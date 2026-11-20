
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  executeApprovedBrowserActionMock: vi.fn(),
  checkAutoFireRateCapMock: vi.fn(),
  logEventMock: vi.fn(),
  claimDecisionMock: vi.fn(),
  serviceClientMock: vi.fn(),
}));

vi.mock("../../client", () => ({ inngest: { createFunction: () => ({}) } }));

vi.mock("@/services/sandbox/browser-mcp/anchor-backend", () => ({
  executeApprovedBrowserAction: mocks.executeApprovedBrowserActionMock,
}));

vi.mock("@/services/decisions/auto-fire-rate-cap", () => ({
  checkAutoFireRateCap: mocks.checkAutoFireRateCapMock,
}));
vi.mock("@/services/logging/logEvent", () => ({
  logEvent: mocks.logEventMock,
  LOG_META_KEYS: [],
}));
vi.mock("@/services/decisions/atomic-claim", () => ({
  claimDecision: mocks.claimDecisionMock,
  markDispatched: vi.fn(),
  releaseClaim: vi.fn(),
}));
vi.mock("@/services/supabase", () => ({ serviceClient: mocks.serviceClientMock }));

vi.mock("@/services/decisions/waiver-resolve", () => ({
  resolveWaiverState: vi.fn(async () => ({ state: "none" })),
}));

vi.mock("@/services/agents/class-cap", () => ({
  consumeClassBudget: vi.fn(async () => "charged"),
}));

vi.mock("@/services/agents/log-decision-not-taken", () => ({ logDecisionNotTaken: vi.fn(async () => {}) }));

vi.mock("@/services/memory/stamp-outcome", () => ({ stampOutcomeForDecisionId: vi.fn(async () => {}) }));
vi.mock("@/services/mcp/execute", () => ({ callMcpTool: vi.fn() }));
vi.mock("@/agents/engineer/output-schema", () => ({ prProposalSchema: { safeParse: () => ({ success: false, error: { issues: [] } }) } }));
vi.mock("@/services/agents/registry", () => ({ loadAgentDefinition: vi.fn() }));
vi.mock("@/services/mcp/internal/jira", () => ({ jiraCreateIssue: vi.fn(), jiraAddComment: vi.fn() }));
vi.mock("@/services/mcp/internal/linear", () => ({ linearCreateIssue: vi.fn(), linearAddComment: vi.fn() }));
vi.mock("../digest-post-handler", () => ({ digestPostHandler: vi.fn() }));
vi.mock("@/services/agents/fleet-halt", () => ({ isFleetHalted: vi.fn(async () => false) }));
vi.mock("@/services/tools/meta-ads/write/_decision-bodies", () => ({ updateAdSetBudgetBodySchema: {}, setStatusBodySchema: {}, createAdSetBodySchema: {} }));
vi.mock("@/services/tools/meta-ads/write/update_ad_set_budget", () => ({ metaUpdateAdSetBudget: vi.fn() }));
vi.mock("@/services/tools/meta-ads/write/set_status", () => ({ metaSetStatus: vi.fn() }));
vi.mock("@/services/tools/meta-ads/write/create_ad_set", () => ({ metaCreateAdSet: vi.fn() }));
vi.mock("@/services/tools/meta-ads/_client", () => ({ fbGet: vi.fn(), getAdAccountCurrency: vi.fn() }));
vi.mock("@/services/tools/meta-ads/write/_helpers", () => ({ toBudgetMinorUnits: vi.fn() }));
vi.mock("@/services/tools/meta-ads/write/_drift-guard", () => ({ assertNoBudgetDrift: vi.fn() }));
vi.mock("@/services/tools/meta-ads/write/_cap-evaluator", async (importOriginal) => ({ ...(await importOriginal<object>()), evaluateBudgetCap: vi.fn() }));
vi.mock("@/services/tools/meta-ads/write/cap-reader", () => ({ readTenantCapAndToday: vi.fn() }));
vi.mock("../dispatch-notice", () => ({
  buildDispatchNotice: vi.fn(),
  buildOpenPrNotice: vi.fn(),
  extractChatThreadId: vi.fn(),
  HANDLER_LABELS: {},
}));

import { __testOnly_handlers as HANDLERS, autoCronDispatchBatch } from "../dispatch-decision";

