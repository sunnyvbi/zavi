
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  callMcpTool: vi.fn(),
  serviceClientMock: vi.fn(),
  agentRunsPayload: { target: { github_full_name: "praxis-built/acme" }, build_conductor_run_id: "conductor-1" } as unknown,
  agentRunsParsed: null as unknown,
  agentRunsUpdates: [] as Array<Record<string, unknown>>,
  agentRunsUpdateError: null as null | { message: string },
  tenantResourceRow: { mode: "provisioned", external_ref: { github_full_name: "praxis-built/acme" } } as
    | { mode: string; external_ref: Record<string, unknown> }
    | null,
  tenantResourceError: null as null | { message: string },
  conductorStatus: "active" as string,
  conductorStatusSeq: [] as string[],
  conductorReadError: null as null | { message: string },
}));

vi.mock("../../client", () => ({
  inngest: { createFunction: () => ({}), send: vi.fn(async () => undefined) },
}));

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
          select: () => {
            const node: Record<string, unknown> = {};
            node.eq = () => node;
            node.maybeSingle = async () => ({
              data: { payload: mocks.agentRunsPayload, parsed: mocks.agentRunsParsed },
              error: null,
            });
            return node;
          },
          update: (val: Record<string, unknown>) => {
            mocks.agentRunsUpdates.push(val);
            return {
              eq: async () => ({ data: null, error: mocks.agentRunsUpdateError }),
            };
          },
        };
      }
      if (table === "conductor_runs") {
        const node: Record<string, unknown> = {};
        node.select = () => node;
        node.eq = () => node;
        node.maybeSingle = async () => ({
          data: mocks.conductorReadError
            ? null
            : { status: mocks.conductorStatusSeq.length > 0 ? mocks.conductorStatusSeq.shift() : mocks.conductorStatus },
          error: mocks.conductorReadError,
        });
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

const REPO = "praxis-built/acme";

function decision(bodyOverrides: Record<string, unknown> = {}) {
  return {
    id: "d-1",
    tenant_id: "t-prov",
    agent_run_id: "run-1",
    decision_class: "engineer.ship-pr",
    body: {
      repo: REPO,
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
    content: JSON.stringify({ pushed: true, commit_sha: "abc1234", html_url: "", number: null }),
  });
  mocks.serviceClientMock.mockReset();
  mocks.serviceClientMock.mockImplementation(() => makeServiceClient());
  mocks.tenantResourceRow = { mode: "provisioned", external_ref: { github_full_name: REPO } };
  mocks.tenantResourceError = null;
  mocks.conductorStatus = "active";
  mocks.conductorStatusSeq = [];
  mocks.conductorReadError = null;
  mocks.agentRunsPayload = { target: { github_full_name: REPO }, build_conductor_run_id: "conductor-1" };
  mocks.agentRunsParsed = null;
  mocks.agentRunsUpdates = [];
  mocks.agentRunsUpdateError = null;
  process.env.PRODUCT_BUILDER_ENABLED = "1";
});

function toolNamesCalled(): string[] {
  return mocks.callMcpTool.mock.calls.map((c) => c[2] as string);
}

