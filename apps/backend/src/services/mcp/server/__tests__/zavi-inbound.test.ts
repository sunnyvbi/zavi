
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/services/supabase", () => ({
  serviceClient: vi.fn(),
}));
vi.mock("@/services/agents/runner", () => ({
  listAgentRuns: vi.fn(),
  getAgentRunById: vi.fn(),
  enqueueAgentRun: vi.fn(),
  AgentNotFoundError: class AgentNotFoundError extends Error {
    constructor(slug: string) {
      super(`Agent "${slug}" not found in src/agents/`);
      this.name = "AgentNotFoundError";
    }
  },
  BROWSER_OPERATOR_ALLOWED_TRIGGERS: new Set(),
}));
vi.mock("@/services/agents/registry", () => ({
  listAgents: vi.fn(() => []),
}));
vi.mock("@/services/agents/visibility", () => ({
  filterTenantVisibleAgents: vi.fn(),
}));
vi.mock("@/services/auth/members", () => ({
  canUserAccessAgent: vi.fn(),
}));
vi.mock("@/services/tenant-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/tenant-client")>();
  return { ...actual, tenantClient: vi.fn(actual.tenantClient), tenantRpc: vi.fn() };
});
vi.mock("@/services/auth/tenant-role", () => ({ loadTenantRoleFor: vi.fn() }));
vi.mock("@/services/growth/cgo-tests", () => ({ readDueTests: vi.fn() }));
vi.mock("@/services/growth/goal-write", () => ({ writeAutopilotGoal: vi.fn() }));
vi.mock("@/services/growth/goal-owner", () => ({ syncGoalWork: vi.fn() }));
vi.mock("@/services/analytics/record-metric-snapshot", () => ({ recordMetricSnapshot: vi.fn() }));
vi.mock("@/services/logging/logEvent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/logging/logEvent")>()),
  logEvent: vi.fn(),
}));

import { anyWordQuery, handleZaviTool, ZAVI_INBOUND_TOOL_LIST, ZAVI_ASK_WAIT_MS, READ_CAP_MS } from "@/services/mcp/server/zavi-inbound";
import { logEvent } from "@/services/logging/logEvent";
import { callerHasScope, TOOL_SCOPES } from "@/services/auth/pat";
import type { McpCaller } from "@/services/auth/oauth/verifier";
import { asTenantId } from "@/services/tenant-client";
import { serviceClient } from "@/services/supabase";
import {
  listAgentRuns,
  getAgentRunById,
  enqueueAgentRun,
  AgentNotFoundError,
} from "@/services/agents/runner";
import { filterTenantVisibleAgents } from "@/services/agents/visibility";
import { canUserAccessAgent } from "@/services/auth/members";
import { MCP_AGENT_CATALOG } from "@/services/mcp/server/agent-catalog";

const TENANT_A = "11111111-aaaa-aaaa-aaaa-111111111111";
const TENANT_B = "22222222-bbbb-bbbb-bbbb-222222222222";
const USER_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

function caller(scopes: string[], tenant = TENANT_A): McpCaller {
  return {
    user_id: USER_A,
    tenant_id: asTenantId(tenant),
    scopes,
    credential_kind: "pat",
    pat_id: "pat-1",
    oauth_access_token_id: null,
  };
}

const readCaller = caller(["read"]);
const runCaller = caller(["read", "run"]);

function parse(res: { content: { text: string }[] }): any {
  return JSON.parse(res.content[0].text);
}

function makeQueryStub(result: { data: unknown; error: unknown }) {
  const calls: { method: string; args: unknown[] }[] = [];
  const builder: any = {};
  const chain = (method: string) => (...args: unknown[]) => {
    calls.push({ method, args });
    return builder;
  };
  for (const m of [
    "select",
    "eq",
    "is",
    "not",
    "ilike",
    "textSearch",
    "order",
    "limit",
    "gte",
  ]) {
    builder[m] = chain(m);
  }
  builder.maybeSingle = vi.fn(() => Promise.resolve(result));
  builder.then = (onFulfilled: (v: unknown) => unknown) =>
    Promise.resolve(result).then(onFulfilled);
  return { builder, calls };
}

function noChildrenClient() {
  const b: any = { from: () => b, select: () => b, eq: () => b, in: () => b, limit: async () => ({ data: [], error: null }) };
  return b;
}

beforeEach(() => {
  vi.clearAllMocks();
  (serviceClient as any).mockImplementation(noChildrenClient);
});

describe("callerHasScope / TOOL_SCOPES", () => {
  it("every read tool requires the 'read' scope", () => {
    for (const t of [
      "zavi_list_agents",
      "zavi_get_run_status",
      "zavi_recent_runs",
      "zavi_read_brain",
      "zavi_search",
      "zavi_fetch",
    ]) {
      expect(TOOL_SCOPES[t]).toBe("read");
      expect(callerHasScope({ scopes: ["read"] }, t)).toBe(true);
      expect(callerHasScope({ scopes: ["run"] }, t)).toBe(false);
      expect(callerHasScope({ scopes: [] }, t)).toBe(false);
    }
  });

  it("run tools require the 'run' scope; a read-only token cannot run", () => {
    for (const t of ["zavi_run_agent", "zavi_ask"]) {
      expect(TOOL_SCOPES[t]).toBe("run");
      expect(callerHasScope({ scopes: ["run"] }, t)).toBe(true);
      expect(callerHasScope({ scopes: ["read"] }, t)).toBe(false);
    }
  });

  it("an unknown tool is denied even with every scope (fail-closed)", () => {
    expect(callerHasScope({ scopes: ["read", "run", "admin"] }, "bogus_tool")).toBe(false);
    expect(TOOL_SCOPES["bogus_tool"]).toBeUndefined();
  });

  it("the default mint scopes never include admin", () => {
    expect(Object.values(TOOL_SCOPES)).not.toContain(undefined);
    expect(Object.values(TOOL_SCOPES).includes("admin")).toBe(false);
  });
});

describe("handleZaviTool — scope enforcement", () => {
  it("rejects a read-scope token calling a run tool BEFORE any data access", async () => {
    const res = await handleZaviTool("zavi_run_agent", { slug: "engineer" }, readCaller);
    expect(res.isError).toBe(true);
    expect(parse(res).error).toMatch(/scope_denied/);
    expect(canUserAccessAgent).not.toHaveBeenCalled();
    expect(enqueueAgentRun).not.toHaveBeenCalled();
  });

  it("rejects zavi_ask without the run scope", async () => {
    const res = await handleZaviTool("zavi_ask", { message: "ship a fix" }, readCaller);
    expect(res.isError).toBe(true);
    expect(parse(res).error).toMatch(/scope_denied/);
    expect(enqueueAgentRun).not.toHaveBeenCalled();
  });

  it("rejects a read tool when the token carries NO scopes at all", async () => {
    const res = await handleZaviTool("zavi_read_brain", {}, caller([]));
    expect(res.isError).toBe(true);
    expect(parse(res).error).toMatch(/scope_denied/);
    expect(serviceClient).not.toHaveBeenCalled();
  });

  it("returns a distinct error for an unknown tool", async () => {
    const res = await handleZaviTool("zavi_delete_everything", {}, runCaller);
    expect(res.isError).toBe(true);
    expect(parse(res).error).toMatch(/unknown tool/);
  });
});

describe("handleZaviTool — legacy praxis_* alias (back-compat)", () => {
  it("routes a legacy praxis_run_agent call through the SAME run-scope gate", async () => {
    const res = await handleZaviTool("praxis_run_agent", { slug: "engineer" }, readCaller);
    expect(res.isError).toBe(true);
    expect(parse(res).error).toMatch(/scope_denied/);
    expect(enqueueAgentRun).not.toHaveBeenCalled();
  });

  it("still surfaces an unknown legacy tool as unknown (alias never masks it)", async () => {
    const res = await handleZaviTool("praxis_delete_everything", {}, runCaller);
    expect(res.isError).toBe(true);
    expect(parse(res).error).toMatch(/unknown tool/);
  });
});

