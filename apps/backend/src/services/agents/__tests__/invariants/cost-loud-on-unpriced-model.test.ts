
import { describe, it, expect, vi } from "vitest";

const { alertSpy } = vi.hoisted(() => ({ alertSpy: vi.fn(async () => {}) }));
vi.mock("@/services/logging/alert", () => ({ alert: alertSpy }));

import { estimateCostUsd, PRICING, DEFAULT_MODEL } from "../../../anthropic";

const M = 1_000_000;
const usage = { input_tokens: M, output_tokens: M };

describe("invariant: cost estimation is loud/max on an unpriced model", () => {
  it("charges an UNKNOWN model at the MAX known rate, not the cheap DEFAULT_MODEL", () => {
    const cheap = PRICING[DEFAULT_MODEL];
    const maxInput = Math.max(...Object.values(PRICING).map((p) => p.input));
    const maxOutput = Math.max(...Object.values(PRICING).map((p) => p.output));

    const unknownCost = estimateCostUsd("claude-imaginary-9000", usage);
    const expectedMax = (M / M) * maxInput + (M / M) * maxOutput;
    const cheapWould = (M / M) * cheap.input + (M / M) * cheap.output;

    expect(unknownCost).toBeCloseTo(expectedMax, 2);
    expect(unknownCost).toBeGreaterThan(cheapWould);
    expect(alertSpy).toHaveBeenCalledOnce();
  });

  it("throws on an unknown model when onUnpriced:'throw' (offline/validation callers stay loud)", () => {
    expect(() => estimateCostUsd("nope-9000", usage, { onUnpriced: "throw" })).toThrow(
      /unpriced model/i,
    );
  });

  it("prices a KNOWN model unchanged (regression guard)", () => {
    const opus = estimateCostUsd("claude-opus-4-7", usage);
    expect(opus).toBeCloseTo(5 + 25, 2);
  });
});
