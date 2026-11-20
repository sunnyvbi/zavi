import { beforeEach, describe, expect, it, vi } from "vitest";
import { isYesNoAsk } from "../cgo-questions";
import { applyGoalBasis, basisAsk, undoGoalBasis } from "../goal-basis";
import { proposedPeriodStart } from "../goal-trajectory";
import { goalRev } from "../goal-owner";

const writes: Array<Record<string, unknown>> = [];
let goalRow: Record<string, unknown> | null = null;
let writeStatus: "written" | "not_matched" = "written";

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => {
    const q = {
      select: () => q,
      eq: () => q,
      maybeSingle: async () => ({ data: goalRow, error: null }),
    };
    return { from: () => q };
  },
}));
vi.mock("../goal-write", () => ({
  writeAutopilotGoal: async (_t: string, w: Record<string, unknown>) => {
    writes.push(w);
    return writeStatus === "written" ? { status: "written", id: "g1" } : { status: "not_matched" };
  },
}));

const NOW = new Date("2026-11-12T10:00:00.000Z");

const goal = (over: Record<string, unknown> = {}) => ({
  id: "g1",
  objective: "Signups growth push.",
  target_metric: "signups",
  target_value: 3_000,
  baseline_value: 1_500,
  current_value: 700,
  current_value_at: "2026-11-11T03:00:00Z",
  created_at: "2026-11-01T18:00:00Z",
  due_date: "2026-11-30",
  measurement_mode: "manual_reported",
  count_rule: null,
  value_kind: null,
  value_period_start: null,
  ...over,
});

beforeEach(() => {
  writes.length = 0;
  writeStatus = "written";
  goalRow = { id: "g1", objective: "Signups growth push", target_metric: "signups", target_value: 3_000, baseline_value: 1_500, measurement_mode: "manual_reported", due_date: "2026-11-30", status: "active", value_kind: null };
});
const REV = () => goalRev({ objective: "Signups growth push", target_metric: "signups", target_value: 3_000, due_date: "2026-11-30" });

describe("basisAsk", () => {
  it("asks a yes/no question with both readings named, for an ambiguous goal with a number", () => {
    const a = basisAsk(goal(), "2026-11-12", "rev-1")!;
    expect(a.topic_key).toBe("basis:g1");
    expect(a.ask).toBe('Is the 700 on "Signups growth push" this month\'s total so far, counted from 0 since Nov 1, rather than a running number that started at 1,500?');
    expect(isYesNoAsk(a.ask)).toBe(true);
    expect(a.required).toBe(true);
    expect(a.on_yes).toEqual({ kind: "goal_basis", goal_id: "g1", goal_rev: "rev-1", value_period_start: "2026-11-01", why: expect.any(String) });
  });
  it("never asks about a goal that is not ambiguous or has no number", () => {
    expect(basisAsk(goal({ value_kind: "gauge" }), "2026-11-12", "r")).toBeNull();
    expect(basisAsk(goal({ measurement_mode: "auto" }), "2026-11-12", "r")).toBeNull();
    expect(basisAsk(goal({ current_value: null }), "2026-11-12", "r")).toBeNull();
    expect(basisAsk(goal({ baseline_value: null }), "2026-11-12", "r")).toBeNull();
  });
  it("never asks when a yes could not be stored (a spend goal)", () => {
    expect(basisAsk(goal({ target_metric: "ad spend" }), "2026-11-12", "r")).toBeNull();
  });
  it("a goal set mid-month that runs past the month proposes the day it was set", () => {
    expect(proposedPeriodStart({ created_at: "2026-11-11T00:00:00Z", due_date: "2026-12-31", current_value_at: "2026-11-20T00:00:00Z" }, "2026-11-21")).toBe("2026-11-11");
    expect(basisAsk(goal({ created_at: "2026-11-11T00:00:00Z", due_date: "2026-12-31" }), "2026-11-21", "r")!.ask).toContain("the total since Nov 11");
  });
});

