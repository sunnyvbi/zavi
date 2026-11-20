
import { describe, it, expect, vi, beforeEach } from "vitest";
const armStop = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => (_a[2] ? { ok: true as boolean, line: "Runs $48/day until Nov 3, planned about $480. Zavi pauses it if spend gets there." as string | null, why: "" } : { ok: true as boolean, line: null as string | null, why: "" })));
vi.mock("@/services/growth/channel-stopped", () => ({ readChannelStopped: async () => false }));
vi.mock("@/services/growth/test-stops", async (orig) => ({ ...(await orig<typeof import("@/services/growth/test-stops")>()), armCreatedTestStop: async (...a: unknown[]) => (await armStop(...a)) ?? (a[2] ? { ok: true, line: "Runs $48/day until Nov 3, planned about $480. Zavi pauses it if spend gets there." } : { ok: true, line: null }) }));
const testEndMock = vi.hoisted(() => ({ end: null as null | { decision_id: string; channel: string | null; ends_on: string } }));
vi.mock("@/services/growth/cgo-test-end", async (orig) => ({
  ...(await orig<typeof import("@/services/growth/cgo-test-end")>()),
  cgoTestEndForRun: vi.fn(async () => testEndMock.end),
}));
import { overProjectionGate } from "@/services/decisions/ad-budget";

const mocks = vi.hoisted(() => ({
  getBudgetMock: vi.fn(),
  updateBudgetMock: vi.fn(),
  setStatusMock: vi.fn(),
  capReaderMock: vi.fn(),
  guardFactsMock: vi.fn(),
  createCampaignMock: vi.fn(),
  getAdGroupMock: vi.fn(),
  setAdGroupStatusMock: vi.fn(),
  getCampaignMock: vi.fn(),
  getCampaignEndMock: vi.fn(),
  founderEnvelope: vi.fn(async (..._a: unknown[]): Promise<"none" | "valid" | "invalid"> => "none"),
}));
vi.mock("@/services/approvals/envelope-door", async (orig) => ({
  ...(await orig<typeof import("@/services/approvals/envelope-door")>()),
  founderEnvelopeVerdict: (...a: unknown[]) => mocks.founderEnvelope(...a),
}));

import { makeAdBudgetFake } from "./_ad-budget-fake";
import { ExpectedToolError } from "@/services/tools/types";
let fake = makeAdBudgetFake(null);
vi.mock("@/services/growth/unattended-policy", async (orig) => ({
  ...(await orig<typeof import("@/services/growth/unattended-policy")>()),
  authorizeUnattended: vi.fn(async () => ({ verdict: "allow", reasons: [] })),
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    rpc: (n: string, a: Record<string, unknown>) => fake.rpc(n, a),
    from: () => ({ update: () => { const c = { eq: () => c, select: async () => ({ data: [{ id: "row" }], error: null }) }; return c; } }),
  }),
}));
vi.mock("@/services/settings", () => ({ getBoolSettingStrictResolved: async () => true }));
vi.mock("@/services/auth/tenant-role", () => ({ loadTenantRoleFor: vi.fn(async () => "owner") }));

vi.mock("../../client", () => ({ inngest: { createFunction: () => ({}) } }));

vi.mock("@/services/decisions/auto-fire-rate-cap", () => ({ checkAutoFireRateCap: vi.fn() }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(), LOG_META_KEYS: [] }));
vi.mock("@/services/decisions/atomic-claim", () => ({ claimDecision: vi.fn(), markDispatched: vi.fn(), releaseClaim: vi.fn() }));
vi.mock("@/services/decisions/waiver-resolve", () => ({ resolveWaiverState: vi.fn(async () => ({ state: "none" })) }));
vi.mock("@/services/agents/log-decision-not-taken", () => ({ logDecisionNotTaken: vi.fn(async () => {}) }));
vi.mock("@/services/memory/stamp-outcome", () => ({ stampOutcomeForDecisionId: vi.fn(async () => {}) }));
vi.mock("@/services/mcp/execute", () => ({ callMcpTool: vi.fn() }));
vi.mock("@/agents/engineer/output-schema", () => ({ prProposalSchema: { safeParse: () => ({ success: false, error: { issues: [] } }) } }));
vi.mock("@/services/agents/registry", () => ({ loadAgentDefinition: vi.fn() }));
vi.mock("@/services/mcp/internal/jira", () => ({ jiraCreateIssue: vi.fn(), jiraAddComment: vi.fn() }));
vi.mock("@/services/mcp/internal/linear", () => ({ linearCreateIssue: vi.fn(), linearAddComment: vi.fn() }));
vi.mock("../digest-post-handler", () => ({ digestPostHandler: vi.fn() }));
vi.mock("@/services/agents/fleet-halt", () => ({ isFleetHalted: vi.fn(async () => false) }));
vi.mock("../dispatch-notice", () => ({
  buildDispatchNotice: vi.fn(),
  buildOpenPrNotice: vi.fn(),
  extractChatThreadId: vi.fn(),
  HANDLER_LABELS: {},
}));