const REAL_RUN_UUID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

beforeEach(() => {
  Object.values(mocks).forEach((m) => (m as ReturnType<typeof vi.fn>).mockReset());
  mocks.logEventMock.mockResolvedValue(undefined);
  mocks.claimDecisionMock.mockResolvedValue(null);
  mocks.serviceClientMock.mockReturnValue({
    from: () => ({
      update: () => ({ eq: () => ({ data: null, error: null }) }),
    }),
  });
});

describe("browser.action handler — retired with browser-operator (PR #3560)", () => {
  it.each([
    { op: "click", selector: "#approved-btn" },
    { op: "fill", selector: "#email", value: "x@y.z" },
    { op: "nav", url: "https://x.com" },
    {},
  ])("refuses %j without touching a browser", async (body) => {
    mocks.executeApprovedBrowserActionMock.mockResolvedValue({ ok: true });
    const h = HANDLERS["browser.action"];
    const res = await h({
      id: "decision-1",
      tenant_id: "t-1",
      agent_run_id: REAL_RUN_UUID,
      decision_class: "browser.action",
      body,
      status: "approved",
      handler: "browser.action",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("browser_actions_retired");
    expect(mocks.executeApprovedBrowserActionMock).not.toHaveBeenCalled();
  });
});

describe("autoCronDispatchBatch — Fix 2 layer 3 (browser.action NEVER auto-fires)", () => {
  it("refuses to auto-dispatch a browser.action row (the injected click Confirm refund never auto-fires)", async () => {
    mocks.checkAutoFireRateCapMock.mockResolvedValue({ allowed: true, count: 1, cap: 30 });
    const r = await autoCronDispatchBatch([
      { id: "d-browser-1", tenant_id: "t-1", decision_class: "browser.action" },
    ]);

    expect(r.acted).toBe(0);
    expect(mocks.claimDecisionMock).not.toHaveBeenCalled();
    expect(mocks.checkAutoFireRateCapMock).not.toHaveBeenCalled();
    expect(mocks.logEventMock).toHaveBeenCalledTimes(1);
    const logged = mocks.logEventMock.mock.calls[0][0];
    expect(logged.level).toBe("warn");
    expect(logged.code).toBe("never_auto_class_blocked");
    expect(logged.source).toBe("dispatch-auto-cron");
    expect(logged.meta.decision_class).toBe("browser.action");
  });

  it("mixed batch: a browser.action row is blocked, a normal auto row still dispatches", async () => {
    mocks.checkAutoFireRateCapMock.mockResolvedValue({ allowed: true, count: 1, cap: 30 });
    const r = await autoCronDispatchBatch([
      { id: "d-browser-1", tenant_id: "t-1", decision_class: "browser.action" },
      { id: "d-slack-1", tenant_id: "t-1", decision_class: "operator.post-slack-message" },
    ]);

    expect(mocks.claimDecisionMock).toHaveBeenCalledTimes(1);
    expect(mocks.claimDecisionMock).toHaveBeenCalledWith("d-slack-1");
    const neverAutoLogs = mocks.logEventMock.mock.calls.filter(
      (c) => c[0].code === "never_auto_class_blocked",
    );
    expect(neverAutoLogs).toHaveLength(1);
  });

  it.each([
    "meta_ads.update_ad_set_budget_review",
    "meta_ads.set_status_review",
  ])("refuses to auto-dispatch the %s review class (worker mirror of the DB never_auto clamp)", async (cls) => {
    mocks.checkAutoFireRateCapMock.mockResolvedValue({ allowed: true, count: 1, cap: 30 });
    const r = await autoCronDispatchBatch([
      { id: "d-ads-1", tenant_id: "t-1", decision_class: cls },
    ]);

    expect(r.acted).toBe(0);
    expect(mocks.claimDecisionMock).not.toHaveBeenCalled();
    expect(mocks.checkAutoFireRateCapMock).not.toHaveBeenCalled();
    expect(mocks.logEventMock).toHaveBeenCalledTimes(1);
    const logged = mocks.logEventMock.mock.calls[0][0];
    expect(logged.code).toBe("never_auto_class_blocked");
    expect(logged.meta.decision_class).toBe(cls);
  });
});
