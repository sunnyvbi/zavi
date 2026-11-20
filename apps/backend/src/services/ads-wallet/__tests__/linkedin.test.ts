import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  binding: vi.fn(),
  account: vi.fn(),
  resolve: vi.fn(),
  rpc: vi.fn(),
  wallet: vi.fn(),
  walletRow: vi.fn(),
  eligibility: vi.fn(),
  alert: vi.fn(),
  rows: {} as Record<string, unknown>,
  updates: [] as unknown[],
}));
vi.mock("../bindings", () => ({
  getCampaignBinding: m.binding,
  getAccountBinding: m.account,
}));
vi.mock("../adapters/linkedin-account", () => ({
  resolveLinkedinAccount: m.resolve,
}));
vi.mock("@/services/connectors/linkedin-ads/http", () => ({
  linkedinAdsGet: m.get,
  linkedinAdsPost: m.post,
}));
vi.mock("../wallet", () => ({ readWallet: m.wallet, walletRow: m.walletRow }));
vi.mock("../providers", () => ({ refillEligibility: m.eligibility }));
vi.mock("@/services/growth/cgo-blockers", () => ({ alertFounderSafely: m.alert }));
vi.mock("@/services/decisions/ad-budget", () => ({
  adBudgetIdemKey: (id: string) => id,
  commitAdSpend: async () => {},
  committedAdHoldIds: vi.fn(async () => ["hold-1"]),
  releaseAdSpendHolds: vi.fn(),
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  tenantRpc: m.rpc,
  tenantClient: () => ({
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      let write: null | "update" | "upsert" = null;
      let values: Record<string, unknown> = {};
      const run = () => {
        if (table !== "ads_campaign_lifecycle" || !write)
          return { data: m.rows[table] ?? null, error: null };
        const row = (m.rows[table] ??= {}) as Record<string, unknown>;
        if (write === "upsert") {
          Object.assign(row, values);
          return { data: null, error: null };
        }
        if ("stop_requested_at" in filters && row.stop_requested_at !== filters.stop_requested_at)
          return { data: [], error: null };
        Object.assign(row, values);
        return { data: [{ campaign_binding_id: filters.campaign_binding_id }], error: null };
      };
      const q: any = {
        select: () => q,
        eq: (col: string, v: unknown) => {
          filters[col] = v;
          return q;
        },
        in: () => q,
        upsert: (v: Record<string, unknown>) => {
          m.updates.push(v);
          write = "upsert";
          values = v;
          return q;
        },
        update: (v: Record<string, unknown>) => {
          m.updates.push(v);
          write = "update";
          values = v;
          return q;
        },
        maybeSingle: async () => run(),
        then: (resolve: any) => resolve(run()),
      };
      return q;
    },
  }),
}));
import {
  linkedinLifetimeSpend,
  linkedinCampaign,
  settleLinkedinBoundCampaign,
  pauseLinkedinBoundCampaign,
  reconcileLinkedinOperation,
  requestLinkedinPause,
  LINKEDIN_PAUSE_ZAVI_FAULT,
} from "../adapters/linkedin";
import { ExpectedToolError } from "@/services/tools/types";
import { decimalCents } from "../money";
let campaign: Record<string, any>;
let report: unknown;
beforeEach(() => {
  vi.resetAllMocks();
  m.rows = {
    ads_campaign_lifecycle: {
      created_paused: true,
      activation_attempted_at: null,
      stop_requested_at: null,
    },
    ads_campaign_reservations: { reserved_cents: 10000 },
  };
  m.updates = [];
  campaign = {
    id: 123,
    account: "urn:li:sponsoredAccount:42",
    name: "Bound campaign",
    status: "PAUSED",
    campaignGroup: "urn:li:sponsoredCampaignGroup:7",
    totalBudget: { amount: "100.00", currencyCode: "USD" },
    runSchedule: { start: Date.now() - 1000, end: Date.now() + 86400000 },
    changeAuditStamps: {
      created: { time: Date.now() - 1000 },
      lastModified: { time: Date.now() - 1000 },
    },
  };
  campaign.changeAuditStamps.lastModified.time =
    campaign.changeAuditStamps.created.time;
  report = {
    elements: [
      {
        pivotValues: ["urn:li:sponsoredCampaign:123"],
        costInLocalCurrency: "12.001",
      },
    ],
  };
  m.binding.mockResolvedValue({
    id: "bound",
    tenant_id: "t",
    platform: "linkedin",
    provider_campaign_id: "123",
    account_binding_id: "account",
    funding_source: "wallet",
  });
  m.account.mockResolvedValue({ id: "account" });
  m.resolve.mockResolvedValue({
    token: "bound-secret",
    account: { id: "42", currency: "USD" },
  });
  m.rpc.mockResolvedValue({ error: null });
  m.wallet.mockResolvedValue({ available_cents: 10000 });
  m.walletRow.mockResolvedValue({ payment_method_id: "pm_1" });
  m.eligibility.mockResolvedValue("allowed");
  m.alert.mockResolvedValue({ sent: 1, urgent_ids: [] });
  m.get.mockImplementation(async (_token, path) =>
    path === "adAnalytics" ? report : campaign,
  );
  m.post.mockImplementation(async () => {
    campaign.status = "PAUSED";
    return {};
  });
});
it.each([
  ["0", 0],
  ["0.001", 1],
  ["1.005", 101],
  ["19.99", 1999],
  ["12.000", 1200],
])("converts decimal %s conservatively and exactly", (v, c) =>
  expect(decimalCents(v)).toBe(c),
);
it("allows protective pauses for a customer's non-USD campaign but refuses USD settlement", async () => {
  m.resolve.mockResolvedValue({
    token: "bound-secret",
    account: { id: "42", currency: "EUR" },
  });
  campaign.totalBudget.currencyCode = "EUR";
  campaign.status = "ACTIVE";
  await pauseLinkedinBoundCampaign("t", "bound");
  expect(m.post).toHaveBeenCalledTimes(1);
  await expect(linkedinLifetimeSpend("t", "bound")).rejects.toMatchObject({
    code: "ads_currency_unsupported",
  });
  expect(m.rpc).not.toHaveBeenCalled();
});
it.each([null, 1, -1, "-1", "NaN", "1e3", ""])(
  "refuses malformed provider spend %s",
  (v) => expect(() => decimalCents(v)).toThrow(),
);
it("uses the pinned account and campaign in its reporting filters", async () => {
  expect((await linkedinLifetimeSpend("t", "bound")).cents).toBe(1201);
  expect(m.get).toHaveBeenCalledWith(
    "bound-secret",
    "adAnalytics",
    expect.objectContaining({
      accounts: ["urn:li:sponsoredAccount:42"],
      campaigns: ["urn:li:sponsoredCampaign:123"],
    }),
    { fields: "pivotValues,costInLocalCurrency" },
    { fresh: true },
  );
});
it.each([
  { account: "urn:li:sponsoredAccount:99" },
  { id: 999 },
  { dailyBudget: { amount: "10", currencyCode: "EUR" } },
])("refuses identity/currency drift before reporting %o", async (change) => {
  Object.assign(campaign, change);
  await expect(linkedinLifetimeSpend("t", "bound")).rejects.toThrow();
  expect(m.get.mock.calls).toHaveLength(1);
});
it("reads an empty report as nothing reported yet, before or after activation", async () => {
  report = { elements: [] };
  expect((await linkedinLifetimeSpend("t", "bound")).cents).toBe(0);
  m.rows.ads_campaign_lifecycle = {
    created_paused: true,
    activation_attempted_at: new Date().toISOString(),
  };
  campaign.changeAuditStamps.lastModified.time += 1;
  expect((await linkedinLifetimeSpend("t", "bound")).cents).toBe(0);
});
it("keeps settling a launched campaign that never delivered, so its hold can be released", async () => {
  report = { elements: [] };
  campaign.status = "COMPLETED";
  m.rows.ads_campaign_lifecycle = {
    created_paused: true,
    activation_attempted_at: new Date().toISOString(),
    stop_requested_at: null,
  };
  m.rpc.mockResolvedValue({ data: false, error: null });
  await settleLinkedinBoundCampaign("t", "bound");
  expect(m.rpc).toHaveBeenCalledWith("t", "ads_wallet_settle_bound", {
    p_campaign_binding_id: "bound",
    p_spend_cents: 0,
  });
  expect(m.rpc).toHaveBeenCalledWith("t", "ads_observe_linkedin_spend", {
    p_campaign_binding_id: "bound",
    p_spend_cents: 0,
    p_ended: true,
  });
});
it.each([
  {
    elements: [
      {
        pivotValues: ["urn:li:sponsoredCampaign:999"],
        costInLocalCurrency: "1",
      },
    ],
  },
  { elements: [{ pivotValues: ["urn:li:sponsoredCampaign:123"] }] },
])("never settles unavailable or foreign spend %o", async (bad) => {
  report = bad;
  m.rows.ads_campaign_lifecycle = { created_paused: false };
  await expect(settleLinkedinBoundCampaign("t", "bound")).rejects.toThrow();
  expect(m.rpc).not.toHaveBeenCalled();
});
it("pauses an overdrawn wallet even when reporting is unavailable", async () => {
  campaign.status = "ACTIVE";
  report = {};
  m.wallet.mockResolvedValue({ available_cents: -1 });
  await expect(settleLinkedinBoundCampaign("t", "bound")).rejects.toThrow();
  expect(m.post).toHaveBeenCalled();
  expect(m.rpc).not.toHaveBeenCalled();
});
it("settles campaign spend and protects a campaign whose external cap exceeds its reservation", async () => {
  campaign.status = "ACTIVE";
  m.rows.ads_campaign_reservations = { reserved_cents: 100 };
  await settleLinkedinBoundCampaign("t", "bound");
  expect(m.rpc).toHaveBeenCalledWith("t", "ads_wallet_settle_bound", {
    p_campaign_binding_id: "bound",
    p_spend_cents: 1201,
  });
  expect(campaign.status).toBe("PAUSED");
});
it.each([
  { elements: [] },
  { elements: [{ pivotValues: ["urn:li:sponsoredCampaign:123"], costInLocalCurrency: "12.001" }] },
])("keeps a fully covered campaign running when LinkedIn reports less than was already charged (%#)", async (lower) => {
  campaign.status = "ACTIVE";
  report = lower;
  m.rows.ads_campaign_reservations = { reserved_cents: 5000, spent_cents: 5000 };
  await settleLinkedinBoundCampaign("t", "bound");
  expect(m.post).not.toHaveBeenCalled();
  expect(m.updates).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ stop_requested_at: expect.anything() })]),
  );
  expect(campaign.status).toBe("ACTIVE");
});
it("still pauses when the recorded charge plus the hold no longer covers the cap", async () => {
  campaign.status = "ACTIVE";
  m.rows.ads_campaign_reservations = { reserved_cents: 4999, spent_cents: 5000 };
  await settleLinkedinBoundCampaign("t", "bound");
  expect(campaign.status).toBe("PAUSED");
});
it("settles late charges before asking SQL to release only after ended/stable spend", async () => {
  campaign.status = "COMPLETED";
  await settleLinkedinBoundCampaign("t", "bound");
  expect(m.rpc.mock.calls.map((c) => c[1])).toEqual([
    "ads_wallet_settle_bound",
    "ads_observe_linkedin_spend",
  ]);
  expect(m.rpc).toHaveBeenCalledWith("t", "ads_observe_linkedin_spend", {
    p_campaign_binding_id: "bound",
    p_spend_cents: 1201,
    p_ended: true,
  });
});
it("persists a stop even when the provider pause fails", async () => {
  campaign.status = "ACTIVE";
  m.post.mockRejectedValue(new Error("timeout"));
  await expect(pauseLinkedinBoundCampaign("t", "bound")).rejects.toThrow(
    "timeout",
  );
  expect(m.updates).toContainEqual(
    expect.objectContaining({
      campaign_binding_id: "bound",
      stop_requested_at: expect.any(String),
    }),
  );
});
it("refuses a binding for a different platform before resolving credentials", async () => {
  m.binding.mockResolvedValue({ platform: "chatgpt" });
  await expect(linkedinCampaign("t", "bound")).rejects.toThrow();
  expect(m.resolve).not.toHaveBeenCalled();
});

