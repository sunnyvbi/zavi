import { describe, it, expect } from "vitest";
import {
  roundWeight,
  brierScore,
  directionalAccuracy,
  actualRate,
  calibrationCurve,
  computeScorecardMetrics,
  type Resolution,
} from "../takes";

describe("roundWeight", () => {
  it("snaps to 0.05 grid", () => {
    expect(roundWeight(0.74)).toBe(0.75);
    expect(roundWeight(0.72)).toBe(0.7);
    expect(roundWeight(0.5)).toBe(0.5);
    expect(roundWeight(0)).toBe(0);
    expect(roundWeight(1)).toBe(1);
  });
  it("clamps to [0, 1]", () => {
    expect(roundWeight(-0.5)).toBe(0);
    expect(roundWeight(1.5)).toBe(1);
  });
  it("throws on non-finite", () => {
    expect(() => roundWeight(NaN)).toThrow(/non-finite/);
    expect(() => roundWeight(Infinity)).toThrow(/non-finite/);
    expect(() => roundWeight(-Infinity)).toThrow(/non-finite/);
  });
});

describe("brierScore", () => {
  it("empty → null", () => {
    expect(brierScore([])).toEqual({ brier: null, n: 0 });
  });
  it("only-unresolved → null", () => {
    expect(brierScore([{ weight: 0.7, resolved_to: null }])).toEqual({ brier: null, n: 0 });
  });
  it("only-partial → null (Brier strict-binary, partial excluded)", () => {
    expect(brierScore([{ weight: 0.7, resolved_to: "partial" }])).toEqual({ brier: null, n: 0 });
  });
  it("perfect predictions → brier=0", () => {
    const rs: Resolution[] = [
      { weight: 1.0, resolved_to: "correct" },
      { weight: 0.0, resolved_to: "incorrect" },
    ];
    expect(brierScore(rs)).toEqual({ brier: 0, n: 2 });
  });
  it("worst predictions → brier=1", () => {
    const rs: Resolution[] = [
      { weight: 1.0, resolved_to: "incorrect" },
      { weight: 0.0, resolved_to: "correct" },
    ];
    expect(brierScore(rs)).toEqual({ brier: 1, n: 2 });
  });
  it("uncalibrated 0.5 predictions → brier=0.25", () => {
    const rs: Resolution[] = [
      { weight: 0.5, resolved_to: "correct" },
      { weight: 0.5, resolved_to: "incorrect" },
    ];
    const r = brierScore(rs);
    expect(r.brier).toBeCloseTo(0.25, 6);
    expect(r.n).toBe(2);
  });
  it("mixes correctly (partial excluded)", () => {
    const rs: Resolution[] = [
      { weight: 0.8, resolved_to: "correct" },
      { weight: 0.2, resolved_to: "incorrect" },
      { weight: 0.5, resolved_to: "partial" },
      { weight: 0.5, resolved_to: null },
    ];
    const r = brierScore(rs);
    expect(r.n).toBe(2);
    expect(r.brier).toBeCloseTo(0.04, 6);
  });
});

describe("directionalAccuracy", () => {
  it("empty → null", () => {
    expect(directionalAccuracy([])).toEqual({ value: null, n: 0 });
  });
  it("high-weight correct + low-weight incorrect = directionally right", () => {
    const rs: Resolution[] = [
      { weight: 0.9, resolved_to: "correct" },
      { weight: 0.1, resolved_to: "incorrect" },
    ];
    expect(directionalAccuracy(rs)).toEqual({ value: 1, n: 2 });
  });
  it("high-weight incorrect = directionally wrong", () => {
    const rs: Resolution[] = [{ weight: 0.9, resolved_to: "incorrect" }];
    expect(directionalAccuracy(rs)).toEqual({ value: 0, n: 1 });
  });
  it("weight=0.5 borderline + correct counts as directionally right (>=0.5)", () => {
    const rs: Resolution[] = [{ weight: 0.5, resolved_to: "correct" }];
    expect(directionalAccuracy(rs)).toEqual({ value: 1, n: 1 });
  });
  it("partial counts as 0.5", () => {
    const rs: Resolution[] = [
      { weight: 0.9, resolved_to: "partial" },
    ];
    expect(directionalAccuracy(rs)).toEqual({ value: 0.5, n: 1 });
  });
  it("null excluded", () => {
    const rs: Resolution[] = [
      { weight: 0.9, resolved_to: null },
      { weight: 0.9, resolved_to: "correct" },
    ];
    expect(directionalAccuracy(rs)).toEqual({ value: 1, n: 1 });
  });
});