describe("github.open_pr handler — push_to_main safety gate", () => {
  it("REFUSES a queued push after its parent build is stopped", async () => {
    mocks.conductorStatus = "failed";
    await HANDLERS["github.open_pr"](decision());
    expect(toolNamesCalled()).not.toContain("push_to_main");
  });
  it("RETRIES instead of publishing when the conductor status cannot be read", async () => {
    mocks.conductorReadError = { message: "db unavailable" };
    await expect(HANDLERS["github.open_pr"](decision())).rejects.toThrow("conductor status read failed");
    expect(toolNamesCalled()).not.toContain("push_to_main");
    expect(toolNamesCalled()).not.toContain("open_pr");
  });
  it("REFUSES the push when Stop lands after the first conductor read and before the push", async () => {
    mocks.conductorStatusSeq = ["active", "failed"];
    const res = await HANDLERS["github.open_pr"](decision());
    expect(toolNamesCalled()).not.toContain("push_to_main");
    expect(toolNamesCalled()).not.toContain("open_pr");
    expect(res.ok).toBe(false);
  });
  it("FALLBACK: a push_to_main proposal from a run with no parent build still opens a PR on a connected repo", async () => {
    mocks.agentRunsPayload = { target: { github_full_name: REPO } };
    mocks.tenantResourceRow = { mode: "connected", external_ref: { github_full_name: REPO } };
    const res = await HANDLERS["github.open_pr"](decision());
    expect(toolNamesCalled()).toContain("open_pr");
    expect(toolNamesCalled()).not.toContain("push_to_main");
    expect(res.ok).toBe(true);
  });
  it("PASS: provisioned triple-match + flag on → calls github.push_to_main (NOT open_pr)", async () => {
    const res = await HANDLERS["github.open_pr"](decision());
    expect(res.ok).toBe(true);
    expect(toolNamesCalled()).toContain("push_to_main");
    expect(toolNamesCalled()).not.toContain("open_pr");
  });

  it("FALLBACK: mode='connected' (customer's repo) → falls back to open_pr, never push_to_main", async () => {
    mocks.tenantResourceRow = { mode: "connected", external_ref: { github_full_name: REPO } };
    const res = await HANDLERS["github.open_pr"](decision());
    expect(toolNamesCalled()).toContain("open_pr");
    expect(toolNamesCalled()).not.toContain("push_to_main");
    expect(res.ok).toBe(true);
  });

  it("FALLBACK: no tenant_resources row → open_pr, never push_to_main", async () => {
    mocks.tenantResourceRow = null;
    await HANDLERS["github.open_pr"](decision());
    expect(toolNamesCalled()).toContain("open_pr");
    expect(toolNamesCalled()).not.toContain("push_to_main");
  });

  it("FALLBACK: tenant_resources query error → FAILS CLOSED to open_pr", async () => {
    mocks.tenantResourceError = { message: "db blip" };
    await HANDLERS["github.open_pr"](decision());
    expect(toolNamesCalled()).toContain("open_pr");
    expect(toolNamesCalled()).not.toContain("push_to_main");
  });

  it("FALLBACK: proposal.repo points at Praxis's own repo (name mismatch) → open_pr only", async () => {
    mocks.agentRunsPayload = { target: { github_full_name: "rravi149/praxis" }, build_conductor_run_id: "conductor-1" };
    await HANDLERS["github.open_pr"](decision({ repo: "rravi149/praxis" }));
    expect(toolNamesCalled()).toContain("open_pr");
    expect(toolNamesCalled()).not.toContain("push_to_main");
  });

  it("FALLBACK: proposal.repo != run payload.target → open_pr only (forged proposal repo)", async () => {
    mocks.agentRunsPayload = { target: { github_full_name: REPO }, build_conductor_run_id: "conductor-1" };
    await HANDLERS["github.open_pr"](decision({ repo: "praxis-built/other" }));
    expect(toolNamesCalled()).toContain("open_pr");
    expect(toolNamesCalled()).not.toContain("push_to_main");
  });

  it("FALLBACK: PRODUCT_BUILDER_ENABLED=0 (kill-switch) → open_pr only", async () => {
    process.env.PRODUCT_BUILDER_ENABLED = "0";
    await HANDLERS["github.open_pr"](decision());
    expect(toolNamesCalled()).toContain("open_pr");
    expect(toolNamesCalled()).not.toContain("push_to_main");
  });

  it("DEFAULT ON: PRODUCT_BUILDER_ENABLED unset → push_to_main (default-on, provisioned triple-match)", async () => {
    delete process.env.PRODUCT_BUILDER_ENABLED;
    const res = await HANDLERS["github.open_pr"](decision());
    expect(res.ok).toBe(true);
    expect(toolNamesCalled()).toContain("push_to_main");
    expect(toolNamesCalled()).not.toContain("open_pr");
  });

  it("NO FLAG: a normal proposal without push_to_main → open_pr (never touches the gate)", async () => {
    await HANDLERS["github.open_pr"](decision({ push_to_main: undefined }));
    expect(toolNamesCalled()).toContain("open_pr");
    expect(toolNamesCalled()).not.toContain("push_to_main");
  });
});

