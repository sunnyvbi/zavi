
import { describe, it, expect, vi, beforeEach } from "vitest";

const claimDecisionMock = vi.fn();
const isFleetHaltedMock = vi.fn(async () => false);
const enqueueAgentRun = vi.fn();
const getVisibleAgentSlugs = vi.fn();

const decisionsUpdates: Array<Record<string, unknown>> = [];
const settle = { failWith: null as null | { message: string } };

const execApproved = vi.fn();
const resumeAfterDecision = vi.fn();
vi.mock("@/services/agents/approve-resume-dispatch", () => ({
  resumeAfterDecision: (...a: unknown[]) => resumeAfterDecision(...a),
}));
vi.mock("@/services/connectors/composio/execute-approved", () => ({
  executeApprovedComposioWrite: (...a: unknown[]) => execApproved(...a),
}));
vi.mock("@/services/agents/runner", () => ({
  enqueueAgentRun: (...a: unknown[]) => enqueueAgentRun(...a),
}));
vi.mock("@/services/agents/visibility", () => ({
  getVisibleAgentSlugs: (...a: unknown[]) => getVisibleAgentSlugs(...a),
}));
vi.mock("../../client", () => ({ inngest: { createFunction: () => ({}) } }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      if (table === "decisions") {
        return {
          update: (payload: Record<string, unknown>) => {
            decisionsUpdates.push(payload);
            const isSettle = "status" in payload && "dispatched_at" in payload;
            const error = isSettle ? settle.failWith : null;
            return { eq: () => Promise.resolve({ data: null, error }) };
          },
        };
      }
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
            maybeSingle: async () => ({ data: null, error: null }),
          }),
        }),
      };
    },
  }),
}));
vi.mock("@/services/memory/stamp-outcome", () => ({ stampOutcomeForDecisionId: vi.fn(async () => {}) }));
vi.mock("@/services/mcp/execute", () => ({ callMcpTool: vi.fn() }));
vi.mock("@/agents/engineer/output-schema", () => ({ prProposalSchema: { safeParse: () => ({ success: false, error: { issues: [] } }) } }));
vi.mock("@/services/agents/registry", () => ({ loadAgentDefinition: vi.fn() }));
vi.mock("@/services/mcp/internal/jira", () => ({ jiraCreateIssue: vi.fn(), jiraAddComment: vi.fn() }));
vi.mock("@/services/mcp/internal/linear", () => ({ linearCreateIssue: vi.fn(), linearAddComment: vi.fn() }));
vi.mock("../digest-post-handler", () => ({ digestPostHandler: vi.fn() }));
vi.mock("@/services/decisions/atomic-claim", () => ({
  claimDecision: (id: string) => claimDecisionMock(id),
  releaseClaim: vi.fn(),
  markDispatched: vi.fn(),
}));
vi.mock("@/services/decisions/auto-fire-rate-cap", () => ({ checkAutoFireRateCap: vi.fn() }));
vi.mock("@/services/agents/fleet-halt", () => ({ isFleetHalted: () => isFleetHaltedMock() }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(), LOG_META_KEYS: [] }));
vi.mock("@/services/tools/meta-ads/write/_decision-bodies", () => ({ updateAdSetBudgetBodySchema: {}, setStatusBodySchema: {}, createAdSetBodySchema: {} }));
vi.mock("@/services/tools/meta-ads/write/update_ad_set_budget", () => ({ metaUpdateAdSetBudget: vi.fn() }));
vi.mock("@/services/tools/meta-ads/write/set_status", () => ({ metaSetStatus: vi.fn() }));
vi.mock("@/services/tools/meta-ads/write/create_ad_set", () => ({ metaCreateAdSet: vi.fn() }));
vi.mock("@/services/tools/meta-ads/_client", () => ({ fbGet: vi.fn(), getAdAccountCurrency: vi.fn() }));
vi.mock("@/services/tools/meta-ads/write/_helpers", () => ({ toBudgetMinorUnits: vi.fn() }));
vi.mock("@/services/tools/meta-ads/write/_drift-guard", () => ({ assertNoBudgetDrift: vi.fn() }));
vi.mock("@/services/tools/meta-ads/write/_cap-evaluator", async (importOriginal) => ({ ...(await importOriginal<object>()), evaluateBudgetCap: vi.fn() }));
vi.mock("@/services/tools/meta-ads/write/cap-reader", () => ({ readTenantCapAndToday: vi.fn() }));
vi.mock("@/services/tools/email/_client", () => ({ emailSend: vi.fn() }));
const platformWriteEnabledMock = vi.fn(async () => true);
vi.mock("@/services/channels/exec-kill-switch", () => ({
  platformWriteEnabled: () => platformWriteEnabledMock(),
  execPlatform: () => "google_ads",
  execPlatformLabel: () => "Google Ads",
}));
vi.mock("../dispatch-notice", () => ({
  buildDispatchNotice: vi.fn(),
  buildOpenPrNotice: vi.fn(),
  extractChatThreadId: vi.fn(() => null),
  extractSlackRouting: vi.fn(() => null),
  postDispatchNotice: vi.fn(),
  HANDLER_LABELS: {},
}));

