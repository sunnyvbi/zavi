import { describe, it, expect } from "vitest";
import {
  cronNextRun,
  cronToShape,
  describeCron,
  isValidTimeZone,
  nextRuns,
  shapeToCron,
} from "./cron-schedule-util";

function wall(d: Date, tz: string): string {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  let hour = get("hour");
  if (hour === "24") hour = "00";
  return `${get("year")}-${get("month")}-${get("day")} ${hour}:${get("minute")}`;
}

const LA = "America/Los_Angeles";
const NY = "America/New_York";

describe("nextRuns — UTC (no timezone)", () => {
  it("returns the next fires evaluated against UTC wall-clock", () => {
    const from = new Date("2026-07-11T12:00:00Z");
    const runs = nextRuns("0 9 * * *", null, 3, from);
    expect(runs.map((d) => d.toISOString())).toEqual([
      "2026-07-12T09:00:00.000Z",
      "2026-07-13T09:00:00.000Z",
      "2026-07-14T09:00:00.000Z",
    ]);
  });

  it("cronNextRun keeps its legacy UTC behavior when no zone is passed", () => {
    const from = new Date("2026-07-11T08:30:00Z");
    expect(cronNextRun("0 9 * * *", from)?.toISOString()).toBe(
      "2026-07-11T09:00:00.000Z",
    );
  });

  it("returns nothing for an unparseable expression", () => {
    expect(nextRuns("not a cron", LA, 3)).toEqual([]);
    expect(cronNextRun("0 99 * * *")).toBeNull();
  });
});

describe("nextRuns — local wall-clock in an IANA zone", () => {
  it("fires at 09:00 LOCAL, not 09:00 UTC (the reported bug)", () => {
    const from = new Date("2026-07-11T12:00:00Z");
    const [first] = nextRuns("0 9 * * *", LA, 1, from);
    expect(wall(first, LA)).toBe("2026-07-11 09:00");
    expect(first.toISOString()).toBe("2026-07-11T16:00:00.000Z");
  });

  it("tracks DST: the same local 09:00 maps to a different UTC hour in winter", () => {
    const summer = nextRuns("0 9 * * *", LA, 1, new Date("2026-07-11T00:00:00Z"))[0];
    const winter = nextRuns("0 9 * * *", LA, 1, new Date("2026-12-11T00:00:00Z"))[0];
    expect(summer.getUTCHours()).toBe(16);
    expect(winter.getUTCHours()).toBe(17);
    expect(wall(summer, LA)).toBe("2026-07-11 09:00");
    expect(wall(winter, LA)).toBe("2026-12-11 09:00");
  });

  it("honors weekday shapes in local time", () => {
    const runs = nextRuns("0 7 * * 1-5", LA, 2, new Date("2026-07-11T20:00:00Z"));
    expect(runs.map((d) => wall(d, LA))).toEqual([
      "2026-07-13 07:00",
      "2026-07-14 07:00",
    ]);
  });

  it("SKIPS the hour that spring-forward deletes (never doubles it)", () => {
    const runs = nextRuns("30 2 * * *", NY, 3, new Date("2027-03-12T12:00:00Z"));
    const labels = runs.map((d) => wall(d, NY));
    expect(labels).toEqual([
      "2027-03-13 02:30",
      "2027-03-15 02:30",
      "2027-03-16 02:30",
    ]);
    expect(labels.every((l) => l.endsWith("02:30"))).toBe(true);
  });

  it("does not list a run twice in the hour fall-back repeats", () => {
    const runs = nextRuns("30 1 * * *", NY, 3, new Date("2026-10-30T12:00:00Z"));
    const labels = runs.map((d) => wall(d, NY));
    expect(labels).toEqual([
      "2026-10-31 01:30",
      "2026-11-01 01:30",
      "2026-11-02 01:30",
    ]);
    expect(new Set(runs.map((d) => d.toISOString())).size).toBe(3);
  });

  it("falls back to UTC evaluation when the zone is unrecognized", () => {
    const from = new Date("2026-07-11T12:00:00Z");
    const [first] = nextRuns("0 9 * * *", "Mars/Olympus_Mons", 1, from);
    expect(first.toISOString()).toBe("2026-07-12T09:00:00.000Z");
  });

  it("cronNextRun takes the same zone", () => {
    const next = cronNextRun("0 9 * * *", new Date("2026-07-11T12:00:00Z"), LA);
    expect(next?.toISOString()).toBe("2026-07-11T16:00:00.000Z");
  });
});

describe("isValidTimeZone", () => {
  it("accepts real zones and rejects junk", () => {
    expect(isValidTimeZone(LA)).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Nowhere/Nothing")).toBe(false);
  });
});

describe("cronToShape / shapeToCron", () => {
  it("round-trips the preset shapes", () => {
    expect(cronToShape("0 7 * * 1-5")).toEqual({ shape: "weekdays", time: "07:00" });
    expect(cronToShape("30 9 * * *")).toEqual({ shape: "daily", time: "09:30" });
    expect(cronToShape("0 9 * * 1")).toEqual({ shape: "weekly", time: "09:00" });
    expect(cronToShape("15 * * * *")).toEqual({ shape: "hourly", time: "00:15" });
    expect(shapeToCron("weekdays", "07:00")).toBe("0 7 * * 1-5");
    expect(shapeToCron("daily", "09:30")).toBe("30 9 * * *");
    expect(shapeToCron("weekly", "09:00")).toBe("0 9 * * 1");
    expect(shapeToCron("hourly", "00:15")).toBe("15 * * * *");
    expect(shapeToCron("custom", "09:00")).toBeNull();
  });

  it("calls anything it can't express custom", () => {
    expect(cronToShape("0 9 1 * *").shape).toBe("custom");
    expect(cronToShape("0 9,17 * * *").shape).toBe("custom");
    expect(cronToShape("garbage").shape).toBe("custom");
  });
});

describe("describeCron", () => {
  it("names the zone it was given", () => {
    expect(describeCron("0 7 * * 1-5", "Los Angeles (PT)")).toBe(
      "On weekdays at 7:00 AM in Los Angeles (PT).",
    );
  });

  it("says UTC when no zone is given (legacy rows)", () => {
    expect(describeCron("0 9 * * *")).toBe("Every day at 9:00 AM in UTC.");
  });
});
