const path = require("node:path");
const { loadTs } = require("./helpers/load-ts.cjs");
const { describe, it, expect } = require("./helpers/vitest-shim.cjs");

const src = (rel) => path.join(__dirname, "../src", rel);
const F = loadTs(src("features/growth/goalForm.ts"));
const H = loadTs(src("features/growth/goalHistory.ts"));
const D = loadTs(src("features/growth/dates.ts"));

const mrrGoal = {
  id: "g1",
  objective: "Grow MRR to 3,000",
  target_metric: "mrr",
  target_value: 3000,
  baseline_value: null,
  current_value: 900,
  due_date: "2026-12-31",
  status: "active",
  priority: 50,
  measurement_mode: "auto",
};
const fieldsOf = (goal, over = {}) => ({ ...F.goalFieldsStart(goal), ...over });

describe("validation (web validateGoalForm)", () => {
  const ok = { objective: "Grow MRR to 3,000", metric: "mrr", currentValue: "", targetValue: "3000", dueDate: "2026-12-31", currentRequired: false };
  it("passes a good goal", () => {
    expect(F.validateGoalForm(ok)).toEqual({});
  });
  it("says what is wrong, in web's words", () => {
    expect(F.validateGoalForm({ ...ok, objective: " " }).objective).toBe("Enter a goal name.");
    expect(F.validateGoalForm({ ...ok, objective: "Grow it" }).objective).toBe("Use at least 8 characters so the goal is clear.");
    expect(F.validateGoalForm({ ...ok, objective: "x".repeat(501) }).objective).toBe("Goal names can be up to 500 characters.");
    expect(F.validateGoalForm({ ...ok, metric: "" }).metric).toBe("Select or enter a metric.");
    expect(F.validateGoalForm({ ...ok, metric: "a" }).metric).toBe("Use at least 2 characters.");
    expect(F.validateGoalForm({ ...ok, metric: "m".repeat(121) }).metric).toBe("Metrics can be up to 120 characters.");
    expect(F.validateGoalForm({ ...ok, targetValue: "" }).targetValue).toBe("Enter a target value.");
    expect(F.validateGoalForm({ ...ok, targetValue: "0" }).targetValue).toBe("Target value must be greater than zero.");
    expect(F.validateGoalForm({ ...ok, dueDate: "" }).dueDate).toBe("Choose a due date.");
    expect(F.validateGoalForm({ ...ok, dueDate: "31/12/2026" }).dueDate).toBe("Choose a valid due date.");
  });
  it("asks for the number only where nothing can read the metric, but checks one that is typed", () => {
    expect(F.validateGoalForm({ ...ok, currentRequired: true }).currentValue).toBe("Enter the current value.");
    expect(F.validateGoalForm({ ...ok, currentValue: "abc" }).currentValue).toBe("Current value must be a number.");
    expect(F.validateGoalForm({ ...ok, currentValue: "42", currentRequired: true }).currentValue).toBeUndefined();
  });
  it("turns junk away", () => {
    expect(F.validateGoalForm({ ...ok, objective: "hhhhhhhhh" }).objective).toMatch(/placeholder text/);
    expect(F.validateGoalForm({ ...ok, objective: "brrrrtttpppp" }).objective).toMatch(/real words/);
    expect(F.detectGoalJunk({ target_metric: "yy" })).toMatch(/placeholder text/);
  });
  it("a 7-character name is too short; an empty date asks for one (T4 done-when)", () => {
    const f = fieldsOf(null, { objective: "Grow 10", metricChoice: "mrr", targetValue: "5", dueDate: "" });
    const e = F.validateFields(f);
    expect(e.objective).toBe("Use at least 8 characters so the goal is clear.");
    expect(e.dueDate).toBe("Choose a due date.");
  });
});

