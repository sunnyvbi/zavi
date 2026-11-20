import { beforeEach, describe, expect, it, vi } from "vitest";
import { LINKEDIN_MIN_RUNWAY_MS as SHARED_RUNWAY_MS, linkedinEndTimeProblem } from "@zavi/shared";
const m = vi.hoisted(() => ({
  fx: vi.fn(),
  activeBudget: vi.fn(),
  monthView: vi.fn(),
  campaign: vi.fn(),
  spend: vi.fn(),
  pause: vi.fn(),
  unmark: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
  rpc: vi.fn(),
  tier: vi.fn(),
  lock: vi.fn(),
  consent: vi.fn(),
  hold: vi.fn(),
  commit: vi.fn(),
  drop: vi.fn(),
  events: [] as string[],
  logged: [] as Array<{ code: string; message?: string; meta?: Record<string, unknown> }>,
  lifecycle: {
    provider_group_id: "7",
    provider_creative_ids: ["8"],
    stop_requested_at: null as string | null,
  },
  finish: [] as string[],
  receiptError: false,
  failUpdates: {} as Record<string, number>,
  deleteOk: false,
  deleted: [] as string[],
  writesOn: true,
  grantMissing: false,
  opRows: null as Array<{ id?: string; status: string }> | null,
  stopped: null as string | null,
  wallet: vi.fn(),
  statusError: false,
  reservation: null as null | { reserved_cents: number; spent_cents: number },
  lifecycleSingleFails: (): boolean => false,
  tables: {} as Record<string, unknown>,
}));
vi.mock("../fx", async (original) => ({
  ...(await original<typeof import("../fx")>()),
  adsFx: m.fx,
}));
vi.mock("../adapters/linkedin", () => ({
  linkedinCampaign: m.campaign,
  linkedinLifetimeSpend: m.spend,
  pauseLinkedinBoundCampaign: m.pause,
  unmarkLinkedinCampaignGone: m.unmark,
}));
vi.mock("@/services/connectors/linkedin-ads/http", async (original) => {
  const real = await original<typeof import("@/services/connectors/linkedin-ads/http")>();
  const guarded = (fn: typeof m.get) => (token: string, path: string, ...rest: unknown[]) => {
    if (!real.isLinkedInAdsPath(path)) throw new Error(`transport would refuse ${path}`);
    return fn(token, path, ...rest);
  };
  return { ...real, linkedinAdsGet: guarded(m.get), linkedinAdsPost: guarded(m.post) };
});
vi.mock("@/services/agents/entitlement", () => ({ checkAgentTier: m.tier }));
vi.mock("@/services/channels/lock", async (original) => ({
  ...(await original<typeof import("@/services/channels/lock")>()),
  isChannelLockedStrict: m.lock,
}));
vi.mock("@/services/tools/linkedin-ads/write/_flag-check", async (original) => ({
  ...(await original<typeof import("@/services/tools/linkedin-ads/write/_flag-check")>()),
  isLinkedInAdsWriteEnabled: async () => m.writesOn,
}));
vi.mock("../wallet", () => ({ fundingEnabled: () => true, readWallet: m.wallet }));
vi.mock("../consent", () => ({ requireSharedWalletConsent: m.consent }));
vi.mock("@/services/logging/logEvent", () => ({
  logEvent: async (e: { code: string; message?: string; meta?: Record<string, unknown> }) => {
    m.events.push(`log:${e.code}`);
    m.logged.push(e);
  },
}));
vi.mock("@/services/decisions/ad-budget", async (original) => ({
  lifetimeDailyUsd: (await original<typeof import("@/services/decisions/ad-budget")>()).lifetimeDailyUsd,
  budgetMargin: (await original<typeof import("@/services/decisions/ad-budget")>()).budgetMargin,
  readActiveAdBudget: m.activeBudget,
  readAdBudgetMonthView: m.monthView,
  reserveAdSpend: m.hold,
  commitAdSpend: m.commit,
  dropAdSpendHold: m.drop,
  adBudgetRefusal: (reason: string) => `cap_refuse: ad_budget_${reason}`,
  adBudgetIdemKey: (await original<typeof import("@/services/decisions/ad-budget")>()).adBudgetIdemKey,
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (v: string) => v,
  tenantRpc: m.rpc,
  tenantClient: () => ({
    from: (table: string) => {
      let changes: Record<string, unknown> | undefined;
      let deleting = false;
      let failing = false;
      const filters: Record<string, unknown> = {};
      const result = () => failing ? { error: { message: "receipt unavailable" }, data: null } : deleting ? { error: null, data: m.deleteOk ? [{ id: "op" }] : [] } : table in m.tables ? { error: null, data: m.tables[table] } : ({
        error: (table === "ads_campaign_operations" && m.receiptError) || (table === "ads_account_binding_status" && m.statusError) ? { message: "receipt unavailable" } : null,
        data:
          table === "ads_campaign_lifecycle"
            ? changes
              ? [{ campaign_binding_id: "bound" }]
              : structuredClone(m.lifecycle)
            : table === "ads_campaign_operations" && m.opRows
              ? m.opRows
            : table === "ads_account_binding_status"
              ? filters.account_binding_id === "account-binding" ? { disabled_at: m.stopped } : null
            : table === "ads_campaign_reservations" && m.reservation
              ? m.reservation
            : table === "ads_managed_account_grants" && m.grantMissing
              ? null
              : { account_id: "account" },
      });
      const q: any = {
        select: () => q,
        eq: (column: string, value: unknown) => {
          filters[column] = value;
          return q;
        },
        is: () => q,
        in: () => q,
        maybeSingle: async () => result(),
        single: async () => (table === "ads_campaign_lifecycle" && !changes && m.lifecycleSingleFails() ? { error: { message: "connection reset" }, data: null } : result()),
        delete: () => {
          deleting = true;
          m.deleted.push(table);
          return q;
        },
        update: (value: Record<string, unknown>) => {
          changes = value;
          if (table === "ads_campaign_operations") {
            m.finish.push(String(value.status));
            const left = m.failUpdates[String(value.status)] ?? 0;
            if (left > 0) {
              failing = true;
              m.failUpdates[String(value.status)] = left - 1;
            }
          }
          return q;
        },
        then: (resolve: any) => resolve(result()),
      };
      return q;
    },
  }),
}));
import {
  launchLinkedinCampaign,
  linkedinLaunchFilingRefusal,
  linkedinLaunchSnapshot,
  linkedinLaunchObservedCents,
  linkedinLaunchOwnHoldUsd,
  linkedinLaunchSummary,
  LINKEDIN_MIN_RUNWAY_MS,
  linkedinEndTimeRefusal,
  LINKEDIN_LAUNCH_UNCONFIRMED,
  LINKEDIN_LAUNCH_UNCONFIRMED_WALLET,
  LINKEDIN_ACCOUNT_STOPPED,
  LINKEDIN_NOT_FINISHED,
  LINKEDIN_LAUNCH_LIVE_RECORD_PENDING,
  LINKEDIN_MANAGED_WRITE_FORBIDDEN,
} from "../linkedin-launch";
import { walletError } from "@/routes/ads/wallet-auth";
import { ExpectedToolError } from "@/services/tools/types";
import { LINKEDIN_ADS_CHANGE_REFUSED, LINKEDIN_ADS_FORBIDDEN_WRITE, LINKEDIN_ADS_RECONNECT } from "@/services/connectors/linkedin-ads/http";
import { utcStamp } from "@/services/growth/ad-plan-shape";
const request = "10000000-0000-4000-8000-000000000001";
const PAUSED_DURING_LAUNCH = "The campaign was paused while it was launching, so Zavi stopped the launch. Check the campaign before you launch it again.";
const FIRST_WRITE_REFUSED = "LinkedIn did not accept this total budget or end date. Nothing changed in LinkedIn and nothing was held. Check both, then try again.";
let context: any;
let siblings: any;
let mutateOnWrite: (path: string, body: any) => void;
let adIntent: string;
let underReview = false;
beforeEach(() => {
  underReview = false;
  m.stopped = null;
  m.statusError = false;
  m.reservation = null;
  m.lifecycleSingleFails = () => false;
  m.tables = {};
  vi.resetAllMocks();
  m.activeBudget.mockResolvedValue({ days_left: 10 });
  m.fx.mockImplementation(async (currency) => ({
    currency,
    units_per_usd: currency === "EUR" ? 0.8 : 1,
    as_of: null,
    source: "ExchangeRate-API",
  }));
  process.env.ADS_LINKEDIN_MANAGED_ENABLED = "true";
  process.env.ADS_LINKEDIN_ROLLOUT_ACK="campaign-bindings-forward-only";
  m.events = [];
  m.logged = [];
  m.finish = [];
  m.unmark.mockReset();
  m.unmark.mockResolvedValue(undefined);
  m.deleteOk = false;
  m.deleted = [];
  m.writesOn = true;
  m.grantMissing = false;
  m.opRows = null;
  m.receiptError = false;
  m.failUpdates = {};
  m.lifecycle = {
    provider_group_id: "7",
    provider_creative_ids: ["8"],
    stop_requested_at: null,
  };
  context = {
    binding: { id: "bound", account_binding_id: "account-binding", account_id: "account", funding_source: "wallet" },
    account: {
      id: "42",
      currency: "USD",
      status: "ACTIVE",
      servingStatuses: ["RUNNABLE"],
    },
    campaign: {
      id: "123",
      name: "Pilot",
      status: "PAUSED",
      account: "urn:li:sponsoredAccount:42",
      campaignGroup: "urn:li:sponsoredCampaignGroup:7",
      runSchedule: { start: Date.now() - 1000 },
    },
    token: "secret",
    path: "adAccounts/42/adCampaigns/123",
  };
  siblings = {
    elements: [{ id: "123", campaignGroup: context.campaign.campaignGroup }],
  };
  m.campaign.mockImplementation(async () => structuredClone(context));
  m.spend.mockResolvedValue({ cents: 0 });
  m.tier.mockResolvedValue({ allowed: true, enforced: true });
  m.lock.mockResolvedValue(false);
  m.hold.mockImplementation(async () => {
    m.events.push("monthly-hold");
    return { status: "held", fresh: true, tenant_id: "t", idem_key: `${request}:resume` };
  });
  m.rpc.mockImplementation(async (_tenant, name) => {
    m.events.push(name);
    return { data: true, error: null };
  });
  m.get.mockImplementation(async (_token, path) =>
    path.endsWith("adCampaignGroups/7")
      ? { id: 7, account: context.campaign.account, status: "DRAFT" }
      : path === "adAccounts/42/creatives/urn%3Ali%3AsponsoredCreative%3A8"
        ? {
            id: 8,
            campaign: "urn:li:sponsoredCampaign:123",
            intendedStatus: adIntent,
            ...(underReview ? { review: { status: "NEEDS_REVIEW" }, servingHoldReasons: ["UNDER_REVIEW"] } : {}),
          }
        : siblings,
  );
  adIntent = "DRAFT";
  mutateOnWrite = () => {};
  m.post.mockImplementation(async (_token, path, _method, body) => {
    if (path.includes("/creatives/")) adIntent = body.patch.$set.intendedStatus;
    m.events.push(
      `${path}:${body.patch.$set.status ?? body.patch.$set.intendedStatus ?? "budget"}`,
    );
    if (path === context.path) Object.assign(context.campaign, body.patch.$set);
    mutateOnWrite(path, body);
    return {};
  });
});
async function ask() {
  return {
    request_id: request,
    snapshot: (await linkedinLaunchSummary("t", "bound")).snapshot,
    total_budget_cents: 10000,
    end_time: Date.now() + 86400000,
  };
}
it("hands who approved the launch to the monthly hold (D3: the founder's approval is not Autopilot's)", async () => {
  const approval = { approved_by: "owner-1", approved_by_source: "email", body: { origin: "agent" } };
  expect(await launchLinkedinCampaign("t", "bound", await ask(), undefined, approval)).toEqual({ status: "active" });
  expect(m.hold).toHaveBeenCalledWith(
    { id: request, tenant_id: "t", exec_source: "workspace", ...approval },
    expect.objectContaining({ platform: "linkedin", op: "resume", object_id: "bound", currency: "USD" }),
  );
});
function linkedInHoldingAd(intendedStatus: string) {
  const li = { group: { id: 7, account: context.campaign.account, status: "PAUSED" }, ad: { id: 8, campaign: "urn:li:sponsoredCampaign:123", intendedStatus, servingHoldReasons: [] as string[] }, adWhenCampaignWentActive: null as string | null, sent: [] as string[] };
  m.get.mockImplementation(async (_token: string, path: string) => (path.endsWith("adCampaignGroups/7") ? structuredClone(li.group) : path.includes("/creatives/") ? structuredClone(li.ad) : siblings));
  m.post.mockImplementation(async (_token: string, path: string, _method: string, body: any) => {
    const set = body.patch.$set;
    li.sent.push(path);
    if (path.includes("/creatives/")) {
      expect(set).toEqual({ intendedStatus: "ACTIVE" });
      li.ad.intendedStatus = set.intendedStatus;
    } else if (path.endsWith("adCampaignGroups/7")) Object.assign(li.group, set);
    else {
      if (set.status === "ACTIVE") li.adWhenCampaignWentActive = li.ad.intendedStatus;
      Object.assign(context.campaign, set);
    }
    return {};
  });
  return li;
}
function linkedInIgnoringAdSwitch(adIds: string[], appliedIds: string[]) {
  m.lifecycle.provider_creative_ids = adIds;
  const ads = new Map(adIds.map((adId) => [adId, "DRAFT"]));
  const seen = { sent: [] as string[], readsAfterLive: [] as string[], live: false };
  m.get.mockImplementation(async (_token: string, path: string) => {
    if (seen.live) seen.readsAfterLive.push(path);
    if (path.endsWith("adCampaignGroups/7")) return { id: 7, account: context.campaign.account, status: "PAUSED" };
    const adId = /sponsoredCreative%3A(\d+)$/.exec(path)?.[1];
    return adId ? { id: Number(adId), campaign: "urn:li:sponsoredCampaign:123", intendedStatus: ads.get(adId) } : siblings;
  });
  m.post.mockImplementation(async (_token: string, path: string, _method: string, body: any) => {
    seen.sent.push(path);
    const adId = /sponsoredCreative%3A(\d+)$/.exec(path)?.[1];
    if (adId) {
      if (appliedIds.includes(adId)) ads.set(adId, body.patch.$set.intendedStatus);
    } else if (path === context.path) {
      Object.assign(context.campaign, body.patch.$set);
      if (body.patch.$set.status === "ACTIVE") seen.live = true;
    }
    return {};
  });
  return { ads, seen };
}
it.each([
  ["its only ad", ["8"], []],
  ["one of its two ads", ["8", "9"], ["8"]],
])("LinkedIn accepting the switch-on of %s but leaving it DRAFT is not a clean launch: uncertain, paused, holds kept", async (_label, adIds, appliedIds) => {
  const { ads, seen } = linkedInIgnoringAdSwitch(adIds, appliedIds);
  const err = await launchLinkedinCampaign("t", "bound", await ask()).catch((e) => e);
  expect(err).toBeInstanceOf(Error);
  expect(err.message).toBe(LINKEDIN_LAUNCH_UNCONFIRMED_WALLET);
  expect(err.meta?.outcome_unknown).toBe(true);
  expect([...ads.values()].at(-1)).toBe("DRAFT");
  expect(m.finish).toEqual(["uncertain"]);
  expect(m.pause).toHaveBeenCalledWith("t", "bound");
  expect(m.commit).not.toHaveBeenCalled();
  expect(m.drop).not.toHaveBeenCalled();
  expect(m.unmark).not.toHaveBeenCalled();
  expect(m.deleted).toEqual([]);
  expect(seen.sent.filter((p) => p.includes("/creatives/"))).toHaveLength(adIds.length);
});
it("confirming a launch adds exactly one read per ad and no other LinkedIn call", async () => {
  const { seen } = linkedInIgnoringAdSwitch(["8"], ["8"]);
  expect(await launchLinkedinCampaign("t", "bound", await ask())).toEqual({ status: "active" });
  expect(seen.readsAfterLive).toEqual(["adAccounts/42/creatives/urn%3Ali%3AsponsoredCreative%3A8"]);
  expect(m.finish).toEqual(["succeeded"]);
  expect(m.commit).toHaveBeenCalledTimes(1);
  expect(m.pause).not.toHaveBeenCalled();
});
it.each(["DRAFT", "PAUSED", "ACTIVE"])("launching a campaign whose ad is %s switches that ad on before the campaign goes live", async (start) => {
  const li = linkedInHoldingAd(start);
  const summary = await linkedinLaunchSummary("t", "bound");
  expect(summary.ads).toEqual([{ label: "Ad 1", status: start }]);
  expect(await launchLinkedinCampaign("t", "bound", await ask())).toEqual({ status: "active" });
  expect(li.ad.intendedStatus).toBe("ACTIVE");
  expect(li.sent.filter((p) => p.includes("/creatives/"))).toHaveLength(1);
  expect(li.adWhenCampaignWentActive).toBe("ACTIVE");
  expect(li.group.status).toBe("ACTIVE");
  expect(context.campaign.status).toBe("ACTIVE");
});
it("when LinkedIn refuses to switch the draft ad on, the campaign never goes live and the founder can retry", async () => {
  const li = linkedInHoldingAd("DRAFT");
  const apply = m.post.getMockImplementation()!;
  m.post.mockImplementation(async (token: string, path: string, method: string, body: any) => {
    if (path.includes("/creatives/")) throw new ExpectedToolError("linkedin_ads_write_refused", LINKEDIN_ADS_CHANGE_REFUSED, { status: 422, http_status: 422 });
    return apply(token, path, method, body);
  });
  const err = await launchLinkedinCampaign("t", "bound", await ask()).catch((e) => e);
  expect(err.code).toBe("ads_launch_not_sent");
  expect(err.meta?.outcome_unknown).toBeUndefined();
  expect(li.ad.intendedStatus).toBe("DRAFT");
  expect(li.group.status).toBe("PAUSED");
  expect(context.campaign.status).toBe("PAUSED");
  expect(li.sent).toEqual(["adAccounts/42/adCampaigns/123"]);
  expect(m.pause).not.toHaveBeenCalled();
  expect(m.finish).toEqual(["refused"]);
  expect(m.commit).not.toHaveBeenCalled();
});
it("non-regression guard: an archived ad is not launched, and nothing is sent to LinkedIn", async () => {
  const li = linkedInHoldingAd("ARCHIVED");
  const err = await launchLinkedinCampaign("t", "bound", { request_id: request, snapshot: (await linkedinLaunchSummary("t", "bound")).snapshot, total_budget_cents: 10000, end_time: Date.now() + 86400000 }).catch((e) => e);
  expect(err.message).toBe("One or more ads are not ready for launch.");
  expect(li.sent).toEqual([]);
  expect(li.ad.intendedStatus).toBe("ARCHIVED");
});
it("with no approval given (an Autopilot caller), the hold carries no approver", async () => {
  await launchLinkedinCampaign("t", "bound", await ask());
  expect(m.hold.mock.calls[0]![0]).toEqual({ id: request, tenant_id: "t", exec_source: "workspace", approved_by: null, approved_by_source: null, body: undefined });
});
it("takes both holds, sets the cap and end date, then activates the parent campaign last", async () => {
  expect(await launchLinkedinCampaign("t", "bound", await ask())).toEqual({
    status: "active",
  });
  expect(m.events).toEqual([
    "ads_claim_campaign_operation",
    "monthly-hold",
    "ads_reserve_linkedin_launch",
    "adAccounts/42/adCampaigns/123:budget",
    "adAccounts/42/creatives/urn%3Ali%3AsponsoredCreative%3A8:ACTIVE",
    "adAccounts/42/adCampaignGroups/7:ACTIVE",
    "adAccounts/42/adCampaigns/123:ACTIVE",
    "ads_release_unsent_linkedin_launch",
  ]);
  expect(m.finish).toEqual(["succeeded"]);
  expect(m.commit).toHaveBeenCalled();
});
it("a successful relaunch clears the gone record, for the customer's own account too, once the stop is cleared", async () => {
  context.binding.funding_source = "provider";
  await launchLinkedinCampaign("t", "bound", await ask());
  expect(m.unmark).toHaveBeenCalledTimes(1);
  expect(m.unmark).toHaveBeenCalledWith("t", "bound");
  expect(m.unmark.mock.invocationCallOrder[0]).toBeLessThan(m.commit.mock.invocationCallOrder[0]);
});
it("a gone record that cannot be cleared never fails or pauses a launch that is live", async () => {
  m.unmark.mockRejectedValue(new Error("db down"));
  expect(await launchLinkedinCampaign("t", "bound", await ask())).toEqual({ status: "active" });
  expect(m.pause).not.toHaveBeenCalled();
  expect(m.finish).toEqual(["succeeded"]);
  expect(m.events).toContain("log:ads_wallet.gone_record_not_cleared");
});
it("a launch that fails leaves the gone record alone", async () => {
  m.post.mockRejectedValue(new Error("LinkedIn 500"));
  await launchLinkedinCampaign("t", "bound", await ask()).catch(() => undefined);
  expect(m.unmark).not.toHaveBeenCalled();
});
it("does not draw on the wallet for the customer's own LinkedIn account", async () => {
  context.binding.funding_source = "provider";
  await launchLinkedinCampaign("t", "bound", await ask());
  expect(m.events).not.toContain("ads_reserve_linkedin_launch");
  expect(m.consent).not.toHaveBeenCalled();
  expect(m.hold).toHaveBeenCalled();
});
it("refuses insufficient shared balance before any provider write", async () => {
  m.rpc.mockImplementation(async (_t, name) => ({
    data: true,
    error:
      name === "ads_reserve_linkedin_launch"
        ? { message: "ads_balance_insufficient" }
        : null,
  }));
  const err = (await launchLinkedinCampaign("t", "bound", await ask()).catch((e: unknown) => e)) as Error;
  expect(err.message).toBe("Your shared-wallet balance cannot cover this launch with a $100.00 total budget. Nothing was sent to LinkedIn and nothing was held. Add balance from the balance panel on your LinkedIn Ads page, or lower the total budget, then try again.");
  expect(m.post).not.toHaveBeenCalled();
  expect(m.drop).toHaveBeenCalled();
  expect(m.finish).toEqual(["refused"]);
  expect(m.rpc.mock.calls.map((c) => c[1])).not.toContain("ads_release_unsent_linkedin_launch");
});
it("does not blame the founder's balance when the wallet hold fails for another reason", async () => {
  m.rpc.mockImplementation(async (_t, name) => ({
    data: true,
    error:
      name === "ads_reserve_linkedin_launch"
        ? { message: "could not obtain lock on row in relation \"ads_wallets\"" }
        : null,
  }));
  const err = (await launchLinkedinCampaign("t", "bound", await ask()).catch((e: unknown) => e)) as Error;
  expect(err.message).toBe("Zavi could not confirm the shared-wallet funds for this launch just now. Nothing was sent to LinkedIn. Try again in a minute.");
  expect(err.message).not.toMatch(/nothing was held/i);
  expect(m.rpc.mock.calls.map((c) => c[1])).not.toContain("ads_release_unsent_linkedin_launch");
  expect(err.message).not.toMatch(/balance|ads_wallets|lock/);
  expect(m.post).not.toHaveBeenCalled();
  expect(m.drop).toHaveBeenCalled();
});
it("refuses a monthly budget denial before taking a wallet hold", async () => {
  m.hold.mockResolvedValue({ status: "refused", error: "Monthly cap" });
  await expect(
    launchLinkedinCampaign("t", "bound", await ask()),
  ).rejects.toThrow("Your monthly ad budget did not allow this launch.");
  expect(m.rpc).toHaveBeenCalledTimes(1);
  expect(m.post).not.toHaveBeenCalled();
});
it("marks a claimed launch retryable only after a pre-write refusal is recorded", async () => {
  context.binding.funding_source = "provider";
  m.activeBudget.mockResolvedValue(null);
  await expect(launchLinkedinCampaign("t", "bound", await ask())).rejects.toMatchObject({
    code: "ads_launch_not_sent",
    message: "Set a monthly ad budget before launching LinkedIn campaigns.",
  });
  expect(m.post).not.toHaveBeenCalled();
  expect(m.drop).toHaveBeenCalled();
  expect(m.finish).toEqual(["refused"]);
});
it.each(["wallet", "provider"])("keeps the request ID when the %s budget reservation answer was lost, and lets the same request run once the check is back", async (funding) => {
  context.binding.funding_source = funding;
  m.deleteOk = true;
  const ask0 = await ask();
  const lost = "cap_refuse: ad_budget_unavailable: the ad budget could not be checked, nothing was sent";
  m.hold.mockResolvedValueOnce({ status: "refused", error: lost });
  const { err, status, body } = await founderRefusal(() => launchLinkedinCampaign("t", "bound", ask0));
  expect(err.code).toBe("ads_launch_conflict");
  expect(status).toBe(409);
  expect(body.error.message).toBe("Zavi could not check your monthly ad budget just now. Nothing was sent to LinkedIn. Try again in a minute.");
  expect(err.meta).toEqual({ budget_refusal: lost });
  expect(m.post).not.toHaveBeenCalled();
  expect(m.deleted).toEqual(["ads_campaign_operations"]);
  expect(m.finish).toEqual([]);
  m.events = [];
  expect(await launchLinkedinCampaign("t", "bound", ask0)).toEqual({ status: "active" });
  expect(m.rpc.mock.calls.filter((c) => c[1] === "ads_claim_campaign_operation").map((c) => c[2].p_id)).toEqual([request, request]);
  expect(m.hold.mock.calls.map((c) => c[0].id)).toEqual([request, request]);
  expect(m.finish).toEqual(["succeeded"]);
});
it("does not mark a refusal retryable when its receipt could not be saved", async () => {
  m.activeBudget.mockResolvedValue(null);
  m.receiptError = true;
  await expect(launchLinkedinCampaign("t", "bound", await ask())).rejects.toThrow("receipt could not be saved");
  expect(m.post).not.toHaveBeenCalled();
});
it("a failed monthly hold cleanup still gives back the wallet coverage and reopens the request, so the stuck hold never blocks the campaign", async () => {
  const a = await ask();
  m.deleteOk = true;
  m.drop.mockRejectedValue(new Error("Ad budget hold cleanup could not be confirmed"));
  m.rpc.mockImplementation(async (_t, name, args) => {
    m.events.push(name);
    if (name === "ads_release_unsent_linkedin_launch")
      m.events.push(`release:${args.p_operation_id}:${args.p_prior_reserved_cents}`);
    if (name === "ads_reserve_linkedin_launch") {
      m.lifecycle.stop_requested_at = new Date().toISOString();
      return { data: 2500, error: null };
    }
    return { data: true, error: null };
  });
  const err = await launchLinkedinCampaign("t", "bound", a).catch((e) => e);
  expect(err).toBeInstanceOf(ExpectedToolError);
  expect(err.code).toBe("ads_launch_not_sent");
  expect(err.message).toBe(PAUSED_DURING_LAUNCH);
  expect(m.drop).toHaveBeenCalledWith(expect.objectContaining({ status: "held", fresh: true }), { strict: true });
  expect(m.events).toContain(`release:${request}:2500`);
  expect(m.events).toContain("log:ads_wallet.unsent_launch_hold_left");
  expect(m.deleted).toEqual(["ads_campaign_operations"]);
  expect(m.finish).toEqual([]);
  expect(m.post).not.toHaveBeenCalled();
});
it("refuses an outdated review before claiming or writing", async () => {
  const value = await ask();
  context.campaign.name = "Changed";
  await expect(launchLinkedinCampaign("t", "bound", value)).rejects.toThrow(
    "changed",
  );
  expect(m.rpc).not.toHaveBeenCalled();
  expect(m.post).not.toHaveBeenCalled();
});
it("does not blindly resend an already claimed launch", async () => {
  m.rpc.mockResolvedValue({ data: false, error: null });
  expect(await launchLinkedinCampaign("t", "bound", await ask())).toEqual({
    status: "already_requested",
  });
  expect(m.post).not.toHaveBeenCalled();
});
it("retains holds and attempts a stop after an ambiguous write", async () => {
  m.post.mockRejectedValue(new Error("timeout"));
  await expect(
    launchLinkedinCampaign("t", "bound", await ask()),
  ).rejects.toThrow("may have reached LinkedIn");
  expect(m.drop).not.toHaveBeenCalled();
  expect(m.pause).toHaveBeenCalledWith("t", "bound");
  expect(m.finish).toEqual(["uncertain"]);
});
it("records LinkedIn's refusal reason once on a refused launch write, and keeps it off the founder's message", async () => {
  m.post.mockRejectedValue(new ExpectedToolError("linkedin_ads_write_refused", LINKEDIN_ADS_CHANGE_REFUSED, { status: 422, http_status: 422, linkedin_reason: "runSchedule.end: End date must be in the future" }));
  const err = (await launchLinkedinCampaign("t", "bound", await ask()).catch((e: unknown) => e)) as Error;
  expect(err.message).toBe(FIRST_WRITE_REFUSED);
  expect(err.message).not.toContain("End date must be in the future");
  expect(m.events.filter((e) => e === "log:linkedin_ads.write_refused")).toHaveLength(1);
});
it("still leaves a row when LinkedIn refuses without a readable reason, so a 4xx is never invisible", async () => {
  m.post.mockRejectedValue(new ExpectedToolError("linkedin_ads_write_refused", LINKEDIN_ADS_CHANGE_REFUSED, { status: 422, http_status: 422 }));
  await launchLinkedinCampaign("t", "bound", await ask()).catch(() => undefined);
  expect(m.logged).toEqual([expect.objectContaining({ code: "linkedin_ads.write_refused", message: "LinkedIn refused this write and sent no reason Zavi could read.", meta: expect.objectContaining({ stage: "launch", http_status: 422 }) })]);
});
it("protectively re-pauses customer billing when a stop races the final activation write", async () => {
  context.binding.funding_source = "provider";
  mutateOnWrite = (path, body) => {
    if (path === context.path && body.patch.$set.status === "ACTIVE") {
      m.lifecycle.stop_requested_at = new Date().toISOString();
    }
  };
  await expect(launchLinkedinCampaign("t", "bound", await ask())).rejects.toThrow(PAUSED_DURING_LAUNCH);
  expect(m.events).toContain(`${context.path}:ACTIVE`);
  expect(m.pause).toHaveBeenCalledWith("t", "bound");
  expect(m.finish).toEqual(["uncertain"]);
  expect(m.drop).not.toHaveBeenCalled();
  expect(m.commit).not.toHaveBeenCalled();
});
it.each(["wallet", "provider"])("a racing stop prevents %s campaign activation and preserves coverage", async (funding) => {
  context.binding.funding_source = funding;
  mutateOnWrite = () => {
    m.lifecycle.stop_requested_at = new Date().toISOString();
  };
  await expect(
    launchLinkedinCampaign("t", "bound", await ask()),
  ).rejects.toThrow(PAUSED_DURING_LAUNCH);
  expect(m.events).not.toContain("adAccounts/42/adCampaigns/123:ACTIVE");
  expect(m.pause).toHaveBeenCalled();
  expect(m.drop).not.toHaveBeenCalled();
});
it("refuses to enable unseen campaigns in a shared group", async () => {
  siblings.elements.push({
    id: "999",
    campaignGroup: context.campaign.campaignGroup,
  });
  await expect(linkedinLaunchSummary("t", "bound")).rejects.toThrow(
    "outside this launch",
  );
  expect(m.post).not.toHaveBeenCalled();
});
it("refuses an own-billing account on billing hold with the billing words, before reserving anything", async () => {
  context.binding.funding_source = "provider";
  context.account.servingStatuses = ["BILLING_HOLD"];
  await expect(launchLinkedinCampaign("t", "bound", await ask())).rejects.toThrow(
    "LinkedIn has paused your ad account for billing. Add or fix the payment method in LinkedIn Campaign Manager, then try again.",
  );
  expect(m.rpc).not.toHaveBeenCalled();
  expect(m.post).not.toHaveBeenCalled();
});
it("a billing hold on Zavi's managed account tells a wallet founder Zavi is sorting it out, never to fix a payment method, and holds nothing", async () => {
  context.account.servingStatuses = ["BILLING_HOLD"];
  const err = await launchLinkedinCampaign("t", "bound", await ask()).catch((e) => e);
  expect(err.message).toBe("Zavi's managed LinkedIn ad account cannot run ads right now: LinkedIn has paused it for billing. Zavi is sorting out its account, and there is nothing you need to fix. Nothing was sent to LinkedIn. Try again later. Your campaign stays paused.");
  expect(err.message).not.toMatch(/payment method|Campaign Manager/);
  expect(m.rpc).not.toHaveBeenCalled();
  expect(m.hold).not.toHaveBeenCalled();
  expect(m.post).not.toHaveBeenCalled();
});
it.each([
  ["STOPPED", "ACTIVE", "LinkedIn has stopped the ad account from running ads", "Check the account's status in LinkedIn Campaign Manager, then review the launch again."],
  ["ACCOUNT_TOTAL_BUDGET_HOLD", "ACTIVE", "the ad account has used up the total budget set on it in LinkedIn", "Raise or remove the account's total budget in LinkedIn Campaign Manager, then review the launch again."],
  ["ACCOUNT_END_DATE_HOLD", "ACTIVE", "the end date set on the ad account in LinkedIn has passed", "Move or remove the account's end date in LinkedIn Campaign Manager, then review the launch again."],
  ["RESTRICTED_HOLD", "ACTIVE", "LinkedIn has restricted the ad account", "Open LinkedIn Campaign Manager to read LinkedIn's notice about it, or contact LinkedIn support."],
  ["INTERNAL_HOLD", "ACTIVE", "LinkedIn is holding the ad account on its side", "This usually clears on its own. Try again later, and contact LinkedIn support if it stays."],
  ["RUNNABLE", "DRAFT", "the ad account is not fully set up in LinkedIn yet", "Finish setting it up in LinkedIn Campaign Manager, including a payment method, then review the launch again."],
  ["RUNNABLE", "CANCELED", "the ad account is closed in LinkedIn", "Choose another ad account in Ads account settings."],
  ["SOME_NEW_HOLD", "ACTIVE", "LinkedIn says the ad account cannot run ads right now", "Check the account in LinkedIn Campaign Manager, then review the launch again."],
])("an own account serving as %s (status %s) is refused with the reason and next step, before anything is held", async (serving, status, reason, step) => {
  context.binding.funding_source = "provider";
  context.account.servingStatuses = [serving];
  context.account.status = status;
  const err = await launchLinkedinCampaign("t", "bound", await ask()).catch((e) => e);
  expect(err.message).toBe(`This campaign cannot launch because ${reason}. ${step} Nothing was sent to LinkedIn and your campaign stays paused.`);
  expect(err.message).not.toMatch(/not ready to serve|_HOLD|RUNNABLE|DRAFT|CANCELED|SOME_NEW/);
  expect(m.rpc).not.toHaveBeenCalled();
  expect(m.hold).not.toHaveBeenCalled();
  expect(m.post).not.toHaveBeenCalled();
});
it.each(["STOPPED", "RESTRICTED_HOLD", "ACCOUNT_TOTAL_BUDGET_HOLD"])("a wallet campaign on Zavi's managed account serving as %s says Zavi is sorting it out, with no step for the founder", async (serving) => {
  context.account.servingStatuses = [serving];
  const err = await launchLinkedinCampaign("t", "bound", await ask()).catch((e) => e);
  expect(err.message).toMatch(/^Zavi's managed LinkedIn ad account cannot run ads right now: .+\. Zavi is sorting out its account, and there is nothing you need to fix\. Nothing was sent to LinkedIn\. Try again later\. Your campaign stays paused\.$/);
  expect(err.message).not.toMatch(/Campaign Manager|support|_HOLD|STOPPED/);
  expect(m.hold).not.toHaveBeenCalled();
  expect(m.post).not.toHaveBeenCalled();
});
it("requires current shared-wallet consent", async () => {
  m.consent.mockRejectedValue(new Error("consent withdrawn"));
  await expect(
    launchLinkedinCampaign("t", "bound", await ask()),
  ).rejects.toThrow("consent withdrawn");
  expect(m.post).not.toHaveBeenCalled();
});
it("money: a founder who withdraws the wallet while a never-run draft is reserving its funds stops the launch before LinkedIn, and the funds go back", async () => {
  const r = await ask();
  m.consent.mockImplementation(async () => {
    if (m.events.includes("ads_reserve_linkedin_launch"))
      throw new ExpectedToolError("ads_consent_required", "Review and authorize shared-wallet spending first.");
  });
  const err = await launchLinkedinCampaign("t", "bound", r).catch((e) => e);
  expect(err.message).toBe("Review and authorize shared-wallet spending first.");
  expect(m.post).not.toHaveBeenCalled();
  expect(m.events.indexOf("ads_release_unsent_linkedin_launch")).toBeGreaterThan(m.events.indexOf("ads_reserve_linkedin_launch"));
  expect(m.finish).not.toContain("succeeded");
});

it("converts a non-USD customer lifetime cap into the monthly budget without wallet funding", async () => {
  context.binding.funding_source = "provider";
  context.account.currency = "EUR";
  const r = await ask();
  r.total_budget_cents = 800000;
  await launchLinkedinCampaign("t", "bound", r);
  expect(m.hold).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ daily_delta_usd: 10000, lifetime_usd: 10000, currency: "USD" }),
  );
  expect(m.events).not.toContain("ads_reserve_linkedin_launch");
  expect(context.campaign.totalBudget).toEqual({
    amount: "8000.00",
    currencyCode: "EUR",
  });
});
it("requires an active founder budget even for an owner-approved launch", async () => {
  m.activeBudget.mockResolvedValue(null);
  await expect(
    launchLinkedinCampaign("t", "bound", await ask()),
  ).rejects.toThrow("monthly ad budget");
  expect(m.post).not.toHaveBeenCalled();
});
it("rechecks delegated permission between provider writes and pauses after revocation", async () => {
  let revoked = false;
  const guard = vi.fn(async () => {
    if (revoked) throw new Error("Revoked");
  });
  mutateOnWrite = () => {
    revoked = true;
  };
  await expect(
    launchLinkedinCampaign("t", "bound", await ask(), guard),
  ).rejects.toThrow("may have reached LinkedIn");
  expect(m.post).toHaveBeenCalledTimes(1);
  expect(m.pause).toHaveBeenCalled();
  expect(m.finish).toContain("uncertain");
});
it("gives back the wallet coverage of a launch that aborted before any LinkedIn write", async () => {
  const a = await ask();
  m.rpc.mockImplementation(async (_t, name, args) => {
    m.events.push(name);
    if (name === "ads_release_unsent_linkedin_launch")
      m.events.push(`release:${args.p_operation_id}:${args.p_prior_reserved_cents}`);
    if (name === "ads_reserve_linkedin_launch") {
      m.lifecycle.stop_requested_at = new Date().toISOString();
      return { data: 2500, error: null };
    }
    return { data: true, error: null };
  });
  await expect(launchLinkedinCampaign("t", "bound", a)).rejects.toThrow(
    PAUSED_DURING_LAUNCH,
  );
  expect(m.post).not.toHaveBeenCalled();
  expect(m.events).toContain(`release:${request}:2500`);
  expect(m.drop).toHaveBeenCalled();
  expect(m.finish).toEqual(["refused"]);
});
it("applies the $10 minimum to a non-USD account in USD terms", async () => {
  context.binding.funding_source = "provider";
  context.account.currency = "JPY";
  m.fx.mockImplementation(async (currency) => ({
    currency,
    units_per_usd: 150,
    as_of: null,
    source: "ExchangeRate-API",
  }));
  await expect(launchLinkedinCampaign("t", "bound", await ask())).rejects.toThrow(
    "at least $10",
  );
  expect(m.hold).not.toHaveBeenCalled();
  expect(m.post).not.toHaveBeenCalled();
});
it("reports, and keeps conservatively, coverage it could not give back", async () => {
  const a = await ask();
  m.rpc.mockImplementation(async (_t, name) => {
    m.events.push(name);
    if (name === "ads_reserve_linkedin_launch") {
      m.lifecycle.stop_requested_at = new Date().toISOString();
      return { data: 0, error: null };
    }
    if (name === "ads_release_unsent_linkedin_launch")
      return { data: null, error: { message: "db down" } };
    return { data: true, error: null };
  });
  await expect(launchLinkedinCampaign("t", "bound", a)).rejects.toThrow(
    "Nothing was sent to LinkedIn, but Zavi could not give back the shared-wallet funds it set aside for this launch yet. They are reserved, not spent, and Zavi gives them back before this campaign's next launch.",
  );
  expect(m.events).toContain("log:ads_wallet.unsent_launch_release_failed");
  expect(m.post).not.toHaveBeenCalled();
});

