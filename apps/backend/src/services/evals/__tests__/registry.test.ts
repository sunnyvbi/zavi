
import { describe, it, expect } from "vitest";
import { EVAL_REGISTRY, findEval, listEvals } from "../registry";

describe("eval registry", () => {
  it("listEvals returns the canonical registry", () => {
    expect(listEvals()).toBe(EVAL_REGISTRY);
    expect(EVAL_REGISTRY.length).toBeGreaterThan(0);
  });

  it("every entry has a non-empty slug, description, cost, and runner", () => {
    for (const e of EVAL_REGISTRY) {
      expect(e.slug).toMatch(/^[a-z][a-z0-9-]+$/);
      expect(e.description.length).toBeGreaterThan(10);
      expect(["deterministic", "live_anthropic", "live_other"]).toContain(e.cost);
      expect(typeof e.blocking_gate).toBe("boolean");
      expect(typeof e.runner).toBe("function");
    }
  });

  it("slugs are unique", () => {
    const slugs = EVAL_REGISTRY.map((e) => e.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("findEval returns the right entry by slug", () => {
    const first = EVAL_REGISTRY[0];
    expect(findEval(first.slug)).toBe(first);
    expect(findEval("definitely-not-a-real-eval")).toBeUndefined();
  });

  it("slack-routing-deterministic runner returns a well-formed EvalReport", async () => {
    const entry = findEval("slack-routing-deterministic");
    expect(entry).toBeDefined();
    const report = await entry!.runner();
    expect(report.slug).toBe("slack-routing-deterministic");
    expect(typeof report.ts).toBe("string");
    expect(report.total).toBeGreaterThan(0);
    expect(report.passed + report.failed).toBe(report.total);
    expect(report.accuracy).toBeGreaterThanOrEqual(0);
    expect(report.accuracy).toBeLessThanOrEqual(1);
    expect(report.blocking_gate).toBe(true);
    expect(Array.isArray(report.failures)).toBe(true);
    for (const f of report.failures) {
      expect(f.pass).toBe(false);
      expect(typeof f.case_id).toBe("string");
    }
  });
});