describe("what the form starts with and needs", () => {
  it("starts empty for a new goal, seeded by a chip", () => {
    expect(F.goalFieldsStart(null, "Improve activation").objective).toBe("Improve activation");
    expect(F.goalFieldsStart(null).metricChoice).toBe("");
  });
  it("starts from the goal; a metric the list does not know is 'Something else'", () => {
    expect(F.goalFieldsStart(mrrGoal)).toEqual({ objective: "Grow MRR to 3,000", metricChoice: "mrr", customMetric: "", currentValue: "900", targetValue: "3000", dueDate: "2026-12-31" });
    const custom = F.goalFieldsStart({ ...mrrGoal, target_metric: "verified_hosts", current_value: null });
    expect(custom.metricChoice).toBe(F.CUSTOM_METRIC);
    expect(custom.customMetric).toBe("verified_hosts");
    expect(custom.currentValue).toBe("");
    expect(F.effectiveMetric(custom)).toBe("verified_hosts");
  });
  it("a manual metric needs the number; a source-read one does not", () => {
    expect(F.currentRequired("verified_hosts")).toBe(true);
    expect(F.currentRequired("mrr")).toBe(false);
    expect(F.currentRequired("")).toBe(false);
  });
});

describe("what a save sends (web: AutopilotGoalsPanel.measure.test)", () => {
  it("'Use it' fills the box and makes the goal measured by the source", () => {
    const p = F.buildGoalPayload({ fields: fieldsOf(mrrGoal, { currentValue: "994" }), goal: mrrGoal, pulledValue: 994 });
    expect(p.current_value).toBe(994);
    expect(p.measurement_mode).toBe("auto");
  });
  it("a number typed instead is the founder's: manual_reported", () => {
    const p = F.buildGoalPayload({ fields: fieldsOf(mrrGoal, { currentValue: "1000" }), goal: mrrGoal, pulledValue: 994 });
    expect(p.current_value).toBe(1000);
    expect(p.measurement_mode).toBe("manual_reported");
  });
  it("an edit that leaves the box alone keeps the goal's mode and sends no number", () => {
    const p = F.buildGoalPayload({ fields: fieldsOf(mrrGoal, { targetValue: "3500" }), goal: mrrGoal, pulledValue: null });
    expect("measurement_mode" in p).toBe(false);
    expect("current_value" in p).toBe(false);
    expect(p.target_value).toBe(3500);
  });
  it("forgets 'Use it' when the metric changes: the number is then the founder's", () => {
    const f = fieldsOf(mrrGoal, { metricChoice: "arr", currentValue: "994" });
    const p = F.buildGoalPayload({ fields: f, goal: mrrGoal, pulledValue: null });
    expect(p.target_metric).toBe("arr");
    expect(p.current_value).toBe(994);
    expect(p.measurement_mode).toBe("manual_reported");
  });
  it("an auto MRR goal moved to ARR without 'Use it' becomes the founder's number", () => {
    const f = fieldsOf(mrrGoal, { metricChoice: "arr" });
    const p = F.buildGoalPayload({ fields: f, goal: mrrGoal, pulledValue: null });
    expect(p.target_metric).toBe("arr");
    expect(p.current_value).toBe(900);
    expect(p.measurement_mode).toBe("manual_reported");
  });
  it("the first number is the baseline; later reports leave it alone", () => {
    const manual = { ...mrrGoal, target_metric: "verified_hosts", measurement_mode: "manual_reported", current_value: null };
    const first = F.buildGoalPayload({ fields: fieldsOf(manual, { currentValue: "120" }), goal: manual, pulledValue: null });
    expect(first.baseline_value).toBe(120);
    const later = F.buildGoalPayload({ fields: fieldsOf({ ...manual, baseline_value: 120, current_value: 120 }, { currentValue: "150" }), goal: { ...manual, baseline_value: 120, current_value: 120 }, pulledValue: null });
    expect(later.baseline_value).toBe(120);
    expect(later.current_value).toBe(150);
  });
  it("a new goal sends its number, a default priority, and trims the name", () => {
    const f = fieldsOf(null, { objective: "  Reach 500 signups  ", metricChoice: "signups", currentValue: "10", targetValue: "500", dueDate: "2026-12-01" });
    expect(F.buildGoalPayload({ fields: f, goal: null, pulledValue: null })).toEqual({
      objective: "Reach 500 signups",
      target_metric: "signups",
      target_value: 500,
      baseline_value: 10,
      due_date: "2026-12-01",
      priority: 50,
      current_value: 10,
      measurement_mode: "manual_reported",
    });
  });
  it("shows the warnings the server sends, strings only", () => {
    expect(F.warningsOf({ warnings: ["The current value was not saved.", "", 3] })).toEqual(["The current value was not saved."]);
    expect(F.warningsOf(null)).toEqual([]);
  });
  it("says what the live read found", () => {
    const src = { label: "Stripe" };
    expect(F.liveReadLine({ loading: true, measured: false, sourceLabel: "Stripe" }, "mrr", src).text).toBe("Reading from Stripe…");
    expect(F.liveReadLine({ loading: false, measured: true, value: 994, sourceLabel: "Stripe" }, "mrr", src)).toEqual({ text: "Stripe reads $994. ", use: true });
    expect(F.liveReadLine({ loading: false, measured: false, failed: true, sourceLabel: "Stripe" }, "mrr", src).text).toBe("Could not reach Stripe right now. You can type the number.");
    expect(F.liveReadLine({ loading: false, measured: false, sourceLabel: "Stripe" }, "mrr", src).text).toBe("Stripe can read this once it is connected. Until then, type the number.");
  });
  it("shows the server's sentence on a refused save, else HTTP <status>", () => {
    expect(F.saveErrorText({ status: 409, code: "goal_limit_reached", message: "You have 20 active goals." })).toBe("You have 20 active goals.");
    expect(F.saveErrorText({ status: 500, code: "http_500", message: "Request failed (500)" })).toBe("HTTP 500");
    expect(F.saveErrorText(new TypeError("Network request failed"))).toBe("Network request failed");
    expect(F.serverMessage({ code: "http_404" }, "Could not pause that goal.")).toBe("Could not pause that goal.");
  });
  it("describes the data source under the box", () => {
    expect(F.dataSourceNote("")).toBe("The source is determined by the metric you choose.");
    expect(F.dataSourceNote("mrr")).toBe("Matched automatically to the selected metric.");
    expect(F.dataSourceNote("verified_hosts")).toBe("This metric is updated manually.");
  });
});