it("D3: a launch the budget hands back to the founder leaves no claim behind, so the founder's approval of the same request runs it", async () => {
  m.deleteOk = true;
  const refusal = "cap_refuse: ad_budget_over_projection_with_change: This puts you on track for $27,100 this month, $100 over your $27,000 cap, so Autopilot left it for you to approve; nothing was sent";
  m.hold.mockImplementationOnce(async () => ({ status: "refused", error: refusal }));
  const err = await launchLinkedinCampaign("t", "bound", await ask()).catch((e) => e);
  expect(err).toMatchObject({ code: "ads_launch_not_sent", message: "This month's ad spending is on track to go over your monthly ad budget, so this launch was not sent to LinkedIn. Open the launch and approve it yourself to go ahead.", meta: { budget_refusal: refusal } });
  expect(m.deleted).toEqual(["ads_campaign_operations"]);
  expect(m.finish).toEqual([]);
  m.events = [];
  expect(await launchLinkedinCampaign("t", "bound", await ask(), undefined, { approved_by: "owner-1" })).toEqual({ status: "active" });
  expect(m.events[0]).toBe("ads_claim_campaign_operation");
  expect(m.events).toContain("monthly-hold");
});
it("with the server switch off, refuses with the standard switched-off copy and code before any read, claim, hold or write", async () => {
  const value = await ask();
  m.get.mockClear();
  m.campaign.mockClear();
  m.events = [];
  m.writesOn = false;
  const refusal = await launchLinkedinCampaign("t", "bound", value, undefined, { approved_by: "owner-1" }).catch((e) => e);
  expect(refusal).toBeInstanceOf(ExpectedToolError);
  expect(refusal.code).toBe("linkedin_ads_writes_off");
  expect(refusal.message).toBe("LinkedIn Ads changes are switched off on this server, so Zavi cannot launch campaigns yet. Your campaign stays paused.");
  const res: any = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  walletError(res, refusal);
  expect(res.status).toHaveBeenCalledWith(403);
  expect(res.json).toHaveBeenCalledWith({ error: { code: "linkedin_ads_writes_off", message: refusal.message } });
  expect(m.post).not.toHaveBeenCalled();
  expect(m.get).not.toHaveBeenCalled();
  expect(m.campaign).not.toHaveBeenCalled();
  expect(m.rpc).not.toHaveBeenCalled();
  expect(m.hold).not.toHaveBeenCalled();
  expect(m.commit).not.toHaveBeenCalled();
  expect(m.spend).not.toHaveBeenCalled();
  expect(m.finish).toEqual([]);
  expect(m.deleted).toEqual([]);
  expect(m.events).toEqual([]);
  m.writesOn = true;
  expect(await launchLinkedinCampaign("t", "bound", value)).toEqual({ status: "active" });
  expect(m.rpc).toHaveBeenCalledWith("t", "ads_claim_campaign_operation", expect.objectContaining({ p_id: request }));
});
it("a Coming soon LinkedIn channel refuses the launch as coming soon before any read, claim, hold or write", async () => {
  const value = await ask();
  m.get.mockClear();
  m.campaign.mockClear();
  m.events = [];
  m.lock.mockResolvedValue(true);
  const refusal = await launchLinkedinCampaign("t", "bound", value, undefined, { approved_by: "owner-1" }).catch((e) => e);
  expect(refusal).toBeInstanceOf(ExpectedToolError);
  expect(refusal.message).toBe("LinkedIn Ads is coming soon.");
  expect(m.get).not.toHaveBeenCalled();
  expect(m.campaign).not.toHaveBeenCalled();
  expect(m.rpc).not.toHaveBeenCalled();
  expect(m.hold).not.toHaveBeenCalled();
  expect(m.post).not.toHaveBeenCalled();
  m.lock.mockResolvedValue(false);
  m.tier.mockResolvedValue({ allowed: false, enforced: true });
  const planRefusal = await launchLinkedinCampaign("t", "bound", value).catch((e) => e);
  expect(planRefusal.message).toBe("LinkedIn launch is unavailable for this workspace.");
  expect(m.post).not.toHaveBeenCalled();
});

