import { describe, it, expect } from "vitest";

type ResultLike = {
  raw_response_text: string;
  prompt_snapshot: string;
  usage: { input_tokens: number; output_tokens: number };
  routing?: { model: string };
};

function applyErrorInstrument(args: {
  result: ResultLike | null;
  model: string;
  storeRaw: boolean;
}): Record<string, unknown> {
  const { result, model, storeRaw } = args;
  const update: Record<string, unknown> = {
    status: "dispatch_error",
    parse_ok: false,
    cost_tokens: 0,
    cost_usd: 0,
  };
  if (result) {
    update.raw_response_text = storeRaw ? result.raw_response_text : null;
    update.prompt_snapshot = storeRaw ? result.prompt_snapshot : null;
    update.input_tokens = result.usage.input_tokens;
    update.output_tokens = result.usage.output_tokens;
    update.model_used = result.routing?.model ?? model;
  }
  return update;
}

const RESULT: ResultLike = {
  raw_response_text: "the model actually emitted this",
  prompt_snapshot: "SYSTEM PROMPT ...",
  usage: { input_tokens: 1234, output_tokens: 56 },
};

describe("persistTerminal dispatch_error instrument", () => {
  it("(c) captures raw/prompt/tokens/model when a result is threaded + store_raw=true", () => {
    const u = applyErrorInstrument({ result: RESULT, model: "claude-opus-4-6", storeRaw: true });
    expect(u.status).toBe("dispatch_error");
    expect(u.raw_response_text).toBe("the model actually emitted this");
    expect(u.prompt_snapshot).toBe("SYSTEM PROMPT ...");
    expect(u.input_tokens).toBe(1234);
    expect(u.output_tokens).toBe(56);
    expect(u.model_used).toBe("claude-opus-4-6");
    expect(u.cost_tokens).toBe(0);
    expect(u.cost_usd).toBe(0);
  });

  it("(c) store_raw=false blanks raw + prompt but still records tokens + model", () => {
    const u = applyErrorInstrument({ result: RESULT, model: "claude-opus-4-6", storeRaw: false });
    expect(u.raw_response_text).toBeNull();
    expect(u.prompt_snapshot).toBeNull();
    expect(u.input_tokens).toBe(1234);
    expect(u.output_tokens).toBe(56);
    expect(u.model_used).toBe("claude-opus-4-6");
  });

  it("(c) prefers the routed model over the declared model param", () => {
    const u = applyErrorInstrument({
      result: { ...RESULT, routing: { model: "claude-sonnet-4-6" } },
      model: "claude-opus-4-6",
      storeRaw: true,
    });
    expect(u.model_used).toBe("claude-sonnet-4-6");
  });

  it("(c) does NOT crash + records no model evidence when nothing is available (threw before the model)", () => {
    const u = applyErrorInstrument({ result: null, model: "claude-sonnet-4-6", storeRaw: true });
    expect(u.status).toBe("dispatch_error");
    expect("raw_response_text" in u).toBe(false);
    expect("input_tokens" in u).toBe(false);
    expect("model_used" in u).toBe(false);
  });
});
