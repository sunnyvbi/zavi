import { describe, it, expect, vi } from "vitest";

const readGooglePlaces = vi.fn();
vi.mock("@/services/ad-locations/places", () => ({ readGooglePlaces: (...a: unknown[]) => readGooglePlaces(...a) }));
const gadsSearch = vi.fn();
vi.mock("@/services/tools/google-ads/_client", () => ({ gadsSearch: (...a: unknown[]) => gadsSearch(...a) }));

import { listLocationsTool } from "../list_locations";

describe("google_ads_list_locations", () => {
  it("names each live campaign's places, and says why when it cannot", async () => {
    readGooglePlaces.mockResolvedValue(
      new Map([
        [1001, { id: "1001", name: "Riverton, TX", kind: "City", country_code: "US" }],
        [2002, { id: "2002", name: "Ontario", kind: "State", country_code: "CA" }],
      ]),
    );
    gadsSearch.mockImplementation(async (_t: string, q: string) => {
      if (q.includes("FROM campaign_conversion_goal")) return [];
      if (q.includes("FROM campaign_criterion"))
        return [
          { campaign: { id: "11" }, campaignCriterion: { location: { geoTargetConstant: "geoTargetConstants/1001" } } },
          { campaign: { id: "11" }, campaignCriterion: { location: { geoTargetConstant: "geoTargetConstants/2002" } } },
          { campaign: { id: "13" }, campaignCriterion: { location: { geoTargetConstant: "geoTargetConstants/1001" } } },
          { campaign: { id: "13" }, campaignCriterion: { negative: true, location: { geoTargetConstant: "geoTargetConstants/3003" } } },
        ];
      return [
        { campaign: { id: "11", name: "Bakery brand search", biddingStrategyType: "MAXIMIZE_CLICKS" } },
        { campaign: { id: "12", name: "Catering leads", biddingStrategyType: "MAXIMIZE_CONVERSIONS" } },
        { campaign: { id: "13", name: "Wedding cakes", biddingStrategyType: "MAXIMIZE_CLICKS" } },
      ];
    });
    const out = (await listLocationsTool.execute({ tenant_id: "t-1", log: () => {} } as never, {})) as {
      campaigns: Array<{ campaign_id: string; campaign_name: string | null; places: unknown }>;
    };
    expect(out.campaigns.find((c) => c.campaign_id === "11")).toEqual({
      campaign_id: "11",
      campaign_name: "Bakery brand search",
      places: [
        { kind: "city", country: "US", name: "Riverton", state: "TX" },
        { kind: "state", country: "CA", name: "Ontario" },
      ],
    });
    expect(out.campaigns.find((c) => c.campaign_id === "12")).toMatchObject({ campaign_name: "Catering leads", places: null, not_listed_because: "no_location_criteria" });
    expect(out.campaigns.find((c) => c.campaign_id === "13")).toMatchObject({ places: null, not_listed_because: "location_exclusions" });
  });
});
