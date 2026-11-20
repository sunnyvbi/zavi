import { describe, it, expect } from "vitest";
import {
  GOAL_METRIC_OPTIONS,
  findMetricOption,
  composeObjective,
  formatTargetValue,
  isoDateInDays,
  humanDate,
} from "./goalMetricOptions";

const NOW = new Date("2026-08-01T12:00:00Z");

describe("goal metric catalogue", () => {
  it("has no duplicate values (a dupe would break the <select>)", () => {
    const values = GOAL_METRIC_OPTIONS.map((o) => o.value);
    expect(new Set(values).size).toBe(values.length);
  });

  it("marks GMV as NOT measurable", () => {
    expect(findMetricOption("gmv")?.measurable).toBe(false);
  });

  it("marks mrr/arr as measurable", () => {
    expect(findMetricOption("mrr")?.measurable).toBe(true);
    expect(findMetricOption("arr")?.measurable).toBe(true);
  });

  it("every option value is lowercase and non-empty (it is stored verbatim)", () => {
    for (const o of GOAL_METRIC_OPTIONS) {
      expect(o.value.length).toBeGreaterThan(0);
      expect(o.value).toBe(o.value.toLowerCase());
    }
  });
});

describe("formatTargetValue", () => {
  it("adds a $ and thousands separators for usd", () => {
    expect(formatTargetValue("50000", "usd")).toBe("$50,000");
  });
  it("groups counts without a currency symbol", () => {
    expect(formatTargetValue("1500", "count")).toBe("1,500");
  });
  it("passes non-numeric text straight through", () => {
    expect(formatTargetValue("abc", "usd")).toBe("abc");
  });
});

describe("isoDateInDays / humanDate", () => {
  it("resolves a 90-day timeframe to a real ISO date", () => {
    expect(isoDateInDays(90, NOW)).toBe("2026-10-30");
  });
  it("renders a short human date without the year when it matches", () => {
    expect(humanDate("2026-10-30", NOW)).toBe("Oct 30");
  });
  it("includes the year when it differs", () => {
    expect(humanDate("2027-01-15", NOW)).toContain("2027");
  });
});

describe("composeObjective", () => {
  const base = { customMetric: "", dueDateIso: "", now: NOW };

  it("builds the sentence from the picks", () => {
    expect(
      composeObjective({
        ...base,
        metricValue: "mrr",
        targetValue: "50000",
        dueDateIso: "2026-10-30",
      }),
    ).toBe("Grow MRR to $50,000 by Oct 30");
  });

  it("strips the parenthetical from the option label", () => {
    const out = composeObjective({
      ...base,
      metricValue: "mrr",
      targetValue: "1000",
    });
    expect(out).toBe("Grow MRR to $1,000");
    expect(out).not.toContain("(");
  });

  it("omits the deadline when there isn't one", () => {
    expect(
      composeObjective({ ...base, metricValue: "bookings", targetValue: "500" }),
    ).toBe("Grow Bookings to 500");
  });

  it("uses the custom metric name when 'Something else' is picked", () => {
    expect(
      composeObjective({
        ...base,
        metricValue: "__custom__",
        customMetric: "podcast listeners",
        targetValue: "2000",
      }),
    ).toBe("Grow podcast listeners to 2,000");
  });

  it("returns empty until there is enough to say (drives the preview)", () => {
    expect(composeObjective({ ...base, metricValue: "", targetValue: "" })).toBe("");
    expect(composeObjective({ ...base, metricValue: "mrr", targetValue: "" })).toBe("");
    expect(
      composeObjective({
        ...base,
        metricValue: "__custom__",
        customMetric: "   ",
        targetValue: "10",
      }),
    ).toBe("");
  });
});
