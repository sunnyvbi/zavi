
import { describe, it, expect, vi, beforeEach } from "vitest";

type CapturedRun = {
  agent: any;
  input: any;
  options: any;
};

// eslint-disable-next-line no-var
var captured: { runs: CapturedRun[] } = { runs: [] };
// eslint-disable-next-line no-var
var driver:
  | ((agent: any, push: (data: unknown) => void) => Promise<void>)
  | null = null;
// eslint-disable-next-line no-var
var streamFinal: { lastResponseId?: string; usageRaw?: unknown } = {};

vi.mock("@openai/agents", () => {
  class FakeRunRawModelStreamEvent {
    readonly type = "raw_model_stream_event";
    constructor(public data: unknown) {}
  }
  return {
    RunRawModelStreamEvent: FakeRunRawModelStreamEvent,
    MaxTurnsExceededError: class MaxTurnsExceededError extends Error {},
    OpenAIChatCompletionsModel: class OpenAIChatCompletionsModel {
      constructor(..._args: unknown[]) {}
    },
    tool: (opts: any) => ({
      type: "function",
      name: opts.name,
      description: opts.description,
      parameters: opts.parameters,
      strict: opts.strict,
      execute: opts.execute,
      _isHosted: false,
    }),
    Agent: class {
      name: string;
      instructions: any;
      model: any;
      tools: any[];
      handoffs: any[];
      mcpServers: any[];
      constructor(cfg: any) {
        this.name = cfg.name;
        this.instructions = cfg.instructions;
        this.model = cfg.model;
        this.tools = cfg.tools ?? [];
        this.handoffs = cfg.handoffs ?? [];
        this.mcpServers = cfg.mcpServers ?? [];
      }
    },
    run: async (agent: any, input: any, options: any) => {
      captured.runs.push({ agent, input, options });
      return {
        async *[Symbol.asyncIterator]() {
          const events: unknown[] = [];
          const push = (data: unknown) =>
            events.push(new FakeRunRawModelStreamEvent(data));
          let driverErr: unknown;
          try {
            if (driver) await driver(agent, push);
          } catch (e) {
            driverErr = e;
          }
          for (const e of events) yield e;
          if (driverErr) throw driverErr;
        },
        completed: Promise.resolve(),
        get lastResponseId() {
          return streamFinal.lastResponseId;
        },
        state: {
          get usage() {
            return streamFinal.usageRaw;
          },
        },
        error: undefined,
      };
    },
  };
});

vi.mock("@/services/openai", () => ({
  getOpenAi: () => ({ _fake: true }),
}));

import { OpenAIAgentEngine, buildOpenAiAgent } from "../openai-engine";
import type {
  AgentEngineRunSpec,
  EngineEvent,
  EngineToolCall,
  EngineToolResult,
} from "../types";

