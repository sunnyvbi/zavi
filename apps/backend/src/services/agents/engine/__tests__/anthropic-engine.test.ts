
import { describe, it, expect, vi, beforeEach } from "vitest";

// eslint-disable-next-line no-var
var captured: {
  queryParams: any[];
  serverTools: any[];
} = { queryParams: [], serverTools: [] };

// eslint-disable-next-line no-var
var driver:
  | ((push: (msg: unknown) => void, tools: any[]) => Promise<void>)
  | null = null;

vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  return {
    tool: (name: string, description: string, schema: unknown, handler: any) => ({
      name,
      description,
      schema,
      handler,
    }),
    createSdkMcpServer: (opts: any) => {
      captured.serverTools = opts.tools ?? [];
      return { __server: true, name: opts.name };
    },
    query: (params: any) => {
      captured.queryParams.push(params);
      return {
        async *[Symbol.asyncIterator]() {
          if (params.prompt && typeof params.prompt[Symbol.asyncIterator] === "function") {
            for await (const _ of params.prompt) void _;
          }
          const msgs: unknown[] = [];
          const push = (m: unknown) => msgs.push(m);
          let driverErr: unknown;
          try {
            if (driver) await driver(push, captured.serverTools);
          } catch (e) {
            driverErr = e;
          }
          for (const m of msgs) yield m;
          if (driverErr) throw driverErr;
        },
        interrupt: async () => {},
        close: () => {},
      };
    },
  };
});

import { AnthropicAgentEngine } from "../anthropic-engine";
import type {
  AgentEngineRunSpec,
  EngineEvent,
  EngineToolCall,
  EngineToolResult,
} from "../types";

function baseSpec(overrides: Partial<AgentEngineRunSpec> = {}): {
  spec: AgentEngineRunSpec;
  events: EngineEvent[];
  dispatchCalls: EngineToolCall[];
} {
  const events: EngineEvent[] = [];
  const dispatchCalls: EngineToolCall[] = [];
  const dispatchTool = vi.fn(
    async (call: EngineToolCall): Promise<EngineToolResult> => {
      dispatchCalls.push(call);
      spec.onEvent({
        type: "tool_call",
        name: call.tool_name,
        ms: 7,
        code: "ok",
        iter: 0,
      });
      return {
        is_error: false,
        content: JSON.stringify({ result: "real-output" }),
        ms: 7,
        denied: false,
      };
    },
  );
  const spec: AgentEngineRunSpec = {
    systemPrompt: "you are a test agent",
    userPrompt: "hello",
    model: "claude-opus-4-8",
    maxTurns: 8,
    tools: [
      {
        name: "slack__post_message",
        description: "post a slack message",
        jsonSchema: { type: "object", properties: {} },
      },
    ],
    resume: null,
    abort: new AbortController(),
    dispatchTool: dispatchTool as unknown as AgentEngineRunSpec["dispatchTool"],
    onEvent: (e) => events.push(e),
    ...overrides,
  };
  return { spec, events, dispatchCalls };
}