it("releases future monthly coverage only after the stable-spend RPC confirms wallet release",async()=>{
 const {releaseAdSpendHolds,committedAdHoldIds}=await import("@/services/decisions/ad-budget");campaign.status="COMPLETED";
 vi.mocked(committedAdHoldIds).mockResolvedValue(["hold-1"]);
 m.rpc.mockResolvedValue({error:null,data:false});await settleLinkedinBoundCampaign("t","bound");expect(releaseAdSpendHolds).not.toHaveBeenCalled();
 m.rpc.mockResolvedValue({error:null,data:true});await settleLinkedinBoundCampaign("t","bound");expect(releaseAdSpendHolds).toHaveBeenCalledWith("t","linkedin","bound",["hold-1"]);
});
it("records a durable pause intent even when LinkedIn cannot be read", async () => {
  m.get.mockRejectedValue(new Error("LinkedIn unavailable"));
  await expect(pauseLinkedinBoundCampaign("t", "bound")).rejects.toThrow(
    "LinkedIn unavailable",
  );
  expect(m.updates).toContainEqual(
    expect.objectContaining({
      campaign_binding_id: "bound",
      tenant_id: "t",
      stop_requested_at: expect.any(String),
    }),
  );
  expect(m.post).not.toHaveBeenCalled();
});