vi.mock("@/services/tools/google-ads/_client", () => ({
  gadsGetCampaignBudget: mocks.getBudgetMock,
  gadsGetBudgetGuardFacts: mocks.guardFactsMock,
  gadsGetAdGroup: mocks.getAdGroupMock,
  gadsGetCampaign: mocks.getCampaignMock,
  gadsGetCampaignEnd: mocks.getCampaignEndMock,
  gadsSearch: vi.fn(),
  gadsMutate: vi.fn(),
}));
const readback = vi.hoisted(() => ({ ask: vi.fn(async (_a: { tenant_id: string; topic: string; ask: string }) => true) }));
vi.mock("@/services/growth/open-advice", async (orig) => ({
  ...(await orig<typeof import("@/services/growth/open-advice")>()),
  askFounderOutsideReview: readback.ask,
}));
vi.mock("@/services/tools/google-ads/write/update_campaign_budget", () => ({
  googleUpdateCampaignBudget: mocks.updateBudgetMock,
}));
vi.mock("@/services/tools/google-ads/write/set_status", () => ({
  googleSetCampaignStatus: mocks.setStatusMock,
  googleSetAdGroupStatus: mocks.setAdGroupStatusMock,
}));
vi.mock("@/services/tools/google-ads/write/create_campaign", () => ({
  googleCreateCampaign: mocks.createCampaignMock,
}));
vi.mock("@/services/tools/google-ads/write/cap-reader", () => ({
  readTenantGoogleCapAndToday: mocks.capReaderMock,
}));

import { __testOnly_handlers as HANDLERS } from "../dispatch-decision";

const GENEROUS_CAP = {
  enabled: true,
  max_daily_budget_usd: 100_000,
  max_pct_change_per_run: null,
  max_daily_total_change_usd: null,
};

function budgetRow(body: Record<string, unknown>) {
  return {
    id: "dec-1",
    tenant_id: "tenant-1",
    agent_run_id: "run-1",
    decision_class: "google_ads.update_campaign_budget",
    status: "approved",
    handler: null,
    body,
  };
}
function statusRow(body: Record<string, unknown>) {
  return {
    id: "dec-2",
    tenant_id: "tenant-1",
    agent_run_id: "run-1",
    decision_class: "google_ads.set_status",
    status: "approved",
    handler: null,
    body,
  };
}

beforeEach(() => {
  Object.values(mocks).forEach((m) => (m as ReturnType<typeof vi.fn>).mockReset());
  testEndMock.end = null;
  fake = makeAdBudgetFake(null);
  mocks.guardFactsMock.mockResolvedValue({ currency_code: "USD", budget_period: "DAILY" });
  mocks.createCampaignMock.mockResolvedValue({
    campaign_id: "555",
    campaign_resource: "customers/9/campaigns/555",
    budget_resource: "customers/9/campaignBudgets/556",
    ad_group_id: null,
    ad_group_resource: null,
    created_resources: 2,
  });
  mocks.getBudgetMock.mockResolvedValue({
    campaign_resource: "customers/9/campaigns/111",
    campaign_status: "ENABLED",
    budget_resource: "customers/9/campaignBudgets/222",
    amount_micros: 50_000_000,
  });
  mocks.updateBudgetMock.mockResolvedValue({ resource_name: "customers/9/campaignBudgets/222", amount_micros: 55_000_000 });
  mocks.setStatusMock.mockResolvedValue({ resource_name: "customers/9/campaigns/111", status: "PAUSED" });
  mocks.capReaderMock.mockResolvedValue({ cap: GENEROUS_CAP, today_total_change_usd: 0 });
});

describe("google_ads.update_campaign_budget — dispatch handler", () => {
  it("must catch: the budget reads back different from what was set: the change stands and the founder is asked once", async () => {
    readback.ask.mockClear();
    mocks.getBudgetMock
      .mockResolvedValueOnce({ campaign_resource: "customers/9/campaigns/111", campaign_status: "ENABLED", budget_resource: "customers/9/campaignBudgets/222", amount_micros: 50_000_000 })
      .mockResolvedValueOnce({ campaign_resource: "customers/9/campaigns/111", campaign_status: "ENABLED", budget_resource: "customers/9/campaignBudgets/222", amount_micros: 52_000_000 });
    const r = await HANDLERS["google_ads.update_campaign_budget"](budgetRow({ campaign_id: "111", daily_budget_usd: 55, expected_current_daily_budget_usd: 50, rationale: "graduated scale", over_cap: false }));
    expect(r.ok).toBe(true);
    expect(readback.ask).toHaveBeenCalledTimes(1);
    expect(readback.ask.mock.calls[0]![0]).toMatchObject({ topic: "budget_readback:google:111" });
  });

  it("must not catch: the budget reads back as set: no question", async () => {
    readback.ask.mockClear();
    mocks.getBudgetMock
      .mockResolvedValueOnce({ campaign_resource: "customers/9/campaigns/111", campaign_status: "ENABLED", budget_resource: "customers/9/campaignBudgets/222", amount_micros: 50_000_000 })
      .mockResolvedValueOnce({ campaign_resource: "customers/9/campaigns/111", campaign_status: "ENABLED", budget_resource: "customers/9/campaignBudgets/222", amount_micros: 55_000_000 });
    const r = await HANDLERS["google_ads.update_campaign_budget"](budgetRow({ campaign_id: "111", daily_budget_usd: 55, expected_current_daily_budget_usd: 50, rationale: "graduated scale", over_cap: false }));
    expect(r.ok).toBe(true);
    expect(readback.ask).not.toHaveBeenCalled();
  });

  it("drift + cap pass → calls the Google write API", async () => {
    const r = await HANDLERS["google_ads.update_campaign_budget"](
      budgetRow({
        campaign_id: "111",
        daily_budget_usd: 55,
        expected_current_daily_budget_usd: 50,
        rationale: "graduated scale",
        over_cap: false,
      }),
    );
    expect(r.ok).toBe(true);
    expect(mocks.updateBudgetMock).toHaveBeenCalledTimes(1);
    expect(mocks.updateBudgetMock.mock.calls[0][1]).toMatchObject({
      budget_resource: "customers/9/campaignBudgets/222",
      daily_budget_usd: 55,
    });
  });

  it("budget DRIFT (expected != live) → REFUSES, NO write", async () => {
    const r = await HANDLERS["google_ads.update_campaign_budget"](
      budgetRow({
        campaign_id: "111",
        daily_budget_usd: 55,
        expected_current_daily_budget_usd: 40,
        rationale: "stale baseline",
        over_cap: false,
      }),
    );
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("google_ads_budget_drift");
    expect(mocks.updateBudgetMock).not.toHaveBeenCalled();
  });

  it("over cap → REFUSES, NO write (drift guard ran, cap recheck rejects)", async () => {
    mocks.capReaderMock.mockResolvedValue({
      cap: { enabled: true, max_daily_budget_usd: 50, max_pct_change_per_run: null, max_daily_total_change_usd: null },
      today_total_change_usd: 0,
    });
    const r = await HANDLERS["google_ads.update_campaign_budget"](
      budgetRow({
        campaign_id: "111",
        daily_budget_usd: 80,
        expected_current_daily_budget_usd: 50,
        rationale: "too big",
        over_cap: false,
      }),
    );
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("cap_refuse");
    expect(mocks.updateBudgetMock).not.toHaveBeenCalled();
  });

  it("no cap configured (null) → REFUSES (safe default)", async () => {
    mocks.capReaderMock.mockResolvedValue({ cap: null, today_total_change_usd: 0 });
    const r = await HANDLERS["google_ads.update_campaign_budget"](
      budgetRow({
        campaign_id: "111",
        daily_budget_usd: 55,
        expected_current_daily_budget_usd: 50,
        rationale: "no opt-in",
        over_cap: false,
      }),
    );
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("no_cap_configured");
    expect(mocks.updateBudgetMock).not.toHaveBeenCalled();
  });

  it("the _review class shares the same handler", () => {
    expect(HANDLERS["google_ads.update_campaign_budget_review"]).toBeTypeOf("function");
  });
});

