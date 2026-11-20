
import { describe, it, expect } from "vitest";
import type { MetricSnapshotRow } from "@/services/analytics/record-metric-snapshot";
import {
  buildGoalTrendLine,
  buildTrendLines,
  changePhrase,
  fetchGoalTrendLines,
  fetchTrendHistories,
  metricKeyForGoalMetric,
  selectWoWPair,
} from "../digest-trends";
import { renderGoalsBlock } from "../goal-reconcile";

const T0 = Date.parse("2026-07-04T13:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const row = (daysAgo: number, value: number | null, over: Partial<MetricSnapshotRow> = {}): MetricSnapshotRow => ({
  id: "row-id",
  tenant_id: "t-1",
  metric_key: "weekly_signups",
  window_start: null,
  meta: {},
  created_at: new Date(0).toISOString(),
  value,
  status: "measured",
  window_kind: "rolling_7d",
  window_end: new Date(T0 - daysAgo * DAY).toISOString(),
  source: "operator_db",
  ...over,
});

describe("selectWoWPair — week-over-week comparison rule", () => {
  it("picks the row nearest to 7 days before the latest", () => {
    const rows = [row(0, 338), row(3, 320), row(7, 312), row(12, 290)];
    const pair = selectWoWPair(rows);
    expect(pair).not.toBeNull();
    expect(pair!.latest.value).toBe(338);
    expect(pair!.baseline.value).toBe(312);
    expect(pair!.pct).toBe(8);
  });

  it("sparse history: a 10-day-old row still qualifies as 'a week earlier'", () => {
    const pair = selectWoWPair([row(0, 100), row(10, 80)]);
    expect(pair).not.toBeNull();
    expect(pair!.baseline.value).toBe(80);
    expect(pair!.pct).toBe(25);
  });

  it("NEVER compares near-overlapping rolling windows (gap < 4d → no pair)", () => {
    expect(selectWoWPair([row(0, 100), row(1, 99)])).toBeNull();
    expect(selectWoWPair([row(0, 100), row(3, 90)])).toBeNull();
  });

  it("rejects stale baselines (gap > 14d → no pair)", () => {
    expect(selectWoWPair([row(0, 100), row(20, 50)])).toBeNull();
  });

  it("never crosses window_kind (a weekly row is not a baseline for a rolling row)", () => {
    const pair = selectWoWPair([row(0, 100), row(7, 80, { window_kind: "calendar_week" })]);
    expect(pair).toBeNull();
  });

  it("ignores unavailable rows entirely — no 'down 100%' from a dead source", () => {
    const pair = selectWoWPair([row(0, 100), row(7, 0, { status: "unavailable" }), row(8, 90)]);
    expect(pair).not.toBeNull();
    expect(pair!.baseline.value).toBe(90);
  });

  it("<2 comparable rows → null", () => {
    expect(selectWoWPair([])).toBeNull();
    expect(selectWoWPair([row(0, 100)])).toBeNull();
    expect(selectWoWPair([row(0, 100), row(7, null)])).toBeNull();
  });

  it("baseline of 0 → pct null (no divide-by-zero, no invented percent)", () => {
    const pair = selectWoWPair([row(0, 5), row(7, 0)]);
    expect(pair).not.toBeNull();
    expect(pair!.pct).toBeNull();
  });
});

describe("changePhrase — direction-aware framing", () => {
  it.each([
    ["up", 8, "(+8%)"],
    ["up", -12, "(⚠ down 12%)"],
    ["down", -12, "(down 12%, improving)"],
    ["down", 12, "(⚠ up 12%)"],
    ["context", 8, "(+8%)"],
    ["context", -8, "(-8%)"],
    ["up", 0, "(no change)"],
  ] as const)("direction=%s pct=%s → %s", (direction, pct, expected) => {
    expect(changePhrase(direction, pct)).toBe(expected);
  });

  it("context metrics carry NO good/bad framing", () => {
    expect(changePhrase("context", -40)).not.toContain("⚠");
    expect(changePhrase("context", -40)).not.toContain("improving");
  });
});

