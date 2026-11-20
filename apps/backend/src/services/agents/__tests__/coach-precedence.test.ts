import { describe, it, expect } from "vitest";
import {
  extractPrimaryGoalId,
  selectAgentProposedRunIds,
  COVER_ACTIONS,
  type ConductorRunRef,
} from "../coach-precedence";

describe("extractPrimaryGoalId", () => {
  it("returns the first node's payload.goal_id", () => {
    const graph = [{ payload: { goal_id: "g-1" } }, { payload: { goal_id: "g-2" } }];
    expect(extractPrimaryGoalId(graph)).toBe("g-1");
  });
  it("skips nodes without a goal_id and finds a later one", () => {
    const graph = [{ payload: {} }, { id: "x" }, { payload: { goal_id: "g-9" } }];
    expect(extractPrimaryGoalId(graph)).toBe("g-9");
  });
  it("returns null when no node declares a goal_id (→ never cancel)", () => {
    expect(extractPrimaryGoalId([{ payload: {} }, { id: "y" }])).toBeNull();
    expect(extractPrimaryGoalId([])).toBeNull();
    expect(extractPrimaryGoalId(null)).toBeNull();
    expect(extractPrimaryGoalId("nonsense")).toBeNull();
  });
});

describe("selectAgentProposedRunIds (spend-path safety)", () => {
  const src = new Map<string, string>([
    ["g-agent", "agent_proposed"],
    ["g-founder", "founder"],
  ]);

  it("selects ONLY agent_proposed runs", () => {
    const runs: ConductorRunRef[] = [
      { id: "r-agent", goalId: "g-agent" },
      { id: "r-founder", goalId: "g-founder" },
    ];
    expect(selectAgentProposedRunIds(runs, src)).toEqual(["r-agent"]);
  });

  it("NEVER cancels a founder run", () => {
    const runs: ConductorRunRef[] = [{ id: "r-founder", goalId: "g-founder" }];
    expect(selectAgentProposedRunIds(runs, src)).toEqual([]);
  });

  it("NEVER cancels a run with an unresolved goal id (skip-on-doubt)", () => {
    const runs: ConductorRunRef[] = [
      { id: "r-null", goalId: null },
      { id: "r-unknown", goalId: "g-not-in-map" },
    ];
    expect(selectAgentProposedRunIds(runs, src)).toEqual([]);
  });

  it("set_goal + bake_rule are part of the cover-action taxonomy", () => {
    expect(COVER_ACTIONS).toContain("set_goal");
    expect(COVER_ACTIONS).toContain("bake_rule");
  });
});