describe("google_ads.set_status — dispatch handler", () => {
  it("PAUSE flips status without a cap recheck", async () => {
    const r = await HANDLERS["google_ads.set_status"](
      statusRow({ campaign_id: "111", status: "PAUSED", rationale: "kill the loser", over_cap: false }),
    );
    expect(r.ok).toBe(true);
    expect(mocks.setStatusMock).toHaveBeenCalledTimes(1);
    expect(mocks.setStatusMock.mock.calls[0][1]).toMatchObject({ status: "PAUSED" });
    expect(mocks.capReaderMock).not.toHaveBeenCalled();
  });

  it("ENABLED (resume) rechecks the cap before flipping", async () => {
    const r = await HANDLERS["google_ads.set_status"](
      statusRow({ campaign_id: "111", status: "ENABLED", rationale: "resume winner", over_cap: true }),
    );
    expect(r.ok).toBe(true);
    expect(mocks.capReaderMock).toHaveBeenCalledTimes(1);
    expect(mocks.setStatusMock).toHaveBeenCalledTimes(1);
    expect(mocks.setStatusMock.mock.calls[0][1]).toMatchObject({ status: "ENABLED" });
  });

  it("ENABLED resume over cap → REFUSES, no status flip", async () => {
    mocks.capReaderMock.mockResolvedValue({
      cap: { enabled: true, max_daily_budget_usd: 10, max_pct_change_per_run: null, max_daily_total_change_usd: null },
      today_total_change_usd: 0,
    });
    const r = await HANDLERS["google_ads.set_status"](
      statusRow({ campaign_id: "111", status: "ENABLED", rationale: "resume $50 line over $10 cap", over_cap: true }),
    );
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("cap_refuse");
    expect(mocks.setStatusMock).not.toHaveBeenCalled();
  });
});