describe("applyGoalBasis", () => {
  const onYes = () => ({ kind: "goal_basis" as const, goal_id: "g1", goal_rev: REV(), value_period_start: "2026-11-01", why: "x" });
  it("yes stores a period total from the asked day, guarded on nothing said yet and the same metric", async () => {
    const r = await applyGoalBasis("t1", onYes(), "yes", { source: "founder", user_id: "u1" }, NOW);
    expect(writes[0]).toMatchObject({
      op: "update",
      goal_id: "g1",
      values: { value_kind: "period_total", value_period_start: "2026-11-01", updated_at: NOW.toISOString() },
      expect: { status: "active", value_kind: null, objective: "Signups growth push", target_metric: "signups", target_value: 3_000, due_date: "2026-11-30" },
    });
    expect(r).toEqual({ line: 'Goal "Signups growth push": counting its number as the total since Nov 1, so its pace runs from 0 to 3,000.', applied_at: NOW.toISOString() });
  });
  it("no stores a running number", async () => {
    const r = await applyGoalBasis("t1", onYes(), "no", { source: "founder", user_id: "u1" }, NOW);
    expect(writes[0]).toMatchObject({ values: { value_kind: "gauge", value_period_start: null } });
    expect(r!.line).toContain("running number from 1,500");
  });
  it("an answer to an older version of the goal (metric, target or date changed since) stores nothing", async () => {
    goalRow = { ...goalRow!, target_metric: "bookings" };
    expect(await applyGoalBasis("t1", onYes(), "yes", { source: "founder", user_id: "u1" }, NOW)).toBeNull();
    expect(writes).toHaveLength(0);
  });
  it("an answer already undone is never stored again", async () => {
    expect(await applyGoalBasis("t1", { ...onYes(), undone_at: "2026-11-12T11:00:00Z" }, "yes", { source: "founder", user_id: "u1" }, NOW)).toBeNull();
    expect(writes).toHaveLength(0);
  });
  it("changes nothing when the goal already says how it counts, is not active, or cannot be a period total", async () => {
    goalRow = { ...goalRow!, value_kind: "gauge" };
    expect(await applyGoalBasis("t1", onYes(), "yes", { source: "founder", user_id: "u1" })).toBeNull();
    goalRow = { ...goalRow!, value_kind: null, status: "paused" };
    expect(await applyGoalBasis("t1", onYes(), "yes", { source: "founder", user_id: "u1" })).toBeNull();
    goalRow = { ...goalRow!, status: "active", target_metric: "ad spend" };
    expect(await applyGoalBasis("t1", { ...onYes(), goal_rev: "" }, "yes", { source: "founder", user_id: "u1" })).toBeNull();
    expect(writes).toHaveLength(0);
  });
  it("a write that lost the race (the founder set it on the goal meanwhile) says nothing changed", async () => {
    writeStatus = "not_matched";
    expect(await applyGoalBasis("t1", onYes(), "yes", { source: "founder", user_id: "u1" })).toBeNull();
  });
  it("undo clears only the write that answer made (same kind, same start, no change since)", async () => {
    expect(await undoGoalBasis("t1", { ...onYes(), applied_at: NOW.toISOString() }, "yes")).toContain("back to not saying");
    expect(writes[0]).toMatchObject({
      values: { value_kind: null, value_period_start: null },
      expect: { value_kind: "period_total", value_period_start: "2026-11-01", updated_at: NOW.toISOString() },
    });
    writes.length = 0;
    expect(await undoGoalBasis("t1", { ...onYes(), applied_at: NOW.toISOString() }, "no")).toContain("back");
    expect(writes[0]).toMatchObject({ expect: { value_kind: "gauge", value_period_start: null, updated_at: NOW.toISOString() } });
  });
  it("undo of an answer with no stored write, or one already undone, changes nothing", async () => {
    expect(await undoGoalBasis("t1", onYes(), "yes")).toBeNull();
    expect(await undoGoalBasis("t1", { ...onYes(), applied_at: NOW.toISOString(), undone_at: NOW.toISOString() }, "yes")).toBeNull();
    expect(writes).toHaveLength(0);
  });
});
