import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const baselinePath = path.resolve(__dirname, "../../../../eval/agent-behavior/baseline.json");

describe("agent-behavior baseline", () => {
  const raw = JSON.parse(fs.readFileSync(baselinePath, "utf8")) as {
    total_runs: number;
    no_detector_fired: number;
    by_dimension: Record<string, { fired: number; rate_pct: number }>;
    by_rule: Record<string, { dimension: string; rule: string; fired: number; rate_pct: number; by_agent: Record<string, number>; examples: string[] }>;
  };

  it("has a non-trivial corpus and sane top-level counts", () => {
    expect(raw.total_runs).toBeGreaterThan(0);
    expect(raw.no_detector_fired).toBeGreaterThanOrEqual(0);
    expect(raw.no_detector_fired).toBeLessThanOrEqual(raw.total_runs);
  });

  it("covers all three dimensions with rates in [0,100]", () => {
    for (const dim of ["task-success", "connector-wall", "format"]) {
      const d = raw.by_dimension[dim];
      expect(d, `dimension ${dim}`).toBeDefined();
      expect(d.fired).toBeGreaterThanOrEqual(0);
      expect(d.rate_pct).toBeGreaterThanOrEqual(0);
      expect(d.rate_pct).toBeLessThanOrEqual(100);
    }
  });

  it("every rule row is internally consistent (by_agent sums to fired, rate in range)", () => {
    for (const [key, v] of Object.entries(raw.by_rule)) {
      const agentSum = Object.values(v.by_agent).reduce((a, n) => a + n, 0);
      expect(agentSum, `${key} by_agent sum`).toBe(v.fired);
      expect(v.rate_pct, `${key} rate`).toBeGreaterThanOrEqual(0);
      expect(v.rate_pct).toBeLessThanOrEqual(100);
      expect(Array.isArray(v.examples)).toBe(true);
      expect(v.examples.length).toBeLessThanOrEqual(5);
    }
  });
});
