import { describe, it, expect } from "vitest";
import { verifyMapping } from "../verify";
import type { CollectionSketch } from "../sample-mongo";
import type { DetectedMapping } from "../detect";

function sketch(fields: CollectionSketch["fields"]): CollectionSketch[] {
  return [{ collection: "trips", approx_count: 100, fields, status_candidates: [] }];
}
function baseMapping(over: Partial<DetectedMapping> = {}): DetectedMapping {
  return {
    booking_source: "trips",
    date_field: "createdAt",
    status_field: "status",
    completed_statuses: ["completed"],
    revenue_field: "price.finalPrice",
    amount_unit: "dollars",
    refund_field: null,
    currency: "USD",
    confidence: "high",
    blockers: [],
    reasoning: "",
    ...over,
  };
}

describe("verifyMapping", () => {
  it("keeps a plausible dollar revenue field", () => {
    const v = verifyMapping(
      baseMapping(),
      sketch([{ path: "price.finalPrice", types: ["number"], examples: [89, 8187], numeric_stats: { min: 89, max: 8187, nonzero_frac: 1 } }]),
    );
    expect(v.revenue_field).toBe("price.finalPrice");
    expect(v.verification.revenue_ok).toBe(true);
  });

  it("downgrades to count-only when the revenue field is mostly zero", () => {
    const v = verifyMapping(
      baseMapping({ revenue_field: "depositAmount" }),
      sketch([{ path: "depositAmount", types: ["number"], examples: [0, 0, 200], numeric_stats: { min: 0, max: 200, nonzero_frac: 0.25 } }]),
    );
    expect(v.revenue_field).toBeNull();
    expect(v.verification.revenue_ok).toBe(false);
    expect(v.verification.downgrades.join(" ")).toMatch(/zero/);
  });

  it("keeps a cents/minor-unit field natively (amount_unit=cents, forces confirm)", () => {
    const v = verifyMapping(
      baseMapping({ amount_unit: "cents", revenue_field: "amountCents" }),
      sketch([{ path: "amountCents", types: ["number"], examples: [4999, 129900], numeric_stats: { min: 4999, max: 129900, nonzero_frac: 1 } }]),
    );
    expect(v.revenue_field).toBe("amountCents");
    expect(v.amount_unit).toBe("cents");
    expect(v.verification.revenue_ok).toBe(true);
    expect(v.verification.needs_confirm_reasons.join(" ")).toMatch(/cents|minor-unit/);
  });

  it("infers cents from a large-integer field when unit is unknown (kept, confirm)", () => {
    const v = verifyMapping(
      baseMapping({ amount_unit: "unknown", revenue_field: "amountCents", currency: "USD" }),
      sketch([{ path: "amountCents", types: ["number"], examples: [4999, 129900], numeric_stats: { min: 4999, max: 129900, nonzero_frac: 1 } }]),
    );
    expect(v.revenue_field).toBe("amountCents");
    expect(v.amount_unit).toBe("cents");
    expect(v.verification.needs_confirm_reasons.join(" ")).toMatch(/cents|minor-unit/);
  });

  it("resolves a plain dollar field to amount_unit=dollars", () => {
    const v = verifyMapping(
      baseMapping({ amount_unit: "dollars", revenue_field: "price.finalPrice" }),
      sketch([{ path: "price.finalPrice", types: ["number"], examples: [89, 8187], numeric_stats: { min: 89, max: 8187, nonzero_frac: 1 } }]),
    );
    expect(v.revenue_field).toBe("price.finalPrice");
    expect(v.amount_unit).toBe("dollars");
  });

  it("downgrades when the revenue field has no numeric samples", () => {
    const v = verifyMapping(
      baseMapping({ revenue_field: "notes" }),
      sketch([{ path: "notes", types: ["string"], examples: ["a", "b"] }]),
    );
    expect(v.revenue_field).toBeNull();
  });

  it("forces confirm when a status field has no completed values", () => {
    const v = verifyMapping(
      baseMapping({ completed_statuses: [] }),
      sketch([{ path: "price.finalPrice", types: ["number"], examples: [89], numeric_stats: { min: 89, max: 8187, nonzero_frac: 1 } }]),
    );
    expect(v.verification.needs_confirm_reasons.join(" ")).toMatch(/completed-status/);
  });

  it("flags confirm when revenue kept but currency unknown", () => {
    const v = verifyMapping(
      baseMapping({ currency: null }),
      sketch([{ path: "price.finalPrice", types: ["number"], examples: [89], numeric_stats: { min: 89, max: 8187, nonzero_frac: 1 } }]),
    );
    expect(v.revenue_field).toBe("price.finalPrice");
    expect(v.verification.needs_confirm_reasons.join(" ")).toMatch(/currency/);
  });

  it("downgrades a tiny-magnitude field (rating/fraction, not a txn total: max < 0.5)", () => {
    const v = verifyMapping(
      baseMapping({ amount_unit: "dollars", revenue_field: "rating" }),
      sketch([{ path: "rating", types: ["number"], examples: [0.02, 0.001], numeric_stats: { min: 0.001, max: 0.02, nonzero_frac: 1 } }]),
    );
    expect(v.revenue_field).toBeNull();
    expect(v.verification.revenue_ok).toBe(false);
    expect(v.verification.downgrades.join(" ")).toMatch(/plausible per-transaction range/);
  });

  it("downgrades an implausibly huge field (id/epoch, not a txn total: min > 1e6)", () => {
    const v = verifyMapping(
      baseMapping({ amount_unit: "dollars", revenue_field: "externalId" }),
      sketch([
        { path: "externalId", types: ["number"], examples: [5_000_000, 9_000_000], numeric_stats: { min: 5_000_000, max: 9_000_000, nonzero_frac: 1 } },
      ]),
    );
    expect(v.revenue_field).toBeNull();
    expect(v.verification.revenue_ok).toBe(false);
    expect(v.verification.downgrades.join(" ")).toMatch(/plausible per-transaction range/);
  });

  it("keeps revenue when a refund_field is present (net>gross guard is the rollup's job, not verify's)", () => {
    const v = verifyMapping(
      baseMapping({ revenue_field: "price.finalPrice", refund_field: "refundAmount" }),
      sketch([
        { path: "price.finalPrice", types: ["number"], examples: [89, 8187], numeric_stats: { min: 89, max: 8187, nonzero_frac: 1 } },
        { path: "refundAmount", types: ["number"], examples: [0, 250], numeric_stats: { min: 0, max: 250, nonzero_frac: 0.4 } },
      ]),
    );
    expect(v.revenue_field).toBe("price.finalPrice");
    expect(v.verification.revenue_ok).toBe(true);
    expect(v.refund_field).toBe("refundAmount");
  });
});
