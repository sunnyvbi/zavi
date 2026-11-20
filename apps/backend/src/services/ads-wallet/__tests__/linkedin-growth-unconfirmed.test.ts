import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  fx: vi.fn(),
  campaign: vi.fn(),
  spend: vi.fn(),
  pause: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
  rpc: vi.fn(),
  hold: vi.fn(),
  commit: vi.fn(),
  drop: vi.fn(),
  role: vi.fn(),
  ops: new Map<string, string>(),
  lifecycle: { provider_group_id: "7", provider_creative_ids: ["8"], stop_requested_at: null as string | null },
}));
vi.mock("../fx", async (original) => ({ ...(await original<typeof import("../fx")>()), adsFx: m.fx }));
vi.mock("../adapters/linkedin", () => ({
  linkedinCampaign: m.campaign,
  linkedinLifetimeSpend: m.spend,
  pauseLinkedinBoundCampaign: m.pause,
  unmarkLinkedinCampaignGone: async () => undefined,
}));
vi.mock("@/services/connectors/linkedin-ads/http", async (original) => {
  const real = await original<typeof import("@/services/connectors/linkedin-ads/http")>();
  const guarded = (fn: typeof m.get) => (token: string, path: string, ...rest: unknown[]) => {
    if (!real.isLinkedInAdsPath(path)) throw new Error(`transport would refuse ${path}`);
    return fn(token, path, ...rest);
  };
  return { ...real, linkedinAdsGet: guarded(m.get), linkedinAdsPost: guarded(m.post) };
});
vi.mock("@/services/agents/entitlement", () => ({ checkAgentTier: async () => ({ allowed: true, enforced: true }) }));
vi.mock("@/services/channels/lock", async (original) => ({
  ...(await original<typeof import("@/services/channels/lock")>()),
  isChannelLockedStrict: async () => false,
}));
vi.mock("@/services/tools/linkedin-ads/write/_flag-check", async (original) => ({
  ...(await original<typeof import("@/services/tools/linkedin-ads/write/_flag-check")>()),
  isLinkedInAdsWriteEnabled: async () => true,
}));
vi.mock("../wallet", () => ({ fundingEnabled: () => true }));
vi.mock("../consent", () => ({ requireSharedWalletConsent: async () => undefined }));
vi.mock("@/services/auth/tenant-role", () => ({ loadTenantRoleFor: m.role }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: async () => undefined }));
vi.mock("@/services/decisions/ad-budget", async (original) => ({
  lifetimeDailyUsd: (await original<typeof import("@/services/decisions/ad-budget")>()).lifetimeDailyUsd,
  readActiveAdBudget: async () => ({ days_left: 10 }),
  reserveAdSpend: m.hold,
  commitAdSpend: m.commit,
  dropAdSpendHold: m.drop,
  adBudgetRefusal: (reason: string) => `cap_refuse: ad_budget_${reason}`,
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (v: string) => v,
  tenantRpc: m.rpc,
  tenantClient: () => ({
    from: (table: string) => {
      const eqs: Record<string, unknown> = {};
      let op: "read" | "update" | "delete" = "read";
      let changes: Record<string, unknown> = {};
      const run = () => {
        if (table === "ads_campaign_operations") {
          const id = String(eqs.id);
          if (op === "update") {
            if (m.ops.has(id)) m.ops.set(id, String(changes.status));
            return { error: null, data: null };
          }
          if (op === "delete") {
            if (m.ops.get(id) === eqs.status) {
              m.ops.delete(id);
              return { error: null, data: [{ id }] };
            }
            return { error: null, data: [] };
          }
          return { error: null, data: m.ops.has(id) ? { status: m.ops.get(id) } : null };
        }
        if (table === "ads_campaign_lifecycle")
          return { error: null, data: op === "update" ? [{ campaign_binding_id: binding }] : structuredClone(m.lifecycle) };
        return { error: null, data: { account_id: "account" } };
      };
      const q: any = {
        select: () => q,
        eq: (k: string, v: unknown) => {
          eqs[k] = v;
          return q;
        },
        is: () => q,
        delete: () => {
          op = "delete";
          return q;
        },
        update: (v: Record<string, unknown>) => {
          op = "update";
          changes = v;
          return q;
        },
        maybeSingle: async () => run(),
        single: async () => run(),
        then: (resolve: any, reject: any) => Promise.resolve().then(run).then(resolve, reject),
      };
      return q;
    },
  }),
}));
import {
  executeLinkedinGrowthLaunch,
  LINKEDIN_LAUNCH_ALREADY_DONE,
  LINKEDIN_LAUNCH_CHECKING,
  LINKEDIN_LAUNCH_RECONCILED_PAUSED,
  LINKEDIN_LAUNCH_REQUEST_USED,
  LINKEDIN_LAUNCH_UNCONFIRMED,
} from "../linkedin-growth";
import { linkedinLaunchSummary, LINKEDIN_LAUNCH_UNCONFIRMED_WALLET } from "../linkedin-launch";
import { classifyExecFailure, verdictFor } from "@/services/channels/exec-failure";
import { isPartialRiskExecCode } from "@zavi/shared";
import { ExpectedToolError } from "@/services/tools/types";
import { LINKEDIN_ADS_CHANGE_REFUSED } from "@/services/connectors/linkedin-ads/http";

