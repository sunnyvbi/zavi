
import { describe, it, expect, vi, beforeEach } from "vitest";

const claimDecisionMock = vi.fn();
const isFleetHaltedMock = vi.fn(async () => false);
const enqueueAgentRun = vi.fn();
const getVisibleAgentSlugs = vi.fn();

const decisionsUpdates: Array<Record<string, unknown>> = [];
const settle = { failWith: null as null | { message: string } };

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
  postDispatchNotice: vi.fn(),
  HANDLER_LABELS: {},
}));

import { __testOnly_executeDispatch as executeDispatch } from "../dispatch-decision";

function claimSpecialist() {
  claimDecisionMock.mockResolvedValueOnce({
    id: "d-settle",
    tenant_id: "t-1",
    agent_run_id: null,
    decision_class: "praxis.dispatch_specialist",
    body: { target_agent_slug: "pm", intent: "do a thing" },
    status: "approved",
    handler: "praxis.dispatch_specialist",
  });
}

function settleWrites() {
  return decisionsUpdates.filter((u) => "status" in u && "dispatched_at" in u);
}

beforeEach(() => {
  decisionsUpdates.length = 0;
  settle.failWith = null;
  platformWriteEnabledMock.mockReset();
  platformWriteEnabledMock.mockResolvedValue(true);
  claimDecisionMock.mockReset();
  isFleetHaltedMock.mockReset();
  isFleetHaltedMock.mockResolvedValue(false);
  enqueueAgentRun.mockReset();
  enqueueAgentRun.mockResolvedValue({ run_id: "run-9" });
  getVisibleAgentSlugs.mockReset();
  getVisibleAgentSlugs.mockResolvedValue(new Set(["pm"]));
});

describe("dispatch-decision — a settle write that does not land", () => {
  it("retries the settle once and reports the stuck row at error level", async () => {
    settle.failWith = { message: "could not serialize access" };
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      errors.push(a.map(String).join(" "));
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    claimSpecialist();
    const res = await executeDispatch("d-settle");

    spy.mockRestore();
    warn.mockRestore();

    expect(settleWrites()).toHaveLength(2);
    const stuck = errors.find((e) => e.includes("SETTLE STUCK"));
    expect(stuck, `expected an error-level SETTLE STUCK line, got: ${errors.join(" | ")}`).toBeTruthy();
    expect(stuck).toContain("d-settle");
    expect(res.ok).toBe(true);
  });

  it("a settle that lands is written exactly once", async () => {
    claimSpecialist();
    const res = await executeDispatch("d-settle");

    expect(res.ok).toBe(true);
    expect(settleWrites()).toHaveLength(1);
    expect(settleWrites()[0].status).toBe("acted");
  });
});

describe("dispatch-decision — the platform-off exit checks its own write", () => {
  it("retries and reports a stuck row, instead of leaving it 'dispatching' silently", async () => {
    platformWriteEnabledMock.mockResolvedValue(false);
    settle.failWith = { message: "could not serialize access" };
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      errors.push(a.map(String).join(" "));
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    claimSpecialist();
    const res = await executeDispatch("d-settle");

    spy.mockRestore();
    warn.mockRestore();

    expect(settleWrites()).toHaveLength(2);
    const stuck = errors.find((e) => e.includes("SETTLE STUCK"));
    expect(stuck, `expected an error-level SETTLE STUCK line, got: ${errors.join(" | ")}`).toBeTruthy();
    expect(stuck).toContain("d-settle");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("platform_write_disabled");
  });

  it("writes the refusal once when it lands", async () => {
    platformWriteEnabledMock.mockResolvedValue(false);
    claimSpecialist();
    const res = await executeDispatch("d-settle");

    expect(settleWrites()).toHaveLength(1);
    expect(settleWrites()[0].status).toBe("dispatch_failed");
    expect(res.ok).toBe(false);
  });
});
