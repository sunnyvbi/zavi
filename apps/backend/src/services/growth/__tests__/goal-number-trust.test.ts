import { describe, it, expect } from "vitest";
import { easesGoal, endedReason, numberAgeDays, numberTrusted, planGoalChanges, type GoalRow } from "../goal-owner";

const today = "2026-09-26";
const now = new Date(`${today}T14:00:00Z`);
const goal = (over: Partial<GoalRow> = {}): GoalRow =>
  ({
    id: "g1",
    objective: "Grow my MRR to 100k",
    target_metric: "mrr",
    target_value: 100000,
    current_value: 895,
    current_value_at: "2026-09-26T13:30:00Z",
    current_value_source: "stripe_mrr",
    baseline_value: null,
    due_date: "2026-09-30",
    status: "active",
    priority: 1,
    measurement_mode: "auto",
    open_cards: [],
    decided_cards: [],
    finished_steps: [],
    ...over,
  }) as unknown as GoalRow;

describe("numberTrusted", () => {
  it("an automatic number measured today or within 2 days is trusted", () => {
    expect(numberTrusted(goal(), today)).toBe(true);
    expect(numberTrusted(goal({ current_value_at: "2026-09-24T13:30:00Z" }), today)).toBe(true);
    expect(numberAgeDays(goal({ current_value_at: "2026-09-24T13:30:00Z" }), today)).toBe(2);
  });

  it("an automatic number older than 2 days, with no timestamp, or missing is not", () => {
    expect(numberTrusted(goal({ current_value_at: "2026-09-23T13:30:00Z" }), today)).toBe(false);
    expect(numberTrusted(goal({ current_value_at: null }), today)).toBe(false);
    expect(numberTrusted(goal({ current_value: null }), today)).toBe(false);
  });

  it("a founder's typed number is trusted for 14 days, then expires (decision 8)", () => {
    const typed = (at: string | null) => goal({ measurement_mode: "manual_reported", current_value_at: at });
    expect(numberTrusted(typed("2026-09-12T10:00:00Z"), today)).toBe(true);
    expect(numberTrusted(typed("2026-09-11T10:00:00Z"), today)).toBe(false);
    expect(numberTrusted(typed("2026-09-01T10:00:00Z"), today)).toBe(false);
    expect(numberTrusted(typed(null), today)).toBe(false);
    expect(numberTrusted(goal({ measurement_mode: "unmapped", current_value_at: "2026-09-20T00:00:00Z" }), today)).toBe(true);
  });

  it("a number counted by a confirmed rule is a measurement: stale after 2 days", () => {
    const rule = { dialect: "mongodb", source: "operator_db", collection: "cars", pipeline: [{ $count: "n" }], definition: "cars", schema_hash: "h", confirmed_at: "2026-09-20T00:00:00Z" };
    const counted = (at: string) => goal({ measurement_mode: "manual_reported", current_value_at: at, count_rule: rule } as never);
    expect(numberTrusted(counted("2026-09-25T13:30:00Z"), today)).toBe(true);
    expect(numberTrusted(counted("2026-09-20T13:30:00Z"), today)).toBe(false);
    const failing = goal({ measurement_mode: "manual_reported", current_value_at: "2026-09-25T13:30:00Z", count_rule: { ...rule, stale_reason: "schema_changed" } } as never);
    expect(numberTrusted(failing, today)).toBe(false);
    const proposed = goal({ measurement_mode: "manual_reported", current_value_at: "2026-09-20T13:30:00Z", count_rule: { ...rule, confirmed_at: null } } as never);
    expect(numberTrusted(proposed, today)).toBe(true);
  });

  it("no number is never trusted, whoever reports it", () => {
    expect(numberTrusted(goal({ measurement_mode: "manual_reported", current_value: null }), today)).toBe(false);
    expect(numberTrusted(goal({ measurement_mode: "unmapped", current_value: null }), today)).toBe(false);
  });
});

describe("a stale number never closes a goal", () => {
  it("met on a fresh reading, not on a stale one", () => {
    const hit = { target_value: 800, current_value: 812 };
    expect(endedReason(goal({ ...hit }), today)).toBe("met");
    expect(endedReason(goal({ ...hit, current_value_at: null }), today)).toBeNull();
  });
});