describe("handleZaviTool — tenant isolation", () => {
  it("zavi_get_run_status hides a run owned by another tenant", async () => {
    (getAgentRunById as any).mockImplementation((tid: string, id: string) =>
      Promise.resolve(
        id === "run-xyz" && tid === TENANT_B
          ? { id: "run-xyz", tenant_id: TENANT_B, status: "success", input_payload_raw: null }
          : null,
      ),
    );
    const res = await handleZaviTool(
      "zavi_get_run_status",
      { run_id: "run-xyz" },
      runCaller,
    );
    expect(res.isError).toBe(true);
    expect(parse(res).error).toMatch(/not found/);
  });

  it("zavi_get_run_status returns a same-tenant run", async () => {
    (getAgentRunById as any).mockResolvedValue({
      id: "run-abc",
      tenant_id: TENANT_A,
      status: "success",
      input_payload_raw: null,
    });
    const res = await handleZaviTool("zavi_get_run_status", { run_id: "run-abc" }, readCaller);
    expect(res.isError).toBeUndefined();
    expect(parse(res).run_id).toBe("run-abc");
  });

  it("zavi_get_run_status does NOT poll-follow a delegated child of another tenant", async () => {
    (getAgentRunById as any).mockImplementation((tid: string, id: string) => {
      if (id === "parent-1" && tid === TENANT_A)
        return Promise.resolve({
          id: "parent-1",
          tenant_id: TENANT_A,
          status: "running",
          input_payload_raw: { delegated_child_run_id: "child-evil" },
        });
      return Promise.resolve(null);
    });
    const res = await handleZaviTool("zavi_get_run_status", { run_id: "parent-1" }, readCaller);
    expect(res.isError).toBeUndefined();
    const body = parse(res);
    expect(body.run_id).toBe("parent-1");
    expect(body.delegated_from).toBeUndefined();
  });

  it("zavi_recent_runs forwards caller.tenant_id to the runner (never client input)", async () => {
    (listAgentRuns as any).mockResolvedValue([{ id: "r1" }]);
    await handleZaviTool("zavi_recent_runs", { limit: 5, slug: "engineer" }, readCaller);
    expect(listAgentRuns).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: TENANT_A, agent_slug: "engineer", limit: 5 }),
    );
  });

  it("zavi_read_brain scopes the query to caller.tenant_id with an explicit eq", async () => {
    const { builder, calls } = makeQueryStub({ data: [{ id: "n1", title: "t" }], error: null });
    (serviceClient as any).mockReturnValue({ from: () => builder });
    await handleZaviTool("zavi_read_brain", {}, readCaller);
    const eqTenant = calls.find((c) => c.method === "eq" && c.args[0] === "tenant_id");
    expect(eqTenant).toBeDefined();
    expect(eqTenant!.args[1]).toBe(TENANT_A);
  });

  it("zavi_fetch (note) scopes by tenant_id and resolves a same-tenant note", async () => {
    const { builder, calls } = makeQueryStub({
      data: { id: "n7", title: "Brain note", body_markdown: "body" },
      error: null,
    });
    (serviceClient as any).mockReturnValue({ from: () => builder });
    const res = await handleZaviTool("zavi_fetch", { id: "note:n7" }, readCaller);
    expect(res.isError).toBeUndefined();
    const eqTenant = calls.find((c) => c.method === "eq" && c.args[0] === "tenant_id");
    expect(eqTenant!.args[1]).toBe(TENANT_A);
    expect(parse(res).id).toBe("note:n7");
    expect(parse(res).url).toMatch(/\/memory\/n7$/);
  });

  it("zavi_fetch returns not-found when the row is absent (cross-tenant id filtered out)", async () => {
    const { builder } = makeQueryStub({ data: null, error: null });
    (serviceClient as any).mockReturnValue({ from: () => builder });
    const res = await handleZaviTool("zavi_fetch", { id: "note:someone-elses-note" }, readCaller);
    expect(res.isError).toBe(true);
    expect(parse(res).error).toMatch(/not found/);
  });

  it("zavi_search scopes BOTH the notes and runs queries to caller.tenant_id", async () => {
    const allCalls: { method: string; args: unknown[] }[] = [];
    (serviceClient as any).mockReturnValue({
      from: () => {
        const { builder, calls } = makeQueryStub({ data: [], error: null });
        const origEq = builder.eq;
        builder.eq = (...a: unknown[]) => {
          allCalls.push({ method: "eq", args: a });
          return origEq(...a);
        };
        void calls;
        return builder;
      },
    });
    await handleZaviTool("zavi_search", { query: "weekend bookings" }, readCaller);
    const tenantEqs = allCalls.filter((c) => c.args[0] === "tenant_id");
    expect(tenantEqs.length).toBe(3);
    expect(tenantEqs.every((c) => c.args[1] === TENANT_A)).toBe(true);
  });

  function searchClient(notesFor: (query: string) => unknown[]) {
    const queries: string[] = [];
    (serviceClient as any).mockReturnValue({
      from: (table: string) => {
        const result: { data: unknown; error: unknown } = { data: [], error: null };
        const { builder } = makeQueryStub(result);
        if (table === "memory_note") {
          builder.textSearch = (_col: string, query: string) => {
            queries.push(query);
            result.data = notesFor(query);
            return builder;
          };
        }
        return builder;
      },
    });
    return queries;
  }

  it("zavi_search retries with any of the words when all of them together find nothing", async () => {
    const queries = searchClient((query) => (query === "pricing or notes" ? [{ id: "n1", title: "Pricing page" }] : []));
    const body = parse(await handleZaviTool("zavi_search", { query: "pricing notes" }, readCaller));
    expect(queries).toEqual(["pricing notes", "pricing or notes"]);
    expect(body.results.map((r: any) => r.id)).toEqual(["note:n1"]);
  });

  it("zavi_search does not retry when the first pass finds something, or the query is one word", async () => {
    const hit = searchClient(() => [{ id: "n1", title: "Pricing page" }]);
    await handleZaviTool("zavi_search", { query: "pricing notes" }, readCaller);
    expect(hit).toEqual(["pricing notes"]);

    const oneWord = searchClient(() => []);
    const body = parse(await handleZaviTool("zavi_search", { query: "pricing" }, readCaller));
    expect(oneWord).toEqual(["pricing"]);
    expect(body.results).toEqual([]);
  });

  it("zavi_search says the search failed when the retry errors, not that nothing matched", async () => {
    let pass = 0;
    (serviceClient as any).mockReturnValue({
      from: (table: string) => {
        const result: { data: unknown; error: unknown } = { data: [], error: null };
        const { builder } = makeQueryStub(result);
        if (table === "memory_note") {
          builder.textSearch = () => {
            pass += 1;
            if (pass === 2) {
              result.data = null;
              result.error = { message: "search is unavailable" };
            }
            return builder;
          };
        }
        return builder;
      },
    });
    const res = await handleZaviTool("zavi_search", { query: "pricing notes" }, readCaller);
    expect(pass).toBe(2);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/search is unavailable/);
  });

  it("anyWordQuery keeps letters and digits only, drops repeats, and needs two words", () => {
    expect(anyWordQuery("pricing notes")).toBe("pricing or notes");
    expect(anyWordQuery('"Pricing" -notes pricing OR plan2')).toBe("pricing or notes or plan2");
    expect(anyWordQuery("pricing")).toBeNull();
    expect(anyWordQuery("  ")).toBeNull();
  });

  it("zavi_list_agents authorizes each agent against caller.user_id + tenant_id", async () => {
    (filterTenantVisibleAgents as any).mockResolvedValue([
      { slug: "operator", name: "Operator", description: "runs ops" },
    ]);
    (canUserAccessAgent as any).mockResolvedValue(true);
    await handleZaviTool("zavi_list_agents", {}, readCaller);
    expect(filterTenantVisibleAgents).toHaveBeenCalledWith(expect.anything(), TENANT_A);
    expect(canUserAccessAgent).toHaveBeenCalledWith(
      expect.anything(),
      USER_A,
      TENANT_A,
      "operator",
    );
  });
});

