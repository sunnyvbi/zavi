
import { describe, it, expect } from "vitest";
import {
  updateAdSetBudgetBodySchema,
  setStatusBodySchema,
  createAdSetBodySchema,
} from "../_decision-bodies";

describe("updateAdSetBudgetBodySchema", () => {
  const valid = {
    ad_set_id: "120201234567890",
    daily_budget_usd: 25,
    expected_current_daily_budget_usd: 20,
    rationale: "ROAS 3.1 → push +25%",
    over_cap: false,
  };

  it("accepts a well-formed body", () => {
    const r = updateAdSetBudgetBodySchema.safeParse(valid);
    expect(r.success).toBe(true);
  });

  it("rejects a missing ad_set_id", () => {
    const { ad_set_id: _drop, ...rest } = valid;
    expect(updateAdSetBudgetBodySchema.safeParse(rest).success).toBe(false);
  });

  it("rejects a zero / negative budget", () => {
    expect(
      updateAdSetBudgetBodySchema.safeParse({ ...valid, daily_budget_usd: 0 }).success,
    ).toBe(false);
    expect(
      updateAdSetBudgetBodySchema.safeParse({ ...valid, daily_budget_usd: -5 }).success,
    ).toBe(false);
  });

  it("rejects a missing expected_current_daily_budget_usd (drift guard needs it)", () => {
    const { expected_current_daily_budget_usd: _drop, ...rest } = valid;
    expect(updateAdSetBudgetBodySchema.safeParse(rest).success).toBe(false);
  });

  it("rejects a missing over_cap flag", () => {
    const { over_cap: _drop, ...rest } = valid;
    expect(updateAdSetBudgetBodySchema.safeParse(rest).success).toBe(false);
  });
});

describe("setStatusBodySchema", () => {
  const valid = {
    object_id: "120201234567890",
    level: "adset" as const,
    status: "PAUSED" as const,
    rationale: "CTR collapsed",
    over_cap: false,
  };

  it("accepts a well-formed body", () => {
    expect(setStatusBodySchema.safeParse(valid).success).toBe(true);
  });

  it("rejects an out-of-enum status", () => {
    expect(
      setStatusBodySchema.safeParse({ ...valid, status: "ARCHIVED" }).success,
    ).toBe(false);
  });

  it("rejects an out-of-enum level", () => {
    expect(
      setStatusBodySchema.safeParse({ ...valid, level: "ad" }).success,
    ).toBe(false);
  });
});

describe("createAdSetBodySchema", () => {
  const valid = {
    campaign_id: "23842",
    name: "Bay Area — vans — wk20",
    daily_budget_usd: 30,
    optimization_goal: "OFFSITE_CONVERSIONS",
    promoted_object: { pixel_id: "1234567890", custom_event_type: "COMPLETE_REGISTRATION" },
    billing_event: "IMPRESSIONS",
    targeting: { geo_locations: { countries: ["US"] } },
    rationale: "wedge: van rentals SF; vans cohort outperforms",
  };

  it("accepts a well-formed body", () => {
    expect(createAdSetBodySchema.safeParse(valid).success).toBe(true);
  });

  it("rejects a missing campaign_id", () => {
    const { campaign_id: _drop, ...rest } = valid;
    expect(createAdSetBodySchema.safeParse(rest).success).toBe(false);
  });

  it("rejects an empty name", () => {
    expect(
      createAdSetBodySchema.safeParse({ ...valid, name: "" }).success,
    ).toBe(false);
  });

  it("rejects a non-object targeting", () => {
    expect(
      createAdSetBodySchema.safeParse({ ...valid, targeting: "US" }).success,
    ).toBe(false);
  });
});
