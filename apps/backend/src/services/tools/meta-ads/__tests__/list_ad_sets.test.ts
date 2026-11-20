
import { describe, it, expect } from "vitest";
import {
  mergeAdSetDetails,
  classifyCampaignBudgeting,
  metaOptimizationEvent,
} from "../list_ad_sets";

describe("mergeAdSetDetails", () => {
  const baseInsight = {
    adset_id: "120252798081830059",
    adset_name: "Regular Rentals Purchases",
    campaign_id: "120252798081800059",
    spend: "22.98",
    impressions: "1829",
    clicks: "18",
    ctr: "0.98",
    cpc: "1.28",
    reach: "522",
    actions: [{ action_type: "purchase", value: "2" }],
    action_values: [{ action_type: "purchase", value: "323.80" }],
  };

  it("merges insight metrics with ad-set detail fields for USD accounts", () => {
    const detail = {
      "120252798081830059": {
        daily_budget: "5000",
        lifetime_budget: null,
        status: "ACTIVE",
        configured_status: "ACTIVE",
        effective_status: "ACTIVE",
        optimization_goal: "OFFSITE_CONVERSIONS",
        targeting: {
          geo_locations: {
            cities: [{ key: "2487956", name: "San Francisco", region: "California" }],
            location_types: ["home", "recent"],
          },
        },
      },
    };

    const out = mergeAdSetDetails([baseInsight], detail, "USD");

    expect(out).toHaveLength(1);
    const row = out[0]!;
    expect(row.spend_usd).toBe(22.98);
    expect(row.purchases).toBe(2);
    expect(row.roas).toBeCloseTo(14.09, 2);
    expect(row.daily_budget_usd).toBe(50);
    expect(row.lifetime_budget_usd).toBeNull();
    expect(row.daily_budget_minor_units).toBe("5000");
    expect(row.status).toBe("ACTIVE");
    expect(row.effective_status).toBe("ACTIVE");
    expect(row.optimization_goal).toBe("OFFSITE_CONVERSIONS");
    expect(row.optimization_event).toBe("Conversion");
    expect(row.geo_locations).toEqual({
      cities: [{ key: "2487956", name: "San Francisco", region: "California" }],
      location_types: ["home", "recent"],
    });
  });

  it("returns null daily_budget_usd for non-USD accounts but still surfaces raw minor units", () => {
    const detail = {
      "120252798081830059": {
        daily_budget: "5000",
        status: "ACTIVE",
        targeting: { geo_locations: { countries: ["GB"] } },
      },
    };

    const out = mergeAdSetDetails([baseInsight], detail, "GBP");
    const row = out[0]!;

    expect(row.daily_budget_usd).toBeNull();
    expect(row.daily_budget_minor_units).toBe("5000");
    expect(row.geo_locations).toEqual({ countries: ["GB"] });
  });

  it("emits null details when detailMap has no entry for the ad-set", () => {
    const out = mergeAdSetDetails([baseInsight], {}, "USD");
    const row = out[0]!;

    expect(row.ad_set_id).toBe("120252798081830059");
    expect(row.spend_usd).toBe(22.98);
    expect(row.daily_budget_usd).toBeNull();
    expect(row.daily_budget_minor_units).toBeNull();
    expect(row.geo_locations).toBeNull();
    expect(row.status).toBeNull();
    expect(row.optimization_event).toBeNull();
  });

  it("treats USD currency case-insensitively (Meta returns 'USD' uppercase but defend against drift)", () => {
    const detail = {
      "120252798081830059": { daily_budget: "10000" },
    };
    expect(mergeAdSetDetails([baseInsight], detail, "usd")[0]!.daily_budget_usd).toBe(100);
    expect(mergeAdSetDetails([baseInsight], detail, "Usd")[0]!.daily_budget_usd).toBe(100);
  });
});