describe("actualRate", () => {
  it("empty → null", () => {
    expect(actualRate([])).toEqual({ value: null, n: 0 });
  });
  it("all correct → 1.0", () => {
    expect(
      actualRate([
        { weight: 0.1, resolved_to: "correct" },
        { weight: 0.9, resolved_to: "correct" },
      ]),
    ).toEqual({ value: 1, n: 2 });
  });
  it("partial = 0.5 contribution", () => {
    expect(actualRate([{ weight: 0.5, resolved_to: "partial" }])).toEqual({ value: 0.5, n: 1 });
  });
  it("mixed", () => {
    const rs: Resolution[] = [
      { weight: 0.5, resolved_to: "correct" },
      { weight: 0.5, resolved_to: "incorrect" },
      { weight: 0.5, resolved_to: "partial" },
      { weight: 0.5, resolved_to: null },
    ];
    const r = actualRate(rs);
    expect(r.n).toBe(3);
    expect(r.value).toBeCloseTo((1 + 0 + 0.5) / 3, 6);
  });
});

describe("calibrationCurve", () => {
  it("empty → []", () => {
    expect(calibrationCurve([])).toEqual([]);
  });
  it("partial + null excluded", () => {
    const rs: Resolution[] = [
      { weight: 0.7, resolved_to: "partial" },
      { weight: 0.7, resolved_to: null },
    ];
    expect(calibrationCurve(rs)).toEqual([]);
  });
  it("weight=1.0 lands in 0.9-1.0 bucket (last is closed)", () => {
    const rs: Resolution[] = [{ weight: 1.0, resolved_to: "correct" }];
    const c = calibrationCurve(rs);
    expect(c).toEqual([{ bucket: "0.9-1.0", n: 1, actual_rate: 1.0 }]);
  });
  it("weight=0 lands in 0.0-0.1 bucket", () => {
    const rs: Resolution[] = [{ weight: 0, resolved_to: "incorrect" }];
    expect(calibrationCurve(rs)).toEqual([{ bucket: "0.0-0.1", n: 1, actual_rate: 0 }]);
  });
  it("weight=0.95 lands in 0.9-1.0", () => {
    const rs: Resolution[] = [{ weight: 0.95, resolved_to: "correct" }];
    expect(calibrationCurve(rs)[0].bucket).toBe("0.9-1.0");
  });
  it("buckets aggregate correctly", () => {
    const rs: Resolution[] = [
      { weight: 0.9, resolved_to: "correct" },
      { weight: 0.92, resolved_to: "correct" },
      { weight: 0.95, resolved_to: "incorrect" },
    ];
    const c = calibrationCurve(rs);
    expect(c.length).toBe(1);
    expect(c[0]).toEqual({ bucket: "0.9-1.0", n: 3, actual_rate: 2 / 3 });
  });
});

describe("computeScorecardMetrics", () => {
  it("empty → all-null envelope", () => {
    const m = computeScorecardMetrics([]);
    expect(m).toEqual({
      brier: null,
      brier_n: 0,
      directional_accuracy: null,
      directional_accuracy_n: 0,
      actual_rate: null,
      actual_rate_n: 0,
      calibration_curve: [],
    });
  });
  it("mixed envelope shape", () => {
    const rs: Resolution[] = [
      { weight: 0.8, resolved_to: "correct" },
      { weight: 0.2, resolved_to: "incorrect" },
      { weight: 0.5, resolved_to: "partial" },
    ];
    const m = computeScorecardMetrics(rs);
    expect(m.brier_n).toBe(2);
    expect(m.directional_accuracy_n).toBe(3);
    expect(m.actual_rate_n).toBe(3);
    expect(m.calibration_curve.length).toBe(2);
  });
});