describe("handleZaviTool — run authorization", () => {
  it("zavi_run_agent refuses when the caller's role may not run (viewer / non-member)", async () => {
    (canUserAccessAgent as any).mockResolvedValue(false);
    const res = await handleZaviTool("zavi_run_agent", { slug: "secret-agent" }, runCaller);
    expect(res.isError).toBe(true);
    expect(parse(res).error).toMatch(/not found, or your role is read-only/);
    expect(enqueueAgentRun).not.toHaveBeenCalled();
  });

  it("zavi_run_agent strips server-only provenance keys from the client's payload (autopilot tracking T1)", async () => {
    (canUserAccessAgent as any).mockResolvedValue(true);
    (enqueueAgentRun as any).mockResolvedValue({ run_id: "new-run" });
    await handleZaviTool(
      "zavi_run_agent",
      { slug: "engineer", payload: { x: 1, source_decision_id: "d", dispatched_by: "cgo", cgo_hire: {}, email_plan: { mode: "weekly_plan" } } },
      runCaller,
    );
    const payload = (enqueueAgentRun as any).mock.calls.at(-1)[0].payload;
    expect(payload).toEqual({ x: 1 });
  });

  it("zavi_run_agent never starts cgo's goal review (its children are a2a, outside the assistant ad hold)", async () => {
    (canUserAccessAgent as any).mockResolvedValue(true);
    (enqueueAgentRun as any).mockResolvedValue({ run_id: "new-run" });
    await handleZaviTool("zavi_run_agent", { slug: "cgo", payload: { stage: "own_goals", autopilot: true } }, runCaller);
    expect((enqueueAgentRun as any).mock.calls.at(-1)[0].payload).toEqual({ autopilot: true });
    await handleZaviTool("zavi_run_agent", { slug: "research", payload: { stage: "own_goals" } }, runCaller);
    expect((enqueueAgentRun as any).mock.calls.at(-1)[0].payload).toEqual({ stage: "own_goals" });
  });

  it("zavi_run_agent enqueues with trigger 'mcp' + caller.tenant_id when allowed", async () => {
    (canUserAccessAgent as any).mockResolvedValue(true);
    (enqueueAgentRun as any).mockResolvedValue({ run_id: "new-run" });
    const res = await handleZaviTool(
      "zavi_run_agent",
      { slug: "engineer", payload: { x: 1 } },
      runCaller,
    );
    expect(res.isError).toBeUndefined();
    expect(enqueueAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({
        agent_slug: "engineer",
        tenant_id: TENANT_A,
        trigger: "mcp",
        actor_user_id: USER_A,
      }),
    );
    expect(parse(res).run_id).toBe("new-run");
  });

  it("zavi_ask enqueues the operator agent (front-door) with trigger 'mcp'", async () => {
    (canUserAccessAgent as any).mockResolvedValue(true);
    (enqueueAgentRun as any).mockResolvedValue({ run_id: "op-run" });
    await handleZaviTool("zavi_ask", { message: "what did the last support run find?" }, runCaller);
    expect(enqueueAgentRun).toHaveBeenCalledTimes(1);
    expect(enqueueAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({ agent_slug: "operator", tenant_id: TENANT_A, trigger: "mcp", actor_user_id: USER_A }),
    );
  });

  it("zavi_ask starts a growth question on the growth agent, as an answer-only run, with no operator run", async () => {
    (canUserAccessAgent as any).mockResolvedValue(true);
    (enqueueAgentRun as any).mockResolvedValue({ run_id: "cgo-run" });
    const message = "Which one channel should we focus on this week?";
    await handleZaviTool("zavi_ask", { message }, caller(["run"]));
    expect(enqueueAgentRun).toHaveBeenCalledTimes(1);
    expect(enqueueAgentRun).toHaveBeenCalledWith({
      agent_slug: "cgo",
      tenant_id: TENANT_A,
      trigger: "mcp",
      payload: { intent: message, message, current_user_text_raw: message, user_id: USER_A, source: "mcp", conversation_answer: true },
      actor_user_id: USER_A,
    });
  });

  it.each(["AgentNotFoundError", "SafetyGateError", "PlanUpgradeRequiredError"])(
    "zavi_ask falls back to the operator when the growth agent cannot run (%s)",
    async (name) => {
      (canUserAccessAgent as any).mockResolvedValue(true);
      const refused = new Error("cgo is off for this workspace");
      refused.name = name;
      (enqueueAgentRun as any).mockRejectedValueOnce(refused).mockResolvedValueOnce({ run_id: "op-run" });
      const res = await handleZaviTool("zavi_ask", { message: "plan my growth" }, caller(["run"]));
      expect(parse(res)).toEqual({ run_id: "op-run" });
      expect((enqueueAgentRun as any).mock.calls.map((c: any[]) => c[0].agent_slug)).toEqual(["cgo", "operator"]);
    },
  );

  it("zavi_ask starts every ask on the operator when MCP_ASK_DIRECT_GROWTH=0", async () => {
    vi.stubEnv("MCP_ASK_DIRECT_GROWTH", "0");
    try {
      (canUserAccessAgent as any).mockResolvedValue(true);
      (enqueueAgentRun as any).mockResolvedValue({ run_id: "op-run" });
      await handleZaviTool("zavi_ask", { message: "plan my growth" }, caller(["run"]));
      expect((enqueueAgentRun as any).mock.calls.map((c: any[]) => c[0].agent_slug)).toEqual(["operator"]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    ["InsufficientCreditsError", 'Agent "operator" rejected: out of credits — top up to keep running'],
    ["BuildCreditsExhaustedError", 'Agent "operator" rejected: no build credits remaining this period'],
    ["PlanUpgradeRequiredError", "Upgrade to Pro ($240/mo) to run operator."],
    ["BudgetExceededError", 'Agent "operator" rejected: tenant daily budget cap ($25) reached'],
  ])("a %s reaches the assistant without a purchase prompt or price", async (name, message) => {
    (canUserAccessAgent as any).mockResolvedValue(true);
    const e = new Error(message);
    e.name = name;
    (enqueueAgentRun as any).mockRejectedValue(e);
    const res = await handleZaviTool("zavi_ask", { message: "plan my growth" }, runCaller);
    expect(res.isError).toBe(true);
    const text = parse(res).error as string;
    expect(text).not.toBe(message);
    expect(text).not.toMatch(/top up|upgrade|\$|\/mo/i);
  });

  it("passes other errors through unchanged", async () => {
    (canUserAccessAgent as any).mockResolvedValue(true);
    (enqueueAgentRun as any).mockRejectedValue(new Error("fleet halted"));
    const res = await handleZaviTool("zavi_ask", { message: "plan my growth" }, runCaller);
    expect(parse(res).error).toBe("fleet halted");
  });

  it("rejects malformed args at the schema layer (no slug)", async () => {
    const res = await handleZaviTool("zavi_run_agent", {}, runCaller);
    expect(res.isError).toBe(true);
    expect(parse(res).error).toMatch(/invalid args/);
    expect(canUserAccessAgent).not.toHaveBeenCalled();
  });
});

describe("zavi_list_agents / zavi_run_agent — user-facing agent surface", () => {
  it("lists only catalogued agents, with the catalog's name and description instead of agent.md's", async () => {
    (filterTenantVisibleAgents as any).mockResolvedValue([
      { slug: "operator", name: "operator", description: "Operator-pulled front-door chat via praxis__action." },
      { slug: "browser-operator", name: "browser-operator", description: "RETIRED (internal plan note)." },
      { slug: "uncatalogued-agent", name: "uncatalogued-agent", description: "" },
    ]);
    (canUserAccessAgent as any).mockResolvedValue(true);
    const body = parse(await handleZaviTool("zavi_list_agents", {}, readCaller));
    expect(body).toEqual([
      {
        slug: "operator",
        name: MCP_AGENT_CATALOG.operator.name,
        description: MCP_AGENT_CATALOG.operator.description,
        can_run: true,
      },
    ]);
  });

  it("refuses the retired browser-operator as not found, before any access check or enqueue", async () => {
    (canUserAccessAgent as any).mockResolvedValue(true);
    const res = await handleZaviTool("zavi_run_agent", { slug: "browser-operator" }, runCaller);
    expect(res.isError).toBe(true);
    expect(parse(res).error).toBe("agent browser-operator not found");
    expect(canUserAccessAgent).not.toHaveBeenCalled();
    expect(enqueueAgentRun).not.toHaveBeenCalled();
  });

  it("an unknown slug says not found without the server's source path", async () => {
    (canUserAccessAgent as any).mockResolvedValue(true);
    (enqueueAgentRun as any).mockRejectedValue(new AgentNotFoundError("not-a-real-agent"));
    const res = await handleZaviTool("zavi_run_agent", { slug: "not-a-real-agent" }, runCaller);
    expect(res.isError).toBe(true);
    expect(parse(res).error).toBe("agent not-a-real-agent not found");
  });

  it("declares payload as an optional JSON object", () => {
    const tool = ZAVI_INBOUND_TOOL_LIST.find((t) => t.name === "zavi_run_agent")!;
    expect((tool.inputSchema.properties as any).payload).toMatchObject({ type: "object" });
    expect(tool.inputSchema.required).toEqual(["slug"]);
  });

  it.each([
    ["an object", { competitors: ["a", "b"] }, { competitors: ["a", "b"] }],
    ["a JSON-encoded object", '{"competitors":["a","b"]}', { competitors: ["a", "b"] }],
    ["a JSON-encoded object with a reserved key", '{"x":1,"dispatched_by":"cgo"}', { x: 1 }],
    ["plain text", "compare our pricing to Acme", { message: "compare our pricing to Acme" }],
    ["a JSON-encoded array", '["a"]', { message: '["a"]' }],
    ["a blank string", "  ", undefined],
    ["null", null, undefined],
  ])("accepts %s as the payload", async (_label, payload, expected) => {
    (canUserAccessAgent as any).mockResolvedValue(true);
    (enqueueAgentRun as any).mockResolvedValue({ run_id: "new-run" });
    const res = await handleZaviTool("zavi_run_agent", { slug: "research", payload }, runCaller);
    expect(res.isError).toBeUndefined();
    expect((enqueueAgentRun as any).mock.calls.at(-1)[0].payload).toEqual(expected);
  });

  it.each([
    ["an array", ["a"]],
    ["a number", 42],
  ])("refuses %s as the payload at the schema layer", async (_label, payload) => {
    (canUserAccessAgent as any).mockResolvedValue(true);
    const res = await handleZaviTool("zavi_run_agent", { slug: "research", payload }, runCaller);
    expect(res.isError).toBe(true);
    expect(parse(res).error).toMatch(/invalid args/);
    expect(enqueueAgentRun).not.toHaveBeenCalled();
  });
});

describe("zavi_read_brain — FTS alignment (Gap 3)", () => {
  it("pushes the query into a parameterized textSearch on the tsv column", async () => {
    const { builder, calls } = makeQueryStub({ data: [{ id: "n1" }], error: null });
    (serviceClient as any).mockReturnValue({ from: () => builder });
    await handleZaviTool("zavi_read_brain", { query: "weekend bookings" }, readCaller);
    const fts = calls.find((c) => c.method === "textSearch");
    expect(fts).toBeDefined();
    expect(fts!.args[0]).toBe("tsv");
    expect(fts!.args[1]).toBe("weekend bookings");
    expect(fts!.args[2]).toEqual({ type: "websearch" });
  });

  it("does NOT apply textSearch when no query is given (recency listing)", async () => {
    const { builder, calls } = makeQueryStub({ data: [{ id: "n1" }], error: null });
    (serviceClient as any).mockReturnValue({ from: () => builder });
    await handleZaviTool("zavi_read_brain", { limit: 5 }, readCaller);
    expect(calls.find((c) => c.method === "textSearch")).toBeUndefined();
    expect(calls.find((c) => c.method === "is" && c.args[0] === "superseded_by")).toBeDefined();
    expect(calls.find((c) => c.method === "order")).toBeDefined();
  });

  it("still applies the optional slug filter alongside FTS", async () => {
    const { builder, calls } = makeQueryStub({ data: [], error: null });
    (serviceClient as any).mockReturnValue({ from: () => builder });
    await handleZaviTool(
      "zavi_read_brain",
      { query: "payouts", slug: "company" },
      readCaller,
    );
    expect(calls.find((c) => c.method === "eq" && c.args[0] === "slug" && c.args[1] === "company")).toBeDefined();
    expect(calls.find((c) => c.method === "textSearch")).toBeDefined();
  });

  it("propagates a DB error as an isError result (no silent empty)", async () => {
    const { builder } = makeQueryStub({ data: null, error: { message: "fts boom" } });
    (serviceClient as any).mockReturnValue({ from: () => builder });
    const res = await handleZaviTool("zavi_read_brain", { query: "x" }, readCaller);
    expect(res.isError).toBe(true);
    expect(parse(res).error).toMatch(/fts boom/);
  });
});

function fullRunRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-abc",
    agent_slug: "operator",
    tenant_id: TENANT_A,
    agent_definition_path: "agents/operator/agent.md",
    agent_definition_hash: "sha-123",
    trigger: "mcp",
    started_at: "2026-10-16T10:00:00Z",
    finished_at: "2026-10-16T10:01:00Z",
    status: "success",
    input_payload_raw: { message: "hi", source: "mcp" },
    prompt_snapshot: "",
    raw_response_text: "",
    parsed: { decision: "answer" },
    parse_ok: true,
    output_text: "Signups dipped because the trial page 404s.",
    decisions_emitted: [],
    cost_tokens: 1200,
    cost_usd: 0.03,
    tool_calls: [{ tool: "operator_db", input: "select 1" }],
    error: undefined,
    outcome: null,
    presentation_status: "answered",
    ...overrides,
  };
}

