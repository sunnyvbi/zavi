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
vi.mock("@/services/supabase", () => ({
  serviceClient: mocks.serviceClientMock,
}));
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

import { autoCronDispatchBatch } from "../dispatch-decision";

beforeEach(() => {
  Object.values(mocks).forEach((m) => (m as ReturnType<typeof vi.fn>).mockReset());
  mocks.logEventMock.mockResolvedValue(undefined);
  mocks.logDecisionNotTakenMock.mockResolvedValue(true);
  mocks.resolveWaiverStateMock.mockResolvedValue({ state: "none" });
  mocks.consumeClassBudgetMock.mockResolvedValue("charged");
  mocks.claimDecisionMock.mockResolvedValue(null);
  mocks.serviceClientMock.mockReturnValue({
    from: () => ({
      update: () => ({ eq: () => ({ in: () => ({ select: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) }),
    }),
  });
});

const ROW = (i: number) => ({
  id: `d-${i}`,
  tenant_id: "t-1",
  decision_class: "operator.post-slack-message",
});

describe("autoCronDispatchBatch — AUTO-fire rate cap", () => {
  it("UNDER cap → dispatches (claim attempted), no cap-event logged", async () => {
    mocks.checkAutoFireRateCapMock.mockResolvedValue({ allowed: true, count: 1, cap: 30 });
    const r = await autoCronDispatchBatch([ROW(1), ROW(2)]);
    expect(r.rate_capped).toBe(0);
    expect(mocks.claimDecisionMock).toHaveBeenCalledTimes(2);
    expect(mocks.logEventMock).not.toHaveBeenCalled();
  });

  it("OVER cap → does NOT dispatch (no claim), row left proposed, warn logged", async () => {
    mocks.checkAutoFireRateCapMock.mockResolvedValue({
      allowed: false, count: 30, cap: 30, reason: "over_cap",
    });
    const r = await autoCronDispatchBatch([ROW(1)]);
    expect(r.acted).toBe(0);
    expect(r.rate_capped).toBe(1);
    expect(mocks.claimDecisionMock).not.toHaveBeenCalled();
    expect(mocks.logEventMock).toHaveBeenCalledTimes(1);
    const logged = mocks.logEventMock.mock.calls[0][0];
    expect(logged.level).toBe("warn");
    expect(logged.code).toBe("auto_fire_rate_capped");
    expect(logged.source).toBe("dispatch-auto-cron");
    expect(mocks.logDecisionNotTakenMock).toHaveBeenCalledTimes(1);
    const cf = mocks.logDecisionNotTakenMock.mock.calls[0][0];
    expect(cf.rejection_type).toBe("cap_exceeded");
    expect(cf.reason_code).toBe("auto_fire_rate_capped");
    expect(cf.tenant_id).toBe("t-1");
  });

  it("NEVER-AUTO class → withheld + counterfactual condition_unmet", async () => {
    const r = await autoCronDispatchBatch([
      { id: "d-x", tenant_id: "t-1", decision_class: "browser.action" },
    ]);
    expect(r.rate_capped).toBe(1);
    expect(mocks.checkAutoFireRateCapMock).not.toHaveBeenCalled();
    expect(mocks.claimDecisionMock).not.toHaveBeenCalled();
    expect(mocks.logDecisionNotTakenMock).toHaveBeenCalledTimes(1);
    const cf = mocks.logDecisionNotTakenMock.mock.calls[0][0];
    expect(cf.rejection_type).toBe("condition_unmet");
    expect(cf.reason_code).toBe("never_auto_class_blocked");
  });

  it("count ERROR → FAIL CLOSED (no dispatch, count_error event)", async () => {
    mocks.checkAutoFireRateCapMock.mockResolvedValue({
      allowed: false, count: -1, cap: 30, reason: "count_error",
    });
    const r = await autoCronDispatchBatch([ROW(1)]);
    expect(r.rate_capped).toBe(1);
    expect(mocks.claimDecisionMock).not.toHaveBeenCalled();
    expect(mocks.logEventMock.mock.calls[0][0].code).toBe("auto_fire_rate_cap_count_error");
  });

  it("mixed batch: some under, some over → only under-cap rows dispatch", async () => {
    mocks.checkAutoFireRateCapMock
      .mockResolvedValueOnce({ allowed: true, count: 1, cap: 30 })
      .mockResolvedValueOnce({ allowed: false, count: 30, cap: 30, reason: "over_cap" })
      .mockResolvedValueOnce({ allowed: true, count: 2, cap: 30 });
    const r = await autoCronDispatchBatch([ROW(1), ROW(2), ROW(3)]);
    expect(r.rate_capped).toBe(1);
    expect(mocks.claimDecisionMock).toHaveBeenCalledTimes(2);
    expect(mocks.logEventMock).toHaveBeenCalledTimes(1);
  });

  it("empty batch → no-op", async () => {
    const r = await autoCronDispatchBatch([]);
    expect(r).toEqual({ acted: 0, rate_capped: 0 });
    expect(mocks.checkAutoFireRateCapMock).not.toHaveBeenCalled();
  });
});

describe("autoCronDispatchBatch — POLSIA-P3 dispatch-time waiver enforcement", () => {
  it("EXPIRED waiver → does NOT dispatch (no rate-cap check, no claim), row left proposed, warn logged", async () => {
    mocks.resolveWaiverStateMock.mockResolvedValue({
      state: "expired",
      expires_at: "2026-05-29T00:00:00Z",
    });
    const r = await autoCronDispatchBatch([
      { id: "d-1", tenant_id: "t-1", decision_class: "send_email" },
    ]);
    expect(r.acted).toBe(0);
    expect(r.rate_capped).toBe(1);
    expect(mocks.checkAutoFireRateCapMock).not.toHaveBeenCalled();
    expect(mocks.claimDecisionMock).not.toHaveBeenCalled();
    expect(mocks.logEventMock).toHaveBeenCalledTimes(1);
    const logged = mocks.logEventMock.mock.calls[0][0];
    expect(logged.level).toBe("warn");
    expect(logged.code).toBe("autopilot_waiver_expired_blocked");
    expect(logged.source).toBe("dispatch-auto-cron");
    expect(logged.tenant_id).toBe("t-1");
    expect(mocks.logDecisionNotTakenMock).toHaveBeenCalledTimes(1);
    const cf = mocks.logDecisionNotTakenMock.mock.calls[0][0];
    expect(cf.rejection_type).toBe("condition_unmet");
    expect(cf.reason_code).toBe("autopilot_waiver_expired_blocked");
  });

  it("ACTIVE waiver → falls through to rate-cap check (auto-fire path proceeds)", async () => {
    mocks.resolveWaiverStateMock.mockResolvedValue({
      state: "active",
      max_daily_usd: 25,
      cooling_off_seconds: 0,
      expires_at: "2099-01-01T00:00:00Z",
    });
    mocks.checkAutoFireRateCapMock.mockResolvedValue({ allowed: true, count: 1, cap: 30 });
    const r = await autoCronDispatchBatch([
      { id: "d-2", tenant_id: "t-1", decision_class: "send_email" },
    ]);
    expect(r.rate_capped).toBe(0);
    expect(mocks.checkAutoFireRateCapMock).toHaveBeenCalledTimes(1);
    expect(mocks.claimDecisionMock).toHaveBeenCalledTimes(1);
  });

  it("NONE waiver → status-quo (no waiver, no waiver-event)", async () => {
    mocks.resolveWaiverStateMock.mockResolvedValue({ state: "none" });
    mocks.checkAutoFireRateCapMock.mockResolvedValue({ allowed: true, count: 1, cap: 30 });
    const r = await autoCronDispatchBatch([
      { id: "d-3", tenant_id: "t-1", decision_class: "send_email" },
    ]);
    expect(r.rate_capped).toBe(0);
    expect(mocks.checkAutoFireRateCapMock).toHaveBeenCalledTimes(1);
    expect(mocks.claimDecisionMock).toHaveBeenCalledTimes(1);
    expect(
      mocks.logEventMock.mock.calls.find(
        (c) => c[0]?.code === "autopilot_waiver_expired_blocked",
      ),
    ).toBeUndefined();
  });

  it("NEVER-AUTO class → waiver lookup is skipped (never-auto guard fires first)", async () => {
    const r = await autoCronDispatchBatch([
      { id: "d-x", tenant_id: "t-1", decision_class: "browser.action" },
    ]);
    expect(r.rate_capped).toBe(1);
    expect(mocks.resolveWaiverStateMock).not.toHaveBeenCalled();
  });
});
