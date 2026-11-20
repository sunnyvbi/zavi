import { describe, it, expect } from "vitest";
import {
  dayInZone,
  enteredDay,
  goalMoneyMetric,
  goalUnitWords,
  goalValueMoney,
  noteGoalViews,
  planGoalChanges,
  statusLineFor,
  type GoalRow,
} from "../goal-owner";
import { goalKind, goalTrajectory, periodStartStale, rolledPeriodStart } from "../goal-trajectory";
import { basisAsk } from "../goal-basis";
import { actionsConflict, buildNoteItems, channelCardNoteItem, deriveHeadline, noteHeadline, type NoteItem } from "../cgo-note-items";

const goal = (over: Partial<GoalRow>): GoalRow => ({
  id: "g1",
  objective: "Goal",
  target_metric: "signups",
  target_value: 100,
  current_value: 10,
  current_value_at: "2026-10-30T12:00:00Z",
  due_date: "2026-11-30",
  status: "active",
  priority: 50,
  measurement_mode: "manual_reported",
  created_at: "2026-10-01T00:00:00Z",
  ...over,
});

describe("1. the founder's day, not UTC's", () => {
  const at = new Date("2026-11-01T00:38:26Z");

  it("today is the tenant's local day", () => {
    expect(dayInZone(at, "America/Los_Angeles")).toBe("2026-10-31");
    expect(dayInZone(at, "UTC")).toBe("2026-11-01");
    expect(dayInZone(at, "Not/AZone")).toBe("2026-11-01");
  });

  it("the entered date is the day the founder typed it", () => {
    expect(enteredDay("2026-11-01T00:38:26.476+00:00", "America/Los_Angeles")).toBe("2026-10-31");
    expect(enteredDay("2026-10-15", "America/Los_Angeles")).toBe("2026-10-15");
  });

  it("the note says 'entered Oct 31' and counts days left from the local day", () => {
    const g = goal({ target_metric: "signups", target_value: 20, current_value: 5, baseline_value: 5, current_value_at: "2026-11-01T00:09:18Z", due_date: "2026-11-06" });
    const [v] = noteGoalViews([g], dayInZone(at, "America/Los_Angeles"), null, "America/Los_Angeles");
    expect(v.source).toBe("From the 5 you entered Oct 31.");
    expect(v.due).toBe("6 days left");
  });
});

describe("2. a monthly total whose due date moved", () => {
  const gmv = goal({
    target_metric: "gmv",
    target_value: 600000,
    baseline_value: 157000,
    current_value: 5000,
    current_value_at: "2026-11-01T00:38:26Z",
    due_date: "2026-11-30",
    value_kind: "period_total",
    value_period_start: "2026-10-01",
  });

  it("no pace from an October start for a November total (was 9,531)", () => {
    const t = goalTrajectory(gmv, "2026-11-01", { paceUsable: true, progressUsable: true });
    expect(t.projected).toBeNull();
    expect(statusLineFor(gmv, "2026-11-01")).not.toMatch(/on pace/);
  });

  it("the start rolls to the new month when the due date moves", () => {
    const monthly = { value_kind: "period_total", value_period_start: "2026-10-01", due_date: "2026-10-31" };
    expect(periodStartStale("2026-10-01", "2026-11-30")).toBe(true);
    expect(periodStartStale("2026-10-01", "2026-10-31")).toBe(false);
    expect(rolledPeriodStart(monthly, "2026-11-30")).toBe("2026-11-01");
    expect(rolledPeriodStart(monthly, "2026-10-25")).toBeNull();
    expect(rolledPeriodStart({ ...monthly, due_date: "2026-11-30" }, "2026-12-31")).toBe("2026-12-01");
    expect(rolledPeriodStart({ value_kind: "gauge", value_period_start: null, due_date: "2026-10-31" }, "2026-11-30")).toBeNull();
    expect(rolledPeriodStart({ ...monthly, value_period_start: "2026-10-15" }, "2026-11-30")).toBeNull();
  });

  it("a quarter, half or year counted from the 1st keeps its start and its pace", () => {
    expect(periodStartStale("2026-01-01", "2026-03-31")).toBe(false);
    expect(periodStartStale("2026-01-01", "2026-03-30")).toBe(false);
    expect(periodStartStale("2026-01-01", "2026-12-31")).toBe(false);
    expect(rolledPeriodStart({ value_kind: "period_total", value_period_start: "2026-01-01", due_date: "2026-03-30" }, "2026-03-31")).toBeNull();
    const q = { ...gmv, value_period_start: "2026-01-01", due_date: "2026-03-31", current_value: 30000, current_value_at: "2026-01-30T12:00:00Z" };
    expect(goalTrajectory(q, "2026-01-30", { paceUsable: true, progressUsable: true }).projected).not.toBeNull();
  });

  it("with the rolled start the pace runs from Nov 1", () => {
    const rolled = { ...gmv, value_period_start: "2026-11-01", current_value: 40000, current_value_at: "2026-11-05T12:00:00Z" };
    const t = goalTrajectory(rolled, "2026-11-05", { paceUsable: true, progressUsable: true });
    expect(t.projected).toBe(240000);
  });

  it("cgo's due-date change writes the rolled start with it", () => {
    const oct = { ...gmv, due_date: "2026-10-31", target_value: 300000, current_value_at: "2026-10-28T12:00:00Z" };
    const plan = planGoalChanges({
      changes: [{ goal_id: oct.id, due_date: "2026-11-30", why: "new month" }],
      goals: [oct],
      today: "2026-10-29",
      now: new Date("2026-10-29T12:00:00Z"),
      run_id: "r1",
      acts: true,
      approved: true,
    } as Parameters<typeof planGoalChanges>[0]);
    expect(plan.writes[0]?.patch.value_period_start).toBe("2026-11-01");
    expect(plan.writes[0]?.patch.current_value).toBeNull();
  });

  it("the number's day is the founder's: 19:00 PT on Oct 31 is October's total", () => {
    const oct = { ...gmv, due_date: "2026-10-31", target_value: 300000, current_value_at: "2026-11-01T02:00:00Z" };
    const run = (tz: string) =>
      planGoalChanges({
        changes: [{ goal_id: oct.id, due_date: "2026-11-30", why: "new month" }],
        goals: [oct],
        today: "2026-10-31",
        tz,
        now: new Date("2026-11-01T03:00:00Z"),
        run_id: "r1",
        acts: true,
        approved: true,
      } as Parameters<typeof planGoalChanges>[0]).writes[0]?.patch;
    expect(run("America/Los_Angeles")?.current_value).toBeNull();
    expect("current_value" in (run("UTC") ?? {})).toBe(false);
  });
});