function baseSpec(
  overrides: Partial<AgentEngineRunSpec> = {},
): {
  spec: AgentEngineRunSpec;
  events: EngineEvent[];
  dispatchCalls: EngineToolCall[];
} {
  const events: EngineEvent[] = [];
  const dispatchCalls: EngineToolCall[] = [];
  const dispatchTool = vi.fn(
    async (call: EngineToolCall): Promise<EngineToolResult> => {
      dispatchCalls.push(call);
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
    model: "gpt-5.5",
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
  captured.runs = [];
  driver = null;
  streamFinal = {};
});

describe("OpenAIAgentEngine — tool funnel routing", () => {
  it("(a) a model tool call routes through spec.dispatchTool with the bare name + tool_use_id and feeds the result back", async () => {
    const { spec, dispatchCalls } = baseSpec();
    let modelSawResult: unknown;

    driver = async (agent, push) => {
      push({ type: "output_text_delta", delta: "thinking..." });
      const fnTool = agent.tools[0];
      modelSawResult = await fnTool.execute(
        { channel: "C1", text: "hi" },
        undefined,
        { toolCall: { callId: "call_abc123" } },
      );
      push({
        type: "response_done",
        response: { id: "resp_1", usage: { inputTokens: 10, outputTokens: 4 } },
      });
    };

    const engine = new OpenAIAgentEngine();
    await drain(engine.run(spec));

    expect(dispatchCalls).toHaveLength(1);
    expect(dispatchCalls[0]).toEqual({
      tool_name: "slack__post_message",
      input: { channel: "C1", text: "hi" },
      tool_use_id: "call_abc123",
    });
    expect(modelSawResult).toBe(JSON.stringify({ result: "real-output" }));
  });

  it("(a1) strips null args before dispatch (strict-mode optionals arrive as null)", async () => {
    const { spec, dispatchCalls } = baseSpec();
    driver = async (agent) => {
      await agent.tools[0].execute(
        { query: "x", projection: null, sort: null, nested: { keep: 1, drop: null } },
        undefined,
        { toolCall: { callId: "c1" } },
      );
    };
    await drain(new OpenAIAgentEngine().run(spec));
    expect(dispatchCalls).toHaveLength(1);
    expect(dispatchCalls[0].input).toEqual({ query: "x", nested: { keep: 1 } });
  });

  it("(a2) synthesizes a stable tool_use_id when the SDK gives no callId", async () => {
    const { spec, dispatchCalls } = baseSpec();
    driver = async (agent) => {
      await agent.tools[0].execute({ x: 1 }, undefined, undefined);
    };
    const engine = new OpenAIAgentEngine();
    await drain(engine.run(spec));
    expect(dispatchCalls).toHaveLength(1);
    expect(dispatchCalls[0].tool_use_id).toMatch(/^slack__post_message:/);
  });

  it("(b) a deny result is surfaced to the model as a normal tool result string (not executed, not thrown)", async () => {
    const events: EngineEvent[] = [];
    const denyDispatch = vi.fn(
      async (call: EngineToolCall): Promise<EngineToolResult> => ({
        is_error: true,
        content:
          "operator_db denied: pm's access to the customer business DB is not enabled.",
        ms: 0,
        code: "pm_operator_db_policy",
        denied: true,
      }),
    );
    const { spec } = baseSpec({
      onEvent: (e) => events.push(e),
      dispatchTool: denyDispatch as unknown as AgentEngineRunSpec["dispatchTool"],
    });

    let modelSaw: unknown;
    let threw = false;
    driver = async (agent) => {
      try {
        modelSaw = await agent.tools[0].execute({}, undefined, {
          toolCall: { callId: "c1" },
        });
      } catch {
        threw = true;
      }
    };

    const engine = new OpenAIAgentEngine();
    await drain(engine.run(spec));

    expect(threw).toBe(false);
    expect(modelSaw).toBe(
      "operator_db denied: pm's access to the customer business DB is not enabled.",
    );
    expect(denyDispatch).toHaveBeenCalledTimes(1);
  });
});

describe("OpenAIAgentEngine — event mapping", () => {
  it("(c) maps text_delta + usage + terminal; adapter never emits tool_call (funnel owns it)", async () => {
    const { spec } = baseSpec();
    streamFinal = {
      lastResponseId: "resp_final",
      usageRaw: { inputTokens: 100, outputTokens: 20 },
    };
    driver = async (agent, push) => {
      push({ type: "output_text_delta", delta: "Hello " });
      push({ type: "output_text_delta", delta: "world" });
      await agent.tools[0].execute({}, undefined, { toolCall: { callId: "c" } });
      push({
        type: "response_done",
        response: { id: "resp_1", usage: { inputTokens: 100, outputTokens: 20 } },
      });
    };

    const engine = new OpenAIAgentEngine();
    const out = await drain(engine.run(spec));

    const textDeltas = out.filter((e) => e.type === "text_delta");
    expect(textDeltas.map((e: any) => e.text)).toEqual(["Hello ", "world"]);

    expect(out.filter((e) => e.type === "tool_call")).toHaveLength(0);

    const usageEvents = out.filter((e) => e.type === "usage");
    expect(usageEvents.length).toBeGreaterThanOrEqual(1);
    expect((usageEvents[0] as any).usage).toEqual({
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });

    const terminal = out.find((e) => e.type === "terminal");
    expect(terminal).toBeTruthy();
    expect((terminal as any).resume).toEqual({
      kind: "openai",
      lastResponseId: "resp_final",
    });
    expect((terminal as any).usage).toEqual({
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
  });

  it("(c2) cached prompt tokens are subtracted out of input_tokens (disjoint, no double-bill)", async () => {
    const { spec } = baseSpec();
    driver = async (_agent, push) => {
      push({
        type: "response_done",
        response: {
          id: "r",
          usage: {
            inputTokens: 100,
            outputTokens: 5,
            inputTokensDetails: { cached_tokens: 40 },
          },
        },
      });
    };
    const engine = new OpenAIAgentEngine();
    const out = await drain(engine.run(spec));
    const usage = out.find((e) => e.type === "usage") as any;
    expect(usage.usage).toEqual({
      input_tokens: 60,
      output_tokens: 5,
      cache_read_input_tokens: 40,
      cache_creation_input_tokens: 0,
    });
  });

  it("(c3) onEvent receives the SAME events that are yielded (parity)", async () => {
    const { spec, events } = baseSpec();
    streamFinal = { lastResponseId: "rid" };
    driver = async (_agent, push) => {
      push({ type: "output_text_delta", delta: "x" });
    };
    const engine = new OpenAIAgentEngine();
    const yielded = await drain(engine.run(spec));
    expect(events).toHaveLength(yielded.length);
    expect(events.map((e) => e.type)).toEqual(yielded.map((e) => e.type));
  });
});

describe("OpenAIAgentEngine — run wiring", () => {
  it("(d) threads the abort signal + maxTurns into run() options", async () => {
    const ac = new AbortController();
    const { spec } = baseSpec({ abort: ac, maxTurns: 42 });
    driver = async () => {};
    const engine = new OpenAIAgentEngine();
    await drain(engine.run(spec));
    expect(captured.runs).toHaveLength(1);
    expect(captured.runs[0].options.signal).toBe(ac.signal);
    expect(captured.runs[0].options.maxTurns).toBe(42);
    expect(captured.runs[0].options.stream).toBe(true);
  });

  it("(d2) abort mid-run terminates the stream with a terminal event (no rethrow)", async () => {
    const ac = new AbortController();
    const { spec } = baseSpec({ abort: ac });
    driver = async (_agent, push) => {
      push({ type: "output_text_delta", delta: "partial" });
      ac.abort();
      const err = new Error("aborted");
      (err as any).name = "AbortError";
      throw err;
    };
    const engine = new OpenAIAgentEngine();
    const out = await drain(engine.run(spec));
    expect(out.some((e) => e.type === "text_delta")).toBe(true);
    const terminal = out.find((e) => e.type === "terminal");
    expect(terminal).toBeTruthy();
    expect((terminal as any).resume.kind).toBe("openai");
  });

  it("(d3) a non-abort transport error still emits terminal, then rethrows", async () => {
    const { spec } = baseSpec();
    driver = async () => {
      throw new Error("openai 500");
    };
    const engine = new OpenAIAgentEngine();
    const it = engine.run(spec);
    const seen: EngineEvent[] = [];
    let caught: unknown;
    try {
      for await (const e of it) seen.push(e);
    } catch (err) {
      caught = err;
    }
    expect(seen.some((e) => e.type === "terminal")).toBe(true);
    expect((caught as Error)?.message).toBe("openai 500");
  });

  it("(e) an image input part maps to input_image; text is preserved + ordered", async () => {
    const { spec } = baseSpec({
      userPrompt: [
        { type: "text", text: "describe this" },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: "AAAA",
          },
        } as any,
      ],
    });
    driver = async () => {};
    const engine = new OpenAIAgentEngine();
    await drain(engine.run(spec));
    const input = captured.runs[0].input;
    expect(Array.isArray(input)).toBe(true);
    expect(input[0].role).toBe("user");
    expect(input[0].content).toEqual([
      { type: "input_text", text: "describe this" },
      { type: "input_image", image: "data:image/png;base64,AAAA" },
    ]);
  });

  it("(e3) an attached PDF is named, never sent as base64 text", async () => {
    const { spec } = baseSpec({
      userPrompt: [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0xLjQ=" }, title: "menu.pdf" } as any,
        { type: "text", text: "what does this say?" },
      ],
    });
    driver = async () => {};
    const engine = new OpenAIAgentEngine();
    await drain(engine.run(spec));
    const parts = captured.runs[0].input[0].content as Array<{ type: string; text?: string }>;
    expect(parts.map((p) => p.type)).toEqual(["input_text", "input_text"]);
    expect(parts[0].text).toContain("menu.pdf");
    expect(JSON.stringify(parts)).not.toContain("JVBERi0xLjQ=");
    expect(parts[1].text).toBe("what does this say?");
  });

  it("(e2) a plain-string userPrompt maps to a single input_text part", async () => {
    const { spec } = baseSpec({ userPrompt: "just text" });
    driver = async () => {};
    const engine = new OpenAIAgentEngine();
    await drain(engine.run(spec));
    expect(captured.runs[0].input[0].content).toEqual([
      { type: "input_text", text: "just text" },
    ]);
  });

  it("(f) resume: re-feeds our own {kind:'openai'} lastResponseId as previousResponseId", async () => {
    const { spec } = baseSpec({
      resume: { kind: "openai", lastResponseId: "resp_prev" },
    });
    driver = async () => {};
    const engine = new OpenAIAgentEngine();
    await drain(engine.run(spec));
    expect(captured.runs[0].options.previousResponseId).toBe("resp_prev");
  });

  it("(f2) a foreign resume handle (sdk_session) is ignored (falls closed to first-turn)", async () => {
    const { spec } = baseSpec({
      resume: { kind: "sdk_session", sessionId: "abc" },
    });
    driver = async () => {};
    const engine = new OpenAIAgentEngine();
    await drain(engine.run(spec));
    expect(captured.runs[0].options.previousResponseId).toBeUndefined();
  });
});

describe("OpenAIAgentEngine — fail-loud config", () => {
  it("throws a clear error when OPENAI_API_KEY is unset (getOpenAi null)", async () => {
    const mod = await import("@/services/openai");
    const spy = vi.spyOn(mod, "getOpenAi").mockReturnValue(null as any);
    const { spec } = baseSpec();
    const engine = new OpenAIAgentEngine();
    await expect(drain(engine.run(spec))).rejects.toThrow(/OPENAI_API_KEY/);
    spy.mockRestore();
  });

  it("provider is 'openai'", () => {
    expect(new OpenAIAgentEngine().provider).toBe("openai");
  });
});

describe("buildOpenAiAgent — config shape", () => {
  it("constructs an Agent with the system prompt as instructions + model + mapped function tools", () => {
    const { spec } = baseSpec();
    const agent = buildOpenAiAgent(spec) as any;
    expect(agent.instructions).toBe("you are a test agent");
    expect(agent.model).toBe("gpt-5.5");
    expect(agent.tools).toHaveLength(1);
    expect(agent.tools[0].type).toBe("function");
    expect(agent.tools[0].name).toBe("slack__post_message");
    expect(agent.tools[0].strict).toBe(true);
  });

  it("gates strict:false for an OPEN-MAP param tool (z.record) — would otherwise OpenAI-400", () => {
    const { spec } = baseSpec({
      tools: [
        {
          name: "meta_ads__propose_new_ad_set",
          description: "propose a new ad set",
          jsonSchema: {
            type: "object",
            additionalProperties: false,
            required: ["targeting"],
            properties: {
              targeting: { type: "object", additionalProperties: { type: "string" } },
            },
          },
        },
      ] as AgentEngineRunSpec["tools"],
    });
    const agent = buildOpenAiAgent(spec) as any;
    expect(agent.tools[0].name).toBe("meta_ads__propose_new_ad_set");
    expect(agent.tools[0].strict).toBe(false);
  });

  it("keeps strict:true for a closed schema with real fixed properties", () => {
    const { spec } = baseSpec({
      tools: [
        {
          name: "report__get",
          description: "get a report",
          jsonSchema: {
            type: "object",
            additionalProperties: false,
            required: ["id"],
            properties: { id: { type: "string" } },
          },
        },
      ] as AgentEngineRunSpec["tools"],
    });
    const agent = buildOpenAiAgent(spec) as any;
    expect(agent.tools[0].strict).toBe(true);
  });
});

describe("OpenAIAgentEngine — barge-in segment loop (money: sum-once)", () => {
  function usageDriver(perSegment: Array<{ i: number; o: number }>) {
    let seg = -1;
    return async (_agent: any, push: (d: unknown) => void) => {
      seg += 1;
      const u = perSegment[Math.min(seg, perSegment.length - 1)];
      push({
        type: "response_done",
        response: { id: `resp-${seg + 1}`, usage: { inputTokens: u.i, outputTokens: u.o } },
      });
    };
  }

  it("no steerSource → ONE segment, ONE terminal with that segment's usage (byte-identical)", async () => {
    streamFinal = {};
    driver = usageDriver([{ i: 100, o: 40 }]);
    const { spec, events } = baseSpec();
    await drain(new OpenAIAgentEngine().run(spec));
    expect(captured.runs.length).toBe(1);
    const terminals = events.filter((e) => e.type === "terminal");
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({
      usage: { input_tokens: 100, output_tokens: 40 },
    });
    expect(events.some((e) => e.type === "steer_drained")).toBe(false);
  });

  it("3-segment barge-in run charges the SUM of all segments' usage in ONE terminal", async () => {
    streamFinal = {};
    driver = usageDriver([
      { i: 100, o: 40 },
      { i: 30, o: 12 },
      { i: 50, o: 20 },
    ]);
    let call = 0;
    const marked: string[] = [];
    const steerSource = {
      drain: async () => {
        call += 1;
        if (call === 1) return [{ id: "s1", seq: 1, body: "use PROD account", origin: "chat" as const, author_user_id: "u1" }];
        if (call === 2) return [{ id: "s2", seq: 2, body: "skip the refund", origin: "chat" as const, author_user_id: "u1" }];
        return [];
      },
      markDrained: async (ids: string[]) => {
        marked.push(...ids);
      },
    };
    const { spec, events } = baseSpec({
      steerSource,
      resume: { kind: "openai", lastResponseId: undefined },
    });
    await drain(new OpenAIAgentEngine().run(spec));

    expect(captured.runs.length).toBe(3);
    const terminals = events.filter((e) => e.type === "terminal");
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({
      usage: { input_tokens: 180, output_tokens: 72 },
    });
    expect(marked).toEqual(["s1", "s2"]);
    expect(events.filter((e) => e.type === "steer_drained")).toHaveLength(2);
    expect(captured.runs[1].options.previousResponseId).toBe("resp-1");
    expect(captured.runs[2].options.previousResponseId).toBe("resp-2");
  });

  it("stateless mode does NOT barge-in in-run (context would be lost) — one segment, steer left for the reroute", async () => {
    const prev = process.env.AWS_BEARER_TOKEN_BEDROCK;
    process.env.AWS_BEARER_TOKEN_BEDROCK = "test-bearer";
    try {
      streamFinal = {};
      driver = usageDriver([{ i: 100, o: 40 }]);
      let drainCalls = 0;
      const steerSource = {
        drain: async () => {
          drainCalls += 1;
          return [{ id: "s1", seq: 1, body: "steer", origin: "chat" as const, author_user_id: "u1" }];
        },
        markDrained: async () => {},
      };
      const { spec, events } = baseSpec({ steerSource, model: "qwen.qwen3-next-80b-a3b-instruct" });
      const { BedrockOpenAICompatAgentEngine } = await import("../openai-engine");
      await drain(new BedrockOpenAICompatAgentEngine().run(spec));
      expect(captured.runs.length).toBe(1);
      expect(drainCalls).toBe(0);
      expect(events.filter((e) => e.type === "terminal")).toHaveLength(1);
      expect(events[events.length - 1]).toMatchObject({ resume: null });
    } finally {
      if (prev === undefined) delete process.env.AWS_BEARER_TOKEN_BEDROCK;
      else process.env.AWS_BEARER_TOKEN_BEDROCK = prev;
    }
  });

  it("a poison steer source (always returns a new steer) is BOUNDED — total segments capped, ONE terminal still emitted", async () => {
    streamFinal = {};
    driver = usageDriver([{ i: 5, o: 2 }]);
    let seq = 0;
    const steerSource = {
      drain: async () => {
        seq += 1;
        return [{ id: `p${seq}`, seq, body: "again", origin: "chat" as const, author_user_id: "u1" }];
      },
      markDrained: async () => {},
    };
    const { spec, events } = baseSpec({
      steerSource,
      resume: { kind: "openai", lastResponseId: undefined },
    });
    await drain(new OpenAIAgentEngine().run(spec));
    expect(captured.runs.length).toBeLessThanOrEqual(24);
    expect(captured.runs.length).toBeGreaterThan(1);
    expect(events.filter((e) => e.type === "terminal")).toHaveLength(1);
  });
});
