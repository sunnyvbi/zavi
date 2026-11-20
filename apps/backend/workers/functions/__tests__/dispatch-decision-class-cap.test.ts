import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  checkAutoFireRateCapMock: vi.fn(),
  consumeClassBudgetMock: vi.fn(),
  logEventMock: vi.fn(),
  claimDecisionMock: vi.fn(),
  serviceClientMock: vi.fn(),
  logDecisionNotTakenMock: vi.fn(),
  resolveWaiverStateMock: vi.fn(),
}));

vi.mock("@/services/decisions/auto-fire-rate-cap", () => ({
  checkAutoFireRateCap: mocks.checkAutoFireRateCapMock,
}));
vi.mock("@/services/agents/class-cap", () => ({
  consumeClassBudget: mocks.consumeClassBudgetMock,
}));
vi.mock("@/services/decisions/waiver-resolve", () => ({
  resolveWaiverState: mocks.resolveWaiverStateMock,
}));
vi.mock("@/services/logging/logEvent", () => ({
  logEvent: mocks.logEventMock,
  LOG_META_KEYS: [],
}));
vi.mock("@/services/decisions/atomic-claim", () => ({
  claimDecision: mocks.claimDecisionMock,
}));
vi.mock("@/services/supabase", () => ({ serviceClient: mocks.serviceClientMock }));
vi.mock("@/services/agents/log-decision-not-taken", () => ({
  logDecisionNotTaken: mocks.logDecisionNotTakenMock,
}));
vi.mock("../../client", () => ({ inngest: { createFunction: () => ({}) } }));
vi.mock("@/services/memory/stamp-outcome", () => ({ stampOutcomeForDecisionId: vi.fn(() => Promise.resolve()) }));
vi.mock("@/services/mcp/execute", () => ({ callMcpTool: vi.fn() }));
vi.mock("@/agents/engineer/output-schema", () => ({ prProposalSchema: { safeParse: () => ({ success: false }) } }));
vi.mock("@/services/agents/registry", () => ({ loadAgentDefinition: vi.fn() }));
vi.mock("@/services/mcp/internal/jira", () => ({ jiraCreateIssue: vi.fn(), jiraAddComment: vi.fn() }));
vi.mock("@/services/mcp/internal/linear", () => ({ linearCreateIssue: vi.fn(), linearAddComment: vi.fn() }));
vi.mock("../digest-post-handler", () => ({ digestPostHandler: vi.fn() }));
vi.mock("@/services/tools/meta-ads/write/_decision-bodies", () => ({
  updateAdSetBudgetBodySchema: {}, setStatusBodySchema: {}, createAdSetBodySchema: {},
}));
vi.mock("@/services/tools/meta-ads/write/update_ad_set_budget", () => ({ metaUpdateAdSetBudget: vi.fn() }));
vi.mock("@/services/tools/meta-ads/write/set_status", () => ({ metaSetStatus: vi.fn() }));
vi.mock("@/services/tools/meta-ads/write/create_ad_set", () => ({ metaCreateAdSet: vi.fn() }));
vi.mock("@/services/tools/meta-ads/_client", () => ({ fbGet: vi.fn(), getAdAccountCurrency: vi.fn() }));
vi.mock("@/services/tools/meta-ads/write/_helpers", () => ({ toBudgetMinorUnits: vi.fn() }));
vi.mock("@/services/tools/meta-ads/write/_drift-guard", () => ({ assertNoBudgetDrift: vi.fn() }));
vi.mock("@/services/tools/meta-ads/write/_cap-evaluator", async (importOriginal) => ({ ...(await importOriginal<object>()), evaluateBudgetCap: vi.fn() }));
vi.mock("@/services/tools/meta-ads/write/cap-reader", () => ({ readTenantCapAndToday: vi.fn() }));

import { autoCronDispatchBatch, estimateUsdFromDecisionBody } from "../dispatch-decision";

