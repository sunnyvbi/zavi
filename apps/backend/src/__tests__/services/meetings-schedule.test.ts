import { describe, it, expect } from "vitest";
import { computeDueJoin, nextOpenMeetingDate } from "../../services/meetings/schedule";

const CFG = {
  days_of_week: [1, 2, 3, 4, 5],
  join_time: "09:30",
  timezone: "America/Los_Angeles",
};

describe("computeDueJoin", () => {
  it("due exactly at the tenant-local join time", () => {
    const r = computeDueJoin(CFG, new Date("2026-06-10T16:30:00Z"));
    expect(r.due).toBe(true);
    if (r.due) {
      expect(r.local_date).toBe("2026-06-10");
      expect(new Date(r.join_at_iso).getTime()).toBeGreaterThan(
        new Date("2026-06-10T16:30:00Z").getTime(),
      );
    }
  });

  it("due slightly before join time (5-min lead window)", () => {
    const r = computeDueJoin(CFG, new Date("2026-06-10T16:26:00Z"));
    expect(r.due).toBe(true);
    if (r.due) {
      expect(r.join_at_iso).toBe("2026-06-10T16:30:00.000Z");
    }
  });

  it("not due outside the window", () => {
    expect(computeDueJoin(CFG, new Date("2026-06-10T15:00:00Z")).due).toBe(false);
    expect(computeDueJoin(CFG, new Date("2026-06-10T16:41:00Z")).due).toBe(false);
  });

  it("not due on a disabled weekday (Sunday)", () => {
    expect(computeDueJoin(CFG, new Date("2026-06-14T16:30:00Z")).due).toBe(false);
  });

  it("respects a different timezone (Asia/Kolkata standup)", () => {
    const cfg = { ...CFG, timezone: "Asia/Kolkata", join_time: "10:00" };
    const r = computeDueJoin(cfg, new Date("2026-06-10T04:30:00Z"));
    expect(r.due).toBe(true);
    if (r.due) expect(r.local_date).toBe("2026-06-10");
  });

  it("local_date is tenant-local even across the UTC date line", () => {
    const cfg = { ...CFG, join_time: "23:30", days_of_week: [2] };
    const r = computeDueJoin(cfg, new Date("2026-06-10T06:30:00Z"));
    expect(r.due).toBe(true);
    if (r.due) expect(r.local_date).toBe("2026-06-09");
  });

  it("never throws on garbage config", () => {
    expect(
      computeDueJoin(
        { days_of_week: [3], join_time: "9:3x", timezone: "America/Los_Angeles" },
        new Date(),
      ).due,
    ).toBe(false);
    expect(
      computeDueJoin(
        { days_of_week: [3], join_time: "09:30", timezone: "Not/AZone" },
        new Date(),
      ).due,
    ).toBe(false);
  });
});

describe("computeDueJoin across local midnight", () => {
  it("a 23:58 meeting is due on the 00:00 tick (it used to be skipped every day), keyed to the meeting's own day", () => {
    const cfg = { days_of_week: [1], join_time: "23:58", timezone: "America/Los_Angeles" };
    const r = computeDueJoin(cfg, new Date("2026-06-09T07:00:10Z"));
    expect(r.due).toBe(true);
    if (r.due) {
      expect(r.local_date).toBe("2026-06-08");
      expect(r.target_iso).toBe("2026-06-09T06:58:00.000Z");
      expect(r.join_at_iso).toBe("2026-06-09T07:01:10.000Z");
    }
  });

  it("the weekday checked is the meeting's, not the tick's", () => {
    const tuesdayOnly = { days_of_week: [2], join_time: "23:58", timezone: "America/Los_Angeles" };
    expect(computeDueJoin(tuesdayOnly, new Date("2026-06-09T07:00:10Z")).due).toBe(false);
  });

  it("a 00:02 meeting is due on the 23:57 tick the night before, keyed to the meeting's day", () => {
    const cfg = { days_of_week: [2], join_time: "00:02", timezone: "America/Los_Angeles" };
    const r = computeDueJoin(cfg, new Date("2026-06-09T06:57:30Z"));
    expect(r.due).toBe(true);
    if (r.due) {
      expect(r.local_date).toBe("2026-06-09");
      expect(r.target_iso).toBe("2026-06-09T07:02:00.000Z");
    }
  });

  it("reports the join instant of an ordinary window as target_iso", () => {
    const r = computeDueJoin(CFG, new Date("2026-06-10T16:26:20Z"));
    expect(r.due).toBe(true);
    if (r.due) expect(r.target_iso).toBe("2026-06-10T16:30:00.000Z");
  });

  it("handles a month boundary for the meeting's day", () => {
    const cfg = { days_of_week: [2], join_time: "23:58", timezone: "America/Los_Angeles" };
    const r = computeDueJoin(cfg, new Date("2026-07-01T07:00:10Z"));
    expect(r.due).toBe(true);
    if (r.due) expect(r.local_date).toBe("2026-06-30");
  });
});