describe("run responses — trimmed to user-facing fields", () => {
  const DETAIL_KEYS = [
    "agent_slug",
    "error",
    "finished_at",
    "presentation_status",
    "result",
    "run_id",
    "started_at",
    "status",
  ];

  it("zavi_get_run_status returns the result, never the internal row or a link", async () => {
    (getAgentRunById as any).mockResolvedValue(fullRunRow());
    const body = parse(
      await handleZaviTool("zavi_get_run_status", { run_id: "run-abc" }, readCaller),
    );
    expect(Object.keys(body).sort()).toEqual(DETAIL_KEYS);
    expect(body).toMatchObject({
      run_id: "run-abc",
      agent_slug: "operator",
      status: "success",
      presentation_status: "answered",
      result: "Signups dipped because the trial page 404s.",
      error: null,
    });
  });

  it("zavi_get_run_status shows a provider usage limit as the web's plain copy, not the raw text", async () => {
    (getAgentRunById as any).mockResolvedValueOnce(
      fullRunRow({
        status: "dispatch_error",
        output_text: "",
        parsed: null,
        error: "Claude Code returned an error result: You've hit your limit · resets 7pm (UTC)",
      }),
    );
    const body = parse(
      await handleZaviTool("zavi_get_run_status", { run_id: "run-abc" }, readCaller),
    );
    expect(body.error).toMatch(/usage limit on the AI service/);
    expect(body.error).toMatch(/7pm \(UTC\)/);
    expect(body.error).not.toMatch(/Claude Code|hit your limit/);
  });

  it("falls back to the structured output when the run wrote no text, else null", async () => {
    (getAgentRunById as any).mockResolvedValueOnce(fullRunRow({ output_text: "  " }));
    const structured = parse(
      await handleZaviTool("zavi_get_run_status", { run_id: "run-abc" }, readCaller),
    );
    expect(JSON.parse(structured.result)).toEqual({ decision: "answer" });

    (getAgentRunById as any).mockResolvedValueOnce(
      fullRunRow({ status: "running", output_text: "", parsed: null, finished_at: "" }),
    );
    const running = parse(
      await handleZaviTool("zavi_get_run_status", { run_id: "run-abc" }, readCaller),
    );
    expect(running.result).toBeNull();
    expect(running.finished_at).toBeNull();
  });

  it("a handed-off run returns the specialist's trimmed run, marked delegated_from", async () => {
    (getAgentRunById as any).mockImplementation((_tid: string, id: string) =>
      Promise.resolve(
        id === "parent-1"
          ? fullRunRow({ id: "parent-1", input_payload_raw: { delegated_child_run_id: "child-1" } })
          : fullRunRow({ id: "child-1", agent_slug: "research", output_text: "Specialist answer" }),
      ),
    );
    const body = parse(
      await handleZaviTool("zavi_get_run_status", { run_id: "parent-1" }, readCaller),
    );
    expect(Object.keys(body).sort()).toEqual([...DETAIL_KEYS, "delegated_from"].sort());
    expect(body).toMatchObject({
      run_id: "child-1",
      agent_slug: "research",
      result: "Specialist answer",
      delegated_from: "parent-1",
    });
  });

  it("an MCP run whose payload link was never written follows its single hand-off child by parent_run_id", async () => {
    const filters: Array<[string, unknown]> = [];
    const inFilters: Array<[string, unknown]> = [];
    let rows: Array<{ id: string }> = [{ id: "child-2" }];
    (serviceClient as any).mockReturnValue({
      from: () => {
        const b: any = {
          select: () => b,
          eq: (k: string, v: unknown) => (filters.push([k, v]), b),
          in: (k: string, v: unknown) => (inFilters.push([k, v]), b),
          limit: async () => ({ data: rows, error: null }),
        };
        return b;
      },
    });
    (getAgentRunById as any).mockImplementation((_tid: string, id: string) =>
      Promise.resolve(
        id === "parent-2"
          ? fullRunRow({ id: "parent-2", trigger: "mcp", input_payload_raw: {} })
          : fullRunRow({ id: "child-2", agent_slug: "seo-geo", output_text: "GEO answer" }),
      ),
    );
    const body = parse(await handleZaviTool("zavi_get_run_status", { run_id: "parent-2" }, readCaller));
    expect(body).toMatchObject({ run_id: "child-2", result: "GEO answer", delegated_from: "parent-2" });
    expect(filters).toEqual(expect.arrayContaining([["parent_run_id", "parent-2"]]));
    expect(inFilters).toEqual([["trigger", ["mcp", "handoff"]]]);

    rows = [{ id: "c-a" }, { id: "c-b" }];
    const fan = parse(await handleZaviTool("zavi_get_run_status", { run_id: "parent-2" }, readCaller));
    expect(fan.run_id).toBe("parent-2");
  });

  it("a failed child lookup is an error to retry, never the parent's note as the answer", async () => {
    (serviceClient as any).mockReturnValue({
      from: () => {
        const b: any = { select: () => b, eq: () => b, in: () => b, limit: async () => ({ data: null, error: { message: "boom" } }) };
        return b;
      },
    });
    (getAgentRunById as any).mockResolvedValue(fullRunRow({ id: "parent-3", trigger: "mcp", input_payload_raw: {} }));
    const res: any = await handleZaviTool("zavi_get_run_status", { run_id: "parent-3" }, readCaller);
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res)).toMatch(/again/);
  });

  it("zavi_recent_runs lists one line per run, without results", async () => {
    (listAgentRuns as any).mockResolvedValue([
      fullRunRow({ id: "r1" }),
      fullRunRow({ id: "r2", status: "running", presentation_status: "running", finished_at: "" }),
    ]);
    const body = parse(await handleZaviTool("zavi_recent_runs", {}, readCaller));
    expect(body).toEqual([
      {
        run_id: "r1",
        agent_slug: "operator",
        status: "success",
        presentation_status: "answered",
        started_at: "2026-10-16T10:00:00Z",
        finished_at: "2026-10-16T10:01:00Z",
      },
      {
        run_id: "r2",
        agent_slug: "operator",
        status: "running",
        presentation_status: "running",
        started_at: "2026-10-16T10:00:00Z",
        finished_at: null,
      },
    ]);
  });
});

