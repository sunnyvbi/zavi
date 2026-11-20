import { describe, expect, it } from "vitest";
import { clampTest, parseMoveTest } from "../cgo-tests";
import { envelopeDays, isServerEnvelope, legacyTestTotalUsd, newObjectEnvelope, raiseEnvelope, testEndsOn } from "../test-envelope";

const TEST = { variable: "a new search campaign", baseline: "0 leads a week", success_if: "5 leads", readout_on: "2026-11-03" };

describe("the server derives a test's envelope, never the model", () => {
  it("clampTest marks the test and never rewrites the model's total from the order's spare capacity", () => {
    const t = clampTest({ ...TEST, budget_usd: 670 }, "2026-10-20");
    expect(t.budget_usd).toBe(670);
    expect(t.envelope).toBe("server");
    expect(isServerEnvelope(t)).toBe(true);
    expect(legacyTestTotalUsd(t)).toBeNull();
    expect(t.readout_on).toBe("2026-11-03");
    expect(parseMoveTest(JSON.parse(JSON.stringify(t)))?.envelope).toBe("server");
  });

  it("a new object: its daily x the days from activation to the readout day", () => {
    const ends_on = testEndsOn("2026-10-20T10:00:00Z", { readout_on: "2026-11-03" }, "2026-10-20T15:00:00Z");
    expect(ends_on).toBe("2026-11-03");
    expect(newObjectEnvelope({ daily_usd: 48, activated_at: "2026-10-20T15:00:00Z", ends_on })).toEqual({
      kind: "gross_since_start", daily_usd: 48, days: 14, amount_usd: 672, started_at: "2026-10-20T15:00:00Z", ends_on: "2026-11-03",
    });
  });

  it("a late activation moves the end day by a full window, and the envelope with it", () => {
    const ends_on = testEndsOn("2026-10-20T10:00:00Z", { readout_on: "2026-11-03" }, "2026-10-25T09:00:00Z");
    expect(ends_on).toBe("2026-11-08");
    expect(newObjectEnvelope({ daily_usd: 10.5, activated_at: "2026-10-25T09:00:00Z", ends_on })?.amount_usd).toBe(147);
  });

  it("a raise: only the extra daily over the baseline counts; a cut or no change has none", () => {
    expect(raiseEnvelope({ daily_usd: 149, baseline_daily_usd: 120, launched_at: "2026-10-20T05:06:41Z", ends_on: "2026-10-27" })).toMatchObject({
      kind: "extra_over_baseline", extra_daily_usd: 29, days: 7, amount_usd: 203,
    });
    expect(raiseEnvelope({ daily_usd: 0.38 + 48, baseline_daily_usd: 48, launched_at: "2026-10-20T00:00:00Z", ends_on: "2026-11-03" })?.amount_usd).toBe(5.32);
    expect(raiseEnvelope({ daily_usd: 100, baseline_daily_usd: 120, launched_at: "2026-10-20T00:00:00Z", ends_on: "2026-10-27" })).toBeNull();
    expect(raiseEnvelope({ daily_usd: 120, baseline_daily_usd: 120, launched_at: "2026-10-20T00:00:00Z", ends_on: "2026-10-27" })).toBeNull();
  });

  it("an unusable amount or an empty window gives no envelope (the end day still stops the test)", () => {
    for (const daily of [0, -5, Number.NaN, "48", null, undefined]) {
      expect(newObjectEnvelope({ daily_usd: daily, activated_at: "2026-10-20T00:00:00Z", ends_on: "2026-11-03" }), String(daily)).toBeNull();
      expect(raiseEnvelope({ daily_usd: daily, baseline_daily_usd: 10, launched_at: "2026-10-20T00:00:00Z", ends_on: "2026-11-03" }), String(daily)).toBeNull();
    }
    expect(newObjectEnvelope({ daily_usd: 48, activated_at: "2026-11-03T01:00:00Z", ends_on: "2026-11-03" })).toBeNull();
    expect(envelopeDays("2026-11-05T00:00:00Z", "2026-11-03")).toBe(0);
  });

  it("a legacy test keeps the total it was filed with; old rows are read, never rewritten", () => {
    expect(legacyTestTotalUsd({ budget_usd: 203 })).toBe(203);
    expect(legacyTestTotalUsd({ budget_usd: 0 })).toBeNull();
    expect(legacyTestTotalUsd({})).toBeNull();
    expect(legacyTestTotalUsd({ budget_usd: 203, envelope: "server" })).toBeNull();
    expect(parseMoveTest({ ...TEST, budget_usd: 50, envelope: "client" })).toMatchObject({ budget_usd: 50 });
    expect(parseMoveTest({ ...TEST, budget_usd: 50, envelope: "client" })?.envelope).toBeUndefined();
  });
});