const decisionId = "10000000-0000-4000-8000-0000000000aa";
const binding = "22222222-2222-4222-8222-222222222222";
let context: any;
let failure: (path: string, body: any) => void;
let applyActivation = true;

beforeEach(() => {
  vi.resetAllMocks();
  process.env.ADS_LINKEDIN_MANAGED_ENABLED = "true";
  process.env.ADS_LINKEDIN_ROLLOUT_ACK = "campaign-bindings-forward-only";
  m.ops = new Map();
  m.lifecycle = { provider_group_id: "7", provider_creative_ids: ["8"], stop_requested_at: null };
  applyActivation = true;
  failure = () => {};
  m.role.mockResolvedValue("owner");
  m.fx.mockImplementation(async (currency: string) => ({ currency, units_per_usd: 1, as_of: null, source: "ExchangeRate-API" }));
  context = {
    binding: { id: "bound", account_id: "account", funding_source: "wallet" },
    account: { id: "42", currency: "USD", status: "ACTIVE", servingStatuses: ["RUNNABLE"] },
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
  m.campaign.mockImplementation(async () => structuredClone(context));
  m.spend.mockResolvedValue({ cents: 0 });
  m.hold.mockResolvedValue({ status: "held", fresh: true, tenant_id: "tenant", idem_key: `${decisionId}:resume` });
  m.rpc.mockImplementation(async (_t: string, name: string, args: any) => {
    if (name === "ads_claim_campaign_operation") {
      if (m.ops.has(args.p_id)) return { data: false, error: null };
      m.ops.set(args.p_id, "pending");
      return { data: true, error: null };
    }
    return { data: 0, error: null };
  });
  let adIntent = "DRAFT";
  m.get.mockImplementation(async (_token: string, path: string) =>
    path.endsWith("adCampaignGroups/7")
      ? { id: 7, account: context.campaign.account, status: "DRAFT" }
      : path === "adAccounts/42/creatives/urn%3Ali%3AsponsoredCreative%3A8"
        ? { id: 8, campaign: "urn:li:sponsoredCampaign:123", intendedStatus: adIntent }
        : { elements: [{ id: "123", campaignGroup: context.campaign.campaignGroup }] },
  );
  m.post.mockImplementation(async (_token: string, path: string, _method: string, body: any) => {
    failure(path, body);
    if (path.includes("creatives")) adIntent = body.patch.$set.intendedStatus;
    if (path === context.path && (applyActivation || body.patch.$set.status !== "ACTIVE")) Object.assign(context.campaign, body.patch.$set);
    return {};
  });
});

async function decision() {
  const summary = await linkedinLaunchSummary("tenant", binding);
  return {
    id: decisionId,
    tenant_id: "tenant",
    approved_by: "founder",
    approved_by_source: null,
    body: {
      campaign_binding_id: binding,
      name: "Pilot",
      rationale: "Test the verified campaign",
      snapshot: summary.snapshot,
      total_budget_cents: 10000,
      total_budget_usd: 100,
      currency: "USD",
      end_time: Date.now() + 86400000,
      origin: "agent",
    },
  };
}

const failures: Array<[string, () => void]> = [
  [
    "LinkedIn took every write but the campaign did not read back as active",
    () => {
      applyActivation = false;
    },
  ],
  [
    "the first LinkedIn write timed out with no answer",
    () => {
      failure = () => {
        throw new Error("socket hang up");
      };
    },
  ],
];

it.each(failures)("when %s, the founder is told it may have reached LinkedIn and is never offered a Try again that reuses the dead request", async (_name, arrange) => {
  const d = await decision();
  arrange();
  const first = await executeLinkedinGrowthLaunch(d);
  expect(m.post).toHaveBeenCalled();
  expect(m.pause).toHaveBeenCalledWith("tenant", binding);
  expect(m.drop).not.toHaveBeenCalled();
  expect(m.commit).not.toHaveBeenCalled();
  expect(m.ops.get(decisionId)).toBe("uncertain");
  expect(first).toEqual({ ok: false, code: "exec_outcome_unknown", error: LINKEDIN_LAUNCH_UNCONFIRMED_WALLET });
  expect(first.error).not.toMatch(/Campaign Manager/);
  expect(first.error).toMatch(/may have reached LinkedIn/);
  expect(first.error).toMatch(/tried to pause the campaign/);
  expect(first.error).toMatch(/may still be running/);
  expect(first.error).not.toMatch(/Zavi paused the campaign/);
  expect(first.error).toMatch(/review the launch again/);
  expect(first.error).not.toMatch(/did not accept|try again|Try again|ads_|request_id|uncertain|operation|binding|tenant|reservation/);
  expect(isPartialRiskExecCode((first as { code?: string }).code)).toBe(true);
  expect(classifyExecFailure(first)).toEqual({ bucket: "partial_risk", fix: null, platform_code: null });

  const writes = m.post.mock.calls.length;
  const second = await executeLinkedinGrowthLaunch(d);
  expect(m.post.mock.calls.length).toBe(writes);
  expect(m.ops.get(decisionId)).toBe("uncertain");
  expect(second.ok).toBe(false);
  expect(second.error).not.toMatch(/did not accept|try again|Try again/);
  expect(second.error).toMatch(/review (it|the launch) again/i);
});

it("Flow 39: when LinkedIn cleanly refuses a creative after the budget write landed, Autopilot reports the campaign stays paused, keeps no hold and is never told it may have reached LinkedIn", async () => {
  const d = await decision();
  failure = (path) => {
    if (path.includes("creatives")) throw new ExpectedToolError("linkedin_ads_write_refused", LINKEDIN_ADS_CHANGE_REFUSED, { status: 422, http_status: 422 });
  };
  const first = await executeLinkedinGrowthLaunch(d);
  expect(m.pause).not.toHaveBeenCalled();
  expect(m.drop).toHaveBeenCalledTimes(1);
  expect(m.commit).not.toHaveBeenCalled();
  expect(m.ops.has(decisionId)).toBe(false);
  expect(first.ok).toBe(false);
  expect((first as { code?: string }).code).not.toBe("exec_outcome_unknown");
  expect(first.error).toMatch(/^LinkedIn did not let Zavi switch this campaign on, so it stays paused and cannot spend\./);
  expect(first.error).not.toMatch(/may have reached/);
  expect(classifyExecFailure(first)?.bucket).not.toBe("partial_risk");
});

it("an unconfirmed launch on the founder's own billing still points to Campaign Manager", async () => {
  context.binding.funding_source = "provider";
  const d = await decision();
  failure = () => {
    throw new Error("socket hang up");
  };
  expect(await executeLinkedinGrowthLaunch(d)).toEqual({ ok: false, code: "exec_outcome_unknown", error: LINKEDIN_LAUNCH_UNCONFIRMED });
});

it("a second run of the same request after an unconfirmed launch never writes to LinkedIn again and keeps the same plain words with no retry", async () => {
  const d = await decision();
  failure = () => {
    throw new Error("socket hang up");
  };
  await executeLinkedinGrowthLaunch(d);
  const writes = m.post.mock.calls.length;
  failure = () => {};
  const again = await executeLinkedinGrowthLaunch(d);
  expect(m.post.mock.calls.length).toBe(writes);
  expect(m.rpc.mock.calls.filter((c) => c[1] === "ads_claim_campaign_operation")).toHaveLength(1);
  expect(again).toEqual({ ok: false, code: "exec_outcome_unknown", error: LINKEDIN_LAUNCH_UNCONFIRMED_WALLET });
  expect(classifyExecFailure(again)?.bucket).toBe("partial_risk");
});

it("a launch that never reached LinkedIn keeps its own words and stays retryable on the same request", async () => {
  const d = await decision();
  m.hold.mockResolvedValueOnce({ status: "refused", error: "cap_refuse: ad_budget_over_month" });
  const first = await executeLinkedinGrowthLaunch(d);
  expect(m.post).not.toHaveBeenCalled();
  expect(m.ops.has(decisionId)).toBe(false);
  expect((first as { code?: string }).code).toBeUndefined();
  expect(first.error).not.toBe(LINKEDIN_LAUNCH_UNCONFIRMED);
  expect(classifyExecFailure(first)?.bucket).not.toBe("partial_risk");
  expect(await executeLinkedinGrowthLaunch(d)).toMatchObject({ ok: true });
  expect(m.ops.get(decisionId)).toBe("succeeded");
});

it.each([
  ["uncertain", { ok: false, code: "exec_outcome_unknown", error: LINKEDIN_LAUNCH_UNCONFIRMED_WALLET }],
  ["pending", { ok: false, code: "exec_outcome_unknown", error: LINKEDIN_LAUNCH_CHECKING }],
])("approving a card whose launch row is %s again says it may have reached LinkedIn and is never retried", async (status, expected) => {
  const d = await decision();
  m.ops.set(decisionId, status);
  const r = await executeLinkedinGrowthLaunch(d);
  expect(r).toEqual(expected);
  expect(m.post).not.toHaveBeenCalled();
  expect(classifyExecFailure(r)?.bucket).toBe("partial_risk");
});

it("approving a card whose launch already succeeded reports the launch as done, never as an outcome Zavi cannot see", async () => {
  const d = await decision();
  m.ops.set(decisionId, "succeeded");
  const r = await executeLinkedinGrowthLaunch(d);
  expect(r).toEqual({ ok: true, notice: LINKEDIN_LAUNCH_ALREADY_DONE });
  expect(JSON.stringify(r)).not.toMatch(/may have reached|exec_outcome_unknown|could not confirm/);
  expect(m.post).not.toHaveBeenCalled();
  expect(classifyExecFailure(r)?.bucket).not.toBe("partial_risk");
});

it("approving again after the reconcile paused an interrupted launch never says nothing was sent: it says Zavi could not confirm and keeps it paused", async () => {
  const d = await decision();
  m.ops.set(decisionId, "refused");
  const r = await executeLinkedinGrowthLaunch(d);
  expect(r).toEqual({ ok: false, code: "exec_outcome_unknown", error: LINKEDIN_LAUNCH_RECONCILED_PAUSED });
  expect(r.error).not.toMatch(/Nothing was sent|did not accept|try again|Try again/);
  expect(m.post).not.toHaveBeenCalled();
  expect(classifyExecFailure(r)?.bucket).toBe("partial_risk");
});

it("a reconciled launch whose campaign changed since review is not closed as 'Nothing was sent to LinkedIn'", async () => {
  const d = await decision();
  m.ops.set(decisionId, "refused");
  const reviewed = structuredClone(context);
  context.campaign.name = "Pilot (paused by Zavi to be safe)";
  m.campaign.mockImplementation(async (...a: unknown[]) => structuredClone(a[5] ? context : reviewed));
  const r = await executeLinkedinGrowthLaunch(d);
  expect(r).toEqual({ ok: false, code: "exec_outcome_unknown", error: LINKEDIN_LAUNCH_RECONCILED_PAUSED });
  expect(m.rpc.mock.calls.filter((c) => c[1] === "ads_claim_campaign_operation")).toHaveLength(0);
  expect(m.post).not.toHaveBeenCalled();
  expect(classifyExecFailure(r)?.bucket).toBe("partial_risk");
  expect(verdictFor(r, "linkedin_ads.launch_campaign")?.note ?? "").not.toMatch(/Nothing was sent/);
});


describe("Review 34", () => {
  it("P2: approving again after the reply to a live launch was lost says it is already launched, not that only a paused campaign can launch, and touches nothing", async () => {
    const d = await decision();
    await executeLinkedinGrowthLaunch(d);
    expect(m.ops.get(decisionId)).toBe("succeeded");
    expect(context.campaign.status).toBe("ACTIVE");
    const writes = m.post.mock.calls.length;
    const holds = m.hold.mock.calls.length;
    const claims = m.rpc.mock.calls.filter((c) => c[1] === "ads_claim_campaign_operation").length;
    const again = await executeLinkedinGrowthLaunch(d);
    expect(again).toEqual({ ok: true, notice: LINKEDIN_LAUNCH_ALREADY_DONE });
    expect(JSON.stringify(again)).not.toMatch(/Only a paused campaign/);
    expect(m.post.mock.calls.length).toBe(writes);
    expect(m.hold.mock.calls.length).toBe(holds);
    expect(m.rpc.mock.calls.filter((c) => c[1] === "ads_claim_campaign_operation")).toHaveLength(claims);
    expect(m.pause).not.toHaveBeenCalled();
    expect(m.drop).not.toHaveBeenCalled();
  });

  it("P3: an own-billing launch whose first LinkedIn write answers 401 keeps LinkedIn's code and the reconnect words on the card, gives the hold back and never says Zavi stopped it", async () => {
    context.binding.funding_source = "provider";
    const d = await decision();
    failure = (path, body) => {
      if (path === context.path && body.patch.$set.totalBudget)
        throw new ExpectedToolError("linkedin_ads_token_revoked", "LinkedIn Ads needs to be reconnected. Reconnect it from Connectors in the left menu.", { status: 401 });
    };
    const r = await executeLinkedinGrowthLaunch(d);
    expect(r).toEqual({ ok: false, error: "LinkedIn Ads needs to be reconnected. Reconnect it from Connectors in the left menu. Nothing changed in LinkedIn and nothing was held." });
    expect((r as { code?: string }).code).not.toBe("linkedin_ads_launch_refused");
    expect(m.drop).toHaveBeenCalledWith(expect.objectContaining({ status: "held", fresh: true }), { strict: true });
    expect(m.commit).not.toHaveBeenCalled();
    expect(m.pause).not.toHaveBeenCalled();
    expect(m.ops.has(decisionId)).toBe(false);
    expect(m.post).toHaveBeenCalledTimes(1);
  });

  it("P3: a total or end date LinkedIn refuses shows LinkedIn's refusal, never 'Zavi stopped this before anything reached LinkedIn'", async () => {
    context.binding.funding_source = "provider";
    const d = await decision();
    failure = (path, body) => {
      if (path === context.path && body.patch.$set.totalBudget)
        throw new ExpectedToolError("linkedin_ads_write_refused", LINKEDIN_ADS_CHANGE_REFUSED, { status: 400, http_status: 400, linkedin_reason: "runSchedule.end invalid" });
    };
    const r = await executeLinkedinGrowthLaunch(d);
    expect(r).toEqual({ ok: false, error: "LinkedIn did not accept this total budget or end date. Nothing changed in LinkedIn and nothing was held. Check both, then try again." });
    expect(JSON.stringify(r)).not.toMatch(/Zavi stopped this/);
    expect(m.drop).toHaveBeenCalledWith(expect.objectContaining({ status: "held", fresh: true }), { strict: true });
    expect(m.pause).not.toHaveBeenCalled();
    expect(m.post).toHaveBeenCalledTimes(1);
  });
});