describe("zavi_ask and zavi_get_run_status wait for the answer", () => {
  const runningRow = (overrides: Record<string, unknown> = {}) =>
    fullRunRow({ status: "running", presentation_status: "running", output_text: "", finished_at: null, ...overrides });

  beforeEach(() => {
    vi.useFakeTimers();
    (canUserAccessAgent as any).mockResolvedValue(true);
    (enqueueAgentRun as any).mockResolvedValue({ run_id: "op-run" });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the answer when the run finishes inside the wait", async () => {
    let reads = 0;
    (getAgentRunById as any).mockImplementation((_tid: string, id: string) =>
      Promise.resolve(++reads < 3 ? runningRow({ id }) : fullRunRow({ id })),
    );
    const pending = handleZaviTool("zavi_ask", { message: "why are signups flat?" }, runCaller);
    await vi.advanceTimersByTimeAsync(ZAVI_ASK_WAIT_MS);
    const body = parse(await pending);
    expect(body).toMatchObject({
      run_id: "op-run",
      presentation_status: "answered",
      result: "Signups dipped because the trial page 404s.",
    });
    expect(body.next).toBeUndefined();
    expect(reads).toBe(3);
  });

  it("follows an operator handoff and waits for the specialist's answer", async () => {
    let childReads = 0;
    (getAgentRunById as any).mockImplementation((_tid: string, id: string) =>
      Promise.resolve(
        id === "op-run"
          ? fullRunRow({ id, input_payload_raw: { delegated_child_run_id: "child-1" } })
          : ++childReads < 2
            ? runningRow({ id, agent_slug: "research" })
            : fullRunRow({ id, agent_slug: "research", output_text: "Specialist answer" }),
      ),
    );
    const pending = handleZaviTool("zavi_ask", { message: "research competitors" }, runCaller);
    await vi.advanceTimersByTimeAsync(ZAVI_ASK_WAIT_MS);
    expect(parse(await pending)).toMatchObject({
      run_id: "child-1",
      result: "Specialist answer",
      delegated_from: "op-run",
    });
  });

  it("after the wait says to call zavi_get_run_status straight away", async () => {
    (getAgentRunById as any).mockImplementation((_tid: string, id: string) =>
      Promise.resolve(runningRow({ id })),
    );
    let settled = false;
    const pending = handleZaviTool("zavi_ask", { message: "plan my month" }, runCaller).then((r) => {
      settled = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(ZAVI_ASK_WAIT_MS - 1_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    const body = parse(await pending);
    expect(body).toEqual({ run_id: "op-run", status: "running", next: expect.stringMatching(/zavi_get_run_status .* now/) });
  });

  it("zavi_get_run_status waits for a running run and returns its answer", async () => {
    let reads = 0;
    (getAgentRunById as any).mockImplementation((_tid: string, id: string) =>
      Promise.resolve(++reads < 3 ? runningRow({ id }) : fullRunRow({ id })),
    );
    const pending = handleZaviTool("zavi_get_run_status", { run_id: "run-abc" }, readCaller);
    await vi.advanceTimersByTimeAsync(ZAVI_ASK_WAIT_MS);
    expect(parse(await pending)).toMatchObject({ run_id: "run-abc", result: "Signups dipped because the trial page 404s." });
    expect(reads).toBe(3);
  });

  it("zavi_get_run_status says to call again when the run is still going after the wait", async () => {
    (getAgentRunById as any).mockImplementation((_tid: string, id: string) => Promise.resolve(runningRow({ id })));
    const pending = handleZaviTool("zavi_get_run_status", { run_id: "run-abc" }, readCaller);
    await vi.advanceTimersByTimeAsync(ZAVI_ASK_WAIT_MS);
    expect(parse(await pending)).toEqual({ run_id: "run-abc", status: "running", next: expect.any(String) });
  });

  const settledBy = async (call: Promise<unknown>) => {
    let settled = false;
    const pending = call.then((r) => {
      settled = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(ZAVI_ASK_WAIT_MS - 1_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toBe(true);
    return parse((await pending) as any);
  };

  it("zavi_get_run_status still answers by the deadline when its first read is slow", async () => {
    (getAgentRunById as any).mockImplementation(() => new Promise(() => {}));
    const body = await settledBy(handleZaviTool("zavi_get_run_status", { run_id: "run-abc" }, readCaller));
    expect(body).toMatchObject({ run_id: "run-abc", status: "running" });
  });

  it("zavi_get_run_status drops a stalled first read at the cap and answers from the retry", async () => {
    let reads = 0;
    (getAgentRunById as any).mockImplementation((_tid: string, id: string) =>
      ++reads === 1 ? new Promise(() => {}) : Promise.resolve(fullRunRow({ id })),
    );
    const pending = handleZaviTool("zavi_get_run_status", { run_id: "run-abc" }, readCaller);
    await vi.advanceTimersByTimeAsync(READ_CAP_MS);
    expect(parse(await pending)).toMatchObject({ run_id: "run-abc", presentation_status: "answered" });
    expect(reads).toBe(2);
  });

  it("zavi_get_run_status fails when a stalled first read fails, even with a retry still out", async () => {
    let reads = 0;
    (getAgentRunById as any).mockImplementation(() =>
      ++reads === 1
        ? new Promise((_r, reject) => setTimeout(() => reject(new Error("fetch timeout")), READ_CAP_MS + 2_000))
        : new Promise(() => {}),
    );
    const pending = handleZaviTool("zavi_get_run_status", { run_id: "run-abc" }, readCaller);
    await vi.advanceTimersByTimeAsync(ZAVI_ASK_WAIT_MS);
    expect((await pending).isError).toBe(true);
  });

  it("zavi_ask counts a slow start against the same deadline", async () => {
    (enqueueAgentRun as any).mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ run_id: "op-run" }), 30_000)),
    );
    (getAgentRunById as any).mockImplementation((_tid: string, id: string) => Promise.resolve(runningRow({ id })));
    const body = await settledBy(handleZaviTool("zavi_ask", { message: "plan my month" }, runCaller));
    expect(body).toMatchObject({ run_id: "op-run", status: "running" });
  });

  it("a token without the read scope gets the run_id only, as before", async () => {
    const res = await handleZaviTool("zavi_ask", { message: "plan my month" }, caller(["run"]));
    expect(parse(res)).toEqual({ run_id: "op-run" });
    expect(getAgentRunById).not.toHaveBeenCalled();
  });

  it("a read that stalls past the deadline does not hold the call past the wait", async () => {
    let reads = 0;
    (getAgentRunById as any).mockImplementation((_tid: string, id: string) =>
      ++reads === 1 ? Promise.resolve(runningRow({ id })) : new Promise(() => {}),
    );
    let settled = false;
    const pending = handleZaviTool("zavi_ask", { message: "plan my month" }, runCaller).then((r) => {
      settled = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(ZAVI_ASK_WAIT_MS);
    expect(settled).toBe(true);
    expect(parse(await pending)).toMatchObject({ run_id: "op-run", status: "running" });
  });

  it("reads that keep failing still wait out the deadline, then say running, not an error", async () => {
    (getAgentRunById as any).mockRejectedValue(new Error("db down"));
    const body = await settledBy(handleZaviTool("zavi_ask", { message: "plan my month" }, runCaller));
    expect(body).toMatchObject({ run_id: "op-run", status: "running" });
  });

  it("a failed read is logged and tried again, so the answer still comes in the same call", async () => {
    let reads = 0;
    (getAgentRunById as any).mockImplementation((_tid: string, id: string) =>
      ++reads === 1 ? Promise.reject(new Error("fetch timeout")) : Promise.resolve(reads === 2 ? runningRow({ id }) : fullRunRow({ id })),
    );
    const pending = handleZaviTool("zavi_ask", { message: "why are signups flat?" }, runCaller);
    await vi.advanceTimersByTimeAsync(ZAVI_ASK_WAIT_MS);
    expect(parse(await pending)).toMatchObject({ run_id: "op-run", result: "Signups dipped because the trial page 404s." });
    expect(logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ code: "mcp.wait_read_failed", run_id: "op-run", tenant_id: TENANT_A }),
    );
  });

  it("a run that reads as missing mid-wait ends the wait, and is logged", async () => {
    (getAgentRunById as any).mockResolvedValue(null);
    const pending = handleZaviTool("zavi_ask", { message: "plan my month" }, runCaller);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(parse(await pending)).toMatchObject({ run_id: "op-run", status: "running" });
    expect(logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ code: "mcp.wait_read_missing", run_id: "op-run", tenant_id: TENANT_A }),
    );
  });

  it("a read slower than the cap is dropped and tried again", async () => {
    let reads = 0;
    (getAgentRunById as any).mockImplementation((_tid: string, id: string) =>
      ++reads === 1 ? new Promise(() => {}) : Promise.resolve(fullRunRow({ id })),
    );
    let settled = false;
    const pending = handleZaviTool("zavi_ask", { message: "why are signups flat?" }, runCaller).then((r) => {
      settled = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(1_000 + READ_CAP_MS);
    expect(settled).toBe(true);
    expect(parse(await pending)).toMatchObject({ run_id: "op-run", presentation_status: "answered" });
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ code: "mcp.wait_read_slow" }));
  });

  it("reads that are always slower than the cap still answer: an earlier try that finishes still counts", async () => {
    (getAgentRunById as any).mockImplementation(
      (_tid: string, id: string) => new Promise((resolve) => setTimeout(() => resolve(fullRunRow({ id })), READ_CAP_MS + 2_000)),
    );
    const pending = handleZaviTool("zavi_get_run_status", { run_id: "run-abc" }, readCaller);
    await vi.advanceTimersByTimeAsync(READ_CAP_MS + 2_000);
    expect(parse(await pending)).toMatchObject({ run_id: "run-abc", presentation_status: "answered" });
  });
});

