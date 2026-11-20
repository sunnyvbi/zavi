import { describe, expect, it } from "vitest";
import { goalBarPercent } from "./GrowthGoals";
import type { GrowthGoal } from "@/lib/workspace/useGrowthPlan";

const goal = (over: Partial<GrowthGoal>): GrowthGoal =>
  ({ id: "g", objective: "Grow hosts", target_metric: "suppliers", target_value: 800, current_value: 612, baseline_value: null, ...over }) as GrowthGoal;

describe("goalBarPercent", () => {
  it("fills to the share of the target when there is no baseline", () => {
    expect(goalBarPercent(goal({}), true)).toBe(77);
  });
  it("uses progress from the baseline when there is one", () => {
    expect(goalBarPercent(goal({ baseline_value: 600, current_value: 700 }), true)).toBe(50);
  });
  it("never fills an unmeasured goal", () => {
    expect(goalBarPercent(goal({}), false)).toBeNull();
    expect(goalBarPercent(goal({ current_value: null }), true)).toBeNull();
  });
});
