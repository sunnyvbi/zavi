import { describe, it, expect } from "vitest";
import {
  cronMatches,
  cronDueInBucket,
  validateCronExpression,
  isValidTimeZone,
} from "./cron-match";

describe("cronMatches", () => {
  it("0 9 * * * matches 09:00, not 10:00", () => {
    expect(cronMatches("0 9 * * *", new Date("2026-05-15T09:00:00Z"))).toBe(true);
    expect(cronMatches("0 9 * * *", new Date("2026-05-15T10:00:00Z"))).toBe(false);
    expect(cronMatches("0 9 * * *", new Date("2026-05-15T09:01:00Z"))).toBe(false);
  });

  it("0 10 * * 1 matches Monday 10:00 only", () => {
    expect(cronMatches("0 10 * * 1", new Date("2026-05-18T10:00:00Z"))).toBe(true);
    expect(cronMatches("0 10 * * 1", new Date("2026-05-15T10:00:00Z"))).toBe(false);
  });

  it("*/5 * * * * matches any 5-min boundary", () => {
    expect(cronMatches("*/5 * * * *", new Date("2026-05-15T09:00:00Z"))).toBe(true);
    expect(cronMatches("*/5 * * * *", new Date("2026-05-15T09:35:00Z"))).toBe(true);
    expect(cronMatches("*/5 * * * *", new Date("2026-05-15T09:37:00Z"))).toBe(false);
  });

  it("DOM/DOW each constrain independently (OR not enforced here — both set)", () => {
    expect(cronMatches("0 9 1 * 1", new Date("2026-06-01T09:00:00Z"))).toBe(true);
    expect(cronMatches("0 9 1 * 1", new Date("2026-05-01T09:00:00Z"))).toBe(false);
  });

  it("range+step 1-5/2 → 1,3,5", () => {
    expect(cronMatches("1-5/2 * * * *", new Date("2026-05-15T09:01:00Z"))).toBe(true);
    expect(cronMatches("1-5/2 * * * *", new Date("2026-05-15T09:03:00Z"))).toBe(true);
    expect(cronMatches("1-5/2 * * * *", new Date("2026-05-15T09:05:00Z"))).toBe(true);
    expect(cronMatches("1-5/2 * * * *", new Date("2026-05-15T09:02:00Z"))).toBe(false);
  });

  it("comma list 0,30 9 * * *", () => {
    expect(cronMatches("0,30 9 * * *", new Date("2026-05-15T09:30:00Z"))).toBe(true);
    expect(cronMatches("0,30 9 * * *", new Date("2026-05-15T09:15:00Z"))).toBe(false);
  });

  it("DOW 7 is Sunday", () => {
    expect(cronMatches("0 9 * * 7", new Date("2026-05-17T09:00:00Z"))).toBe(true);
    expect(cronMatches("0 9 * * 0", new Date("2026-05-17T09:00:00Z"))).toBe(true);
    expect(cronMatches("0 9 * * 7", new Date("2026-05-18T09:00:00Z"))).toBe(false);
  });

  it("malformed → false", () => {
    expect(cronMatches("not a cron", new Date())).toBe(false);
    expect(cronMatches("0 9 * *", new Date())).toBe(false);
    expect(cronMatches("*/0 * * * *", new Date("2026-05-15T09:00:00Z"))).toBe(false);
  });
});

describe("cronDueInBucket", () => {
  it("0 9 * * * is due in the 09:00 bucket, not 10:30", () => {
    expect(cronDueInBucket("0 9 * * *", "2026-05-15T09:00:00.000Z")).toBe(true);
    expect(cronDueInBucket("0 9 * * *", "2026-05-15T10:30:00.000Z")).toBe(false);
  });
  it("a minute mid-bucket still fires for that bucket", () => {
    expect(cronDueInBucket("3 9 * * *", "2026-05-15T09:00:00.000Z")).toBe(true);
  });
  it("*/5 due in every bucket", () => {
    expect(cronDueInBucket("*/5 * * * *", "2026-05-15T09:15:00.000Z")).toBe(true);
  });
  it("bad bucket iso → false", () => {
    expect(cronDueInBucket("0 9 * * *", "garbage")).toBe(false);
  });
});

describe("validateCronExpression", () => {
  it("accepts valid expressions", () => {
    expect(validateCronExpression("0 9 * * *")).toBeNull();
    expect(validateCronExpression("0 9 * * 1-5")).toBeNull();
    expect(validateCronExpression("*/5 * * * *")).toBeNull();
    expect(validateCronExpression("0,30 9 * * 1")).toBeNull();
  });
  it("rejects non-5-field", () => {
    expect(validateCronExpression("0 9 * *")).toMatch(/exactly 5 fields/);
  });
  it("rejects garbage tokens", () => {
    expect(validateCronExpression("99 9 * * *")).toMatch(/out of range/);
    expect(validateCronExpression("foo 9 * * *")).toMatch(/invalid token/);
  });
  it("rejects zero/negative step", () => {
    expect(validateCronExpression("*/0 * * * *")).toMatch(/invalid step/);
  });
  it("rejects out-of-range", () => {
    expect(validateCronExpression("60 * * * *")).toMatch(/out of range/);
    expect(validateCronExpression("* 24 * * *")).toMatch(/out of range/);
    expect(validateCronExpression("* * 32 * *")).toMatch(/out of range/);
  });
  it("rejects sub-5-minute cadence", () => {
    expect(validateCronExpression("*/1 * * * *")).toMatch(/too frequent/);
    expect(validateCronExpression("* * * * *")).toMatch(/too frequent/);
    expect(validateCronExpression("*/4 * * * *")).toMatch(/too frequent/);
  });
});

