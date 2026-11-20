import { describe, expect, it } from "vitest";
import { snapshotWindow, spanDays } from "@/services/agents/dashboards/snapshot-window";
import { shapePinterestAnalytics } from "../pinterest-organic";

const now = Date.parse("2026-11-18T10:00:00Z");

describe("snapshotWindow", () => {
  it("the default window is open-ended and marked as the default", () => {
    expect(snapshotWindow({ rangeDays: null, customRange: null }, 30, now)).toEqual({ since: "2026-10-19", until: null, isDefault: true, period: { from: "2026-10-19", to: "2026-11-18" } });
  });

  it("a shorter preset is its own window", () => {
    const w = snapshotWindow({ rangeDays: 7, customRange: null }, 30, now);
    expect(w).toMatchObject({ since: "2026-11-11", until: null, isDefault: false });
  });

  it("a custom range wins over the preset and is closed at its end date", () => {
    const w = snapshotWindow({ rangeDays: 7, customRange: { since: "2026-11-03", until: "2026-11-10" } }, 30, now);
    expect(w).toEqual({ since: "2026-11-03", until: "2026-11-10", isDefault: false, period: { from: "2026-11-03", to: "2026-11-10" } });
    expect(spanDays({ since: "2026-11-03", until: "2026-11-10" })).toBe(8);
  });
});

describe("Pinterest custom window", () => {
  const day = (n: number) => new Date(Date.parse("2026-10-01T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);
  const daily = Array.from({ length: 48 }, (_, i) => ({ date: day(i), impressions: 10, engagements: 2, clicks: 1, saves: 1 }));
  const rows = [
    { captured_on: "2026-11-02", username: "u", followers_count: 100, post_count: 1 },
    { captured_on: "2026-11-10", username: "u", followers_count: 130, post_count: 1 },
    { captured_on: "2026-11-17", username: "u", followers_count: 140, post_count: 1, metrics: { daily, pins: {} } },
  ] as Parameters<typeof shapePinterestAnalytics>[0];

  it("sums only the days picked and compares with the same number of days before", () => {
    const w = shapePinterestAnalytics(rows, { since: "2026-11-03", until: "2026-11-10" }).windows.custom;
    expect(w).toMatchObject({ days: 8, views: 80, clicks: 8, saves: 8, new_followers: 30, top: [], formats: [] });
    expect(w?.prev).toMatchObject({ views: 80 });
  });

  it("a range that starts before the stored history has no numbers, not a partial sum", () => {
    expect(shapePinterestAnalytics(rows, { since: "2026-09-20", until: "2026-10-05" }).windows.custom).toBeNull();
  });

  it("presets are unchanged and no custom window is added when none was picked", () => {
    const windows = shapePinterestAnalytics(rows).windows;
    expect(Object.keys(windows).sort()).toEqual(["14", "30", "7"]);
    expect(windows["7"]).toMatchObject({ days: 7, views: 70 });
  });
});