describe("ad budget holds on Google spend writes (money path)", () => {
  const createRow = (id: string) => ({
    ...budgetRow({
      name: "Spring promo",
      channel_type: "SEARCH",
      daily_budget_usd: 20,
      bidding: { strategy: "MANUAL_CPC" },
      rationale: "",
    }),
    id,
    decision_class: "google_ads.create_campaign",
  });
  const raise = (id: string, to: number, from = 50) => ({
    ...budgetRow({ campaign_id: "111", daily_budget_usd: to, expected_current_daily_budget_usd: from, rationale: "", over_cap: false }),
    id,
  });

  it("T13: no budget, the raise runs exactly as before and only asks the budget once", async () => {
    const r = await HANDLERS["google_ads.update_campaign_budget"](raise("d0", 55));
    expect(r.ok).toBe(true);
    expect(mocks.updateBudgetMock).toHaveBeenCalledTimes(1);
    expect(fake.namesCalled()).toEqual(["reserve_ad_spend"]);
    expect(mocks.guardFactsMock).toHaveBeenCalledTimes(1);
    expect(mocks.guardFactsMock).toHaveBeenCalledWith("tenant-1", null);
  });

  it("T9: a Google create and a Google raise draw on the same budget", async () => {
    fake = makeAdBudgetFake({ cap: 1000, days: 10, margin: 1.25 });
    const c = await HANDLERS["google_ads.create_campaign"](createRow("create-1"));
    expect(c.ok).toBe(true);
    expect(mocks.createCampaignMock.mock.calls[0][1].name).toBe("Zavi · Spring promo");
    expect(mocks.createCampaignMock.mock.calls[0]).toHaveLength(2);
    expect(fake.res.get("create-1:create")).toMatchObject({ status: "committed", object_id: "555", amount: 250 });
    expect(fake.res.get("create-1:create")!.ref).toMatchObject({ kind: "google_campaign_name" });
    expect((fake.res.get("create-1:create")!.ref as { name: string }).name).toMatch(/^Zavi · /);

    const r = await HANDLERS["google_ads.update_campaign_budget"](raise("raise-1", 55));
    expect(r.ok).toBe(true);
    expect(fake.res.get("raise-1:raise")).toMatchObject({ status: "committed", object_id: "111", amount: 62.5 });
    expect(fake.budget!.held).toBe(312.5);
    const reserveArgs = fake.calls.find((x) => x.args.p_idem_key === "raise-1:raise")!.args;
    expect(reserveArgs).toMatchObject({ p_platform: "google", p_op: "raise", p_daily_delta_usd: 5, p_tenant_id: "tenant-1" });
    expect(reserveArgs).not.toHaveProperty("p_amount_usd");
  });

  it("a raise on a campaign the budget never held reserves only the increase, and fits where the whole rate would not", async () => {
    fake = makeAdBudgetFake({ cap: 700, days: 10, margin: 1.25 });
    expect((await HANDLERS["google_ads.update_campaign_budget"](raise("r1", 101))).ok).toBe(true);
    expect(fake.res.get("r1:raise")).toMatchObject({ status: "committed", delta: 51, amount: 637.5 });
    expect(fake.budget!.held).toBe(637.5);
  });

  it("a cut lowers the campaign's hold by the cut: +$50 held, cut by $20 holds $30; a raise to $90 holds only +$10; a retry does not double", async () => {
    fake = makeAdBudgetFake({ cap: 100000, days: 10, margin: 1.25 });
    const live = (usd: number) =>
      mocks.getBudgetMock.mockResolvedValueOnce({
        campaign_resource: "customers/9/campaigns/111",
        campaign_status: "ENABLED",
        budget_resource: "customers/9/campaignBudgets/222",
        amount_micros: usd * 1_000_000,
      });
    live(50);
    expect((await HANDLERS["google_ads.update_campaign_budget"](raise("g100", 100, 50))).ok).toBe(true);
    expect(fake.heldDaily("google", "111")).toBe(50);

    live(100);
    expect((await HANDLERS["google_ads.update_campaign_budget"](raise("g80", 80, 100))).ok).toBe(true);
    expect(fake.calls.at(-1)).toMatchObject({
      name: "rebase_ad_spend_for_object",
      args: { p_platform: "google", p_object_id: "111", p_new_daily_usd: 80, p_idem_key: "g80:rebase", p_cut_usd: 20 },
    });
    expect(fake.heldDaily("google", "111")).toBe(30);

    live(100);
    expect((await HANDLERS["google_ads.update_campaign_budget"](raise("g80", 80, 100))).ok).toBe(true);
    expect(fake.heldDaily("google", "111")).toBe(30);

    live(80);
    expect((await HANDLERS["google_ads.update_campaign_budget"](raise("g90", 90, 80))).ok).toBe(true);
    expect(fake.res.get("g90:raise")).toMatchObject({ status: "committed", delta: 10, amount: 125 });
    expect(fake.heldDaily("google", "111")).toBe(40);
  });

  it("T2: a raise past the total is refused and Google is never called", async () => {
    fake = makeAdBudgetFake({ cap: 50, days: 10 });
    const r = await HANDLERS["google_ads.update_campaign_budget"](raise("big", 60));
    expect(r.ok).toBe(false);
    expect(String(r.error)).toBe("cap_refuse: ad_budget_over_month");
    expect(mocks.updateBudgetMock).not.toHaveBeenCalled();
  });

  it("T4: a definite 4xx from Google gives the hold back", async () => {
    fake = makeAdBudgetFake({ cap: 1000 });
    mocks.updateBudgetMock.mockRejectedValue(
      new ExpectedToolError("google_ads_mutate_failed", "Google Ads campaignBudgets:mutate failed: 400 bad amount"),
    );
    const r = await HANDLERS["google_ads.update_campaign_budget"](raise("r4xx", 55));
    expect(r.ok).toBe(false);
    expect(fake.res.get("r4xx:raise")!.status).toBe("released");
    expect(fake.budget!.held).toBe(0);
  });

  it("T4: a 5xx or a timeout keeps the hold (the change may have landed)", async () => {
    fake = makeAdBudgetFake({ cap: 1000 });
    mocks.updateBudgetMock.mockRejectedValue(
      new ExpectedToolError("google_ads_mutate_failed", "Google Ads campaignBudgets:mutate failed: 503 unavailable"),
    );
    await HANDLERS["google_ads.update_campaign_budget"](raise("r5xx", 55));
    mocks.updateBudgetMock.mockRejectedValue(new ExpectedToolError("google_ads_timeout", "timed out"));
    await HANDLERS["google_ads.update_campaign_budget"](raise("rto", 55));
    expect(fake.res.get("r5xx:raise")!.status).toBe("reserved");
    expect(fake.res.get("rto:raise")!.status).toBe("reserved");
    expect(fake.budget!.held).toBe(125);
  });

  it("a campaign resume holds its live budget; a campaign pause gives back the days after today (T7, T14)", async () => {
    fake = makeAdBudgetFake({ cap: 1000, days: 10 });
    const on = await HANDLERS["google_ads.set_status"]({
      ...statusRow({ campaign_id: "111", status: "ENABLED", rationale: "", over_cap: true }),
      id: "on-1",
    });
    expect(on.ok).toBe(true);
    expect(fake.budget!.held).toBe(625);
    const off = await HANDLERS["google_ads.set_status"]({
      ...statusRow({ campaign_id: "111", status: "PAUSED", rationale: "", over_cap: false }),
      id: "off-1",
    });
    expect(off.ok).toBe(true);
    expect(fake.budget!.held).toBe(62.5);
    expect(fake.namesCalled()).toContain("release_ad_spend_for_object");
  });

  it("refuses a non-USD account before any hold, and a non-daily campaign budget giving the hold back", async () => {
    fake = makeAdBudgetFake({ cap: 1000 });
    mocks.guardFactsMock.mockResolvedValue({ currency_code: "EUR", budget_period: "DAILY" });
    const eur = await HANDLERS["google_ads.update_campaign_budget"](raise("eur", 55));
    expect(eur).toMatchObject({ ok: false, code: "google_ads_non_usd_account" });
    expect(fake.namesCalled()).toEqual([]);
    expect(mocks.getBudgetMock).not.toHaveBeenCalled();
    mocks.guardFactsMock.mockResolvedValue({ currency_code: "USD", budget_period: "CUSTOM_PERIOD" });
    const total = await HANDLERS["google_ads.update_campaign_budget"](raise("custom", 55));
    expect(total.error).toBe("cap_refuse: ad_budget_non_daily_budget");
    expect(mocks.updateBudgetMock).not.toHaveBeenCalled();
    expect(fake.budget!.held).toBe(0);
  });

  it("an RPC error refuses the action (fail closed), even for a human approval", async () => {
    fake = makeAdBudgetFake({ cap: 1000 });
    fake.failRpc("connection reset");
    const r = await HANDLERS["google_ads.create_campaign"]({ ...createRow("c-err"), approved_by: "user-1" });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/^cap_refuse: ad_budget_unavailable/);
    expect(mocks.createCampaignMock).not.toHaveBeenCalled();
  });
});

