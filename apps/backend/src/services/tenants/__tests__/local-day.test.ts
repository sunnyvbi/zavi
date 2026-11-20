
import { describe, it, expect } from "vitest";
import { tenantDayStartIso, DEFAULT_TENANT_TZ } from "../local-day";

describe("tenantDayStartIso", () => {
  it("Pacific evening: the boundary is TODAY's local midnight, not tomorrow's UTC one", () => {
    const now = new Date("2026-09-07T01:30:00Z");
    expect(tenantDayStartIso("America/Los_Angeles", now)).toBe("2026-09-06T07:00:00.000Z");
    expect(now.toISOString().slice(0, 10)).toBe("2026-09-07");
  });

  it("a 9am-local run is INSIDE the window a 6pm-local viewer sees", () => {
    const nowEvening = new Date("2026-09-07T01:30:00Z");
    const morningRun = new Date("2026-09-06T16:00:00Z");
    const start = tenantDayStartIso("America/Los_Angeles", nowEvening);
    expect(morningRun.toISOString() >= start).toBe(true);
    const oldStart = nowEvening.toISOString().slice(0, 10) + "T00:00:00Z";
    expect(morningRun.toISOString() >= oldStart).toBe(false);
  });

  it("UTC+14 (Pacific/Kiritimati): local day starts BEFORE the UTC day", () => {
    const now = new Date("2026-09-05T20:00:00Z");
    expect(tenantDayStartIso("Pacific/Kiritimati", now)).toBe("2026-09-05T10:00:00.000Z");
  });

  it("UTC-11 (Pacific/Niue): local day starts AFTER the UTC day", () => {
    const now = new Date("2026-09-06T23:00:00Z");
    expect(tenantDayStartIso("Pacific/Niue", now)).toBe("2026-09-06T11:00:00.000Z");
  });

  it("exactly AT local midnight, the day start is that same instant (inclusive)", () => {
    const midnight = new Date("2026-09-06T07:00:00.000Z");
    const start = tenantDayStartIso("America/Los_Angeles", midnight);
    expect(start).toBe("2026-09-06T07:00:00.000Z");
    expect(midnight.toISOString() >= start).toBe(true);
  });

  it("one millisecond BEFORE local midnight still belongs to the previous day", () => {
    const justBefore = new Date("2026-09-06T06:59:59.999Z");
    expect(tenantDayStartIso("America/Los_Angeles", justBefore)).toBe(
      "2026-09-05T07:00:00.000Z",
    );
  });

  it("DST spring-forward: the day that loses an hour still starts at local midnight", () => {
    const now = new Date("2026-03-08T20:00:00Z");
    expect(tenantDayStartIso("America/Los_Angeles", now)).toBe("2026-03-08T08:00:00.000Z");
  });

  it("DST fall-back: the day that gains an hour still starts at local midnight", () => {
    const now = new Date("2026-11-01T20:00:00Z");
    expect(tenantDayStartIso("America/Los_Angeles", now)).toBe("2026-11-01T07:00:00.000Z");
  });

  it("a half-hour zone (Asia/Kolkata, UTC+5:30) is handled", () => {
    const now = new Date("2026-09-06T10:00:00Z");
    expect(tenantDayStartIso("Asia/Kolkata", now)).toBe("2026-09-05T18:30:00.000Z");
  });

  it("UTC tenant: unchanged from the old behavior", () => {
    const now = new Date("2026-09-06T23:59:00Z");
    expect(tenantDayStartIso("UTC", now)).toBe("2026-09-06T00:00:00.000Z");
  });

  it("null / empty / garbage timezone degrades to UTC, never throws", () => {
    const now = new Date("2026-09-06T23:59:00Z");
    const utc = "2026-09-06T00:00:00.000Z";
    expect(tenantDayStartIso(null, now)).toBe(utc);
    expect(tenantDayStartIso(undefined, now)).toBe(utc);
    expect(tenantDayStartIso("", now)).toBe(utc);
    expect(tenantDayStartIso("Not/AZone", now)).toBe(utc);
  });

  it("the column default is a real zone the helper accepts", () => {
    const now = new Date("2026-09-07T01:30:00Z");
    expect(tenantDayStartIso(DEFAULT_TENANT_TZ, now)).toBe("2026-09-06T07:00:00.000Z");
  });
});
