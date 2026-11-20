import { describe, expect, it } from "vitest";
import { behindLine, daysInclusive, goalKind, goalMet, goalTrajectory, paceLines, projectOnLine, proposedPeriodStart, readingDay, valueKindRefusal, type TrajectoryGoal } from "../goal-trajectory";

const g = (over: Partial<TrajectoryGoal> = {}): TrajectoryGoal => ({
  target_metric: "signups",
  target_value: 1_000,
  current_value: 400,
  current_value_at: "2026-11-10T08:00:00Z",
  baseline_value: 600,
  created_at: "2026-11-01T12:00:00Z",
  due_date: "2026-11-30",
  measurement_mode: "manual_reported",
  count_rule: null,
  value_kind: null,
  value_period_start: null,
  ...over,
});
const fresh = { paceUsable: true, progressUsable: true };

describe("goalKind", () => {
  it("a typed number with a target above a positive baseline and no stated kind is ambiguous", () => {
    expect(goalKind(g())).toBe("ambiguous");
  });
  const rule = { dialect: "sql", source: "operator_db", query: "select 1", definition: "x", schema_hash: "h", confirmed_at: "2026-11-01T00:00:00Z" };
  it("a measured number, a confirmed count rule, a stated kind, no baseline, or a cost metric is not", () => {
    expect(goalKind(g({ measurement_mode: "auto" }))).toBe("gauge");
    expect(goalKind(g({ count_rule: rule }))).toBe("gauge");
    expect(goalKind(g({ value_kind: "gauge" }))).toBe("gauge");
    expect(goalKind(g({ value_kind: "period_total", value_period_start: "2026-11-01" }))).toBe("period_total");
    expect(goalKind(g({ baseline_value: null }))).toBe("gauge");
    expect(goalKind(g({ target_metric: "cost per signup", baseline_value: 1_500 }))).toBe("gauge");
  });
  it("a count-up target BELOW its baseline (last month 300k, this month 250k) can be read both ways too", () => {
    expect(goalKind(g({ baseline_value: 1_500 }))).toBe("ambiguous");
  });
  it("a stated kind wins over a confirmed count rule (a rule says what is counted, not over which window)", () => {
    expect(goalKind(g({ count_rule: rule, value_kind: "period_total", value_period_start: "2026-11-01" }))).toBe("period_total");
  });
  it("an automatic number counts its own way, whatever was stored", () => {
    expect(goalKind(g({ measurement_mode: "auto", value_kind: "period_total", value_period_start: "2026-11-01" }))).toBe("gauge");
  });
  it("period_total without a start day is not trusted as one", () => {
    expect(goalKind(g({ value_kind: "period_total", value_period_start: null }))).toBe("ambiguous");
  });
});

describe("counting days", () => {
  it("both ends count: the same day is 1, a 30-day month is 30", () => {
    expect(daysInclusive("2026-11-01", "2026-11-01")).toBe(1);
    expect(daysInclusive("2026-11-01", "2026-11-30")).toBe(30);
  });
  it("the reading day is when the number was written, never after today", () => {
    expect(readingDay({ current_value_at: "2026-11-10T08:00:00Z" }, "2026-11-12")).toBe("2026-11-10");
    expect(readingDay({ current_value_at: "2026-11-20T08:00:00Z" }, "2026-11-12")).toBe("2026-11-12");
    expect(readingDay({ current_value_at: null }, "2026-11-12")).toBe("2026-11-12");
  });
  it("no forecast under 3 counted days; the third day forecasts", () => {
    const line = { start_value: 0, start_day: "2026-11-01", target: 1_000, due_day: "2026-11-30" };
    expect(projectOnLine(line, 50, "2026-11-02")).toBeNull();
    expect(projectOnLine(line, 60, "2026-11-03")).toBe(600);
    expect(projectOnLine(line, 60, "2026-11-30")).toBeNull();
  });
});