describe("buildTrendLines — the digest Trends section", () => {
  it("renders the canonical line shape, provenance-labeled [observed]", () => {
    const lines = buildTrendLines({
      histories: { weekly_signups: [row(0, 338), row(7, 312)] },
    });
    expect(lines).toEqual(["Signups (7d): 338 vs 312 a week earlier (+8%) [observed]"]);
  });

  it("up-metric drop is flagged", () => {
    const lines = buildTrendLines({
      histories: { weekly_bookings: [row(0, 44), row(7, 50)] },
    });
    expect(lines).toEqual(["Bookings (7d): 44 vs 50 a week earlier (⚠ down 12%) [observed]"]);
  });

  it("down-metric (CPA) drop reads as improving, with usd formatting", () => {
    const lines = buildTrendLines({
      histories: { ads_cpa_7d: [row(0, 44), row(7, 50)] },
    });
    expect(lines).toEqual(["Ad CPA (7d): $44 vs $50 a week earlier (down 12%, improving) [observed]"]);
  });

  it("context metric (spend) gets a neutral phrase — no ⚠, no 'improving'", () => {
    const up = buildTrendLines({ histories: { ads_spend_7d: [row(0, 600), row(7, 500)] } });
    const down = buildTrendLines({ histories: { ads_spend_7d: [row(0, 400), row(7, 500)] } });
    expect(up).toEqual(["Ad spend (7d): $600 vs $500 a week earlier (+20%) [observed]"]);
    expect(down).toEqual(["Ad spend (7d): $400 vs $500 a week earlier (-20%) [observed]"]);
    for (const l of [...up, ...down]) {
      expect(l).not.toContain("⚠");
      expect(l).not.toContain("improving");
    }
  });

  it("unavailable latest reading → 'no reading (…)', never a trend, never 'down 100%'", () => {
    const lines = buildTrendLines({
      histories: {
        stripe_mrr: [
          row(0, 0, { status: "unavailable", source: "stripe", window_kind: "point" }),
          row(7, 900, { window_kind: "point" }),
          row(14, 850, { window_kind: "point" }),
        ],
      },
    });
    expect(lines).toEqual(["MRR (now): no reading (stripe unavailable) [observed]"]);
    expect(lines.join("\n")).not.toContain("100%");
  });

  it("<2 comparable rows → the metric is omitted (no fake trend)", () => {
    expect(buildTrendLines({ histories: { weekly_signups: [row(0, 338)] } })).toEqual([]);
    expect(buildTrendLines({ histories: { weekly_signups: [row(0, 338), row(1, 335)] } })).toEqual([]);
  });

  it("no histories at all → [] (callers omit the whole section)", () => {
    expect(buildTrendLines({ histories: {} })).toEqual([]);
  });

  it("renders metrics in registry order, independent metrics independently", () => {
    const lines = buildTrendLines({
      histories: {
        ads_cpa_7d: [row(0, 44), row(7, 50)],
        weekly_signups: [row(0, 338), row(7, 312)],
      },
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Signups");
    expect(lines[1]).toContain("Ad CPA");
  });
});

describe("buildGoalTrendLine + metricKeyForGoalMetric — planner context", () => {
  it("maps founder-shaped goal metrics onto warehouse keys", () => {
    expect(metricKeyForGoalMetric("signups")).toBe("weekly_signups");
    expect(metricKeyForGoalMetric("Weekly_Signups")).toBe("weekly_signups");
    expect(metricKeyForGoalMetric("mrr")).toBe("stripe_mrr");
    expect(metricKeyForGoalMetric("nps")).toBeNull();
  });

  it("renders the one-line trend for a mapped metric", () => {
    const line = buildGoalTrendLine("weekly_signups", [row(0, 338), row(7, 312)]);
    expect(line).toBe("trend: 338 now, 312 a week ago (+8%)");
  });

  it("returns null when no clean week-over-week pair exists", () => {
    expect(buildGoalTrendLine("weekly_signups", [row(0, 338)])).toBeNull();
    expect(buildGoalTrendLine("not_a_metric", [row(0, 338), row(7, 312)])).toBeNull();
  });
});

describe("renderGoalsBlock — goal trend line (S4)", () => {
  const goal = {
    id: "g-1",
    objective: "Hit 400 weekly signups",
    target_metric: "weekly_signups",
    target_value: 400,
    baseline_value: 300,
    current_value: 338,
    due_date: null,
    priority: 80,
  };

  it("appends the trend line under the goal when provided", () => {
    const block = renderGoalsBlock([goal], [], {
      "g-1": "trend: 338 now, 312 a week ago (+8%)",
    });
    expect(block).toContain("  - goal_id: `g-1`\n  - trend: 338 now, 312 a week ago (+8%)");
  });

  it("renders byte-identical to the pre-S4 output when no trends exist", () => {
    expect(renderGoalsBlock([goal], [], {})).toBe(renderGoalsBlock([goal]));
    expect(renderGoalsBlock([goal])).not.toContain("trend:");
  });
});

describe("fetch helpers against the INERT contract stub (feature-detect degrade)", () => {
  it("fetchTrendHistories → {} while the data layer is a stub", async () => {
    expect(await fetchTrendHistories("tenant-1")).toEqual({});
  });

  it("fetchGoalTrendLines → {} while the data layer is a stub", async () => {
    const out = await fetchGoalTrendLines("tenant-1", [
      { id: "g-1", target_metric: "weekly_signups" },
    ]);
    expect(out).toEqual({});
  });
});
