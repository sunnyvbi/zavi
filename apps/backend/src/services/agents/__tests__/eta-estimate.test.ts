import { describe, it, expect } from "vitest";
import {
  percentile,
  computeEta,
  FLEET_DEFAULTS_MS,
  MIN_TENANT_SAMPLES,
} from "../eta-estimate";

describe("percentile", () => {
  it("returns 0 for an empty array", () => {
    expect(percentile([], 50)).toBe(0);
  });

  it("returns the single value for a 1-element array", () => {
    expect(percentile([42], 95)).toBe(42);
  });

  it("p50 of 1..10 is the linear-interpolated median (5.5)", () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(xs, 50)).toBeCloseTo(5.5, 6);
  });

  it("p95 interpolates between the top two of 1..10", () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(xs, 95)).toBeCloseTo(9.55, 6);
  });

  it("p0 and p100 return the min and max", () => {
    const xs = [10, 20, 30, 40];
    expect(percentile(xs, 0)).toBe(10);
    expect(percentile(xs, 100)).toBe(40);
  });
});

describe("computeEta", () => {
  it("uses the fleet default when there is no tenant history", () => {
    const eta = computeEta("operator", []);
    expect(eta.basis).toBe("fleet_default");
    expect(eta.n).toBe(0);
    expect(eta.p50_ms).toBe(FLEET_DEFAULTS_MS.operator.p50);
    expect(eta.p95_ms).toBe(FLEET_DEFAULTS_MS.operator.p95);
  });

  it("falls back to fleet default below the minimum sample threshold", () => {
    const tooFew = Array.from({ length: MIN_TENANT_SAMPLES - 1 }, () => 5000);
    const eta = computeEta("qa", tooFew);
    expect(eta.basis).toBe("fleet_default");
    expect(eta.p50_ms).toBe(FLEET_DEFAULTS_MS.qa.p50);
  });

  it("uses a per-tenant estimate once there are enough clean samples", () => {
    const durations = [
      1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000,
    ];
    const eta = computeEta("operator", durations);
    expect(eta.basis).toBe("tenant");
    expect(eta.n).toBe(10);
    expect(eta.p50_ms).toBe(5500);
    expect(eta.p95_ms).toBe(9550);
  });

  it("drops negative / non-finite durations before estimating", () => {
    const durations = [
      1000, -50, NaN, 2000, Infinity, 3000, 4000, 5000, 6000, 7000,
    ];
    const eta = computeEta("operator", durations);
    expect(eta.basis).toBe("tenant");
    expect(eta.n).toBe(7);
    expect(eta.p50_ms).toBe(4000);
  });

  it("uses the generic default for an unknown slug with no history", () => {
    const eta = computeEta("some-unknown-agent", []);
    expect(eta.basis).toBe("fleet_default");
    expect(eta.p50_ms).toBe(45000);
    expect(eta.p95_ms).toBe(180000);
  });
});
