
import { describe, expect, it, vi } from "vitest";
import type {
  AgentEngine,
  AgentEngineRunSpec,
  EngineEvent,
  NormalizedUsage,
} from "@/services/agents/engine/types";
import type { CallModelOpts, CallModelResult } from "@/services/llm/call-model";
import type { ParityTask } from "../engine-parity";
import { runTaskThroughEngine, makeLiveRunTask } from "../live-runner";

const ZERO: NormalizedUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

function task(over: Partial<ParityTask> = {}): ParityTask {
  return {
    task_id: "t1",
    agent_slug: "operator",
    label: "test task",
    system: "you are a helper",
    prompt: "do the thing",
    ...over,
  };
}

function scriptedEngine(script: EngineEvent[]): AgentEngine {
  return {
    provider: "openai",
    async *run(spec: AgentEngineRunSpec) {
      for (const e of script) {
        spec.onEvent(e);
        yield e;
      }
    },
  };
}

function throwingEngine(before: EngineEvent[], err: Error): AgentEngine {
  return {
    provider: "openai",
    async *run(spec: AgentEngineRunSpec) {
      for (const e of before) {
        spec.onEvent(e);
        yield e;
      }
      throw err;
    },
  };
}

describe("runTaskThroughEngine — OpenAI lane (stubbed engine)", () => {
  it("concatenates text_delta events into output", async () => {
    const usage: NormalizedUsage = { ...ZERO, input_tokens: 100, output_tokens: 40 };
    const engine = scriptedEngine([
      { type: "text_delta", text: "Hello " },
      { type: "text_delta", text: "world" },
      { type: "terminal", resume: null, usage },
    ]);
    const cap = await runTaskThroughEngine(task(), "openai", {
      engineFactory: () => engine,
      now: (() => {
        let t = 1000;
        return () => (t += 10);
      })(),
    });
    expect(cap.output).toBe("Hello world");
    expect(cap.errored).toBe(false);
    expect(cap.gated_tool_calls).toBe(0);
  });

  it("takes usage from the terminal event", async () => {
    const usage: NormalizedUsage = { ...ZERO, input_tokens: 222, output_tokens: 11 };
    const engine = scriptedEngine([
      { type: "usage", usage: { ...ZERO, input_tokens: 1 } },
      { type: "text_delta", text: "x" },
      { type: "terminal", resume: null, usage },
    ]);
    const cap = await runTaskThroughEngine(task(), "openai", {
      engineFactory: () => engine,
    });
    expect(cap.usage).toEqual(usage);
  });

  it("falls back to the last usage event when there is no terminal usage", async () => {
    const usage: NormalizedUsage = { ...ZERO, output_tokens: 7 };
    const engine = scriptedEngine([
      { type: "text_delta", text: "y" },
      { type: "usage", usage },
    ]);
    const cap = await runTaskThroughEngine(task(), "openai", {
      engineFactory: () => engine,
    });
    expect(cap.usage).toEqual(usage);
  });

  it("counts tool_call events as gated_tool_calls", async () => {
    const engine = scriptedEngine([
      { type: "tool_call", name: "github__list_prs", ms: 5, code: "ok", iter: 1 },
      { type: "tool_call", name: "github__get_pr", ms: 8, code: "ok", iter: 2 },
      { type: "text_delta", text: "done" },
      { type: "terminal", resume: null, usage: ZERO },
    ]);
    const cap = await runTaskThroughEngine(task(), "openai", {
      engineFactory: () => engine,
    });
    expect(cap.gated_tool_calls).toBe(2);
  });

  it("captures errored:true (with error_detail) when the run throws", async () => {
    const engine = throwingEngine(
      [{ type: "text_delta", text: "partial" }],
      Object.assign(new Error("boom"), { name: "OpenAIBadRequestError" }),
    );
    const cap = await runTaskThroughEngine(task(), "openai", {
      engineFactory: () => engine,
    });
    expect(cap.errored).toBe(true);
    expect(cap.error_detail).toBe("OpenAIBadRequestError");
    expect(cap.output).toBe("partial");
  });

  it("attaches a structured outputJsonSchema for a classified agent slug", async () => {
    let capturedSpec: AgentEngineRunSpec | null = null;
    const engine: AgentEngine = {
      provider: "openai",
      async *run(spec) {
        capturedSpec = spec;
        spec.onEvent({ type: "terminal", resume: null, usage: ZERO });
        yield { type: "terminal", resume: null, usage: ZERO } as EngineEvent;
      },
    };
    await runTaskThroughEngine(task({ agent_slug: "pm" }), "openai", {
      engineFactory: () => engine,
    });
    expect(capturedSpec).not.toBeNull();
    expect(capturedSpec!.outputJsonSchema?.type).toBe("json_schema");
    expect(capturedSpec!.outputJsonSchema?.schema).toBeTypeOf("object");
  });

  it("omits outputJsonSchema for an unclassified slug (pure text)", async () => {
    let capturedSpec: AgentEngineRunSpec | null = null;
    const engine: AgentEngine = {
      provider: "openai",
      async *run(spec) {
        capturedSpec = spec;
        spec.onEvent({ type: "terminal", resume: null, usage: ZERO });
        yield { type: "terminal", resume: null, usage: ZERO } as EngineEvent;
      },
    };
    await runTaskThroughEngine(task({ agent_slug: "operator" }), "openai", {
      engineFactory: () => engine,
    });
    expect(capturedSpec!.outputJsonSchema).toBeUndefined();
  });
});