describe("3. money reads as money", () => {
  it("knows a money metric from its words", () => {
    for (const m of ["gmv", "GMV", "revenue", "mrr", "ad spend", "gross revenue", "booking value", "CAC"]) expect(goalMoneyMetric(m)).toBe(true);
    for (const m of ["signups", "Launch in 20 states", "conversion rate", "ROAS", "bookings"]) expect(goalMoneyMetric(m)).toBe(false);
  });

  it("shows $ on a money goal's values", () => {
    const g = goal({ target_metric: "gmv", target_value: 300000, current_value: 270000, baseline_value: null, current_value_at: "2026-10-28T12:00:00Z", due_date: "2026-10-31" });
    expect(statusLineFor(g, "2026-10-29")).toMatch(/^\$270,000 of \$300,000 GMV/);
    const [v] = noteGoalViews([g], "2026-10-29");
    expect(v.current).toBe("$270,000 of $300,000 GMV");
    expect(v.target).toBe("target $300,000");
    expect(v.aim).toBe("$300,000 GMV by Oct 31");
  });

  it("a price that only qualifies a count is not money", () => {
    expect(goalMoneyMetric("Reach 100 customers paying $20/month")).toBe(false);
    expect(goalMoneyMetric("Hit $1M revenue")).toBe(true);
    expect(goalMoneyMetric("$300k GMV")).toBe(true);
  });

  it("a money word that only qualifies a count does not put $ on the count", () => {
    expect(goalValueMoney("Reach 100 customers at $20 CAC", 100)).toBe(false);
    expect(goalValueMoney("Launch in 20 states on budget", 20)).toBe(false);
    expect(goalValueMoney("Hit 300,000 GMV", 300000)).toBe(true);
    expect(goalValueMoney("Reach $50,000 in sales", 50000)).toBe(true);
    expect(goalValueMoney("gmv", 300000)).toBe(true);
    const g = goal({ target_metric: "Reach 100 customers at $20 CAC", target_value: 100, current_value: 30, current_value_at: "2026-10-28T12:00:00Z" });
    expect(statusLineFor(g, "2026-10-29")).toMatch(/^30 of 100 customers at \$20 CAC/);
  });

  it("a count goal stays a bare number", () => {
    const g = goal({ target_metric: "signups", target_value: 20, current_value: 6, current_value_at: "2026-10-28T12:00:00Z" });
    expect(statusLineFor(g, "2026-10-29")).toMatch(/^6 of 20 signups/);
  });
});

