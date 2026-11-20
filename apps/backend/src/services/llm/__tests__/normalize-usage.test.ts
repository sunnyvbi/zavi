import { describe, it, expect } from "vitest";
import { normalizeUsage } from "@/services/llm/normalize-usage";

describe("normalizeUsage — anthropic", () => {
  it("maps all four anthropic fields incl. cache fields", () => {
    const raw = {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 10,
    };
    expect(normalizeUsage(raw, "anthropic")).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 10,
    });
  });

  it("defaults missing anthropic cache fields to 0", () => {
    const raw = { input_tokens: 7, output_tokens: 3 };
    expect(normalizeUsage(raw, "anthropic")).toEqual({
      input_tokens: 7,
      output_tokens: 3,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
  });
});

describe("normalizeUsage — openai", () => {
  it("maps prompt_tokens→input, completion_tokens→output, cache→0", () => {
    const raw = { prompt_tokens: 200, completion_tokens: 80 };
    expect(normalizeUsage(raw, "openai")).toEqual({
      input_tokens: 200,
      output_tokens: 80,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
  });

  it("maps cached_tokens → cache_read + SUBTRACTS it from input (disjoint, cost-correct)", () => {
    const raw = {
      prompt_tokens: 200,
      completion_tokens: 80,
      prompt_tokens_details: { cached_tokens: 64 },
    };
    expect(normalizeUsage(raw, "openai")).toEqual({
      input_tokens: 136,
      output_tokens: 80,
      cache_read_input_tokens: 64,
      cache_creation_input_tokens: 0,
    });
  });

  it("cached_tokens > prompt_tokens (garbage) → input floored at 0", () => {
    const raw = {
      prompt_tokens: 50,
      completion_tokens: 10,
      prompt_tokens_details: { cached_tokens: 999 },
    };
    expect(normalizeUsage(raw, "openai").input_tokens).toBe(0);
  });

  it("does NOT read anthropic field names on the openai branch", () => {
    const raw = { input_tokens: 999, output_tokens: 999 };
    expect(normalizeUsage(raw, "openai")).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
  });

  it("codex normalizes identically to openai (subscription endpoint serves OpenAI-shaped usage)", () => {
    const raw = {
      prompt_tokens: 200,
      completion_tokens: 80,
      prompt_tokens_details: { cached_tokens: 64 },
    };
    expect(normalizeUsage(raw, "codex")).toEqual(normalizeUsage(raw, "openai"));
    expect(normalizeUsage(raw, "codex")).toEqual({
      input_tokens: 136,
      output_tokens: 80,
      cache_read_input_tokens: 64,
      cache_creation_input_tokens: 0,
    });
  });
});

describe("normalizeUsage — defensive (never throws, garbage → zeros)", () => {
  const zeros = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };

  it("null → all zeros", () => {
    expect(normalizeUsage(null, "anthropic")).toEqual(zeros);
  });

  it("undefined → all zeros", () => {
    expect(normalizeUsage(undefined, "openai")).toEqual(zeros);
  });

  it("non-object (string) → all zeros", () => {
    expect(normalizeUsage("not-an-object", "anthropic")).toEqual(zeros);
  });

  it("NaN / negative / wrong-typed fields → 0 each", () => {
    const raw = {
      input_tokens: NaN,
      output_tokens: -5,
      cache_read_input_tokens: "30",
      cache_creation_input_tokens: Infinity,
    };
    expect(normalizeUsage(raw, "anthropic")).toEqual(zeros);
  });

  it("openai with non-object prompt_tokens_details → cache 0, no throw", () => {
    const raw = { prompt_tokens: 5, completion_tokens: 2, prompt_tokens_details: "nope" };
    expect(normalizeUsage(raw, "openai")).toEqual({
      input_tokens: 5,
      output_tokens: 2,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
  });
});
