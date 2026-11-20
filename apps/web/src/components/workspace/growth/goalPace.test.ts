
import { describe, expect, it } from "vitest";
import { goalPace } from "./growthPresentation";
import type { GrowthGoal } from "@/lib/workspace/useGrowthPlan";

const NOW = new Date("2026-01-01T00:00:00Z");

function goal(over: Partial<GrowthGoal>): GrowthGoal {
  return {
    id: "g1",
    objective: "Grow signups",
    target_metric: "signups",
    target_value: 500,
    baseline_value: 100,
    current_value: 120,
    due_date: "2026-03-12",
    status: "active",
    priority: 1,
    source: "founder",
    falsifier: null,
    status_changed_by: null,
    status_changed_at: null,
    ...over,
  };
}

describe("goalPace", () => {
  it("divides what is LEFT by the weeks left, not the whole target", () => {
    const pace = goalPace(goal({}), NOW);
    expect(pace).not.toBeNull();
    expect(pace!.remaining).toBe(380);
    expect(pace!.weeks).toBe(10);
    expect(pace!.perWeek).toBe(38);
  });

  it("measures the gap from today, not from the baseline", () => {
    const pace = goalPace(goal({ current_value: 400 }), NOW);
    expect(pace!.remaining).toBe(100);
    expect(pace!.perWeek).toBe(10);
  });

  it("reports met rather than a negative pace once the target is passed", () => {
    const pace = goalPace(goal({ current_value: 600 }), NOW);
    expect(pace!.met).toBe(true);
    expect(pace!.perWeek).toBe(0);
  });

  it("floors at one week so a goal due in days does not inflate the number", () => {
    const pace = goalPace(goal({ due_date: "2026-01-04" }), NOW);
    expect(pace!.weeks).toBe(1);
    expect(pace!.perWeek).toBe(380);
  });

  describe("lower-is-better goals", () => {
    const cac = (over: Partial<GrowthGoal> = {}) =>
      goal({
        objective: "Cut cost per signup",
        target_metric: "cost_per_signup",
        baseline_value: 100,
        current_value: 80,
        target_value: 50,
        ...over,
      });

    it("does not call a downward goal met just because current exceeds target", () => {
      const pace = goalPace(cac(), NOW);
      expect(pace!.met).toBe(false);
      expect(pace!.direction).toBe("down");
      expect(pace!.remaining).toBe(30);
      expect(pace!.perWeek).toBe(3);
    });

    it("reports met once a downward goal is at or below its target", () => {
      const pace = goalPace(cac({ current_value: 45 }), NOW);
      expect(pace!.met).toBe(true);
    });

    it("infers downward from current when there is no baseline", () => {
      const pace = goalPace(cac({ baseline_value: null }), NOW);
      expect(pace!.direction).toBe("down");
      expect(pace!.remaining).toBe(30);
    });

    it("keeps perWeek positive in both directions", () => {
      expect(goalPace(cac(), NOW)!.perWeek).toBeGreaterThan(0);
      expect(goalPace(goal({}), NOW)!.perWeek).toBeGreaterThan(0);
    });

    it("still reads an upward goal as upward", () => {
      expect(goalPace(goal({}), NOW)!.direction).toBe("up");
    });
  });

  it.each([
    ["no measurement", { current_value: null }],
    ["no target", { target_value: null }],
    ["no due date", { due_date: null }],
    ["a due date already past", { due_date: "2025-12-01" }],
    ["an unparseable due date", { due_date: "not-a-date" }],
  ])("refuses to invent a pace with %s", (_label, over) => {
    expect(goalPace(goal(over as Partial<GrowthGoal>), NOW)).toBeNull();
  });

  it("reads the due date as UTC, so a timestamped date is not a day off", () => {
    const bare = goalPace(goal({ due_date: "2026-03-12" }), NOW);
    const stamped = goalPace(goal({ due_date: "2026-03-12T18:45:00Z" }), NOW);
    expect(stamped!.weeks).toBe(bare!.weeks);
    expect(stamped!.perWeek).toBe(bare!.perWeek);
  });

  it("loses a week honestly as the deadline approaches", () => {
    const early = goalPace(goal({}), new Date("2026-01-01T00:00:00Z"));
    const later = goalPace(goal({}), new Date("2026-01-01T07:30:00Z"));
    expect(early!.weeks).toBe(10);
    expect(later!.weeks).toBe(9);
    expect(later!.perWeek).toBeGreaterThan(early!.perWeek);
  });
});
