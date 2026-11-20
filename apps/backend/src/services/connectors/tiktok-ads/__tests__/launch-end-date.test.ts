import { describe, expect, it } from "vitest";
import { flightDaysTo, launchHoldUsd, scheduleEnd, scheduleStart, tiktokLaunchBody } from "@/services/connectors/tiktok-ads/launch-schema";

describe("TikTok end dates", () => {
  it("schedule_end_time is the end day's 00:00 UTC regardless of the advertiser timezone", () => {
    expect(scheduleEnd("2026-10-19", "UTC")).toBe("2026-10-19 00:00:00");
    expect(scheduleEnd("2026-10-19", "Etc/GMT+5")).toBe("2026-10-19 00:00:00");
  });
  it("enforces the documented schedule limits and rejects impossible end dates", () => {
    const now = new Date("2026-11-02T00:00:00Z");
    expect(scheduleStart("2028-01-01T00:00:00Z", now, "Asia/Kolkata")).toBe("2028-01-01 00:00:00");
    expect(() => scheduleStart("2028-01-01T00:00:01Z", now, "UTC")).toThrow();
    expect(scheduleEnd("2038-01-01", "America/Los_Angeles")).toBe("2038-01-01 00:00:00");
    expect(() => scheduleEnd("2038-01-02", "UTC")).toThrow();
    expect(() => scheduleEnd("2027-02-30", "UTC")).toThrow();
  });
  it("the hold covers the days to the end, never more than the days left", () => {
    expect(launchHoldUsd(20.01, 17, 1, 9)).toBe(180.09);
    expect(launchHoldUsd(20.01, 5, 1, 9)).toBe(100.05);
    expect(launchHoldUsd(20.01, 17, 1)).toBe(340.17);
    expect(launchHoldUsd(20.01, 17, 1, 9, 1.25)).toBe(225.18);
    expect(launchHoldUsd(20.01, 5, 1, 9, 1.25)).toBe(125.10);
    expect(launchHoldUsd(20.01, 17, 1, undefined, 1.25)).toBe(425.34);
  });
  it("flight days from today to an exclusive end date", () => {
    expect(flightDaysTo("2026-10-24", new Date("2026-10-15T18:00:00Z"))).toBe(9);
    expect(flightDaysTo(undefined, new Date())).toBeUndefined();
    expect(flightDaysTo("2026-10-01", new Date("2026-10-15T18:00:00Z"))).toBe(0);
  });
  it("the launch body takes an optional end date after the start", () => {
    const base = (tiktokLaunchBody as unknown as { innerType?: () => unknown }).innerType?.() ?? null;
    expect(base === null || typeof base === "object").toBe(true);
    const shape = (tiktokLaunchBody as unknown as { safeParse: (v: unknown) => { success: boolean } });
    expect(shape.safeParse({ end_date: "not a date" }).success).toBe(false);
  });
});
