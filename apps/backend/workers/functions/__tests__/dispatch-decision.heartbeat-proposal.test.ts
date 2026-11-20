
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => {
  const state: {
    decisionRow: { id: string; approved_by: string | null } | null;
    decisionReadError: { message: string } | null;
    upsertResult: { error: { message: string } | null };
    upsertCalls: Array<{ row: Record<string, unknown>; opts: unknown }>;
    schedulableSlugs: string[];
    schedulableThrows: boolean;
  } = {
    decisionRow: { id: "d-1", approved_by: "user-123" },
    decisionReadError: null,
    upsertResult: { error: null },
    upsertCalls: [],
    schedulableSlugs: ["operator", "pm", "engineer"],
    schedulableThrows: false,
  };

  const serviceClientMock = vi.fn(() => ({
    from: (table: string) => {
      if (table === "decisions") {
        const chain: Record<string, unknown> = {};
        chain.select = () => chain;
        chain.eq = () => chain;
        chain.maybeSingle = async () => ({
          data: state.decisionRow,
          error: state.decisionReadError,
        });
        return chain;
      }
      return {
        upsert: (row: Record<string, unknown>, opts: unknown) => {
          state.upsertCalls.push({ row, opts });
          return Promise.resolve(state.upsertResult);
        },
      };
    },
    rpc: vi.fn(async () => ({ data: null, error: null })),
  }));

  const isAgentSchedulableMock = vi.fn(async (_tenantId: string, slug: string) => {
    if (state.schedulableThrows) throw new Error("visibility boom");
    return state.schedulableSlugs.includes(slug);
  });

  return { state, serviceClientMock, isAgentSchedulableMock };
});

vi.mock("../../client", () => ({ inngest: { createFunction: () => ({}) } }));
vi.mock("@/services/supabase", () => ({ serviceClient: mocks.serviceClientMock }));
vi.mock("@/services/agents/visibility", () => ({
  isAgentSchedulable: mocks.isAgentSchedulableMock,
}));

vi.mock("@/services/memory/stamp-outcome", () => ({ stampOutcomeForDecisionId: vi.fn() }));
vi.mock("@/services/mcp/execute", () => ({ callMcpTool: vi.fn() }));
vi.mock("@/agents/engineer/output-schema", () => ({
  prProposalSchema: { safeParse: () => ({ success: false, error: { issues: [] } }) },
  prProposalProductBuildSchema: { safeParse: () => ({ success: false, error: { issues: [] } }) },
}));
vi.mock("@/services/agents/registry", () => ({ loadAgentDefinition: vi.fn() }));
vi.mock("@/services/mcp/internal/jira", () => ({ jiraCreateIssue: vi.fn(), jiraAddComment: vi.fn() }));
vi.mock("@/services/mcp/internal/linear", () => ({ linearCreateIssue: vi.fn(), linearAddComment: vi.fn() }));
vi.mock("../digest-post-handler", () => ({ digestPostHandler: vi.fn() }));
vi.mock("@/services/decisions/atomic-claim", () => ({
  claimDecision: vi.fn(),
  markDispatched: vi.fn(),
  releaseClaim: vi.fn(),
}));
vi.mock("@/services/decisions/auto-fire-rate-cap", () => ({ checkAutoFireRateCap: vi.fn() }));
vi.mock("@/services/agents/fleet-halt", () => ({ isFleetHalted: vi.fn() }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(), LOG_META_KEYS: [] }));
vi.mock("@/services/tools/meta-ads/write/_decision-bodies", () => ({
  updateAdSetBudgetBodySchema: { safeParse: () => ({ success: false, error: { issues: [] } }) },
  setStatusBodySchema: { safeParse: () => ({ success: false, error: { issues: [] } }) },
  createAdSetBodySchema: { safeParse: () => ({ success: false, error: { issues: [] } }) },
}));
vi.mock("@/services/tools/meta-ads/write/update_ad_set_budget", () => ({ metaUpdateAdSetBudget: vi.fn() }));
vi.mock("@/services/tools/meta-ads/write/set_status", () => ({ metaSetStatus: vi.fn() }));
vi.mock("@/services/tools/meta-ads/write/create_ad_set", () => ({ metaCreateAdSet: vi.fn() }));
vi.mock("@/services/tools/meta-ads/_client", () => ({ fbGet: vi.fn(), getAdAccountCurrency: vi.fn() }));
vi.mock("@/services/tools/email/_client", () => ({ emailSend: vi.fn() }));
vi.mock("@/services/tools/meta-ads/write/_helpers", () => ({ toBudgetMinorUnits: vi.fn() }));
vi.mock("@/services/tools/meta-ads/write/_drift-guard", () => ({ assertNoBudgetDrift: vi.fn() }));
vi.mock("@/services/tools/meta-ads/write/_cap-evaluator", async (importOriginal) => ({ ...(await importOriginal<object>()), evaluateBudgetCap: vi.fn() }));
vi.mock("@/services/tools/meta-ads/write/cap-reader", () => ({ readTenantCapAndToday: vi.fn() }));
vi.mock("@/services/provisioning/provisioned-repo-gate", () => ({ assertProvisionedRepoTarget: vi.fn() }));
vi.mock("../dispatch-notice", () => ({
  buildDispatchNotice: vi.fn(),
  buildOpenPrNotice: vi.fn(),
  extractChatThreadId: vi.fn(),
  HANDLER_LABELS: {},
}));

