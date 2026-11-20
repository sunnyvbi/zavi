import { describe, it, expect } from "vitest";
import { dayKey, stuntDay, recentPerDay, runsOutDay, dayRangeUtc, measurementDays } from "../days";

describe("live-stunt day math", () => {
  it("keys a UTC instant to its Pacific calendar day", () => {
    expect(dayKey(new Date("2026-10-02T06:30:00Z"), "America/Los_Angeles")).toBe("2026-10-01");
  });
  it("numbers stunt days from the start (1-based, ET)", () => {
    expect(stuntDay(new Date("2026-10-13T22:00:00Z"), "2026-10-01T00:00:00-04:00")).toBe(13);
  });
  it("averages the last 5 FULL days (today excluded)", () => {
    const by = [880, 950, 980, 1000, 1040, 670].map((s, i) => ({ day: `d${i}`, spent_usd: s }));
    expect(recentPerDay(by)).toBe(970);
  });
  it("projects the run-out day, or null with no spend", () => {
    expect(runsOutDay({ day: 13, left: 15160, perDay: 970 })).toBe(29);
    expect(runsOutDay({ day: 13, left: 15160, perDay: 0 })).toBeNull();
  });
  it("lists measurement days as Pacific days clipped to the stunt window", () => {
    const d = measurementDays({ start_at: "2026-10-01T00:00:00-04:00", end_at: "2026-10-30T23:59:59-04:00", now: new Date("2026-10-02T12:00:00Z") });
    expect(d[0]).toEqual({ day: "2026-09-30", since: "2026-10-01T04:00:00.000Z", until: "2026-10-01T07:00:00.000Z" });
    expect(d.at(-1)!.until).toBe("2026-10-02T12:00:00.000Z");
    expect(d.map((x) => x.day)).toEqual(["2026-09-30", "2026-10-01", "2026-10-02"]);
  });
  it("returns no days before the start", () => {
    expect(measurementDays({ start_at: "2026-10-01T00:00:00-04:00", end_at: "2026-10-30T23:59:59-04:00", now: new Date("2026-09-29T12:00:00Z") })).toEqual([]);
  });
  it("gives the UTC half-open range of a Pacific day", () => {
    expect(dayRangeUtc("2026-10-01", "America/Los_Angeles")).toEqual({ since: "2026-10-01T07:00:00.000Z", until: "2026-10-02T07:00:00.000Z" });
  });
  it("handles the DST change day (1 Nov 2026 is 25h in Pacific)", () => {
    expect(dayRangeUtc("2026-11-01", "America/Los_Angeles")).toEqual({ since: "2026-11-01T07:00:00.000Z", until: "2026-11-02T08:00:00.000Z" });
  });
});
