import { describe, it, expect } from "vitest";
import { scheduleLabel, zoneLabel } from "../custom-agent-schedule-label";

describe("scheduleLabel", () => {
  it.each([
    ["0 9 * * 1-5", "America/Los_Angeles", "Weekdays at 9:00 AM (PT)"],
    ["0 8 * * 1", "Asia/Kolkata", "Every Monday at 8:00 AM (IST)"],
    ["30 19 * * *", "UTC", "Every day at 7:30 PM (UTC)"],
    ["0 0 * * 0,6", "America/New_York", "Weekends at 12:00 AM (ET)"],
    ["15 12 * * 1,3,5", "Europe/Berlin", "Every Monday, Wednesday and Friday at 12:15 PM (Berlin)"],
    ["0 7 * * 0", undefined, "Every Sunday at 7:00 AM"],
  ])("%s in %s → %s", (cron, tz, want) => {
    expect(scheduleLabel(cron, tz)).toBe(want);
  });

  it.each(["*/15 9 * * *", "0 */2 * * 1-5", "0 9 1 * *", "0 9 * 1 *", "0 9-17 * * *", "0 9 * * MON", "nonsense", "99 9 * * *"])(
    "falls back for %s",
    (cron) => {
      expect(scheduleLabel(cron, "UTC")).toBe(`Custom schedule (${cron})`);
    },
  );

  it.each([
    ["*/15 * * * *", "Every 15 minutes"],
    ["0 */2 * * *", "Every 2 hours"],
    ["0 * * * *", "Every hour"],
  ])("interval %s reads %s", (cron, label) => {
    expect(scheduleLabel(cron, "UTC")).toBe(label);
  });

  it("short zone labels", () => {
    expect(zoneLabel("America/Chicago")).toBe("CT");
    expect(zoneLabel("America/Sao_Paulo")).toBe("Sao Paulo");
  });
});