beforeEach(() => {
  Object.values(mocks).forEach((m) => (m as ReturnType<typeof vi.fn>).mockReset());
  mocks.logEventMock.mockResolvedValue(undefined);
  mocks.logDecisionNotTakenMock.mockResolvedValue(true);
  mocks.resolveWaiverStateMock.mockResolvedValue({ state: "none" });
  mocks.claimDecisionMock.mockResolvedValue(null);
  mocks.checkAutoFireRateCapMock.mockResolvedValue({ allowed: true, count: 1, cap: 30 });
  mocks.consumeClassBudgetMock.mockResolvedValue("charged");
  mocks.serviceClientMock.mockReturnValue({
    from: () => ({
      update: () => ({ eq: () => ({ in: () => ({ select: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) }),
    }),
  });
});

const ROW = (i: number, body?: Record<string, unknown>) => ({
  id: `d-${i}`,
  tenant_id: "t-1",
  decision_class: "meta_ads.update_ad_set_budget",
  body: body ?? { daily_budget_usd: 80, expected_current_daily_budget_usd: 50 },
});

describe("autoCronDispatchBatch — per-class SPEND cap (SLICE P0.1)", () => {
  it("UNDER class spend cap → dispatches; reader called with the body-derived estimate", async () => {
    const r = await autoCronDispatchBatch([ROW(1)]);
    expect(r.rate_capped).toBe(0);
    expect(mocks.consumeClassBudgetMock).toHaveBeenCalledWith("t-1", "meta_ads.update_ad_set_budget", 30);
    expect(mocks.claimDecisionMock).toHaveBeenCalledTimes(1);
  });

  it("OVER class spend cap → does NOT dispatch, row left proposed, warn + counterfactual logged", async () => {
    mocks.consumeClassBudgetMock.mockResolvedValue("over_cap");
    const r = await autoCronDispatchBatch([ROW(1)]);
    expect(r.acted).toBe(0);
    expect(r.rate_capped).toBe(1);
    expect(mocks.claimDecisionMock).not.toHaveBeenCalled();
    expect(mocks.logEventMock).toHaveBeenCalledTimes(1);
    const logged = mocks.logEventMock.mock.calls[0][0];
    expect(logged.level).toBe("warn");
    expect(logged.code).toBe("class_spend_cap_over");
    expect(logged.source).toBe("dispatch-auto-cron");
    expect(mocks.logDecisionNotTakenMock).toHaveBeenCalledTimes(1);
    const cf = mocks.logDecisionNotTakenMock.mock.calls[0][0];
    expect(cf.rejection_type).toBe("cap_exceeded");
    expect(cf.reason_code).toBe("class_spend_cap_over");
    expect(cf.tenant_id).toBe("t-1");
  });

  it("rate-cap runs BEFORE the spend cap (over rate-cap → spend cap never consulted)", async () => {
    mocks.checkAutoFireRateCapMock.mockResolvedValue({
      allowed: false, count: 30, cap: 30, reason: "over_cap",
    });
    const r = await autoCronDispatchBatch([ROW(1)]);
    expect(r.rate_capped).toBe(1);
    expect(mocks.consumeClassBudgetMock).not.toHaveBeenCalled();
  });

  it("mixed batch: under-spend dispatches, over-spend withheld", async () => {
    mocks.consumeClassBudgetMock
      .mockResolvedValueOnce("charged")
      .mockResolvedValueOnce("over_cap");
    const r = await autoCronDispatchBatch([ROW(1), ROW(2)]);
    expect(r.rate_capped).toBe(1);
    expect(mocks.claimDecisionMock).toHaveBeenCalledTimes(1);
  });

  it("FAIL-SAFE: reader returns over_cap on RPC error → withheld (helper fails safe upstream)", async () => {
    mocks.consumeClassBudgetMock.mockResolvedValue("over_cap");
    const r = await autoCronDispatchBatch([ROW(1)]);
    expect(r.rate_capped).toBe(1);
    expect(mocks.claimDecisionMock).not.toHaveBeenCalled();
  });

  it("P1-6/P2 HARD-EXEMPT ABOVE ALL GATES: parked class enqueues even under an EXPIRED waiver + OVER rate-cap + over spend-cap", async () => {
    mocks.resolveWaiverStateMock.mockResolvedValue({ state: "expired" });
    mocks.checkAutoFireRateCapMock.mockResolvedValue({ allowed: false, count: 30, cap: 30, reason: "over_cap" });
    mocks.consumeClassBudgetMock.mockResolvedValue("over_cap");
    const pendingRow = {
      id: "d-pending",
      tenant_id: "t-1",
      decision_class: "perfmkt.create_ad_set_pending_strategist",
      body: { kind: "create_ad_set_pending_strategist", create_ad_set: { daily_budget_usd: 500 } },
    };
    const r = await autoCronDispatchBatch([pendingRow]);
    expect(mocks.resolveWaiverStateMock).not.toHaveBeenCalled();
    expect(mocks.checkAutoFireRateCapMock).not.toHaveBeenCalled();
    expect(mocks.consumeClassBudgetMock).not.toHaveBeenCalled();
    expect(mocks.claimDecisionMock).toHaveBeenCalledTimes(1);
    expect(r.rate_capped).toBe(0);
  });
});

describe("estimateUsdFromDecisionBody (SLICE P0.1)", () => {
  it("meta-ads budget change → |proposed - current|", () => {
    expect(estimateUsdFromDecisionBody({ daily_budget_usd: 80, expected_current_daily_budget_usd: 50 })).toBe(30);
    expect(estimateUsdFromDecisionBody({ daily_budget_usd: 30, expected_current_daily_budget_usd: 80 })).toBe(50);
  });
  it("proposed budget only (no prior) → |proposed|", () => {
    expect(estimateUsdFromDecisionBody({ daily_budget_usd: 25 })).toBe(25);
  });
  it("explicit estimate/cost/amount/spend field", () => {
    expect(estimateUsdFromDecisionBody({ estimate_usd: 12 })).toBe(12);
    expect(estimateUsdFromDecisionBody({ amount_usd: 7 })).toBe(7);
    expect(estimateUsdFromDecisionBody({ cost_usd: "4.5" })).toBe(4.5);
    expect(estimateUsdFromDecisionBody({ spend_usd: -9 })).toBe(9);
  });
  it("unknown / non-object / null body → 0 (no per-action trip; only daily can trip)", () => {
    expect(estimateUsdFromDecisionBody({ to: "x@y.com", subject: "hi" })).toBe(0);
    expect(estimateUsdFromDecisionBody(null)).toBe(0);
    expect(estimateUsdFromDecisionBody("nope")).toBe(0);
    expect(estimateUsdFromDecisionBody(undefined)).toBe(0);
  });
  it("non-finite numbers → 0", () => {
    expect(estimateUsdFromDecisionBody({ daily_budget_usd: "NaN" })).toBe(0);
    expect(estimateUsdFromDecisionBody({ estimate_usd: Infinity })).toBe(0);
  });
});