describe("ZAVI_INBOUND_TOOL_LIST annotations", () => {
  it("lists exactly the scoped tools, each with a title and explicit boolean hints", () => {
    const names = ZAVI_INBOUND_TOOL_LIST.map((t) => t.name).sort();
    expect(names).toEqual(Object.keys(TOOL_SCOPES).sort());
    for (const t of ZAVI_INBOUND_TOOL_LIST) {
      expect(t.title).toBeTruthy();
      expect(t.annotations?.title).toBe(t.title);
      expect(typeof t.annotations?.readOnlyHint).toBe("boolean");
      expect(typeof t.annotations?.destructiveHint).toBe("boolean");
      expect(typeof t.annotations?.openWorldHint).toBe("boolean");
      expect(typeof t.annotations?.idempotentHint).toBe("boolean");
      expect(t.inputSchema).toMatchObject({ type: "object" });
    }
  });

  it("calls a repeat idempotent only where it changes nothing: mark done replays, a reported number does not", () => {
    const byName = Object.fromEntries(ZAVI_INBOUND_TOOL_LIST.map((t) => [t.name, t.annotations]));
    expect(byName.zavi_mark_step_done?.idempotentHint).toBe(true);
    expect(byName.zavi_report_number?.idempotentHint).toBe(false);
    expect(byName.zavi_report_number).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: false });
  });

  it("input schemas keep types, bounds, defaults and field descriptions", () => {
    const byName = Object.fromEntries(ZAVI_INBOUND_TOOL_LIST.map((t) => [t.name, t.inputSchema]));
    expect(byName.zavi_recent_runs).toMatchObject({
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 50, default: 10 } },
    });
    expect(byName.zavi_recent_runs.required ?? []).not.toContain("limit");
    expect(byName.zavi_ask).toMatchObject({ required: ["message"] });
    expect((byName.zavi_ask.properties as any).message.description).toBeTruthy();
    for (const schema of Object.values(byName)) expect(schema).not.toHaveProperty("$schema");
  });

  it("hints agree with the enforced scope: read tools read-only, run tools destructive", () => {
    for (const t of ZAVI_INBOUND_TOOL_LIST) {
      const scope = TOOL_SCOPES[t.name];
      expect(t.annotations?.readOnlyHint).toBe(scope === "read");
      expect(t.annotations?.destructiveHint).toBe(scope !== "read");
    }
  });
});

import { tenantClient, tenantRpc } from "@/services/tenant-client";
import { loadTenantRoleFor } from "@/services/auth/tenant-role";
import { readDueTests } from "@/services/growth/cgo-tests";
import { writeAutopilotGoal } from "@/services/growth/goal-write";
import { syncGoalWork } from "@/services/growth/goal-owner";
import { recordMetricSnapshot } from "@/services/analytics/record-metric-snapshot";

const CARD = "33333333-cccc-4ccc-8ccc-333333333333";
const GOAL = "44444444-dddd-4ddd-8ddd-444444444444";
const MOVE = "55555555-eeee-4eee-8eee-555555555555";

function fakeTenantClient(tables: Record<string, { data: unknown; error: unknown }>) {
  const scopes: string[] = [];
  const calls: { table: string; method: string; args: unknown[] }[] = [];
  (tenantClient as any).mockImplementation((tid: string) => {
    scopes.push(tid);
    return {
      from: (table: string) => {
        const result = tables[table] ?? { data: [], error: null };
        const b: any = {};
        for (const m of ["select", "eq", "in", "order", "limit"]) {
          b[m] = (...args: unknown[]) => {
            calls.push({ table, method: m, args });
            return b;
          };
        }
        b.maybeSingle = () => Promise.resolve(result);
        b.then = (f: (v: unknown) => unknown, r?: (e: unknown) => unknown) => Promise.resolve(result).then(f, r);
        return b;
      },
    };
  });
  return { scopes, calls };
}

describe("founder's-AI tools — scopes", () => {
  it("next_step is read; mark_done and report_number are run (no new scope value)", () => {
    expect(TOOL_SCOPES.zavi_next_step).toBe("read");
    expect(TOOL_SCOPES.zavi_mark_step_done).toBe("run");
    expect(TOOL_SCOPES.zavi_report_number).toBe("run");
    expect(new Set(Object.values(TOOL_SCOPES))).toEqual(new Set(["read", "run"]));
  });

  it("a read-only token cannot mark a step done or report a number, and nothing is touched", async () => {
    const a = await handleZaviTool("zavi_mark_step_done", { action_id: CARD, what_changed: "x" }, readCaller);
    const b = await handleZaviTool("zavi_report_number", { goal_id: GOAL, value: 5 }, readCaller);
    for (const res of [a, b]) {
      expect(res.isError).toBe(true);
      expect(parse(res).error).toMatch(/scope_denied/);
    }
    expect(tenantClient).not.toHaveBeenCalled();
    expect(tenantRpc).not.toHaveBeenCalled();
    expect(writeAutopilotGoal).not.toHaveBeenCalled();
  });

  it("a token with no read scope cannot read the next step", async () => {
    const res = await handleZaviTool("zavi_next_step", {}, caller(["run"]));
    expect(parse(res).error).toMatch(/scope_denied/);
    expect(tenantClient).not.toHaveBeenCalled();
  });
});

describe("zavi_next_step", () => {
  beforeEach(() => {
    (readDueTests as any).mockResolvedValue({ due: [], more: 0 });
  });

  it("names the workspace it read, and leaves the name out when it cannot be read", async () => {
    const empty = {
      autopilot_goals: { data: [], error: null },
      customer_visible_open_channel_actions: { data: [], error: null },
    };
    const tenantReads: unknown[][] = [];
    fakeTenantClient(empty);
    (serviceClient as any).mockImplementation(() => ({
      from: (table: string) => {
        if (table !== "tenants") return noChildrenClient();
        const { builder, calls } = makeQueryStub({ data: { display_name: "  Upcar   AI " }, error: null });
        builder.maybeSingle = () => {
          tenantReads.push(...calls.filter((c) => c.method === "select" || c.method === "eq").map((c) => c.args));
          return Promise.resolve({ data: { display_name: "  Upcar   AI " }, error: null });
        };
        return builder;
      },
    }));
    const named = parse(await handleZaviTool("zavi_next_step", {}, readCaller));
    expect(named.workspace_name).toBe("Upcar AI");
    expect(tenantReads).toEqual([["display_name"], ["id", TENANT_A]]);

    fakeTenantClient(empty);
    (serviceClient as any).mockImplementation(() => ({
      from: () => {
        throw new Error("db down");
      },
    }));
    const res = await handleZaviTool("zavi_next_step", {}, readCaller);
    expect(res.isError).toBeUndefined();
    expect("workspace_name" in parse(res)).toBe(false);
  });

  it("with nothing open, tells the AI to ask Zavi for a plan", async () => {
    fakeTenantClient({
      autopilot_goals: { data: [], error: null },
      customer_visible_open_channel_actions: { data: [], error: null },
    });
    const res = await handleZaviTool("zavi_next_step", {}, readCaller);
    expect(res.isError).toBeUndefined();
    const body = parse(res);
    expect(body.steps).toEqual([]);
    expect(body.next).toMatch(/zavi_ask/);
    expect(res.structuredContent).toEqual(body);
  });

  it("with no steps and an unreadable readout list, does not say nothing is open", async () => {
    fakeTenantClient({
      autopilot_goals: { data: [], error: null },
      customer_visible_open_channel_actions: { data: [], error: null },
    });
    (readDueTests as any).mockRejectedValue(new Error("boom"));
    const body = parse(await handleZaviTool("zavi_next_step", {}, readCaller));
    expect(body.due_readouts).toBeNull();
    expect(body.next).not.toMatch(/Nothing is open/);
    expect(body.next).toMatch(/could not be read/);
  });

  it("returns goals, cgo's steps first with their test, and scopes every read to the caller's tenant", async () => {
    const { scopes, calls } = fakeTenantClient({
      autopilot_goals: {
        data: [{ id: GOAL, objective: "More signups", target_metric: "signups", target_value: 100, current_value: 40, current_value_at: new Date(Date.now() - 3 * 86_400_000).toISOString(), measurement_mode: "manual_reported", due_date: null }],
        error: null,
      },
      customer_visible_open_channel_actions: {
        data: [
          { id: "plain", run_id: "run-plain", channel_slug: "x", title: "Post a thread", step: { body: "Reach" }, how_to: [], exec_class: null, score: 9 },
          { id: "zavi-only", run_id: "run-z", channel_slug: "x", title: "Zavi note", step: { responsibility: "zavi" }, how_to: [], exec_class: null, score: 8 },
          { id: CARD, run_id: "run-cgo", channel_slug: "x", title: "Rewrite the pricing page headline", step: { body: "Visitors bounce" }, how_to: ["Open the page", "Change the h1"], exec_class: null, score: 1 },
        ],
        error: null,
      },
      agent_runs: { data: [{ id: "run-cgo", source_decision_id: MOVE }, { id: "run-plain", source_decision_id: null }], error: null },
      decisions: {
        data: [{ id: MOVE, goal_id: GOAL, dispatched_by: "cgo", test: { variable: "headline", baseline: "2% signup", success_if: "3% signup", readout_on: "2026-11-10" } }],
        error: null,
      },
    });
    const body = parse(await handleZaviTool("zavi_next_step", {}, readCaller));
    expect(scopes.every((t) => t === TENANT_A)).toBe(true);
    for (const table of ["autopilot_goals", "customer_visible_open_channel_actions", "agent_runs", "decisions"]) {
      expect(calls.some((c) => c.table === table && c.method === "eq" && c.args[0] === "tenant_id" && c.args[1] === TENANT_A)).toBe(true);
    }
    expect(body.goals[0]).toMatchObject({ goal_id: GOAL, current_value: 40, number_age_days: 3, measurement_mode: "manual_reported" });
    expect(body.steps.map((s: any) => s.action_id)).toEqual([CARD, "plain"]);
    expect(body.steps[0]).toMatchObject({
      what_to_do: "Rewrite the pricing page headline",
      why: "Visitors bounce",
      done_by: "you",
      goal_id: GOAL,
      test: { variable: "headline", baseline: "2% signup", success_if: "3% signup", stop_if: null, readout_on: "2026-11-10" },
    });
    expect(body.steps[1].test).toBeNull();
    expect(readDueTests).toHaveBeenCalledWith(TENANT_A, "cgo.dispatch-specialist", expect.any(Date));
  });
});

