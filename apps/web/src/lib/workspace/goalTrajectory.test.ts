import { describe, expect, it } from "vitest";
import { lineValueAt, type GoalTrajectory } from "./goalTrajectory";
import { goalProgress as growthProgress } from "@/components/workspace/growth/growthPresentation";
import { goalPace as historyPace } from "@/components/workspace/growth/GoalHistory";
import { goalProgress as panelProgress } from "@/components/workspace/AutopilotGoalsPanel";
import { goalProgress as homeProgress } from "@/components/workspace/home/calm/calmTypes";
import type { GrowthGoal } from "./useGrowthPlan";
import { goalBarPercent } from "@/components/workspace/growth/GrowthGoals";

const period: GoalTrajectory = {
  kind: "period_total",
  progress: 70_000 / 300_000,
  line: { start_value: 0, start_day: "2026-10-01", target: 300_000, due_day: "2026-10-31" },
  projected: 197_273,
  behind_required: true,
  reading_day: "2026-10-11",
  pace_usable: true,
};
const ambiguous: GoalTrajectory = { kind: "ambiguous", progress: null, line: null, projected: null, behind_required: true, reading_day: "2026-10-11", pace_usable: true };

const growthGoal = (over: Partial<GrowthGoal> = {}): GrowthGoal => ({
  id: "g1",
  objective: "GMV push",
  target_metric: "gmv",
  target_value: 300_000,
  baseline_value: 157_000,
  current_value: 70_000,
  due_date: "2026-10-31",
  status: "active",
  priority: 50,
  source: "founder",
  falsifier: null,
  status_changed_by: null,
  status_changed_at: null,
  ...over,
});

describe("lineValueAt", () => {
  it("counts days like the server: day 1 already carries one day's share, the due day the target", () => {
    expect(lineValueAt(period.line!, Date.parse("2026-10-01T12:00:00Z"))).toBeCloseTo(300_000 / 31);
    expect(lineValueAt(period.line!, Date.parse("2026-10-31T23:00:00Z"))).toBe(300_000);
  });
});

describe("bars read the server's progress", () => {
  it("a period total fills from 0; an ambiguous goal draws no bar (not an empty 0%)", () => {
    expect(growthProgress(growthGoal({ trajectory: period }))).toBe(23);
    expect(growthProgress(growthGoal({ trajectory: ambiguous }))).toBeNull();
    expect(panelProgress({ status: "active", current_value: 70_000, target_value: 300_000, trajectory: ambiguous })).toBeNull();
    expect(panelProgress({ status: "met", current_value: 70_000, target_value: 300_000, trajectory: ambiguous })).toBe(1);
    expect(homeProgress({ id: "g1", objective: "x", target_metric: "gmv", target_value: 300_000, baseline_value: 157_000, current_value: 70_000, due_date: null, status: "active", priority: 50, source: "founder", trajectory: period })).toBeCloseTo(0.2333, 3);
  });
  it("an older backend with no trajectory keeps the old arithmetic", () => {
    expect(growthProgress(growthGoal())).toBe(0);
  });
  it("the Growth bar draws the server's progress, never a current/target fallback for an ambiguous goal", () => {
    expect(goalBarPercent(growthGoal({ trajectory: ambiguous }), true)).toBeNull();
    expect(goalBarPercent(growthGoal({ trajectory: period }), true)).toBe(23);
    expect(goalBarPercent(growthGoal({ baseline_value: null }), true)).toBe(23);
  });
});

describe("history pace reads the server's line", () => {
  const points = [{ at: "2026-10-06T00:00:00Z", value: 3_446 }, { at: "2026-10-11T00:00:00Z", value: 70_000 }];
  it("a period total paces from 0 on its start, judged on the reading's own day with the server's verdict", () => {
    const pace = historyPace(points, growthGoal({ trajectory: period }), Date.parse("2026-10-13T12:00:00Z"), 70_000)!;
    expect(pace.expected).toBeCloseTo((300_000 * 11) / 31);
    expect(pace.onPace).toBe(false);
    expect(pace).toMatchObject({ from: "2026-10-01", asOf: "2026-10-11" });
    const ahead = historyPace(points, growthGoal({ trajectory: { ...period, behind_required: false } }), Date.parse("2026-10-13T12:00:00Z"), 120_000)!;
    expect(ahead.onPace).toBe(true);
  });
  it("a number too old to pace on shows no pace", () => {
    expect(historyPace(points, growthGoal({ trajectory: { ...period, pace_usable: false } }), Date.parse("2026-10-13T12:00:00Z"), 70_000)).toBeNull();
  });
  it("an ambiguous goal shows no pace", () => {
    expect(historyPace(points, growthGoal({ trajectory: ambiguous }), Date.parse("2026-10-11T12:00:00Z"), 70_000)).toBeNull();
  });
});