describe("goal order (web: GrowthStory goal order)", () => {
  const g = (id, priority) => ({ id, priority });
  it("moving a goal renumbers top-down 100, 99... and writes only the goals that changed", () => {
    expect(F.reorderWrites([g("a", 100), g("b", 99), g("c", 98)], 2, -1)).toEqual([
      { id: "c", priority: 99 },
      { id: "b", priority: 98 },
    ]);
  });
  it("makes the order exact when every goal shares the default 50", () => {
    expect(F.reorderWrites([g("a", 50), g("b", 50)], 1, -1)).toEqual([
      { id: "b", priority: 100 },
      { id: "a", priority: 99 },
    ]);
  });
  it("goes nowhere off either end", () => {
    expect(F.reorderWrites([g("a", 100), g("b", 99)], 0, -1)).toBeNull();
    expect(F.reorderWrites([g("a", 100), g("b", 99)], 1, 1)).toBeNull();
  });
  it("says the cap and the failures in web's words", () => {
    expect(F.capLine(20)).toBe("20 goals is the most this plan chases at once. Pause one to add another.");
    expect(F.REORDER_ERROR).toBe("Could not save the new goal order. Try again.");
    expect(F.DELETE_ERROR).toBe("Could not delete that goal. Try again.");
    expect(F.DELETE_CONFIRM).toBe("Delete this goal? Zavi stops working on it. This can't be undone.");
    expect(F.ACCEPT_GONE).toBe("That suggestion is no longer open.");
    expect(F.ACCEPT_ERROR).toBe("Could not add that goal. Try again.");
  });
});

