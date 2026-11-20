import { describe, it, expect, vi } from "vitest";
import {
  applyOpenRouterPin,
  extractOpenRouterMeta,
  isServedByPin,
  makeOpenRouterFetch,
  OpenRouterRunRecorder,
} from "../openrouter";
import { assertModelMatchesProvider } from "../models";

const PIN = { upstream: "Fireworks" };

describe("openrouter provider pin (test 9)", () => {
  it("request body carries provider.order + allow_fallbacks:false + require_parameters:true", () => {
    const out = applyOpenRouterPin({ model: "qwen/qwen3", messages: [] }, PIN);
    expect(out.provider).toEqual({
      order: ["Fireworks"],
      allow_fallbacks: false,
      require_parameters: true,
    });
    expect(out.usage).toEqual({ include: true });
    expect(out.model).toBe("qwen/qwen3");
  });

  it("a caller cannot re-enable fallbacks by passing its own provider block", () => {
    const out = applyOpenRouterPin(
      { model: "x/y", provider: { order: ["Other"], allow_fallbacks: true } },
      PIN,
    );
    expect(out.provider).toEqual({
      order: ["Fireworks"],
      allow_fallbacks: false,
      require_parameters: true,
    });
  });

  it("the fetch wrapper rewrites every outgoing body and records the served provider + billed cost", async () => {
    const sent: Record<string, unknown>[] = [];
    const base = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({ provider: "Fireworks", model: "qwen/qwen3", usage: { cost: 0.0123 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const rec = new OpenRouterRunRecorder(PIN);
    const f = makeOpenRouterFetch(PIN, rec, base);
    await f("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "qwen/qwen3", messages: [] }),
    });
    await rec.settle();
    expect((sent[0].provider as { allow_fallbacks: boolean }).allow_fallbacks).toBe(false);
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].served_provider).toBe("Fireworks");
    expect(rec.totalCostUsd()).toBeCloseTo(0.0123);
    expect(rec.unpinnedCalls()).toHaveLength(0);
  });

  it("a response served by an unpinned route is flagged so the row is discarded", async () => {
    const base = vi.fn(async () =>
      new Response(JSON.stringify({ provider: "Together", usage: { cost: 0.01 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;
    const rec = new OpenRouterRunRecorder(PIN);
    await makeOpenRouterFetch(PIN, rec, base)("u", { method: "POST", body: "{}" });
    await rec.settle();
    expect(rec.unpinnedCalls()).toHaveLength(1);
    expect(rec.verdict()).toBe("unpinned_route");
  });

  it("a response with no usage cost marks the model unpriceable", async () => {
    const base = vi.fn(async () =>
      new Response(JSON.stringify({ provider: "Fireworks" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;
    const rec = new OpenRouterRunRecorder(PIN);
    await makeOpenRouterFetch(PIN, rec, base)("u", { method: "POST", body: "{}" });
    await rec.settle();
    expect(rec.verdict()).toBe("no_usage_cost");
  });

  it("reads provider + cost out of an SSE stream (the final chunk carries usage)", () => {
    const sse =
      'data: {"provider":"Fireworks","choices":[{"delta":{"content":"hi"}}]}\n\n' +
      'data: {"provider":"Fireworks","choices":[],"usage":{"cost":0.5}}\n\n' +
      "data: [DONE]\n\n";
    const m = extractOpenRouterMeta(sse);
    expect(m.served_provider).toBe("Fireworks");
    expect(m.cost_usd).toBe(0.5);
  });

  it("served-provider comparison is case/punctuation-insensitive but exact", () => {
    expect(isServedByPin("fireworks", PIN)).toBe(true);
    expect(isServedByPin("Fireworks AI", { upstream: "fireworks-ai" })).toBe(true);
    expect(isServedByPin("Together", PIN)).toBe(false);
    expect(isServedByPin(null, PIN)).toBe(false);
  });

  it("openrouter model ids must be <vendor>/<model>", () => {
    expect(() => assertModelMatchesProvider("openrouter", "qwen/qwen3-coder")).not.toThrow();
    expect(() => assertModelMatchesProvider("openrouter", "anthropic/claude-opus-4.7")).not.toThrow();
    expect(() => assertModelMatchesProvider("openrouter", "gpt-5.5")).toThrow(/vendor/);
  });
});