it("non-regression guard (Review 7, withdraw race): a stop intent recorded while the launch's last write is in flight ends paused, never reported live, and its receipt is unconfirmed", async () => {
  const a = await ask();
  mutateOnWrite = (path, body) => {
    if (path === context.path && body.patch.$set.status === "ACTIVE") m.lifecycle.stop_requested_at = new Date().toISOString();
  };
  await expect(launchLinkedinCampaign("t", "bound", a)).rejects.toThrow(PAUSED_DURING_LAUNCH);
  expect(m.pause).toHaveBeenCalledWith("t", "bound");
  expect(m.finish).toEqual(["uncertain"]);
  expect(m.finish).not.toContain("succeeded");
  expect(m.commit).not.toHaveBeenCalled();
});
const INTERNAL_WORDS = /rollout|inventory|reconcil|operation|binding|tenant|forward-only|D3/i;
async function founderRefusal(run: () => Promise<unknown>) {
  const err = await run().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ExpectedToolError);
  if (!(err instanceof ExpectedToolError)) throw new Error("expected an ExpectedToolError");
  const res: any = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  walletError(res, err);
  return { err, status: res.status.mock.calls[0][0], body: res.json.mock.calls[0][0] };
}
it("with wallet payments for LinkedIn switched off, tells the founder in plain words and touches nothing", async () => {
  const value = await ask();
  process.env.ADS_LINKEDIN_ROLLOUT_ACK = "";
  const { err, status, body } = await founderRefusal(() => launchLinkedinCampaign("t", "bound", value));
  const copy = "Zavi wallet payments for LinkedIn are not switched on yet, so this campaign cannot launch from the wallet. It stays paused.";
  expect(err.code).toBe("ads_launch_conflict");
  expect(status).toBe(409);
  expect(body).toEqual({ error: { code: "ads_launch_conflict", message: copy } });
  expect(copy).not.toMatch(INTERNAL_WORDS);
  expect(m.rpc).not.toHaveBeenCalled();
  expect(m.hold).not.toHaveBeenCalled();
  expect(m.post).not.toHaveBeenCalled();
  expect(m.finish).toEqual([]);
});
it("with the wallet grant gone, says the ad account can no longer spend from the wallet before any claim", async () => {
  const value = await ask();
  m.grantMissing = true;
  const { status, body } = await founderRefusal(() => launchLinkedinCampaign("t", "bound", value));
  const copy = "This LinkedIn ad account can no longer spend from the Zavi wallet. Your campaign stays paused.";
  expect(status).toBe(409);
  expect(body).toEqual({ error: { code: "ads_launch_conflict", message: copy } });
  expect(copy).not.toMatch(INTERNAL_WORDS);
  expect(m.rpc).not.toHaveBeenCalled();
  expect(m.post).not.toHaveBeenCalled();
});
it("when another change to the campaign holds the claim, asks the founder to try again shortly and sends nothing", async () => {
  const value = await ask();
  m.rpc.mockImplementation(async (_t, name) => ({ data: null, error: name === "ads_claim_campaign_operation" ? { message: "locked" } : null }));
  const { status, body } = await founderRefusal(() => launchLinkedinCampaign("t", "bound", value));
  const copy = "Another change to this campaign is still finishing. Nothing was sent to LinkedIn. Try again in a few minutes.";
  expect(status).toBe(409);
  expect(body).toEqual({ error: { code: "ads_launch_conflict", message: copy } });
  expect(copy).not.toMatch(INTERNAL_WORDS);
  expect(m.hold).not.toHaveBeenCalled();
  expect(m.post).not.toHaveBeenCalled();
  expect(m.finish).toEqual([]);
});
it("without a saved record of the campaign's ads, the review itself says so in plain words", async () => {
  m.lifecycle = null as any;
  const { status, body } = await founderRefusal(() => linkedinLaunchSummary("t", "bound"));
  const copy = "Zavi could not confirm which ads belong to this campaign, so it cannot launch it. Your campaign stays paused.";
  expect(status).toBe(409);
  expect(body).toEqual({ error: { code: "ads_launch_conflict", message: copy } });
  expect(copy).not.toMatch(INTERNAL_WORDS);
  expect(m.post).not.toHaveBeenCalled();
});
it("a pause that lands mid-launch reaches the founder as a full plain sentence on the not-sent path", async () => {
  const value = await ask();
  context.binding.funding_source = "provider";
  m.rpc.mockImplementation(async (_t, name) => {
    if (name === "ads_claim_campaign_operation") m.lifecycle.stop_requested_at = new Date().toISOString();
    return { data: true, error: null };
  });
  const { err, status, body } = await founderRefusal(() => launchLinkedinCampaign("t", "bound", value));
  expect(err.code).toBe("ads_launch_not_sent");
  expect(status).toBe(409);
  expect(body).toEqual({ error: { code: "ads_launch_not_sent", message: PAUSED_DURING_LAUNCH } });
  expect(PAUSED_DURING_LAUNCH).not.toMatch(INTERNAL_WORDS);
  expect(m.post).not.toHaveBeenCalled();
});
const gbp = (units_per_usd: number, as_of: string) => {
  context.account.currency = "GBP";
  context.campaign.totalBudget = { amount: "50.00", currencyCode: "GBP" };
  m.fx.mockImplementation(async (currency) => ({ currency, units_per_usd, as_of, source: "ExchangeRate-API" }));
};
it("a GBP card approved after a rate refresh within 2% launches and holds the USD at today's rate", async () => {
  gbp(0.8, "2026-10-25T00:00:01.000Z");
  const a = await ask();
  gbp(0.79, "2026-10-26T00:00:01.000Z");
  expect(await launchLinkedinCampaign("t", "bound", a, undefined, { approved_by: "owner-1", approved_total_usd: 125 })).toEqual({ status: "active" });
  expect(m.hold.mock.calls[0]![1]).toMatchObject({ daily_delta_usd: 126.59, lifetime_usd: 126.59, currency: "USD" });
  expect(m.events).toContain("ads_reserve_linkedin_launch");
  expect(m.rpc.mock.calls.find((c) => c[1] === "ads_reserve_linkedin_launch")![2]).toMatchObject({ p_lifetime_cents: 10000 });
  expect(m.post.mock.calls[0]![3]).toEqual({ patch: { $set: { totalBudget: { amount: "100.00", currencyCode: "GBP" }, runSchedule: { ...context.campaign.runSchedule } } } });
  expect(m.finish).toEqual(["succeeded"]);
});
it("the founder form left open across a rate refresh still launches", async () => {
  gbp(0.8, "2026-10-25T00:00:01.000Z");
  const a = await ask();
  gbp(0.81, "2026-10-26T00:00:01.000Z");
  expect(await launchLinkedinCampaign("t", "bound", a)).toEqual({ status: "active" });
  expect(m.hold.mock.calls[0]![1]).toMatchObject({ daily_delta_usd: 123.46, lifetime_usd: 123.46 });
});
it("a GBP card whose rate moved more than 2% is refused in plain words before any claim, hold or LinkedIn write", async () => {
  gbp(0.8, "2026-10-25T00:00:01.000Z");
  const a = await ask();
  gbp(0.75, "2026-10-26T00:00:01.000Z");
  m.events = [];
  const err = await launchLinkedinCampaign("t", "bound", a, undefined, { approved_by: "owner-1", approved_total_usd: 125 }).catch((e) => e);
  expect(err).toBeInstanceOf(ExpectedToolError);
  expect(err.message).toBe("The exchange rate moved since this launch was approved, so it now comes to $133.34, more than 2% above the $125.00 approved. Nothing was sent to LinkedIn. Review the launch again.");
  expect(m.events).toEqual([]);
  expect(m.rpc).not.toHaveBeenCalled();
  expect(m.hold).not.toHaveBeenCalled();
  expect(m.post).not.toHaveBeenCalled();
  expect(m.finish).toEqual([]);
});
it("a changed daily budget refuses for good even when the rate did not move", async () => {
  gbp(0.8, "2026-10-25T00:00:01.000Z");
  const a = await ask();
  context.campaign.dailyBudget = { amount: "60.00", currencyCode: "GBP" };
  const err = await launchLinkedinCampaign("t", "bound", a, undefined, { approved_total_usd: 125 }).catch((e) => e);
  expect(err.message).toBe("The campaign or its ads changed. Review the launch again.");
  expect(err.meta).toMatchObject({ card_cannot_run: true });
  expect(m.rpc).not.toHaveBeenCalled();
  expect(m.hold).not.toHaveBeenCalled();
  expect(m.post).not.toHaveBeenCalled();
});
it("a USD card must still match its approved dollars to the cent", async () => {
  const a = await ask();
  await expect(launchLinkedinCampaign("t", "bound", a, undefined, { approved_total_usd: 99.99 })).rejects.toThrow("Campaign or currency changed. Review it again.");
  expect(m.rpc).not.toHaveBeenCalled();
  expect(m.post).not.toHaveBeenCalled();
  expect(await launchLinkedinCampaign("t", "bound", a, undefined, { approved_total_usd: 100 })).toEqual({ status: "active" });
  expect(m.hold.mock.calls[0]![1]).toMatchObject({ daily_delta_usd: 100, lifetime_usd: 100 });
});
it("a GBP launch pressed on the dashboard after the rate moved more than 2% from the reviewed rate is refused before any claim, hold or LinkedIn write", async () => {
  gbp(0.8, "2026-10-25T00:00:01.000Z");
  const a = await ask();
  gbp(0.75, "2026-10-26T00:00:01.000Z");
  m.events = [];
  const err = await launchLinkedinCampaign("t", "bound", a, undefined, { approved_by: "owner-1", reviewed_units_per_usd: 0.8 }).catch((e) => e);
  expect(err).toBeInstanceOf(ExpectedToolError);
  expect(err.message).toBe("The exchange rate moved since this launch was approved, so it now comes to $133.34, more than 2% above the $125.00 approved. Nothing was sent to LinkedIn. Review the launch again.");
  expect(m.events).toEqual([]);
  expect(m.rpc).not.toHaveBeenCalled();
  expect(m.hold).not.toHaveBeenCalled();
  expect(m.post).not.toHaveBeenCalled();
  expect(m.finish).toEqual([]);
});
it("a GBP launch pressed on the dashboard within 2% of the reviewed rate launches and holds the USD at today's rate", async () => {
  gbp(0.8, "2026-10-25T00:00:01.000Z");
  const a = await ask();
  gbp(0.79, "2026-10-26T00:00:01.000Z");
  expect(await launchLinkedinCampaign("t", "bound", a, undefined, { approved_by: "owner-1", reviewed_units_per_usd: 0.8 })).toEqual({ status: "active" });
  expect(m.hold.mock.calls[0]![1]).toMatchObject({ daily_delta_usd: 126.59, lifetime_usd: 126.59, currency: "USD" });
});
it("a GBP dashboard launch that does not say which rate it was reviewed at is refused before any claim, hold or LinkedIn write", async () => {
  gbp(0.8, "2026-10-25T00:00:01.000Z");
  const a = await ask();
  await expect(launchLinkedinCampaign("t", "bound", a, undefined, { approved_by: "owner-1", reviewed_units_per_usd: null })).rejects.toThrow("Zavi could not tell which exchange rate this launch was reviewed at. Nothing was sent to LinkedIn. Review the launch again.");
  expect(m.rpc).not.toHaveBeenCalled();
  expect(m.hold).not.toHaveBeenCalled();
  expect(m.post).not.toHaveBeenCalled();
});
it("a USD dashboard launch needs no reviewed rate", async () => {
  const a = await ask();
  expect(await launchLinkedinCampaign("t", "bound", a, undefined, { approved_by: "owner-1", reviewed_units_per_usd: null })).toEqual({ status: "active" });
});
const releases = () => m.rpc.mock.calls.filter((c) => c[1] === "ads_release_unsent_linkedin_launch").map((c) => c[2]);
it.each([
  ["a 422", new ExpectedToolError("linkedin_ads_write_refused", LINKEDIN_ADS_CHANGE_REFUSED, { status: 422, http_status: 422, linkedin_reason: "totalBudget: below minimum" }), FIRST_WRITE_REFUSED],
  ["a 402", new ExpectedToolError("linkedin_ads_write_refused", "LinkedIn says this ad account has a billing problem. Fix the payment method in LinkedIn Campaign Manager, then try again.", { status: 402, http_status: 402 }), "LinkedIn says this ad account has a billing problem. Fix the payment method in LinkedIn Campaign Manager, then try again. Nothing changed in LinkedIn and nothing was held."],
  ["a billing hold", new ExpectedToolError("linkedin_ads_write_refused", "LinkedIn has paused your ad account for billing. Add or fix the payment method in LinkedIn Campaign Manager, then try again.", { status: 400, http_status: 400, billing_hold: true }), "LinkedIn has paused your ad account for billing. Add or fix the payment method in LinkedIn Campaign Manager, then try again. Nothing changed in LinkedIn and nothing was held."],
])("when LinkedIn refuses the first launch write with %s, gives back both holds, leaves no claim, sends nothing else and lets the founder retry", async (_label, refusal, copy) => {
  m.deleteOk = true;
  m.rpc.mockImplementation(async (_t, name) => {
    m.events.push(name);
    return { data: name === "ads_reserve_linkedin_launch" ? 1500 : true, error: null };
  });
  m.post.mockRejectedValueOnce(refusal);
  const a = await ask();
  const { err, status, body } = await founderRefusal(() => launchLinkedinCampaign("t", "bound", a));
  expect(err.code).toBe("ads_launch_not_sent");
  expect(status).toBe(409);
  expect(body.error.message).toBe(copy);
  expect(body.error.message).not.toMatch(/HTTP|cap_refuse|below minimum/);
  expect(m.post).toHaveBeenCalledTimes(1);
  expect(m.pause).not.toHaveBeenCalled();
  expect(m.drop).toHaveBeenCalledWith(expect.objectContaining({ status: "held", fresh: true }), { strict: true });
  expect(releases()).toEqual([{ p_campaign_binding_id: "bound", p_operation_id: request, p_prior_reserved_cents: 1500 }]);
  expect(m.commit).not.toHaveBeenCalled();
  expect(m.deleted).toEqual(["ads_campaign_operations"]);
  expect(m.finish).toEqual([]);
  expect(await launchLinkedinCampaign("t", "bound", { ...(await ask()), request_id: "10000000-0000-4000-8000-000000000002" })).toEqual({ status: "active" });
  expect(m.finish).toEqual(["succeeded"]);
});
it("a clean LinkedIn refusal after the first write changed the budget keeps the campaign paused and is not an unknown outcome", async () => {
  m.deleteOk = true;
  m.post.mockImplementation(async (_token, path) => {
    if (path.includes("creatives")) throw new ExpectedToolError("linkedin_ads_write_refused", LINKEDIN_ADS_CHANGE_REFUSED, { status: 422, http_status: 422 });
    return {};
  });
  const err = await launchLinkedinCampaign("t", "bound", await ask()).catch((e) => e);
  expect(err.code).toBe("ads_launch_not_sent");
  expect(err.meta?.outcome_unknown).toBeUndefined();
  expect(err.message).toContain("kept this launch's new total budget and end date");
  expect(m.pause).not.toHaveBeenCalled();
  expect(m.drop).toHaveBeenCalledTimes(1);
  expect(releases()).toHaveLength(1);
  expect(m.deleted).toEqual(["ads_campaign_operations"]);
  expect(m.finish).toEqual([]);
});
it("a 5xx on the first launch write stays unknown: LinkedIn may have applied it", async () => {
  m.post.mockRejectedValueOnce(new ExpectedToolError("linkedin_ads_http_error", "LinkedIn Ads is not responding right now. Try again in a few minutes.", { status: 503, http_status: 503 }));
  await launchLinkedinCampaign("t", "bound", await ask()).catch(() => undefined);
  expect(m.pause).toHaveBeenCalled();
  expect(m.drop).not.toHaveBeenCalled();
  expect(m.finish).toEqual(["uncertain"]);
});
const PLATFORM_UNREAD_LOGIN = "cap_refuse: ad_budget_platform_unread: LinkedIn spend could not be read on the last check, so its month is unknown. Reconnect it in Settings; nothing was sent";
it.each([
  ["cap_refuse: ad_budget_over_month", "This launch would go over your monthly ad budget. Nothing was sent to LinkedIn. Lower the total budget or raise your monthly ad budget, then try again."],
  ["cap_refuse: ad_budget_over_daily_limit", "This launch would go over the daily limit on your monthly ad budget. Nothing was sent to LinkedIn. Raise the daily limit on your monthly ad budget on the Growth page, or lower this campaign's daily budget, then try again."],
  [PLATFORM_UNREAD_LOGIN, "Zavi could not read your LinkedIn ad spending on its last check, so it cannot tell how much of this month's ad budget is left. Nothing was sent to LinkedIn. Reconnect LinkedIn Ads from Connectors in the left menu, then try again."],
  ["cap_refuse: ad_budget_platform_unread: LinkedIn spend couldn't be read this hour; budget raises on LinkedIn wait until it reads again. Nothing was sent", "Zavi could not read your LinkedIn ad spending on its last check, so it cannot tell how much of this month's ad budget is left. Nothing was sent to LinkedIn. Try again after the next hourly check."],
  ["cap_refuse: ad_budget_object_busy: another change to this ad is still in flight; try again shortly", "Another change to this campaign is still finishing. Nothing was sent to LinkedIn. Try again in a minute."],
  ["cap_refuse: ad_budget_over_projection: this month is on track for $1,200, $200 over your $1,000 cap, so Autopilot adds no spend. Approve it yourself to go ahead; nothing was sent", "This month's ad spending is on track to go over your monthly ad budget, so this launch was not sent to LinkedIn. Open the launch and approve it yourself to go ahead."],
  ["cap_refuse: ad_budget_unavailable: this month's projection could not be checked, so Autopilot added no spend; nothing was sent", "Zavi could not check your monthly ad budget just now. Nothing was sent to LinkedIn. Try again in a minute."],
])("the monthly budget refusal %s reaches the founder in plain words, keeping the original for the approval card", async (raw, copy) => {
  m.deleteOk = true;
  m.hold.mockResolvedValueOnce({ status: "refused", error: raw });
  const a = await ask();
  const { err, status, body } = await founderRefusal(() => launchLinkedinCampaign("t", "bound", a));
  expect(status).toBe(409);
  expect(body.error.message).toBe(copy);
  expect(body.error.message).not.toMatch(/cap_refuse|ad_budget_|Autopilot|Settings/);
  expect(err.meta).toEqual({ budget_refusal: raw });
  expect(m.post).not.toHaveBeenCalled();
  expect(m.events).not.toContain("ads_reserve_linkedin_launch");
  expect(m.deleted).toEqual(["ads_campaign_operations"]);
});
it("a monthly budget stopped between the review and the launch says so instead of asking for another review", async () => {
  m.hold.mockResolvedValueOnce({ status: "no_budget" });
  const a = await ask();
  const { body } = await founderRefusal(() => launchLinkedinCampaign("t", "bound", a));
  expect(body.error.message).toBe("Your monthly ad budget was turned off while this launch was being checked. Nothing was sent to LinkedIn. Set a monthly ad budget, then try again.");
  expect(m.post).not.toHaveBeenCalled();
});
it("an own-billing relaunch at or below its spend so far is refused before any claim, hold or LinkedIn write", async () => {
  context.binding.funding_source = "provider";
  m.spend.mockResolvedValue({ cents: 30000 });
  const a = await ask();
  a.total_budget_cents = 20000;
  await expect(launchLinkedinCampaign("t", "bound", a)).rejects.toThrow("so a new total must be above that");
  expect(m.spend).toHaveBeenCalledWith("t", "bound", { anyCurrency: true });
  expect(m.rpc).not.toHaveBeenCalled();
  expect(m.hold).not.toHaveBeenCalled();
  expect(m.post).not.toHaveBeenCalled();
});
it.each(["provider", "wallet"])("a %s relaunch holds only what is left of the new total in the monthly budget", async (funding) => {
  context.binding.funding_source = funding;
  m.spend.mockResolvedValue({ cents: 6000 });
  expect(await launchLinkedinCampaign("t", "bound", await ask())).toEqual({ status: "active" });
  expect(m.hold.mock.calls[0]![1]).toMatchObject({ daily_delta_usd: 40, lifetime_usd: 40, observed_usd: 60, currency: "USD" });
  expect(m.post.mock.calls[0]![3].patch.$set.totalBudget).toEqual({ amount: "100.00", currencyCode: "USD" });
});
const inrAccountSpent = (cents: number) => {
  context.account.currency = "INR";
  m.fx.mockImplementation(async (currency) => ({ currency, units_per_usd: currency === "INR" ? 80 : 1, as_of: null, source: "ExchangeRate-API" }));
  m.spend.mockImplementation(async (_t: string, _b: string, options?: { anyCurrency?: boolean }) => {
    if (!options?.anyCurrency) throw new ExpectedToolError("ads_currency_unsupported", "Shared wallet settlement supports USD accounts only.");
    return { cents };
  });
};
it("an INR own-billing relaunch counts the rupees already spent: it holds only the USD of what is left and shows the real spend", async () => {
  context.binding.funding_source = "provider";
  inrAccountSpent(4_000_000);
  expect(await linkedinLaunchObservedCents("t", "bound", "provider")).toBe(4_000_000);
  const r = await ask();
  r.total_budget_cents = 5_000_000;
  expect(await launchLinkedinCampaign("t", "bound", r)).toEqual({ status: "active" });
  expect(m.hold).toHaveBeenCalledTimes(1);
  expect(m.hold.mock.calls[0]![1]).toMatchObject({ lifetime_usd: 125, currency: "USD" });
  expect(m.post.mock.calls[0]![3].patch.$set.totalBudget).toEqual({ amount: "50000.00", currencyCode: "INR" });
});
it("an INR own-billing relaunch at or below the rupees already spent is refused before any claim, hold or LinkedIn write", async () => {
  context.binding.funding_source = "provider";
  inrAccountSpent(4_000_000);
  const r = await ask();
  r.total_budget_cents = 4_000_000;
  await expect(launchLinkedinCampaign("t", "bound", r)).rejects.toThrow("so a new total must be above that");
  expect(m.rpc).not.toHaveBeenCalled();
  expect(m.hold).not.toHaveBeenCalled();
  expect(m.post).not.toHaveBeenCalled();
});
it("a wallet launch still reads spend under the USD-only wallet rule", async () => {
  inrAccountSpent(4_000_000);
  expect(await linkedinLaunchObservedCents("t", "bound", "wallet")).toBeNull();
  await expect(launchLinkedinCampaign("t", "bound", await ask())).rejects.toMatchObject({ code: "ads_currency_unsupported" });
  expect(m.hold).not.toHaveBeenCalled();
});
it.each([
  ["approved the day before month end, 30 days out", 30, 30, 20],
  ["a 3-day flight", 3, 30, 200],
])("%s: the monthly hold is the remaining total, ending on the campaign's end date", async (_label, flightDays, daysLeft, perDay) => {
  m.activeBudget.mockResolvedValue({ days_left: daysLeft });
  context.campaign.dailyBudget = { amount: `${perDay}.00`, currencyCode: "USD" };
  const r = await ask();
  r.total_budget_cents = 60_000;
  r.end_time = Date.now() + flightDays * 86_400_000;
  expect(await launchLinkedinCampaign("t", "bound", r)).toEqual({ status: "active" });
  const day = new Date(Math.ceil(Math.ceil(r.end_time / 1000) / 86_400) * 86_400_000 + 86_400_000).toISOString().slice(0, 10);
  expect(m.hold.mock.calls[0]![1]).toEqual({
    platform: "linkedin",
    op: "resume",
    object_id: "bound",
    daily_delta_usd: perDay,
    currency: "USD",
    lifetime_usd: 600,
    observed_usd: 0,
    ends_on: day,
    refuse_over_cap: true,
  });
});
const LINKEDIN_ADS_DAILY_LIMIT = "LinkedIn's daily allowance of requests for this LinkedIn connection is used up. It resets at 00:00 UTC (5:30 AM IST). Try again after that.";
const SPEND_UNREAD = "Zavi could not read this campaign's spending from LinkedIn just now. Nothing was sent to LinkedIn, and nothing was held or spent. Try again in a few minutes.";
it.each([
  ["provider", "a LinkedIn 5xx", new ExpectedToolError("linkedin_ads_http_error", "LinkedIn Ads is not responding right now. Try again in a few minutes.", { status: 503, http_status: 503 })],
  ["provider", "a network failure", new TypeError("fetch failed")],
  ["provider", "an unreadable report", new Error("LinkedIn spend is unavailable")],
  ["wallet", "a LinkedIn 5xx", new ExpectedToolError("linkedin_ads_http_error", "LinkedIn Ads is not responding right now. Try again in a few minutes.", { status: 503, http_status: 503 })],
  ["wallet", "an unreadable report", new Error("LinkedIn campaign spend is incomplete")],
])("a %s launch whose spend so far hits %s is a plain 409 refusal that says nothing was held, before any claim, hold or write", async (funding, _label, failure) => {
  context.binding.funding_source = funding;
  m.spend.mockRejectedValue(failure);
  const { err, status, body } = await founderRefusal(async () => launchLinkedinCampaign("t", "bound", await ask()));
  expect(err.code).toBe("ads_launch_conflict");
  expect(status).toBe(409);
  expect(body.error.message).toBe(SPEND_UNREAD);
  expect(body.error.message).not.toMatch(/stays held|set aside/);
  expect(m.rpc).not.toHaveBeenCalled();
  expect(m.hold).not.toHaveBeenCalled();
  expect(m.drop).not.toHaveBeenCalled();
  expect(m.post).not.toHaveBeenCalled();
  expect(m.finish).toEqual([]);
});
it.each(["provider", "wallet"])("a %s launch that hits LinkedIn's daily limit gives the real cause and reset time, says nothing was held, and touches no money", async (funding) => {
  context.binding.funding_source = funding;
  m.spend.mockRejectedValue(new ExpectedToolError("linkedin_ads_http_error", LINKEDIN_ADS_DAILY_LIMIT, { status: 429, http_status: 429 }));
  const { err, status, body } = await founderRefusal(async () => launchLinkedinCampaign("t", "bound", await ask()));
  expect(err.code).toBe("ads_launch_conflict");
  expect(status).toBe(409);
  expect(body.error.message).toBe(`${LINKEDIN_ADS_DAILY_LIMIT} Nothing was sent to LinkedIn, and nothing was held or spent.`);
  expect(body.error.message).toContain("00:00 UTC");
  expect(body.error.message).not.toContain("few minutes");
  expect(m.rpc).not.toHaveBeenCalled();
  expect(m.hold).not.toHaveBeenCalled();
  expect(m.post).not.toHaveBeenCalled();
});
it.each([
  ["provider", "revoked", new ExpectedToolError("linkedin_ads_token_revoked", "Reconnect LinkedIn Ads from Connectors.", { status: 401, http_status: 401 }), 401],
  ["wallet", "revoked", new ExpectedToolError("linkedin_ads_token_revoked", "Reconnect LinkedIn Ads from Connectors.", { status: 401, http_status: 401 }), 401],
  ["provider", "refused by LinkedIn", new ExpectedToolError("linkedin_ads_forbidden", "LinkedIn did not let Zavi read this ad account. Reconnect LinkedIn Ads from Connectors.", { status: 403, http_status: 403 }), 403],
  ["wallet", "refused by LinkedIn", new ExpectedToolError("linkedin_ads_forbidden", "LinkedIn did not let Zavi read this ad account. Reconnect LinkedIn Ads from Connectors.", { status: 403, http_status: 403 }), 403],
])("a %s launch whose LinkedIn access was %s mid-review keeps the reconnect code, status and words, and holds, writes and spends nothing", async (funding, _label, failure, httpStatus) => {
  context.binding.funding_source = funding;
  m.spend.mockRejectedValue(failure);
  const { err, status, body } = await founderRefusal(async () => launchLinkedinCampaign("t", "bound", await ask()));
  expect(err.code).toBe(failure.code);
  expect(err.meta).toMatchObject({ http_status: httpStatus });
  expect(status).toBe(403);
  expect(body.error.code).toBe(failure.code);
  expect(body.error.message).toBe(`${failure.message} Nothing was sent to LinkedIn, and nothing was held or spent.`);
  expect(m.rpc).not.toHaveBeenCalled();
  expect(m.hold).not.toHaveBeenCalled();
  expect(m.drop).not.toHaveBeenCalled();
  expect(m.post).not.toHaveBeenCalled();
  expect(m.finish).toEqual([]);
});
it("a LinkedIn 5xx on the spend read stays a 409 refusal but carries LinkedIn's status", async () => {
  context.binding.funding_source = "wallet";
  m.spend.mockRejectedValue(new ExpectedToolError("linkedin_ads_http_error", "LinkedIn Ads is not responding right now.", { status: 503, http_status: 503 }));
  const { err, status } = await founderRefusal(async () => launchLinkedinCampaign("t", "bound", await ask()));
  expect(err.code).toBe("ads_launch_conflict");
  expect(err.meta).toMatchObject({ http_status: 503 });
  expect(status).toBe(409);
  expect(m.hold).not.toHaveBeenCalled();
});
it("a wallet launch on a non-USD account still refuses as unsupported rather than reading as a temporary failure", async () => {
  m.spend.mockRejectedValue(new ExpectedToolError("ads_currency_unsupported", "Shared wallet settlement supports USD accounts only."));
  const { err, status } = await founderRefusal(async () => launchLinkedinCampaign("t", "bound", await ask()));
  expect(err.code).toBe("ads_currency_unsupported");
  expect(status).toBe(409);
  expect(m.rpc).not.toHaveBeenCalled();
});
it.each(["wallet", "provider"])("a %s retry that finds the hold its lost first reservation took gives it back when it then stops before LinkedIn, and leaves the request reclaimable", async (funding) => {
  context.binding.funding_source = funding;
  m.deleteOk = true;
  const real = await vi.importActual<typeof import("@/services/decisions/ad-budget")>("@/services/decisions/ad-budget");
  m.drop.mockImplementation(real.dropAdSpendHold);
  const settled: string[] = [];
  const base = m.rpc.getMockImplementation()!;
  m.rpc.mockImplementation(async (tenant, name, args) => {
    if (name === "settle_ad_spend") {
      settled.push(`${args.p_idem_key}:${args.p_outcome}`);
      return { data: { status: args.p_outcome }, error: null };
    }
    return base(tenant, name, args);
  });
  const a = await ask();
  m.hold.mockResolvedValueOnce({ status: "refused", error: "cap_refuse: ad_budget_unavailable: the ad budget could not be checked, nothing was sent" });
  await expect(launchLinkedinCampaign("t", "bound", a)).rejects.toMatchObject({ code: "ads_launch_conflict" });
  expect(settled).toEqual([]);
  m.hold.mockImplementationOnce(async () => {
    m.lifecycle.stop_requested_at = new Date().toISOString();
    return { status: "held", fresh: false, tenant_id: "t", idem_key: `${request}:resume` };
  });
  m.deleted = [];
  m.finish = [];
  await expect(launchLinkedinCampaign("t", "bound", a)).rejects.toThrow(PAUSED_DURING_LAUNCH);
  expect(m.post).not.toHaveBeenCalled();
  expect(settled).toEqual([`${request}:resume:released`]);
  expect(m.deleted).toEqual(["ads_campaign_operations"]);
  expect(m.finish).toEqual([]);
});
const approvedLater = async (draft: Awaited<ReturnType<typeof ask>>, laterMs: number) => {
  const real = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(real + laterMs);
  const beforeWrite = vi.fn(async () => {});
  try {
    return { result: await launchLinkedinCampaign("t", "bound", draft, beforeWrite).catch((e: Error) => e), beforeWrite };
  } finally {
    clock.mockRestore();
  }
};
it("refuses a card approved after its end date passed, asks for a new end date and never moves the date", async () => {
  const draft = await ask();
  const { result, beforeWrite } = await approvedLater(draft, 2 * 86400000);
  expect(result).toBeInstanceOf(ExpectedToolError);
  expect((result as ExpectedToolError).message).toBe(
    `The end date on this launch (${utcStamp(draft.end_time)}) has already passed. Nothing was sent to LinkedIn and your campaign stays paused. Ask Zavi for a new end date, then approve the new card.`,
  );
  expect(beforeWrite).not.toHaveBeenCalled();
  expect(m.hold).not.toHaveBeenCalled();
  expect(m.rpc).not.toHaveBeenCalled();
  expect(m.post).not.toHaveBeenCalled();
  expect(context.campaign.runSchedule).toEqual({ start: context.campaign.runSchedule.start });
  expect(context.campaign.status).toBe("PAUSED");
});
it("refuses a card approved so late that under 12 hours of its flight are left", async () => {
  const draft = await ask();
  const { result, beforeWrite } = await approvedLater(draft, 20 * 3600000);
  expect((result as ExpectedToolError).message).toMatch(/^This launch would stop .+ UTC, less than 12 hours from now\. Nothing was sent to LinkedIn and your campaign stays paused\. Ask Zavi for a new end date, then approve the new card\.$/);
  expect(beforeWrite).not.toHaveBeenCalled();
  expect(m.hold).not.toHaveBeenCalled();
  expect(m.post).not.toHaveBeenCalled();
});
it("launches a card approved with more than 12 hours left on exactly the end date the card showed", async () => {
  const draft = await ask();
  const { result, beforeWrite } = await approvedLater(draft, 11 * 3600000);
  expect(result).toEqual({ status: "active" });
  expect(beforeWrite).toHaveBeenCalled();
  const budgetWrite = m.post.mock.calls.find((c) => c[3]?.patch?.$set?.runSchedule);
  expect(budgetWrite![3].patch.$set.runSchedule.end).toBe(draft.end_time);
  expect(context.campaign.runSchedule.end).toBe(draft.end_time);
});
it("reads the observed lifetime spend for the launch review the way the launch counts it", async () => {
  m.spend.mockResolvedValue({ cents: 42000 });
  expect(await linkedinLaunchObservedCents("t", "bound", "provider")).toBe(42000);
  expect(await linkedinLaunchObservedCents("t", "bound", "wallet")).toBe(42000);
  expect(m.spend.mock.calls.map((c) => c[2])).toEqual([{ anyCurrency: true }, { anyCurrency: false }]);
  m.spend.mockRejectedValue(new ExpectedToolError("ads_currency_unsupported", "Shared wallet settlement supports USD accounts only."));
  expect(await linkedinLaunchObservedCents("t", "bound", "wallet")).toBeNull();
  m.spend.mockRejectedValue(new ExpectedToolError("linkedin_ads_rate_limited", "LinkedIn is busy."));
  expect(await linkedinLaunchObservedCents("t", "bound", "provider")).toBeNull();
  m.spend.mockRejectedValue(new Error("socket hang up"));
  expect(await linkedinLaunchObservedCents("t", "bound", "wallet")).toBeNull();
  expect(m.get).not.toHaveBeenCalled();
  expect(m.post).not.toHaveBeenCalled();
});
it("reads the campaign's own hold for the launch review by this tenant and this LinkedIn binding only, and says unknown rather than 0 when it cannot", async () => {
  m.rpc.mockReset();
  m.rpc.mockResolvedValueOnce({ data: "10.00", error: null });
  expect(await linkedinLaunchOwnHoldUsd("tenant-a", "bound")).toBe(10);
  expect(m.rpc.mock.calls).toEqual([["tenant-a", "ad_object_hold_usd", { p_platform: "linkedin", p_object_id: "bound" }]]);
  m.rpc.mockResolvedValueOnce({ data: null, error: { message: "permission denied" } });
  expect(await linkedinLaunchOwnHoldUsd("tenant-a", "bound")).toBeNull();
  m.rpc.mockRejectedValueOnce(new Error("socket hang up"));
  expect(await linkedinLaunchOwnHoldUsd("tenant-a", "bound")).toBeNull();
  m.rpc.mockResolvedValueOnce({ data: "-1", error: null });
  expect(await linkedinLaunchOwnHoldUsd("tenant-a", "bound")).toBeNull();
  expect(m.post).not.toHaveBeenCalled();
});
it.each([
  ["USD", 1, "10.00", 600],
  ["EUR", 0.8, "10.00", 750],
])("a %s campaign whose daily budget would pace below the total by its end date still holds the whole total LinkedIn enforces, and sends LinkedIn the full approved total", async (currency, _rate, daily, heldUsd) => {
  context.binding.funding_source = "provider";
  context.account.currency = currency;
  context.campaign.dailyBudget = { amount: daily, currencyCode: currency };
  const r = await ask();
  r.total_budget_cents = 60_000;
  r.end_time = Date.now() + 3 * 86_400_000 - 3_600_000;
  expect(await launchLinkedinCampaign("t", "bound", r)).toEqual({ status: "active" });
  expect(m.hold).toHaveBeenCalledTimes(1);
  expect(m.hold.mock.calls[0]![1]).toMatchObject({ lifetime_usd: heldUsd, op: "resume", currency: "USD" });
  const budgetWrite = m.post.mock.calls.find(([, , , body]) => body.patch.$set.totalBudget)!;
  expect(budgetWrite[3].patch.$set.totalBudget).toEqual({ amount: "600.00", currencyCode: currency });
  expect(budgetWrite[3].patch.$set).not.toHaveProperty("dailyBudget");
  expect(context.campaign.dailyBudget).toEqual({ amount: daily, currencyCode: currency });
});
it("a daily budget that can spend more than the total by the end date holds the total, never more", async () => {
  context.binding.funding_source = "provider";
  context.campaign.dailyBudget = { amount: "300.00", currencyCode: "USD" };
  const r = await ask();
  r.total_budget_cents = 60_000;
  r.end_time = Date.now() + 3 * 86_400_000 - 3_600_000;
  expect(await launchLinkedinCampaign("t", "bound", r)).toEqual({ status: "active" });
  expect(m.hold.mock.calls[0]![1]).toMatchObject({ lifetime_usd: 600 });
});
it("a relaunch with spend so far holds what is left of the total, whatever the daily budget could still spend", async () => {
  context.binding.funding_source = "provider";
  context.campaign.dailyBudget = { amount: "10.00", currencyCode: "USD" };
  m.spend.mockResolvedValue({ cents: 50_000 });
  const r = await ask();
  r.total_budget_cents = 60_000;
  r.end_time = Date.now() + 3 * 86_400_000 - 3_600_000;
  expect(await launchLinkedinCampaign("t", "bound", r)).toEqual({ status: "active" });
  expect(m.hold.mock.calls[0]![1]).toMatchObject({ lifetime_usd: 100 });
  m.hold.mockClear();
  m.spend.mockResolvedValue({ cents: 58_000 });
  context.campaign.status = "PAUSED";
  const again = await ask();
  again.request_id = "10000000-0000-4000-8000-000000000002";
  again.total_budget_cents = 60_000;
  again.end_time = r.end_time;
  expect(await launchLinkedinCampaign("t", "bound", again)).toEqual({ status: "active" });
  expect(m.hold.mock.calls[0]![1]).toMatchObject({ lifetime_usd: 20 });
});
it("a $1000 total at $10 a day for 10 days holds the whole $1000 for the month and checks the $10 LinkedIn spends in a day", async () => {
  context.binding.funding_source = "provider";
  context.campaign.dailyBudget = { amount: "10.00", currencyCode: "USD" };
  const r = await ask();
  r.total_budget_cents = 100_000;
  r.end_time = Date.now() + 10 * 86_400_000;
  expect(await launchLinkedinCampaign("t", "bound", r)).toEqual({ status: "active" });
  expect(m.hold).toHaveBeenCalledTimes(1);
  expect(m.hold.mock.calls[0]![1]).toMatchObject({ lifetime_usd: 1000, op: "resume", refuse_over_cap: true });
  expect(m.hold.mock.calls[0]![1].daily_delta_usd).toBe(10);
});
it("LinkedIn's smallest total is one number: a $10 total launches, $9.99 is refused before any claim, and the planner takes a LinkedIn ask under $100", async () => {
  const { shapeDirectAsk } = await import("@/services/growth/direct-ad-ask");
  const { linkedinMinTotalUsd } = await import("@zavi/shared");
  expect(linkedinMinTotalUsd()).toBe(10);
  context.binding.funding_source = "provider";
  context.campaign.dailyBudget = { amount: "10.00", currencyCode: "USD" };
  const r = await ask();
  r.total_budget_cents = 1000;
  expect(await launchLinkedinCampaign("t", "bound", r)).toEqual({ status: "active" });
  expect(m.hold.mock.calls[0]![1]).toMatchObject({ lifetime_usd: 10 });
  m.rpc.mockClear();
  m.post.mockClear();
  context.campaign.status = "PAUSED";
  const low = await ask();
  low.request_id = "10000000-0000-4000-8000-000000000003";
  low.total_budget_cents = 999;
  await expect(launchLinkedinCampaign("t", "bound", low)).rejects.toThrow();
  expect(m.rpc).not.toHaveBeenCalled();
  expect(m.post).not.toHaveBeenCalled();
  const plan = shapeDirectAsk({ channel_slug: "linkedin_ads", total_usd: 25, daily_usd: null, days: null }, "2026-10-15");
  expect(plan.kind).toBe("plan");
});