import {
  __testOnly_executeDispatch as executeDispatch,
  DECISION_HANDLERS,
  resumeWhenRunEnds,
} from "../dispatch-decision";

const ROW = {
  id: "dec-c1",
  tenant_id: "TENANT_A",
  agent_run_id: null,
  decision_class: "composio.moves_money",
  body: { kind: "composio_write", tool_slug: "SQUARE_CREATE_REFUND", tenant_id: "TENANT_B" },
  status: "approved",
  handler: "composio.execute_tool",
  approved_by: "u1",
  approved_by_source: null,
};
const settleWrites = () => decisionsUpdates.filter((u) => "status" in u && "dispatched_at" in u);

beforeEach(() => {
  decisionsUpdates.length = 0;
  settle.failWith = null;
  platformWriteEnabledMock.mockReset();
  platformWriteEnabledMock.mockResolvedValue(true);
  claimDecisionMock.mockReset();
  isFleetHaltedMock.mockReset();
  isFleetHaltedMock.mockResolvedValue(false);
  execApproved.mockReset();
});

describe("composio.execute_tool handler", () => {
  it("is registered and forwards the claimed row's id, tenant, class and approver (body tenant ignored)", async () => {
    expect(typeof DECISION_HANDLERS["composio.execute_tool"]).toBe("function");
    execApproved.mockResolvedValue({ ok: true, notice: "Done in Square." });
    claimDecisionMock.mockResolvedValueOnce(ROW);
    const res = await executeDispatch("dec-c1");
    expect(res.ok).toBe(true);
    expect(execApproved).toHaveBeenCalledWith({ id: "dec-c1", tenant_id: "TENANT_A", decision_class: "composio.moves_money", body: ROW.body, approved_by: "u1", approved_by_source: null });
    expect(settleWrites()[0].status).toBe("acted");
  });

  it("approved before the run finished: the result rides resume_pending for the wait-and-retry", async () => {
    execApproved.mockResolvedValue({ ok: true, notice: "Done in Mixpanel.", agent_outcome: 'Mixpanel returned: {"a":1}' });
    resumeAfterDecision.mockResolvedValueOnce({ resumed: false, reason: "still_running" });
    claimDecisionMock.mockResolvedValueOnce({ ...ROW, agent_run_id: "run_1" });
    const res = await executeDispatch("dec-c1");
    expect((resumeAfterDecision.mock.calls[0] as unknown[])[0]).toMatchObject({ outcome: 'Mixpanel returned: {"a":1}' });
    expect(res.resume_pending).toMatchObject({ agent_run_id: "run_1", outcome: 'Mixpanel returned: {"a":1}' });
  });

  it("approved, then dispatched after the chat run already ended: still resumes (allowFinished)", async () => {
    execApproved.mockResolvedValue({ ok: true, notice: "Done in Google Drive.", agent_outcome: "Google Drive returned: {}" });
    resumeAfterDecision.mockResolvedValueOnce({ resumed: true, reason: "resumed" });
    claimDecisionMock.mockResolvedValueOnce({ ...ROW, agent_run_id: "run_done" });
    const res = await executeDispatch("dec-c1");
    expect((resumeAfterDecision.mock.calls.at(-1) as unknown[])[0]).toMatchObject({ agent_run_id: "run_done", allowFinished: true });
    expect(res.resume_pending).toBeUndefined();
  });

  it("an auto-dispatched row (no approver) never resumes a finished chat as approved", async () => {
    execApproved.mockResolvedValue({ ok: true, notice: "Done." });
    resumeAfterDecision.mockResolvedValueOnce({ resumed: false, reason: "not_paused" });
    claimDecisionMock.mockResolvedValueOnce({ ...ROW, agent_run_id: "run_auto", approved_by: null });
    await executeDispatch("dec-c1");
    expect((resumeAfterDecision.mock.calls.at(-1) as unknown[])[0]).toMatchObject({ agent_run_id: "run_auto", allowFinished: false });
  });

  it("the wait-and-retry keeps the same rule: no approver, no finished-chat resume", async () => {
    execApproved.mockResolvedValue({ ok: true, notice: "Done." });
    resumeAfterDecision.mockResolvedValueOnce({ resumed: false, reason: "still_running" });
    claimDecisionMock.mockResolvedValueOnce({ ...ROW, agent_run_id: "run_live", approved_by: null });
    const res = await executeDispatch("dec-c1");
    expect(res.resume_pending).toMatchObject({ agent_run_id: "run_live", allowFinished: false });
    resumeAfterDecision.mockResolvedValueOnce({ resumed: false, reason: "not_paused" });
    await resumeWhenRunEnds(res.resume_pending!);
    expect((resumeAfterDecision.mock.calls.at(-1) as unknown[])[0]).toMatchObject({ agent_run_id: "run_live", allowFinished: false });
  });

  it("a handler failure settles dispatch_failed, never proposed (no automatic retry)", async () => {
    execApproved.mockResolvedValue({ ok: false, error: "Square refused: No such charge" });
    claimDecisionMock.mockResolvedValueOnce(ROW);
    const res = await executeDispatch("dec-c1");
    expect(res.ok).toBe(false);
    const writes = settleWrites();
    expect(writes).toHaveLength(1);
    expect(writes[0].status).toBe("dispatch_failed");
    expect(decisionsUpdates.some((u) => u.status === "proposed")).toBe(false);
  });

  it("a row already 'dispatching' (crashed mid-call) cannot be claimed again: nothing runs", async () => {
    claimDecisionMock.mockResolvedValueOnce(null);
    await executeDispatch("dec-c1");
    expect(execApproved).not.toHaveBeenCalled();
    expect(settleWrites()).toHaveLength(0);
  });

  it("an UNKNOWN outcome leaves the row 'dispatching' (no settle, no release) and logs a stable code", async () => {
    const { logEvent } = await import("@/services/logging/logEvent");
    const { releaseClaim } = await import("@/services/decisions/atomic-claim");
    vi.mocked(logEvent).mockClear();
    vi.mocked(releaseClaim).mockClear();
    execApproved.mockResolvedValue({ ok: false, outcome_unknown: true, error: "composio_outcome_unknown" });
    claimDecisionMock.mockResolvedValueOnce(ROW);
    const res = await executeDispatch("dec-c1");
    expect(res.ok).toBe(false);
    expect(settleWrites()).toHaveLength(0);
    expect(decisionsUpdates).toHaveLength(0);
    expect(releaseClaim).not.toHaveBeenCalled();
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ code: "decision_outcome_unknown", tenant_id: "TENANT_A" }));
  });
});
