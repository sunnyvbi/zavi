import { describe, expect, it } from "vitest";
import { shapePinterest, shapePinterestAnalytics } from "../pinterest-organic";

const row = (captured_on: string, followers_count: number, totals: Record<string, number>) => ({
  captured_on,
  username: "dudhat0633",
  followers_count,
  post_count: 40,
  metrics: { account_totals: totals, account_error: null, window: { start_date: "2026-09-16", end_date: "2026-10-15" } },
});

describe("shapePinterest", () => {
  it("shows account growth against the previous daily capture", () => {
    const out = shapePinterest([
      row("2026-10-15", 100, { IMPRESSION: 5000, OUTBOUND_CLICK: 25, SAVE: 70 }),
      row("2026-10-16", 120, { IMPRESSION: 5400, OUTBOUND_CLICK: 31, SAVE: 88 }),
    ]);
    expect(out.metrics).toEqual([
      expect.objectContaining({ key: "followers", value: 120, prev_value: 100, prev_day: "2026-10-15" }),
      expect.objectContaining({ key: "impressions", value: 5400, prev_value: 5000, window_kind: "30d" }),
      expect.objectContaining({ key: "outbound_clicks", value: 31, prev_value: 25 }),
      expect.objectContaining({ key: "saves", value: 88, prev_value: 70 }),
    ]);
    expect(out.account).toEqual({ username: "dudhat0633", followers: 120 });
  });

  it("does not invent zeroes for unavailable Pinterest analytics", () => {
    const out = shapePinterest([{ ...row("2026-10-16", 120, {}), metrics: { account_totals: null, account_error: "business account required" } }]);
    expect(out.metrics.map((metric) => metric.key)).toEqual(["followers"]);
    expect(out.problem).toMatch(/business account/);
  });
});

describe("shapePinterestAnalytics", () => {
  const pin = (id: string, format: "image" | "video", impressions: number, engagements: number) => ({
    id, title: id, format, image: null, url: `https://www.pinterest.com/pin/${id}/`, impressions, engagements, clicks: 1, saves: 1,
  });
  const days = Array.from({ length: 60 }, (_, i) => {
    const d = new Date(Date.UTC(2026, 7, 17) + i * 86_400_000).toISOString().slice(0, 10);
    return { date: d, impressions: i < 30 ? 100 : 200, engagements: i < 30 ? 3 : 8, clicks: i < 30 ? 1 : 2, saves: 0 };
  });
  const snapshot = (captured_on: string, followers_count: number, extra: Record<string, unknown> = {}) => ({
    captured_on, username: "upcar", followers_count, post_count: 4, metrics: { account_totals: { IMPRESSION: 1 }, ...extra },
  });

  it("sums each range, compares it with the range before, and counts new followers", () => {
    const out = shapePinterestAnalytics([
      snapshot("2026-08-16", 900),
      snapshot("2026-09-15", 960),
      snapshot("2026-10-16", 1012, { daily: days, pins: { "30": [pin("a", "image", 2520, 121), pin("b", "video", 857, 47), pin("c", "video", 454, 13)] } }),
    ]);
    const w = out.windows["30"]!;
    expect(w).toMatchObject({ views: 6000, engagements: 240, clicks: 60, new_followers: 52 });
    expect(w.prev).toMatchObject({ views: 3000, engagements: 90, clicks: 30, new_followers: 60 });
    expect(w.top.map((p) => p.id)).toEqual(["b", "a", "c"]);
    expect(w.formats.map((f) => f.format)).toEqual(["image", "video"]);
    expect(out.windows["7"]).toMatchObject({ views: 1400, new_followers: null, prev: { views: 1400 } });
    expect(out.as_of).toBe("2026-10-16");
  });

  it("falls back to the stored 30-day totals before the daily read exists", () => {
    const out = shapePinterestAnalytics([snapshot("2026-10-16", 10, { account_totals: { IMPRESSION: 5400, OUTBOUND_CLICK: 31 } })]);
    expect(out.windows["30"]).toMatchObject({ views: 5400, engagements: null, clicks: 31, prev: null, top: [] });
    expect(out.windows["7"]).toBeNull();
  });
});

describe("shapePinterestAnalytics when the top-pins read failed", () => {
  const stored = (extra: Record<string, unknown>) => [{ captured_on: "2026-10-16", username: "upcar", followers_count: 10, post_count: 1, metrics: { account_totals: { IMPRESSION: 5 }, ...extra } }];

  it("says the read failed for a window with no pins", () => {
    const out = shapePinterestAnalytics(stored({ pins: null, pins_error: "timeout" }));
    expect(out.windows["30"]).toMatchObject({ pins_failed: true, top: [] });
  });

  it("does not claim a failure for a window that has its pins", () => {
    const pin = { id: "a", title: "a", format: "image" as const, image: null, url: "u", impressions: 5, engagements: 1, clicks: 0, saves: 0 };
    const out = shapePinterestAnalytics(stored({ pins: { "30": [pin] }, pins_error: "timeout" }));
    expect(out.windows["30"]).toMatchObject({ pins_failed: false });
  });
});
