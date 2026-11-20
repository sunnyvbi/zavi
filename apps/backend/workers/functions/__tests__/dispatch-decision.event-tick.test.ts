import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  callMcpTool: vi.fn(),
  serviceClientMock: vi.fn(),
  send: vi.fn(),
  alertMock: vi.fn(async () => undefined),
  agentRunsPayload: {} as unknown,
  tenantResourceRow: null as null | { mode: string; external_ref: Record<string, unknown> },
  conductorRow: { data: { status: "active" }, error: null } as { data: unknown; error: unknown },
  conductorLookupThrows: false,
  conductorEqs: [] as Array<[string, unknown]>,
  stopGateReads: 0,
  stopGateRow: { data: { status: "active" }, error: null } as { data: unknown; error: unknown },
}));

vi.mock("../../client", () => ({
  inngest: { createFunction: () => ({}), send: mocks.send },
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
vi.mock("@/services/logging/alert", () => ({ alert: mocks.alertMock, deliverOpsAlert: vi.fn() }));
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
import { BUILD_CONDUCTOR_RUN_ID_KEY } from "@/services/billing/tiers";
import {
  CONDUCTOR_TICK_REQUESTED,
  KICK_DEDUPE_WINDOW_MS,
  resetConductorKickDedupe,
} from "@/services/agents/conductor-kick";

const REPO = "praxis-built/acme";
const TENANT = "a7ec7367-acc8-4abc-995b-7da60a572de3";
const CONDUCTOR = "509235e5-bb1b-448c-9a2b-4acdb9ccb0b2";

function makeServiceClient() {
  return {
    from: (table: string) => {
      if (table === "tenant_resources") {
        const node: Record<string, unknown> = {};
        node.select = () => node;
        node.eq = () => node;
        node.maybeSingle = async () => ({ data: mocks.tenantResourceRow, error: null });
        return node;
      }
      if (table === "conductor_runs") {
        const eqs: Array<[string, unknown]> = [];
        const node: Record<string, unknown> = {};
        node.select = () => node;
        node.eq = (col: string, val: unknown) => {
          eqs.push([col, val]);
          return node;
        };
        node.maybeSingle = async () => {
          if (eqs.some(([c, v]) => c === "kind" && v === "build_app")) {
            mocks.stopGateReads += 1;
            return mocks.stopGateRow;
          }
          mocks.conductorEqs.push(...eqs);
          if (mocks.conductorLookupThrows) throw new Error("db down");
          return mocks.conductorRow;
        };
        return node;
      }
      if (table === "agent_runs") {
        const node: Record<string, unknown> = {};
        node.select = () => node;
        node.eq = () => node;
        node.maybeSingle = async () => ({ data: { payload: mocks.agentRunsPayload, parsed: null }, error: null });
        node.update = () => ({ eq: async () => ({ data: null, error: null }) });
        return node;
      }
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.update = () => chain;
      chain.eq = () => chain;
      chain.in = () => chain;
      chain.limit = async () => ({ data: [], error: null });
      chain.maybeSingle = async () => ({ data: null, error: null });
      chain.then = (r: (v: unknown) => unknown) => r({ data: null, error: null });
      return chain;
    },
    rpc: async () => ({ data: null, error: null }),
  };
}

function decision(bodyOverrides: Record<string, unknown> = {}) {
  return {
    id: "d-1",
    tenant_id: TENANT,
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

function tickSends() {
  return mocks.send.mock.calls.filter(
    (c) => (c[0] as { name?: string }).name === CONDUCTOR_TICK_REQUESTED,
  );
}

function tools(): string[] {
  return mocks.callMcpTool.mock.calls.map((c) => c[2] as string);
}

beforeEach(() => {
  resetConductorKickDedupe();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mocks.send.mockReset();
  mocks.send.mockResolvedValue({ ids: ["evt"] });
  mocks.alertMock.mockClear();
  mocks.callMcpTool.mockReset();
  mocks.callMcpTool.mockImplementation(async (_ctx: unknown, _server: string, tool: string) =>
    tool === "push_to_main"
      ? { is_error: false, content: JSON.stringify({ pushed: true, commit_sha: "abc1234" }) }
      : { is_error: false, content: JSON.stringify({ html_url: "https://github.com/x/pull/1", number: 1 }) },
  );
  mocks.serviceClientMock.mockReset();
  mocks.serviceClientMock.mockImplementation(() => makeServiceClient());
  mocks.tenantResourceRow = { mode: "provisioned", external_ref: { github_full_name: REPO } };
  mocks.agentRunsPayload = {
    target: { github_full_name: REPO },
    [BUILD_CONDUCTOR_RUN_ID_KEY]: CONDUCTOR,
  };
  mocks.conductorRow = { data: { status: "active" }, error: null };
  mocks.conductorLookupThrows = false;
  mocks.conductorEqs = [];
  mocks.stopGateReads = 0;
  mocks.stopGateRow = { data: { status: "active" }, error: null };
  process.env.PRODUCT_BUILDER_ENABLED = "1";
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("push_to_main landed → conductor tick", () => {
  it("kicks the run's conductor exactly once, tenant-scoped, after the push lands", async () => {
    const res = await HANDLERS["github.open_pr"](decision());
    expect(res.ok).toBe(true);
    expect(tools()).toEqual(["push_to_main"]);
    expect(tickSends()).toHaveLength(1);
    expect(tickSends()[0][0]).toEqual({
      name: CONDUCTOR_TICK_REQUESTED,
      data: { conductor_run_id: CONDUCTOR },
    });
    expect(mocks.conductorEqs).toEqual([
      ["tenant_id", TENANT],
      ["id", CONDUCTOR],
    ]);
    expect(mocks.stopGateReads).toBe(2);
    const order = mocks.send.mock.calls.map((c) => (c[0] as { name: string }).name);
    expect(order.indexOf(CONDUCTOR_TICK_REQUESTED)).toBeGreaterThan(
      order.indexOf("engineer.postdeploy.verify.requested"),
    );
  });

  it("does not kick when the provisioned gate refuses and the handler falls back to open_pr", async () => {
    mocks.tenantResourceRow = { mode: "connected", external_ref: { github_full_name: REPO } };
    const res = await HANDLERS["github.open_pr"](decision());
    expect(tools()).toContain("open_pr");
    expect(tools()).not.toContain("push_to_main");
    expect(tickSends()).toHaveLength(0);
    expect(res.ok).toBe(true);
  });

  it("does not kick on a protected-path refusal even though the target was verified", async () => {
    await HANDLERS["github.open_pr"](
      decision({ files: [{ path: ".env", action: "create", content: "SECRET=1" }] }),
    );
    expect(tools()).not.toContain("push_to_main");
    expect(mocks.alertMock).toHaveBeenCalledWith(
      expect.objectContaining({ code: "product_build_push_refused" }),
    );
    expect(tickSends()).toHaveLength(0);
  });

  it("does not kick when the GitHub push itself fails", async () => {
    mocks.callMcpTool.mockResolvedValue({ is_error: true, content: "403 forbidden" });
    const res = await HANDLERS["github.open_pr"](decision());
    expect(res.ok).toBe(false);
    expect(tickSends()).toHaveLength(0);
    expect(mocks.conductorEqs).toEqual([]);
  });

  it("does not kick for a push whose run is not a conductor build step", async () => {
    mocks.agentRunsPayload = { target: { github_full_name: REPO } };
    const res = await HANDLERS["github.open_pr"](decision());
    expect(res.ok).toBe(true);
    expect(tickSends()).toHaveLength(0);
  });

  it("does not kick a conductor that is no longer active", async () => {
    mocks.conductorRow = { data: { status: "done" }, error: null };
    const res = await HANDLERS["github.open_pr"](decision());
    expect(res.ok).toBe(true);
    expect(tools()).toEqual(["push_to_main"]);
    expect(tickSends()).toHaveLength(0);
  });

  it("a build stopped before publication neither pushes nor kicks", async () => {
    mocks.stopGateRow = { data: { status: "cancelled" }, error: null };
    const res = await HANDLERS["github.open_pr"](decision());
    expect(res.ok).toBe(false);
    expect(tools()).toEqual([]);
    expect(tickSends()).toHaveLength(0);
    expect(mocks.conductorEqs).toEqual([]);
  });

  it("a rejected tick send never fails the landed dispatch", async () => {
    mocks.send.mockImplementation(async (e: { name: string }) => {
      if (e.name === CONDUCTOR_TICK_REQUESTED) throw new Error("401 Event key not found");
      return { ids: ["evt"] };
    });
    const res = await HANDLERS["github.open_pr"](decision());
    expect(res.ok).toBe(true);
    expect(tickSends()).toHaveLength(1);
  });

  it("a throwing conductor lookup never fails the landed dispatch", async () => {
    mocks.conductorLookupThrows = true;
    const res = await HANDLERS["github.open_pr"](decision());
    expect(res.ok).toBe(true);
    expect(tools()).toEqual(["push_to_main"]);
    expect(tickSends()).toHaveLength(0);
  });

  it("dedupes repeat landings for the same conductor inside the window, then kicks again after it", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    await HANDLERS["github.open_pr"](decision());
    await HANDLERS["github.open_pr"](decision());
    expect(tickSends()).toHaveLength(1);
    now.mockReturnValue(1_000_000 + KICK_DEDUPE_WINDOW_MS);
    await HANDLERS["github.open_pr"](decision());
    expect(tickSends()).toHaveLength(2);
  });

  it("a failed send does not burn the dedupe slot, so the next landing retries", async () => {
    let fail = true;
    mocks.send.mockImplementation(async (e: { name: string }) => {
      if (e.name === CONDUCTOR_TICK_REQUESTED && fail) throw new Error("blip");
      return { ids: ["evt"] };
    });
    await HANDLERS["github.open_pr"](decision());
    fail = false;
    await HANDLERS["github.open_pr"](decision());
    expect(tickSends()).toHaveLength(2);
  });
});
