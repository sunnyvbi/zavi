import { describe, expect, it } from "vitest";
import { goalPace, reviewMetaFromPayload, spareDailyCapacityUsd, type GoalRow } from "../goal-owner";
import { clampNextReviewDays } from "../cgo-watch";

const goal = (over: Partial<GoalRow> = {}): GoalRow => ({
  id: "g1",
  objective: "Reach 300 signups by Oct 30",
  target_metric: "signups",
  target_value: 300,
  current_value: 10,
  current_value_at: "2026-10-02T09:00:00Z",
  due_date: "2026-10-30",
  status: "active",
  priority: 50,
  measurement_mode: "auto",
  baseline_value: null,
  created_at: "2026-10-01T18:00:00Z",
  ...over,
});

describe("goalPace", () => {
  it("day 2 of a 30-day goal: behind from day 1, not after a quarter of the time", () => {
    const p = goalPace(goal(), "2026-10-02");
    expect(p.days_left).toBe(29);
    expect(p.remaining).toBe(290);
    expect(p.required_per_day).toBe(10);
    expect(p.behind_required).toBe(true);
  });

  it("on pace when ahead of the line", () => {
    expect(goalPace(goal({ current_value: 40 }), "2026-10-02").behind_required).toBe(false);
  });

  it("due today counts as one day left; past due and undated carry no deadline", () => {
    expect(goalPace(goal(), "2026-10-30").days_left).toBe(1);
    expect(goalPace(goal(), "2026-10-31")).toEqual({ days_left: null, remaining: null, required_per_day: null, behind_required: false });
    expect(goalPace(goal({ due_date: null }), "2026-10-02").days_left).toBeNull();
  });

  it("lower-is-better: a cost goal is behind when ABOVE its line", () => {
    const cost = goal({ target_metric: "cost per signup", baseline_value: 80, target_value: 40, current_value: 79, current_value_at: "2026-10-15T08:00:00Z" });
    const p = goalPace(cost, "2026-10-15");
    expect(p.remaining).toBe(39);
    expect(p.behind_required).toBe(true);
    expect(goalPace({ ...cost, current_value: 50 }, "2026-10-15").behind_required).toBe(false);
  });

  it("met goal: nothing remaining, never behind", () => {
    const p = goalPace(goal({ current_value: 320 }), "2026-10-02");
    expect(p.remaining).toBe(0);
    expect(p.behind_required).toBe(false);
  });

  it("a typed number drives pace for 3 days, then not (keeps days_left)", () => {
    const typed = goal({ measurement_mode: "manual_reported", current_value: 5 });
    expect(goalPace({ ...typed, current_value_at: "2026-10-01T09:00:00Z" }, "2026-10-04").behind_required).toBe(true);
    const old = goalPace({ ...typed, current_value_at: "2026-10-01T09:00:00Z" }, "2026-10-05");
    expect(old.behind_required).toBe(false);
    expect(old.required_per_day).toBeNull();
    expect(old.days_left).toBe(26);
  });

  it("no number at all: no pace, never behind", () => {
    const p = goalPace(goal({ current_value: null, current_value_at: null }), "2026-10-02");
    expect(p.behind_required).toBe(false);
    expect(p.remaining).toBeNull();
  });
});

describe("daily review while behind (change 2)", () => {
  const payloadWith = (goals: unknown[]) => ({ autopilot: true, memory: { cgo_goals: { goals } } });
  it("meta marks behind_required_near only for a behind goal due within 31 days, from the server's payload", () => {
    const near = goalPace(goal(), "2026-10-02");
    expect(reviewMetaFromPayload(payloadWith([near]) as never).behind_required_near).toBe(true);
    const far = goalPace(goal({ due_date: "2026-12-31", created_at: "2026-10-01T00:00:00Z", current_value: 1 }), "2026-10-02");
    expect(far.behind_required).toBe(true);
    expect(reviewMetaFromPayload(payloadWith([far]) as never).behind_required_near).toBe(false);
    expect(reviewMetaFromPayload(payloadWith([goalPace(goal({ current_value: 40 }), "2026-10-02")]) as never).behind_required_near).toBe(false);
  });
  it("the clamp allows 1 day only when the server says so", () => {
    expect(clampNextReviewDays(1, { allowDaily: true })).toBe(1);
    expect(clampNextReviewDays(1)).toBe(2);
    expect(clampNextReviewDays(7, { allowDaily: true })).toBe(7);
    expect(clampNextReviewDays(undefined, { allowDaily: true })).toBe(7);
  });
});

describe("spareDailyCapacityUsd", () => {
  it("spreads what is left over the days left at the margin", () => {
    expect(spareDailyCapacityUsd(25_000, 30, 1.25)).toBe(666.66);
    expect(spareDailyCapacityUsd(25_000, 30, 1)).toBe(833.33);
  });
  it("a founder's daily limit caps it, net of what live ads already run per day", () => {
    expect(spareDailyCapacityUsd(5_000, 10, 1.25, { limit_usd: 20, held_usd: 375 })).toBe(0);
    expect(spareDailyCapacityUsd(5_000, 10, 1.25, { limit_usd: 100, held_usd: 500 })).toBe(60);
    expect(spareDailyCapacityUsd(5_000, 10, 1.25, { limit_usd: null, held_usd: 500 })).toBe(400);
  });
  it("C3: with a live forecast it is measured against what live ads spend, not their holds (paused = 0)", () => {
    expect(spareDailyCapacityUsd(9_000, 30, 1, { limit_usd: null, held_usd: 15_482 }, { daily_usd: 300, unspent_usd: 24_482 })).toBe(516.06);
    expect(spareDailyCapacityUsd(9_000, 30, 1, { limit_usd: null, held_usd: 15_482 })).toBe(300);
    expect(spareDailyCapacityUsd(9_000, 30, 1, { limit_usd: 400, held_usd: 0 }, { daily_usd: 300, unspent_usd: 24_482 })).toBe(100);
    expect(spareDailyCapacityUsd(9_000, 30, 1, undefined, { daily_usd: 2_000, unspent_usd: 24_482 })).toBe(0);
  });
  it("never negative; null with no days left or a bad margin", () => {
    expect(spareDailyCapacityUsd(-5, 10, 1.25)).toBe(0);
    expect(spareDailyCapacityUsd(1000, 0, 1.25)).toBeNull();
    expect(spareDailyCapacityUsd(1000, 10, 0.5)).toBeNull();
  });
});
