
import { describe, it, expect, vi } from "vitest";

import {
  isTrendOffTrack,
  evaluateTrendForGoal,
  formatTrendNote,
  snapshotsToPoints,
  TREND_WINDOW_KIND,
  TREND_HISTORY_LIMIT,
  type TrendDeps,
} from "../trend-off-track";
import { MIN_PRIOR_POINTS } from "@/services/analytics/anomaly";
import type { MetricSnapshotRow } from "@/services/analytics/record-metric-snapshot";

const NOW_MS = Date.parse("2026-07-04T12:00:00Z");
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function row(
  agoMs: number,
  value: number,
  window_kind: MetricSnapshotRow["window_kind"] = TREND_WINDOW_KIND as MetricSnapshotRow["window_kind"],
): MetricSnapshotRow {
  return {
    id: "row-id",
    tenant_id: "t-1",
    window_start: null,
    meta: {},
    created_at: new Date(0).toISOString(),
    metric_key: "weekly_signups",
    window_kind,
    value,
    status: "measured",
    source: "operator_db",
    window_end: new Date(NOW_MS - agoMs).toISOString(),
  };
}

function history(latest: number, days = 56): MetricSnapshotRow[] {
  const rows = [row(0, latest)];
  for (let d = 1; d <= days; d++) rows.push(row(d * DAY_MS, 100 + ((d * 5) % 7) - 3));
  return rows;
}

const UP = { direction: "up" as const, unit: "count" as const };
const DOWN = { direction: "down" as const, unit: "usd" as const };
const CONTEXT = { direction: "context" as const, unit: "usd" as const };

describe("isTrendOffTrack: the anomaly gate over snapshots", () => {
  it("up-metric far below its 8 weeks → off_track anomaly_drop with signed pct", () => {
    const v = isTrendOffTrack(history(60), UP);
    expect(v.off_track).toBe(true);
    if (!v.off_track) return;
    expect(v.reason).toBe("anomaly_drop");
    expect(v.pct).toBeLessThan(-35);
    expect(v.z).toBeLessThanOrEqual(-2);
  });

  it("down-metric (CPA) far above its 8 weeks → off_track anomaly_rise", () => {
    const v = isTrendOffTrack(history(140), DOWN);
    expect(v).toMatchObject({ off_track: true, reason: "anomaly_rise" });
  });

  it("the old 20% rule no longer decides: a 25% drop inside the normal range is not off-track", () => {
    const rows = [row(0, 75)];
    for (let d = 1; d <= 56; d++) rows.push(row(d * DAY_MS, d % 2 ? 70 : 130));
    expect(isTrendOffTrack(rows, UP)).toEqual({ off_track: false, reason: "within_threshold" });
  });

  it("a move the GOOD way is never off-track", () => {
    expect(isTrendOffTrack(history(160), UP)).toEqual({ off_track: false, reason: "good_direction" });
    expect(isTrendOffTrack(history(40), DOWN)).toEqual({ off_track: false, reason: "good_direction" });
  });

  it("context metrics never go off-track, whatever the move", () => {
    expect(isTrendOffTrack(history(1), CONTEXT)).toEqual({ off_track: false, reason: "context_metric" });
  });

  it(`fewer than ${MIN_PRIOR_POINTS} prior days → insufficient_history (the old 2-row WoW would have fired)`, () => {
    expect(isTrendOffTrack([], UP)).toEqual({ off_track: false, reason: "insufficient_history" });
    expect(isTrendOffTrack([row(0, 75), row(7 * DAY_MS, 100)], UP)).toEqual({ off_track: false, reason: "insufficient_history" });
    expect(isTrendOffTrack(history(10, MIN_PRIOR_POINTS - 1), UP)).toEqual({ off_track: false, reason: "insufficient_history" });
    expect(isTrendOffTrack(history(10, MIN_PRIOR_POINTS), UP).off_track).toBe(true);
  });

  it("rows of a different window_kind than the latest are never compared", () => {
    const rows = [row(0, 10), ...history(10).slice(1).map((r) => ({ ...r, window_kind: "calendar_week" as const }))];
    expect(isTrendOffTrack(rows, UP)).toEqual({ off_track: false, reason: "insufficient_history" });
  });

  it("orders newest-first itself and keeps one point per local day (the latest)", () => {
    const shuffled = [...history(60)].reverse();
    expect(isTrendOffTrack(shuffled, UP).off_track).toBe(true);
    const twice = [row(10 * HOUR_MS, 100), row(1 * HOUR_MS, 60), ...history(60).slice(1)];
    const pts = snapshotsToPoints(twice);
    expect(pts.filter((p) => p.date === "2026-07-04")).toEqual([{ date: "2026-07-04", value: 60 }]);
  });

  it("day boundaries follow the tenant time zone", () => {
    const r = { ...row(0, 1), window_end: "2026-07-04T02:00:00.000Z" };
    expect(snapshotsToPoints([r], "America/Los_Angeles")[0].date).toBe("2026-07-03");
    expect(snapshotsToPoints([r], "UTC")[0].date).toBe("2026-07-04");
  });
});

