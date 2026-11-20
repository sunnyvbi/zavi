import { describe, expect, it } from "vitest";
import { planGoalCards, type GoalMoves, type GoalRow } from "../goal-owner";

const G = "11111111-1111-4111-8111-111111111111";
const TODAY = "2026-10-02";
const goal = (over: Partial<GoalRow> = {}): GoalRow => ({
  id: G,
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
const agents = ["meta_ads", "google_ads", "youtube_ads", "seo", "linkedin_organic", "research"];
const plan = (g: GoalRow, moves: Array<Record<string, unknown>>, spare: number | null = null) =>
  planGoalCards({
    liveGoals: [g],
    moves: { goals: [{ goal_id: G, moves }], goal_changes: [], channel_changes: [] } as unknown as GoalMoves,
    changedGoals: new Set(),
    acts: true,
    allowed: new Set(agents),
    openKeys: new Set(),
    recentKeys: new Set(),
    repo: null,
    today: TODAY,
    spareDailyCapacityUsd: spare,
  });
const move = (target: string, extra: Record<string, unknown> = {}) => ({ target_agent_slug: target, intent: `Grow signups via ${target}`, why: "", ...extra });
const cards = (r: ReturnType<typeof plan>) => (r.needsRepo ? [] : r.goals[0].cards);

describe("moves per goal", () => {
  const four = [move("meta_ads"), move("google_ads"), move("seo"), move("linkedin_organic")];
  it("4 when the goal is behind its deadline line", () => {
    expect(cards(plan(goal(), four))).toHaveLength(4);
  });
  it("2 when on pace", () => {
    expect(cards(plan(goal({ current_value: 40 }), four))).toHaveLength(2);
  });
  it("2 when the number cannot drive pace (typed 5 days ago)", () => {
    expect(cards(plan(goal({ measurement_mode: "manual_reported", current_value_at: "2026-09-27T09:00:00Z" }), four))).toHaveLength(2);
  });
});

describe("ad moves share the spare daily capacity", () => {
  it("fits are kept with the budget in their boundaries; an overflow is refused", () => {
    const r = plan(goal(), [move("meta_ads", { daily_usd: 400 }), move("google_ads", { daily_usd: 200 }), move("youtube_ads", { daily_usd: 300 })], 666.66);
    const c = cards(r);
    expect(c.map((x) => x.target)).toEqual(["meta_ads", "google_ads"]);
    expect(c[0].body.boundaries).toMatch(/at most \$400/);
    expect(!r.needsRepo && r.refused.join(" ")).toMatch(/youtube_ads.*\$300\/day.*only \$66\/day fits/);
  });
  it("organic moves are not counted; an ad move with no amount takes what is left", () => {
    const r = plan(goal(), [move("seo", { daily_usd: 900 }), move("meta_ads"), move("google_ads", { daily_usd: 10 })], 100);
    const c = cards(r);
    expect(c.map((x) => x.target)).toEqual(["seo", "meta_ads"]);
    expect(c[0].body.boundaries).toBeUndefined();
    expect(c[1].body.boundaries).toMatch(/at most \$100\./);
    expect(!r.needsRepo && r.refused.join(" ")).toMatch(/google_ads.*\$10\/day.*only \$0\/day fits/);
  });
  it("no budget known: no split", () => {
    expect(cards(plan(goal(), [move("meta_ads", { daily_usd: 5000 })], null))).toHaveLength(1);
  });
  it("the order's spare capacity claim stays in its boundaries and never becomes the test's stop", () => {
    const test = { variable: "a new search campaign", budget_usd: 670, baseline: "0 leads", success_if: "5 leads", readout_on: "2026-10-16" };
    const c = cards(plan(goal(), [move("google_ads", { test })], 0.38));
    expect(c[0].body.boundaries).toMatch(/at most \$0\.38\./);
    expect(c[0].body.test).toMatchObject({ envelope: "server", budget_usd: 670, readout_on: "2026-10-16" });
  });
  it("the founder's boundaries are kept after the budget line", () => {
    const c = cards(plan(goal(), [move("meta_ads", { daily_usd: 50, boundaries: "No discounts." })], 100));
    expect(c[0].body.boundaries).toBe("New daily ad budget for this order, all new ad sets together: at most $50. No discounts.");
  });
});
