
import { describe, it, expect, vi, beforeEach } from "vitest";

const streamed = vi.fn();
const created = vi.fn();

vi.mock("deepagents", () => ({
  createDeepAgent: (params: unknown) => {
    created(params);
    return { stream: async (_i: unknown, cfg: unknown) => streamed(cfg) };
  },
}));

vi.mock("../backends/mount", () => ({
  buildBackend: () => ({}),
  ZAVI_FS_PERMISSIONS: [],
}));

import { LangChainDeepAgentEngine, isGraphRecursionError } from "../engine";
import type { AgentEngineRunSpec, EngineEvent } from "../../engine/types";

async function* chunks(list: unknown[]) {
  for (const c of list) yield c;
}

function spec(over: Partial<AgentEngineRunSpec> = {}): AgentEngineRunSpec {
  return {
    systemPrompt: "sys",
    userPrompt: "hi",
    model: "claude-sonnet-4-6",
    maxTurns: 10,
    tools: [],
    resume: null,
    abort: new AbortController(),
    dispatchTool: async () => ({ is_error: false, content: "{}", ms: 1 }),
    onEvent: () => {},
    tenantId: undefined,
    ...over,
  } as AgentEngineRunSpec;
}

async function drainWithSink(
  s: AgentEngineRunSpec,
): Promise<{ yielded: EngineEvent[]; sunk: EngineEvent[] }> {
  const sunk: EngineEvent[] = [];
  (s as { onEvent: (e: EngineEvent) => void }).onEvent = (e) => sunk.push(e);
  const yielded: EngineEvent[] = [];
  for await (const e of new LangChainDeepAgentEngine({ mountMemory: false }).run(s)) {
    yielded.push(e);
  }
  return { yielded, sunk };
}

async function drain(s: AgentEngineRunSpec): Promise<EngineEvent[]> {
  const out: EngineEvent[] = [];
  for await (const e of new LangChainDeepAgentEngine({ mountMemory: false }).run(s)) {
    out.push(e);
  }
  return out;
}

const aiText = (text: string, usage?: Record<string, unknown>) => [
  "messages",
  [{ content: text, usage_metadata: usage }, {}],
];

beforeEach(() => {
  streamed.mockReset();
  created.mockReset();
});

describe("LangChainDeepAgentEngine.run — stream contract", () => {
  it("yields text, sums usage, and ends end_turn", async () => {
    streamed.mockReturnValue(
      chunks([
        aiText("hello ", { input_tokens: 10, output_tokens: 2 }),
        aiText("world", { input_tokens: 5, output_tokens: 3 }),
      ]),
    );
    const events = await drain(spec());
    expect(events.filter((e) => e.type === "text_delta")).toEqual([
      { type: "text_delta", text: "hello " },
      { type: "text_delta", text: "world" },
    ]);
    const terminal = events.at(-1) as Extract<EngineEvent, { type: "terminal" }>;
    expect(terminal.usage.input_tokens).toBe(15);
    expect(terminal.usage.output_tokens).toBe(5);
    expect(terminal.stopReason).toBe("end_turn");
  });

  it("surfaces structuredResponse from the VALUES stream as terminal.structuredOutput", async () => {
    streamed.mockReturnValue(
      chunks([["values", { structuredResponse: { rendered_markdown: "# ok" } }]]),
    );
    const terminal = (await drain(spec())).at(-1) as Extract<
      EngineEvent,
      { type: "terminal" }
    >;
    expect(terminal.structuredOutput).toEqual({ rendered_markdown: "# ok" });
  });

  it("a structured-output run with NO assistant text still ends end_turn", async () => {
    streamed.mockReturnValue(chunks([["values", { structuredResponse: { a: 1 } }]]));
    const terminal = (await drain(spec())).at(-1) as Extract<
      EngineEvent,
      { type: "terminal" }
    >;
    expect(terminal.stopReason).toBe("end_turn");
  });

  it("keeps the LAST structuredResponse and ignores value chunks without one", async () => {
    streamed.mockReturnValue(
      chunks([
        ["values", { messages: [] }],
        ["values", { structuredResponse: { v: 1 } }],
        ["values", { structuredResponse: { v: 2 } }],
        ["values", { messages: [] }],
      ]),
    );
    const terminal = (await drain(spec())).at(-1) as Extract<
      EngineEvent,
      { type: "terminal" }
    >;
    expect(terminal.structuredOutput).toEqual({ v: 2 });
  });

  it("a run with neither text nor structured output is an error", async () => {
    streamed.mockReturnValue(chunks([]));
    const terminal = (await drain(spec())).at(-1) as Extract<
      EngineEvent,
      { type: "terminal" }
    >;
    expect(terminal.stopReason).toBe("error_during_execution");
    expect(terminal.structuredOutput).toBeUndefined();
  });

  it("counts summarization tokens as spend but not as the agent's reply", async () => {
    streamed.mockReturnValue(
      chunks([
        [
          "messages",
          [
            { content: "internal recap", usage_metadata: { input_tokens: 100, output_tokens: 7 } },
            { lcSource: "summarization" },
          ],
        ],
        aiText("real answer", { input_tokens: 1, output_tokens: 1 }),
      ]),
    );
    const events = await drain(spec());
    expect(events.filter((e) => e.type === "text_delta")).toEqual([
      { type: "text_delta", text: "real answer" },
    ]);
    const terminal = events.at(-1) as Extract<EngineEvent, { type: "terminal" }>;
    expect(terminal.usage.input_tokens).toBe(101);
  });
});