describe("runTaskThroughEngine — Anthropic baseline lane (stubbed callModel)", () => {
  it("returns the callModel text + usage as the capture", async () => {
    const usage: NormalizedUsage = { ...ZERO, input_tokens: 50, output_tokens: 25 };
    const callModelFn = vi.fn(
      async (_opts: CallModelOpts): Promise<CallModelResult> => ({
        text: "baseline answer",
        usage,
        provider: "anthropic",
      }),
    );
    const cap = await runTaskThroughEngine(task(), "anthropic", {
      callModelFn: callModelFn as unknown as typeof import("@/services/llm/call-model").callModel,
    });
    expect(cap.output).toBe("baseline answer");
    expect(cap.usage).toEqual(usage);
    expect(cap.gated_tool_calls).toBe(0);
    expect(cap.errored).toBe(false);
    expect(callModelFn).toHaveBeenCalledOnce();
    expect(callModelFn.mock.calls[0][0].provider).toBe("anthropic");
  });

  it("appends a JSON-schema instruction to the system prompt for a structured task", async () => {
    const callModelFn = vi.fn(
      async (_opts: CallModelOpts): Promise<CallModelResult> => ({
        text: "{}",
        usage: ZERO,
        provider: "anthropic",
      }),
    );
    await runTaskThroughEngine(task({ agent_slug: "pm" }), "anthropic", {
      callModelFn: callModelFn as unknown as typeof import("@/services/llm/call-model").callModel,
    });
    const sysArg = callModelFn.mock.calls[0][0].system as string;
    expect(sysArg).toContain("JSON Schema");
  });

  it("captures errored:true when callModel throws", async () => {
    const callModelFn = vi.fn(async (): Promise<CallModelResult> => {
      throw Object.assign(new Error("rate limited"), { name: "RateLimitError" });
    });
    const cap = await runTaskThroughEngine(task(), "anthropic", {
      callModelFn: callModelFn as unknown as typeof import("@/services/llm/call-model").callModel,
    });
    expect(cap.errored).toBe(true);
    expect(cap.error_detail).toBe("RateLimitError");
    expect(cap.output).toBe("");
  });
});

describe("makeLiveRunTask", () => {
  it("binds deps and routes by provider", async () => {
    const engine = scriptedEngine([
      { type: "text_delta", text: "oa" },
      { type: "terminal", resume: null, usage: ZERO },
    ]);
    const callModelFn = vi.fn(
      async (): Promise<CallModelResult> => ({ text: "an", usage: ZERO, provider: "anthropic" }),
    );
    const run = makeLiveRunTask({
      engineFactory: () => engine,
      callModelFn: callModelFn as unknown as typeof import("@/services/llm/call-model").callModel,
    });
    expect((await run(task(), "openai")).output).toBe("oa");
    expect((await run(task(), "anthropic")).output).toBe("an");
  });
});
