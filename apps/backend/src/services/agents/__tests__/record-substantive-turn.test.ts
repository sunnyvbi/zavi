import { describe, it, expect } from "vitest";
import { recordSubstantiveTurn } from "../generic-dispatcher";

describe("recordSubstantiveTurn", () => {
  it("captures successive turns in order", () => {
    const turns: string[] = [];
    recordSubstantiveTurn(turns, "the full breakdown");
    recordSubstantiveTurn(turns, "saved to memory, reply above");
    expect(turns).toEqual(["the full breakdown", "saved to memory, reply above"]);
  });

  it("skips empty / whitespace-only turns (plan-only first turn → residual empty)", () => {
    const turns: string[] = [];
    recordSubstantiveTurn(turns, "");
    recordSubstantiveTurn(turns, "   \n  ");
    recordSubstantiveTurn(turns, "real turn");
    expect(turns).toEqual(["real turn"]);
  });

  it("dedups an exact repeat of the last turn (SDK result-fallback re-push)", () => {
    const turns: string[] = [];
    recordSubstantiveTurn(turns, "final answer");
    recordSubstantiveTurn(turns, "final answer");
    expect(turns).toEqual(["final answer"]);
  });

  it("trims stored text but still distinguishes genuinely different turns", () => {
    const turns: string[] = [];
    recordSubstantiveTurn(turns, "  turn one  ");
    recordSubstantiveTurn(turns, "turn two");
    expect(turns).toEqual(["turn one", "turn two"]);
  });

  it("a single substantive turn yields one entry (no multi-turn delivery downstream)", () => {
    const turns: string[] = [];
    recordSubstantiveTurn(turns, "only turn");
    expect(turns).toHaveLength(1);
  });
});
