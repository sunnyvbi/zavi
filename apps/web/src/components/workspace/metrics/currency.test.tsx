import { describe, expect, it } from "vitest";
import { currencyFromUnit, formatCurrency } from "./currency";
import { formatMetricValue, metricDelta } from "./format";

describe("currency formatting", () => {
  it("keeps currency units distinct from ratios and counts", () => {
    expect(currencyFromUnit("currency:INR")).toBe("INR");
    expect(currencyFromUnit("count")).toBeNull();
    expect(currencyFromUnit("currency:null")).toBeNull();
    expect(formatMetricValue({ value: 20.5, unit: "currency:GBP" })).toBe("GBP 20.50");
    expect(formatMetricValue({ value: 20, unit: "count" })).toBe("20");
  });

  it("does not guess a missing currency or amount", () => {
    expect(formatCurrency(10, null)).toBe("-");
    expect(formatCurrency(null, "INR")).toBe("-");
    expect(formatCurrency(Number.NaN, "USD")).toBe("-");
  });

  it("preserves currency for a delta from zero", () => {
    expect(metricDelta({ key: "spend", value: 20, unit: "currency:GBP", prev_value: 0, grounded: true, day: "2026-10-01", prev_day: "2026-09-30", window_kind: "30d" })?.text).toBe("+GBP 20");
  });
});
