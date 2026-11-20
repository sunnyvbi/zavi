
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Model, ModelRequest } from "@openai/agents";

vi.mock("@/services/openai", () => ({ getOpenAi: () => null }));
// eslint-disable-next-line no-var
var embedCalls: Array<{ n: number; inputType: string }> = [];
vi.mock("@/services/memory/embed", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/memory/embed")>()),
  embedTexts: async (texts: string[], inputType: string) => {
    embedCalls.push({ n: texts.length, inputType });
    const e = new Error("VOYAGE_API_KEY not set");
    e.name = "VoyageError";
    throw e;
  },
}));

import {
  buildOpenAiAgent,
  toolSearchStateFor,
  toolSearchRunOptions,
  _streamOpenAICompatRunForTests,
} from "../openai-engine";
import { makeDispatchTool, type MakeDispatchToolDeps } from "../dispatch-tool";
import {
  SEARCH_TOOLS_NAME,
  TOOL_SEARCH_PROMPT_SUFFIX,
  TOOL_SEARCH_START_CAP,
  _clearToolVectorCacheForTests,
  takeToolSearchRecord,
} from "../tool-search";
import type {
  AgentEngineRunSpec,
  EngineEvent,
  EngineToolCall,
  EngineToolResult,
  EngineToolSpec,
} from "../types";

const OBJ = { type: "object", properties: {} };

function filler(n: number): EngineToolSpec[] {
  return Array.from({ length: n }, (_, i) => ({
    name: `web_fetch__filler_${i}`,
    description: `Filler tool number ${i}`,
    jsonSchema: OBJ,
  }));
}

const PR_TOOL: EngineToolSpec = {
  name: "github__list_pull_requests",
  description: "List open pull requests in a GitHub repository",
  jsonSchema: OBJ,
};
const MERGE_TOOL: EngineToolSpec = {
  name: "github__merge_pull_request",
  description: "Merge a GitHub pull request",
  jsonSchema: OBJ,
};

function baseSpec(tools: EngineToolSpec[], over: Partial<AgentEngineRunSpec> = {}) {
  const dispatchCalls: EngineToolCall[] = [];
  const events: EngineEvent[] = [];
  const dispatchTool = vi.fn(async (call: EngineToolCall): Promise<EngineToolResult> => {
    dispatchCalls.push(call);
    return { is_error: false, content: `ran ${call.tool_name}`, ms: 1, denied: false };
  });
  const spec: AgentEngineRunSpec = {
    systemPrompt: "SYSTEM",
    userPrompt: "do the task",
    model: "gpt-5.5",
    maxTurns: 8,
    tools,
    resume: null,
    abort: new AbortController(),
    dispatchTool: dispatchTool as unknown as AgentEngineRunSpec["dispatchTool"],
    onEvent: (e) => events.push(e),
    ...over,
  };
  return { spec, dispatchCalls, dispatchTool, events };
}

type ScriptedOutput =
  | { call: string; args?: Record<string, unknown> }[]
  | { text: string };