describe("cronMatches timezone", () => {
  it('"0 9 * * *" for America/Los_Angeles fires at 09:00 PT, not 09:00 UTC', () => {
    expect(
      cronMatches("0 9 * * *", new Date("2026-07-15T16:00:00Z"), "America/Los_Angeles"),
    ).toBe(true);
    expect(
      cronMatches("0 9 * * *", new Date("2026-07-15T09:00:00Z"), "America/Los_Angeles"),
    ).toBe(false);
    expect(
      cronMatches("0 9 * * *", new Date("2026-07-15T17:00:00Z"), "America/Los_Angeles"),
    ).toBe(false);
  });

  it("null/undefined/empty timezone is BYTE-IDENTICAL to the UTC path", () => {
    const cases: Array<[string, string]> = [
      ["0 9 * * *", "2026-05-15T09:00:00Z"],
      ["0 9 * * *", "2026-05-15T10:00:00Z"],
      ["0 10 * * 1", "2026-05-18T10:00:00Z"],
      ["*/5 * * * *", "2026-05-15T09:35:00Z"],
      ["0 9 * * 7", "2026-05-17T09:00:00Z"],
    ];
    for (const [expr, iso] of cases) {
      const base = cronMatches(expr, new Date(iso));
      expect(cronMatches(expr, new Date(iso), undefined)).toBe(base);
      expect(cronMatches(expr, new Date(iso), null)).toBe(base);
      expect(cronMatches(expr, new Date(iso), "")).toBe(base);
      expect(cronMatches(expr, new Date(iso), "UTC")).toBe(base);
    }
  });

  it("DST boundary: the SAME cron maps to a DIFFERENT UTC instant across the transition", () => {
    expect(
      cronMatches("0 9 * * *", new Date("2026-01-15T17:00:00Z"), "America/Los_Angeles"),
    ).toBe(true);
    expect(
      cronMatches("0 9 * * *", new Date("2026-01-15T16:00:00Z"), "America/Los_Angeles"),
    ).toBe(false);

    expect(
      cronMatches("0 9 * * *", new Date("2026-07-15T16:00:00Z"), "America/Los_Angeles"),
    ).toBe(true);
    expect(
      cronMatches("0 9 * * *", new Date("2026-07-15T17:00:00Z"), "America/Los_Angeles"),
    ).toBe(false);

    expect(
      cronMatches("0 9 * * *", new Date("2026-01-15T17:00:00Z"), "America/Los_Angeles"),
    ).not.toBe(
      cronMatches("0 9 * * *", new Date("2026-07-15T17:00:00Z"), "America/Los_Angeles"),
    );
  });

  it("timezone rolls the weekday across the UTC day boundary", () => {
    expect(
      cronMatches("0 23 * * 5", new Date("2026-01-17T07:00:00Z"), "America/Los_Angeles"),
    ).toBe(true);
    expect(cronMatches("0 23 * * 5", new Date("2026-01-17T07:00:00Z"))).toBe(false);
  });

  it("unrecognized timezone fails SAFE to the UTC path (never throws)", () => {
    expect(cronMatches("0 9 * * *", new Date("2026-05-15T09:00:00Z"), "Mars/Phobos")).toBe(
      cronMatches("0 9 * * *", new Date("2026-05-15T09:00:00Z")),
    );
    expect(isValidTimeZone("Mars/Phobos")).toBe(false);
    expect(isValidTimeZone("America/Los_Angeles")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
  });
});

describe("cronDueInBucket timezone", () => {
  it("bucket honors the tenant timezone (LA summer 09:00 PT == 16:00Z bucket)", () => {
    expect(
      cronDueInBucket("0 9 * * *", "2026-07-15T16:00:00.000Z", "America/Los_Angeles"),
    ).toBe(true);
    expect(
      cronDueInBucket("0 9 * * *", "2026-07-15T09:00:00.000Z", "America/Los_Angeles"),
    ).toBe(false);
    expect(
      cronDueInBucket("3 9 * * *", "2026-07-15T16:00:00.000Z", "America/Los_Angeles"),
    ).toBe(true);
  });

  it("null timezone bucket is byte-identical to today", () => {
    expect(cronDueInBucket("0 9 * * *", "2026-05-15T09:00:00.000Z", null)).toBe(
      cronDueInBucket("0 9 * * *", "2026-05-15T09:00:00.000Z"),
    );
    expect(cronDueInBucket("0 9 * * *", "2026-05-15T09:00:00.000Z", null)).toBe(true);
  });
});

describe("nextLocalCronFire (Agent Builder S2)", () => {
  it("reads the cron as local wall-clock time, across a DST change", async () => {
    const { nextLocalCronFire } = await import("./cron-match");
    expect(
      nextLocalCronFire("0 9 * * 1-5", "America/Los_Angeles", new Date("2026-10-30T16:05:00.000Z"))?.toISOString(),
    ).toBe("2026-11-02T17:00:00.000Z");
    expect(
      nextLocalCronFire("0 9 * * 1-5", "America/Los_Angeles", new Date("2026-09-28T00:00:00.000Z"))?.toISOString(),
    ).toBe("2026-09-28T16:00:00.000Z");
  });

  it("is inclusive of `from` on a whole minute, and null when it never fires", async () => {
    const { nextLocalCronFire } = await import("./cron-match");
    expect(nextLocalCronFire("0 16 * * *", "UTC", new Date("2026-09-28T16:00:00.000Z"))?.toISOString()).toBe(
      "2026-09-28T16:00:00.000Z",
    );
    expect(nextLocalCronFire("0 0 31 2 *", "UTC", new Date("2026-01-01T00:00:00.000Z"), 30)).toBeNull();
  });
});