describe("metaOptimizationEvent (real objective disambiguation)", () => {
  it("two ad sets sharing optimization_goal=OFFSITE_CONVERSIONS resolve to DIFFERENT events", () => {
    const purchase = metaOptimizationEvent({
      optimization_goal: "OFFSITE_CONVERSIONS",
      promoted_object: { custom_event_type: "PURCHASE" },
    });
    const checkout = metaOptimizationEvent({
      optimization_goal: "OFFSITE_CONVERSIONS",
      promoted_object: { custom_event_type: "INITIATED_CHECKOUT" },
    });
    expect(purchase).toBe("Purchase");
    expect(checkout).toBe("InitCheckout");
    expect(purchase).not.toBe(checkout);
  });

  it("prefers the conversion event over the coarse optimization_goal", () => {
    expect(
      metaOptimizationEvent({
        optimization_goal: "OFFSITE_CONVERSIONS",
        promoted_object: { custom_event_type: "COMPLETE_REGISTRATION" },
      }),
    ).toBe("Signup");
  });

  it("falls back to the goal label when there is no conversion event (traffic/awareness)", () => {
    expect(metaOptimizationEvent({ optimization_goal: "LINK_CLICKS" })).toBe("Clicks");
    expect(metaOptimizationEvent({ optimization_goal: "REACH" })).toBe("Reach");
  });

  it("title-cases an unknown event/goal enum instead of leaking SCREAMING_SNAKE", () => {
    expect(
      metaOptimizationEvent({ promoted_object: { custom_event_type: "SOME_NEW_EVENT" } }),
    ).toBe("Some New Event");
  });

  it("returns null when neither event nor goal is present", () => {
    expect(metaOptimizationEvent({})).toBeNull();
    expect(metaOptimizationEvent({ promoted_object: null })).toBeNull();
  });
});

describe("classifyCampaignBudgeting (insights-independent target resolution)", () => {
  it("returns single for exactly one non-deleted ad-set-level budget (ABO)", () => {
    const cls = classifyCampaignBudgeting([
      { id: "a1", name: "Only", daily_budget: "3000", effective_status: "ACTIVE" },
    ]);
    expect(cls.kind).toBe("single");
    if (cls.kind === "single") expect(cls.adSet.id).toBe("a1");
  });

  it("counts a PAUSED zero-spend ad set — so a 2-ad-set campaign is ambiguous even when one is paused", () => {
    const cls = classifyCampaignBudgeting([
      { id: "a1", name: "Spent", daily_budget: "3000", effective_status: "ACTIVE" },
      {
        id: "a2",
        name: "Paused",
        daily_budget: "2000",
        effective_status: "PAUSED",
        configured_status: "PAUSED",
      },
    ]);
    expect(cls.kind).toBe("ambiguous");
  });

  it("returns cbo_or_none when no ad set carries its own daily_budget (CBO / campaign budget)", () => {
    const cls = classifyCampaignBudgeting([
      { id: "a1", name: "A", daily_budget: null, effective_status: "ACTIVE" },
      { id: "a2", name: "B", effective_status: "ACTIVE" },
    ]);
    expect(cls.kind).toBe("cbo_or_none");
  });

  it("excludes DELETED + ARCHIVED ad sets before counting (effective OR configured status)", () => {
    const cls = classifyCampaignBudgeting([
      { id: "a1", name: "Live", daily_budget: "3000", effective_status: "ACTIVE" },
      { id: "a2", name: "Archived", daily_budget: "9999", effective_status: "ARCHIVED" },
      { id: "a3", name: "Deleted", daily_budget: "8888", configured_status: "DELETED" },
    ]);
    expect(cls.kind).toBe("single");
    if (cls.kind === "single") expect(cls.adSet.id).toBe("a1");
  });

  it("treats a zero / non-numeric daily_budget as no ad-set budget", () => {
    const cls = classifyCampaignBudgeting([
      { id: "a1", name: "Zero", daily_budget: "0", effective_status: "ACTIVE" },
      { id: "a2", name: "Junk", daily_budget: "abc", effective_status: "ACTIVE" },
    ]);
    expect(cls.kind).toBe("cbo_or_none");
  });

  it("ignores rows with no id", () => {
    const cls = classifyCampaignBudgeting([
      { name: "no id", daily_budget: "3000", effective_status: "ACTIVE" },
      { id: "a1", name: "Real", daily_budget: "5000", effective_status: "ACTIVE" },
    ]);
    expect(cls.kind).toBe("single");
    if (cls.kind === "single") expect(cls.adSet.id).toBe("a1");
  });

  it("empty campaign → cbo_or_none (fails closed, never single)", () => {
    expect(classifyCampaignBudgeting([]).kind).toBe("cbo_or_none");
  });
});