it.each([false, true])("recovers a customer-billed pause timeout (provider applied it: %s)", async (applied) => {
  m.binding.mockResolvedValue({ id: "bound", tenant_id: "t", platform: "linkedin", provider_campaign_id: "123", account_binding_id: "account", funding_source: "provider" });
  campaign.status = "ACTIVE";
  m.post.mockImplementationOnce(async () => {
    if (applied) campaign.status = "PAUSED";
    throw new Error("timeout");
  });
  await expect(pauseLinkedinBoundCampaign("t", "bound")).rejects.toThrow("timeout");
  const intent = m.updates.find((v: any) => v.stop_requested_at) as { stop_requested_at: string };
  expect(intent).toBeDefined();
  expect(m.updates).not.toContainEqual(expect.objectContaining({ stop_confirmed_at: expect.any(String) }));
  m.rows.ads_campaign_lifecycle = intent;
  await pauseLinkedinBoundCampaign("t", "bound", false);
  expect(campaign.status).toBe("PAUSED");
  expect(m.post).toHaveBeenCalledTimes(applied ? 1 : 2);
  expect(m.updates).toContainEqual(expect.objectContaining({ stop_confirmed_at: expect.any(String) }));
  expect(m.rpc).not.toHaveBeenCalled();
  expect(m.wallet).not.toHaveBeenCalled();
});

