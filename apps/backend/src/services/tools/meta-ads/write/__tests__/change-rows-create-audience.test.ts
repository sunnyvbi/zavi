import { describe, it, expect } from "vitest";
import { metaChangeRows, targetingLabel } from "../_change-rows";

describe("meta create card: Audience row", () => {
  const body = {
    campaign_id: "camp-1",
    name: "First-Time Renter - CA",
    daily_budget_usd: 50,
    optimization_goal: "LINK_CLICKS",
    billing_event: "IMPRESSIONS",
    targeting: {
      geo_locations: { countries: ["US"], regions: [{ key: "3847", name: "California" }] },
      age_min: 25,
      age_max: 54,
      flexible_spec: [{ interests: [{ id: "6003", name: "Road trips" }] }],
    },
    rationale: "Test.",
  };

  it("shows locations, ages and interests from the dispatched targeting", () => {
    const c = metaChangeRows("meta_ads.create_ad_set", body);
    const row = c?.rows.find((r) => r.item === "Audience");
    expect(row?.after).toBe("Locations: US, California · Ages 25-54 · Interests: Road trips");
  });

  it("names keys it does not spell out instead of dropping them", () => {
    expect(
      targetingLabel({ geo_locations: { countries: ["US"] }, publisher_platforms: ["instagram"] }),
    ).toBe("Locations: US · Other settings: publisher_platforms");
  });

  it("names the excluded places", () => {
    expect(
      targetingLabel({ geo_locations: { regions: [{ key: "3886", name: "Texas" }] }, excluded_geo_locations: { cities: [{ key: "2418956", name: "Dallas" }] } }),
    ).toBe("Locations: Texas · Excluded locations: Dallas");
  });

  it("keeps city radius, the 65+ ceiling and clause grouping; the flag is the reach row's job", () => {
    expect(
      targetingLabel({
        geo_locations: { cities: [{ key: "1", name: "San Mateo", radius: 50, distance_unit: "mile" }] },
        age_min: 18,
        age_max: 65,
        flexible_spec: [{ interests: [{ name: "A" }, { name: "B" }] }, { interests: [{ name: "C" }] }],
        targeting_automation: { advantage_audience: 1 },
      }),
    ).toBe(
      "Locations: San Mateo +50 mile · Ages 18-65+ · Interests: (A or B) and (C)",
    );
  });

  it("names the reach mode the server will send", () => {
    const rows = metaChangeRows("meta_ads.create_ad_set", body)?.rows ?? [];
    expect(rows.find((r) => r.item === "Audience reach")?.after).toBe("Exact audience: Meta stays inside these limits");
    const broad = metaChangeRows("meta_ads.create_ad_set", { ...body, targeting: { geo_locations: { countries: ["US"] }, age_min: 21, age_max: 65 } })?.rows ?? [];
    expect(broad.find((r) => r.item === "Audience reach")?.after).toMatch(/^Advantage audience on: only locations, languages, minimum age and excluded audiences are firm/);
  });

  it("says when targeting sets no limits", () => {
    expect(targetingLabel({})).toBe("No limits set (Meta's broadest audience)");
  });
});
