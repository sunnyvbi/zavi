
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  callMcpTool: vi.fn(),
  serviceClientMock: vi.fn(),
  agentRunsPayload: {} as unknown,
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

const REPO = "acme-co/acme";
const CHECKOUT_REF = "engineer/foo";

function makeServiceClient() {
  return {
    from: (table: string) => {
      if (table === "agent_runs") {
        return {
          select: () => {
            const node: Record<string, unknown> = {};
            node.eq = () => node;
            node.maybeSingle = async () => ({
              data: { payload: mocks.agentRunsPayload, agent_slug: "engineer" },
              error: null,
            });
            return node;
          },
        };
      }
      const chain: Record<string, unknown> = {};
      chain.update = () => chain;
      chain.eq = () => ({ data: null, error: null });
      return chain;
    },
    rpc: async () => ({ data: null, error: null }),
  };
}

function decision(bodyOverrides: Record<string, unknown> = {}) {
  return {
    id: "d-fup-1",
    tenant_id: "t-fup-1",
    agent_run_id: "run-fup-1",
    decision_class: "engineer.ship-pr",
    body: {
      repo: REPO,
      base_branch: "main",
      head_branch: CHECKOUT_REF,
      title: "follow-up: handle X",
      body: "",
      files: [{ path: "src/x.ts", action: "modify", content: "x" }],
      ...bodyOverrides,
    },
    status: "approved",
    handler: "github.open_pr",
  };
}

beforeEach(() => {
  mocks.callMcpTool.mockReset();
  mocks.callMcpTool.mockImplementation(async (_ctx, _server, tool, _args) => {
    if (tool === "list_open_prs") {
      return {
        is_error: false,
        content: JSON.stringify({ prs: [{ number: 7, head_branch: CHECKOUT_REF }] }),
      };
    }
    if (tool === "update_pr_branch") {
      return { is_error: false, content: JSON.stringify({ no_change: false, commit_sha: "deadbeef" }) };
    }
    return { is_error: false, content: JSON.stringify({ url: "https://github.com/acme-co/acme/pull/9", number: 9 }) };
  });
  mocks.serviceClientMock.mockReset();
  mocks.serviceClientMock.mockImplementation(() => makeServiceClient());
  mocks.agentRunsPayload = {
    kind: "engineer_pr_followup",
    checkout_ref: CHECKOUT_REF,
    target_pr_number: 7,
    target_pr_repo: REPO,
    instruction: "also handle X",
    source: "chat",
  };
  process.env.PRODUCT_BUILDER_ENABLED = "1";
});

function toolNamesCalled(): string[] {
  return mocks.callMcpTool.mock.calls.map((c) => c[2] as string);
}

describe("github.open_pr handler — engineer_pr_followup branch-update gate (DEL-318 S3)", () => {
  it("PASS: head_branch===checkout_ref + open PR matches → update_pr_branch fires, no fresh PR", async () => {
    const res = await HANDLERS["github.open_pr"](decision());
    expect(res.ok).toBe(true);
    expect(toolNamesCalled()).toContain("update_pr_branch");
    expect(toolNamesCalled()).not.toContain("open_pr");
  });

  it("FAIL-CLOSED: model head_branch != server checkout_ref → REFUSED (error), NO fresh PR, no update_pr_branch", async () => {
    const res = await HANDLERS["github.open_pr"](decision({ head_branch: "engineer/attacker-branch" }));
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain("refused");
    expect(toolNamesCalled()).not.toContain("open_pr");
    expect(toolNamesCalled()).not.toContain("update_pr_branch");
  });

  it("FAIL-CLOSED: target PR not OPEN for this tenant → REFUSED (error), NO fresh PR, no update_pr_branch", async () => {
    mocks.callMcpTool.mockImplementation(async (_ctx, _server, tool) => {
      if (tool === "list_open_prs") {
        return { is_error: false, content: JSON.stringify({ prs: [{ number: 99, head_branch: CHECKOUT_REF }] }) };
      }
      return { is_error: false, content: JSON.stringify({ url: "https://github.com/acme-co/acme/pull/9", number: 9 }) };
    });
    const res = await HANDLERS["github.open_pr"](decision());
    expect(res.ok).toBe(false);
    expect(toolNamesCalled()).not.toContain("open_pr");
    expect(toolNamesCalled()).not.toContain("update_pr_branch");
  });

  it("NOT a follow-up run (no engineer_pr_followup kind) → ordinary open_pr, no list_open_prs probe", async () => {
    mocks.agentRunsPayload = { target: { github_full_name: REPO } };
    await HANDLERS["github.open_pr"](decision());
    expect(toolNamesCalled()).toContain("open_pr");
    expect(toolNamesCalled()).not.toContain("update_pr_branch");
    expect(toolNamesCalled()).not.toContain("list_open_prs");
  });

  it("FAIL-CLOSED: MALFORMED follow-up payload (kind set, target_pr_number missing) → REFUSED, NO fresh PR (codex P2 tri-state)", async () => {
    mocks.agentRunsPayload = {
      kind: "engineer_pr_followup",
      checkout_ref: CHECKOUT_REF,
      target_pr_repo: REPO,
    };
    const res = await HANDLERS["github.open_pr"](decision());
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain("refused");
    expect(toolNamesCalled()).not.toContain("open_pr");
    expect(toolNamesCalled()).not.toContain("update_pr_branch");
  });
});