describe("a CGO ad-group enable holds its campaign's budget", () => {
  const OWNER = "owner-1";
  const agRow = (id: string, source: string | null) => ({
    ...statusRow({ campaign_id: "111", level: "ad_group", ad_group_id: "333", status: "ENABLED", rationale: "", over_cap: false }),
    id,
    approved_by: OWNER,
    approved_by_source: source,
  });
  beforeEach(() => {
    mocks.getAdGroupMock.mockResolvedValue({ campaign_id: "111", ad_group_resource: "customers/9/adGroups/g1" });
    mocks.setAdGroupStatusMock.mockResolvedValue({});
    mocks.capReaderMock.mockResolvedValue({ cap: null, today_total_change_usd: 0, cap_row_absent: true });
  });

  it("cgo, budget on, no caps row: the campaign's $50/day is held, then the ad group is enabled", async () => {
    fake = makeAdBudgetFake({ cap: 1000, days: 10 });
    const r = await HANDLERS["google_ads.set_status"](agRow("ag-1", "cgo"));
    expect(r.ok).toBe(true);
    expect(mocks.setAdGroupStatusMock).toHaveBeenCalledTimes(1);
    expect(fake.res.get("ag-1:resume")).toMatchObject({ object_id: "111", status: "committed", amount: 625 });
  });

  it("cgo over the budget: refused, the ad group is never enabled", async () => {
    fake = makeAdBudgetFake({ cap: 100, days: 10 });
    const r = await HANDLERS["google_ads.set_status"](agRow("ag-2", "cgo"));
    expect(r.error).toBe("cap_refuse: ad_budget_over_month");
    expect(mocks.setAdGroupStatusMock).not.toHaveBeenCalled();
  });

  it("an ad group from another campaign: refused and the hold given back", async () => {
    fake = makeAdBudgetFake({ cap: 1000, days: 10 });
    mocks.getAdGroupMock.mockResolvedValue({ campaign_id: "999", ad_group_resource: "x" });
    const r = await HANDLERS["google_ads.set_status"](agRow("ag-3", "cgo"));
    expect(String(r.error)).toMatch(/google_ads_target_mismatch/);
    expect(fake.budget!.held).toBe(0);
  });

  it("an ad group that cannot be read (deleted since): refused and the hold given back", async () => {
    fake = makeAdBudgetFake({ cap: 1000, days: 10 });
    mocks.getAdGroupMock.mockRejectedValue(new Error("google_ads_ad_group_not_found"));
    const r = await HANDLERS["google_ads.set_status"](agRow("ag-5", "cgo"));
    expect(r.ok).toBe(false);
    expect(mocks.setAdGroupStatusMock).not.toHaveBeenCalled();
    expect(fake.budget!.held).toBe(0);
  });

  it("a founder's own ad-group enable holds the campaign's budget too (a person's click counts)", async () => {
    fake = makeAdBudgetFake({ cap: 1000, days: 10 });
    const r = await HANDLERS["google_ads.set_status"](agRow("ag-4", null));
    expect(r.ok).toBe(true);
    expect(fake.res.get("ag-4:resume")).toMatchObject({ object_id: "111", status: "committed", amount: 625 });
  });

  it("a founder's ad-group enable over the budget: refused, the ad group is never enabled", async () => {
    fake = makeAdBudgetFake({ cap: 100, days: 10 });
    const r = await HANDLERS["google_ads.set_status"](agRow("ag-6", null));
    expect(r.error).toBe("cap_refuse: ad_budget_over_month");
    expect(mocks.setAdGroupStatusMock).not.toHaveBeenCalled();
  });
});