function scriptedModel(script: ScriptedOutput[]) {
  const turns: { tools: string[]; input: string }[] = [];
  let n = 0;
  const model: Model = {
    async getResponse() {
      throw new Error("not used (stream only)");
    },
    async *getStreamedResponse(req: ModelRequest) {
      turns.push({
        tools: (req.tools ?? []).map((t) => (t as { name: string }).name),
        input: JSON.stringify(req.input),
      });
      const step = script[Math.min(n, script.length - 1)];
      n += 1;
      const output = Array.isArray(step)
        ? step.map((c, i) => ({
            type: "function_call" as const,
            id: `fc_${n}_${i}`,
            callId: `call_${n}_${i}`,
            name: c.call,
            arguments: JSON.stringify(c.args ?? {}),
            status: "completed" as const,
          }))
        : [
            {
              type: "message" as const,
              id: `msg_${n}`,
              role: "assistant" as const,
              status: "completed" as const,
              content: [{ type: "output_text" as const, text: step.text }],
            },
          ];
      yield {
        type: "response_done",
        response: {
          id: `resp_${n}`,
          usage: { requests: 1, inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          output,
        },
      } as never;
    },
  };
  return { model, turns };
}

async function drive(spec: AgentEngineRunSpec, model: Model) {
  const agent = buildOpenAiAgent(spec, model);
  const out: EngineEvent[] = [];
  for await (const e of _streamOpenAICompatRunForTests(spec, agent, "stateless")) out.push(e);
  return { agent, out };
}

beforeEach(() => {
  _clearToolVectorCacheForTests();
  embedCalls.length = 0;
});

describe("tool search: default embedder is Voyage, with keyword fallback", () => {
  it("uses Voyage document/query embeddings; a Voyage failure still returns keyword results", async () => {
    const { spec } = baseSpec([...filler(50), PR_TOOL]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = buildOpenAiAgent(spec);
    const s = toolSearchStateFor(agent)!;
    const txt = await s.search("list open pull requests", 3);
    expect(txt).toContain("github__list_pull_requests");
    expect(new Set(embedCalls.map((c) => c.inputType))).toEqual(new Set(["document", "query"]));
    expect(warn.mock.calls.some((c) => String(c[0]).includes("tool_search_embed_fallback"))).toBe(true);
    const before = embedCalls.length;
    await s.search("pull requests", 3);
    expect(embedCalls.length).toBe(before);
    warn.mockRestore();
  });
});

describe("tool search: activation", () => {
  it("at or under the cap: built exactly as before (no search_tools, no gating, no suffix, default run options)", () => {
    const { spec } = baseSpec(filler(TOOL_SEARCH_START_CAP));
    const agent = buildOpenAiAgent(spec) as unknown as { tools: { name: string }[]; instructions: string };
    expect(agent.tools).toHaveLength(TOOL_SEARCH_START_CAP);
    expect(agent.tools.some((t) => t.name === SEARCH_TOOLS_NAME)).toBe(false);
    expect(agent.instructions).toBe("SYSTEM");
    expect(toolSearchStateFor(agent)).toBeNull();
    expect(toolSearchRunOptions(agent)).toEqual({});
  });

  it("over the cap: every tool registered + search_tools, suffix appended after the (already-addended) prompt", () => {
    const { spec } = baseSpec([...filler(50), PR_TOOL]);
    const agent = buildOpenAiAgent(spec) as unknown as { tools: { name: string; type: string }[]; instructions: string };
    expect(agent.tools).toHaveLength(52);
    expect(agent.tools.every((t) => t.type === "function")).toBe(true);
    expect(agent.tools[agent.tools.length - 1].name).toBe(SEARCH_TOOLS_NAME);
    expect(agent.instructions).toBe(`SYSTEM\n\n${TOOL_SEARCH_PROMPT_SUFFIX}`);
    expect(toolSearchRunOptions(agent).toolNotFoundBehavior).toBe("return_error_to_model");
  });

  it("spec.tools is never filtered or mutated (the shared list the Claude paths read stays whole)", async () => {
    const tools = [...filler(50), PR_TOOL];
    const snapshot = JSON.parse(JSON.stringify(tools));
    const { spec } = baseSpec(tools);
    const { model } = scriptedModel([[{ call: SEARCH_TOOLS_NAME, args: { query: "pull requests", k: null } }], { text: "ok" }]);
    await drive(spec, model);
    expect(spec.tools).toBe(tools);
    expect(tools).toEqual(snapshot);
  });

  it("the first turn offers exactly the starting set (declared + injected) plus search_tools", async () => {
    const tools = [
      ...filler(45),
      PR_TOOL,
      MERGE_TOOL,
      { name: "skill__load", description: "Load a skill", jsonSchema: OBJ },
    ];
    const { spec } = baseSpec(tools, {
      toolSearch: {
        declaredTools: ["github__*", "web_fetch__filler_44", "web_fetch__missing"],
        injectedToolNames: ["skill__load"],
      },
    });
    const { model, turns } = scriptedModel([{ text: "done" }]);
    await drive(spec, model);
    expect([...turns[0].tools].sort()).toEqual(
      [
        "github__list_pull_requests",
        "github__merge_pull_request",
        "web_fetch__filler_44",
        "skill__load",
        SEARCH_TOOLS_NAME,
      ].sort(),
    );
  });

  it("with no hints, the first 40 tools in run order are loaded (plus search_tools)", async () => {
    const { spec } = baseSpec([...filler(60)]);
    const { model, turns } = scriptedModel([{ text: "done" }]);
    await drive(spec, model);
    expect(turns[0].tools).toHaveLength(TOOL_SEARCH_START_CAP + 1);
    expect(turns[0].tools).toContain("web_fetch__filler_39");
    expect(turns[0].tools).not.toContain("web_fetch__filler_40");
  });
});

describe("tool search: search loads for the NEXT turn only", () => {
  it("a tool found this turn is not callable this turn, is callable next turn, and routes through dispatchTool", async () => {
    const { spec, dispatchCalls } = baseSpec([...filler(50), PR_TOOL]);
    const { model, turns } = scriptedModel([
      [
        { call: SEARCH_TOOLS_NAME, args: { query: "list open pull requests", k: 3 } },
        { call: "github__list_pull_requests" },
      ],
      [{ call: "github__list_pull_requests" }],
      { text: "done" },
    ]);
    const { out } = await drive(spec, model);

    expect(turns[0].tools).not.toContain("github__list_pull_requests");
    expect(turns[1].tools).toContain("github__list_pull_requests");
    expect(turns[1].input).toContain(
      "Tool 'github__list_pull_requests' was not loaded when you called it, so it did not run",
    );
    expect(dispatchCalls.map((c) => c.tool_name)).toEqual(["github__list_pull_requests"]);
    expect(out[out.length - 1].type).toBe("terminal");
  });

  it("search_tools returns the REGISTERED (sanitized) names", async () => {
    const skill: EngineToolSpec = {
      name: "tenant_skill__cto-engineer__weekly_report",
      description: "Weekly engineering report routine",
      jsonSchema: OBJ,
    };
    const { spec } = baseSpec([...filler(50), skill]);
    const { model, turns } = scriptedModel([
      [{ call: SEARCH_TOOLS_NAME, args: { query: "weekly engineering report", k: null } }],
      { text: "done" },
    ]);
    await drive(spec, model);
    expect(turns[1].input).toContain("tenant_skill__cto_engineer__weekly_report");
    expect(turns[1].tools).toContain("tenant_skill__cto_engineer__weekly_report");
  });
});

describe("tool search: an unloaded or unknown tool call never aborts the run", () => {
  it("unloaded tool -> error to the model, run completes, nothing dispatched", async () => {
    const { spec, dispatchCalls } = baseSpec([...filler(50), PR_TOOL]);
    const { model, turns } = scriptedModel([[{ call: "github__list_pull_requests" }], { text: "done" }]);
    const { out } = await drive(spec, model);
    expect(turns[1].input).toContain("is not loaded yet, so it did not run. Call search_tools");
    expect(dispatchCalls).toHaveLength(0);
    expect(out[out.length - 1].type).toBe("terminal");
  });

  it("a name the run was never given -> 'not available', nothing dispatched", async () => {
    const { spec, dispatchCalls } = baseSpec([...filler(50), PR_TOOL]);
    const { model, turns } = scriptedModel([[{ call: "stripe__create_refund" }], { text: "done" }]);
    await drive(spec, model);
    expect(turns[1].input).toContain("'stripe__create_refund' is not available");
    expect(dispatchCalls).toHaveLength(0);
  });
});

describe("tool search: the gate is unchanged", () => {
  it("a found-but-forbidden tool is still denied by makeDispatchTool (zero MCP call)", async () => {
    const callSpy = vi.fn().mockResolvedValue({ ok: true, content: "real", is_error: false, ms: 1 });
    const events: EngineEvent[] = [];
    const deps: MakeDispatchToolDeps = {
      isToolAllowed: async (_t: string, _agent: string, name: string) =>
        name.includes("merge") ? { allowed: false, reason: "blocked by tenant policy" } : { allowed: true },
      evaluateToolCallPolicy: () => ({ allow: true, reason: "ok" }),
      shouldDenyPmOperatorDb: () => false,
      isAgentKilled: async () => false,
      callMcpTool: callSpy as unknown as MakeDispatchToolDeps["callMcpTool"],
      tenant_id: "t1",
      agent_slug: "operator",
      baseCallCtx: { tenant_id: "t1", run_id: "r1" },
      onEvent: (e) => events.push(e),
      iter: { value: 0 },
    } as MakeDispatchToolDeps;
    const { spec } = baseSpec([...filler(50), MERGE_TOOL], { dispatchTool: makeDispatchTool(deps) });
    const { model, turns } = scriptedModel([
      [{ call: SEARCH_TOOLS_NAME, args: { query: "merge pull request", k: null } }],
      [{ call: "github__merge_pull_request" }],
      { text: "done" },
    ]);
    await drive(spec, model);
    expect(turns[1].tools).toContain("github__merge_pull_request");
    expect(callSpy).not.toHaveBeenCalled();
    expect(turns[2].input).toContain("blocked by tenant policy");
    const denied = events.filter((e) => e.type === "tool_call");
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ name: "github__merge_pull_request", code: "tenant_tool_deny" });
  });

  it("search_tools itself never reaches dispatchTool and emits no tool_call event", async () => {
    const { spec, dispatchTool, events } = baseSpec([...filler(50), PR_TOOL]);
    const { model } = scriptedModel([
      [{ call: SEARCH_TOOLS_NAME, args: { query: "pull requests", k: null } }],
      { text: "done" },
    ]);
    await drive(spec, model);
    expect(dispatchTool).not.toHaveBeenCalled();
    expect(events.filter((e) => e.type === "tool_call")).toHaveLength(0);
  });
});