describe("zavi_next_step — approval cards", () => {
  beforeEach(() => {
    (readDueTests as any).mockResolvedValue({ due: [], more: 0 });
  });

  it("a page of Zavi-executed cards does not hide a step the founder's AI can do", async () => {
    const execCards = Array.from({ length: 12 }, (_, i) => ({ id: `ad-${i}`, run_id: null, channel_slug: "x", title: `Approve ad ${i}`, step: {}, how_to: [], exec_class: "meta_ads", score: 50 - i }));
    fakeTenantClient({
      autopilot_goals: { data: [], error: null },
      customer_visible_open_channel_actions: {
        data: [...execCards, { id: "task", run_id: null, channel_slug: "x", title: "Post a thread", step: {}, how_to: [], exec_class: null, score: 1 }],
        error: null,
      },
    });
    const body = parse(await handleZaviTool("zavi_next_step", {}, readCaller));
    expect(body.steps).toHaveLength(10);
    expect(body.steps[0]).toMatchObject({ action_id: "task", done_by: "you" });
    expect(body.next).toMatch(/If they ask you to do it/);
    expect(body.next).not.toMatch(/with your own tools/);
    expect(body.steps[1]).toMatchObject({ action_id: "ad-0", done_by: "zavi" });
  });

  it("when every open step is Zavi's, does not tell the AI to do a step of its own", async () => {
    fakeTenantClient({
      autopilot_goals: { data: [], error: null },
      customer_visible_open_channel_actions: {
        data: [{ id: "ad", run_id: null, channel_slug: "x", title: "Approve ad", step: {}, how_to: [], exec_class: "meta_ads", score: 5 }],
        error: null,
      },
    });
    const body = parse(await handleZaviTool("zavi_next_step", {}, readCaller));
    expect(body.next).not.toMatch(/Show the founder/);
    expect(body.next).toMatch(/zavi_ask/);
  });
});

describe("zavi_mark_step_done", () => {
  beforeEach(() => {
    (loadTenantRoleFor as any).mockResolvedValue("member");
  });

  it("marks an open card acted through set_channel_action, with the AI's note and a stable event key", async () => {
    fakeTenantClient({ channel_actions: { data: { id: CARD, status: "pending", exec_class: null, exec_status: null }, error: null } });
    (tenantRpc as any).mockResolvedValue({ data: { ok: true, replayed: false, status: "acted" }, error: null });
    const res = await handleZaviTool(
      "zavi_mark_step_done",
      { action_id: CARD, what_changed: "Changed the headline", link: "https://example.com/pr/1" },
      runCaller,
    );
    expect(res.isError).toBeUndefined();
    expect(parse(res)).toMatchObject({ action_id: CARD, status: "acted" });
    expect(tenantRpc).toHaveBeenCalledWith(TENANT_A, "set_channel_action", {
      p_action_id: CARD,
      p_status: "acted",
      p_note: "Done by your AI: Changed the headline https://example.com/pr/1",
      p_snoozed_until: null,
      p_event_key: expect.stringMatching(new RegExp(`^ai:${CARD}:[0-9a-f]{16}$`)),
      p_actor_user_id: USER_A,
    });
  });

  it("a retry of the same report replays with the same key; a different report gets a new key", async () => {
    fakeTenantClient({ channel_actions: { data: { id: CARD, status: "pending", exec_class: null }, error: null } });
    (tenantRpc as any).mockResolvedValue({ data: { ok: true, replayed: false, status: "acted" }, error: null });
    await handleZaviTool("zavi_mark_step_done", { action_id: CARD, what_changed: "Did it" }, runCaller);
    await handleZaviTool("zavi_mark_step_done", { action_id: CARD, what_changed: "Did it" }, runCaller);
    await handleZaviTool("zavi_mark_step_done", { action_id: CARD, what_changed: "Did it again" }, runCaller);
    const keys = (tenantRpc as any).mock.calls.map((c: any[]) => c[2].p_event_key);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it("does not claim done when a replay finds the card reopened", async () => {
    fakeTenantClient({ channel_actions: { data: { id: CARD, status: "pending", exec_class: null }, error: null } });
    (tenantRpc as any).mockResolvedValue({ data: { ok: true, replayed: true, status: "pending" }, error: null });
    const res = await handleZaviTool("zavi_mark_step_done", { action_id: CARD, what_changed: "Did it" }, runCaller);
    expect(res.isError).toBe(true);
    expect(parse(res).error).toMatch(/reopened/);
  });

  it("refuses another tenant's card (the tenant-scoped read finds nothing) and never writes", async () => {
    const { scopes } = fakeTenantClient({ channel_actions: { data: null, error: null } });
    const res = await handleZaviTool("zavi_mark_step_done", { action_id: CARD, what_changed: "x" }, runCaller);
    expect(res.isError).toBe(true);
    expect(parse(res).error).toMatch(/not found/);
    expect(scopes).toEqual([TENANT_A]);
    expect(tenantRpc).not.toHaveBeenCalled();
  });

  it("refuses a closed card and a card Zavi executes itself", async () => {
    fakeTenantClient({ channel_actions: { data: { id: CARD, status: "acted", exec_class: null }, error: null } });
    expect(parse(await handleZaviTool("zavi_mark_step_done", { action_id: CARD, what_changed: "x" }, runCaller)).error).toMatch(/already closed/);
    fakeTenantClient({ channel_actions: { data: { id: CARD, status: "pending", exec_class: "meta_ads.create_ad" }, error: null } });
    expect(parse(await handleZaviTool("zavi_mark_step_done", { action_id: CARD, what_changed: "x" }, runCaller)).error).toMatch(/Zavi makes this change itself/);
    expect(tenantRpc).not.toHaveBeenCalled();
  });

  it("refuses a viewer", async () => {
    (loadTenantRoleFor as any).mockResolvedValue("viewer");
    const res = await handleZaviTool("zavi_mark_step_done", { action_id: CARD, what_changed: "x" }, runCaller);
    expect(res.isError).toBe(true);
    expect(tenantRpc).not.toHaveBeenCalled();
  });

  it("reports an RPC error honestly instead of claiming success", async () => {
    fakeTenantClient({ channel_actions: { data: { id: CARD, status: "pending", exec_class: null }, error: null } });
    (tenantRpc as any).mockResolvedValue({ data: null, error: { message: "boom" } });
    const res = await handleZaviTool("zavi_mark_step_done", { action_id: CARD, what_changed: "x" }, runCaller);
    expect(res.isError).toBe(true);
    expect(parse(res).error).toMatch(/could not be marked done/);
  });
});

describe("zavi_report_number", () => {
  beforeEach(() => {
    (loadTenantRoleFor as any).mockResolvedValue("owner");
    (writeAutopilotGoal as any).mockResolvedValue({ status: "written", id: GOAL });
  });

  it("writes the number as a founder-typed reading on a manual goal", async () => {
    fakeTenantClient({ autopilot_goals: { data: { id: GOAL, status: "active", measurement_mode: "manual_reported" }, error: null } });
    const res = await handleZaviTool("zavi_report_number", { goal_id: GOAL, value: 42 }, runCaller);
    expect(res.isError).toBeUndefined();
    expect(writeAutopilotGoal).toHaveBeenCalledWith(TENANT_A, expect.objectContaining({
      op: "update",
      goal_id: GOAL,
      values: expect.objectContaining({ current_value: 42, current_value_source: "entered by the founder", current_value_at: expect.any(String) }),
      expect: { measurement_mode: "manual_reported" },
      status_not_in: ["met", "missed"],
      actor: { source: "founder", user_id: USER_A, why: "Reported by the founder's own AI" },
    }));
    expect(recordMetricSnapshot).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: TENANT_A, metric_key: `goal:${GOAL}`, value: 42, source: "founder_reported" }));
    expect(syncGoalWork).toHaveBeenCalledWith(TENANT_A, GOAL);
  });

  it("refuses a goal measured by a connected source", async () => {
    fakeTenantClient({ autopilot_goals: { data: { id: GOAL, status: "active", measurement_mode: "auto" }, error: null } });
    const res = await handleZaviTool("zavi_report_number", { goal_id: GOAL, value: 42 }, runCaller);
    expect(res.isError).toBe(true);
    expect(parse(res).error).toMatch(/measured by a connected source/);
    expect(writeAutopilotGoal).not.toHaveBeenCalled();
  });

  it("refuses another tenant's goal (the tenant-scoped read finds nothing)", async () => {
    const { scopes } = fakeTenantClient({ autopilot_goals: { data: null, error: null } });
    const res = await handleZaviTool("zavi_report_number", { goal_id: GOAL, value: 42 }, runCaller);
    expect(parse(res).error).toMatch(/not found/);
    expect(scopes).toEqual([TENANT_A]);
    expect(writeAutopilotGoal).not.toHaveBeenCalled();
  });

  it("refuses a member (goal edits are owner/admin, as in the goal editor) and a non-finite value", async () => {
    (loadTenantRoleFor as any).mockResolvedValue("member");
    fakeTenantClient({ autopilot_goals: { data: { id: GOAL, status: "active", measurement_mode: "manual_reported" }, error: null } });
    expect((await handleZaviTool("zavi_report_number", { goal_id: GOAL, value: 1 }, runCaller)).isError).toBe(true);
    (loadTenantRoleFor as any).mockResolvedValue("owner");
    expect(parse(await handleZaviTool("zavi_report_number", { goal_id: GOAL, value: Infinity }, runCaller)).error).toMatch(/invalid args/);
    expect(writeAutopilotGoal).not.toHaveBeenCalled();
  });

  it("says so when the goal changed underneath the write", async () => {
    fakeTenantClient({ autopilot_goals: { data: { id: GOAL, status: "active", measurement_mode: null }, error: null } });
    (writeAutopilotGoal as any).mockResolvedValue({ status: "not_matched" });
    const res = await handleZaviTool("zavi_report_number", { goal_id: GOAL, value: 1 }, runCaller);
    expect(res.isError).toBe(true);
    expect(recordMetricSnapshot).not.toHaveBeenCalled();
  });
});

