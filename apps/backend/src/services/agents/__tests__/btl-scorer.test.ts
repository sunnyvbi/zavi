
import { describe, it, expect } from "vitest";
// @ts-ignore — .mjs sibling harness, no type decls (pure JS, intentional).
import { AXES, CLEAN_REQUIRED_AXES, scoreBuild, compareScores, aggregateSuite, DEFAULT_TIME_TO_PREVIEW_BUDGET_S } from "../../../../scripts/btl/scorer.mjs";

const PERFECT = {
  live_deploy: true,
  time_to_preview: 60,
  showability: true,
  auth_correct: true,
  data_correct: true,
  mobile: true,
  screenshot: true,
};

describe("btl/scorer — axes + weights", () => {
  it("weights sum to exactly 100", () => {
    const sum = (AXES as Array<{ weight: number }>).reduce((s, a) => s + a.weight, 0);
    expect(sum).toBe(100);
  });

  it("a perfect build scores 100 and is clean", () => {
    const sc = scoreBuild(PERFECT);
    expect(sc.score).toBe(100);
    expect(sc.maxScore).toBe(100);
    expect(sc.clean).toBe(true);
    expect(sc.cleanBlockers).toEqual([]);
    expect(sc.failedAxes).toEqual([]);
  });

  it("an empty observation object fails every axis (conservative — no false-live)", () => {
    const sc = scoreBuild({});
    expect(sc.score).toBe(0);
    expect(sc.clean).toBe(false);
    expect(sc.passedAxes).toEqual([]);
    expect([...sc.cleanBlockers].sort()).toEqual([...CLEAN_REQUIRED_AXES].sort());
  });
});

describe("btl/scorer — per-axis semantics", () => {
  it("missing/null/non-boolean axis is a FAIL, not a pass", () => {
    const sc = scoreBuild({ ...PERFECT, live_deploy: undefined, auth_correct: "yes" as unknown });
    expect(sc.axes.live_deploy.pass).toBe(false);
    expect(sc.axes.auth_correct.pass).toBe(false);
    expect(sc.score).toBe(58);
    expect(sc.clean).toBe(false);
    expect([...sc.cleanBlockers].sort()).toEqual(["auth_correct", "live_deploy"]);
  });

  it("accepts the {pass:boolean} object form", () => {
    const sc = scoreBuild({ ...PERFECT, showability: { pass: false } });
    expect(sc.axes.showability.pass).toBe(false);
    expect(sc.score).toBe(80);
  });

  it("time_to_preview passes within budget, fails past it, fails on non-positive", () => {
    expect(scoreBuild({ time_to_preview: DEFAULT_TIME_TO_PREVIEW_BUDGET_S }).axes.time_to_preview.pass).toBe(true);
    expect(scoreBuild({ time_to_preview: DEFAULT_TIME_TO_PREVIEW_BUDGET_S + 1 }).axes.time_to_preview.pass).toBe(false);
    expect(scoreBuild({ time_to_preview: 0 }).axes.time_to_preview.pass).toBe(false);
    expect(scoreBuild({ time_to_preview: -5 }).axes.time_to_preview.pass).toBe(false);
    expect(scoreBuild({ time_to_preview: 120 }, { timeToPreviewBudgetS: 60 }).axes.time_to_preview.pass).toBe(false);
  });

  it("clean ignores non-required axes (slow + no screenshot is still clean)", () => {
    const sc = scoreBuild({ ...PERFECT, time_to_preview: 99999, screenshot: false });
    expect(sc.clean).toBe(true);
    expect(sc.score).toBe(100 - 10 - 5);
    expect(sc.cleanBlockers).toEqual([]);
  });
});

describe("btl/scorer — compareScores honesty", () => {
  it("refuses a comparative verdict when no competitor baseline exists", () => {
    const zavi = scoreBuild(PERFECT);
    const cmp = compareScores(zavi, null);
    expect(cmp.verdict).toBe("no_competitor_baseline");
    expect(cmp.competitorScore).toBeNull();
    expect(cmp.perAxis).toBeNull();
  });

  it("reports zavi_ahead / competitor_ahead / tie correctly", () => {
    const zavi = scoreBuild(PERFECT);
    const weaker = scoreBuild({ ...PERFECT, data_correct: false });
    expect(compareScores(zavi, weaker).verdict).toBe("zavi_ahead");
    expect(compareScores(weaker, zavi).verdict).toBe("competitor_ahead");
    expect(compareScores(zavi, scoreBuild(PERFECT)).verdict).toBe("tie");
    const ahead = compareScores(zavi, weaker);
    expect(ahead.perAxis.data_correct).toBe("zavi");
    expect(ahead.perAxis.live_deploy).toBe("tie");
  });
});

describe("btl/scorer — aggregateSuite", () => {
  it("aggregates clean rate + per-axis pass rate over a suite", () => {
    const cards = [scoreBuild(PERFECT), scoreBuild({ ...PERFECT, mobile: false }), scoreBuild({})];
    const agg = aggregateSuite(cards);
    expect(agg.n).toBe(3);
    expect(agg.cleanCount).toBe(1);
    expect(agg.perAxisPassRate.live_deploy).toBeCloseTo(2 / 3, 5);
    expect(agg.perAxisPassRate.mobile).toBeCloseTo(1 / 3, 5);
  });

  it("handles an empty suite without dividing by zero", () => {
    const agg = aggregateSuite([]);
    expect(agg.n).toBe(0);
    expect(agg.avgScore).toBe(0);
    expect(agg.cleanRate).toBe(0);
  });
});
