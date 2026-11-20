
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  callMcpTool: vi.fn(),
  serviceClientMock: vi.fn(),
  alertMock: vi.fn(
    async (_input: { msg: string; source: string; code?: string; tenant_id?: string | null }) => {},
  ),
  agentRunsPayload: {
    target: { github_full_name: "praxis-build/acme" },
  } as unknown,
  tenantResourceRow: {
    mode: "provisioned",
    external_ref: { github_full_name: "praxis-build/acme" },
  } as { mode: string; external_ref: Record<string, unknown> } | null,
  tenantResourceError: null as null | { message: string },
  siteByRepo: null as null | Record<string, unknown>,
  conductorRow: { status: "active" } as Record<string, unknown>,
}));

vi.mock("@/services/sites/store", () => ({
  siteStore: () => ({ getByRepo: async () => mocks.siteByRepo }),
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
vi.mock("@/services/logging/alert", () => ({ alert: mocks.alertMock, deliverOpsAlert: vi.fn() }));
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
        node.maybeSingle = async () => ({ data: mocks.conductorRow, error: null });
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

const REPO = "praxis-build/acme";

function decision(files: Array<Record<string, unknown>>, bodyOverrides: Record<string, unknown> = {}) {
  return {
    id: "d-pp-1",
    tenant_id: "t-pp-1",
    agent_run_id: "run-pp-1",
    decision_class: "engineer.ship-pr",
    body: {
      repo: REPO,
      base_branch: "main",
      head_branch: "product-builder/build",
      title: "build: change",
      body: "",
      files,
      push_to_main: true,
      ...bodyOverrides,
    },
    status: "approved",
    handler: "github.open_pr",
  };
}

beforeEach(() => {
  mocks.callMcpTool.mockReset();
  mocks.alertMock.mockClear();
  mocks.callMcpTool.mockResolvedValue({
    is_error: false,
    content: JSON.stringify({ pushed: true, commit_sha: "abc1234" }),
  });
  mocks.serviceClientMock.mockReset();
  mocks.serviceClientMock.mockImplementation(() => makeServiceClient());
  mocks.tenantResourceRow = { mode: "provisioned", external_ref: { github_full_name: REPO } };
  mocks.tenantResourceError = null;
  mocks.siteByRepo = null;
  mocks.conductorRow = { status: "active" };
  mocks.agentRunsPayload = { target: { github_full_name: REPO }, build_conductor_run_id: "conductor-pp-1" };
  process.env.PRODUCT_BUILDER_ENABLED = "1";
});

function toolNamesCalled(): string[] {
  return mocks.callMcpTool.mock.calls.map((c) => c[2] as string);
}

describe("github.open_pr push_to_main — C3 protected-path bypass guard", () => {
  it("REFUSES push_to_main when the diff touches supabase/migrations/** → falls back to open_pr", async () => {
    await HANDLERS["github.open_pr"](
      decision([
        { path: "src/pages/Home.tsx", action: "modify", content: "x" },
        { path: "supabase/migrations/20260101_add.sql", action: "create", content: "y" },
      ]),
    );
    expect(toolNamesCalled()).toContain("open_pr");
    expect(toolNamesCalled()).not.toContain("push_to_main");
  });

  it("REFUSES when the diff touches an env file (**/.env*) → open_pr", async () => {
    await HANDLERS["github.open_pr"](
      decision([{ path: "apps/backend/.env", action: "modify", content: "SECRET=1" }]),
    );
    expect(toolNamesCalled()).toContain("open_pr");
    expect(toolNamesCalled()).not.toContain("push_to_main");
  });

  it("honors an app-specific protected glob from the repo's external_ref policy", async () => {
    mocks.tenantResourceRow = {
      mode: "provisioned",
      external_ref: { github_full_name: REPO, protected_globs: ["**/payments/**"] },
    };
    await HANDLERS["github.open_pr"](
      decision([{ path: "src/payments/checkout.ts", action: "modify", content: "x" }]),
    );
    expect(toolNamesCalled()).toContain("open_pr");
    expect(toolNamesCalled()).not.toContain("push_to_main");
  });

  it("PAGES when a verified provisioned target refuses the fast-forward (the strand signal)", async () => {
    await HANDLERS["github.open_pr"](
      decision([{ path: ".env.example", action: "modify", content: "DATABASE_URL=" }]),
    );
    expect(toolNamesCalled()).toContain("open_pr");
    expect(mocks.alertMock).toHaveBeenCalledTimes(1);
    const arg = mocks.alertMock.mock.calls[0][0];
    expect(arg.code).toBe("product_build_push_refused");
    expect(arg.tenant_id).toBe("t-pp-1");
    expect(arg.msg).toMatch(/\.env\.example/);
    expect(arg.msg).not.toMatch(/DATABASE_URL=/);
  });

  it("does NOT page when the target was never verified as provisioned (routine open_pr)", async () => {
    mocks.tenantResourceRow = {
      mode: "provisioned",
      external_ref: { github_full_name: "praxis-build/some-other-repo" },
    };
    await HANDLERS["github.open_pr"](
      decision([{ path: "src/pages/Home.tsx", action: "modify", content: "x" }]),
    );
    expect(toolNamesCalled()).toContain("open_pr");
    expect(toolNamesCalled()).not.toContain("push_to_main");
    expect(mocks.alertMock).not.toHaveBeenCalled();
  });

  it("CLEAN diff (no protected paths) still fast-forwards main (push_to_main fires)", async () => {
    const res = await HANDLERS["github.open_pr"](
      decision([{ path: "src/pages/Home.tsx", action: "modify", content: "x" }]),
    );
    expect(res.ok).toBe(true);
    expect(toolNamesCalled()).toContain("push_to_main");
    expect(toolNamesCalled()).not.toContain("open_pr");
  });
});

describe("github.open_pr push_to_main — verified new-flow site repo", () => {
  const SITE_ID = "4e697436-edc6-4e18-9d92-17adccbf898f";
  function asSiteRun() {
    mocks.agentRunsPayload = {
      target: { github_full_name: REPO },
      build_conductor_run_id: "conductor-pp-1",
      stage: "build",
      site_id: SITE_ID,
    };
    mocks.siteByRepo = { id: SITE_ID, tenant_id: "t-pp-1", github_full_name: REPO, status: "building" };
  }

  it("fast-forwards a top-level site migration", async () => {
    asSiteRun();
    const res = await HANDLERS["github.open_pr"](
      decision([
        { path: "src/pages/Book.tsx", action: "create", content: "x" },
        { path: "supabase/migrations/001_grooming_bookings.sql", action: "create", content: "create table x();" },
      ]),
    );
    expect(res.ok).toBe(true);
    expect(toolNamesCalled()).toContain("push_to_main");
    expect(toolNamesCalled()).not.toContain("open_pr");
  });

  it("ignores a stale post-run stamp for a top-level site migration", async () => {
    asSiteRun();
    await HANDLERS["github.open_pr"](
      decision([{ path: "supabase/migrations/001_a.sql", action: "create", content: "y" }], {
        protected_paths: [{ path: "supabase/migrations/001_a.sql", glob: "supabase/migrations/**" }],
      }),
    );
    expect(toolNamesCalled()).toContain("push_to_main");
  });

  it("still refuses when no site of this tenant owns the repo (payload site_id alone is not trusted)", async () => {
    asSiteRun();
    mocks.siteByRepo = null;
    await HANDLERS["github.open_pr"](
      decision([{ path: "supabase/migrations/001_a.sql", action: "create", content: "y" }]),
    );
    expect(toolNamesCalled()).not.toContain("push_to_main");
  });

  it("still refuses when the site row is another site", async () => {
    asSiteRun();
    mocks.siteByRepo = { id: "11111111-1111-4111-8111-111111111111", tenant_id: "t-pp-1", github_full_name: REPO, status: "building" };
    await HANDLERS["github.open_pr"](
      decision([{ path: "supabase/migrations/001_a.sql", action: "create", content: "y" }]),
    );
    expect(toolNamesCalled()).not.toContain("push_to_main");
  });

  it("still refuses deleting a site migration", async () => {
    asSiteRun();
    await HANDLERS["github.open_pr"](decision([{ path: "supabase/migrations/001_a.sql", action: "delete" }]));
    expect(toolNamesCalled()).not.toContain("push_to_main");
  });

  it("still refuses an env file or a nested migration path on a site", async () => {
    asSiteRun();
    await HANDLERS["github.open_pr"](decision([{ path: ".env.local", action: "create", content: "K=1" }]));
    expect(toolNamesCalled()).not.toContain("push_to_main");
    mocks.callMcpTool.mockClear();
    await HANDLERS["github.open_pr"](
      decision([{ path: "supabase/migrations/nested/001.sql", action: "create", content: "y" }]),
    );
    expect(toolNamesCalled()).not.toContain("push_to_main");
  });
});

describe("github.open_pr push_to_main — fresh app build (scaffold/build of a new app)", () => {
  const RUN = "run-pp-1";
  const AUTH_SCAFFOLD = [
    { path: "app/page.tsx", action: "create", content: "x" },
    { path: "app/api/auth/magic/route.ts", action: "create", content: "export {}" },
    { path: "app/api/webhooks/stripe/route.ts", action: "create", content: "export {}" },
    { path: "middleware/session.ts", action: "create", content: "export {}" },
    { path: "middleware.ts", action: "create", content: "export {}" },
    { path: ".env.example", action: "create", content: "DATABASE_URL=" },
  ];
  function graph(stage: string, child: string | null = RUN, rootRefine = false, nodeRefine = false) {
    return [
      { id: "provision", status: "done", payload: { stage: "provision", ...(rootRefine ? { refine_mode: true } : {}) }, child_run_id: null },
      { id: stage, status: "dispatched", payload: { stage, ...(nodeRefine ? { refine_mode: true } : {}) }, child_run_id: child },
    ];
  }
  function asFreshBuild(stage = "scaffold") {
    mocks.agentRunsPayload = { target: { github_full_name: REPO }, build_conductor_run_id: "conductor-pp-1", stage };
    mocks.conductorRow = { status: "active", kind: "build_app", goal_graph: graph(stage) };
  }

  it("fast-forwards a fresh scaffold that writes auth, webhooks, middleware and an env template (even with a stale stamp)", async () => {
    asFreshBuild();
    const res = await HANDLERS["github.open_pr"](
      decision(AUTH_SCAFFOLD, { protected_paths: [{ path: "app/api/auth/magic/route.ts", glob: "**/auth/**" }] }),
    );
    expect(res.ok).toBe(true);
    expect(toolNamesCalled()).toContain("push_to_main");
    expect(toolNamesCalled()).not.toContain("open_pr");
  });

  it("the build stage of a fresh build, and a repair of it (the node's current child), are fresh too", async () => {
    asFreshBuild("build");
    await HANDLERS["github.open_pr"](decision(AUTH_SCAFFOLD));
    expect(toolNamesCalled()).toContain("push_to_main");
    mocks.callMcpTool.mockClear();
    mocks.agentRunsPayload = { target: { github_full_name: REPO }, build_conductor_run_id: "conductor-pp-1", stage: "build", repair_mode: true };
    await HANDLERS["github.open_pr"](decision(AUTH_SCAFFOLD));
    expect(toolNamesCalled()).toContain("push_to_main");
  });

  it("a fresh build still never pushes a real env file, a secrets folder or a migration", async () => {
    for (const f of [
      { path: ".env.local", action: "create", content: "K=1" },
      { path: "secrets/auth/key.txt", action: "create", content: "k" },
      { path: "supabase/migrations/001_a.sql", action: "create", content: "y" },
    ]) {
      asFreshBuild();
      mocks.callMcpTool.mockClear();
      await HANDLERS["github.open_pr"](decision([f]));
      expect(toolNamesCalled(), f.path).not.toContain("push_to_main");
    }
  });

  it("an env template still holds when ANOTHER kept glob matches it (secrets/, or the app's own rules)", async () => {
    const cases: Array<{ path: string; app?: string[] }> = [
      { path: "secrets/.env.example" },
      { path: "config/.env.example", app: ["config/**"] },
      { path: ".env.example", app: [".env.example"] },
    ];
    for (const c of cases) {
      asFreshBuild();
      mocks.callMcpTool.mockClear();
      mocks.tenantResourceRow = { mode: "provisioned", external_ref: { github_full_name: REPO, ...(c.app ? { protected_globs: c.app } : {}) } };
      await HANDLERS["github.open_pr"](
        decision([{ path: c.path, action: "create", content: "X=" }], { protected_paths: [{ path: c.path, glob: "**/.env*" }] }),
      );
      expect(toolNamesCalled(), c.path).not.toContain("push_to_main");
    }
  });

  it("an app that re-protected auth in its own policy keeps that hold even on a fresh build", async () => {
    asFreshBuild();
    mocks.tenantResourceRow = { mode: "provisioned", external_ref: { github_full_name: REPO, protected_globs: ["**/auth/**"] } };
    await HANDLERS["github.open_pr"](decision(AUTH_SCAFFOLD));
    expect(toolNamesCalled()).not.toContain("push_to_main");
  });

  it("a refine (later edit) keeps the full floor: auth is held for a human", async () => {
    mocks.agentRunsPayload = { target: { github_full_name: REPO }, build_conductor_run_id: "conductor-pp-1", stage: "build", refine_mode: true };
    mocks.conductorRow = { status: "active", kind: "build_app", goal_graph: graph("build", RUN, true, true) };
    await HANDLERS["github.open_pr"](decision(AUTH_SCAFFOLD));
    expect(toolNamesCalled()).not.toContain("push_to_main");
  });

  it("a payload that claims fresh is not trusted when the conductor's first node is a refine", async () => {
    asFreshBuild();
    mocks.conductorRow = { status: "active", kind: "build_app", goal_graph: graph("scaffold", RUN, true) };
    await HANDLERS["github.open_pr"](decision(AUTH_SCAFFOLD));
    expect(toolNamesCalled()).not.toContain("push_to_main");
  });

  it("a run that is not the node's current child (an older attempt, another run) is not fresh", async () => {
    asFreshBuild();
    mocks.conductorRow = { status: "active", kind: "build_app", goal_graph: graph("scaffold", "some-other-run") };
    await HANDLERS["github.open_pr"](decision(AUTH_SCAFFOLD));
    expect(toolNamesCalled()).not.toContain("push_to_main");
  });

  it("a non-codegen node (qa) is not fresh", async () => {
    asFreshBuild();
    mocks.conductorRow = { status: "active", kind: "build_app", goal_graph: graph("qa") };
    await HANDLERS["github.open_pr"](decision(AUTH_SCAFFOLD));
    expect(toolNamesCalled()).not.toContain("push_to_main");
  });

  it("no conductor on the run is not fresh", async () => {
    mocks.agentRunsPayload = { target: { github_full_name: REPO }, stage: "scaffold" };
    mocks.conductorRow = { status: "active", kind: "build_app", goal_graph: graph("scaffold") };
    await HANDLERS["github.open_pr"](decision(AUTH_SCAFFOLD));
    expect(toolNamesCalled()).not.toContain("push_to_main");
  });

  it("a user_repo target (the founder's own repo) keeps the full floor", async () => {
    asFreshBuild();
    mocks.agentRunsPayload = {
      target: { github_full_name: REPO, github_target_mode: "user_repo" },
      build_conductor_run_id: "conductor-pp-1",
      stage: "scaffold",
    };
    await HANDLERS["github.open_pr"](decision(AUTH_SCAFFOLD));
    expect(toolNamesCalled()).not.toContain("push_to_main");
  });

  it("a fresh SITE build (new flow) is lifted the same way, with the site migration rule kept", async () => {
    const SITE_ID = "4e697436-edc6-4e18-9d92-17adccbf898f";
    mocks.agentRunsPayload = { target: { github_full_name: REPO }, build_conductor_run_id: "conductor-pp-1", stage: "build", site_id: SITE_ID };
    mocks.conductorRow = { status: "active", kind: "build_app", goal_graph: graph("build") };
    mocks.siteByRepo = { id: SITE_ID, tenant_id: "t-pp-1", github_full_name: REPO, status: "building" };
    await HANDLERS["github.open_pr"](
      decision([
        { path: "src/auth/AuthGate.tsx", action: "create", content: "x" },
        { path: "supabase/migrations/001_bookings.sql", action: "create", content: "create table b();" },
      ]),
    );
    expect(toolNamesCalled()).toContain("push_to_main");
  });

  it("a site repo reached only through the gate's site fallback, without a verified site run, is not lifted", async () => {
    const SITE_ID = "4e697436-edc6-4e18-9d92-17adccbf898f";
    asFreshBuild();
    mocks.tenantResourceRow = { mode: "provisioned", external_ref: { github_full_name: "praxis-build/other" } };
    mocks.siteByRepo = { id: SITE_ID, tenant_id: "t-pp-1", github_full_name: REPO, status: "building" };
    await HANDLERS["github.open_pr"](decision(AUTH_SCAFFOLD));
    expect(toolNamesCalled()).not.toContain("push_to_main");
  });
});
