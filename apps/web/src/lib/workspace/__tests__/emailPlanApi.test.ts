import { describe, expect, it } from "vitest";
import { PlanError, PLAN_TOO_FAR, isAmbiguousPlanError, planLatestDay, plannedTooFar, plannedTooSoon, wallInstant, wallParts } from "../emailPlanApi";

describe("isAmbiguousPlanError", () => {
  it("only a 4xx with the server's own reason is a refusal", () => {
    expect(isAmbiguousPlanError(new PlanError("not_skippable", "This email can no longer be skipped.", 409, true))).toBe(false);
    expect(isAmbiguousPlanError(new PlanError("bad_request", "That request was not complete.", 400, true))).toBe(false);
  });

  it("no answer, any 5xx (even one with a code and a message), and a 4xx with no reason are ambiguous", () => {
    expect(isAmbiguousPlanError(new PlanError("network", "We could not reach Zavi.", 0))).toBe(true);
    expect(isAmbiguousPlanError(new PlanError("count_required", "Zavi could not count the list.", 503, true))).toBe(true);
    expect(isAmbiguousPlanError(new PlanError("internal_error", "That did not work.", 500, true))).toBe(true);
    expect(isAmbiguousPlanError(new PlanError("error", "That did not work. Try again.", 404, false))).toBe(true);
    expect(isAmbiguousPlanError(new Error("boom"))).toBe(true);
  });
});

describe("a day whose year is still being typed", () => {
  const NOW = Date.parse("2026-10-27T12:00:00Z");
  const ZONES = ["Asia/Kolkata", "America/Los_Angeles", "UTC", "Pacific/Kiritimati"];

  it("a year under 1000 reads back with four digits", () => {
    expect(wallParts("0028-10-28T10:00:00Z", "UTC")).toEqual({ date: "0028-10-28", time: "10:00" });
    expect(wallParts("0002-10-28T10:00:00Z", "UTC")).toEqual({ date: "0002-10-28", time: "10:00" });
  });

  it("every partial year never throws, a past one is too soon, a far one is not", () => {
    for (const tz of ZONES) {
      for (const date of ["0002-10-28", "0028-10-28", "0281-10-28", "0001-01-01"]) {
        const at = wallInstant({ date, time: "10:00" }, tz);
        expect(at?.slice(0, 4)).toBe(date.slice(0, 4));
        expect(plannedTooSoon({ date, time: "10:00" }, tz, NOW)).toBe(true);
      }
      for (const date of ["2810-10-28", "9999-12-31"]) {
        expect(wallInstant({ date, time: "10:00" }, tz)).not.toBeNull();
        expect(plannedTooSoon({ date, time: "10:00" }, tz, NOW)).toBe(false);
      }
      expect(() => wallInstant({ date: "0000-01-01", time: "10:00" }, tz)).not.toThrow();
      expect(plannedTooSoon({ date: "0000-01-01", time: "10:00" }, tz, NOW)).toBe(false);
    }
    expect(wallInstant({ date: "0028-10-28", time: "10:00" }, "UTC")).toBe("0028-10-28T10:00:00.000Z");
  });
});

describe("a day more than 14 days ahead", () => {
  const NOW = Date.parse("2026-10-27T12:00:00Z");
  const NY = "America/New_York";

  it("the edge is 14 times 24 hours on the workspace's zone across the fall-back change: 07:00 New York is the last minute, 07:01 and the old wall time 08:00 are too far", () => {
    expect(plannedTooFar({ date: "2026-11-10", time: "07:00" }, NY, NOW)).toBe(false);
    expect(wallInstant({ date: "2026-11-10", time: "07:00" }, NY)).toBe("2026-11-10T12:00:00.000Z");
    expect(plannedTooFar({ date: "2026-11-10", time: "07:01" }, NY, NOW)).toBe(true);
    expect(plannedTooFar({ date: "2026-11-10", time: "08:00" }, NY, NOW)).toBe(true);
    expect(plannedTooFar({ date: "2026-11-11", time: "00:00" }, NY, NOW)).toBe(true);
    expect(plannedTooFar({ date: "2026-12-15", time: "09:00" }, NY, NOW)).toBe(true);
    expect(plannedTooFar({ date: "2026-10-29", time: "09:00" }, NY, NOW)).toBe(false);
    expect(planLatestDay(NY, NOW)).toBe("2026-11-10");
  });

  it("the edge is the same instant in a zone ahead of UTC: Kolkata 17:30 is fine, 17:31 is too far", () => {
    expect(plannedTooFar({ date: "2026-11-10", time: "17:30" }, "Asia/Kolkata", NOW)).toBe(false);
    expect(plannedTooFar({ date: "2026-11-10", time: "17:31" }, "Asia/Kolkata", NOW)).toBe(true);
  });

  it("a year of five or more digits is too far even before the zone is known", () => {
    for (const date of ["812026-12-15", "20261-01-01", "+812026-12-15"]) {
      expect(plannedTooFar({ date, time: "09:00" }, NY, NOW)).toBe(true);
      expect(plannedTooFar({ date, time: "09:00" }, null, NOW)).toBe(true);
    }
    expect(plannedTooFar({ date: "2026-12-15", time: "09:00" }, null, NOW)).toBe(false);
  });

  it("says what the server says", () => {
    expect(PLAN_TOO_FAR).toBe("An email is planned at most 14 days ahead.");
  });
});