describe("the daily limit is checked against what LinkedIn can spend in a day", () => {
  it.each([
    ["a slow total on a fast daily budget: the old total-over-days figure was $3.34", 10_000, 30, "50.00", 50],
    ["a fast total on a slow daily budget: the old figure was $100", 100_000, 10, "10.00", 10],
    ["a daily budget equal to the total cannot spend more than the total", 10_000, 30, "100.00", 100],
  ])("%s", async (_label, cents, days, daily, expected) => {
    context.binding.funding_source = "provider";
    context.campaign.dailyBudget = { amount: daily, currencyCode: "USD" };
    const r = await ask();
    r.total_budget_cents = cents;
    r.end_time = Date.now() + days * 86_400_000;
    await launchLinkedinCampaign("t", "bound", r);
    expect(m.hold.mock.calls[0]![1]).toMatchObject({ daily_delta_usd: expected, lifetime_usd: cents / 100 });
  });
  it("a campaign with no daily budget has no pace to rely on, so the whole remaining total counts", async () => {
    context.binding.funding_source = "provider";
    const r = await ask();
    r.end_time = Date.now() + 30 * 86_400_000;
    await launchLinkedinCampaign("t", "bound", r);
    expect(m.hold.mock.calls[0]![1].daily_delta_usd).toBe(100);
  });
  it("a foreign-currency daily budget is compared in dollars, not in its own units", async () => {
    context.binding.funding_source = "provider";
    context.account.currency = "EUR";
    context.campaign.dailyBudget = { amount: "40.00", currencyCode: "EUR" };
    const r = await ask();
    r.total_budget_cents = 80_000;
    await launchLinkedinCampaign("t", "bound", r);
    expect(m.hold.mock.calls[0]![1].daily_delta_usd).toBe(50);
  });
  it("after spend, a day cannot cost more than what is left", async () => {
    context.campaign.dailyBudget = { amount: "50.00", currencyCode: "USD" };
    m.spend.mockResolvedValue({ cents: 9_000 });
    await launchLinkedinCampaign("t", "bound", await ask());
    expect(m.hold.mock.calls[0]![1].daily_delta_usd).toBe(10);
  });
});

