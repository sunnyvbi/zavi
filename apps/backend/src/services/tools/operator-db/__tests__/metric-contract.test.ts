import { describe, it, expect } from "vitest";
import { checkMetricContract, type MetricResult } from "../metric-contract";

function base(over: Partial<MetricResult> = {}): MetricResult {
  return {
    lever: "idle-supply", numerator: 30, denominator: 100,
    window_days: 30, numerator_window_days: 30, denominator_window_days: 30,
    query_id: "q", source: "s", ...over,
  };
}

describe("checkMetricContract", () => {
  it("passes a clean metric", () => {
    expect(checkMetricContract(base()).passed).toBe(true);
  });

  it("fails when numerator exceeds denominator (ratio > 1 impossible)", () => {
    const v = checkMetricContract(base({ numerator: 120, denominator: 100 }));
    expect(v.passed).toBe(false);
    expect(v.probes.find((p) => p.name === "denominator_ge_numerator")?.ok).toBe(false);
  });

  it("fails when numerator/denominator windows differ (tripStart-vs-createdAt class)", () => {
    const v = checkMetricContract(base({ numerator_window_days: 365 }));
    expect(v.passed).toBe(false);
    expect(v.probes.find((p) => p.name === "same_window")?.ok).toBe(false);
  });

  it("fails on low join-coverage (mismatched join key)", () => {
    const v = checkMetricContract(base({ join_attempted: 100, join_matched: 10 }));
    expect(v.passed).toBe(false);
    expect(v.probes.find((p) => p.name === "join_coverage")?.ok).toBe(false);
  });

  it("fails on dup-explosion (one-to-many fan-out)", () => {
    const v = checkMetricContract(base({ joined_rows: 500, distinct_join_keys: 100 }));
    expect(v.passed).toBe(false);
    expect(v.probes.find((p) => p.name === "dup_explosion")?.ok).toBe(false);
  });

  it("fails on high null-coverage (mostly-empty key field)", () => {
    const v = checkMetricContract(base({ null_count: 80, sampled_count: 100 }));
    expect(v.passed).toBe(false);
    expect(v.probes.find((p) => p.name === "null_coverage")?.ok).toBe(false);
  });

  it("fails when an independent count disagrees with the denominator", () => {
    const v = checkMetricContract(base({ independent_denominator: 200 }));
    expect(v.passed).toBe(false);
    expect(v.probes.find((p) => p.name === "row_count_cross_check")?.ok).toBe(false);
  });

  it("join_attempted === 0 is NOT a coverage failure (all listings idle, no bookings)", () => {
    const v = checkMetricContract(base({ numerator: 100, denominator: 100, join_attempted: 0, join_matched: 0 }));
    expect(v.passed).toBe(true);
    expect(v.probes.find((p) => p.name === "join_coverage")).toBeUndefined();
  });

  it("skips join/null/cross-check probes when their fields are absent", () => {
    const v = checkMetricContract(base());
    expect(v.probes.map((p) => p.name)).toEqual(["denominator_ge_numerator", "same_window"]);
  });
});