describe("structured output must speak OpenAI strict JSON Schema", () => {
  it("normalizes the schema before handing it to the provider", async () => {
    streamed.mockReturnValue(chunks([]));
    await drain(
      spec({
        outputJsonSchema: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              rendered_markdown: { type: "string", minLength: 1 },
              note: { type: "string" },
            },
            required: ["rendered_markdown"],
          },
        },
      } as never),
    );
    const rf = (created.mock.calls[0][0] as { responseFormat?: Record<string, unknown> })
      .responseFormat;
    expect(rf?.additionalProperties).toBe(false);
    expect(rf?.required).toEqual(["rendered_markdown", "note"]);
    expect(JSON.stringify(rf)).not.toContain("minLength");
  });

  it("sends no responseFormat when the run did not ask for one", async () => {
    streamed.mockReturnValue(chunks([]));
    await drain(spec());
    expect(created.mock.calls[0][0]).not.toHaveProperty("responseFormat");
  });
});

describe("graph recursion budget", () => {
  it("asks for a budget that fits middleware + subagent nodes, not just turns", async () => {
    streamed.mockReturnValue(chunks([]));
    await drain(spec({ maxTurns: 14 } as never));
    const cfg = streamed.mock.calls[0][0] as { recursionLimit: number };
    expect(cfg.recursionLimit).toBeGreaterThan(28);
  });

  it("degrades a recursion trip to error_max_turns instead of throwing", async () => {
    async function* boom() {
      yield aiText("partial answer so far", { input_tokens: 9, output_tokens: 4 });
      const e = new Error(
        "Recursion limit of 28 reached without hitting a stop condition.",
      );
      e.name = "GraphRecursionError";
      throw e;
    }
    streamed.mockReturnValue(boom());
    const events = await drain(spec());
    const terminal = events.at(-1) as Extract<EngineEvent, { type: "terminal" }>;
    expect(terminal.stopReason).toBe("error_max_turns");
    expect(events.some((e) => e.type === "text_delta")).toBe(true);
    expect(terminal.usage.input_tokens).toBe(9);
  });

  it("still throws on a genuine error — a real failure must not look like a cap", async () => {
    async function* boom() {
      yield aiText("x");
      throw new Error("connection reset by peer");
    }
    streamed.mockReturnValue(boom());
    await expect(drain(spec())).rejects.toThrow(/connection reset/);
  });

  it("recognises the recursion error by name OR message", () => {
    const byName = new Error("something");
    byName.name = "GraphRecursionError";
    expect(isGraphRecursionError(byName)).toBe(true);
    expect(isGraphRecursionError(new Error("Recursion limit of 40 reached"))).toBe(true);
    expect(isGraphRecursionError(new Error("connection reset"))).toBe(false);
    expect(isGraphRecursionError(null)).toBe(false);
  });
});

describe("cancellation", () => {
  it("hands the host's abort signal to the graph", async () => {
    streamed.mockReturnValue(chunks([]));
    const s = spec();
    await drain(s);
    const cfg = streamed.mock.calls[0][0] as { signal?: AbortSignal };
    expect(cfg.signal).toBe(s.abort.signal);
  });

  it("propagates an abort — the host's budget/kill path must not see it as a clean cap", async () => {
    async function* aborted() {
      yield aiText("partial");
      const e = new Error("Aborted");
      e.name = "AbortError";
      throw e;
    }
    streamed.mockReturnValue(aborted());
    await expect(drain(spec())).rejects.toThrow(/abort/i);
  });
});

describe("spec.onEvent is the host's channel — everything must go through it", () => {
  it("pushes every yielded event to onEvent as well", async () => {
    streamed.mockReturnValue(
      chunks([
        aiText("hello ", { input_tokens: 10, output_tokens: 2 }),
        aiText("world", { input_tokens: 1, output_tokens: 1 }),
      ]),
    );
    const { yielded, sunk } = await drainWithSink(spec());
    expect(sunk.map((e) => e.type)).toEqual(yielded.map((e) => e.type));
    expect(
      sunk
        .filter((e) => e.type === "text_delta")
        .map((e) => (e as { text: string }).text)
        .join(""),
    ).toBe("hello world");
    const terminal = sunk.at(-1) as Extract<EngineEvent, { type: "terminal" }>;
    expect(terminal.type).toBe("terminal");
    expect(terminal.usage.input_tokens).toBe(11);
  });

  it("does NOT emit tool_call — the funnel owns that row (no double audit)", async () => {
    streamed.mockReturnValue(chunks([aiText("x", { input_tokens: 1, output_tokens: 1 })]));
    const { sunk } = await drainWithSink(spec());
    expect(sunk.some((e) => e.type === "tool_call")).toBe(false);
  });

  it("reports a cost for the model that actually ran", async () => {
    streamed.mockReturnValue(
      chunks([aiText("x", { input_tokens: 1_000_000, output_tokens: 0 })]),
    );
    const terminal = (await drain(spec())).at(-1) as Extract<
      EngineEvent,
      { type: "terminal" }
    >;
    expect(terminal.costUsd).toBeGreaterThan(0);
  });
});
