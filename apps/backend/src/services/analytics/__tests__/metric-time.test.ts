import { describe, it, expect } from "vitest";
import {
  bucketsFor,
  compareWindow,
  localDateOf,
  localDayStartUtc,
  resolveWindow,
  windowUtcRange,
  WindowError,
} from "../metric-time";

const NOW = new Date("2026-09-28T03:00:00Z");

describe("resolveWindow", () => {
  it("last_7d ends YESTERDAY in the tenant's zone (today's partial day excluded)", () => {
    const la = resolveWindow({ preset: "last_7d" }, "America/Los_Angeles", NOW);
    expect(la).toMatchObject({ since: "2026-09-20", until: "2026-09-26" });
    const utc = resolveWindow({ preset: "last_7d" }, "UTC", NOW);
    expect(utc).toMatchObject({ since: "2026-09-21", until: "2026-09-27" });
  });

  it("include_today keeps today", () => {
    expect(resolveWindow({ preset: "last_7d", include_today: true }, "UTC", NOW)).toMatchObject({
      since: "2026-09-22",
      until: "2026-09-28",
    });
  });

  it("last_week is the previous full Monday-Sunday", () => {
    expect(resolveWindow({ preset: "last_week" }, "UTC", NOW)).toMatchObject({ since: "2026-09-21", until: "2026-09-27" });
  });

  it("last_month is the previous calendar month", () => {
    expect(resolveWindow({ preset: "last_month" }, "UTC", NOW)).toMatchObject({ since: "2026-08-01", until: "2026-08-31" });
  });

  it("defaults to last_28d", () => {
    expect(resolveWindow(undefined, "UTC", NOW)).toMatchObject({ since: "2026-08-31", until: "2026-09-27" });
  });

  it("clamps an explicit until in the future and says so", () => {
    const w = resolveWindow({ since: "2026-09-01", until: "2026-10-05" }, "UTC", NOW);
    expect(w.until).toBe("2026-09-27");
    expect(w.notes.join(" ")).toMatch(/partial day/);
  });

  it("refuses a preset plus dates, half a range, and an over-long window", () => {
    expect(() => resolveWindow({ preset: "last_7d", since: "2026-09-01", until: "2026-09-02" }, "UTC", NOW)).toThrow(WindowError);
    expect(() => resolveWindow({ since: "2026-09-01" }, "UTC", NOW)).toThrow(WindowError);
    expect(() => resolveWindow({ since: "2024-01-01", until: "2026-09-01" }, "UTC", NOW)).toThrow(/400 days/);
  });

  it("month_to_date on the 1st has no complete day", () => {
    expect(() => resolveWindow({ preset: "month_to_date" }, "UTC", new Date("2026-10-01T12:00:00Z"))).toThrow(/no complete day/);
  });
});

describe("compareWindow", () => {
  it("previous_period is the same number of days immediately before", () => {
    const w = resolveWindow({ since: "2026-09-10", until: "2026-09-16" }, "UTC", NOW);
    expect(compareWindow(w, "previous_period")).toMatchObject({ since: "2026-09-03", until: "2026-09-09" });
  });

  it("a whole month compares to the whole month before, not the prior N days", () => {
    const w = resolveWindow({ preset: "last_month" }, "UTC", NOW);
    expect(compareWindow(w, "previous_period")).toMatchObject({ since: "2026-07-01", until: "2026-07-31" });
  });

  it("previous_year shifts by twelve months", () => {
    const w = resolveWindow({ since: "2026-09-01", until: "2026-09-27" }, "UTC", NOW);
    expect(compareWindow(w, "previous_year")).toMatchObject({ since: "2025-09-01", until: "2025-09-27" });
  });
});

describe("buckets and UTC edges", () => {
  it("weeks are Monday-start and flag partial edges", () => {
    const b = bucketsFor({ since: "2026-09-10", until: "2026-09-27" }, "week");
    expect(b.map((x) => [x.start, x.partial])).toEqual([
      ["2026-09-07", true],
      ["2026-09-14", false],
      ["2026-09-21", false],
    ]);
  });

  it("local midnight is DST-exact", () => {
    expect(localDayStartUtc("2026-09-01", "America/Los_Angeles").toISOString()).toBe("2026-09-01T07:00:00.000Z");
    expect(localDayStartUtc("2026-11-02", "America/Los_Angeles").toISOString()).toBe("2026-11-02T08:00:00.000Z");
    const r = windowUtcRange({ since: "2026-09-01", until: "2026-09-01", tz: "America/Los_Angeles" });
    expect(r.until.getTime() - r.since.getTime()).toBe(86_400_000);
  });

  it("localDateOf reads the zone's calendar", () => {
    expect(localDateOf(NOW, "America/Los_Angeles")).toBe("2026-09-27");
    expect(localDateOf(NOW, "UTC")).toBe("2026-09-28");
  });
});
