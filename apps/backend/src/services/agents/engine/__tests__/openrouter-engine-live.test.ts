import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@/services/openai", () => ({ getOpenAi: () => null }));

import { withOpenRouterCost, OpenRouterUnpinnedError, OpenRouterOpenAICompatAgentEngine } from "../openai-engine";
import { takeOpenRouterRecorder } from "@/services/llm/openrouter";
import type { AgentEngineRunSpec, EngineEvent } from "../types";

async function* src(): AsyncIterable<EngineEvent> {
  yield { type: "text_delta", text: "hi" } as EngineEvent;
  yield { type: "terminal", resume: null, usage: {} } as unknown as EngineEvent;
}

describe("withOpenRouterCost", () => {
  it("adds the recorder's billed cost to the terminal when verdict ok", async () => {
    const rec = { settle: async () => {}, verdict: () => "ok" as const, totalCostUsd: () => 0.0123 };
    const out: EngineEvent[] = [];
    for await (const e of withOpenRouterCost(src(), rec)) out.push(e);
    expect(out[1]).toMatchObject({ type: "terminal", costUsd: 0.0123 });
  });

  it("unpinned route: yields the terminal with what was billed, THEN throws OpenRouterUnpinnedError", async () => {
    const rec = { settle: async () => {}, verdict: () => "unpinned_route" as const, totalCostUsd: () => 0.5 };
    const it = withOpenRouterCost(src(), rec)[Symbol.asyncIterator]();
    await it.next();
    const term = await it.next();
    expect(term.value).toMatchObject({ type: "terminal", costUsd: 0.5 });
    const err = await it.next().catch((e) => e);
    expect(err).toBeInstanceOf(OpenRouterUnpinnedError);
    expect((err as Error).message).toBe("openrouter_unpinned_route");
    expect((err as OpenRouterUnpinnedError).costUsd).toBe(0.5);
  });

  it("leaves costUsd undefined when a call had no usage cost", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rec = { settle: async () => {}, verdict: () => "no_usage_cost" as const, totalCostUsd: () => 0 };
    const out: EngineEvent[] = [];
    for await (const e of withOpenRouterCost(src(), rec)) out.push(e);
    expect((out[1] as { costUsd?: number }).costUsd).toBeUndefined();
    warn.mockRestore();
  });

  it("settles the recorder before reading the verdict", async () => {
    const calls: string[] = [];
    const rec = {
      settle: async () => {
        calls.push("settle");
      },
      verdict: () => {
        calls.push("verdict");
        return "ok" as const;
      },
      totalCostUsd: () => 1,
    };
    for await (const _ of withOpenRouterCost(src(), rec)) void _;
    expect(calls.slice(0, 2)).toEqual(["settle", "verdict"]);
  });
});

describe("OpenRouter engine: per-run upstream pin + no recorder leak", () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  function spec(over: Partial<AgentEngineRunSpec> = {}): AgentEngineRunSpec {
    return {
      systemPrompt: "S",
      userPrompt: "u",
      model: "qwen/qwen3.8-27b",
      maxTurns: 1,
      tools: [],
      resume: null,
      abort: new AbortController(),
      dispatchTool: (async () => ({ is_error: false, content: "", ms: 0, denied: false })) as never,
      onEvent: () => {},
      ...over,
    };
  }

  it("refuses with no per-run upstream and no env pin (fail closed)", async () => {
    process.env.OPENROUTER_API_KEY = "k";
    delete process.env.PRAXIS_SHADOW_OPENROUTER_UPSTREAM;
    const it = new OpenRouterOpenAICompatAgentEngine().run(spec())[Symbol.asyncIterator]();
    await expect(it.next()).rejects.toThrow(/PRAXIS_SHADOW_OPENROUTER_UPSTREAM/);
  });

  it("a live (per-run upstream) run never registers a bench recorder; the bench path still does", async () => {
    process.env.OPENROUTER_API_KEY = "k";
    process.env.OPENROUTER_BASE_URL = "http://127.0.0.1:9/api/v1";
    delete process.env.PRAXIS_SHADOW_OPENROUTER_UPSTREAM;
    const drain = async (s: AgentEngineRunSpec) => {
      try {
        for await (const _ of new OpenRouterOpenAICompatAgentEngine().run(s)) void _;
      } catch {
      }
    };
    await drain(spec({ runId: "live-run", openRouterUpstream: "Darkbloom" }));
    expect(takeOpenRouterRecorder("live-run")).toBeFalsy();

    process.env.PRAXIS_SHADOW_OPENROUTER_UPSTREAM = "Darkbloom";
    await drain(spec({ runId: "bench-run" }));
    expect(takeOpenRouterRecorder("bench-run")).toBeTruthy();
  }, 30_000);
});