import { __testOnly_handlers as HANDLERS } from "../dispatch-decision";

const HANDLER = "heartbeat.automation_proposal_approve";

const baseDecision = {
  id: "d-1",
  tenant_id: "t-1",
  agent_run_id: null,
  decision_class: "heartbeat.automation-proposal",
  body: {
    agent_slug: "operator",
    cron_expression: "0 14 * * *",
    objective: "Automated operator run (proposed by heartbeat).",
  },
  status: "approved",
  handler: HANDLER,
};

describe("dispatch-decision.heartbeat.automation_proposal_approve handler", () => {
  beforeEach(() => {
    mocks.state.decisionRow = { id: "d-1", approved_by: "user-123" };
    mocks.state.decisionReadError = null;
    mocks.state.upsertCalls = [];
    mocks.state.upsertResult = { error: null };
    mocks.state.schedulableSlugs = ["operator", "pm", "engineer"];
    mocks.state.schedulableThrows = false;
    mocks.serviceClientMock.mockClear();
    mocks.isAgentSchedulableMock.mockClear();
  });

  it("inserts/enables ONE schedule row on approve (happy path)", async () => {
    const handler = HANDLERS[HANDLER];
    expect(handler).toBeDefined();
    const res = await handler(baseDecision);
    expect(res.ok).toBe(true);
    expect(res.notice).toMatch(/Scheduled/i);
    expect(mocks.state.upsertCalls.length).toBe(1);
    const call = mocks.state.upsertCalls[0];
    expect(call.row.tenant_id).toBe("t-1");
    expect(call.row.agent_slug).toBe("operator");
    expect(call.row.cron_expression).toBe("0 14 * * *");
    expect(call.row.enabled).toBe(true);
    expect(call.opts).toEqual({ onConflict: "tenant_id,agent_slug" });
    expect((call.row.payload_template as { objective: string }).objective).toMatch(/operator/);
  });

  it("idempotent on DOUBLE approve — each is a single UPSERT (no duplicate row)", async () => {
    await HANDLERS[HANDLER](baseDecision);
    await HANDLERS[HANDLER](baseDecision);
    expect(mocks.state.upsertCalls.length).toBe(2);
    for (const c of mocks.state.upsertCalls) {
      expect(c.opts).toEqual({ onConflict: "tenant_id,agent_slug" });
      expect(c.row.agent_slug).toBe("operator");
    }
  });

  it("TRUST BOUNDARY: a forged/disabled agent_slug (not visible) is REFUSED, no schedule write", async () => {
    const res = await HANDLERS[HANDLER]({
      ...baseDecision,
      body: { ...baseDecision.body, agent_slug: "ban-everyone" },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not visible|not enabled/i);
    expect(mocks.state.upsertCalls.length).toBe(0);
  });

  it("refuses a malformed cron_expression (would never fire / fire wrong)", async () => {
    const res = await HANDLERS[HANDLER]({
      ...baseDecision,
      body: { ...baseDecision.body, cron_expression: "not a cron" },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/cron_expression invalid/);
    expect(mocks.state.upsertCalls.length).toBe(0);
  });

  it("fail-closed on a malformed body (missing agent_slug) — no write", async () => {
    const res = await HANDLERS[HANDLER]({
      ...baseDecision,
      body: { cron_expression: "0 14 * * *", objective: "x" },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/body invalid/);
    expect(mocks.state.upsertCalls.length).toBe(0);
  });

  it("returns ok:false on a schedule upsert DB error (does NOT swallow)", async () => {
    mocks.state.upsertResult = { error: { message: "connection reset" } };
    const res = await HANDLERS[HANDLER](baseDecision);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/connection reset/);
  });

  it("fails closed (#2) when the schedulability check throws (no write)", async () => {
    mocks.state.schedulableThrows = true;
    const res = await HANDLERS[HANDLER](baseDecision);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/schedulability check failed/);
    expect(mocks.state.upsertCalls.length).toBe(0);
  });

  it("#1 a PROPOSED (non-approved) decision routed here writes ZERO schedule rows", async () => {
    mocks.state.decisionRow = { id: "d-1", approved_by: null };
    const res = await HANDLERS[HANDLER](baseDecision);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no human approval|approved_by is null/i);
    expect(mocks.state.upsertCalls.length).toBe(0);
    expect(mocks.isAgentSchedulableMock).not.toHaveBeenCalled();
  });

  it("#1 a missing decision row (cross-tenant id / deleted) writes ZERO schedule rows", async () => {
    mocks.state.decisionRow = null;
    const res = await HANDLERS[HANDLER](baseDecision);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no human approval|approved_by is null/i);
    expect(mocks.state.upsertCalls.length).toBe(0);
  });

  it("#1 an approved-status read error fails closed (no write)", async () => {
    mocks.state.decisionReadError = { message: "db down" };
    const res = await HANDLERS[HANDLER](baseDecision);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/approved-status read failed/);
    expect(mocks.state.upsertCalls.length).toBe(0);
  });

  it("#2 visibility read error → zero schedule rows (NOT fail-open)", async () => {
    mocks.state.schedulableThrows = true;
    const res = await HANDLERS[HANDLER](baseDecision);
    expect(res.ok).toBe(false);
    expect(mocks.state.upsertCalls.length).toBe(0);
  });
});
