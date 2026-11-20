import { describe, it, expect, vi } from "vitest";
import type { Model } from "@openai/agents";

vi.mock("@/services/openai", () => ({ getOpenAi: () => null }));
vi.mock("@/services/memory/embed", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/memory/embed")>()),
  embedTexts: async () => {
    throw new Error("VOYAGE_API_KEY not set");
  },
}));

import { TurnHookModel } from "../turn-hook-model";
import { buildOpenAiAgent, _streamOpenAICompatRunForTests } from "../openai-engine";
import type { AgentEngineRunSpec, EngineEvent, EngineToolCall, EngineToolResult } from "../types";

function fakeModel(turns: Array<{ text: string; tool?: string }>): Model {
  let i = 0;
  return {
    async getResponse() {
      throw new Error("not used");
    },
    async *getStreamedResponse() {
      const t = turns[Math.min(i, turns.length - 1)] ?? { text: "done" };
      i += 1;
      yield { type: "output_text_delta", delta: t.text } as never;
      yield {
        type: "response_done",
        response: {
          id: `r${i}`,
          usage: { requests: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          output: [
            {
              type: "message",
              id: `m${i}`,
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: t.text }],
            },
            ...(t.tool
              ? [{ type: "function_call", id: `fc${i}`, callId: `c${i}`, name: t.tool, arguments: "{}", status: "completed" }]
              : []),
          ],
        },
      } as never;
    },
  } as Model;
}

describe("TurnHookModel", () => {
  it("awaits the hook with the turn's text BEFORE releasing response_done", async () => {
    const order: string[] = [];
    const m = new TurnHookModel(fakeModel([{ text: "<plan>x</plan>", tool: "github__search_code" }]), async (t) => {
      await new Promise((r) => setTimeout(r, 5));
      order.push(`hook:${t.turn}:${t.text}:${t.hasToolCalls}`);
    });
    for await (const ev of m.getStreamedResponse({} as never)) order.push(`ev:${(ev as { type: string }).type}`);
    expect(order).toEqual(["ev:output_text_delta", "hook:0:<plan>x</plan>:true", "ev:response_done"]);
  });

  it("a throwing hook does not break the stream", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const m = new TurnHookModel(fakeModel([{ text: "a" }]), () => {
      throw new Error("boom");
    });
    const seen: string[] = [];
    for await (const ev of m.getStreamedResponse({} as never)) seen.push((ev as { type: string }).type);
    expect(seen).toEqual(["output_text_delta", "response_done"]);
    warn.mockRestore();
  });

  it("counts turns across calls", async () => {
    const turns: number[] = [];
    const m = new TurnHookModel(fakeModel([{ text: "a" }, { text: "b" }]), (t) => {
      turns.push(t.turn);
    });
    for await (const _ of m.getStreamedResponse({} as never)) void _;
    for await (const _ of m.getStreamedResponse({} as never)) void _;
    expect(turns).toEqual([0, 1]);
  });

  it("passes getRetryAdvice through only when the inner model has it", () => {
    const bare = new TurnHookModel(fakeModel([{ text: "a" }]), () => {});
    expect(bare.getRetryAdvice).toBeUndefined();
    const inner = { ...fakeModel([{ text: "a" }]), getRetryAdvice: () => ({ suggested: false }) } as unknown as Model;
    const wrapped = new TurnHookModel(inner, () => {});
    expect(wrapped.getRetryAdvice?.({} as never)).toEqual({ suggested: false });
  });
});

describe("TurnHookModel through the real Runner (engine order)", () => {
  it("hook for turn 0 runs BEFORE turn 0's tool dispatch", async () => {
    const order: string[] = [];
    const events: EngineEvent[] = [];
    const dispatchTool = vi.fn(async (call: EngineToolCall): Promise<EngineToolResult> => {
      order.push(`tool:${call.tool_name}`);
      return { is_error: false, content: "ok", ms: 1, denied: false };
    });
    const spec: AgentEngineRunSpec = {
      systemPrompt: "SYSTEM",
      userPrompt: "go",
      model: "qwen/qwen3.8-27b",
      maxTurns: 4,
      tools: [{ name: "github__search_code", description: "search code", jsonSchema: { type: "object", properties: {} } }],
      resume: null,
      abort: new AbortController(),
      dispatchTool: dispatchTool as unknown as AgentEngineRunSpec["dispatchTool"],
      onEvent: (e) => events.push(e),
    };
    const hooked = new TurnHookModel(
      fakeModel([{ text: "<plan>t</plan>", tool: "github__search_code" }, { text: "final" }]),
      async (t) => {
        await new Promise((r) => setTimeout(r, 20));
        order.push(`hook:${t.turn}`);
      },
    );
    const agent = buildOpenAiAgent(spec, hooked);
    for await (const _ of _streamOpenAICompatRunForTests(spec, agent, "stateless")) void _;
    expect(order).toEqual(["hook:0", "tool:github__search_code", "hook:1"]);
    expect(events.some((e) => e.type === "terminal")).toBe(true);
  });
});
