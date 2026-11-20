import { describe, expect, it } from "vitest";
import type { GrowthGoal } from "@/lib/workspace/useGrowthPlan";
import { goalCountLabel, rankGoals } from "./GrowthGoals";

describe("goalCountLabel", () => {
  it("states the count alone, never a cap that reads as more goals", () => {
    expect(goalCountLabel(0)).toBe("0 active");
    expect(goalCountLabel(1)).toBe("1 active");
    expect(goalCountLabel(4)).toBe("4 active");
  });
});

describe("rankGoals", () => {
  const g = (id: string, priority: number | null) => ({ id, priority }) as GrowthGoal;

  it("leads with the HIGHEST priority, missing last, ties in server order", () => {
    const ranked = rankGoals([g("none", null), g("low", 1), g("tieA", 50), g("tieB", 50), g("top", 90)]);
    expect(ranked.map((x) => x.id)).toEqual(["top", "tieA", "tieB", "low", "none"]);
  });
});
