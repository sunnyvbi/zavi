import { describe, it, expect } from "vitest";
import { scoreAgentBehaviorGoldens } from "../agent-behavior-detector-stability";
import { findEval } from "../registry";

describe("agent-behavior-detector-stability gate", () => {
  it("all committed behavior goldens pass shape + detector-determinism", async () => {
    const report = await scoreAgentBehaviorGoldens();
    expect(report.failures.map((f) => `${f.case_id}: ${f.reason}`)).toEqual([]);
    expect(report.accuracy).toBe(1);
    expect(report.failed).toBe(0);
  });

  it("checks a non-trivial corpus (guards against an empty/missing golden dir)", async () => {
    const report = await scoreAgentBehaviorGoldens();
    expect(report.total).toBeGreaterThan(100);
  });

  it("is registered as a blocking gate", () => {
    const entry = findEval("agent-behavior-detector-stability");
    expect(entry).toBeDefined();
    expect(entry?.blocking_gate).toBe(true);
    expect(entry?.cost).toBe("deterministic");
  });
});
