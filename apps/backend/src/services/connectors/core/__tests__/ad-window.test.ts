import { describe, expect, it } from "vitest";
import { adWindowFor } from "../ad-metrics";
import { BUILDER_RANGE_MAX_DAYS, parseBuilderRange } from "@/routes/agents/dashboard";

const now = new Date("2026-11-18T10:00:00Z");

describe("adWindowFor", () => {
  it("a preset is the last N complete days and the N days before them", () => {
    expect(adWindowFor(7, null, now)).toEqual({
      period: { from: "2026-11-11", to: "2026-11-17" },
      prev_period: { from: "2026-11-04", to: "2026-11-10" },
      days: 7,
      key: "7",
    });
  });

  it("a custom range is used as given, compared with the same number of days before it", () => {
    expect(adWindowFor(30, { since: "2026-11-04", until: "2026-11-12" }, now)).toEqual({
      period: { from: "2026-11-04", to: "2026-11-12" },
      prev_period: { from: "2026-10-26", to: "2026-11-03" },
      days: 9,
      key: "2026-11-04_2026-11-12",
    });
  });

  it("a one-day range compares with the day before", () => {
    const w = adWindowFor(30, { since: "2026-11-10", until: "2026-11-10" }, now);
    expect(w.days).toBe(1);
    expect(w.prev_period).toEqual({ from: "2026-11-09", to: "2026-11-09" });
  });
});

describe("parseBuilderRange", () => {
  it("accepts a valid range up to the limit", () => {
    expect(parseBuilderRange("2026-11-04", "2026-11-12", now)).toEqual({ since: "2026-11-04", until: "2026-11-12" });
    expect(parseBuilderRange("2026-08-21", "2026-11-18", now)).not.toBeNull();
  });

  it("refuses a range wider than the limit, a reversed range and a malformed date", () => {
    expect(BUILDER_RANGE_MAX_DAYS).toBe(90);
    expect(parseBuilderRange("2026-08-01", "2026-11-12", now)).toBeNull();
    expect(parseBuilderRange("2026-11-12", "2026-11-04", now)).toBeNull();
    expect(parseBuilderRange("11/04/2026", "2026-11-12", now)).toBeNull();
    expect(parseBuilderRange(undefined, undefined, now)).toBeNull();
  });
});
