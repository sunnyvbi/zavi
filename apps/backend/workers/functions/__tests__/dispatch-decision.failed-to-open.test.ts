
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  callMcpTool: vi.fn(),
  serviceClientMock: vi.fn(),
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  schemaParse: vi.fn(),
}));

vi.mock("../../client", () => ({ inngest: { createFunction: () => ({}) } }));
vi.mock("@/services/mcp/execute", () => ({ callMcpTool: mocks.callMcpTool }));
vi.mock("@/agents/engineer/output-schema", () => ({
  prProposalSchema: { safeParse: (b: unknown) => mocks.schemaParse(b) },
  prProposalProductBuildSchema: { safeParse: (b: unknown) => mocks.schemaParse(b) },
}));
vi.mock("@/services/supabase", () => ({ serviceClient: mocks.serviceClientMock }));
vi.mock("@/services/memory/stamp-outcome", () => ({ stampOutcomeForDecisionId: vi.fn(async () => {}) }));
vi.mock("@/services/agents/registry", () => ({ loadAgentDefinition: vi.fn() }));
vi.mock("@/services/mcp/internal/jira", () => ({ jiraCreateIssue: vi.fn(), jiraAddComment: vi.fn() }));
vi.mock("@/services/mcp/internal/linear", () => ({ linearCreateIssue: vi.fn(), linearAddComment: vi.fn() }));
vi.mock("../digest-post-handler", () => ({ digestPostHandler: vi.fn() }));
vi.mock("@/services/decisions/atomic-claim", () => ({ claimDecision: vi.fn(), markDispatched: vi.fn(), releaseClaim: vi.fn() }));
vi.mock("@/services/decisions/auto-fire-rate-cap", () => ({ checkAutoFireRateCap: vi.fn() }));
vi.mock("@/services/agents/fleet-halt", () => ({ isFleetHalted: vi.fn(async () => false) }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(), LOG_META_KEYS: [] }));
vi.mock("@/services/agents/log-decision-not-taken", () => ({ logDecisionNotTaken: vi.fn() }));
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
  buildOpenPrNotice: vi.fn(() => "open-pr-notice"),
  extractChatThreadId: vi.fn(),
  HANDLER_LABELS: {},
}));

import { __testOnly_handlers as HANDLERS } from "../dispatch-decision";

function makeServiceClient() {
  return {
    from: () => {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.update = () => chain;
      chain.eq = () => chain;
      chain.maybeSingle = async () => ({ data: null, error: null });
      return chain;
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      mocks.rpcCalls.push({ fn, args });
      return { data: null, error: null };
    },
  };
}

function decision(bodyOverrides: Record<string, unknown> = {}) {
  return {
    id: "d-fto-1",
    tenant_id: "t-fto-1",
    agent_run_id: "run-fto-1",
    decision_class: "engineer.ship-pr",
    body: {
      repo: "acme/app",
      base_branch: "main",
      head_branch: "engineer/fix",
      title: "fix: thing",
      body: "",
      files: [{ path: "x.ts", action: "modify", content: "x" }],
      ...bodyOverrides,
    },
    status: "approved",
    handler: "github.open_pr",
  };
}

beforeEach(() => {
  mocks.callMcpTool.mockReset();
  mocks.serviceClientMock.mockReset();
  mocks.serviceClientMock.mockImplementation(() => makeServiceClient());
  mocks.rpcCalls.length = 0;
  mocks.schemaParse.mockReset();
  process.env.PRODUCT_BUILDER_ENABLED = "0";
});

function prStateCalls() {
  return mocks.rpcCalls.filter((c) => c.fn === "agent_run_set_pr_state");
}

describe("github.open_pr — failed_to_open stamping (P0-1)", () => {
  it("dispatch validation failure → ok:false + pr_state=failed_to_open with the reason", async () => {
    mocks.schemaParse.mockReturnValue({
      success: false,
      error: { issues: [{ message: "pr_proposal exceeds line cap: 6000 > 200" }] },
    });
    const res = await HANDLERS["github.open_pr"](decision());
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/pr_proposal validation failed/);
    const calls = prStateCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].args.p_run_id).toBe("run-fto-1");
    expect(calls[0].args.p_state).toBe("failed_to_open");
    expect(String(calls[0].args.p_detail)).toMatch(/exceeds line cap/);
  });

  it("all bases fail at the GitHub API → ok:false + pr_state=failed_to_open", async () => {
    mocks.schemaParse.mockImplementation((b: unknown) => ({ success: true, data: b }));
    mocks.callMcpTool.mockResolvedValue({ is_error: true, content: "boom: api down" });
    const res = await HANDLERS["github.open_pr"](decision());
    expect(res.ok).toBe(false);
    const calls = prStateCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].args.p_state).toBe("failed_to_open");
    expect(String(calls[0].args.p_detail)).toMatch(/boom: api down/);
  });

  it("successful open → NO failed_to_open stamp", async () => {
    mocks.schemaParse.mockImplementation((b: unknown) => ({ success: true, data: b }));
    mocks.callMcpTool.mockResolvedValue({
      is_error: false,
      content: JSON.stringify({ url: "https://github.com/acme/app/pull/7", number: 7 }),
    });
    const res = await HANDLERS["github.open_pr"](decision());
    expect(res.ok).toBe(true);
    expect(prStateCalls()).toHaveLength(0);
  });

  it("already-open (branch_exists) retry → treated as success, NO failed_to_open stamp", async () => {
    mocks.schemaParse.mockImplementation((b: unknown) => ({ success: true, data: b }));
    mocks.callMcpTool.mockResolvedValue({
      is_error: true,
      content: "reference already exists",
    });
    const res = await HANDLERS["github.open_pr"](decision());
    expect(res.ok).toBe(true);
    expect(prStateCalls()).toHaveLength(0);
  });

  it("missing agent_run_id → no stamp attempted, error still returned", async () => {
    mocks.schemaParse.mockReturnValue({
      success: false,
      error: { issues: [{ message: "bad" }] },
    });
    const d = { ...decision(), agent_run_id: null };
    const res = await HANDLERS["github.open_pr"](d);
    expect(res.ok).toBe(false);
    expect(prStateCalls()).toHaveLength(0);
  });
});
