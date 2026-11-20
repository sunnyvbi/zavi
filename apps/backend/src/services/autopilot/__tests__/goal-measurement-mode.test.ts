import { describe, expect, it } from "vitest";
import { canMeasureAutomatically, validateMeasurementMode } from "../goal-measurement-mode";

describe("auto is only for a metric the real resolver can read", () => {
  it("accepts mrr (Stripe) and bookings (the operator database)", () => {
    expect(canMeasureAutomatically("mrr")).toBe(true);
    expect(canMeasureAutomatically("weekly bookings")).toBe(true);
    expect(validateMeasurementMode("auto", "mrr")).toEqual({ ok: true, value: "auto" });
  });

  it("rejects cac, roas, revenue and revenue per user, which the wording vocabulary would have allowed", () => {
    for (const metric of ["cac", "roas", "revenue", "revenue per user"]) {
      expect(canMeasureAutomatically(metric), metric).toBe(false);
      const v = validateMeasurementMode("auto", metric);
      expect(v.ok, metric).toBe(false);
      if (!v.ok) expect(v.code).toBe("measurement_unavailable");
    }
  });

  it("accepts auto for gross revenue (Stripe payments, last 30 days), and only when named explicitly", () => {
    for (const metric of ["gross revenue", "gross_revenue", "gross volume", "monthly gross revenue"]) {
      expect(canMeasureAutomatically(metric), metric).toBe(true);
    }
    for (const metric of ["revenue", "monthly revenue"]) {
      expect(canMeasureAutomatically(metric), metric).toBe(false);
    }
  });

  it("always accepts manual_reported, and nothing else", () => {
    expect(validateMeasurementMode("manual_reported", "revenue")).toEqual({ ok: true, value: "manual_reported" });
    expect(validateMeasurementMode(undefined, "revenue")).toEqual({ ok: true, value: undefined });
    expect(validateMeasurementMode("sometimes", "mrr").ok).toBe(false);
  });
});