describe("4. a metric typed as the goal itself", () => {
  it("keeps only the unit after the target number", () => {
    expect(goalUnitWords("Launch in 20 states", 20)).toBe("states");
    expect(goalUnitWords("reach 1,000 signups", 1000)).toBe("signups");
    expect(goalUnitWords("Hit the number", 50)).toBe("");
    expect(goalUnitWords("signups", 20)).toBe("signups");
    expect(goalUnitWords("gmv", 300000)).toBe("GMV");
  });

  it("the card reads '5 of 20 states', never '5 of 20 Launch in 20 states'", () => {
    const g = goal({ objective: "Launch ads in all 20 states", target_metric: "Launch in 20 states", target_value: 20, baseline_value: 5, current_value: 5, current_value_at: "2026-10-30T12:00:00Z", due_date: "2026-11-06" });
    expect(statusLineFor(g, "2026-10-31")).toMatch(/^5 of 20 states, 6 days left/);
    const [v] = noteGoalViews([g], "2026-10-31");
    expect(v.current).toBe("5 of 20 states");
    expect(v.aim).toBe("20 states by Nov 6");
  });
});

describe("5. the headline agrees with the card", () => {
  const title = "Pause ad set 'All 20 States' on Meta";

  const card = (outcome: "leave" | "reject", action: string) =>
    channelCardNoteItem({ outcome, row: { id: "a1", channel_slug: "meta_ads", title }, bucket: null, action, why: "", usd: null, platform: "Meta Ads", fixText: null });

  it("a model line that contradicts the card's title gives way to the title", () => {
    expect(actionsConflict("Keep All 20 States on", title)).toBe(true);
    expect(card("leave", "Keep All 20 States on").text).toBe(title);
    expect(deriveHeadline(buildNoteItems([card("leave", "Keep All 20 States on")]))).toBe(`1 thing needs you. First: ${title}.`);
    expect(card("leave", "Pause All 20 States today").text).toBe("Pause All 20 States today");
    expect(card("reject", "Keep All 20 States on").text).toBe("Said no to: Keep All 20 States on");
    expect(actionsConflict("Launch the spring ad", "Raise budget on the spring ad")).toBe(false);
    expect(actionsConflict("Raise the spring budget", "Scale down the spring budget")).toBe(true);
    expect(actionsConflict("Scale back the spring budget", "Lower the spring budget")).toBe(false);
  });

  it("cgo's own headline may not contradict a card it asks the founder to approve", () => {
    const items: NoteItem[] = [{ section: "needs_you", text: title, title, action_id: "a1", channel_slug: "meta_ads" }];
    expect(noteHeadline("Keep All 20 States on, it is working.", items)).toMatch(/^1 thing needs you\. First: Pause ad set 'All 20 States'/);
    expect(noteHeadline("Your GMV is behind; one card to look at.", items)).toBe("Your GMV is behind; one card to look at.");
  });
});

describe("6. no 'this month's total?' question on a count goal", () => {
  it("a footprint count is a running level", () => {
    const g = goal({ objective: "Launch ads in all 20 states", target_metric: "Launch in 20 states", target_value: 20, baseline_value: 5, current_value: 7 });
    expect(goalKind(g)).toBe("gauge");
    expect(basisAsk({ ...g, objective: g.objective, target_metric: g.target_metric }, "2026-10-31", "rev")).toBeNull();
  });

  it("a number still at its baseline is not asked about", () => {
    const g = goal({ target_metric: "signups", target_value: 20, baseline_value: 5, current_value: 5 });
    expect(goalKind(g)).toBe("gauge");
    expect(basisAsk(g, "2026-10-31", "rev")).toBeNull();
  });

  it("money is never read as a footprint or a level by equality", () => {
    expect(goalKind(goal({ target_metric: "Revenue from product launches", target_value: 200000, baseline_value: 100000, current_value: 50000 }))).toBe("ambiguous");
    expect(goalKind(goal({ target_metric: "revenue", target_value: 200000, baseline_value: 100000, current_value: 100000 }))).toBe("ambiguous");
  });

  it("a GMV goal that moved off its baseline is still asked", () => {
    const g = goal({ target_metric: "gmv", target_value: 300000, baseline_value: 157000, current_value: 70000, due_date: "2026-10-31", current_value_at: "2026-10-20T12:00:00Z", created_at: "2026-10-01T00:00:00Z" });
    expect(goalKind(g)).toBe("ambiguous");
    expect(basisAsk(g, "2026-10-21", "rev")).not.toBeNull();
  });
});