describe("the launch snapshot covers what the founder approved and nothing that moves on its own", () => {
  const tree = () => ({
    campaign: {
      id: "123", account: "urn:li:sponsoredAccount:42", campaignGroup: "urn:li:sponsoredCampaignGroup:7", name: "Pilot", status: "PAUSED",
      associatedEntity: "urn:li:organization:9", type: "SPONSORED_UPDATES", objectiveType: "WEBSITE_VISIT", costType: "CPM", optimizationTargetType: "NONE",
      dailyBudget: { amount: "15.00", currencyCode: "USD" }, unitCost: { amount: "6.00", currencyCode: "USD" }, locale: { country: "US", language: "en" },
      targetingCriteria: { include: { and: [{ or: { locations: ["urn:li:geo:1", "urn:li:geo:2"] } }] } }, audienceExpansionEnabled: false, offsiteDeliveryEnabled: false,
      totalBudget: { amount: "100.00", currencyCode: "USD" }, runSchedule: { start: 1, end: 2 }, version: { tag: "1" },
      changeAuditStamps: { created: { time: 1 }, lastModified: { time: 2 } },
    } as any,
    currency: "USD",
    group: { id: 7, account: "urn:li:sponsoredAccount:42", status: "DRAFT" } as any,
    creatives: [{ rawId: "8", campaign: "urn:li:sponsoredCampaign:123", content: { reference: "urn:li:share:1" }, intendedStatus: "DRAFT", servingHoldReasons: [] as string[] }] as any[],
    stop_requested_at: null as string | null,
  });
  const base = linkedinLaunchSnapshot(tree());
  it.each<[string, (t: ReturnType<typeof tree>) => void]>([
    ["the audit stamp LinkedIn moves by itself", (t) => { t.campaign.changeAuditStamps.lastModified.time = 99; }],
    ["LinkedIn's version tag", (t) => { t.campaign.version = { tag: "2" }; }],
    ["a new field LinkedIn starts returning", (t) => { t.campaign.brandNewField = { x: 1 }; }],
    ["the total the launch overwrites", (t) => { t.campaign.totalBudget = { amount: "1.00", currencyCode: "USD" }; }],
    ["the schedule the launch overwrites", (t) => { t.campaign.runSchedule = { start: 5, end: 6 }; }],
    ["the campaign status, which has its own refusal", (t) => { t.campaign.status = "ACTIVE"; }],
    ["the group status, which has its own refusal", (t) => { t.group.status = "ACTIVE"; }],
    ["an ad's review state, which has its own refusal and can recover", (t) => { t.creatives[0].servingHoldReasons = ["UNDER_REVIEW"]; t.creatives[0].intendedStatus = "PAUSED"; }],
    ["the order LinkedIn lists targeting in", (t) => { t.campaign.targetingCriteria.include.and[0].or.locations.reverse(); }],
    ["the order object keys arrive in", (t) => { t.campaign = Object.fromEntries(Object.entries(t.campaign).reverse()); }],
  ])("ignores %s", (_label, change) => {
    const t = tree();
    change(t);
    expect(linkedinLaunchSnapshot(t)).toBe(base);
  });
  it.each<[string, (t: ReturnType<typeof tree>) => void]>([
    ["the name", (t) => { t.campaign.name = "Other"; }],
    ["the daily budget", (t) => { t.campaign.dailyBudget.amount = "15.01"; }],
    ["a daily budget being removed", (t) => { delete t.campaign.dailyBudget; }],
    ["the bid", (t) => { t.campaign.unitCost.amount = "7.00"; }],
    ["the audience", (t) => { t.campaign.targetingCriteria.include.and[0].or.locations.push("urn:li:geo:3"); }],
    ["audience expansion", (t) => { t.campaign.audienceExpansionEnabled = true; }],
    ["offsite delivery", (t) => { t.campaign.offsiteDeliveryEnabled = true; }],
    ["the company page", (t) => { t.campaign.associatedEntity = "urn:li:organization:10"; }],
    ["the objective", (t) => { t.campaign.objectiveType = "LEAD_GENERATION"; }],
    ["the group", (t) => { t.campaign.campaignGroup = "urn:li:sponsoredCampaignGroup:8"; }],
    ["the account currency", (t) => { t.currency = "EUR"; }],
    ["the post an ad runs", (t) => { t.creatives[0].content = { reference: "urn:li:share:2" }; }],
    ["an extra ad", (t) => { t.creatives.push({ ...t.creatives[0], rawId: "9" }); }],
    ["a pause request", (t) => { t.stop_requested_at = "2026-10-30T00:00:00Z"; }],
  ])("changes with %s", (_label, change) => {
    const t = tree();
    change(t);
    expect(linkedinLaunchSnapshot(t)).not.toBe(base);
  });
  it("a launch still goes ahead after LinkedIn moved only its own bookkeeping since review", async () => {
    context.campaign.changeAuditStamps = { created: { time: 1 }, lastModified: { time: 2 } };
    const a = await ask();
    context.campaign.changeAuditStamps.lastModified.time = 999;
    context.campaign.version = { tag: "new" };
    expect(await launchLinkedinCampaign("t", "bound", a)).toEqual({ status: "active" });
    expect(m.post).toHaveBeenCalled();
  });
});

describe("a launch card is refused at filing for what the executor would refuse", () => {
  const filed = async (cents: number, endTime: number) => {
    const s = await linkedinLaunchSummary("t", "bound");
    return linkedinLaunchFilingRefusal("t", s, { total_budget_cents: cents, end_time: endTime });
  };
  const week = () => Date.now() + 7 * 86_400_000;
  beforeEach(() => {
    m.activeBudget.mockResolvedValue({ days_left: 10, left_usd: 1000, daily_limit_usd: null, margin: 1 });
    m.opRows = [];
    m.rpc.mockImplementation(async (_t, name) => (name === "ad_object_hold_usd" ? { data: 0, error: null } : { data: true, error: null }));
  });
  const blockers: Array<[string, () => void, string | RegExp, number?, number?]> = [
    ["a campaign no longer paused", () => { context.campaign.status = "ACTIVE"; }, "Only a paused campaign can be launched here."],
    ["a billing hold", () => { context.account.servingStatuses = ["BILLING_HOLD"]; }, /billing|payment/i],
    ["an own account not serving", () => { context.binding.funding_source = "provider"; context.account.servingStatuses = ["STOPPED"]; }, "This campaign cannot launch because LinkedIn has stopped the ad account from running ads. Check the account's status in LinkedIn Campaign Manager, then review the launch again. Nothing was sent to LinkedIn and your campaign stays paused."],
    ["a managed account not serving", () => { context.account.servingStatuses = ["STOPPED"]; }, "Zavi's managed LinkedIn ad account cannot run ads right now: LinkedIn has stopped the ad account from running ads. Zavi is sorting out its account, and there is nothing you need to fix. Nothing was sent to LinkedIn. Try again later. Your campaign stays paused."],
    ["an end date already gone", () => {}, /has already passed/, 10_000, -3600_000],
    ["an end date under 12 hours away", () => {}, /less than 12 hours/, 10_000, 3600_000],
    ["an end date past a year", () => {}, "Choose an end date within the next year.", 10_000, 400 * 86_400_000],
    ["writes switched off", () => { m.writesOn = false; }, /cannot launch campaigns yet/],
    ["a plan without LinkedIn", () => { m.tier.mockResolvedValue({ allowed: false, enforced: true }); }, "LinkedIn launch is unavailable for this workspace."],
    ["plan settings briefly unverified", () => { m.tier.mockResolvedValue({ allowed: true, enforced: false, unverified: true }); }, "Zavi could not check your plan just now, so nothing was sent to LinkedIn. Try again in a minute."],
    ["plan settings unreadable", () => { m.tier.mockRejectedValue(new Error("tenant_subscriptions read failed: timeout")); }, "Zavi could not check your plan just now, so nothing was sent to LinkedIn. Try again in a minute."],
    ["wallet payments switched off", () => { process.env.ADS_LINKEDIN_MANAGED_ENABLED = "false"; }, /not switched on yet/],
    ["a wallet grant gone", () => { m.grantMissing = true; }, /can no longer spend from the Zavi wallet/],
    ["shared wallet consent missing", () => { m.consent.mockRejectedValue(new ExpectedToolError("ads_consent_required", "Authorize the shared wallet first.")); }, "Authorize the shared wallet first."],
    ["no monthly budget", () => { m.activeBudget.mockResolvedValue(null); }, "Set a monthly ad budget before launching LinkedIn campaigns."],
  ];
  it.each(blockers)("%s: no card is filed, and the executor really does refuse with the same words", async (_label, arrange, words, cents = 10_000, ms = 7 * 86_400_000) => {
    const end = Date.now() + ms;
    const good = await ask();
    arrange();
    const refusal = await filed(cents, end);
    expect(refusal).toEqual(expect.stringMatching(words instanceof RegExp ? words : new RegExp(words.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))));
    m.post.mockClear();
    m.hold.mockClear();
    const live = await linkedinLaunchSummary("t", "bound").catch(() => null);
    const err = await launchLinkedinCampaign("t", "bound", { ...good, snapshot: live?.snapshot ?? good.snapshot, total_budget_cents: cents, end_time: end }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain(refusal!.replace(/, so Zavi cannot launch campaigns yet\.$/, ""));
    expect(m.post).not.toHaveBeenCalled();
    expect(m.hold).not.toHaveBeenCalled();
  });
  it("an ad that was rejected is caught at filing, with the executor's words", async () => {
    m.get.mockImplementation(async (_t, path) =>
      path.endsWith("adCampaignGroups/7") ? { id: 7, account: context.campaign.account, status: "DRAFT" }
      : path.includes("creatives") ? { id: 8, campaign: "urn:li:sponsoredCampaign:123", intendedStatus: "DRAFT", servingHoldReasons: ["CREATIVE_REJECTED"] }
      : siblings);
    expect(await filed(10_000, week())).toBe("One or more ads are not ready for launch.");
  });
  it("a foreign total under LinkedIn's dollar minimum is caught at filing", async () => {
    gbp(1000, "2026-10-25T00:00:01.000Z");
    context.account.currency = "GBP";
    expect(await filed(100_000, week())).toBe("The total budget must be at least $10 (converted to USD).");
  });
  it("a day LinkedIn can spend over the founder's daily limit is caught at filing, measured by the daily budget", async () => {
    m.activeBudget.mockResolvedValue({ days_left: 10, left_usd: 1000, daily_limit_usd: 40, margin: 1 });
    context.campaign.dailyBudget = { amount: "50.00", currencyCode: "USD" };
    const refusal = await filed(10_000, Date.now() + 30 * 86_400_000);
    expect(refusal).toBe("This launch would go over the daily limit on your monthly ad budget. It can spend up to $50.00 in a day, and the daily limit is $40.00. Nothing was sent to LinkedIn. Raise the daily limit on your monthly ad budget on the Growth page, or lower this campaign's daily budget, then try again.");
    expect(refusal).not.toMatch(/lower the total/i);
    context.campaign.dailyBudget = undefined;
    expect(await filed(10_000, Date.now() + 30 * 86_400_000)).toBe("This launch would go over the daily limit on your monthly ad budget. It can spend up to $100.00 in a day, and the daily limit is $40.00. Nothing was sent to LinkedIn. Raise the daily limit on your monthly ad budget on the Growth page, or lower the total budget, then try again.");
    context.campaign.dailyBudget = { amount: "40.00", currencyCode: "USD" };
    expect(await filed(100_000, Date.now() + 25 * 86_400_000)).toBeNull();
  });
  it("a total over what is left this month is caught at filing, counting the margin and this launch's own hold", async () => {
    m.activeBudget.mockResolvedValue({ days_left: 10, left_usd: 100, daily_limit_usd: null, margin: 1.1 });
    expect(await filed(10_000, week())).toMatch(/monthly ad budget/);
    m.activeBudget.mockResolvedValue({ days_left: 10, left_usd: 110, daily_limit_usd: null, margin: 1.1 });
    expect(await filed(10_000, week())).toBeNull();
    m.activeBudget.mockResolvedValue({ days_left: 10, left_usd: 100, daily_limit_usd: null, margin: 1.1 });
    m.rpc.mockImplementation(async (_t, name) => (name === "ad_object_hold_usd" ? { data: 10, error: null } : { data: true, error: null }));
    expect(await filed(10_000, week())).toBeNull();
  });
  it("a campaign that has run before skips the money checks: only LinkedIn knows what it spent, and filing asks LinkedIn nothing more", async () => {
    m.activeBudget.mockResolvedValue({ days_left: 10, left_usd: 1, daily_limit_usd: 1, margin: 1 });
    for (const status of ["succeeded", "uncertain", "pending"]) {
      m.opRows = [{ status }];
      expect(await filed(10_000, week())).toBeNull();
    }
    expect(m.spend).not.toHaveBeenCalled();
  });
  it("a launch refused before it ever ran does not count as having run", async () => {
    m.activeBudget.mockResolvedValue({ days_left: 10, left_usd: 1, daily_limit_usd: null, margin: 1 });
    m.opRows = [{ status: "refused" }];
    expect(await filed(10_000, week())).toMatch(/monthly ad budget/);
  });
  it("a failed budget read or consent read does not stop filing: the executor still checks at approval", async () => {
    m.activeBudget.mockRejectedValue(new Error("db down"));
    m.consent.mockRejectedValue(new Error("db down"));
    expect(await filed(10_000, week())).toBeNull();
  });
  it("a card the executor would accept files, and the check itself makes no LinkedIn call and no write", async () => {
    const s = await linkedinLaunchSummary("t", "bound");
    m.get.mockClear();
    m.campaign.mockClear();
    expect(await linkedinLaunchFilingRefusal("t", s, { total_budget_cents: 10_000, end_time: week() })).toBeNull();
    expect(m.get).not.toHaveBeenCalled();
    expect(m.campaign).not.toHaveBeenCalled();
    expect(m.spend).not.toHaveBeenCalled();
    expect(m.post).not.toHaveBeenCalled();
    expect(m.hold).not.toHaveBeenCalled();
  });
});

