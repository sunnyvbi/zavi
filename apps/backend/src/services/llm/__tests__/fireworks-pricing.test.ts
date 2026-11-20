
import { describe, it, expect } from "vitest";
import { FIREWORKS_PRICING, estimateFireworksCostUsd } from "@/services/openai";

const GLM52 = "accounts/fireworks/models/glm-5p2";

describe("Fireworks GLM-5.2 pricing", () => {
  it("matches the published serverless rate ($1.40 in / $4.40 out per MTok)", () => {
    expect(FIREWORKS_PRICING[GLM52]).toEqual({ input: 1.4, output: 4.4 });
  });

  it("costs 1M in + 1M out at $5.80", () => {
    const cost = estimateFireworksCostUsd(GLM52, {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    } as never);
    expect(cost).toBeCloseTo(5.8, 4);
  });

  it("is materially higher than the old under-reporting estimate", () => {
    const cost = estimateFireworksCostUsd(GLM52, {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    } as never);
    expect(cost).toBeGreaterThan(2.74);
  });

  it("falls back to the most EXPENSIVE known rate for an unknown model id", () => {
    const unknown = estimateFireworksCostUsd("accounts/fireworks/models/not-real", {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    } as never);
    const known = estimateFireworksCostUsd(GLM52, {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    } as never);
    expect(unknown).toBeGreaterThanOrEqual(known);
  });
});