describe("tool search: per-run index (tenant isolation)", () => {
  it("one run's search never returns another run's tool, even with both built in one process", async () => {
    const secret: EngineToolSpec = {
      name: "tenant_skill__acme__secret_payroll_export",
      description: "Export the payroll ledger",
      jsonSchema: OBJ,
    };
    const a = baseSpec([...filler(50), secret], { tenantId: "tenant-a" });
    const b = baseSpec([...filler(50), PR_TOOL], { tenantId: "tenant-b" });
    const agentA = buildOpenAiAgent(a.spec);
    const agentB = buildOpenAiAgent(b.spec);
    const sa = toolSearchStateFor(agentA)!;
    const sb = toolSearchStateFor(agentB)!;
    expect(await sa.search("payroll ledger export", 15)).toContain("secret_payroll_export");
    const fromB = await sb.search("payroll ledger export secret", 15);
    expect(fromB).not.toContain("secret_payroll_export");
    expect(fromB).not.toContain("tenant_skill");
    expect([...sb.loaded].some((n) => n.startsWith("tenant_skill"))).toBe(false);
  });
});

describe("tool search: activation by definition size", () => {
  const bigTools = (n: number): EngineToolSpec[] =>
    Array.from({ length: n }, (_, i) => ({
      name: `web_fetch__big_${i}`,
      description: `Big tool ${i}. ${"x".repeat(3500)}`,
      jsonSchema: OBJ,
    }));

  it("20 tools over 60,000 chars: search engages and the enabled set stays within the size limit", async () => {
    const { spec } = baseSpec(bigTools(20));
    const agent = buildOpenAiAgent(spec) as unknown as { tools: { name: string; description: string; parameters: unknown }[] };
    const s = toolSearchStateFor(agent);
    expect(s).not.toBeNull();
    const { model, turns } = scriptedModel([{ text: "done" }]);
    await drive(spec, model);
    const offered = agent.tools.filter((t) => turns[0].tools.includes(t.name));
    const chars = offered.reduce(
      (n, t) => n + JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters }).length,
      0,
    );
    expect(turns[0].tools).toContain(SEARCH_TOOLS_NAME);
    expect(turns[0].tools.length).toBeLessThan(21);
    expect(chars).toBeLessThanOrEqual(60_000);
  });

  it("20 small tools: the old path, unchanged (no search_tools, no gating)", () => {
    const { spec } = baseSpec(filler(20));
    const agent = buildOpenAiAgent(spec) as unknown as { tools: { name: string }[] };
    expect(toolSearchStateFor(agent)).toBeNull();
    expect(agent.tools).toHaveLength(20);
    expect(toolSearchRunOptions(agent)).toEqual({});
  });
});