describe("the launch form's end-date rule agrees with the server's", () => {
  const now = Date.UTC(2026, 9, 30, 8);
  const hour = 3600_000;
  it("uses one 12 hour runway", () => {
    expect(SHARED_RUNWAY_MS).toBe(LINKEDIN_MIN_RUNWAY_MS);
  });
  it.each([
    ["in the past", now - 1, now - 86400_000],
    ["exactly now", now, now - 86400_000],
    ["six hours away", now + 6 * hour, now - 86400_000],
    ["a millisecond short of the runway", now + LINKEDIN_MIN_RUNWAY_MS - 1, now - 86400_000],
    ["exactly on the runway", now + LINKEDIN_MIN_RUNWAY_MS, now - 86400_000],
    ["a day away", now + 24 * hour, now - 86400_000],
    ["exactly 366 days away", now + 366 * 86400_000, now - 86400_000],
    ["a millisecond past 366 days", now + 366 * 86400_000 + 1, now - 86400_000],
    ["before a future start", now + 24 * hour, now + 48 * hour],
    ["exactly on a future start", now + 24 * hour, now + 24 * hour],
    ["after a future start", now + 72 * hour, now + 48 * hour],
  ])("end %s", (_label, end, start) => {
    expect(linkedinEndTimeProblem(end, start, now) === null).toBe(linkedinEndTimeRefusal(end, start, now) === null);
  });
});
describe("a total below the campaign's daily budget never reaches LinkedIn", () => {
  const WORDS = "LinkedIn does not accept a total budget below the campaign's daily budget. This campaign can spend up to $15.00 a day, so enter a total of at least $15.00.";
  const SENT_NOTHING = "Nothing was sent to LinkedIn and nothing was held.";
  const launchAt = async (cents: number) => launchLinkedinCampaign("t", "bound", { ...(await ask()), total_budget_cents: cents });
  const refused = async (cents: number) => (await launchAt(cents).catch((e: unknown) => e)) as ExpectedToolError;
  const expectNothingMoved = () => {
    expect(m.hold).not.toHaveBeenCalled();
    expect(m.post).not.toHaveBeenCalled();
    expect(m.rpc).not.toHaveBeenCalled();
    expect(m.spend).not.toHaveBeenCalled();
    expect(m.events).toEqual([]);
    expect(m.finish).toEqual([]);
    expect(m.commit).not.toHaveBeenCalled();
  };
  const sentTotal = () => m.post.mock.calls.find(([, path, , body]) => path === context.path && body.patch.$set.totalBudget)?.[3].patch.$set.totalBudget;
  const filed = async (cents: number) => linkedinLaunchFilingRefusal("t", await linkedinLaunchSummary("t", "bound"), { total_budget_cents: cents, end_time: Date.now() + 7 * 86_400_000 });
  const account = (currency: string, units: number) => {
    context.account.currency = currency;
    m.fx.mockImplementation(async (c: string) => ({ currency: c, units_per_usd: units, as_of: null, source: "ExchangeRate-API" }));
  };
  beforeEach(() => {
    context.campaign.dailyBudget = { amount: "15.00", currencyCode: "USD" };
    m.activeBudget.mockResolvedValue({ days_left: 10, left_usd: 1000, daily_limit_usd: null, margin: 1 });
    m.opRows = [];
  });
  it("one cent below refuses before any hold, claim, spend read or LinkedIn write, and closes the card", async () => {
    const e = await refused(1499);
    expect(e.code).toBe("ads_launch_conflict");
    expect(e.message).toBe(`${WORDS} ${SENT_NOTHING}`);
    expect(e.meta?.card_cannot_run).toBe(true);
    expectNothingMoved();
  });
  it("the campaign from the bug, $10 total on $15 a day, is refused", async () => {
    expect((await refused(1000)).message).toBe(`${WORDS} ${SENT_NOTHING}`);
    expectNothingMoved();
  });
  it.each([[1500, "15.00"], [1501, "15.01"]])("a total of %i cents on $15 a day goes to LinkedIn", async (cents, amount) => {
    expect(await launchAt(cents)).toEqual({ status: "active" });
    expect(sentTotal()).toEqual({ amount, currencyCode: "USD" });
    expect(m.hold).toHaveBeenCalledTimes(1);
  });
  it("a daily budget with a fraction of a cent is rounded up, so the total cannot sit under it", async () => {
    context.campaign.dailyBudget = { amount: "15.001", currencyCode: "USD" };
    expect((await refused(1500)).message).toContain("at least $15.01");
    expectNothingMoved();
  });
  it("a campaign with no daily budget has no such rule", async () => {
    delete context.campaign.dailyBudget;
    expect(await filed(1000)).toBeNull();
    expect(await launchAt(1000)).toEqual({ status: "active" });
    expect(sentTotal()).toEqual({ amount: "10.00", currencyCode: "USD" });
  });
  it("compares in the account's own currency: 11.99 EUR on 12 EUR a day is refused although it is more dollars than 12", async () => {
    account("EUR", 0.8);
    context.campaign.dailyBudget = { amount: "12.00", currencyCode: "EUR" };
    const e = await refused(1199);
    expect(e.message).toContain("€12.00 a day");
    expect(e.message).not.toContain("$");
    expectNothingMoved();
    m.events = [];
    expect(await launchAt(1200)).toEqual({ status: "active" });
    expect(sentTotal()).toEqual({ amount: "12.00", currencyCode: "EUR" });
  });
  it("in a currency worth less than a dollar, the words name the larger of the daily budget and LinkedIn's minimum", async () => {
    account("INR", 83);
    context.campaign.dailyBudget = { amount: "500.00", currencyCode: "INR" };
    const words = "LinkedIn does not accept a total budget below the campaign's daily budget. This campaign can spend up to ₹500.00 a day, so enter a total of at least ₹830.00.";
    expect((await refused(49_999)).message).toBe(`${words} ${SENT_NOTHING}`);
    expect(await filed(49_999)).toBe(`${words} Nothing was sent to LinkedIn.`);
    expectNothingMoved();
  });
  it("a relaunch is measured on the whole total: only $2 left of $20 on $15 a day still goes, because LinkedIn compares the total", async () => {
    m.spend.mockResolvedValue({ cents: 1800 });
    expect(await launchAt(2000)).toEqual({ status: "active" });
    expect(sentTotal()).toEqual({ amount: "20.00", currencyCode: "USD" });
    expect(m.hold.mock.calls[0][1]).toMatchObject({ lifetime_usd: 2, observed_usd: 18, daily_delta_usd: 2 });
  });
  it("a relaunch whose whole total is under the daily budget is refused even though spend is below it too", async () => {
    m.spend.mockResolvedValue({ cents: 1000 });
    expect((await refused(1499)).message).toBe(`${WORDS} ${SENT_NOTHING}`);
    expectNothingMoved();
  });
  it("a total at the daily budget that spend already passed keeps the spend refusal", async () => {
    m.spend.mockResolvedValue({ cents: 1600 });
    await expect(launchAt(1500)).rejects.toThrow("This campaign has already spent $16.00");
    expect(m.hold).not.toHaveBeenCalled();
    expect(m.post).not.toHaveBeenCalled();
  });
  it("filing refuses the same case with the same words, and makes no LinkedIn call", async () => {
    const s = await linkedinLaunchSummary("t", "bound");
    m.get.mockClear();
    m.campaign.mockClear();
    expect(await linkedinLaunchFilingRefusal("t", s, { total_budget_cents: 1499, end_time: Date.now() + 7 * 86_400_000 })).toBe(`${WORDS} Nothing was sent to LinkedIn.`);
    expect(m.get).not.toHaveBeenCalled();
    expect(m.campaign).not.toHaveBeenCalled();
    expect(m.post).not.toHaveBeenCalled();
    expect(m.hold).not.toHaveBeenCalled();
    expect(await linkedinLaunchFilingRefusal("t", s, { total_budget_cents: 1500, end_time: Date.now() + 7 * 86_400_000 })).toBeNull();
  });
  it("filing names the daily budget before LinkedIn's lower minimum, so one fix is enough", async () => {
    expect(await filed(900)).toBe(`${WORDS} Nothing was sent to LinkedIn.`);
  });
  it("filing still refuses a campaign that has run before, where the money checks are skipped", async () => {
    m.opRows = [{ status: "succeeded" }];
    expect(await filed(1499)).toBe(`${WORDS} Nothing was sent to LinkedIn.`);
    expect(await filed(1500)).toBeNull();
  });
  it("the month check is separate: the daily rule ignores what is left, and a total at the daily budget still meets the month rule with its own hold", async () => {
    m.activeBudget.mockResolvedValue({ days_left: 10, left_usd: 5, daily_limit_usd: null, margin: 1 });
    m.rpc.mockImplementation(async (_t, name) => (name === "ad_object_hold_usd" ? { data: 20, error: null } : { data: true, error: null }));
    expect(await filed(1499)).toBe(`${WORDS} Nothing was sent to LinkedIn.`);
    expect(await filed(1500)).toBeNull();
    m.rpc.mockImplementation(async (_t, name) => (name === "ad_object_hold_usd" ? { data: 0, error: null } : { data: true, error: null }));
    expect(await filed(1500)).toMatch(/monthly ad budget/);
  });
  describe("when LinkedIn itself refuses the first write", () => {
    const docReason = "/Campaign/totalBudget/amount cannot be set to 10; it cannot be lower than /Campaign/dailyBudget/amount 50";
    const SPECIFIC = "LinkedIn does not accept a total budget below the campaign's daily budget. Check the daily budget in LinkedIn Campaign Manager, then review the launch again. Nothing changed in LinkedIn and nothing was held.";
    const refuse = (reason?: string, status = 422) => m.post.mockRejectedValueOnce(new ExpectedToolError("linkedin_ads_write_refused", LINKEDIN_ADS_CHANGE_REFUSED, { status, http_status: status, ...(reason ? { linkedin_reason: reason } : {}) }));
    it.each([
      ["LinkedIn's documented sentence", docReason],
      ["a field path with the error code", "totalBudget/amount: CONDITIONAL_VALUE_TOO_LOW"],
      ["spaced words", "Total budget cannot be lower than daily budget"],
    ])("%s gets the specific message, the card closes, and both holds go back", async (_label, reason) => {
      m.deleteOk = true;
      refuse(reason);
      const { err, status, body } = await founderRefusal(() => launchAt(2000));
      expect(err.code).toBe("ads_launch_not_sent");
      expect(status).toBe(409);
      expect(body.error.message).toBe(SPECIFIC);
      expect(err.meta?.card_cannot_run).toBe(true);
      expect(m.post).toHaveBeenCalledTimes(1);
      expect(m.drop).toHaveBeenCalledWith(expect.objectContaining({ status: "held", fresh: true }), { strict: true });
      expect(m.pause).not.toHaveBeenCalled();
    });
    it.each([
      ["a minimum on the total", "totalBudget: below minimum"],
      ["the same code on the end date", "runSchedule/end: CONDITIONAL_VALUE_TOO_LOW"],
      ["the code with no field", "CONDITIONAL_VALUE_TOO_LOW"],
      ["a rule about the daily budget alone", "dailyBudget/amount: below the account minimum"],
    ])("%s stays the general message", async (_label, reason) => {
      refuse(reason);
      const e = (await launchAt(2000).catch((x: unknown) => x)) as ExpectedToolError;
      expect(e.message).toBe(FIRST_WRITE_REFUSED);
      expect(e.meta?.card_cannot_run).toBeUndefined();
    });
    it("a reason that names the budgets on a billing refusal keeps the billing words", async () => {
      refuse(docReason, 402);
      const e = (await launchAt(2000).catch((x: unknown) => x)) as ExpectedToolError;
      expect(e.message).toContain(LINKEDIN_ADS_CHANGE_REFUSED);
    });
    it("logs LinkedIn's reason to the backend, once, without the access token or a token-shaped value", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const shaped = "AQV8x9Zk2LmQ7rT5wYp3abc";
      refuse(`${docReason} ${shaped}`);
      await launchAt(2000).catch(() => undefined);
      expect(m.logged).toHaveLength(1);
      expect(m.logged[0]).toMatchObject({ code: "linkedin_ads.write_refused", meta: { stage: "launch", http_status: 422, failure_class: "linkedin_ads_write_refused", object_id: "bound" } });
      expect(m.logged[0].message).toContain(docReason);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain(docReason);
      for (const text of [JSON.stringify(m.logged), String(warn.mock.calls[0][0])]) {
        expect(text).not.toContain(shaped);
        expect(text).not.toContain(context.token);
      }
      warn.mockRestore();
    });
  });
});
describe("the server keeps refusing a launch on a running campaign", () => {
  const running = (serving: string[]) => {
    context.campaign.status = "ACTIVE";
    context.campaign.servingStatuses = serving;
  };
  it.each([
    ["delivering", () => running(["RUNNABLE"])],
    ["with its ad under review", () => { running(["RUNNABLE"]); adIntent = "ACTIVE"; underReview = true; }],
  ])("a campaign LinkedIn runs %s: no hold, no claim, no write", async (_label, arrange) => {
    const good = await ask();
    arrange();
    const a = { ...good, snapshot: (await linkedinLaunchSummary("t", "bound")).snapshot };
    await expect(launchLinkedinCampaign("t", "bound", a)).rejects.toThrow("Only a paused campaign can be launched here.");
    expect(m.hold).not.toHaveBeenCalled();
    expect(m.post).not.toHaveBeenCalled();
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it("with the server's LinkedIn write switch off, the launch review already carries the reason, so the form never asks for a total", async () => {
    m.writesOn = false;
    const s = await linkedinLaunchSummary("t", "bound");
    expect(s.launch_blocker).toBe("LinkedIn Ads changes are switched off on this server, so Zavi cannot launch campaigns yet.");
    m.writesOn = true;
    expect((await linkedinLaunchSummary("t", "bound")).launch_blocker).toBeNull();
  });
  it("the same running campaign is refused at filing", async () => {
    running(["RUNNABLE"]);
    m.activeBudget.mockResolvedValue({ days_left: 10, left_usd: 1000, daily_limit_usd: null, margin: 1 });
    const s = await linkedinLaunchSummary("t", "bound");
    expect(s.launch_blocker).toBe("Only a paused campaign can be launched here.");
    expect(await linkedinLaunchFilingRefusal("t", s, { total_budget_cents: 10_000, end_time: Date.now() + 7 * 86_400_000 })).toBe("Only a paused campaign can be launched here.");
  });
  it("a paused campaign LinkedIn reports as stopped by its group hold can still launch", async () => {
    context.campaign.servingStatuses = ["STOPPED", "CAMPAIGN_GROUP_STATUS_HOLD"];
    underReview = true;
    expect(await launchLinkedinCampaign("t", "bound", await ask())).toEqual({ status: "active" });
  });
});

describe("Flow 14: refusals a founder must read in plain words", () => {
  const ask = () => linkedinLaunchSummary("t", "bound").then((x) => ({ request_id: request, snapshot: x.snapshot, total_budget_cents: 20_000, end_time: Date.now() + 14 * 86_400_000 }));

  it("a 429 after the ACTIVE write never reads as a clean retry: unconfirmed words, marked unknown, the pause attempted", async () => {
    const a = await ask();
    m.post.mockImplementation(async (_t: string, path: string, _k: string, body: any) => {
      if (body?.patch?.$set?.status === "ACTIVE" && path.includes("adCampaigns/"))
        throw new ExpectedToolError("linkedin_ads_rate_limited", "LinkedIn is busy. Try again in a few minutes.", { http_status: 429 });
      return {};
    });
    const err = await launchLinkedinCampaign("t", "bound", a).catch((e) => e);
    expect(err).toBeInstanceOf(ExpectedToolError);
    expect(err.code).not.toBe("ads_launch_not_sent");
    expect(err.message).toBe(LINKEDIN_LAUNCH_UNCONFIRMED_WALLET);
    expect(err.message).not.toMatch(/Try again/);
    expect(err.meta?.outcome_unknown).toBe(true);
    expect(m.pause).toHaveBeenCalledTimes(1);
    expect(m.finish).toContain("uncertain");
  });

  it("a stopped ad account refuses before any claim, hold or LinkedIn write", async () => {
    const a = await ask();
    m.stopped = "2026-10-30T00:00:00Z";
    const err = await launchLinkedinCampaign("t", "bound", a).catch((e) => e);
    expect(err.message).toBe(LINKEDIN_ACCOUNT_STOPPED);
    expect(m.hold).not.toHaveBeenCalled();
    expect(m.post).not.toHaveBeenCalled();
    expect((await linkedinLaunchSummary("t", "bound")).launch_blocker).toBe(LINKEDIN_ACCOUNT_STOPPED);
  });

  it.each([
    ["the founder pressing Launch", { approved_by: "owner-1", reviewed_units_per_usd: null }],
    ["Autopilot", { approved_by: null, approved_by_source: "cgo", body: { origin: "agent" } }],
  ])("a campaign already on a stopped ad account cannot be launched by %s, and nothing is held or sent", async (_who, approval) => {
    const a = await ask();
    m.stopped = "2026-10-30T00:00:00Z";
    const err = await launchLinkedinCampaign("t", "bound", a, undefined, approval).catch((e) => e);
    expect(err).toBeInstanceOf(ExpectedToolError);
    expect(err.message).toBe(LINKEDIN_ACCOUNT_STOPPED);
    expect(m.hold).not.toHaveBeenCalled();
    expect(m.rpc).not.toHaveBeenCalled();
    expect(m.post).not.toHaveBeenCalled();
    expect(m.commit).not.toHaveBeenCalled();
  });

  it.each([
    ["the founder pressing Launch", { approved_by: "owner-1", reviewed_units_per_usd: null }],
    ["Autopilot", { approved_by: null, approved_by_source: "cgo", body: { origin: "agent" } }],
  ])("a campaign on an ad account that is still on launches for %s", async (_who, approval) => {
    m.stopped = null;
    expect(await launchLinkedinCampaign("t", "bound", await ask(), undefined, approval)).toEqual({ status: "active" });
    expect(m.post).toHaveBeenCalled();
  });

  it("an unreadable stop state fails closed", async () => {
    m.statusError = true;
    await expect(linkedinLaunchSummary("t", "bound")).rejects.toThrow("could not check whether this ad account is still on");
    expect(m.post).not.toHaveBeenCalled();
  });

  it("a Not finished campaign with no ad says so in plain words, not a zod dump", async () => {
    const saved = m.lifecycle.provider_creative_ids;
    m.lifecycle.provider_creative_ids = [];
    const err = await linkedinLaunchSummary("t", "bound").catch((e) => e);
    m.lifecycle.provider_creative_ids = saved;
    expect(err).toBeInstanceOf(ExpectedToolError);
    expect(err.message).toBe(LINKEDIN_NOT_FINISHED);
  });

  it("permanent refusals close the card: no more spend headroom on a lifetime total", async () => {
    const a = await ask();
    m.spend.mockResolvedValue({ cents: 25_000 });
    const err = await launchLinkedinCampaign("t", "bound", a).catch((e) => e);
    expect(err.meta?.card_cannot_run).toBe(true);
    expect(err.message).toContain("already spent $250.00");
  });

  it("a campaign no longer paused closes the card for good", async () => {
    const a = await ask();
    context.campaign.status = "ACTIVE";
    const err = await launchLinkedinCampaign("t", "bound", a).catch((e) => e);
    expect(err.meta?.card_cannot_run).toBe(true);
  });

  it("filing a relaunch checks what is new money, not the lifetime total", async () => {
    const s = await linkedinLaunchSummary("t", "bound");
    m.activeBudget.mockResolvedValue({ left_usd: 60, daily_limit_usd: null, days_left: 10 });
    const end = Date.now() + 14 * 86_400_000;
    expect(await linkedinLaunchFilingRefusal("t", s, { total_budget_cents: 20_000, end_time: end, spent_cents: 15_000 })).toBeNull();
    expect(await linkedinLaunchFilingRefusal("t", s, { total_budget_cents: 20_000, end_time: end, spent_cents: 10_000 })).toContain("over your monthly ad budget");
  });

  it("filing refuses a relaunch total at or below what it already spent, with the amount", async () => {
    const s = await linkedinLaunchSummary("t", "bound");
    m.activeBudget.mockResolvedValue({ left_usd: 500, daily_limit_usd: null, days_left: 10 });
    expect(await linkedinLaunchFilingRefusal("t", s, { total_budget_cents: 5_000, end_time: Date.now() + 14 * 86_400_000, spent_cents: 5_000 })).toContain("already spent $50.00");
  });

  it("a $200 launch on a $75 wallet is refused at filing, before any card, with the shortfall's next step", async () => {
    const s = await linkedinLaunchSummary("t", "bound");
    m.activeBudget.mockResolvedValue({ left_usd: 500, daily_limit_usd: null, days_left: 10 });
    m.opRows = [];
    m.wallet.mockResolvedValue({ available_cents: 7_500 });
    const refusal = await linkedinLaunchFilingRefusal("t", s, { total_budget_cents: 20_000, end_time: Date.now() + 14 * 86_400_000 });
    expect(refusal).toBe("Your shared-wallet balance cannot cover this launch with a $200.00 total budget. You have $75.00 available. Nothing was sent to LinkedIn and nothing was held. Add balance from the balance panel on your LinkedIn Ads page, or lower the total budget, then try again.");
    expect(refusal).not.toMatch(/Settings/);
  });

  it("an unreadable wallet leaves the check to the launch", async () => {
    const s = await linkedinLaunchSummary("t", "bound");
    m.activeBudget.mockResolvedValue({ left_usd: 500, daily_limit_usd: null, days_left: 10 });
    m.opRows = [];
    m.wallet.mockRejectedValue(new Error("down"));
    expect(await linkedinLaunchFilingRefusal("t", s, { total_budget_cents: 20_000, end_time: Date.now() + 14 * 86_400_000 })).toBeNull();
  });
});

it("the launch summary names each ad by a plain label, so a founder never sees a scrubbed id", async () => {
  const BIG = ["7123456789012345678", "9876543210987"];
  linkedInIgnoringAdSwitch(BIG, BIG);
  m.get.mockImplementation(async (_token: string, path: string) => {
    if (path.endsWith("adCampaignGroups/7")) return { id: 7, account: context.campaign.account, status: "PAUSED" };
    const adId = /sponsoredCreative%3A(\d+)$/.exec(path)?.[1];
    return adId ? { id: adId, campaign: "urn:li:sponsoredCampaign:123", intendedStatus: "DRAFT" } : siblings;
  });
  const summary = await linkedinLaunchSummary("t", "bound");
  const wire = JSON.stringify(summary);
  expect(summary.ads.map((a: { label: string }) => a.label)).toEqual(["Ad 1", "Ad 2"]);
  for (const id of BIG) expect(wire).not.toContain(id);
  expect(JSON.stringify(summary.ads)).not.toMatch(/\d{10,}/);
  const { scrubAgentEgress } = await import("@/services/agents/scrub-agent-egress");
  const reply = `Its ${summary.ads.length} ads (${summary.ads.map((a: { label: string }) => a.label).join(", ")}) are still drafts.`;
  const out = scrubAgentEgress(reply, { surface: "chat", scrubPii: true });
  expect(out.text).toBe(reply);
  expect(out.text).not.toContain("[redacted]");
});

describe("a launch over the month states the real monthly minimum", () => {
  const floor2 = (n: number) => Math.floor(Number((n * 100).toFixed(6))) / 100;
  const octoberView = (monthly: number, over: Record<string, unknown> = {}) => {
    const cap = floor2((monthly * 2) / 31);
    const view = { id: "b", status: "active", monthly_usd: monthly, month_cap_usd: cap, spent_usd: 0, held_usd: 10, creator_held_usd: 0, creator_spent_usd: 0, daily_limit_usd: null, days_left: 2, days_in_month: 31, started_on: "2026-10-30", month_start: "2026-10-01", next_month_start: "2026-11-01", margin: 1, ...over } as Record<string, any>;
    view.left_usd = Math.max(floor2(view.month_cap_usd - view.spent_usd - view.held_usd - view.creator_held_usd - view.creator_spent_usd), 0);
    return view;
  };
  const useMonth = (view: Record<string, any>) => {
    m.monthView.mockResolvedValue(view);
    m.activeBudget.mockResolvedValue(view);
  };
  const file = async (cents: number) => linkedinLaunchFilingRefusal("t", await linkedinLaunchSummary("t", "bound"), { total_budget_cents: cents, end_time: Date.now() + 7 * 86_400_000 });
  const ownHold = (usd: number) => m.rpc.mockImplementation(async (_t: string, name: string) => (name === "ad_object_hold_usd" ? { data: usd, error: null } : { data: true, error: null }));
  beforeEach(() => {
    m.opRows = [];
    ownHold(0);
    m.monthView.mockReset();
  });
  it("must catch: $15 at $180 prorated 2/31 with $10 held names $388, and the gate agrees: $387 and the old raise-by-$15 still refuse, $388 passes", async () => {
    useMonth(octoberView(180));
    const words = await file(1500);
    expect(words).toContain("raise your monthly ad budget to at least $388,");
    expect(words).toContain("needs $15.00 this month and $1.61 is free");
    expect(words).toContain("$180 monthly ad budget gives $11.61 this month");
    expect(words).toContain("$10.00 of that is already spent or held");
    expect(words).not.toMatch(/\$195|by at least/);
    useMonth(octoberView(195));
    expect(await file(1500)).toContain("at least $388,");
    useMonth(octoberView(387));
    expect(await file(1500)).toContain("at least $388,");
    useMonth(octoberView(388));
    expect(await file(1500)).toBeNull();
  });
  it("counts the budget margin, so the minimum clears the gate at that margin", async () => {
    useMonth(octoberView(180, { margin: 1.1 }));
    const words = await file(1500);
    expect(words).toContain("needs $16.50 this month");
    expect(words).toContain("at least $411,");
    useMonth(octoberView(410, { margin: 1.1 }));
    expect(await file(1500)).toContain("at least $411,");
    useMonth(octoberView(411, { margin: 1.1 }));
    expect(await file(1500)).toBeNull();
  });
  it("gives back this campaign's own hold, so the minimum is not overstated", async () => {
    useMonth(octoberView(180));
    ownHold(5);
    const words = await file(1500);
    expect(words).toContain("$6.61 is free");
    expect(words).toContain("at least $310,");
    useMonth(octoberView(309));
    expect(await file(1500)).toContain("at least $310,");
    useMonth(octoberView(310));
    expect(await file(1500)).toBeNull();
  });
  it("a month already over its cap is measured from what is really used, not from a left floored at zero", async () => {
    useMonth(octoberView(180, { spent_usd: 20, held_usd: 0, creator_spent_usd: 5 }));
    const words = await file(1500);
    expect(words).toContain("$0.00 is free");
    expect(words).toContain("at least $620,");
  });
  it("after the first month the budget is whole, so the minimum is the shortfall on top and no proration is claimed", async () => {
    useMonth({ ...octoberView(180, { month_cap_usd: 180, held_usd: 170, started_on: "2026-08-01" }), left_usd: 10 });
    const words = await file(1500);
    expect(words).toContain("at least $185,");
    expect(words).toContain("$170.00 of your $180 monthly ad budget is already spent or held.");
    expect(words).not.toContain("this month because");
  });
  it.each([
    ["the month view cannot be read", () => m.monthView.mockRejectedValue(new Error("down"))],
    ["the budget was stopped between the reads", () => m.monthView.mockResolvedValue({ ...octoberView(180), status: "stopped" })],
    ["the proration cannot be explained", () => m.monthView.mockResolvedValue({ ...octoberView(180), month_cap_usd: 40 })],
  ])("names no figure when %s", async (_name, arrange) => {
    m.activeBudget.mockResolvedValue(octoberView(180));
    arrange();
    const words = await file(1500);
    expect(words).toContain("over your monthly ad budget");
    expect(words).toContain("do not name an amount");
    expect(words).not.toMatch(/\$\d/);
  });
  it("must catch: the executor's own over_month refusal carries the same minimum and keeps the raw refusal for the card", async () => {
    m.deleteOk = true;
    const a = await ask();
    useMonth(octoberView(180));
    m.hold.mockResolvedValueOnce({ status: "refused", error: "cap_refuse: ad_budget_over_month" });
    const { err, body } = await founderRefusal(() => launchLinkedinCampaign("t", "bound", a));
    expect(body.error.message).toContain("needs $100.00 this month");
    expect(body.error.message).toContain("at least $1,705,");
    expect(err.meta).toEqual({ budget_refusal: "cap_refuse: ad_budget_over_month" });
  });
});

describe("a launch summary says whether a switched-on campaign is delivering", () => {
  const summary = () => linkedinLaunchSummary("t", "bound");
  const on = () => {
    context.campaign.status = "ACTIVE";
    adIntent = "ACTIVE";
  };
  it("must catch: ACTIVE with its only ad under review is in_review and is never called spending", async () => {
    on();
    underReview = true;
    const s = await summary();
    expect(s).toMatchObject({ status: "ACTIVE", delivery: "in_review" });
    expect(s.delivery_note).toContain("never that it is spending");
  });
  it("an ACTIVE campaign LinkedIn calls serving is the only case the note allows spending", async () => {
    on();
    underReview = false;
    const base = m.get.getMockImplementation()!;
    m.get.mockImplementation(async (t: string, path: string) => {
      const r = await base(t, path);
      return path.includes("/creatives/") ? { ...r, isServing: true } : r;
    });
    const s = await summary();
    expect(s.delivery).toBe("serving");
    expect(s.delivery_note).toContain("can be called spending");
  });
  it("a paused campaign is not_on, and an ACTIVE one with no readable serving state is unread rather than spending", async () => {
    underReview = false;
    expect((await summary()).delivery).toBe("not_on");
    on();
    const s = await summary();
    expect(s.delivery).toBe("unread");
    expect(s.delivery_note).toContain("only if linkedin_ads_read_analytics shows spend");
  });
});
describe("Review 18 money fixes", () => {
  const end = () => Date.now() + 14 * 86_400_000;
  const reserveAnswers = (prior = 1500) =>
    m.rpc.mockImplementation(async (_t: string, name: string, args: any) => {
      m.events.push(`${name}:${args?.p_prior_reserved_cents ?? ""}`);
      return { data: name === "ads_reserve_linkedin_launch" ? prior : true, error: null };
    });
  const trims = () => m.rpc.mock.calls.filter((c) => c[1] === "ads_release_unsent_linkedin_launch").map((c) => c[2]);

  it("Flow 25: a wallet relaunch the wallet can cover is not refused for counting its spend twice", async () => {
    const s = await linkedinLaunchSummary("t", "bound");
    m.activeBudget.mockResolvedValue({ left_usd: 5_000, daily_limit_usd: null, days_left: 10 });
    m.wallet.mockResolvedValue({ available_cents: 10_000 });
    m.reservation = { reserved_cents: 10_000, spent_cents: 5_000 };
    expect(await linkedinLaunchFilingRefusal("t", s, { total_budget_cents: 25_000, end_time: end(), spent_cents: 5_000 })).toBeNull();
    expect(await linkedinLaunchFilingRefusal("t", s, { total_budget_cents: 25_001, end_time: end(), spent_cents: 5_000 })).toBe("Your shared-wallet balance cannot cover this launch with a $250.01 total budget. This campaign has already spent $50.00 of that total, so the launch needs $200.01 more. You have $200.00 available, counting the $100.00 already set aside for this campaign. Nothing was sent to LinkedIn and nothing was held. Add balance from the balance panel on your LinkedIn Ads page, or lower the total budget, then try again.");
  });

  it("Flow 25: spend LinkedIn reports but the wallet has not settled yet still comes out of the hold, as the reservation does", async () => {
    const s = await linkedinLaunchSummary("t", "bound");
    m.activeBudget.mockResolvedValue({ left_usd: 5_000, daily_limit_usd: null, days_left: 10 });
    m.wallet.mockResolvedValue({ available_cents: 10_000 });
    m.reservation = { reserved_cents: 10_000, spent_cents: 5_000 };
    expect(await linkedinLaunchFilingRefusal("t", s, { total_budget_cents: 25_000, end_time: end(), spent_cents: 6_000 })).toBeNull();
    expect(await linkedinLaunchFilingRefusal("t", s, { total_budget_cents: 25_001, end_time: end(), spent_cents: 6_000 })).toContain("already spent $60.00 of that total, so the launch needs $190.01 more. You have $190.00 available");
  });

  it.each([
    ["an ad", (path: string) => path.includes("/creatives/"), false],
    ["the campaign group", (path: string) => path.endsWith("adCampaignGroups/7"), true],
    ["the campaign", (path: string, set: any) => path === context.path && set.status === "ACTIVE", true],
  ])("Flow 39: a clean LinkedIn 400 on switching on %s keeps the campaign paused, gives back both holds and lets the founder retry, saying what LinkedIn kept", async (_label, refuses, partlyOn) => {
    m.deleteOk = true;
    reserveAnswers();
    const base = m.post.getMockImplementation()!;
    m.post.mockImplementation(async (t: string, path: string, k: string, body: any) => {
      if (refuses(path, body.patch.$set)) throw new ExpectedToolError("linkedin_ads_write_refused", LINKEDIN_ADS_CHANGE_REFUSED, { status: 400, http_status: 400 });
      return base(t, path, k, body);
    });
    const a = await ask();
    const { err, status, body } = await founderRefusal(() => launchLinkedinCampaign("t", "bound", a));
    expect(err.code).toBe("ads_launch_not_sent");
    expect(status).toBe(409);
    expect(err.meta?.outcome_unknown).toBeUndefined();
    expect(body.error.message).toMatch(/^LinkedIn did not let Zavi switch this campaign on, so it stays paused and cannot spend\. /);
    expect(body.error.message).toContain("kept this launch's new total budget and end date");
    expect(body.error.message.includes("switched on some of its ads or its campaign group")).toBe(partlyOn);
    expect(body.error.message).not.toMatch(/may have reached|Nothing changed in LinkedIn|Nothing was sent/);
    expect(context.campaign.status).toBe("PAUSED");
    expect(m.pause).not.toHaveBeenCalled();
    expect(m.drop).toHaveBeenCalledWith(expect.objectContaining({ status: "held", fresh: true }), { strict: true });
    expect(trims()).toEqual([{ p_campaign_binding_id: "bound", p_operation_id: request, p_prior_reserved_cents: 1500 }]);
    expect(m.commit).not.toHaveBeenCalled();
    expect(m.deleted).toEqual(["ads_campaign_operations"]);
    expect(m.finish).toEqual([]);
  });

  it("a launch conflict with a known outcome keeps its own code on the wire", async () => {
    context.campaign.status = "ACTIVE";
    const { status, body } = await founderRefusal(async () => launchLinkedinCampaign("t", "bound", { request_id: request, snapshot: (await linkedinLaunchSummary("t", "bound")).snapshot, total_budget_cents: 10_000, end_time: end() }));
    expect(status).toBe(409);
    expect(body.error.code).toBe("ads_launch_conflict");
  });

  it("Flow 39: a 5xx on switching on an ad is still an unknown outcome: paused, holds kept, no retry", async () => {
    reserveAnswers();
    const base = m.post.getMockImplementation()!;
    m.post.mockImplementation(async (t: string, path: string, k: string, body: any) => {
      if (path.includes("/creatives/")) throw new ExpectedToolError("linkedin_ads_http_error", "LinkedIn Ads is not responding right now.", { status: 503, http_status: 503 });
      return base(t, path, k, body);
    });
    const err = await launchLinkedinCampaign("t", "bound", await ask()).catch((e) => e);
    expect(err.meta?.outcome_unknown).toBe(true);
    expect(m.pause).toHaveBeenCalledTimes(1);
    expect(m.drop).not.toHaveBeenCalled();
    expect(trims()).toEqual([]);
    expect(m.finish).toEqual(["uncertain"]);
  });

  it("Flow 39: when the wallet hold cannot be given back after a switch-on refusal, the words never claim nothing was sent", async () => {
    m.rpc.mockImplementation(async (_t: string, name: string) =>
      name === "ads_release_unsent_linkedin_launch" ? { data: null, error: { message: "down" } } : { data: name === "ads_reserve_linkedin_launch" ? 1500 : true, error: null },
    );
    const base = m.post.getMockImplementation()!;
    m.post.mockImplementation(async (t: string, path: string, k: string, body: any) => {
      if (path === context.path && body.patch.$set.status === "ACTIVE") throw new ExpectedToolError("linkedin_ads_write_refused", LINKEDIN_ADS_CHANGE_REFUSED, { status: 400, http_status: 400 });
      return base(t, path, k, body);
    });
    const err = await launchLinkedinCampaign("t", "bound", await ask()).catch((e) => e);
    expect(err.code).toBe("ads_launch_not_sent");
    expect(err.message).toBe("LinkedIn did not let Zavi switch this campaign on, so it stays paused and cannot spend. Zavi could not give back the shared-wallet funds it set aside for this launch yet. They are reserved, not spent, and Zavi gives them back before this campaign's next launch.");
    expect(m.finish).toEqual(["refused"]);
  });

  it("Flow 32: an unconfirmed shared-wallet launch never sends the founder to Campaign Manager; own billing still does", async () => {
    const failActive = () => {
      const base = m.post.getMockImplementation()!;
      m.post.mockImplementation(async (t: string, path: string, k: string, body: any) => {
        if (path === context.path && body.patch.$set.status === "ACTIVE") throw new Error("socket hang up");
        return base(t, path, k, body);
      });
    };
    failActive();
    const a = await ask();
    const { err: wallet, status, body } = await founderRefusal(() => launchLinkedinCampaign("t", "bound", a));
    expect(status).toBe(409);
    expect(body.error.code).toBe("linkedin_launch_outcome_unknown");
    expect(wallet.meta?.outcome_unknown).toBe(true);
    expect(wallet.message).toBe(LINKEDIN_LAUNCH_UNCONFIRMED_WALLET);
    expect(wallet.message).not.toMatch(/Campaign Manager/);
    expect(wallet.message).toContain("managed ad account");
    context.binding.funding_source = "provider";
    context.campaign.status = "PAUSED";
    const own = await launchLinkedinCampaign("t", "bound", { ...(await ask()), request_id: "10000000-0000-4000-8000-000000000002" }).catch((e) => e);
    expect(own.message).toBe(LINKEDIN_LAUNCH_UNCONFIRMED);
  });

  it("Flow 38: a euro account's relaunch refusal names the spend in euros, at filing and at launch", async () => {
    context.binding.funding_source = "provider";
    context.account.currency = "EUR";
    const s = await linkedinLaunchSummary("t", "bound");
    m.activeBudget.mockResolvedValue({ left_usd: 5_000, daily_limit_usd: null, days_left: 10 });
    const filed = await linkedinLaunchFilingRefusal("t", s, { total_budget_cents: 5_000, end_time: end(), spent_cents: 5_000 });
    expect(filed).toContain("already spent €50.00,");
    expect(filed).not.toContain("$");
    m.spend.mockResolvedValue({ cents: 123_456 });
    const err = await launchLinkedinCampaign("t", "bound", { ...(await ask()), total_budget_cents: 100_000 }).catch((e) => e);
    expect(err.message).toContain("already spent €1,234.56,");
    expect(err.message).not.toContain("$");
  });

  it("Flow 31: a confirmed wallet relaunch with a smaller total lowers the old larger hold to the new total less its spend, before the receipt", async () => {
    reserveAnswers(40_000);
    m.spend.mockResolvedValue({ cents: 2_500 });
    expect(await launchLinkedinCampaign("t", "bound", await ask())).toEqual({ status: "active" });
    expect(trims()).toEqual([{ p_campaign_binding_id: "bound", p_operation_id: request, p_prior_reserved_cents: 7_500 }]);
    const order = m.events.filter((e) => e.startsWith("ads_reserve") || e.startsWith("ads_release") || e.includes("adCampaigns/123:ACTIVE"));
    expect(order).toEqual(["ads_reserve_linkedin_launch:", "adAccounts/42/adCampaigns/123:ACTIVE", "ads_release_unsent_linkedin_launch:7500"]);
    expect(m.finish).toEqual(["succeeded"]);
  });

  it("Flow 31: an unconfirmed relaunch never lowers the hold", async () => {
    reserveAnswers(40_000);
    const base = m.post.getMockImplementation()!;
    m.post.mockImplementation(async (t: string, path: string, k: string, body: any) => {
      if (path === context.path && body.patch.$set.status === "ACTIVE") throw new Error("socket hang up");
      return base(t, path, k, body);
    });
    await launchLinkedinCampaign("t", "bound", await ask()).catch(() => undefined);
    expect(trims()).toEqual([]);
  });

  it("Flow 31: a hold that cannot be lowered never fails a live launch", async () => {
    m.rpc.mockImplementation(async (_t: string, name: string) =>
      name === "ads_release_unsent_linkedin_launch" ? { data: null, error: { message: "down" } } : { data: name === "ads_reserve_linkedin_launch" ? 40_000 : true, error: null },
    );
    expect(await launchLinkedinCampaign("t", "bound", await ask())).toEqual({ status: "active" });
    expect(m.logged.map((l) => l.code)).toContain("ads_wallet.relaunch_excess_kept");
    expect(m.finish).toEqual(["succeeded"]);
  });
});

describe("Review 26: a launch LinkedIn confirmed live is never paused for Zavi's own record", () => {
  it("keeps the campaign live, counts the hold and says it is live when the record cannot be saved after retries", async () => {
    m.failUpdates = { succeeded: Infinity };
    const result = await launchLinkedinCampaign("t", "bound", await ask());
    expect(result).toEqual({ status: "active", record_pending: true, notice: LINKEDIN_LAUNCH_LIVE_RECORD_PENDING });
    expect(m.events).toContain(`${context.path}:ACTIVE`);
    expect(context.campaign.status).toBe("ACTIVE");
    expect(m.pause).not.toHaveBeenCalled();
    expect(m.commit).toHaveBeenCalledWith(expect.objectContaining({ status: "held", idem_key: `${request}:resume` }), "bound", { strict: true });
    expect(m.drop).not.toHaveBeenCalled();
    expect(m.finish).toEqual(["succeeded", "succeeded", "succeeded"]);
    expect(m.finish).not.toContain("uncertain");
    expect(m.rpc.mock.calls.filter((c) => c[1] === "ads_release_unsent_linkedin_launch").map((c) => c[2].p_prior_reserved_cents)).toEqual([10_000]);
    expect(m.logged.map((l) => l.code)).toContain("ads_wallet.launch_receipt_unsaved");
    expect(LINKEDIN_LAUNCH_LIVE_RECORD_PENDING).not.toMatch(INTERNAL_WORDS);
  });
  it("a record write that fails once is retried and the launch finishes normally", async () => {
    m.failUpdates = { succeeded: 1 };
    expect(await launchLinkedinCampaign("t", "bound", await ask())).toEqual({ status: "active" });
    expect(m.finish).toEqual(["succeeded", "succeeded"]);
    expect(m.pause).not.toHaveBeenCalled();
    expect(m.logged.map((l) => l.code)).not.toContain("ads_wallet.launch_receipt_unsaved");
  });
  it("a launch LinkedIn did not confirm is still paused to be safe", async () => {
    mutateOnWrite = (path, body) => {
      if (path === context.path && body.patch.$set.status === "ACTIVE") context.campaign.status = "PAUSED";
    };
    await expect(launchLinkedinCampaign("t", "bound", await ask())).rejects.toThrow("may have reached LinkedIn");
    expect(m.pause).toHaveBeenCalledWith("t", "bound");
    expect(m.commit).not.toHaveBeenCalled();
    expect(m.finish).toEqual(["uncertain"]);
  });
});

describe("Review 26: an earlier launch with an unclear outcome does not block the campaign for good", () => {
  const earlier = "20000000-0000-4000-8000-000000000002";
  const claimFailsOnce = () => {
    let first = true;
    m.rpc.mockImplementation(async (_t, name) => {
      m.events.push(name);
      if (name === "ads_claim_campaign_operation" && first) {
        first = false;
        return { data: null, error: { message: "duplicate key value violates unique constraint" } };
      }
      return { data: true, error: null };
    });
  };
  const claims = () => m.rpc.mock.calls.filter((c) => c[1] === "ads_claim_campaign_operation");
  it("settles an unclear earlier launch once LinkedIn shows the campaign paused, keeps its hold counted, and launches", async () => {
    const a = await ask();
    m.opRows = [{ id: earlier, kind: "activate", status: "uncertain", created_at: new Date(Date.now() - 60_000).toISOString() } as any];
    claimFailsOnce();
    expect(await launchLinkedinCampaign("t", "bound", a)).toEqual({ status: "active" });
    expect(claims()).toHaveLength(2);
    expect(m.commit.mock.calls[0]).toEqual([expect.objectContaining({ status: "held", idem_key: `${earlier}:resume` }), "bound", { strict: true }]);
    expect(m.drop).not.toHaveBeenCalledWith(expect.objectContaining({ idem_key: `${earlier}:resume` }), expect.anything());
    expect(m.finish).toEqual(["refused", "succeeded"]);
    expect(m.pause).not.toHaveBeenCalled();
    expect(m.events).toContain(`${context.path}:ACTIVE`);
    expect(m.logged.map((l) => l.code)).toContain("ads_wallet.unclear_launch_settled");
  });
  it("never settles an unclear earlier launch while LinkedIn shows the campaign running: nothing is claimed, held or sent", async () => {
    const a = await ask();
    m.opRows = [{ id: earlier, kind: "activate", status: "uncertain", created_at: new Date().toISOString() } as any];
    claimFailsOnce();
    context.campaign.status = "ACTIVE";
    await expect(launchLinkedinCampaign("t", "bound", a)).rejects.toThrow("Only a paused campaign can be launched here.");
    expect(claims()).toHaveLength(0);
    expect(m.commit).not.toHaveBeenCalled();
    expect(m.finish).toEqual([]);
    expect(m.post).not.toHaveBeenCalled();
  });
  it("leaves a launch that is still in flight alone and says an earlier launch is finishing", async () => {
    const a = await ask();
    m.opRows = [{ id: earlier, kind: "activate", status: "pending", created_at: new Date().toISOString() } as any];
    claimFailsOnce();
    const { body } = await founderRefusal(() => launchLinkedinCampaign("t", "bound", a));
    expect(body.error.message).toBe("Zavi is still finishing an earlier launch of this campaign. Nothing new was sent to LinkedIn. Check the campaign on your LinkedIn Ads page in a few minutes; if it is still paused then, review the launch again.");
    expect(claims()).toHaveLength(1);
    expect(m.commit).not.toHaveBeenCalled();
    expect(m.finish).toEqual([]);
    expect(m.hold).not.toHaveBeenCalled();
    expect(m.post).not.toHaveBeenCalled();
  });
  it("when the unclear launch cannot be settled, says what is happening instead of 'another change', and sends nothing", async () => {
    const a = await ask();
    m.opRows = [{ id: earlier, kind: "activate", status: "uncertain", created_at: new Date().toISOString() } as any];
    m.failUpdates = { refused: Infinity };
    claimFailsOnce();
    const { body } = await founderRefusal(() => launchLinkedinCampaign("t", "bound", a));
    expect(body.error.message).toBe("An earlier launch of this campaign did not get a clear answer from LinkedIn, and Zavi is still settling it, including the budget set aside for it. Nothing new was sent to LinkedIn. Check the campaign on your LinkedIn Ads page and try again in a few minutes.");
    expect(body.error.message).not.toMatch(INTERNAL_WORDS);
    expect(claims()).toHaveLength(1);
    expect(m.hold).not.toHaveBeenCalled();
    expect(m.post).not.toHaveBeenCalled();
  });
});
describe("Flow 16: the founder pauses the campaign while its launch is running", () => {
  const pauseAfterLive = () => {
    mutateOnWrite = (path, body) => {
      if (path === context.path && body.patch.$set.status === "ACTIVE") {
        m.lifecycle.stop_requested_at = new Date().toISOString();
        context.campaign.status = "PAUSED";
      }
    };
  };
  it.each(["wallet", "provider"])("a %s launch says the founder paused it, settles its hold and frees the campaign to launch again", async (funding) => {
    context.binding.funding_source = funding;
    pauseAfterLive();
    m.pause.mockResolvedValue("already_paused");
    const err = (await launchLinkedinCampaign("t", "bound", await ask()).catch((e: unknown) => e)) as ExpectedToolError;
    expect(err.message).toBe(PAUSED_DURING_LAUNCH);
    expect(err.message).not.toContain("could not confirm");
    expect(err.meta?.outcome_unknown).toBeUndefined();
    expect(m.commit).toHaveBeenCalledWith(expect.objectContaining({ status: "held", idem_key: `${request}:resume` }), "bound", { strict: true });
    expect(m.pause.mock.invocationCallOrder[0]).toBeLessThan(m.commit.mock.invocationCallOrder[0]);
    expect(m.drop).not.toHaveBeenCalled();
    expect(m.finish).toEqual(["refused"]);
  });
  it("a pause Zavi cannot confirm keeps the hold and the unclear record, as before", async () => {
    pauseAfterLive();
    m.pause.mockRejectedValue(new Error("LinkedIn down"));
    const err = (await launchLinkedinCampaign("t", "bound", await ask()).catch((e: unknown) => e)) as ExpectedToolError;
    expect(err.message).toBe(LINKEDIN_LAUNCH_UNCONFIRMED_WALLET);
    expect(m.drop).not.toHaveBeenCalled();
    expect(m.finish).toEqual(["uncertain"]);
  });
  it("an unclear LinkedIn answer with no pause asked for is still an unknown outcome", async () => {
    m.pause.mockResolvedValue("paused");
    m.post.mockRejectedValue(new Error("timeout"));
    const err = (await launchLinkedinCampaign("t", "bound", await ask()).catch((e: unknown) => e)) as ExpectedToolError;
    expect(err.message).toBe(LINKEDIN_LAUNCH_UNCONFIRMED_WALLET);
    expect(m.commit).not.toHaveBeenCalled();
    expect(m.finish).toEqual(["uncertain"]);
  });
});
describe("Review 34", () => {
  const BUSY = "cap_refuse: ad_budget_object_busy: another change to this ad is still in flight; try again shortly";
  const ADMIN_ROLE = /account admin|Campaign Manager or Account Manager role/;
  it.each([
    ["401", new ExpectedToolError("linkedin_ads_token_revoked", LINKEDIN_ADS_RECONNECT, { status: 401 })],
    ["403", new ExpectedToolError("linkedin_ads_forbidden", LINKEDIN_ADS_FORBIDDEN_WRITE, { status: 403, http_status: 403 })],
  ])("P3: an own-billing launch whose first write LinkedIn refuses with %s keeps LinkedIn's code, status and reconnect words, gives the hold back and leaves no claim", async (_label, refusal) => {
    context.binding.funding_source = "provider";
    m.deleteOk = true;
    m.post.mockRejectedValueOnce(refusal);
    const { err, status, body } = await founderRefusal(async () => launchLinkedinCampaign("t", "bound", await ask()));
    expect(err.code).toBe(refusal.code);
    expect(status).toBe(403);
    expect(body.error.code).toBe(refusal.code);
    expect(body.error.message).toBe(`${refusal.message} Nothing changed in LinkedIn and nothing was held.`);
    expect(m.drop).toHaveBeenCalledWith(expect.objectContaining({ status: "held", fresh: true }), { strict: true });
    expect(m.commit).not.toHaveBeenCalled();
    expect(m.pause).not.toHaveBeenCalled();
    expect(m.post).toHaveBeenCalledTimes(1);
    expect(m.deleted).toEqual(["ads_campaign_operations"]);
    expect(m.finish).toEqual([]);
  });
  it("P9: a permission refusal of a shared-wallet launch's first write says the managed account is Zavi's to fix, never to ask an admin for a role, and gives back both holds", async () => {
    m.deleteOk = true;
    m.post.mockRejectedValueOnce(new ExpectedToolError("linkedin_ads_forbidden", LINKEDIN_ADS_FORBIDDEN_WRITE, { status: 403, http_status: 403 }));
    const { err, body } = await founderRefusal(async () => launchLinkedinCampaign("t", "bound", await ask()));
    expect(err.code).toBe("linkedin_ads_forbidden");
    expect(body.error.message).toBe(`${LINKEDIN_MANAGED_WRITE_FORBIDDEN} Nothing changed in LinkedIn and nothing was held.`);
    expect(body.error.message).not.toMatch(ADMIN_ROLE);
    expect(m.drop).toHaveBeenCalledWith(expect.objectContaining({ status: "held", fresh: true }), { strict: true });
    expect(releases()).toHaveLength(1);
    expect(m.pause).not.toHaveBeenCalled();
    expect(m.commit).not.toHaveBeenCalled();
  });
  it("P9: the same refusal on switching a shared-wallet campaign on says the same, and nothing stays held", async () => {
    m.deleteOk = true;
    const apply = m.post.getMockImplementation()!;
    m.post.mockImplementation(async (token: string, path: string, method: string, body: any) => {
      if (path === context.path && body.patch.$set.status === "ACTIVE")
        throw new ExpectedToolError("linkedin_ads_forbidden", LINKEDIN_ADS_FORBIDDEN_WRITE, { status: 403, http_status: 403 });
      return apply(token, path, method, body);
    });
    const { err, body } = await founderRefusal(async () => launchLinkedinCampaign("t", "bound", await ask()));
    expect(err.code).toBe("linkedin_ads_forbidden");
    expect(err.meta?.outcome_unknown).toBeUndefined();
    expect(body.error.message).toContain(LINKEDIN_MANAGED_WRITE_FORBIDDEN);
    expect(body.error.message).not.toMatch(ADMIN_ROLE);
    expect(m.drop).toHaveBeenCalledWith(expect.objectContaining({ status: "held", fresh: true }), { strict: true });
    expect(releases()).toHaveLength(1);
    expect(m.pause).not.toHaveBeenCalled();
  });
  it("non-regression guard (P9): an own-billing permission refusal still tells the founder which role to ask for", async () => {
    context.binding.funding_source = "provider";
    m.deleteOk = true;
    m.post.mockRejectedValueOnce(new ExpectedToolError("linkedin_ads_forbidden", LINKEDIN_ADS_FORBIDDEN_WRITE, { status: 403, http_status: 403 }));
    const { body } = await founderRefusal(async () => launchLinkedinCampaign("t", "bound", await ask()));
    expect(body.error.message).toMatch(ADMIN_ROLE);
  });
  it("P10: a brief read error on the pause check after LinkedIn took the first write is an unknown outcome, never 'the campaign was paused'; it pauses, keeps the hold and marks the launch uncertain", async () => {
    m.lifecycleSingleFails = () => m.post.mock.calls.length > 0;
    const err = await launchLinkedinCampaign("t", "bound", await ask()).catch((e) => e);
    expect(err).toBeInstanceOf(ExpectedToolError);
    expect(err.message).toBe(LINKEDIN_LAUNCH_UNCONFIRMED_WALLET);
    expect(err.message).not.toBe(PAUSED_DURING_LAUNCH);
    expect(err.meta?.outcome_unknown).toBe(true);
    expect(m.pause).toHaveBeenCalledTimes(1);
    expect(m.finish).toEqual(["uncertain"]);
    expect(m.drop).not.toHaveBeenCalled();
    expect(m.commit).not.toHaveBeenCalled();
    expect(releases()).toEqual([]);
    expect(m.post).toHaveBeenCalledTimes(1);
  });
  it("P10: the same read error before anything is sent says Zavi could not check, gives both holds back and leaves no claim", async () => {
    m.deleteOk = true;
    m.lifecycleSingleFails = () => true;
    const { err, status, body } = await founderRefusal(async () => launchLinkedinCampaign("t", "bound", await ask()));
    expect(err.code).toBe("ads_launch_not_sent");
    expect(status).toBe(409);
    expect(body.error.message).toMatch(/could not check whether this campaign was paused/);
    expect(body.error.message).not.toBe(PAUSED_DURING_LAUNCH);
    expect(m.post).not.toHaveBeenCalled();
    expect(m.drop).toHaveBeenCalledWith(expect.objectContaining({ status: "held", fresh: true }), { strict: true });
    expect(releases()).toHaveLength(1);
    expect(m.pause).not.toHaveBeenCalled();
    expect(m.deleted).toEqual(["ads_campaign_operations"]);
  });
  it("P5: marking a confirmed launch's hold as counted is checked and retried, so a failed first try never leaves it 'Sending'", async () => {
    const counted: string[] = [];
    let fails = 1;
    m.commit.mockImplementation(async (hold: any, _id: unknown, opts?: { strict: boolean }) => {
      if (fails > 0) {
        fails -= 1;
        if (opts?.strict) throw new Error("connection reset");
        return;
      }
      counted.push(hold.idem_key);
    });
    expect(await launchLinkedinCampaign("t", "bound", await ask())).toEqual({ status: "active" });
    expect(counted).toEqual([`${request}:resume`]);
    expect(m.pause).not.toHaveBeenCalled();
    expect(m.drop).not.toHaveBeenCalled();
    expect(m.finish).toEqual(["succeeded"]);
  });
  it("P5: a hold that still cannot be counted never fails or pauses the live launch, and is reported for the hourly check", async () => {
    m.commit.mockImplementation(async (_hold: unknown, _id: unknown, opts?: { strict: boolean }) => {
      if (opts?.strict) throw new Error("connection reset");
    });
    expect(await launchLinkedinCampaign("t", "bound", await ask())).toEqual({ status: "active" });
    expect(m.commit).toHaveBeenCalledTimes(3);
    expect(m.logged.map((l) => l.code)).toContain("ads_wallet.launch_hold_uncommitted");
    expect(m.pause).not.toHaveBeenCalled();
    expect(m.finish).toEqual(["succeeded"]);
  });
  it("P5: relaunching a campaign whose earlier confirmed launch left its hold 'Sending' counts that hold first, so the relaunch is not refused as another change still finishing", async () => {
    const earlier = "10000000-0000-4000-8000-0000000000e1";
    const counted = new Set<string>();
    m.tables = { ad_budget_reservations: [{ idem_key: `${earlier}:resume` }] };
    m.opRows = [{ id: earlier, status: "succeeded" }];
    m.commit.mockImplementation(async (hold: any) => {
      counted.add(hold.idem_key);
    });
    m.hold.mockImplementation(async () =>
      counted.has(`${earlier}:resume`)
        ? { status: "held", fresh: true, tenant_id: "t", idem_key: `${request}:resume` }
        : { status: "refused", error: BUSY },
    );
    expect(await launchLinkedinCampaign("t", "bound", await ask())).toEqual({ status: "active" });
    expect(m.commit.mock.calls[0][0]).toMatchObject({ status: "held", idem_key: `${earlier}:resume` });
    expect(m.commit.mock.invocationCallOrder[0]).toBeLessThan(m.hold.mock.invocationCallOrder[0]);
    expect(m.drop).not.toHaveBeenCalled();
    expect(counted.has(`${request}:resume`)).toBe(true);
  });
});
