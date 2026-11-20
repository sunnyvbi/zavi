import { describe, it, expect } from "vitest";
import { parseLiveUpcar, type LiveUpcar } from "@/lib/marketing/liveUpcar";
import { dayDates, daysWithFigures, parseDayNumber, publishedDay, publishedDayNumbers, runDayCount } from "./publishedDay";

const clock = { start_at: "2026-10-01T00:00:00-04:00", unlock_at: "2026-10-01T00:00:00-04:00", end_at: "2026-10-30T23:59:00-04:00" };
const entry = (day: string, over: Record<string, unknown> = {}) => ({ day, kind: "CHANGE", headline: `Entry ${day}`, channels: [], work: [], why: null, budget: [], spent_usd: 1, bookings: 2, hosts: 3, ...over });
const build = (over: Record<string, unknown> = {}): LiveUpcar =>
  parseLiveUpcar({
    run: { slug: "upcar", listed: true }, locked: false, clock, budget_usd: 25000, goals: { booking_value_usd: 300000 },
    numbers: {
      spent_usd: 1500, spend_per_day_recent_usd: 400, runs_out_day: 30, bookings: 40, hosts: 8, booking_value_usd: 4000,
      pace: { bookings_per_week: 150, hosts_per_week: 84, booking_value_per_week: 53385 },
      by_day: [{ day: "2026-10-03", bookings: 55, hosts: 5, spent_usd: 1006, booking_value_usd: 9000 }],
    },
    now_line: { last_review_at: null, changes_today: 0, channels_today: [] },
    days: [entry("2026-10-09"), entry("2026-10-03"), entry("2026-10-01")],
    ...over,
  })!;

describe("parseDayNumber", () => {
  it("takes 1-99 written plainly, nothing else", () => {
    expect(parseDayNumber("9")).toBe(9);
    expect(parseDayNumber("30")).toBe(30);
    for (const bad of ["0", "09", "-1", "1.5", "100", "", "9 ", "nine"]) expect(parseDayNumber(bad)).toBeNull();
  });
});

describe("daysWithFigures", () => {
  it("gives each log row the figures its day page shows", () => {
    const d = build();
    for (const e of daysWithFigures(d)) {
      const n = publishedDayNumbers(d).find((x) => x.entry.day === e.day)!.n;
      expect({ spent_usd: e.spent_usd, hosts: e.hosts, bookings: e.bookings }).toEqual(publishedDay(d, String(n))!.figures);
    }
    expect(daysWithFigures(d).find((e) => e.day === "2026-10-03")).toMatchObject({ spent_usd: 1006, hosts: 5, bookings: 55 });
  });
  it("leaves the entries alone when the payload carries no numbers", () => {
    const d = build({ locked: true, numbers: null });
    expect(daysWithFigures(d)).toEqual(d.days);
  });
});

describe("publishedDay", () => {
  it("day N is the entry's Eastern date, with the scoreboard's corrected row as its figures", () => {
    const p = publishedDay(build(), "3")!;
    expect(p.entry.day).toBe("2026-10-03");
    expect(p.figures).toEqual({ spent_usd: 1006, hosts: 5, bookings: 55 });
    expect([p.prev, p.next]).toEqual([1, 9]);
  });
  it("falls back to the entry's own figures when the scoreboard has no row for that day", () => {
    expect(publishedDay(build(), "1")!.figures).toEqual({ spent_usd: 1, hosts: 3, bookings: 2 });
  });
  it("a day with no published entry (never written, or hidden) has no page", () => {
    expect(publishedDay(build(), "2")).toBeNull();
    expect(publishedDay(build(), "4")).toBeNull();
  });
  it("prev/next skip days without a page; the first and last have none on one side", () => {
    expect(publishedDay(build(), "1")).toMatchObject({ prev: null, next: 3 });
    expect(publishedDay(build(), "9")).toMatchObject({ prev: 3, next: null });
  });
  it("a locked run has no day pages (the payload carries only the neutral entries)", () => {
    const locked = build({ locked: true });
    expect(publishedDayNumbers(locked)).toEqual([]);
    expect(publishedDay(locked, "3")).toBeNull();
  });
  it("a non-canonical number is not a page, even for a published day", () => {
    expect(publishedDay(build(), "03")).toBeNull();
  });
  it("an entry outside the run window never becomes a page", () => {
    const d = build({ days: [entry("2026-09-29"), entry("2026-11-05"), entry("2026-10-03")] });
    expect(publishedDayNumbers(d).map((x) => x.n)).toEqual([3]);
  });
  it("a moved start date renumbers by date, so an old URL shows its own day or 404s", () => {
    const later = build({ clock: { ...clock, start_at: "2026-10-02T00:00:00-04:00" } });
    expect(publishedDay(later, "2")!.entry.day).toBe("2026-10-03");
    expect(publishedDay(later, "3")).toBeNull();
  });
});

describe("dayDates", () => {
  const e = (over: Record<string, unknown>) => build({ days: [entry("2026-10-03", over)] }).days[0];
  it("uses the real publish and change times", () => {
    expect(dayDates(e({ published_at: "2026-10-04T04:10:00.000Z", updated_at: "2026-10-05T10:00:00.000Z" }))).toEqual({
      published: "2026-10-04T04:10:00.000Z",
      modified: "2026-10-05T10:00:00.000Z",
    });
  });
  it("an older backend without the times dates the page by its day", () => {
    expect(dayDates(e({}))).toEqual({ published: "2026-10-03T04:00:00.000Z", modified: "2026-10-03T04:00:00.000Z" });
    expect(dayDates(build({ days: [entry("2026-11-20")], clock: { ...clock, end_at: "2026-11-25T23:59:00-05:00" } }).days[0]).published).toBe("2026-11-20T05:00:00.000Z");
  });
  it("never says it was modified before it was published", () => {
    expect(dayDates(e({ published_at: "2026-10-04T04:10:00.000Z", updated_at: "2026-10-01T00:00:00.000Z" })).modified).toBe("2026-10-04T04:10:00.000Z");
  });
});

describe("runDayCount", () => {
  it("counts Eastern calendar days, inclusive, the same way day pages are numbered", () => {
    expect(runDayCount(clock)).toBe(30);
    expect(runDayCount({ start_at: "2026-10-01T23:00:00-04:00", unlock_at: "2026-10-01T23:00:00-04:00", end_at: "2026-10-02T23:59:00-04:00" })).toBe(2);
  });
});