describe("tool search: registered-name collisions fail closed", () => {
  it("tenant_skill__foo-bar__run + tenant_skill__foo_bar__run: first keeps the name, the later one is not registered, searchable or callable", async () => {
    const first: EngineToolSpec = { name: "tenant_skill__foo-bar__run", description: "Run the foo report", jsonSchema: OBJ };
    const second: EngineToolSpec = { name: "tenant_skill__foo_bar__run", description: "Run the foo report too", jsonSchema: OBJ };
    const shadowSearch: EngineToolSpec = { name: "search_tools", description: "a real tool named search_tools", jsonSchema: OBJ };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { spec, dispatchCalls } = baseSpec([...filler(50), first, second, shadowSearch]);
    const agent = buildOpenAiAgent(spec) as unknown as { tools: { name: string }[] };
    const names = agent.tools.map((t) => t.name);
    expect(names.filter((n) => n === "tenant_skill__foo_bar__run")).toHaveLength(1);
    expect(names.filter((n) => n === SEARCH_TOOLS_NAME)).toHaveLength(1);
    expect(agent.tools).toHaveLength(52);

    const s = toolSearchStateFor(agent)!;
    await s.search("run the foo report", 15);
    expect(s.isLoaded("tenant_skill__foo-bar__run")).toBe(true);
    expect(s.isLoaded("tenant_skill__foo_bar__run")).toBe(false);
    expect(s.engineNameFor("tenant_skill__foo_bar__run")).toBe("tenant_skill__foo-bar__run");

    const { model } = scriptedModel([[{ call: "tenant_skill__foo_bar__run" }], { text: "done" }]);
    const agent2 = buildOpenAiAgent({ ...spec, toolSearch: { declaredTools: ["tenant_skill__foo-bar__run"], injectedToolNames: [] } }, model);
    const out: EngineEvent[] = [];
    for await (const e of _streamOpenAICompatRunForTests(spec, agent2, "stateless")) out.push(e);
    expect(dispatchCalls.map((c) => c.tool_name)).toEqual(["tenant_skill__foo-bar__run"]);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("tool_search_name_collision"))).toHaveLength(4);
    warn.mockRestore();
  });
});

describe("tool search: bench record", () => {
  it("records the starting set + search results by run id only when asked, and take() forgets it", async () => {
    const { spec } = baseSpec([...filler(50), PR_TOOL], {
      runId: "bench-run-1",
      toolSearch: { declaredTools: ["web_fetch__filler_0"], injectedToolNames: [], record: true },
    });
    const { model } = scriptedModel([
      [{ call: SEARCH_TOOLS_NAME, args: { query: "pull requests", k: 2 } }],
      { text: "done" },
    ]);
    await drive(spec, model);
    const rec = takeToolSearchRecord("bench-run-1")!;
    expect(rec.surfaced.has("web_fetch__filler_0")).toBe(true);
    expect(rec.surfaced.has("github__list_pull_requests")).toBe(true);
    expect(rec.searches[0].query).toBe("pull requests");
    expect(takeToolSearchRecord("bench-run-1")).toBeUndefined();

    const { spec: s2 } = baseSpec([...filler(50)], { runId: "prod-run-1" });
    buildOpenAiAgent(s2);
    expect(takeToolSearchRecord("prod-run-1")).toBeUndefined();
  });
});