describe("formatTrendNote", () => {
  it("says the signed % against the 8-week average", () => {
    expect(formatTrendNote({ off_track: true, reason: "anomaly_drop", pct: -23.4, z: -2.5 })).toBe("trend -23% vs its 8-week average");
    expect(formatTrendNote({ off_track: true, reason: "anomaly_rise", pct: 31.2, z: 3 })).toBe("trend +31% vs its 8-week average");
  });
});

describe("evaluateTrendForGoal: injectable seam", () => {
  function deps(over: Partial<TrendDeps> = {}): TrendDeps {
    return {
      classifyGoalMetricKey: () => "weekly_signups",
      getMetricDef: () => ({ key: "weekly_signups", direction: "up" as const, label: "x", unit: "count" as const, window_kind: "rolling_7d" as const, source: "operator_db" as const }),
      readMetricHistory: async () => history(60),
      resolveTimezone: async () => "UTC",
      ...over,
    };
  }

  it("mapped up-metric with a real drop → off_track (reads 8 weeks of the trend window kind)", async () => {
    const readSpy = vi.fn(async () => history(60));
    const tzSpy = vi.fn(async () => "America/New_York");
    const v = await evaluateTrendForGoal("t-1", "signups", deps({ readMetricHistory: readSpy, resolveTimezone: tzSpy }));
    expect(v).toMatchObject({ off_track: true, reason: "anomaly_drop" });
    expect(readSpy).toHaveBeenCalledWith("t-1", "weekly_signups", {
      window_kind: TREND_WINDOW_KIND,
      limit: TREND_HISTORY_LIMIT,
    });
    expect(tzSpy).toHaveBeenCalledWith("t-1");
    expect(TREND_HISTORY_LIMIT).toBeGreaterThanOrEqual(2 * 57);
  });

  it("unmapped metric → false verdict, history is NEVER read", async () => {
    const readSpy = vi.fn(async () => [] as MetricSnapshotRow[]);
    const v = await evaluateTrendForGoal("t-1", "vibes", deps({ classifyGoalMetricKey: () => null, readMetricHistory: readSpy }));
    expect(v).toEqual({ off_track: false, reason: "unmapped_metric" });
    expect(readSpy).not.toHaveBeenCalled();
  });

  it("context metric → false verdict, history is NEVER read", async () => {
    const readSpy = vi.fn(async () => [] as MetricSnapshotRow[]);
    const v = await evaluateTrendForGoal(
      "t-1",
      "site visits",
      deps({
        getMetricDef: () => ({ key: "site_visits", direction: "context" as const, label: "x", unit: "count" as const, window_kind: "rolling_7d" as const, source: "operator_db" as const }),
        readMetricHistory: readSpy,
      }),
    );
    expect(v).toEqual({ off_track: false, reason: "context_metric" });
    expect(readSpy).not.toHaveBeenCalled();
  });

  it("empty history (stub data layer) → insufficient_history, never off-track", async () => {
    const v = await evaluateTrendForGoal("t-1", "signups", deps({ readMetricHistory: async () => [] }));
    expect(v).toEqual({ off_track: false, reason: "insufficient_history" });
  });

  it("a throwing warehouse read is swallowed into a false verdict", async () => {
    const v = await evaluateTrendForGoal(
      "t-1",
      "signups",
      deps({
        readMetricHistory: async () => {
          throw new Error("warehouse down");
        },
      }),
    );
    expect(v).toEqual({ off_track: false, reason: "trend_eval_failed" });
  });

  it("a failed time zone lookup falls back to UTC, not a failure", async () => {
    const v = await evaluateTrendForGoal("t-1", "signups", deps({ resolveTimezone: async () => Promise.reject(new Error("x")) }));
    expect(v.off_track).toBe(true);
  });
});