describe("Option 2 manual step handoff", () => {
  const original = { kind: "email", label: "Invitation", content: "Subject: Welcome\n\n  Book at https://example.com/book\n" };
  async function next(step: Record<string, unknown>, edited_body?: unknown, exec_class: string | null = null) {
    fakeTenantClient({
      autopilot_goals: { data: [], error: null },
      customer_visible_open_channel_actions: { data: [{
        id: CARD, run_id: null, channel_slug: "email_marketing", title: "Send the invitation",
        step: { body: "Copy the email on this card.", responsibility: "client", ...step },
        edited_body, how_to: ["Copy the email on this card."], exec_class, score: 5,
        exec_payload: { secret: "internal-execution-payload" },
      }], error: null },
    });
    (readDueTests as any).mockResolvedValue({ due: [], more: 0 });
    const res = await handleZaviTool("zavi_next_step", {}, readCaller);
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent).toEqual(parse(res));
    return parse(res).steps[0];
  }

  it("includes the complete paste-ready draft, formatting and exact target", async () => {
    const target = { kind: "page", ref: "https://example.com/spring-offer" };
    const step = await next({ deliverable: original, target });
    expect(step.done_by).toBe("you");
    expect(step.deliverable).toEqual(original);
    expect(step.target).toEqual(target);
  });

  it("uses the founder's saved text and thread without retaining superseded original parts", async () => {
    const edited = { text: "Revised opener\n  keep indentation", thread: ["Revised tail\n\nLink: https://example.com/new"] };
    const step = await next({ deliverable: { ...original, kind: "thread", parts: [{ label: "First", content: "stale opener" }, { label: "Second", content: "stale tail" }] } }, edited);
    expect(step.deliverable.content).toBe(edited.text);
    expect(step.deliverable.thread).toEqual(edited.thread);
    expect(step.deliverable.parts).toBeUndefined();
    expect(JSON.stringify(step)).not.toContain("stale");
  });

  it("does not resurrect original copy when the founder saved an empty selected alternative", async () => {
    const deliverable = { kind: "post", label: "Alternatives", content: "Old A\n\nOld B", parts: [{ label: "A", content: "Old A" }, { label: "B", content: "Old B" }] };
    const edited = { text: "", thread: null, variant_index: 1, variants: { "0": { text: "New A", thread: null }, "1": { text: "", thread: null } } };
    const step = await next({ deliverable, target: { kind: "profile", ref: "company-profile" } }, edited);
    expect(step.deliverable).toBeNull();
    expect(step.deliverable_note).toMatch(/saved draft.*empty/i);
    expect(step.target.ref).toBe("company-profile");
    expect(step.what_to_do).toBe("Send the invitation");
    expect(JSON.stringify(step)).not.toContain("Old B");
  });

  it("does not silently substitute the original when a stored edit cannot be read", async () => {
    const step = await next({ deliverable: original }, { text: "Changed by founder", thread: 42 });
    expect(step.deliverable).toBeNull();
    expect(step.deliverable_note).toMatch(/saved draft.*unavailable/i);
    expect(JSON.stringify(step)).not.toContain(original.content);
  });

  it("preserves original ordered thread parts", async () => {
    const deliverable = { kind: "thread", label: "Two posts", content: "First\n\nSecond", parts: [{ label: "First", content: "First\nline" }, { label: "Second", content: "Second" }] };
    expect((await next({ deliverable })).deliverable).toEqual(deliverable);
  });

  it("overlays saved alternatives without losing untouched alternatives or mixing them into one post", async () => {
    const deliverable = { kind: "post", label: "Alternatives", content: "Old A\n\nOld B", parts: [{ label: "A", content: "Old A" }, { label: "B", content: "Old B" }] };
    const edited = { text: "New B", thread: null, variant_index: 1, variants: { "1": { text: "New B", thread: ["B tail"] } } };
    const step = await next({ deliverable }, edited);
    expect(step.deliverable.content).toBe("New B");
    expect(step.deliverable.variant_index).toBe(1);
    expect(step.deliverable.parts).toEqual([{ label: "A", content: "Old A" }, { label: "B", content: "New B", thread: ["B tail"] }]);
    expect(JSON.stringify(step)).not.toContain("Old B");
  });

  it("does not replace a present unreadable alternative edit with its old text", async () => {
    const deliverable = { kind: "post", label: "Alternatives", content: "Old A\n\nOld B", parts: [{ label: "A", content: "Old A" }, { label: "B", content: "Old B" }] };
    const edited = { text: "New A", thread: null, variant_index: 0, variants: { "0": { text: "New A", thread: null }, "1": { text: "x".repeat(100001), thread: null } } };
    const step = await next({ deliverable }, edited);
    expect(step.deliverable).toBeNull();
    expect(step.deliverable_note).toMatch(/saved draft.*unavailable/i);
    expect(JSON.stringify(step)).not.toContain("Old B");
  });

  it("keeps optional malformed data from hiding an otherwise usable task", async () => {
    const step = await next({ deliverable: { kind: "email", content: 42 }, target: { kind: "page", ref: { secret: true } } }, { text: 42, thread: null });
    expect(step.what_to_do).toBe("Send the invitation");
    expect(step.deliverable).toBeNull();
    expect(step.target).toBeNull();
  });

  it("does not truncate valid long copy or expose unknown stored fields", async () => {
    const content = "Article\n\n" + "text ".repeat(3000);
    const step = await next({ deliverable: { kind: "article", label: "Article", content, internal: "not-for-output" }, target: { kind: "page", ref: "https://example.com", internal: "not-for-output" } });
    expect(step.deliverable.content).toBe(content);
    expect(JSON.stringify(step)).not.toContain("not-for-output");
    expect(JSON.stringify(step)).not.toContain("internal-execution-payload");
  });

  it("does not offer executable card drafts or payloads as manual work", async () => {
    const step = await next({ deliverable: original, target: { kind: "campaign", ref: "campaign-1" } }, { text: "saved ad", thread: null }, "meta_ads.create_ad");
    expect(step.done_by).toBe("zavi");
    expect(step.deliverable).toBeUndefined();
    expect(step.target).toBeUndefined();
    expect(JSON.stringify(step)).not.toContain("internal-execution-payload");
  });
});