describe("the channel-action rail hits the same ad budget hook", () => {
  const deps = (payload: Record<string, unknown>) => ({
    claim: async () => ({
      ok: true as const,
      row: {
        claim_id: "claim-1",
        tenant_id: "tenant-1",
        channel_slug: "google_ads",
        exec_class: "google_ads.update_campaign_budget",
        exec_payload: payload,
        approved_by: "founder-1",
        approved_by_source: null,
        agent_run_id: "run-1",
      },
    }),
    writeEnabled: async () => true,
    channelLock: async () => null,
  });
  const payload = { campaign_id: "111", daily_budget_usd: 60, expected_current_daily_budget_usd: 50, rationale: "", over_cap: false };

  it("a founder-approved channel action is held under the action id", async () => {
    const { runChannelActionMutation } = await import("../dispatch-channel-action");
    fake = makeAdBudgetFake({ cap: 1000, days: 10 });
    const res = await runChannelActionMutation("act-1", deps(payload));
    expect(res.settle).toMatchObject({ ok: true });
    expect(mocks.updateBudgetMock).toHaveBeenCalledTimes(1);
    expect(fake.res.get("act-1:raise")).toMatchObject({ status: "committed", amount: 125 });
  });

  it("over the limit, the channel action is refused and Google is never called", async () => {
    const { runChannelActionMutation } = await import("../dispatch-channel-action");
    fake = makeAdBudgetFake({ cap: 100, days: 10 });
    const res = await runChannelActionMutation("act-2", deps(payload));
    expect(res.settle).toMatchObject({ ok: false, error: "cap_refuse: ad_budget_over_month" });
    expect(mocks.updateBudgetMock).not.toHaveBeenCalled();
  });
});

describe("S7: prior state of reversible Google changes", () => {
  it("a campaign pause records the status and daily budget it had", async () => {
    const r = await HANDLERS["google_ads.set_status"](statusRow({ campaign_id: "111", status: "PAUSED", over_cap: false, name: "Search" }));
    expect(r.ok).toBe(true);
    expect(fake.adChanges).toEqual([
      expect.objectContaining({
        platform: "google",
        object_id: "111",
        level: "campaign",
        action_table: "decisions",
        action_id: "dec-2",
        change_kind: "status",
        before_status: "ENABLED",
        after_status: "PAUSED",
        before_daily_usd: 50,
      }),
    ]);
  });

  it("a budget change records the live budget it replaced", async () => {
    const r = await HANDLERS["google_ads.update_campaign_budget"](
      budgetRow({ campaign_id: "111", daily_budget_usd: 35, expected_current_daily_budget_usd: 50, rationale: "", over_cap: false }),
    );
    expect(r.ok).toBe(true);
    expect(fake.adChanges).toEqual([expect.objectContaining({ change_kind: "budget", before_daily_usd: 50, after_daily_usd: 35, object_id: "111" })]);
  });
});

describe("S7: Undo status drift (Google)", () => {
  it("an undo whose campaign is no longer in the state Zavi left it is refused before any hold or write", async () => {
    const r = await HANDLERS["google_ads.set_status_review"]({
      ...statusRow({ campaign_id: "111", level: "campaign", status: "ENABLED", expected_current_status: "PAUSED", over_cap: true }),
      decision_class: "google_ads.set_status_review",
      approved_by: "user-1",
    } as never);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^google_ads_status_drift/);
    expect(mocks.setStatusMock).not.toHaveBeenCalled();
    expect(fake.namesCalled()).toEqual([]);
  });
});

describe("a change to a VIDEO campaign is refused at execution", () => {
  const VIDEO_LIVE = {
    campaign_resource: "customers/9/campaigns/111",
    campaign_status: "ENABLED",
    channel_type: "VIDEO",
    budget_resource: "customers/9/campaignBudgets/222",
    amount_micros: 50_000_000,
  };
  const REFUSAL = {
    ok: false,
    code: "google_ads_video_mutate_unsupported",
    error: "Google's Ads API cannot change VIDEO campaigns, so Zavi did not apply this. Nothing in the account changed.",
  };

  it("update_campaign_budget", async () => {
    mocks.getBudgetMock.mockResolvedValue(VIDEO_LIVE);
    const r = await HANDLERS["google_ads.update_campaign_budget"](
      budgetRow({ campaign_id: "111", daily_budget_usd: 55, expected_current_daily_budget_usd: 50, rationale: "r", over_cap: false }),
    );
    expect(r).toEqual(REFUSAL);
    expect(mocks.capReaderMock).not.toHaveBeenCalled();
    expect(mocks.updateBudgetMock).not.toHaveBeenCalled();
  });

  it("set_status (an enable would otherwise take a hold first)", async () => {
    mocks.getBudgetMock.mockResolvedValue(VIDEO_LIVE);
    const r = await HANDLERS["google_ads.set_status"](statusRow({ campaign_id: "111", status: "ENABLED", over_cap: false }));
    expect(r).toEqual(REFUSAL);
    expect(mocks.capReaderMock).not.toHaveBeenCalled();
    expect(mocks.setStatusMock).not.toHaveBeenCalled();
  });

  it("a SEARCH or DEMAND_GEN campaign is not refused", async () => {
    mocks.getBudgetMock.mockResolvedValue({ ...VIDEO_LIVE, channel_type: "DEMAND_GEN", campaign_status: "ENABLED" });
    const r = await HANDLERS["google_ads.set_status"](statusRow({ campaign_id: "111", status: "PAUSED", over_cap: false }));
    expect(r.ok).toBe(true);
    expect(mocks.setStatusMock).toHaveBeenCalledTimes(1);
  });
});

