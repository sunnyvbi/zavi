
import { describe, it, expect, vi, beforeEach } from "vitest";

const enqueueAgentRun = vi.fn();
const getVisibleAgentSlugs = vi.fn();
const claimDecisionMock = vi.fn();
const isFleetHaltedMock = vi.fn(async () => false);
const readTenantDisabledMock = vi.fn(async (_t: string): Promise<boolean | null> => false);
const releaseClaimMock = vi.fn();

const decisionsUpdates: Array<Record<string, unknown>> = [];

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
            return { eq: () => Promise.resolve({ data: null, error: null }) };
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
  releaseClaim: (...a: unknown[]) => releaseClaimMock(...a),
  markDispatched: vi.fn(),
}));
vi.mock("@/services/decisions/auto-fire-rate-cap", () => ({ checkAutoFireRateCap: vi.fn() }));
vi.mock("@/services/agents/fleet-halt", () => ({ isFleetHalted: () => isFleetHaltedMock() }));
vi.mock("@/services/tenants/disabled", () => ({ readTenantDisabled: (t: string) => readTenantDisabledMock(t) }));
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
vi.mock("../dispatch-notice", () => ({
  buildDispatchNotice: vi.fn(),
  buildOpenPrNotice: vi.fn(),
  extractChatThreadId: vi.fn(() => null),
  postDispatchNotice: vi.fn(),
  HANDLER_LABELS: {},
}));

import { __testOnly_executeDispatch as executeDispatch } from "../dispatch-decision";

beforeEach(() => {
  decisionsUpdates.length = 0;
  claimDecisionMock.mockReset();
  isFleetHaltedMock.mockReset();
  isFleetHaltedMock.mockResolvedValue(false);
  readTenantDisabledMock.mockReset();
  readTenantDisabledMock.mockResolvedValue(false);
  releaseClaimMock.mockReset();
  enqueueAgentRun.mockReset();
  getVisibleAgentSlugs.mockReset();
});

describe("null-handler advisory dispatch (agent.urgent_advisory)", () => {
  it("a claimed decision with handler=NULL is marked status='acted' (no side effect)", async () => {
    claimDecisionMock.mockResolvedValueOnce({
      id: "d-advisory",
      tenant_id: "t-1",
      agent_run_id: null,
      decision_class: "agent.urgent_advisory",
      body: { title: "Runway alert", summary: "Acknowledge or dismiss." },
      status: "approved",
      handler: null,
    });

    const res = await executeDispatch("d-advisory");

    expect(res.ok).toBe(true);
    const acted = decisionsUpdates.find((u) => u.status === "acted");
    expect(acted, "expected a status='acted' update for the null-handler decision").toBeTruthy();
    expect(decisionsUpdates.some((u) => u.status === "rejected")).toBe(false);
  });

  it("a claimed decision with a NON-NULL but UNREGISTERED handler is DISPATCH_FAILED", async () => {
    claimDecisionMock.mockResolvedValueOnce({
      id: "d-bogus",
      tenant_id: "t-1",
      agent_run_id: null,
      decision_class: "agent.some_unregistered_class",
      body: {},
      status: "approved",
      handler: "no.such.handler",
    });

    const res = await executeDispatch("d-bogus");

    expect(res.ok).toBe(false);
    expect(decisionsUpdates.some((u) => u.status === "rejected")).toBe(false);
    const failed = decisionsUpdates.find((u) => u.status === "dispatch_failed");
    expect(failed).toBeTruthy();
    expect(String(failed!.dispatch_error)).toMatch(/no registered handler/i);
  });
});

describe("disabled workspace (staff Disable workspace)", () => {
  const row = {
    id: "d-x",
    tenant_id: "t-dead",
    agent_run_id: null,
    decision_class: "agent.urgent_advisory",
    body: {},
    status: "approved",
    handler: null,
  };

  it("a disabled tenant's decision settles dispatch_failed/tenant_disabled and never runs", async () => {
    claimDecisionMock.mockResolvedValueOnce(row);
    readTenantDisabledMock.mockResolvedValueOnce(true);
    const res = await executeDispatch("d-x");
    expect(res).toEqual({ ok: false, error: "tenant_disabled" });
    expect(readTenantDisabledMock).toHaveBeenCalledWith("t-dead");
    expect(decisionsUpdates).toHaveLength(1);
    expect(decisionsUpdates[0]).toMatchObject({ status: "dispatch_failed", dispatch_error: "tenant_disabled" });
    expect(releaseClaimMock).not.toHaveBeenCalled();
  });

  it("an unreadable flag fails closed but retryable: the claim is released, nothing settles", async () => {
    claimDecisionMock.mockResolvedValueOnce(row);
    readTenantDisabledMock.mockResolvedValueOnce(null);
    const res = await executeDispatch("d-x");
    expect(res).toEqual({ ok: false, error: "tenant_disabled_check_failed" });
    expect(releaseClaimMock).toHaveBeenCalledWith("d-x", "tenant_disabled_check_failed");
    expect(decisionsUpdates).toHaveLength(0);
  });
});
