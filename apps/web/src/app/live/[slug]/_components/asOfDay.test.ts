import { describe, it, expect } from "vitest";
import { parseLiveUpcar } from "@/lib/marketing/liveUpcar";
import { asOfDay, parseDayParam } from "./asOfDay";

const clock = { start_at: "2026-10-01T00:00:00-04:00", unlock_at: "2026-10-01T00:00:00-04:00", end_at: "2026-10-30T23:59:00-04:00" };
const row = (day: string, spent: number, bookings = 10, hosts = 2, value = 1000) => ({ day, bookings, hosts, spent_usd: spent, booking_value_usd: value });
const entry = (day: string) => ({ day, kind: "CHANGE", headline: `Entry ${day}`, channels: [], work: [], why: null, budget: [], spent_usd: 1, bookings: 1, hosts: 1 });
const live = parseLiveUpcar({
  run: { slug: "upcar", listed: true }, locked: false, clock, budget_usd: 25000, goals: { booking_value_usd: 300000 },
  numbers: {
    spent_usd: 1500, spend_per_day_recent_usd: 400, runs_out_day: 30, bookings: 40, hosts: 8, booking_value_usd: 4000,
    pace: { bookings_per_week: 150, hosts_per_week: 84, booking_value_per_week: 53385 },
    by_day: [row("2026-09-30", 0), row("2026-10-01", 300), row("2026-10-02", 500), row("2026-10-03", 700)],
  },
  now_line: { last_review_at: "2026-10-03T14:00:00Z", changes_today: 2, channels_today: ["Meta"] },
  days: [entry("2026-10-03"), entry("2026-10-02"), entry("2026-10-01")],
})!;

const LATER = Date.parse("2026-10-11T12:00:00-04:00");

describe("?day= replay", () => {
  it("a day before the limit was raised shows the starting budget, a day after shows the new one", () => {
    const raised = { ...live, budget_usd: 28400, budget_raise: { on: "2026-10-02", start_usd: 25000 } };
    expect(asOfDay(raised, 1, LATER).data).toMatchObject({ budget_usd: 25000, budget_raise: null });
    expect(asOfDay(raised, 2, LATER).data).toMatchObject({ budget_usd: 28400, budget_raise: raised.budget_raise });
  });
  it("day 1 shows only day 1: Pacific 09-30 + 10-01, and the day-1 log entry", () => {
    const { data, nowMs } = asOfDay(live, 1, LATER);
    expect(data.numbers).toMatchObject({ spent_usd: 300, bookings: 20, hosts: 4, booking_value_usd: 2000, spend_per_day_recent_usd: 0, runs_out_day: null });
    expect(data.numbers!.by_day.map((r) => r.day)).toEqual(["2026-09-30", "2026-10-01"]);
    expect(data.days.map((e) => e.day)).toEqual(["2026-10-01"]);
    expect(data.now_line.last_review_at).toBeNull();
    expect(new Date(nowMs).toISOString()).toBe("2026-10-02T01:00:00.000Z");
  });
  it("day 2 counts days 1-2 and projects the run-out day from them", () => {
    const { data } = asOfDay(live, 2, LATER);
    expect(data.numbers).toMatchObject({ spent_usd: 800, spend_per_day_recent_usd: 150, runs_out_day: 2 + Math.ceil(24200 / 150) });
    expect(data.days.map((e) => e.day)).toEqual(["2026-10-02", "2026-10-01"]);
  });
  it("today's replay uses the real time, not 9pm, and leaves today's open day out of the rate", () => {
    const now = Date.parse("2026-10-03T10:00:00-04:00");
    const r = asOfDay(live, 3, now);
    expect(r.nowMs).toBe(now);
    expect(r.data.numbers!.spend_per_day_recent_usd).toBe(267);
  });
  it("an unavailable spend day stays unavailable, never $0", () => {
    const gap = { ...live, numbers: { ...live.numbers!, by_day: live.numbers!.by_day.map((r) => (r.day === "2026-10-01" ? { ...r, spent_usd: null } : r)) } };
    expect(asOfDay(gap, 2, LATER).data.numbers).toMatchObject({ spent_usd: null, runs_out_day: null });
  });
  it("a run that starts at 9am still counts Eastern calendar days, and 9pm is 9pm", () => {
    const c = { start_at: "2026-09-28T09:00:00-04:00", unlock_at: "2026-09-28T09:00:00-04:00", end_at: "2026-09-30T23:59:59-04:00" };
    expect(parseDayParam("2", c, Date.parse("2026-09-29T01:00:00-04:00"))).toBe(2);
    expect(parseDayParam("4", c, Date.parse("2026-10-05T12:00:00-04:00"))).toBeNull();
    expect(new Date(asOfDay({ ...live, clock: c }, 1, LATER).nowMs).toISOString()).toBe("2026-09-29T01:00:00.000Z");
  });
  it("a day whose numbers were still locked does not replay", () => {
    const c = { ...clock, unlock_at: "2026-10-03T09:00:00-04:00" };
    expect(parseDayParam("2", c, LATER)).toBeNull();
    expect(parseDayParam("3", c, LATER)).toBe(3);
  });
  it("only a reached day replays; anything else falls back to the live page", () => {
    const now = Date.parse("2026-10-11T12:00:00-04:00");
    expect(parseDayParam("1", clock, now)).toBe(1);
    expect(parseDayParam("11", clock, now)).toBe(11);
    for (const bad of [undefined, "", "0", "12", "31", "1.5", "-1", "abc"]) expect(parseDayParam(bad, clock, now)).toBeNull();
  });
});