it("recovers a customer-billed pause after the initial campaign read is unavailable", async () => {
  m.binding.mockResolvedValue({ id: "bound", tenant_id: "t", platform: "linkedin", provider_campaign_id: "123", account_binding_id: "account", funding_source: "provider" });
  campaign.status = "ACTIVE";
  m.get.mockRejectedValueOnce(new Error("offline"));
  await expect(pauseLinkedinBoundCampaign("t", "bound")).rejects.toThrow("offline");
  m.rows.ads_campaign_lifecycle = m.updates[0];
  await pauseLinkedinBoundCampaign("t", "bound", false);
  expect(campaign.status).toBe("PAUSED");
  expect(m.rpc).not.toHaveBeenCalled();
  expect(m.wallet).not.toHaveBeenCalled();
});

it("protectively stops an uncertain customer-billed activation without relaunching it", async () => {
  m.binding.mockResolvedValue({ id: "bound", tenant_id: "t", platform: "linkedin", provider_campaign_id: "123", account_binding_id: "account", funding_source: "provider" });
  m.rows.ads_campaign_operations = { id: "op", created_at: new Date(Date.now() - 11 * 60000).toISOString() };
  campaign.status = "ACTIVE";
  await reconcileLinkedinOperation("t", "bound");
  expect(campaign.status).toBe("PAUSED");
  expect(m.post).toHaveBeenCalledTimes(1);
  expect(m.post).toHaveBeenCalledWith("bound-secret", expect.any(String), "PARTIAL_UPDATE", { patch: { $set: { status: "PAUSED" } } });
  expect(m.updates).toContainEqual(expect.objectContaining({ status: "refused" }));
  expect(m.wallet).not.toHaveBeenCalled();
});
it.each(["provider", "wallet"])("the sweep leaves a %s launch running that LinkedIn confirmed live but whose record failed, and records it done", async (funding) => {
  m.binding.mockResolvedValue({ id: "bound", tenant_id: "t", platform: "linkedin", provider_campaign_id: "123", account_binding_id: "account", funding_source: funding });
  m.rows.ads_campaign_operations = { id: "op", status: "pending", created_at: new Date(Date.now() - 11 * 60000).toISOString() };
  m.rows.ad_budget_reservations = { status: "committed" };
  campaign.status = "ACTIVE";
  await reconcileLinkedinOperation("t", "bound");
  expect(campaign.status).toBe("ACTIVE");
  expect(m.post).not.toHaveBeenCalled();
  expect(m.updates).toEqual([expect.objectContaining({ status: "succeeded" })]);
  expect(m.updates).not.toContainEqual(expect.objectContaining({ stop_requested_at: expect.anything() }));
});
it.each([
  ["a crash before LinkedIn confirmed it, with its hold still open", "reserved", null],
  ["a pause asked for after it went live", "committed", "2026-11-03T10:00:00.000Z"],
])("the sweep still pauses a stuck launch after %s", async (_label, holdStatus, stop) => {
  m.binding.mockResolvedValue({ id: "bound", tenant_id: "t", platform: "linkedin", provider_campaign_id: "123", account_binding_id: "account", funding_source: "provider" });
  m.rows.ads_campaign_operations = { id: "op", status: "pending", created_at: new Date(Date.now() - 11 * 60000).toISOString() };
  m.rows.ad_budget_reservations = { status: holdStatus };
  (m.rows.ads_campaign_lifecycle as Record<string, unknown>).stop_requested_at = stop;
  campaign.status = "ACTIVE";
  await reconcileLinkedinOperation("t", "bound");
  expect(campaign.status).toBe("PAUSED");
  expect(m.post).toHaveBeenCalledWith("bound-secret", expect.any(String), "PARTIAL_UPDATE", { patch: { $set: { status: "PAUSED" } } });
  expect(m.updates[0]).toEqual(expect.objectContaining({ status: "uncertain" }));
  expect(m.updates).toContainEqual(expect.objectContaining({ status: "refused" }));
  expect(m.updates).not.toContainEqual(expect.objectContaining({ status: "succeeded" }));
});
it("treats a campaign Zavi paused and LinkedIn still shows paused as finished, so its wallet hold can be given back after 72 flat hours", async () => {
  campaign.status = "ACTIVE";
  m.rows.ads_campaign_lifecycle = {
    created_paused: true,
    activation_attempted_at: new Date().toISOString(),
    stop_requested_at: new Date().toISOString(),
  };
  m.rpc.mockResolvedValue({ data: false, error: null });
  await settleLinkedinBoundCampaign("t", "bound");
  expect(m.post).toHaveBeenCalledWith("bound-secret", expect.any(String), "PARTIAL_UPDATE", {
    patch: { $set: { status: "PAUSED" } },
  });
  expect(m.updates).toContainEqual(expect.objectContaining({ stop_confirmed_at: expect.any(String) }));
  expect(m.rpc).toHaveBeenCalledWith("t", "ads_observe_linkedin_spend", {
    p_campaign_binding_id: "bound",
    p_spend_cents: 1201,
    p_ended: true,
  });
});
it.each([
  ["paused in LinkedIn by someone else", "PAUSED"],
  ["running", "ACTIVE"],
])("never counts a campaign %s with no Zavi stop as finished", async (_label, status) => {
  campaign.status = status;
  m.rows.ads_campaign_lifecycle = {
    created_paused: true,
    activation_attempted_at: new Date().toISOString(),
    stop_requested_at: null,
  };
  m.rows.ads_campaign_reservations = { reserved_cents: 10000 };
  m.rpc.mockResolvedValue({ data: false, error: null });
  await settleLinkedinBoundCampaign("t", "bound");
  expect(m.rpc).toHaveBeenCalledWith("t", "ads_observe_linkedin_spend", {
    p_campaign_binding_id: "bound",
    p_spend_cents: 1201,
    p_ended: false,
  });
});
it("a Zavi stop whose pause LinkedIn will not confirm keeps the hold and records nothing as finished", async () => {
  campaign.status = "ACTIVE";
  m.rows.ads_campaign_lifecycle = {
    created_paused: true,
    activation_attempted_at: new Date().toISOString(),
    stop_requested_at: new Date().toISOString(),
  };
  m.post.mockResolvedValue({});
  await expect(settleLinkedinBoundCampaign("t", "bound")).rejects.toThrow("LinkedIn pause could not be confirmed");
  expect(m.rpc).not.toHaveBeenCalledWith("t", "ads_observe_linkedin_spend", expect.anything());
});
const billingHoldAccount = async (_t: string, _b: unknown, write = false, refuseBillingHold = write) => {
  if (refuseBillingHold) {
    const { ExpectedToolError } = await import("@/services/tools/types");
    throw new ExpectedToolError("linkedin_ads_write_refused", "LinkedIn has paused your ad account for billing.", { billing_hold: true });
  }
  return { token: "bound-secret", account: { id: "42", currency: "USD", servingStatuses: ["BILLING_HOLD"] } };
};
it("pauses a wallet campaign on a LinkedIn billing hold, confirms the stop and gives the hold back", async () => {
  const { releaseAdSpendHolds, committedAdHoldIds } = await import("@/services/decisions/ad-budget");
  vi.mocked(committedAdHoldIds).mockResolvedValue(["hold-1"]);
  m.resolve.mockImplementation(billingHoldAccount);
  campaign.status = "ACTIVE";
  expect(await pauseLinkedinBoundCampaign("t", "bound")).toBe("paused");
  expect(m.post).toHaveBeenCalledWith("bound-secret", expect.any(String), "PARTIAL_UPDATE", { patch: { $set: { status: "PAUSED" } } });
  expect(campaign.status).toBe("PAUSED");
  expect(m.updates).toContainEqual(expect.objectContaining({ stop_confirmed_at: expect.any(String) }));
  expect(releaseAdSpendHolds).toHaveBeenCalledWith("t", "linkedin", "bound", ["hold-1"]);
});
it("the settle tick pauses a stopped campaign on a billing hold and still settles its spend as ended", async () => {
  m.resolve.mockImplementation(billingHoldAccount);
  campaign.status = "ACTIVE";
  m.rows.ads_campaign_lifecycle = { created_paused: true, activation_attempted_at: new Date().toISOString(), stop_requested_at: new Date(Date.now() - 60_000).toISOString() };
  m.rpc.mockResolvedValue({ data: false, error: null });
  await settleLinkedinBoundCampaign("t", "bound");
  expect(campaign.status).toBe("PAUSED");
  expect(m.rpc).toHaveBeenCalledWith("t", "ads_wallet_settle_bound", { p_campaign_binding_id: "bound", p_spend_cents: 1201 });
  expect(m.rpc).toHaveBeenCalledWith("t", "ads_observe_linkedin_spend", { p_campaign_binding_id: "bound", p_spend_cents: 1201, p_ended: true });
});
it("still settles a wallet campaign's spend when the retried pause fails, then reports the pause failure", async () => {
  campaign.status = "ACTIVE";
  m.rows.ads_campaign_lifecycle = { created_paused: true, activation_attempted_at: new Date().toISOString(), stop_requested_at: new Date(Date.now() - 60_000).toISOString() };
  m.post.mockRejectedValue(new Error("LinkedIn 500"));
  await expect(settleLinkedinBoundCampaign("t", "bound")).rejects.toThrow("LinkedIn 500");
  expect(m.rpc).toHaveBeenCalledWith("t", "ads_wallet_settle_bound", { p_campaign_binding_id: "bound", p_spend_cents: 1201 });
  expect(m.rpc).not.toHaveBeenCalledWith("t", "ads_observe_linkedin_spend", expect.anything());
});
it("pauses through the local cool-down and read cache, and the confirming read sees the live PAUSED status", async () => {
  campaign.status = "ACTIVE";
  const stale = JSON.parse(JSON.stringify(campaign));
  m.resolve.mockImplementation(async (_t: string, _b: unknown, _write = false, _refuse = false, pauseCritical = false) => {
    if (!pauseCritical) throw new Error("LinkedIn Ads token is cooling down");
    return { token: "bound-secret", account: { id: "42", currency: "USD" } };
  });
  m.get.mockImplementation(async (_token: string, path: string, _p?: unknown, _q?: unknown, opts?: { pauseCritical?: boolean }) =>
    path === "adAnalytics" ? report : opts?.pauseCritical ? campaign : stale,
  );
  expect(await pauseLinkedinBoundCampaign("t", "bound")).toBe("paused");
  expect(m.post).toHaveBeenCalledTimes(1);
  expect(campaign.status).toBe("PAUSED");
  expect(m.updates).toContainEqual(expect.objectContaining({ stop_confirmed_at: expect.any(String) }));
  const campaignReads = m.get.mock.calls.filter((c) => c[1] !== "adAnalytics");
  expect(campaignReads).toHaveLength(2);
  for (const call of campaignReads) expect(call[4]).toEqual({ pauseCritical: true });
});
it("keeps ordinary spend reads on the cached, rate-limited path", async () => {
  await linkedinLifetimeSpend("t", "bound");
  expect(m.resolve).toHaveBeenCalledWith("t", expect.anything(), false, false, false, false);
  for (const call of m.get.mock.calls) expect(call[4] ?? {}).not.toHaveProperty("pauseCritical");
});
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
it("settles a campaign whose Zavi stop LinkedIn already confirmed without re-reading the account, roles and campaign for a second pause", async () => {
  m.rows.ads_campaign_lifecycle = { created_paused: true, stop_requested_at: hoursAgo(5), stop_confirmed_at: hoursAgo(4) };
  m.rpc.mockResolvedValue({ data: false, error: null });
  await settleLinkedinBoundCampaign("t", "bound");
  expect(m.resolve).toHaveBeenCalledTimes(1);
  expect(m.get.mock.calls.map((c) => c[1])).toEqual([expect.stringMatching(/adCampaigns\/123$/), "adAnalytics"]);
  expect(m.post).not.toHaveBeenCalled();
  expect(m.rpc).toHaveBeenCalledWith("t", "ads_observe_linkedin_spend", { p_campaign_binding_id: "bound", p_spend_cents: 1201, p_ended: true });
});
it("still pauses a confirmed-stopped campaign that LinkedIn shows running again", async () => {
  campaign.status = "ACTIVE";
  m.rows.ads_campaign_lifecycle = { created_paused: true, stop_requested_at: hoursAgo(5), stop_confirmed_at: hoursAgo(4) };
  m.rpc.mockResolvedValue({ data: false, error: null });
  await settleLinkedinBoundCampaign("t", "bound");
  expect(m.post).toHaveBeenCalledTimes(1);
  expect(m.post).toHaveBeenCalledWith("bound-secret", expect.any(String), "PARTIAL_UPDATE", { patch: { $set: { status: "PAUSED" } } });
  expect(m.updates).toContainEqual(expect.objectContaining({ stop_confirmed_at: expect.any(String) }));
});
it.each([
  ["mid-launch: ACTIVE written, stop marker and claim not cleared yet", () => {
    m.rows.ads_campaign_operations = { id: "launch-1", status: "pending", created_at: new Date().toISOString() };
  }],
  ["just after the launch finished: stop marker cleared and claim succeeded", () => {
    (m.rows.ads_campaign_lifecycle as Record<string, unknown>).stop_requested_at = null;
  }],
])("a relaunch that makes the campaign ACTIVE while a settle tick is reading it is never re-paused (%s)", async (_label, relaunch) => {
  const stop = hoursAgo(5);
  m.rows.ads_campaign_lifecycle = { created_paused: true, stop_requested_at: stop, stop_confirmed_at: hoursAgo(4) };
  m.rpc.mockResolvedValue({ data: false, error: null });
  let relaunched = false;
  m.get.mockImplementation(async (_token: string, path: string) => {
    if (path === "adAnalytics") return report;
    if (!relaunched) {
      relaunched = true;
      campaign.status = "ACTIVE";
      relaunch();
    }
    return campaign;
  });
  await settleLinkedinBoundCampaign("t", "bound");
  expect(relaunched).toBe(true);
  expect(m.post).not.toHaveBeenCalled();
  expect(campaign.status).toBe("ACTIVE");
  expect(m.updates).not.toContainEqual(expect.objectContaining({ stop_confirmed_at: expect.any(String) }));
  expect(m.rpc).toHaveBeenCalledWith("t", "ads_observe_linkedin_spend", { p_campaign_binding_id: "bound", p_spend_cents: 1201, p_ended: false });
});
it("an unclaimed ACTIVE campaign whose Zavi stop still stands is re-paused, even with an old refused launch on record", async () => {
  m.rows.ads_campaign_lifecycle = { created_paused: true, stop_requested_at: hoursAgo(5), stop_confirmed_at: hoursAgo(4) };
  m.rpc.mockResolvedValue({ data: false, error: null });
  let reads = 0;
  m.get.mockImplementation(async (_token: string, path: string) => {
    if (path === "adAnalytics") return report;
    if (reads++ === 0) campaign.status = "ACTIVE";
    return campaign;
  });
  await settleLinkedinBoundCampaign("t", "bound");
  expect(m.post).toHaveBeenCalledWith("bound-secret", expect.any(String), "PARTIAL_UPDATE", { patch: { $set: { status: "PAUSED" } } });
});
it("still pauses a stop that is not confirmed yet, even on a settled campaign", async () => {
  campaign.status = "ACTIVE";
  m.rows.ads_campaign_lifecycle = { created_paused: true, stop_requested_at: hoursAgo(1), stop_confirmed_at: hoursAgo(80) };
  m.rows.ads_campaign_reservations = { reserved_cents: 0 };
  m.rows.ads_campaign_spend_stability = { stable_since: hoursAgo(80), ended_since: hoursAgo(80), last_observed_at: hoursAgo(0.1) };
  m.rpc.mockResolvedValue({ data: false, error: null });
  await settleLinkedinBoundCampaign("t", "bound");
  expect(m.post).toHaveBeenCalledWith("bound-secret", expect.any(String), "PARTIAL_UPDATE", { patch: { $set: { status: "PAUSED" } } });
});
it("asks LinkedIn nothing for a finalized campaign observed within the hour, and asks again once the hour passes", async () => {
  m.rows.ads_campaign_lifecycle = { created_paused: true, stop_requested_at: hoursAgo(90), stop_confirmed_at: hoursAgo(89) };
  m.rows.ads_campaign_reservations = { reserved_cents: 0 };
  m.rows.ads_campaign_spend_stability = { stable_since: hoursAgo(80), ended_since: hoursAgo(80), last_observed_at: hoursAgo(0.2) };
  m.rpc.mockResolvedValue({ data: true, error: null });
  await settleLinkedinBoundCampaign("t", "bound");
  expect(m.resolve).not.toHaveBeenCalled();
  expect(m.get).not.toHaveBeenCalled();
  expect(m.rpc).not.toHaveBeenCalled();
  m.rows.ads_campaign_spend_stability = { stable_since: hoursAgo(80), ended_since: hoursAgo(80), last_observed_at: hoursAgo(1.1) };
  await settleLinkedinBoundCampaign("t", "bound");
  expect(m.get.mock.calls.map((c) => c[1])).toContain("adAnalytics");
  expect(m.rpc).toHaveBeenCalledWith("t", "ads_wallet_settle_bound", { p_campaign_binding_id: "bound", p_spend_cents: 1201 });
});
it.each([
  ["it still holds money", { reserved_cents: 1 }, { stable_since: hoursAgo(80), ended_since: hoursAgo(80), last_observed_at: hoursAgo(0.2) }],
  ["it ended under 72 hours ago", { reserved_cents: 0 }, { stable_since: hoursAgo(80), ended_since: hoursAgo(71), last_observed_at: hoursAgo(0.2) }],
  ["its spend moved under 72 hours ago", { reserved_cents: 0 }, { stable_since: hoursAgo(71), ended_since: hoursAgo(80), last_observed_at: hoursAgo(0.2) }],
  ["it never ended", { reserved_cents: 0 }, { stable_since: hoursAgo(80), ended_since: null, last_observed_at: hoursAgo(0.2) }],
  ["its stability is unknown", { reserved_cents: 0 }, null],
])("keeps the five-minute LinkedIn read for a campaign when %s", async (_label, reservation, stability) => {
  m.rows.ads_campaign_reservations = reservation;
  m.rows.ads_campaign_spend_stability = stability;
  m.rpc.mockResolvedValue({ data: false, error: null });
  await settleLinkedinBoundCampaign("t", "bound");
  expect(m.get.mock.calls.map((c) => c[1])).toContain("adAnalytics");
  expect(m.rpc).toHaveBeenCalledWith("t", "ads_wallet_settle_bound", { p_campaign_binding_id: "bound", p_spend_cents: 1201 });
});

