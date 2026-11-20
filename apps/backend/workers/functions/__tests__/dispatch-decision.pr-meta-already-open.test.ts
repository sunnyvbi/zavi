
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
    id: "d-ao-1",
    tenant_id: "t-ao-1",
    agent_run_id: "run-ao-1",
    decision_class: "engineer.ship-pr",
    body: {
      repo: "acme/app",
      base_branch: "development",
      head_branch: "engineer/per-car-delete-active-trip-guard",
      title: "fix: guard",
      body: "",
      files: [{ path: "x.ts", action: "modify", content: "x" }],
      ...bodyOverrides,
    },
    status: "approved",
    handler: "github.open_pr",
  };
}

function prMetaCalls() {
  return mocks.rpcCalls.filter((c) => c.fn === "agent_run_set_pr_meta");
}

beforeEach(() => {
  mocks.callMcpTool.mockReset();
  mocks.serviceClientMock.mockReset();
  mocks.serviceClientMock.mockImplementation(() => makeServiceClient());
  mocks.rpcCalls.length = 0;
  mocks.schemaParse.mockReset();
  mocks.schemaParse.mockImplementation((b: unknown) => ({ success: true, data: b }));
  process.env.PRODUCT_BUILDER_ENABLED = "0";
});

describe("github.open_pr — pr_url writeback on the already-open path", () => {
  it("branch_exists + existing OPEN PR resolvable → writes back pr_url/pr_number (was silently skipped)", async () => {
    mocks.callMcpTool.mockImplementation(
      async (_ctx: unknown, _server: string, tool: string) => {
        if (tool === "open_pr") {
          return { is_error: true, content: "Reference already exists" };
        }
        if (tool === "list_open_prs") {
          return {
            is_error: false,
            content: JSON.stringify({
              prs: [
                { number: 999, head_branch: "engineer/unrelated" },
                { number: 1265, head_branch: "engineer/per-car-delete-active-trip-guard" },
              ],
            }),
          };
        }
        return { is_error: true, content: "unexpected tool" };
      },
    );

    const res = await HANDLERS["github.open_pr"](decision());
    expect(res.ok).toBe(true);

    const calls = prMetaCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].args.p_run_id).toBe("run-ao-1");
    expect(calls[0].args.p_pr_url).toBe("https://github.com/acme/app/pull/1265");
    expect(calls[0].args.p_pr_number).toBe(1265);
    expect(calls[0].args.p_pr_repo).toBe("acme/app");
    expect(calls[0].args.p_pr_head_branch).toBe(
      "engineer/per-car-delete-active-trip-guard",
    );
  });

  it("fresh open (no branch collision) → still writes back pr_url (unchanged path)", async () => {
    mocks.callMcpTool.mockImplementation(
      async (_ctx: unknown, _server: string, tool: string) => {
        if (tool === "open_pr") {
          return {
            is_error: false,
            content: JSON.stringify({ url: "https://github.com/acme/app/pull/1300", number: 1300 }),
          };
        }
        return { is_error: true, content: "unexpected tool" };
      },
    );
    const res = await HANDLERS["github.open_pr"](decision());
    expect(res.ok).toBe(true);
    const calls = prMetaCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].args.p_pr_url).toBe("https://github.com/acme/app/pull/1300");
    expect(calls[0].args.p_pr_number).toBe(1300);
  });

  it("branch_exists but list_open_prs fails → degrades to link-less already_open (no crash, ok:true)", async () => {
    mocks.callMcpTool.mockImplementation(
      async (_ctx: unknown, _server: string, tool: string) => {
        if (tool === "open_pr") {
          return { is_error: true, content: "branch_exists" };
        }
        return { is_error: true, content: "list failed" };
      },
    );
    const res = await HANDLERS["github.open_pr"](decision());
    expect(res.ok).toBe(true);
    expect(prMetaCalls()).toHaveLength(0);
  });
});