describe("goal history in the editor (web: GoalHistory)", () => {
  const fmt = (v) => `$${Math.round(v).toLocaleString("en-US")}`;
  const points = [
    { at: "2026-09-01T00:00:00Z", value: 1000 },
    { at: "2026-09-28T00:00:00Z", value: 1290 },
  ];
  const NOW = Date.parse("2026-09-28T12:00:00Z");
  const goal = { target_value: 3000, due_date: "2026-12-31" };
  const pace = H.historyPace(points, goal, NOW, 1290);

  it("says behind, with the gap, and shows the stat tiles", () => {
    const behind = H.isBehind(pace, fmt);
    expect(behind).toBe(true);
    const v = H.historyVerdict({ failed: false, points, pace, behind, measurementMode: "auto", format: fmt });
    expect(v.tone).toBe("bad");
    expect(v.title).toMatch(/^Behind pace: about \$\d+ short\.$/);
    expect(v.detail).toMatch(/^The line from Sep 1 to the goal says \$/);
    const stats = H.historyStats(pace, fmt);
    expect(stats.map((s) => s.label)).toEqual(["Where the line says today", "Needed a week to finish", "Days left"]);
    expect(stats[1].value).toMatch(/^\+\$/);
    expect(stats[2].value).toBe("95");
  });
  it("says on track when nothing is short, even a hair behind the line", () => {
    const p = { expected: 1000.2, onPace: false, gap: 0.2, perWeek: 10, daysLeft: 20 };
    expect(H.isBehind(p, fmt)).toBe(false);
    expect(H.historyVerdict({ failed: false, points, pace: p, behind: false, measurementMode: "auto", format: fmt }).title).toBe("On track to hit the goal.");
  });
  it("keeps four honest empty states, never an invented one", () => {
    const base = { points: [], pace: null, behind: false, measurementMode: "manual_reported", format: fmt };
    expect(H.historyVerdict({ ...base, failed: true }).title).toBe("History could not be loaded.");
    expect(H.historyVerdict({ ...base, failed: false }).detail).toBe("Each number you enter from Edit is dated and drawn here.");
    expect(H.historyVerdict({ ...base, failed: false, measurementMode: "auto" }).detail).toBe("Zavi records this goal once a day once its source can read it.");
    expect(H.historyVerdict({ ...base, failed: false, points }).title).toBe("2 readings since Sep 1.");
    expect(H.historyVerdict({ ...base, failed: false, points, pace: { ...pace, daysLeft: 0 } }).title).toBe("The due date has passed.");
    expect(H.historyStats(null, fmt).map((s) => s.value)).toEqual([null, null, null]);
  });
  it("draws the readings and the goal line in one range", () => {
    const line = H.targetLine(points, goal);
    expect(line).toHaveLength(2);
    expect(line[0]).toBe(1000);
    const p = H.sparkPaths([1000, 1290], line);
    expect(p.actual.startsWith("M")).toBe(true);
    expect(p.goal.startsWith("M")).toBe(true);
    expect(H.targetLine([], goal)).toBeNull();
    expect(H.sparkPaths([5], null).actual).toBe("");
  });
  it("names where the numbers come from", () => {
    expect(H.receiptLine({ points, source: "founder_reported", label: null, last_measured_at: null })).toBe("The numbers you entered for this goal, each dated when you entered it.");
    expect(H.receiptLine({ points, source: "stripe_mrr", label: "MRR", window_kind: "rolling_7d", last_measured_at: null })).toBe("MRR, measured by Zavi from Stripe once a day over the last 7 days.");
    expect(H.receiptLine({ points: [], source: null, last_measured_at: null })).toBeNull();
    expect(H.historyBodyOf({ points: "x" }).points).toEqual([]);
  });
});

describe("date picker maths", () => {
  it("reads and writes calendar days", () => {
    expect(D.parseIsoDate("2026-02-29")).toBeNull();
    expect(D.parseIsoDate("2028-02-29")).toEqual({ year: 2028, month: 2, day: 29 });
    expect(D.parseIsoDate("2026-13-01")).toBeNull();
    expect(D.isoOf(2026, 3, 4)).toBe("2026-03-04");
    expect(D.dateLabel("2026-10-04")).toBe("Oct 4, 2026");
    expect(D.dateLabel("nope")).toBe("");
  });
  it("moves across year ends and lays out weeks of seven", () => {
    expect(D.addMonths(2026, 12, 1)).toEqual({ year: 2027, month: 1 });
    expect(D.addMonths(2026, 1, -1)).toEqual({ year: 2025, month: 12 });
    const weeks = D.monthWeeks(2026, 10);
    expect(weeks.every((w) => w.length === 7)).toBe(true);
    expect(weeks.flat().filter((d) => d !== null)).toHaveLength(31);
  });
});