describe("goalTrajectory", () => {
  it("ambiguous: no projection, no progress, behind only when behind on both lines", () => {
    const t = goalTrajectory(g(), "2026-11-12", fresh);
    expect(t).toMatchObject({ kind: "ambiguous", projected: null, progress: null, line: null, behind_required: false });
    expect(paceLines(g(), "2026-11-12")).toHaveLength(2);
    expect(goalTrajectory(g({ current_value: 200 }), "2026-11-12", fresh).behind_required).toBe(true);
  });
  it("period total: line from 0 on its start, run-rate projection, progress current/target", () => {
    const t = goalTrajectory(g({ value_kind: "period_total", value_period_start: "2026-11-01" }), "2026-11-12", fresh);
    expect(t.kind).toBe("period_total");
    expect(t.line).toEqual({ start_value: 0, start_day: "2026-11-01", target: 1_000, due_day: "2026-11-30" });
    expect(t.projected).toBe(1_200);
    expect(t.behind_required).toBe(false);
    expect(t.progress).toBeCloseTo(0.4);
  });
  it("gauge: today's math from the baseline, and a decline below the start still reads as behind", () => {
    const t = goalTrajectory(g({ value_kind: "gauge" }), "2026-11-12", fresh);
    expect(t.projected).toBe(0);
    expect(t.behind_required).toBe(true);
    expect(t.progress).toBe(0);
  });
  it("a cost goal (target below its start) is behind ABOVE its line", () => {
    const cost = g({ target_metric: "cost per signup", baseline_value: 80, target_value: 40, current_value: 79, value_kind: null });
    expect(goalKind(cost)).toBe("gauge");
    expect(behindLine(paceLines(cost, "2026-11-15")[0], 79, "2026-11-15")).toBe(true);
    expect(behindLine(paceLines(cost, "2026-11-15")[0], 50, "2026-11-15")).toBe(false);
  });
  it("an ambiguous goal set mid-month reads its period line from the day cgo's question names (the 1st)", () => {
    const mid = g({ created_at: "2026-11-11T09:00:00Z", current_value_at: "2026-11-12T08:00:00Z", baseline_value: 1_500, target_value: 3_000, current_value: 300 });
    expect(proposedPeriodStart(mid, "2026-11-12")).toBe("2026-11-01");
    expect(paceLines(mid, "2026-11-12")[1]).toMatchObject({ start_value: 0, start_day: "2026-11-01" });
    expect(goalTrajectory(mid, "2026-11-12", fresh).behind_required).toBe(true);
  });
  it("met on the goal's own line; a number that could be either is met only when both readings agree", () => {
    expect(goalMet(g({ value_kind: "period_total", value_period_start: "2026-11-01", baseline_value: 1_500, current_value: 1_000 }))).toBe(true);
    expect(goalMet(g({ baseline_value: 1_500, current_value: 400 }))).toBe(false);
    expect(goalMet(g({ target_metric: "cost per signup", baseline_value: 80, target_value: 40, current_value: 39 }))).toBe(true);
    expect(goalMet(g({ current_value: 1_200 }))).toBe(true);
  });
  it("a number too old to pace on drives nothing, and a stale one draws no bar", () => {
    const t = goalTrajectory(g({ value_kind: "period_total", value_period_start: "2026-11-01", current_value: 10 }), "2026-11-12", { paceUsable: false, progressUsable: false });
    expect(t).toMatchObject({ projected: null, behind_required: false, progress: null, pace_usable: false });
  });
  it("says which day it judged on", () => {
    expect(goalTrajectory(g(), "2026-11-12", fresh)).toMatchObject({ reading_day: "2026-11-10", pace_usable: true });
  });
});

describe("valueKindRefusal", () => {
  const ok = { value_kind: "period_total", value_period_start: "2026-11-01", target_value: 1_000, baseline_value: 600, measurement_mode: "manual_reported", due_date: "2026-11-30", direction: "up" as const };
  it("accepts a typed count-up goal, a gauge, and clearing it", () => {
    expect(valueKindRefusal(ok)).toBeNull();
    expect(valueKindRefusal({ ...ok, value_kind: "gauge", value_period_start: null })).toBeNull();
    expect(valueKindRefusal({ ...ok, value_kind: null, value_period_start: null })).toBeNull();
  });
  it("refuses a period total that cannot be one", () => {
    expect(valueKindRefusal({ ...ok, value_period_start: null })).toMatch(/YYYY-MM-DD/);
    expect(valueKindRefusal({ ...ok, value_period_start: "2026-12-05" })).toMatch(/on or before the due date/);
    expect(valueKindRefusal({ ...ok, measurement_mode: "auto" })).toMatch(/connected source/);
    expect(valueKindRefusal({ ...ok, value_period_start: "2026-02-31" })).toMatch(/YYYY-MM-DD/);
    expect(valueKindRefusal({ ...ok, baseline_value: 2_000 })).toBeNull();
    expect(valueKindRefusal({ ...ok, direction: "context" })).toMatch(/not one you count up to/);
    expect(valueKindRefusal({ ...ok, direction: "down" })).toMatch(/not one you count up to/);
    expect(valueKindRefusal({ ...ok, value_kind: "weekly" })).toMatch(/gauge, period_total or null/);
    expect(valueKindRefusal({ ...ok, value_kind: "gauge" })).toMatch(/only for period_total/);
  });
});

describe("valueKindRefusal: metrics the registry does not map", () => {
  const ok = { value_kind: "period_total", value_period_start: "2026-11-01", target_value: 1_000, baseline_value: null, measurement_mode: "manual_reported", due_date: "2026-11-30" };
  it("refuses spend, cost and churn goals by their words; keeps count-up goals", () => {
    for (const m of ["ad spend", "Cost per signup", "CAC", "monthly churn", "refunds"]) expect(valueKindRefusal({ ...ok, target_metric: m })).toMatch(/not one you count up to/);
    for (const m of ["gmv", "signups this month", "booked value", "new customers"]) expect(valueKindRefusal({ ...ok, target_metric: m })).toBeNull();
  });
});