describe("planGoalChanges holds a target or date change on an untrusted number", () => {
  const plan = (g: GoalRow, change: Record<string, unknown>) =>
    planGoalChanges({
      changes: [{ goal_id: "g1", why: "Sep 30 is effectively missed.", ...change }] as never,
      goals: [g],
      today,
      now,
      run_id: "run-1",
      acts: true,
    });
  const asks = (r: { held: Array<{ ask: string }> }) => r.held.map((h) => h.ask);

  it("stale: no write, one plain question with the number and its age", () => {
    const r = plan(goal({ current_value_at: "2026-09-01T09:37:40Z" }), { due_date: "2026-12-31" });
    expect(r.writes).toHaveLength(0);
    expect(asks(r)).toEqual([
      'I didn\'t change "Grow my MRR to 100k" (due Sep 30 to Dec 31): it shows 895, last measured 25 days ago. Is that number right?',
    ]);
  });

  it("never timestamped, or never measured: says so", () => {
    expect(asks(plan(goal({ current_value_at: null }), { target_value: 20000 }))[0]).toContain(
      "it shows 895, and I can't tell when that was measured",
    );
    expect(asks(plan(goal({ current_value: null, current_value_at: null }), { target_value: 20000 }))[0]).toContain(
      "it has no measured number yet",
    );
  });

  it("fresh: a raised target is the founder's call too: a question, never a write", () => {
    const r = plan(goal(), { target_value: 120000 });
    expect(r.writes).toHaveLength(0);
    expect(asks(r)[0]).toContain('Should I raise the bar on "Grow my MRR to 100k" (target 100,000 to 120,000)?');
  });

  it("fresh: a later due date makes the goal easier, so it is a question with no default, never a write", () => {
    const r = plan(goal(), { due_date: "2026-12-31" });
    expect(r.writes).toHaveLength(0);
    expect(r.held).toEqual([expect.objectContaining({ topic_key: "goal:g1", default_action: null })]);
    expect(asks(r)[0]).toContain('Should I make "Grow my MRR to 100k" easier (due Sep 30 to Dec 31)?');
  });

  it("a metric switch with its new target is allowed on a stale number", () => {
    const r = plan(goal({ current_value_at: null }), { target_metric: "gross revenue", target_value: 40000 });
    expect(r.writes).toHaveLength(1);
    expect(asks(r)).toHaveLength(0);
  });

  it("a reworded metric that measures the same thing is not a switch: its target change is held", () => {
    const g = goal({ target_metric: "gross_revenue", current_value_at: null });
    const r = plan(g, { target_metric: "gross revenue", target_value: 40000 });
    expect(r.writes).toHaveLength(0);
    expect(asks(r)).toHaveLength(1);
  });

  it("switching to a metric nothing can measure makes the goal founder-reported, not a dead 'auto' goal", () => {
    const r = plan(goal({ current_value_at: null }), { target_metric: "revenue", target_value: 40000 });
    expect(r.writes).toHaveLength(1);
    expect(r.writes[0].patch.measurement_mode).toBe("manual_reported");
    const r2 = plan(goal({ current_value_at: null }), { target_metric: "gross revenue", target_value: 40000 });
    expect(r2.writes[0].patch.measurement_mode).toBe("auto");
  });

  it("switching between two unmeasurable metrics is still a switch", () => {
    const r = plan(goal({ target_metric: "revenue", measurement_mode: "manual_reported", current_value: null }), {
      target_metric: "cac",
      target_value: 50,
    });
    expect(r.writes).toHaveLength(1);
    expect(asks(r)).toHaveLength(0);
  });

  it("restating an unmeasurable metric with other casing or separators is not a switch", () => {
    for (const restated of ["Revenue", " revenue ", "REVENUE"]) {
      const r = plan(goal({ target_metric: "revenue", measurement_mode: "manual_reported", current_value: null }), {
        target_metric: restated,
        target_value: 50000,
      });
      expect(r.writes, restated).toHaveLength(0);
      expect(asks(r), restated).toHaveLength(1);
    }
  });

  it("whitespace in a metric name never turns a restatement into a switch", () => {
    const r = plan(goal({ target_metric: "gross\nrevenue", current_value_at: null }), {
      target_metric: "gross revenue",
      target_value: 150000,
    });
    expect(r.writes).toHaveLength(0);
    expect(asks(r)).toHaveLength(1);
  });

  it("a founder-reported goal with no number yet: its target is held", () => {
    const r = plan(goal({ target_metric: "revenue", measurement_mode: "manual_reported", current_value: null }), { target_value: 50000 });
    expect(r.writes).toHaveLength(0);
    expect(asks(r)[0]).toContain("has no measured number yet");
  });

  it("a metric switch that also moves the date is still held (the date rests on the old number)", () => {
    const r = plan(goal({ current_value_at: null }), { target_metric: "gross revenue", due_date: "2026-12-31" });
    expect(r.writes).toHaveLength(0);
    expect(asks(r)).toHaveLength(1);
  });

  it("switching to a measurable metric is still allowed on a stale number", () => {
    const r = plan(goal({ current_value_at: null }), { target_metric: "gross_revenue" });
    expect(r.writes).toHaveLength(1);
    expect(asks(r)).toHaveLength(0);
  });

  it("with Autopilot off it is still a question, not advice to move the goal", () => {
    const r = planGoalChanges({
      changes: [{ goal_id: "g1", why: "x", due_date: "2026-12-31" }] as never,
      goals: [goal({ current_value_at: null })],
      today,
      now,
      run_id: "run-1",
      acts: false,
    });
    expect(r.wouldLines).toHaveLength(0);
    expect(asks(r)).toHaveLength(1);
  });
});

