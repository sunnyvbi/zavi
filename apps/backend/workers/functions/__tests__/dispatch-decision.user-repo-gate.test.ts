
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  callMcpTool: vi.fn(),
  serviceClientMock: vi.fn(),
  agentRunsPayload: {
    target: { github_full_name: "alice/cool-app", github_target_mode: "user_repo" },
  } as unknown,
  tenantResourceRow: {
    mode: "connected",
    external_ref: { github_full_name: "alice/cool-app", user_repo_grant: true },
  } as { mode: string; external_ref: Record<string, unknown> } | null,
  tenantResourceError: null as null | { message: string },
}));

vi.mock("../../client", () => ({ inngest: { createFunction: () => ({}) } }));
vi.mock("@/services/mcp/execute", () => ({ callMcpTool: mocks.callMcpTool }));
vi.mock("@/agents/engineer/output-schema", () => ({
  prProposalSchema: { safeParse: (b: unknown) => ({ success: true, data: b }) },
  prProposalProductBuildSchema: { safeParse: (b: unknown) => ({ success: true, data: b }) },
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
    from: (table: string) => {
      if (table === "tenant_resources") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () =>
                  mocks.tenantResourceError
                    ? { data: null, error: mocks.tenantResourceError }
                    : { data: mocks.tenantResourceRow, error: null },
              }),
            }),
          }),
        };
      }
      if (table === "agent_runs") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { payload: mocks.agentRunsPayload }, error: null }),
            }),
          }),
        };
      }
      if (table === "conductor_runs") {
        const node: Record<string, unknown> = {};
        node.select = () => node;
        node.eq = () => node;
        node.maybeSingle = async () => ({ data: { status: "active" }, error: null });
        return node;
      }
      const chain: Record<string, unknown> = {};
      chain.update = () => chain;
      chain.eq = () => ({ data: null, error: null });
      chain.rpc = async () => ({ data: null, error: null });
      return chain;
    },
    rpc: async () => ({ data: null, error: null }),
  };
}

const USER_REPO = "alice/cool-app";

function decision(bodyOverrides: Record<string, unknown> = {}) {
  return {
    id: "d-user-1",
    tenant_id: "t-user-1",
    agent_run_id: "run-user-1",
    decision_class: "engineer.ship-pr",
    body: {
      repo: USER_REPO,
      base_branch: "main",
      head_branch: "engineer/build",
      title: "build: implement idea",
      body: "",
      files: [{ path: "app/page.tsx", action: "create", content: "x" }],
      push_to_main: true,
      ...bodyOverrides,
    },
    status: "approved",
    handler: "github.open_pr",
  };
}

beforeEach(() => {
  mocks.callMcpTool.mockReset();
  mocks.callMcpTool.mockResolvedValue({
    is_error: false,
    content: JSON.stringify({ pushed: true, commit_sha: "abc1234" }),
  });
  mocks.serviceClientMock.mockReset();
  mocks.serviceClientMock.mockImplementation(() => makeServiceClient());
  mocks.tenantResourceRow = {
    mode: "connected",
    external_ref: { github_full_name: USER_REPO, user_repo_grant: true },
  };
  mocks.tenantResourceError = null;
  mocks.agentRunsPayload = {
    target: { github_full_name: USER_REPO, github_target_mode: "user_repo" },
    build_conductor_run_id: "conductor-user-1",
  };
  process.env.PRODUCT_BUILDER_ENABLED = "1";
});

function toolNamesCalled(): string[] {
  return mocks.callMcpTool.mock.calls.map((c) => c[2] as string);
}

describe("github.open_pr handler — user_repo gate routing (Phase 1.5)", () => {
  it("PASS: connected mode + grant flag + user_repo target → push_to_main fires", async () => {
    const res = await HANDLERS["github.open_pr"](decision());
    expect(res.ok).toBe(true);
    expect(toolNamesCalled()).toContain("push_to_main");
    expect(toolNamesCalled()).not.toContain("open_pr");
  });

  it("FALLBACK: user_repo target but tenant_resources mode='provisioned' → open_pr (wrong-gate row)", async () => {
    mocks.tenantResourceRow = {
      mode: "provisioned",
      external_ref: { github_full_name: USER_REPO, user_repo_grant: true },
    };
    await HANDLERS["github.open_pr"](decision());
    expect(toolNamesCalled()).toContain("open_pr");
    expect(toolNamesCalled()).not.toContain("push_to_main");
  });

  it("FALLBACK: connected row exists for user_repo target but user_repo_grant missing → open_pr", async () => {
    mocks.tenantResourceRow = {
      mode: "connected",
      external_ref: { github_full_name: USER_REPO  },
    };
    await HANDLERS["github.open_pr"](decision());
    expect(toolNamesCalled()).toContain("open_pr");
    expect(toolNamesCalled()).not.toContain("push_to_main");
  });

  it("FALLBACK: user_repo target name mismatch → open_pr (cross-tenant forge attempt)", async () => {
    mocks.agentRunsPayload = {
      target: { github_full_name: USER_REPO, github_target_mode: "user_repo" },
      build_conductor_run_id: "conductor-user-1",
    };
    await HANDLERS["github.open_pr"](decision({ repo: "bob/evil-app" }));
    expect(toolNamesCalled()).toContain("open_pr");
    expect(toolNamesCalled()).not.toContain("push_to_main");
  });

  it("FALLBACK: user_repo target + query error on tenant_resources → FAILS CLOSED to open_pr", async () => {
    mocks.tenantResourceError = { message: "db blip" };
    await HANDLERS["github.open_pr"](decision());
    expect(toolNamesCalled()).toContain("open_pr");
    expect(toolNamesCalled()).not.toContain("push_to_main");
  });

  it("ROUTING: target without github_target_mode defaults to 'umbrella' (backward compat)", async () => {
    mocks.agentRunsPayload = {
      target: { github_full_name: "praxis-built/legacy"  },
      build_conductor_run_id: "conductor-user-1",
    };
    mocks.tenantResourceRow = {
      mode: "provisioned",
      external_ref: { github_full_name: "praxis-built/legacy" },
    };
    const res = await HANDLERS["github.open_pr"](decision({ repo: "praxis-built/legacy" }));
    expect(res.ok).toBe(true);
    expect(toolNamesCalled()).toContain("push_to_main");
  });
});
