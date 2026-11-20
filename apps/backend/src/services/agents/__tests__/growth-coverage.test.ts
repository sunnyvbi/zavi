import { describe, it, expect } from "vitest";
import { buildCoverageMap, FUNCTION_AGENTS, GROWTH_FUNCTIONS } from "../growth-coverage";

function h(present: boolean, hidden: boolean, handling: boolean) {
  return { present, hidden, handling };
}

describe("buildCoverageMap", () => {
  it("emits one row per growth function", () => {
    const map = buildCoverageMap(new Map());
    expect(map.map((f) => f.fn)).toEqual([...GROWTH_FUNCTIONS]);
  });

  it("a function with no present agents is not_applicable (not red/uncovered)", () => {
    const map = buildCoverageMap(new Map());
    for (const f of map) {
      expect(f.notApplicable).toBe(true);
      expect(f.uncovered).toBe(false);
      expect(f.autonomyPct).toBeNull();
      expect(f.applicableAgents).toBe(0);
    }
  });

  it("a present-but-idle agent makes the function uncovered (the flat angle)", () => {
    const m = new Map([
      ["support-lead", h(true, false, false)],
      ["dispute-response", h(true, false, false)],
    ]);
    const support = buildCoverageMap(m).find((f) => f.fn === "support")!;
    expect(support.notApplicable).toBe(false);
    expect(support.agentHandling).toBe(0);
    expect(support.uncovered).toBe(true);
    expect(support.autonomyPct).toBe(0);
  });

  it("a handling agent lifts autonomy % and clears uncovered", () => {
    const m = new Map([
      ["support-lead", h(true, false, true)],
      ["dispute-response", h(true, false, false)],
    ]);
    const support = buildCoverageMap(m).find((f) => f.fn === "support")!;
    expect(support.agentHandling).toBe(1);
    expect(support.applicableAgents).toBe(2);
    expect(support.autonomyPct).toBe(50);
    expect(support.uncovered).toBe(false);
  });

  it("hidden agents drop out of the applicable denominator", () => {
    const m = new Map([
      ["support-lead", h(true, true, false)],
      ["dispute-response", h(true, false, true)],
    ]);
    const support = buildCoverageMap(m).find((f) => f.fn === "support")!;
    expect(support.applicableAgents).toBe(1);
    expect(support.autonomyPct).toBe(100);
    expect(support.agents.find((a) => a.slug === "support-lead")!.state).toBe("hidden");
  });

  it("admin cover clears uncovered even with no agent handling (Slice 3 input)", () => {
    const m = new Map([["support-lead", h(true, false, false)]]);
    const support = buildCoverageMap(m, { support: 2 }).find((f) => f.fn === "support")!;
    expect(support.adminCovered).toBe(2);
    expect(support.uncovered).toBe(false);
  });

  it("FUNCTION_AGENTS only references real fleet slugs (no typos)", () => {
    const known = new Set([
      "performance-marketer", "growth-lead", "content-design",
      "pm", "operator", "support-lead", "chief-of-staff", "engineer", "qa",
      "browser-operator", "dispute-response",
    ]);
    for (const fn of GROWTH_FUNCTIONS) {
      for (const slug of FUNCTION_AGENTS[fn]) expect(known.has(slug)).toBe(true);
    }
  });
});