async function drain(it: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const out: EngineEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

beforeEach(() => {
  captured = { queryParams: [], serverTools: [] };
  driver = null;
});

describe("AnthropicAgentEngine — self-contained auth wiring", () => {
  it("(auth) resolves its OWN child env and threads it into query() options.env (OAuth default deletes ANTHROPIC_API_KEY)", async () => {
    const prevOauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const prevKey = process.env.ANTHROPIC_API_KEY;
    const prevMode = process.env.PRAXIS_AGENT_AUTH_MODE;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-tok";
    process.env.ANTHROPIC_API_KEY = "api-key";
    delete process.env.PRAXIS_AGENT_AUTH_MODE;
    try {
      const { spec } = baseSpec();
      driver = async (push) => {
        push({ type: "result", subtype: "success", result: "done", session_id: "s1" });
      };
      await drain(new AnthropicAgentEngine().run(spec));
      const opts = captured.queryParams[0].options;
      expect(opts.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-tok");
      expect(opts.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(process.env.ANTHROPIC_API_KEY).toBe("api-key");
    } finally {
      if (prevOauth === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = prevOauth;
      if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevKey;
      if (prevMode === undefined) delete process.env.PRAXIS_AGENT_AUTH_MODE;
      else process.env.PRAXIS_AGENT_AUTH_MODE = prevMode;
    }
  });

  it("(auth) PRAXIS_AGENT_AUTH_MODE=api_key flips the child env to the API key + drops the OAuth token", async () => {
    const prevOauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const prevKey = process.env.ANTHROPIC_API_KEY;
    const prevMode = process.env.PRAXIS_AGENT_AUTH_MODE;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-tok";
    process.env.ANTHROPIC_API_KEY = "api-key";
    process.env.PRAXIS_AGENT_AUTH_MODE = "api_key";
    try {
      const { spec } = baseSpec();
      driver = async (push) => push({ type: "result", subtype: "success", result: "x" });
      await drain(new AnthropicAgentEngine().run(spec));
      const opts = captured.queryParams[0].options;
      expect(opts.env.ANTHROPIC_API_KEY).toBe("api-key");
      expect(opts.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    } finally {
      if (prevOauth === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = prevOauth;
      if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevKey;
      if (prevMode === undefined) delete process.env.PRAXIS_AGENT_AUTH_MODE;
      else process.env.PRAXIS_AGENT_AUTH_MODE = prevMode;
    }
  });
});

describe("AnthropicAgentEngine — query() options wiring", () => {
  it("threads systemPrompt/model/maxTurns/abortController + disables built-in tools", async () => {
    const ac = new AbortController();
    const { spec } = baseSpec({ abort: ac, maxTurns: 42 });
    driver = async (push) => push({ type: "result", subtype: "success", result: "x" });
    await drain(new AnthropicAgentEngine().run(spec));
    const opts = captured.queryParams[0].options;
    expect(opts.systemPrompt).toBe("you are a test agent");
    expect(opts.model).toBe("claude-opus-4-8");
    expect(opts.maxTurns).toBe(42);
    expect(opts.abortController).toBe(ac);
    expect(opts.disallowedTools).toEqual(
      expect.arrayContaining(["Bash", "Read", "Write", "Edit", "WebFetch"]),
    );
  });

  it("passes a caller effort on a non-Opus model, and nothing when there is none", async () => {
    driver = async (push) => push({ type: "result", subtype: "success", result: "x" });
    await drain(new AnthropicAgentEngine().run(baseSpec({ model: "claude-sonnet-5-5", effort: "xhigh" }).spec));
    expect(captured.queryParams.at(-1).options.effort).toBe("xhigh");
    await drain(new AnthropicAgentEngine().run(baseSpec({ model: "claude-sonnet-5-5" }).spec));
    expect(captured.queryParams.at(-1).options.effort).toBeUndefined();
  });

  it("Opus runs at the caller's effort (cgo xhigh), else the fleet high", async () => {
    driver = async (push) => push({ type: "result", subtype: "success", result: "x" });
    await drain(new AnthropicAgentEngine().run(baseSpec({ model: "claude-opus-5-5", effort: "xhigh" }).spec));
    expect(captured.queryParams.at(-1).options.effort).toBe("xhigh");
    await drain(new AnthropicAgentEngine().run(baseSpec({ model: "claude-opus-5-5" }).spec));
    expect(captured.queryParams.at(-1).options.effort).toBe("high");
  });

  it("launches an isolated session even when the backend runs inside a developer's Claude Code session", async () => {
    const { agentSdkConfigDir } = await import("@/services/agents/sdk-isolation");
    const { homedir } = await import("node:os");
    const { join } = await import("node:path");
    const parent: Record<string, string> = {
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_CODE_SESSION_ID: "dev-session-7d",
      CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/cc-socks-501/4242.sock",
      CLAUDE_CODE_MESSAGING_TOKEN: "peer-token",
      CLAUDE_CONFIG_DIR: join(homedir(), ".claude"),
    };
    const prev = Object.fromEntries(Object.keys(parent).map((k) => [k, process.env[k]]));
    Object.assign(process.env, parent);
    try {
      const { spec } = baseSpec();
      driver = async (push) => push({ type: "result", subtype: "success", result: "x" });
      await drain(new AnthropicAgentEngine().run(spec));
      const opts = captured.queryParams[0].options;
      for (const k of Object.keys(parent).filter((k) => k !== "CLAUDE_CONFIG_DIR")) {
        expect(opts.env[k], k).toBeUndefined();
      }
      expect(opts.env.CLAUDE_CONFIG_DIR).toBe(agentSdkConfigDir());
      expect(opts.env.CLAUDE_CONFIG_DIR.startsWith(join(homedir(), ".claude"))).toBe(false);
      expect(opts.settingSources).toEqual([]);
      expect(opts.strictMcpConfig).toBe(true);
      expect(opts.settings).toMatchObject({ crossSessionInbound: "refuse", autoMemoryEnabled: false });
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("threads outputFormat (json_schema) when spec.outputJsonSchema is present", async () => {
    const { spec } = baseSpec({
      outputJsonSchema: {
        type: "json_schema",
        schema: { type: "object", properties: { ok: { type: "boolean" } } },
      },
    });
    driver = async (push) => push({ type: "result", subtype: "success", result: "{}" });
    await drain(new AnthropicAgentEngine().run(spec));
    const opts = captured.queryParams[0].options;
    expect(opts.outputFormat).toEqual({
      type: "json_schema",
      schema: { type: "object", properties: { ok: { type: "boolean" } } },
    });
  });

  it("threads resume (sdk_session) server-side; a foreign handle is ignored", async () => {
    const { spec } = baseSpec({ resume: { kind: "sdk_session", sessionId: "sess_prev" } });
    driver = async (push) => push({ type: "result", subtype: "success", result: "x" });
    await drain(new AnthropicAgentEngine().run(spec));
    expect(captured.queryParams[0].options.resume).toBe("sess_prev");

    captured = { queryParams: [], serverTools: [] };
    const { spec: spec2 } = baseSpec({ resume: { kind: "openai", lastResponseId: "r" } });
    driver = async (push) => push({ type: "result", subtype: "success", result: "x" });
    await drain(new AnthropicAgentEngine().run(spec2));
    expect(captured.queryParams[0].options.resume).toBeUndefined();
  });

  it("builds an in-process MCP server with one tool() per spec.tools entry", async () => {
    const { spec } = baseSpec();
    driver = async (push) => push({ type: "result", subtype: "success", result: "x" });
    await drain(new AnthropicAgentEngine().run(spec));
    expect(captured.serverTools).toHaveLength(1);
    expect(captured.serverTools[0].name).toBe("slack__post_message");
    expect(captured.serverTools[0].description).toContain("Input schema (JSON Schema)");
  });
});

describe("AnthropicAgentEngine — single tool execution (the Design-C fix)", () => {
  it("(tool) the MCP server handler routes EXCLUSIVELY through spec.dispatchTool with the bare name + a synthesized tool_use_id", async () => {
    const { spec, dispatchCalls } = baseSpec();
    let handlerReturn: any;
    driver = async (push, tools) => {
      handlerReturn = await tools[0].handler({ input: { channel: "C1", text: "hi" } }, {});
      push({ type: "result", subtype: "success", result: "ok", session_id: "s" });
    };
    await drain(new AnthropicAgentEngine().run(spec));

    expect(dispatchCalls).toHaveLength(1);
    expect(dispatchCalls[0].tool_name).toBe("slack__post_message");
    expect(dispatchCalls[0].server_id).toBe("slack");
    expect(dispatchCalls[0].bare_tool_name).toBe("post_message");
    expect(dispatchCalls[0].input).toEqual({ channel: "C1", text: "hi" });
    expect(dispatchCalls[0].tool_use_id).toMatch(/__slack__post_message__inv0$/);
    expect(handlerReturn.content[0].text).toBe(JSON.stringify({ result: "real-output" }));
  });

  it("(tool) a funnel deny is returned to the model as an isError text result (NOT thrown, NOT executed twice)", async () => {
    const denyDispatch = vi.fn(
      async (): Promise<EngineToolResult> => ({
        is_error: true,
        content: "operator_db denied: not enabled for this workspace.",
        ms: 0,
        code: "pm_operator_db_policy",
        denied: true,
      }),
    );
    const { spec } = baseSpec({
      dispatchTool: denyDispatch as unknown as AgentEngineRunSpec["dispatchTool"],
    });
    let handlerReturn: any;
    let threw = false;
    driver = async (push, tools) => {
      try {
        handlerReturn = await tools[0].handler({ input: {} }, {});
      } catch {
        threw = true;
      }
      push({ type: "result", subtype: "success", result: "x" });
    };
    await drain(new AnthropicAgentEngine().run(spec));
    expect(threw).toBe(false);
    expect(handlerReturn.isError).toBe(true);
    expect(handlerReturn.content[0].text).toBe(
      "operator_db denied: not enabled for this workspace.",
    );
    expect(denyDispatch).toHaveBeenCalledTimes(1);
  });

  it("(tool) canUseTool is AUDIT-ONLY — emits tool_start, allows with UNCHANGED input, never calls dispatchTool", async () => {
    const { spec, dispatchCalls, events } = baseSpec();
    let auditResult: any;
    driver = async (push) => {
      auditResult = await captured.queryParams[0].options.canUseTool(
        "slack__post_message",
        { a: 1, b: 2 },
      );
      push({ type: "result", subtype: "success", result: "x" });
    };
    await drain(new AnthropicAgentEngine().run(spec));
    expect(auditResult).toEqual({ behavior: "allow", updatedInput: { a: 1, b: 2 } });
    expect(dispatchCalls).toHaveLength(0);
    const start = events.find((e) => e.type === "tool_start");
    expect(start).toBeTruthy();
    expect((start as any).name).toBe("slack__post_message");
    expect((start as any).input).toEqual({ a: 1, b: 2 });
  });
});

describe("AnthropicAgentEngine — Design-C event vocabulary", () => {
  it("(event) emits assistant_turn + assistant_text(isFirstTextBlock) + tool_use, and yields == onEvent", async () => {
    const { spec, events } = baseSpec();
    driver = async (push) => {
      push({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "<plan>...</plan> hello" },
            { type: "tool_use", name: "slack__post_message", input: { x: 1 }, id: "tu_1" },
          ],
        },
      });
      push({
        type: "assistant",
        message: { content: [{ type: "text", text: "final answer" }] },
      });
      push({ type: "result", subtype: "success", result: "", session_id: "sess_z", usage: { input_tokens: 10, output_tokens: 4 } });
    };
    const out = await drain(new AnthropicAgentEngine().run(spec));

    expect(out.filter((e) => e.type === "assistant_turn")).toHaveLength(2);

    const texts = out.filter((e) => e.type === "assistant_text") as Array<
      Extract<EngineEvent, { type: "assistant_text" }>
    >;
    expect(texts[0].text).toBe("<plan>...</plan> hello");
    expect(texts[0].isFirstTextBlock).toBe(true);
    expect(texts[1].text).toBe("final answer");
    expect(texts[1].isFirstTextBlock).toBe(false);

    const toolUse = out.find((e) => e.type === "tool_use") as any;
    expect(toolUse.name).toBe("slack__post_message");
    expect(toolUse.input).toEqual({ x: 1 });
    expect(toolUse.tool_use_id).toBe("tu_1");

    expect(events.map((e) => e.type)).toEqual(out.map((e) => e.type));
  });

  it("(event) emits tool_result on the SDK user turn (for the host's output_preview + heartbeat)", async () => {
    const { spec } = baseSpec();
    driver = async (push) => {
      push({
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "tu_1", content: "OUT", is_error: false },
            { type: "tool_result", tool_use_id: "tu_2", content: "BOOM", is_error: true },
          ],
        },
      });
      push({ type: "result", subtype: "success", result: "x" });
    };
    const out = await drain(new AnthropicAgentEngine().run(spec));
    const results = out.filter((e) => e.type === "tool_result") as any[];
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ tool_use_id: "tu_1", content: "OUT", isError: false });
    expect(results[1]).toMatchObject({ tool_use_id: "tu_2", content: "BOOM", isError: true });
  });

  it("(dedup) the engine NEVER synthesizes a 4-key tool_call event — only the funnel does", async () => {
    const { spec, events } = baseSpec();
    driver = async (push, tools) => {
      await tools[0].handler({ input: {} }, {});
      push({ type: "result", subtype: "success", result: "x" });
    };
    const out = await drain(new AnthropicAgentEngine().run(spec));
    expect(out.filter((e) => e.type === "tool_call")).toHaveLength(0);
    expect(events.filter((e) => e.type === "tool_call")).toHaveLength(1);
  });
});

describe("AnthropicAgentEngine — terminal", () => {
  it("(term) carries SDK total_cost_usd VERBATIM + stopReason + structuredOutput + sdk_session resume", async () => {
    const { spec } = baseSpec();
    driver = async (push) => {
      push({
        type: "result",
        subtype: "success",
        result: "the answer",
        session_id: "sess_final",
        total_cost_usd: 0.0421,
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 10,
        },
        structured_output: { ok: true, items: [1, 2, 3] },
      });
    };
    const out = await drain(new AnthropicAgentEngine().run(spec));
    const term = out.find((e) => e.type === "terminal") as any;
    expect(term).toBeTruthy();
    expect(term.costUsd).toBe(0.0421);
    expect(term.stopReason).toBe("end_turn");
    expect(term.structuredOutput).toEqual({ ok: true, items: [1, 2, 3] });
    expect(term.resume).toEqual({ kind: "sdk_session", sessionId: "sess_final" });
    expect(term.usage).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 10,
    });
  });

  it("(term) a non-success subtype rides through as the raw stopReason", async () => {
    const { spec } = baseSpec();
    driver = async (push) => {
      push({ type: "result", subtype: "error_max_turns", result: "partial", total_cost_usd: 0.01 });
    };
    const out = await drain(new AnthropicAgentEngine().run(spec));
    const term = out.find((e) => e.type === "terminal") as any;
    expect(term.stopReason).toBe("error_max_turns");
    expect(term.resume).toBeNull();
  });

  it("(term) the SDK result.result text rides as an assistant_text fallback (host gates whether to use it)", async () => {
    const { spec } = baseSpec();
    driver = async (push) => {
      push({ type: "result", subtype: "success", result: "fallback reply", session_id: "s" });
    };
    const out = await drain(new AnthropicAgentEngine().run(spec));
    const texts = out.filter((e) => e.type === "assistant_text") as any[];
    expect(texts).toHaveLength(1);
    expect(texts[0].text).toBe("fallback reply");
  });

  it("provider is 'anthropic'", () => {
    expect(new AnthropicAgentEngine().provider).toBe("anthropic");
  });
});

