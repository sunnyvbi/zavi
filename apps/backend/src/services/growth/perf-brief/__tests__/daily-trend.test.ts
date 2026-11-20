import { describe, it, expect } from "vitest";
import { buildDailyTrend, MATURING_DAYS } from "../daily-trend";
import type { MetaDailyRow } from "@/services/tools/meta-ads/daily_series";
import type { GoogleDailyRow } from "@/services/tools/google-ads/daily_series";

function meta(partial: Partial<MetaDailyRow> & { date: string }): MetaDailyRow {
  return {
    campaign_id: "c1",
    campaign_name: "C1",
    ad_set_id: null,
    ad_set_name: null,
    spend_usd: 0,
    impressions: 0,
    clicks: 0,
    ctr_percent: 0,
    cpm_usd: 0,
    conversions: 0,
    purchases: 0,
    sign_ups: 0,
    leads: 0,
    purchase_value_usd: 0,
    ...partial,
  };
}
function google(partial: Partial<GoogleDailyRow> & { date: string }): GoogleDailyRow {
  return {
    campaign_id: "g1",
    campaign_name: "G1",
    spend_usd: 0,
    impressions: 0,
    clicks: 0,
    conversions: 0,
    conversions_value_usd: 0,
    ...partial,
  };
}

describe("buildDailyTrend", () => {
  it("merges Meta + Google on the same date, summing raw components", () => {
    const points = buildDailyTrend(
      [meta({ date: "2026-06-01", spend_usd: 100, purchases: 2, purchase_value_usd: 300 })],
      [google({ date: "2026-06-01", spend_usd: 50, conversions: 1, conversions_value_usd: 150 })],
    );
    expect(points).toHaveLength(1);
    const p = points[0];
    expect(p.spend_usd).toBe(150);
    expect(p.bookings).toBe(3);
    expect(p.revenue_usd).toBe(450);
    expect(p.roas).toBe(3);
  });

  it("recomputes CTR/CPC from SUMS, never averages per-row ratios", () => {
    const points = buildDailyTrend(
      [
        meta({ date: "2026-06-02", spend_usd: 10, impressions: 100, clicks: 10 }),
        meta({ date: "2026-06-02", spend_usd: 40, impressions: 1000, clicks: 10 }),
      ],
      [],
    );
    expect(points).toHaveLength(1);
    expect(points[0].ctr_percent).toBe(1.82);
    expect(points[0].cpc_usd).toBe(2.5);
  });

  it("nulls ratio metrics when the denominator is zero", () => {
    const points = buildDailyTrend([meta({ date: "2026-06-03" })], []);
    const p = points[0];
    expect(p.roas).toBeNull();
    expect(p.ctr_percent).toBeNull();
    expect(p.cpc_usd).toBeNull();
    expect(p.cost_per_booking_usd).toBeNull();
  });

  it("flags maturing relative to nowIso (last 3 calendar days of a recent window)", () => {
    const rows = ["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04", "2026-06-05"].map(
      (date) => meta({ date, spend_usd: 10 }),
    );
    const points = buildDailyTrend(rows, [], { nowIso: "2026-06-05" });
    expect(points.map((p) => p.date)).toEqual([
      "2026-06-01",
      "2026-06-02",
      "2026-06-03",
      "2026-06-04",
      "2026-06-05",
    ]);
    expect(points.map((p) => p.maturing)).toEqual([false, false, true, true, true]);
    expect(MATURING_DAYS).toBe(3);
  });

  it("does NOT shade a fully-settled past window (last_month) as maturing", () => {
    const rows = ["2026-05-29", "2026-05-30", "2026-05-31"].map((date) =>
      meta({ date, spend_usd: 10 }),
    );
    const points = buildDailyTrend(rows, [], { nowIso: "2026-06-15" });
    expect(points.map((p) => p.maturing)).toEqual([false, false, false]);
  });

  it("falls back to last-N-returned when nowIso is omitted", () => {
    const rows = ["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04"].map((date) =>
      meta({ date, spend_usd: 10 }),
    );
    const points = buildDailyTrend(rows, []);
    expect(points.map((p) => p.maturing)).toEqual([false, true, true, true]);
  });

  it("returns empty for no rows", () => {
    expect(buildDailyTrend([], [])).toEqual([]);
  });
});