describe("google_ads.create_campaign: a founder's envelope-approved direct ask is switched on", () => {
  const row = (id: string, over: Record<string, unknown> = {}) => ({
    ...budgetRow({ name: "Founder ask", channel_type: "SEARCH", daily_budget_usd: 10, end_date: "2026-12-01", location_ids: [2840], bidding: { strategy: "MANUAL_CPC" }, rationale: "" }),
    id,
    decision_class: "google_ads.create_campaign",
    approved_by: "owner-1",
    approved_by_source: null,
    exec_source: "channel_actions",
    ...over,
  });
  beforeEach(() => {
    mocks.founderEnvelope.mockReset();
    mocks.getCampaignMock.mockReset();
    mocks.setStatusMock.mockResolvedValue({ resource_name: "customers/9/campaigns/555", status: "ENABLED" });
  });
  it("enabled after the PAUSED create, and the notice says it is on", async () => {
    mocks.founderEnvelope.mockResolvedValue("valid");
    mocks.getCampaignMock.mockResolvedValueOnce({ status: "PAUSED" }).mockResolvedValueOnce({ status: "ENABLED" });
    const r = await HANDLERS["google_ads.create_campaign"](row("fa-1") as never);
    expect(r.ok, String(r.error)).toBe(true);
    expect(mocks.setStatusMock).toHaveBeenCalledWith("tenant-1", { campaign_resource: "customers/9/campaigns/555", status: "ENABLED" });
    expect(r.notice).toContain("Switched on, as you asked.");
    expect(r.notice).not.toContain("PAUSED");
    expect(mocks.founderEnvelope.mock.calls[0][1]).toBe("google_ads");
  });
  it("the enable fails: partial, never success, with the campaign id and why it is paused", async () => {
    mocks.founderEnvelope.mockResolvedValue("valid");
    mocks.getCampaignMock.mockResolvedValue({ status: "PAUSED" });
    mocks.setStatusMock.mockRejectedValue(new Error("PERMISSION_DENIED"));
    const r = await HANDLERS["google_ads.create_campaign"](row("fa-4") as never);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("exec_partial");
    expect(String(r.error)).toContain("555");
    expect(String(r.error)).toMatch(/still PAUSED/);
    expect(String(r.error)).toContain("PERMISSION_DENIED");
    expect(r.created).toMatchObject({ platform: "google", id: "555", status: "PAUSED" });
    expect(mocks.createCampaignMock).toHaveBeenCalledTimes(1);
  });
  it("an envelope approval that no longer holds (role revoked): refused BEFORE any Google call", async () => {
    mocks.founderEnvelope.mockResolvedValue("invalid");
    const r = await HANDLERS["google_ads.create_campaign"](row("fa-3") as never);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("envelope_invalid");
    expect(mocks.createCampaignMock).not.toHaveBeenCalled();
    expect(mocks.setStatusMock).not.toHaveBeenCalled();
    expect(fake.namesCalled()).toEqual([]);
  });
  it("no valid founder envelope: it stays PAUSED and the notice says so", async () => {
    mocks.founderEnvelope.mockResolvedValue("none");
    mocks.getCampaignMock.mockResolvedValue({ status: "PAUSED" });
    const r = await HANDLERS["google_ads.create_campaign"](row("fa-2") as never);
    expect(r.ok).toBe(true);
    expect(mocks.setStatusMock).not.toHaveBeenCalled();
    expect(r.notice).toContain("PAUSED");
  });
});

beforeEach(() => {
  vi.spyOn(overProjectionGate, "read").mockResolvedValue(null);
});