describe("AnthropicAgentEngine — multi-token failover (per-run rotation)", () => {
  const LIMIT_TEXT = "You've hit your limit · resets Jun 13, 12am (UTC)";

  function withTokenPool(pool: string, fn: () => Promise<void>): Promise<void> {
    const prevTokens = process.env.CLAUDE_CODE_OAUTH_TOKENS;
    const prevTok = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const prevKey = process.env.ANTHROPIC_API_KEY;
    const prevMode = process.env.PRAXIS_AGENT_AUTH_MODE;
    process.env.CLAUDE_CODE_OAUTH_TOKENS = pool;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.PRAXIS_AGENT_AUTH_MODE;
    return fn().finally(() => {
      if (prevTokens === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKENS;
      else process.env.CLAUDE_CODE_OAUTH_TOKENS = prevTokens;
      if (prevTok === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = prevTok;
      if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevKey;
      if (prevMode === undefined) delete process.env.PRAXIS_AGENT_AUTH_MODE;
      else process.env.PRAXIS_AGENT_AUTH_MODE = prevMode;
    });
  }

  it("(case 1) token#1 terminal usage-limit → token#2 success: run succeeds on token#2, limit text never surfaces", async () => {
    await withTokenPool("oat-1,oat-2", async () => {
      const { spec, events } = baseSpec();
      driver = async (push) => {
        if (captured.queryParams.length === 1) {
          push({ type: "result", subtype: "error_during_execution", result: LIMIT_TEXT });
        } else {
          push({ type: "result", subtype: "success", result: "real answer", session_id: "s2" });
        }
      };
      await drain(new AnthropicAgentEngine().run(spec));

      expect(captured.queryParams.length).toBe(2);
      expect(captured.queryParams[0].options.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oat-1");
      expect(captured.queryParams[1].options.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oat-2");
      expect(captured.queryParams[0].options.env.CLAUDE_CODE_OAUTH_TOKENS).toBeUndefined();

      const texts = events.filter((e) => e.type === "assistant_text").map((e: any) => e.text);
      expect(texts).toContain("real answer");
      expect(texts).not.toContain(LIMIT_TEXT);
      const terminal = events.find((e) => e.type === "terminal") as any;
      expect(terminal).toBeTruthy();
      expect(terminal.stopReason).toBe("end_turn");
    });
  });

  it("(case 2) token#1 THROWN usage-limit → token#2 success: rotation also handles throws", async () => {
    await withTokenPool("oat-1,oat-2", async () => {
      const { spec, events } = baseSpec();
      driver = async (push) => {
        if (captured.queryParams.length === 1) {
          throw new Error(LIMIT_TEXT);
        }
        push({ type: "result", subtype: "success", result: "answer via 2" });
      };
      await drain(new AnthropicAgentEngine().run(spec));
      expect(captured.queryParams.length).toBe(2);
      const texts = events.filter((e) => e.type === "assistant_text").map((e: any) => e.text);
      expect(texts).toContain("answer via 2");
    });
  });

  it("(case 3) both tokens hit the limit → terminal usage-limit surfaces (fleet-alert path intact)", async () => {
    await withTokenPool("oat-1,oat-2", async () => {
      const { spec, events } = baseSpec();
      driver = async (push) => {
        push({ type: "result", subtype: "error_during_execution", result: LIMIT_TEXT });
      };
      await drain(new AnthropicAgentEngine().run(spec));
      expect(captured.queryParams.length).toBe(2);
      const texts = events.filter((e) => e.type === "assistant_text").map((e: any) => e.text);
      expect(texts).toContain(LIMIT_TEXT);
      expect(events.find((e) => e.type === "terminal")).toBeTruthy();
    });
  });

  it("(case 4) output produced before the limit → NO rotation (dirty attempt commits)", async () => {
    await withTokenPool("oat-1,oat-2", async () => {
      const { spec, events } = baseSpec();
      driver = async (push) => {
        push({
          type: "assistant",
          message: { content: [{ type: "text", text: "partial work" }] },
        });
        push({ type: "result", subtype: "error_during_execution", result: LIMIT_TEXT });
      };
      await drain(new AnthropicAgentEngine().run(spec));
      expect(captured.queryParams.length).toBe(1);
      const texts = events.filter((e) => e.type === "assistant_text").map((e: any) => e.text);
      expect(texts).toContain("partial work");
    });
  });

  it("(case 5) single token → exactly one attempt (today's behavior preserved)", async () => {
    await withTokenPool("oat-solo", async () => {
      const { spec } = baseSpec();
      driver = async (push) =>
        push({ type: "result", subtype: "error_during_execution", result: LIMIT_TEXT });
      await drain(new AnthropicAgentEngine().run(spec));
      expect(captured.queryParams.length).toBe(1);
    });
  });
});

describe("AnthropicAgentEngine — model refusal fails loud", () => {
  it("a refused turn throws model_refusal at end of stream instead of finishing as an empty success", async () => {
    const { spec } = baseSpec();
    driver = async (push) => {
      push({
        type: "assistant",
        message: { content: [], stop_reason: "refusal", stop_details: { category: "cyber" } },
      });
      push({ type: "result", subtype: "success", stop_reason: "refusal", result: "", session_id: "s1" });
    };
    await expect(drain(new AnthropicAgentEngine().run(spec))).rejects.toThrow(
      "model_refusal: The model declined this request (cyber).",
    );
  });

  it("a local-scope fallback (subagent) keeps the main-thread refusal: the run still fails", async () => {
    const { spec } = baseSpec();
    driver = async (push) => {
      push({ type: "assistant", message: { content: [], stop_reason: "refusal", stop_details: { category: "bio" } } });
      push({ type: "system", subtype: "model_refusal_fallback", scope: "local" });
      push({ type: "result", subtype: "success", stop_reason: "end_turn", result: "", session_id: "s1" });
    };
    await expect(drain(new AnthropicAgentEngine().run(spec))).rejects.toThrow(
      "model_refusal: The model declined this request (bio).",
    );
  });

  it("a session-scope fallback clears the refusal and the run finishes normally", async () => {
    const { spec } = baseSpec();
    driver = async (push) => {
      push({ type: "assistant", message: { content: [], stop_reason: "refusal" } });
      push({ type: "system", subtype: "model_refusal_fallback", scope: "session" });
      push({ type: "result", subtype: "success", stop_reason: "end_turn", result: "ok", session_id: "s1" });
    };
    const events = await drain(new AnthropicAgentEngine().run(spec));
    expect(events.some((e) => e.type === "terminal")).toBe(true);
  });

  it("an unscoped (older CLI) fallback-model retry clears the refusal and the run finishes normally", async () => {
    const { spec } = baseSpec();
    driver = async (push) => {
      push({ type: "assistant", message: { content: [], stop_reason: "refusal" } });
      push({ type: "system", subtype: "model_refusal_fallback" });
      push({ type: "result", subtype: "success", stop_reason: "end_turn", result: "ok", session_id: "s1" });
    };
    const events = await drain(new AnthropicAgentEngine().run(spec));
    expect(events.some((e) => e.type === "terminal")).toBe(true);
  });
});
