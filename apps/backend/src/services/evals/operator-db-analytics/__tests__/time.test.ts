
import { describe, expect, it } from "vitest";
import { localMidnightUtc, localMonthRange, tzOffsetMs } from "../fixtures/time";

const iso = (d: Date) => d.toISOString();

describe("localMidnightUtc", () => {
  it("gets an ordinary US-Pacific summer date right", () => {
    expect(iso(localMidnightUtc(2026, 8, 1, "America/Los_Angeles"))).toBe("2026-08-01T07:00:00.000Z");
  });

  it("gets both 2026 US DST edges right", () => {
    expect(iso(localMidnightUtc(2026, 3, 8, "America/Los_Angeles"))).toBe("2026-03-08T08:00:00.000Z");
    expect(iso(localMidnightUtc(2026, 11, 1, "America/Los_Angeles"))).toBe("2026-11-01T07:00:00.000Z");
  });

  it("handles a zone whose DST transition lands ON local midnight", () => {
    const t = localMidnightUtc(2026, 9, 6, "America/Santiago");
    const local = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Santiago",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(t);
    expect(local, `got ${iso(t)}`).toBe("2026-09-06");
  });

  it("handles Havana's midnight transition too", () => {
    const t = localMidnightUtc(2026, 3, 8, "America/Havana");
    const local = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Havana",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(t);
    expect(local, `got ${iso(t)}`).toBe("2026-03-08");
  });

  it("converges on quarter-hour zones", () => {
    expect(iso(localMidnightUtc(2026, 8, 1, "Asia/Kathmandu"))).toBe("2026-07-31T18:15:00.000Z");
    expect(iso(localMidnightUtc(2026, 8, 1, "Pacific/Chatham"))).toBe("2026-07-31T11:15:00.000Z");
  });

  it("reads midnight as hour 0, never 24", () => {
    expect(tzOffsetMs(new Date("2026-08-01T07:00:00.000Z"), "America/Los_Angeles")).toBe(-7 * 3_600_000);
    expect(tzOffsetMs(new Date("2026-08-01T00:00:00.000Z"), "UTC")).toBe(0);
  });
});

describe("localMonthRange", () => {
  it("spans August in the operator's calendar, not UTC", () => {
    const [start, end] = localMonthRange(2026, 8, "America/Los_Angeles");
    expect(iso(start)).toBe("2026-08-01T07:00:00.000Z");
    expect(iso(end)).toBe("2026-09-01T07:00:00.000Z");
  });

  it("rolls December into the next year", () => {
    const [, end] = localMonthRange(2026, 12, "UTC");
    expect(iso(end)).toBe("2027-01-01T00:00:00.000Z");
  });
});