const refillReady = {
  available_cents: -500,
  balance_cents: 9500,
  reserved_cents: 10000,
  threshold_cents: 10000,
  refill_cents: 2000,
  auto_refill_enabled: true,
  pending: false,
  last_error: null,
  funding_enabled: true,
};
const pauseNotices = () => m.alert.mock.calls.flatMap((c) => c[2] as Array<{ id: string; what: string; notify_now?: boolean; who: string }>);
it("must-catch: a campaign the tick pauses because its hold no longer covers its budget tells the founder once, with the reason and what to do", async () => {
  campaign.status = "ACTIVE";
  m.rows.ads_campaign_reservations = { reserved_cents: 100 };
  await settleLinkedinBoundCampaign("t", "bound");
  expect(campaign.status).toBe("PAUSED");
  expect(pauseNotices()).toEqual([
    expect.objectContaining({
      id: "linkedin_wallet_pause:bound:hold_short",
      who: "you",
      notify_now: true,
      what: expect.stringMatching(/^Zavi paused your LinkedIn campaign "Bound campaign" because the money set aside for it in your ads wallet no longer covers its total budget\. Add funds/),
    }),
  ]);
  await settleLinkedinBoundCampaign("t", "bound");
  await settleLinkedinBoundCampaign("t", "bound");
  expect(m.alert).toHaveBeenCalledTimes(1);
});
it("an overdrawn wallet with no refill coming pauses the campaign and names the empty wallet as the reason", async () => {
  campaign.status = "ACTIVE";
  m.wallet.mockResolvedValue({ ...refillReady, auto_refill_enabled: false });
  await settleLinkedinBoundCampaign("t", "bound");
  expect(campaign.status).toBe("PAUSED");
  expect(pauseNotices().map((b) => b.id)).toEqual(["linkedin_wallet_pause:bound:overdrawn"]);
  expect(pauseNotices()[0].what).toMatch(/ads wallet ran out of money/);
});
it("a campaign with no end date is paused and the founder is told that is why", async () => {
  campaign.status = "ACTIVE";
  delete campaign.runSchedule.end;
  await settleLinkedinBoundCampaign("t", "bound");
  expect(campaign.status).toBe("PAUSED");
  expect(pauseNotices().map((b) => b.id)).toEqual(["linkedin_wallet_pause:bound:no_limit"]);
});
it("no notice when the protective pause did not go through", async () => {
  campaign.status = "ACTIVE";
  m.rows.ads_campaign_reservations = { reserved_cents: 100 };
  m.post.mockRejectedValue(new Error("timeout"));
  await expect(settleLinkedinBoundCampaign("t", "bound")).rejects.toThrow();
  expect(m.alert).not.toHaveBeenCalled();
});
it("must-catch: a fully held campaign is not paused for an overdraft that this tick's auto-refill covers, so it is not left paused once the refill lands", async () => {
  campaign.status = "ACTIVE";
  m.wallet.mockResolvedValue(refillReady);
  await settleLinkedinBoundCampaign("t", "bound");
  expect(m.post).not.toHaveBeenCalled();
  expect(campaign.status).toBe("ACTIVE");
  expect(m.updates).not.toEqual(expect.arrayContaining([expect.objectContaining({ stop_requested_at: expect.anything() })]));
  expect(m.alert).not.toHaveBeenCalled();
  m.wallet.mockResolvedValue({ ...refillReady, pending: true, balance_cents: 10500 });
  await settleLinkedinBoundCampaign("t", "bound");
  expect(campaign.status).toBe("ACTIVE");
});
it.each([
  ["the refill is smaller than the overdraft", { wallet: { refill_cents: 400 } }],
  ["auto-refill is off", { wallet: { auto_refill_enabled: false } }],
  ["the daily refill limit or another refill problem is on record", { wallet: { last_error: "The $1,000 daily auto-refill limit has been reached." } }],
  ["ads funding is switched off", { wallet: { funding_enabled: false } }],
  ["no card is saved", { row: { payment_method_id: null } }],
  ["refills are paused for this workspace", { eligibility: "paused" }],
  ["the refill check itself fails", { eligibility: new Error("down") }],
])("still pauses an overdrawn wallet campaign when %s", async (_label, c: { wallet?: Record<string, unknown>; row?: Record<string, unknown>; eligibility?: unknown }) => {
  campaign.status = "ACTIVE";
  m.wallet.mockResolvedValue({ ...refillReady, ...c.wallet });
  if (c.row) m.walletRow.mockResolvedValue(c.row);
  if (c.eligibility instanceof Error) m.eligibility.mockRejectedValue(c.eligibility);
  else if (c.eligibility) m.eligibility.mockResolvedValue(c.eligibility);
  await settleLinkedinBoundCampaign("t", "bound");
  expect(campaign.status).toBe("PAUSED");
  expect(pauseNotices().map((b) => b.id)).toEqual(["linkedin_wallet_pause:bound:overdrawn"]);
});
it("must-catch: a balance above the refill threshold does not pause when the held money leaves the free balance below it, because the refill fires on the free balance", async () => {
  campaign.status = "ACTIVE";
  m.wallet.mockResolvedValue({ ...refillReady, balance_cents: 10000, reserved_cents: 10500, available_cents: -500, threshold_cents: 5000 });
  await settleLinkedinBoundCampaign("t", "bound");
  expect(m.post).not.toHaveBeenCalled();
  expect(campaign.status).toBe("ACTIVE");
  expect(m.alert).not.toHaveBeenCalled();
});
it("a pending refill never excuses a hold that no longer covers the campaign's budget", async () => {
  campaign.status = "ACTIVE";
  m.rows.ads_campaign_reservations = { reserved_cents: 100 };
  m.wallet.mockResolvedValue({ ...refillReady, pending: true });
  await settleLinkedinBoundCampaign("t", "bound");
  expect(campaign.status).toBe("PAUSED");
});
it("must-catch: a founder's pause that hits a Zavi-side LinkedIn login fault says the pause did not go through and is being retried, never that there is nothing to do", async () => {
  campaign.status = "ACTIVE";
  m.resolve.mockRejectedValue(
    new ExpectedToolError("linkedin_ads_zavi_fault", "LinkedIn Ads could not be read because of a problem on Zavi's side. Your connection is fine and there is nothing for you to do. Zavi will try again."),
  );
  const e = await requestLinkedinPause("t", "bound").then(() => null, (x: unknown) => x as ExpectedToolError);
  expect(e?.code).toBe("ads_pause_queued");
  expect(e?.message).toBe(LINKEDIN_PAUSE_ZAVI_FAULT);
  expect(e?.message).toMatch(/could not pause this campaign yet.*can keep spending.*saved your pause request and keeps retrying.*LinkedIn Campaign Manager/);
  expect(e?.message).not.toMatch(/nothing for you to do/);
  expect(m.rows.ads_campaign_lifecycle).toMatchObject({ stop_requested_at: expect.any(String) });
  expect(m.post).not.toHaveBeenCalled();
});
