import { describe, expect, it } from "vitest";
import { parseScheduleWords } from "../schedule-words";
import { scheduleLabel } from "../custom-agent-schedule-label";
import { nextLocalCronFire } from "../../../../workers/functions/cron-match";

const cron = (t: string) => {
  const r = parseScheduleWords(t);
  return r.ok ? r.cron : null;
};

describe("parseScheduleWords", () => {
  it.each([
    ["every day", "0 9 * * *"],
    ["daily at 7:30pm", "30 19 * * *"],
    ["weekdays at 10am", "0 10 * * 1-5"],
    ["Every weekday at 10 AM.", "0 10 * * 1-5"],
    ["weekends at noon", "0 12 * * 0,6"],
    ["every Monday at 9am", "0 9 * * 1"],
    ["every mon, wed and fri at 14:30", "30 14 * * 1,3,5"],
    ["on tuesdays and thursdays at 8 p.m.", "0 20 * * 2,4"],
    ["10:30 every friday", "30 10 * * 5"],
    ["every day at midnight", "0 0 * * *"],
    ["every day at 12am", "0 0 * * *"],
    ["every day at 12pm", "0 12 * * *"],
    ["every day at 2:30am", "30 2 * * *"],
    ["every day at 17", "0 17 * * *"],
    ["every monday tuesday wednesday thursday friday", "0 9 * * 1-5"],
    ["every hour", "0 * * * *"],
    ["hourly", "0 * * * *"],
    ["every 2 hours", "0 */2 * * *"],
    ["every 15 minutes", "*/15 * * * *"],
    ["every 30 mins", "*/30 * * * *"],
  ])("%s -> %s", (text, expected) => {
    expect(cron(text)).toBe(expected);
  });

  it.each([
    "",
    "every 5 minutes",
    "every 45 minutes",
    "every 5 hours",
    "every other thursday",
    "first of the month",
    "every day at 13pm",
    "every day at 9:75",
    "every day at 25:00",
    "10am",
    "whenever you like",
    "every 3 days",
  ])("refuses %j", (text) => {
    expect(parseScheduleWords(text)).toMatchObject({ ok: false });
  });

  it("says why a minutes interval was refused", () => {
    expect(parseScheduleWords("every 5 minutes")).toEqual({ ok: false, reason: "too_frequent" });
    expect(parseScheduleWords("every minute")).toEqual({ ok: false, reason: "too_frequent" });
    expect(parseScheduleWords("every 45 minutes")).toEqual({ ok: false, reason: "minutes" });
    expect(parseScheduleWords("every other thursday")).toEqual({ ok: false });
  });

  it("interval crons read as plain words, never 'Custom schedule'", () => {
    expect(scheduleLabel(cron("every 2 hours")!)).toBe("Every 2 hours");
    expect(scheduleLabel(cron("every 15 minutes")!)).toBe("Every 15 minutes");
    expect(scheduleLabel(cron("every hour")!)).toBe("Every hour");
    expect(scheduleLabel(cron("weekdays at 10am")!, "America/Los_Angeles")).toBe("Weekdays at 10:00 AM (PT)");
  });

  it("DST: next 3 fires of 'every day at 2:30am' LA from 2026-03-07 skip the missing local time", () => {
    const c = cron("every day at 2:30am")!;
    const out: string[] = [];
    let from = new Date("2026-03-07T00:00:00Z");
    for (let i = 0; i < 3; i++) {
      const next = nextLocalCronFire(c, "America/Los_Angeles", from)!;
      out.push(next.toISOString());
      from = new Date(next.getTime() + 60_000);
    }
    expect(out[0]).toBe("2026-03-07T10:30:00.000Z");
    expect(new Set(out).size).toBe(3);
    expect(out).not.toContain("2026-03-08T10:30:00.000Z");
    expect(out[1] > out[0] && out[2] > out[1]).toBe(true);
  });
});