describe("nextOpenMeetingDate", () => {
  const cfg = { days_of_week: [0, 1, 2, 3, 4, 5, 6], join_time: "21:30", timezone: "America/Los_Angeles" };
  it("is today's local date while today's due window is still open, tomorrow's once it closed", () => {
    expect(nextOpenMeetingDate(cfg, new Date("2026-10-27T04:00:00Z"))).toBe("2026-10-26");
    expect(nextOpenMeetingDate(cfg, new Date("2026-10-27T04:39:00Z"))).toBe("2026-10-26");
    expect(nextOpenMeetingDate(cfg, new Date("2026-10-27T04:41:00Z"))).toBe("2026-10-27");
  });
  it("skips days off and returns null for bad config", () => {
    expect(nextOpenMeetingDate({ ...cfg, days_of_week: [2] }, new Date("2026-10-27T04:00:00Z"))).toBe("2026-10-27");
    expect(nextOpenMeetingDate({ ...cfg, days_of_week: [6] }, new Date("2026-10-27T04:00:00Z"))).toBeNull();
    expect(nextOpenMeetingDate({ ...cfg, timezone: "Not/AZone" }, new Date())).toBeNull();
    expect(nextOpenMeetingDate({ ...cfg, join_time: "25:00" }, new Date())).toBeNull();
  });
  it("agrees with the scheduler's day key across midnight, both directions", () => {
    const early = { days_of_week: [2], join_time: "00:02", timezone: "America/Los_Angeles" };
    const at = new Date("2026-06-09T06:57:30Z");
    const due = computeDueJoin(early, at);
    expect(due.due && due.local_date).toBe("2026-06-09");
    expect(nextOpenMeetingDate(early, at)).toBe("2026-06-09");
    const late = { days_of_week: [1], join_time: "23:58", timezone: "America/Los_Angeles" };
    const after = new Date("2026-06-09T07:00:10Z");
    const due2 = computeDueJoin(late, after);
    expect(due2.due && due2.local_date).toBe("2026-06-08");
    expect(nextOpenMeetingDate(late, after)).toBe("2026-06-08");
  });
});

describe("computeDueJoin on daylight-saving days (real instants, not local-minute arithmetic)", () => {
  const every = [0, 1, 2, 3, 4, 5, 6];
  it("a join time inside a spring-forward gap has no meeting that day (not an hour late)", () => {
    const cfg = { days_of_week: every, join_time: "02:02", timezone: "America/New_York" };
    for (const iso of ["2026-03-08T06:50:00Z", "2026-03-08T06:57:00Z", "2026-03-08T07:00:00Z", "2026-03-08T07:02:00Z"]) {
      expect(computeDueJoin(cfg, new Date(iso)).due).toBe(false);
    }
    expect(computeDueJoin(cfg, new Date("2026-03-09T06:02:00Z")).due).toBe(true);
  });

  it("the same at a midnight transition (Cairo, 2026-04-24: 23:59 is followed by 01:00)", () => {
    const cfg = { days_of_week: every, join_time: "00:02", timezone: "Africa/Cairo" };
    expect(computeDueJoin(cfg, new Date("2026-04-23T21:57:30Z")).due).toBe(false);
    expect(computeDueJoin(cfg, new Date("2026-04-23T22:02:00Z")).due).toBe(false);
  });

  it("a join time that happens twice on a fall-back day is due in one of its windows, with its own instant", () => {
    const cfg = { days_of_week: every, join_time: "01:30", timezone: "America/New_York" };
    const first = computeDueJoin(cfg, new Date("2026-11-01T05:30:00Z"));
    const second = computeDueJoin(cfg, new Date("2026-11-01T06:30:00Z"));
    const due = [first, second].filter((r) => r.due);
    expect(due).toHaveLength(1);
    const r = due[0];
    if (r.due) {
      expect(r.local_date).toBe("2026-11-01");
      expect(["2026-11-01T05:30:00.000Z", "2026-11-01T06:30:00.000Z"]).toContain(r.target_iso);
    }
  });

  it("an ordinary meeting on a clock-change day is due at its real local time", () => {
    const cfg = { days_of_week: every, join_time: "09:30", timezone: "America/New_York" };
    const r = computeDueJoin(cfg, new Date("2026-03-08T13:30:00Z"));
    expect(r.due && r.target_iso).toBe("2026-03-08T13:30:00.000Z");
    expect(computeDueJoin(cfg, new Date("2026-03-08T14:30:00Z")).due).toBe(false);
  });
});
