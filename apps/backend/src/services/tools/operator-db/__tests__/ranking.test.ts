import { describe, it, expect } from "vitest";
import { rankLevers, isRankable, type LeverCandidate } from "../ranking";

function cand(over: Partial<LeverCandidate> = {}): LeverCandidate {
  return {
    constraint: "idle-supply", numerator: 30, denominator: 100,
    source_quality: "confirmed_live_mongo",
    confirmed_map: true, metric_probe_passed: true, k_anon_passed: true, live_validated: true,
    ...over,
  };
}

describe("ranking — rankable is a HARD GATE", () => {
  it("only ranks levers that clear all four gates + a rankable source", () => {
    expect(isRankable(cand())).toBe(true);
    expect(isRankable(cand({ metric_probe_passed: false }))).toBe(false);
    expect(isRankable(cand({ k_anon_passed: false }))).toBe(false);
    expect(isRankable(cand({ live_validated: false }))).toBe(false);
    expect(isRankable(cand({ confirmed_map: false }))).toBe(false);
  });

  it("synthetic_only (unvalidated SQL) is surfaced but NEVER ranked", () => {
    const { ranked, abstained } = rankLevers([
      cand({ source_quality: "synthetic_only", live_validated: false }),
    ]);
    expect(ranked).toHaveLength(0);
    expect(abstained[0].reason).toBe("requires_sql_validation");
  });

  it("weak_inferred is surfaced but never ranked", () => {
    const { ranked, abstained } = rankLevers([cand({ source_quality: "weak_inferred" })]);
    expect(ranked).toHaveLength(0);
    expect(abstained[0].reason).toMatch(/not_rankable_source_weak_inferred/);
  });

  it("ranks by measured signal (volume × rate), top-5, rest abstained as outside_top_5", () => {
    const levers = [
      cand({ constraint: "a", numerator: 90, denominator: 100 }),
      cand({ constraint: "b", numerator: 10, denominator: 100 }),
      cand({ constraint: "c", numerator: 50, denominator: 1000 }),
    ];
    const { ranked } = rankLevers(levers);
    expect(ranked.map((r) => r.constraint)).toEqual(["a", "c", "b"]);
    expect(ranked[0].rank).toBe(1);
  });

  it("abstains a lever carrying an explicit abstain_reason (no_data / no mapping)", () => {
    const { ranked, abstained } = rankLevers([cand({ abstain_reason: "no_cancellation_mapping" })]);
    expect(ranked).toHaveLength(0);
    expect(abstained[0].reason).toBe("no_cancellation_mapping");
  });

  it("elasticity/build-cost are NOT score inputs (two identical-measure levers tie on measure)", () => {
    const a = cand({ constraint: "a", elasticity_hint: "huge", build_cost_hint: "trivial" });
    const b = cand({ constraint: "b", elasticity_hint: "tiny", build_cost_hint: "huge" });
    const { ranked } = rankLevers([a, b]);
    expect(ranked[0].score).toBe(ranked[1].score);
  });
});
