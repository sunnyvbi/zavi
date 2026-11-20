
import { describe, it, expect } from "vitest";
import { metaAdsCapsBodySchema } from "../meta-ads-caps";

describe("metaAdsCapsBodySchema", () => {
  const valid = {
    tenant_id: "73db45ff-457e-4541-bc8f-bdb625390204",
    enabled: true,
    max_daily_budget_usd: 100,
    max_pct_change_per_run: 0.25,
    max_daily_total_change_usd: 50,
  };

  it("accepts a fully-populated cap row", () => {
    expect(metaAdsCapsBodySchema.safeParse(valid).success).toBe(true);
  });

  it("accepts an enabled cap with all dimensions null (uncapped on every axis)", () => {
    const r = metaAdsCapsBodySchema.safeParse({
      tenant_id: valid.tenant_id,
      enabled: true,
    });
    expect(r.success).toBe(true);
  });

  it("rejects a non-uuid tenant_id", () => {
    expect(
      metaAdsCapsBodySchema.safeParse({ ...valid, tenant_id: "not-a-uuid" }).success,
    ).toBe(false);
  });

  it("rejects a non-boolean enabled", () => {
    expect(
      metaAdsCapsBodySchema.safeParse({ ...valid, enabled: "true" }).success,
    ).toBe(false);
  });

  it("rejects negative max_daily_budget_usd", () => {
    expect(
      metaAdsCapsBodySchema.safeParse({ ...valid, max_daily_budget_usd: -10 }).success,
    ).toBe(false);
  });

  it("rejects max_pct_change_per_run > 1", () => {
    expect(
      metaAdsCapsBodySchema.safeParse({ ...valid, max_pct_change_per_run: 1.5 }).success,
    ).toBe(false);
  });

  it("rejects max_pct_change_per_run < 0", () => {
    expect(
      metaAdsCapsBodySchema.safeParse({ ...valid, max_pct_change_per_run: -0.1 }).success,
    ).toBe(false);
  });

  it("rejects negative max_daily_total_change_usd", () => {
    expect(
      metaAdsCapsBodySchema.safeParse({ ...valid, max_daily_total_change_usd: -5 }).success,
    ).toBe(false);
  });
});