describe("github.open_pr handler — push_to_main commit_sha stamp", () => {
  it("MERGE-JSONB: stamps commit_sha into parsed while PRESERVING existing envelope keys", async () => {
    mocks.agentRunsParsed = {
      repo: REPO,
      head_branch: "engineer/refine-built-with-zavi",
      base_branch: "main",
      title: "refine: update hero copy",
    };
    const res = await HANDLERS["github.open_pr"](decision());
    expect(res.ok).toBe(true);
    expect(mocks.agentRunsUpdates).toHaveLength(1);
    expect(mocks.agentRunsUpdates[0]).toEqual({
      parsed: {
        repo: REPO,
        head_branch: "engineer/refine-built-with-zavi",
        base_branch: "main",
        title: "refine: update hero copy",
        commit_sha: "abc1234",
      },
    });
  });

  it("null parsed on the run → stamp still lands as {commit_sha}", async () => {
    mocks.agentRunsParsed = null;
    await HANDLERS["github.open_pr"](decision());
    expect(mocks.agentRunsUpdates).toHaveLength(1);
    expect(mocks.agentRunsUpdates[0]).toEqual({ parsed: { commit_sha: "abc1234" } });
  });

  it("STAMP FAILURE NEVER BREAKS THE MERGE: update error → push still returns ok:true", async () => {
    mocks.agentRunsUpdateError = { message: "db blip" };
    const res = await HANDLERS["github.open_pr"](decision());
    expect(res.ok).toBe(true);
    expect(toolNamesCalled()).toContain("push_to_main");
  });

  it("malformed commit_sha from the push result → NO stamp write", async () => {
    mocks.callMcpTool.mockResolvedValue({
      is_error: false,
      content: JSON.stringify({ pushed: true, commit_sha: "not-a-sha" }),
    });
    const res = await HANDLERS["github.open_pr"](decision());
    expect(res.ok).toBe(true);
    expect(mocks.agentRunsUpdates).toHaveLength(0);
  });

  it("gate FALLBACK to open_pr → no commit_sha stamp fires", async () => {
    mocks.tenantResourceRow = { mode: "connected", external_ref: { github_full_name: REPO } };
    await HANDLERS["github.open_pr"](decision());
    expect(toolNamesCalled()).toContain("open_pr");
    expect(mocks.agentRunsUpdates).toHaveLength(0);
  });
});

describe("github.open_pr handler — binary photo files keep their base64 flag", () => {
  const PHOTO = { path: "public/images/hero.jpg", action: "create", content: "/9j/4AAQSkZJRgABAYCB/v8KDQo=", encoding: "base64" };
  const PAGE = { path: "app/page.tsx", action: "modify", content: "export default () => null;\n" };

  function filesSentTo(tool: string): Array<Record<string, unknown>> {
    const call = mocks.callMcpTool.mock.calls.find((c) => c[2] === tool);
    return ((call?.[3] as { files?: Array<Record<string, unknown>> } | undefined)?.files ?? []);
  }

  it("push_to_main receives encoding:base64 on the photo and no encoding on the page", async () => {
    await HANDLERS["github.open_pr"](decision({ files: [PHOTO, PAGE] }));
    const files = filesSentTo("push_to_main");
    expect(files.find((f) => f.path === PHOTO.path)).toEqual(PHOTO);
    expect(files.find((f) => f.path === PAGE.path)).toEqual(PAGE);
  });

  it("the open_pr fallback carries the flag too", async () => {
    mocks.tenantResourceRow = { mode: "connected", external_ref: { github_full_name: REPO } };
    await HANDLERS["github.open_pr"](decision({ files: [PHOTO, PAGE] }));
    const files = filesSentTo("open_pr");
    expect(files.find((f) => f.path === PHOTO.path)).toEqual(PHOTO);
  });
});