describe("planGoalChanges never makes a goal easier on its own", () => {
  const plan = (g: GoalRow, change: Record<string, unknown>) =>
    planGoalChanges({ changes: [{ goal_id: "g1", why: "Behind pace.", ...change }] as never, goals: [g], today, now, run_id: "run-1", acts: true });

  it("a lower target on the same measure is a question with no default", () => {
    const r = plan(goal(), { target_value: 50000 });
    expect(r.writes).toHaveLength(0);
    expect(r.held).toEqual([expect.objectContaining({ topic_key: "goal:g1", default_action: null })]);
    expect(r.refused).toHaveLength(1);
  });

  it("with Autopilot off it is still a question, never advice to cut the goal", () => {
    const r = planGoalChanges({ changes: [{ goal_id: "g1", why: "x", target_value: 50000 }] as never, goals: [goal()], today, now, run_id: "r", acts: false });
    expect(r.wouldLines).toHaveLength(0);
    expect(r.held).toHaveLength(1);
  });

  it("easesGoal: a later or dropped due date is easier; a new measure's target is not compared", () => {
    const g = { objective: "o", target_metric: "mrr", target_value: 100, due_date: "2026-10-01", baseline_value: null, current_value: 50 };
    expect(easesGoal(g, { ...g, due_date: "2026-11-01" })).toBe(true);
    expect(easesGoal(g, { ...g, due_date: null })).toBe(true);
    expect(easesGoal(g, { ...g, due_date: "2026-09-15" })).toBe(false);
    expect(easesGoal(g, { ...g, target_metric: "gross revenue", target_value: 10 }, false)).toBe(false);
  });

  it("no baseline: the current number tells the direction; neither known means any target change is a question", () => {
    const churn = { objective: "Cut churn", target_metric: "churn_rate", target_value: 10, due_date: null, baseline_value: null, current_value: 15 };
    expect(easesGoal(churn, { ...churn, target_value: 20 })).toBe(true);
    expect(easesGoal(churn, { ...churn, target_value: 8 })).toBe(false);
    const unknown = { objective: "o", target_metric: "m", target_value: 10, due_date: null, baseline_value: null, current_value: null };
    expect(easesGoal(unknown, { ...unknown, target_value: 20 })).toBe(true);
    expect(easesGoal(unknown, { ...unknown, target_value: 5 })).toBe(true);
  });

  it("for a goal that should go down (cost, churn), a higher target is the easier one", () => {
    const churn = goal({ target_metric: "churn_rate", baseline_value: 8, target_value: 4, current_value: 7 } as Partial<GoalRow>);
    expect(plan(churn, { target_value: 6 }).held[0].ask).toContain("easier");
    expect(plan(churn, { target_value: 3 }).writes).toHaveLength(0);
    expect(plan(churn, { target_value: 3 }).held[0].ask).toContain("raise the bar");
  });

  it("still cgo's (applies): a new wording, a new measure with its own target; the founder's (a question): a higher target, an earlier date", () => {
    expect(plan(goal(), { target_value: 150000 }).writes).toHaveLength(0);
    expect(plan(goal({ due_date: "2026-12-31" }), { due_date: "2026-11-30" }).writes).toHaveLength(0);
    expect(plan(goal(), { objective: "Reach 100k MRR" }).writes).toHaveLength(1);
    expect(plan(goal(), { target_metric: "gross revenue", target_value: 40000 }).writes).toHaveLength(1);
  });
});

describe("planGoalChanges and a money goal's source pick", () => {
  const money = goal({ objective: "Grow booking value", target_metric: "gmv", measure_source: "booking_value", current_value_source: "booking_value" } as never);
  const plan = (change: Record<string, unknown>) =>
    planGoalChanges({ changes: [{ goal_id: "g1", why: "Clearer name.", ...change }] as never, goals: [money], today, now, run_id: "run-1", acts: true, approved: true } as never);

  it("any metric change clears the pick, even one that still reads as booking value (gross vs net wording)", () => {
    const r = plan({ target_metric: "net booking value after refunds" });
    expect(r.writes).toHaveLength(1);
    expect(r.writes[0].patch).toMatchObject({ measure_source: null });
  });

  it("a different measure clears the pick, and the undo snapshot keeps the old one", () => {
    const r = plan({ target_metric: "mrr" });
    expect(r.writes[0].patch).toMatchObject({ measure_source: null });
    expect((r.writes[0].patch.cgo_undo as { prev: { measure_source: string } }).prev.measure_source).toBe("booking_value");
  });
});
