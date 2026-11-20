import { describe, it, expect, vi } from "vitest";
import { buildSnapshot, type SnapshotDeps, type StuntSnapshot } from "../snapshot";
import { realRun } from "./fixtures";

const cfg = realRun();

function deps(now: string, over: Partial<SnapshotDeps> = {}): SnapshotDeps {
  return {
    countBookings: vi.fn(async () => 10),
    countHosts: vi.fn(async () => 5),
    spendByDay: vi.fn(async () => ({ "2026-10-01": 480.004, "2026-10-02": 560 })),
    nowLine: vi.fn(async () => ({ last_review_at: "2026-10-02T11:00:00Z", changes_today: 2, channel_slugs: ["meta_ads", "meta_ads", "google_ads"] })),
    now: () => new Date(now),
    ...over,
  };
}

describe("buildSnapshot", () => {
  it("dollars booked: counted per day and in the pace when the source reports them", async () => {
    const s = await buildSnapshot(cfg, deps("2026-10-02T12:00:00Z", { bookingValue: vi.fn(async () => 4000) }));
    expect(s.by_day[1]).toMatchObject({ day: "2026-10-01", booking_value_usd: 4000 });
    expect(s.pace.booking_value_per_week).toBe(1000);
  });
  it("dollars booked: an unavailable value stays null, never 0", async () => {
    const s = await buildSnapshot(cfg, deps("2026-10-02T12:00:00Z", { bookingValue: vi.fn(async () => null) }));
    expect(s.by_day[1].booking_value_usd).toBeNull();
    expect(s.pace.booking_value_per_week).toBeNull();
  });
  it("before the start: no days, pace still measured from the 4 weeks before", async () => {
    const d = deps("2026-09-29T12:00:00Z", { countBookings: vi.fn(async () => 480), countHosts: vi.fn(async () => 260) });
    const s = await buildSnapshot(cfg, d);
    expect(s.by_day).toEqual([]);
    expect(s.day).toBeLessThanOrEqual(0);
    expect(s.pace).toEqual({ bookings_per_week: 120, hosts_per_week: 65, booking_value_per_week: null });
  });
  it("on day 2 counts each Pacific day and keys spend by day", async () => {
    const s = await buildSnapshot(cfg, deps("2026-10-02T12:00:00Z"));
    expect(s.by_day.map((d) => d.day)).toEqual(["2026-09-30", "2026-10-01", "2026-10-02"]);
    expect(s.by_day[1]).toEqual({ day: "2026-10-01", bookings: 10, hosts: 5, spent_usd: 480, booking_value_usd: null });
    expect(s.channels_today).toEqual(["Meta", "Google"]);
    expect(s.changes_today).toBe(2);
  });
  it("spend before the stunt's first date (the 30 Sep evening slice) is not counted", async () => {
    const d = deps("2026-10-02T12:00:00Z", { spendByDay: vi.fn(async () => ({ "2026-09-30": 999, "2026-10-01": 480 })) });
    const s = await buildSnapshot(cfg, d);
    expect(s.by_day[0]).toMatchObject({ day: "2026-09-30", spent_usd: 0 });
    expect(d.spendByDay).toHaveBeenCalledWith("2026-10-01", "2026-10-30");
  });
  it("an unavailable host count stays null, never 0", async () => {
    const s = await buildSnapshot(cfg, deps("2026-10-02T12:00:00Z", { countHosts: vi.fn(async () => null) }));
    expect(s.by_day.every((d) => d.hosts === null)).toBe(true);
    expect(s.pace.hosts_per_week).toBeNull();
  });
  it("reuses older booking days and a known pace; recounts hosts for every day", async () => {
    const previous: StuntSnapshot = {
      taken_at: "x", day: 5, pace: { bookings_per_week: 100, hosts_per_week: 50 }, last_review_at: null, changes_today: 0, channels_today: [],
      by_day: ["2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03"].map((day) => ({ day, bookings: 99, hosts: 9, spent_usd: 0 })),
    };
    const d = deps("2026-10-05T12:00:00Z");
    const s = await buildSnapshot(cfg, d, previous);
    expect(s.by_day.slice(0, 4).every((x) => x.bookings === 99)).toBe(true);
    expect(d.countBookings).toHaveBeenCalledTimes(2);
    expect(d.countHosts).toHaveBeenCalledTimes(s.by_day.length);
    expect(s.by_day[0].hosts).toBe(5);
    expect(s.pace).toEqual({ bookings_per_week: 100, hosts_per_week: 50 });
  });
});