describe("google_ads.create_campaign: a cgo test's campaign carries the test's end", () => {
  const row = (id: string, body: Record<string, unknown> = {}) => ({
    ...budgetRow({ name: "Test search", channel_type: "SEARCH", daily_budget_usd: 48, location_ids: [2840], bidding: { strategy: "MANUAL_CPC" }, rationale: "", ...body }),
    id,
    decision_class: "google_ads.create_campaign",
    approved_by: null,
    approved_by_source: "cgo",
  });
  beforeEach(() => {
    testEndMock.end = { decision_id: "order-1", channel: "google_ads", ends_on: "2026-11-03" };
    fake = makeAdBudgetFake({ cap: 10_000, days: 10 });
    mocks.setStatusMock.mockResolvedValue({ resource_name: "customers/9/campaigns/555", status: "ENABLED" });
  });

  it("writes the test's end day as the exclusive end date and switches on once Google reads it back", async () => {
    mocks.getCampaignMock.mockResolvedValueOnce({ status: "PAUSED" }).mockResolvedValueOnce({ status: "ENABLED" });
    mocks.getCampaignEndMock.mockResolvedValue({ end_date_time: "2026-11-02 23:59:59" });
    const r = await HANDLERS["google_ads.create_campaign"](row("t-1") as never);
    expect(r.ok, String(r.error)).toBe(true);
    expect(mocks.createCampaignMock.mock.calls[0][1]).toMatchObject({ end_date: "2026-11-03" });
    expect(mocks.getCampaignEndMock).toHaveBeenCalledWith("tenant-1", "555");
    expect(mocks.setStatusMock).toHaveBeenCalledWith("tenant-1", { campaign_resource: "customers/9/campaigns/555", status: "ENABLED" });
    expect(armStop).toHaveBeenCalledWith("tenant-1", "t-1", expect.objectContaining({ ends_on: "2026-11-03" }), expect.objectContaining({ platform: "google", object_id: "555", billing_scope: "object", daily_usd: 48 }));
    expect(r.notice).toMatch(/Zavi pauses it if spend gets there/);
  });

  it("a stop that cannot be armed keeps the new campaign PAUSED and partial", async () => {
    armStop.mockResolvedValueOnce({ ok: false, line: "", why: "refused" });
    mocks.getCampaignMock.mockResolvedValue({ status: "PAUSED" });
    mocks.getCampaignEndMock.mockResolvedValue({ end_date_time: "2026-11-02 23:59:59" });
    const r = await HANDLERS["google_ads.create_campaign"](row("t-1") as never);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("exec_partial");
    expect(r.error).toMatch(/could not set up the pause/);
    expect(mocks.setStatusMock).not.toHaveBeenCalledWith("tenant-1", expect.objectContaining({ status: "ENABLED" }));
  });

  it("a stop that cannot be armed on a campaign Google shows ACTIVE: Zavi pauses it and says so", async () => {
    armStop.mockResolvedValueOnce({ ok: false, line: "", why: "refused" });
    mocks.getCampaignMock.mockResolvedValueOnce({ status: "ENABLED" }).mockResolvedValueOnce({ status: "PAUSED" });
    mocks.getCampaignEndMock.mockResolvedValue({ end_date_time: "2026-11-02 23:59:59" });
    const r = await HANDLERS["google_ads.create_campaign"](row("t-1") as never);
    expect(r).toMatchObject({ ok: false, code: "exec_partial" });
    expect(r.error).toMatch(/so Zavi paused it/);
    expect(mocks.setStatusMock).toHaveBeenCalledWith("tenant-1", expect.objectContaining({ status: "PAUSED" }));
  });

  it("a card's own sooner end is kept; a later one is cut to the test's end", async () => {
    mocks.getCampaignMock.mockResolvedValue({ status: "PAUSED" });
    mocks.getCampaignEndMock.mockResolvedValue({ end_date_time: "2026-10-30 23:59:59" });
    await HANDLERS["google_ads.create_campaign"](row("t-2", { end_date: "2026-10-31" }) as never);
    expect(mocks.createCampaignMock.mock.calls[0][1]).toMatchObject({ end_date: "2026-10-31" });
    mocks.createCampaignMock.mockClear();
    await HANDLERS["google_ads.create_campaign"](row("t-3", { end_date: "2026-12-31" }) as never);
    expect(mocks.createCampaignMock.mock.calls[0][1]).toMatchObject({ end_date: "2026-11-03" });
  });

  it("Google shows no end, a different end, or cannot be read: it stays PAUSED, partial, and is never switched on", async () => {
    for (const read of [() => mocks.getCampaignEndMock.mockResolvedValue({ end_date_time: null }), () => mocks.getCampaignEndMock.mockResolvedValue({ end_date_time: "2037-12-30 23:59:59" }), () => mocks.getCampaignEndMock.mockRejectedValue(new Error("INTERNAL"))]) {
      mocks.setStatusMock.mockClear();
      mocks.getCampaignMock.mockResolvedValue({ status: "PAUSED" });
      read();
      const r = await HANDLERS["google_ads.create_campaign"](row(`t-miss-${Math.random()}`) as never);
      expect(r.ok).toBe(false);
      expect(r.code).toBe("exec_partial");
      expect(String(r.error)).toMatch(/still PAUSED and not spending: Zavi could not confirm Google stored its end date \(it should stop after Nov 2\)/);
      expect(r.created).toMatchObject({ platform: "google", id: "555", status: "PAUSED" });
      expect(mocks.setStatusMock).not.toHaveBeenCalled();
    }
  });

  it("the test's end cannot be read: nothing is created", async () => {
    const { cgoTestEndForRun } = await import("@/services/growth/cgo-test-end");
    vi.mocked(cgoTestEndForRun).mockRejectedValueOnce(new Error("db down"));
    const r = await HANDLERS["google_ads.create_campaign"](row("t-err") as never);
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/could not read this test's end date, so nothing new was created/);
    expect(mocks.createCampaignMock).not.toHaveBeenCalled();
    expect(fake.namesCalled()).not.toContain("reserve_ad_spend");
  });

  it("Google shows the new test campaign live without its end: Zavi pauses its own campaign and says so", async () => {
    mocks.getCampaignMock.mockResolvedValueOnce({ status: "ENABLED" }).mockResolvedValueOnce({ status: "PAUSED" });
    mocks.getCampaignEndMock.mockResolvedValue({ end_date_time: null });
    mocks.setStatusMock.mockResolvedValue({ resource_name: "customers/9/campaigns/555", status: "PAUSED" });
    const r = await HANDLERS["google_ads.create_campaign"](row("t-live") as never);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("exec_partial");
    expect(mocks.setStatusMock).toHaveBeenCalledWith("tenant-1", { campaign_resource: "customers/9/campaigns/555", status: "PAUSED" });
    expect(String(r.error)).toMatch(/so Zavi paused it\. It is not spending/);
    expect(r.created).toMatchObject({ status: "PAUSED" });
  });

  it("a founder-approved test create stays paused and its notice names the day it stops", async () => {
    mocks.getCampaignMock.mockResolvedValue({ status: "PAUSED" });
    mocks.getCampaignEndMock.mockResolvedValue({ end_date_time: "2026-11-02 23:59:59" });
    const r = await HANDLERS["google_ads.create_campaign"]({ ...row("t-founder"), approved_by: "owner-1", approved_by_source: null } as never);
    expect(r.ok, String(r.error)).toBe(true);
    expect(mocks.setStatusMock).not.toHaveBeenCalled();
    expect(r.notice).toMatch(/It stops on its own after Nov 2, when the test ends\./);
  });

  it("not a test's run: no end date is added and the create runs as before", async () => {
    testEndMock.end = null;
    mocks.getCampaignMock.mockResolvedValueOnce({ status: "PAUSED" }).mockResolvedValueOnce({ status: "ENABLED" });
    const r = await HANDLERS["google_ads.create_campaign"](row("t-none") as never);
    expect(r.ok, String(r.error)).toBe(true);
    expect(mocks.createCampaignMock.mock.calls[0][1]).not.toHaveProperty("end_date");
    expect(mocks.getCampaignEndMock).not.toHaveBeenCalled();
  });
});
