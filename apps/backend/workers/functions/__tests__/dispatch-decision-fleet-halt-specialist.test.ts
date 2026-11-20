import { describe, it, expect, vi, beforeEach } from "vitest";

const enqueueAgentRun = vi.fn();
const getVisibleAgentSlugs = vi.fn();

vi.mock("@/services/agents/runner", () => ({ enqueueAgentRun: (...a: unknown[]) => enqueueAgentRun(...a) }));
vi.mock("@/services/agents/visibility", () => ({
  getVisibleAgentSlugs: (...a: unknown[]) => getVisibleAgentSlugs(...a),
}));

vi.mock("../../client", () => ({ inngest: { createFunction: () => ({}) } }));
vi.mock("@/services/supabase", () => ({ serviceClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) }) }));
vi.mock("@/services/memory/stamp-outcome", () => ({ stampOutcomeForDecisionId: vi.fn(async () => {}) }));
vi.mock("@/services/mcp/execute", () => ({ callMcpTool: vi.fn() }));
vi.mock("@/agents/engineer/output-schema", () => ({ prProposalSchema: { safeParse: () => ({ success: false, error: { issues: [] } }) } }));
vi.mock("@/services/agents/registry", () => ({ loadAgentDefinition: vi.fn() }));
vi.mock("@/services/mcp/internal/jira", () => ({ jiraCreateIssue: vi.fn(), jiraAddComment: vi.fn() }));
vi.mock("@/services/mcp/internal/linear", () => ({ linearCreateIssue: vi.fn(), linearAddComment: vi.fn() }));
vi.mock("../digest-post-handler", () => ({ digestPostHandler: vi.fn() }));
vi.mock("@/services/decisions/atomic-claim", () => ({ claimDecision: vi.fn(), releaseClaim: vi.fn(), markDispatched: vi.fn() }));
vi.mock("@/services/decisions/auto-fire-rate-cap", () => ({ checkAutoFireRateCap: vi.fn() }));
vi.mock("@/services/agents/fleet-halt", () => ({ isFleetHalted: vi.fn(async () => false) }));
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
vi.mock("../dispatch-notice", () => ({ buildDispatchNotice: vi.fn(), postDispatchNotice: vi.fn() }));

import { __testOnly_handlers as HANDLERS } from "../dispatch-decision";

beforeEach(() => {
  enqueueAgentRun.mockReset();
  getVisibleAgentSlugs.mockReset();
  getVisibleAgentSlugs.mockResolvedValue(new Set(["pm"]));
});

describe("praxis.dispatch_specialist — fleet halt race", () => {
  const body = { target_agent_slug: "pm", intent: "do a thing" };

  it("returns stable fleet_halted error when child enqueue throws FleetHaltedError", async () => {
    const haltErr = Object.assign(new Error("fleet halt active"), { code: "fleet_halted" });
    enqueueAgentRun.mockRejectedValueOnce(haltErr);

    const res = await HANDLERS["praxis.dispatch_specialist"]({
      id: "d-1",
      tenant_id: "t-1",
      body,
    } as never);

    expect(res.ok).toBe(false);
    expect(res.error).toBe("fleet_halted");
  });

  it("dispatches normally when not halted", async () => {
    enqueueAgentRun.mockResolvedValueOnce({ run_id: "run-9" });
    const res = await HANDLERS["praxis.dispatch_specialist"]({
      id: "d-1",
      tenant_id: "t-1",
      body,
    } as never);
    expect(res.ok).toBe(true);
  });

  it("threads origin_decision_id + dispatched_by from body into the enqueue payload", async () => {
    enqueueAgentRun.mockResolvedValueOnce({ run_id: "run-10" });
    const res = await HANDLERS["praxis.dispatch_specialist"]({
      id: "disp-1",
      tenant_id: "t-1",
      body: {
        target_agent_slug: "pm",
        intent: "do a thing",
        origin_decision_id: "11111111-1111-4111-8111-111111111111",
        dispatched_by: "growth-lead",
      },
    } as never);
    expect(res.ok).toBe(true);
    const payload = enqueueAgentRun.mock.calls[0][0].payload;
    expect(payload.origin_decision_id).toBe("11111111-1111-4111-8111-111111111111");
    expect(payload.dispatched_by).toBe("growth-lead");
    expect(payload.source_decision_id).toBe("disp-1");
  });

  it("omitted provenance → defaults dispatched_by=chief-of-staff, no origin_decision_id", async () => {
    enqueueAgentRun.mockResolvedValueOnce({ run_id: "run-11" });
    const res = await HANDLERS["praxis.dispatch_specialist"]({
      id: "d-2",
      tenant_id: "t-1",
      body,
    } as never);
    expect(res.ok).toBe(true);
    const payload = enqueueAgentRun.mock.calls[0][0].payload;
    expect(payload.dispatched_by).toBe("chief-of-staff");
    expect("origin_decision_id" in payload).toBe(false);
  });
});
