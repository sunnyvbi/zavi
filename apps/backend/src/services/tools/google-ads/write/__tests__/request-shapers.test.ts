import { describe, it, expect } from "vitest";
import {
  newTempIds,
  shapeAd,
  shapeAdGroupOperations,
  shapeCreateCampaignOperations,
  shapeKeywordOperations,
  shapeUpdateAdGroupOperation,
  shapeUpdateCampaignOperation,
} from "../_request-shapers";
import { createCampaignBodySchema } from "../_decision-bodies";

const CID = "1234567890";

describe("shapeCreateCampaignOperations", () => {
  it("creates budget then campaign then criteria then ad group, keywords and ads with unique temp ids", () => {
    const body = createCampaignBodySchema.parse({
      name: "Launch",
      channel_type: "SEARCH",
      daily_budget_usd: 25.5,
      bidding: { strategy: "MAXIMIZE_CONVERSIONS", target_cpa_usd: 10 },
      location_ids: [2840],
      ad_group: {
        name: "Core",
        type: "SEARCH_STANDARD",
        cpc_bid_usd: 0.05,
        keywords: [{ text: "zavi", match_type: "EXACT" }],
        ads: [{ kind: "responsive_search", final_urls: ["https://example.com"], headlines: ["a", "b", "c"], descriptions: ["d", "e"] }],
      },
    });
    const shaped = shapeCreateCampaignOperations(body, CID);
    const services = shaped.ops.map((o) => o.service);
    expect(services).toEqual(["campaignBudgets", "campaigns", "campaignCriteria", "adGroups", "adGroupCriteria", "adGroupAds"]);
    const budget = shaped.ops[0] as { create: Record<string, unknown> };
    expect(budget.create.amountMicros).toBe("25500000");
    expect(budget.create.resourceName).toBe(`customers/${CID}/campaignBudgets/-1`);
    const campaign = shaped.ops[1] as { create: Record<string, unknown> };
    expect(campaign.create.status).toBe("PAUSED");
    expect(campaign.create.containsEuPoliticalAdvertising).toBe("DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING");
    expect(campaign.create.campaignBudget).toBe(`customers/${CID}/campaignBudgets/-1`);
    expect(campaign.create.maximizeConversions).toEqual({ targetCpaMicros: "10000000" });
    const adGroup = shaped.ops[3] as { create: Record<string, unknown> };
    expect(adGroup.create.status).toBe("ENABLED");
    expect(adGroup.create.cpcBidMicros).toBe("50000");
    const ad = shaped.ops[5] as unknown as { create: { ad: { responsiveSearchAd: unknown }; status: string } };
    expect(ad.create.status).toBe("ENABLED");
    expect(ad.create.ad.responsiveSearchAd).toBeDefined();
    const temps = shaped.ops.flatMap((o) => ("create" in o && typeof o.create.resourceName === "string" ? [o.create.resourceName] : []));
    expect(new Set(temps).size).toBe(temps.length);
  });

  it("an ad group or ad added to an existing campaign stays PAUSED (that campaign may be live)", () => {
    const group = shapeAdGroupOperations(
      { name: "Core", type: "SEARCH_STANDARD", keywords: [], ads: [] } as never,
      `customers/${CID}/campaigns/1`,
      newTempIds(CID),
    );
    expect((group.ops[0] as { create: Record<string, unknown> }).create.status).toBe("PAUSED");
  });

  it("defaults SEARCH network settings to Google Search only", () => {
    const body = createCampaignBodySchema.parse({
      name: "Brand",
      channel_type: "SEARCH",
      daily_budget_usd: 10,
      bidding: { strategy: "MANUAL_CPC" },
    });
    const campaign = shapeCreateCampaignOperations(body, CID).ops[1] as { create: Record<string, unknown> };
    expect(campaign.create.networkSettings).toEqual({
      targetGoogleSearch: true,
      targetSearchNetwork: false,
      targetContentNetwork: false,
      targetPartnerSearchNetwork: false,
    });
    expect(campaign.create.manualCpc).toEqual({ enhancedCpcEnabled: false });
  });
});

describe("shapeAd", () => {
  it("shapes a responsive search ad", () => {
    const out = shapeAd(
      { kind: "responsive_search", final_urls: ["https://x.com"], headlines: ["a", "b", "c"], descriptions: ["d", "e"], path1: "p" },
    ) as { responsiveSearchAd: { headlines: unknown[]; path1: string } };
    expect(out.responsiveSearchAd.headlines).toEqual([{ text: "a" }, { text: "b" }, { text: "c" }]);
    expect(out.responsiveSearchAd.path1).toBe("p");
  });
});

describe("shapeKeywordOperations", () => {
  it("marks campaign keywords negative and ad-group keywords enabled", () => {
    const camp = shapeKeywordOperations([{ text: "free", match_type: "BROAD" }], { campaign_resource: "customers/1/campaigns/2" });
    expect(camp[0]).toEqual({ service: "campaignCriteria", create: { campaign: "customers/1/campaigns/2", negative: true, keyword: { text: "free", matchType: "BROAD" } } });
    const ag = shapeKeywordOperations([{ text: "zavi", match_type: "EXACT" }], { ad_group_resource: "customers/1/adGroups/3", negative: false });
    expect(ag[0]).toEqual({ service: "adGroupCriteria", create: { adGroup: "customers/1/adGroups/3", status: "ENABLED", keyword: { text: "zavi", matchType: "EXACT" } } });
  });
});

describe("shapeUpdateCampaignOperation", () => {
  it("routes target CPA to the field of the live bidding strategy and builds the mask", () => {
    const op = shapeUpdateCampaignOperation(
      { campaign_id: "1", target_cpa_usd: 12, new_name: "Renamed", rationale: "" },
      { campaign_resource: "customers/1/campaigns/1", bidding_strategy_type: "MAXIMIZE_CONVERSIONS" },
    );
    expect(op).toEqual({
      service: "campaigns",
      update: { resourceName: "customers/1/campaigns/1", name: "Renamed", maximizeConversions: { targetCpaMicros: "12000000" } },
      updateMask: "name,maximize_conversions.target_cpa_micros",
    });
  });

  it("refuses a target CPA on a manual CPC campaign", () => {
    expect(() =>
      shapeUpdateCampaignOperation(
        { campaign_id: "1", target_cpa_usd: 12, rationale: "" },
        { campaign_resource: "customers/1/campaigns/1", bidding_strategy_type: "MANUAL_CPC" },
      ),
    ).toThrow(/target_cpa_usd cannot be set/);
  });
});

describe("shapeUpdateAdGroupOperation", () => {
  it("masks exactly the changed fields", () => {
    const op = shapeUpdateAdGroupOperation({ ad_group_id: "3", cpc_bid_usd: 1.25, rationale: "" }, "customers/1/adGroups/3");
    expect(op).toEqual({ service: "adGroups", update: { resourceName: "customers/1/adGroups/3", cpcBidMicros: "1250000" }, updateMask: "cpc_bid_micros" });
  });
});

describe("shapeCreateCampaignOperations: Demand Gen video", () => {
  const T = "11111111-1111-4111-8111-111111111111";
  const SHA = "b".repeat(64);
  const body = createCampaignBodySchema.parse({
    name: "YT launch",
    channel_type: "DEMAND_GEN",
    daily_budget_usd: 30,
    bidding: { strategy: "MAXIMIZE_CONVERSIONS" },
    location_ids: [2840],
    language_ids: [1000],
    demand_gen_ad_group: {
      name: "YT launch – video",
      ad: {
        final_urls: ["https://example.com"],
        youtube_video_ids: ["dQw4w9WgXcQ", "9bZkp7q19f0"],
        headlines: ["Book a car"],
        long_headlines: ["Book a car near you in minutes"],
        descriptions: ["Cars from local hosts"],
        business_name: "Upcar",
        logo: { storage_path: `${T}/logos/${SHA}.png`, sha256: SHA, mime: "image/png", width: 256, height: 256 },
      },
    },
    rationale: "r",
  });
  const shaped = shapeCreateCampaignOperations(body, CID, { logoData: "QUJD" });
  const by = (svc: string) => shaped.ops.filter((o) => o.service === svc) as Array<{ create: Record<string, any> }>;

  it("serves exactly YouTube in-stream, in-feed, Shorts, Discover and Gmail; never Display or Maps", () => {
    expect(by("adGroups")[0].create.demandGenAdGroupSettings).toEqual({
      channelControls: {
        selectedChannels: { youtubeInStream: true, youtubeInFeed: true, youtubeShorts: true, discover: true, gmail: true, display: false, maps: false },
      },
    });
  });

  it("the campaign is PAUSED with its ad group and ad ENABLED under it (one switch), on maximize conversions", () => {
    expect(by("campaigns")[0].create).toMatchObject({ advertisingChannelType: "DEMAND_GEN", status: "PAUSED", maximizeConversions: {} });
    expect(by("campaigns")[0].create.networkSettings).toBeUndefined();
    expect(by("adGroups")[0].create.status).toBe("ENABLED");
    expect(by("adGroups")[0].create.type).toBeUndefined();
    expect(by("adGroupAds")[0].create.status).toBe("ENABLED");
    expect(shaped.ops.filter((o) => "create" in o && (o.create as { status?: string }).status === "PAUSED").map((o) => o.service)).toEqual(["campaigns"]);
    expect(by("campaignBudgets")[0].create.explicitlyShared).toBe(false);
  });

  it("location and language are ad-group criteria; no campaign criteria", () => {
    expect(by("campaignCriteria")).toHaveLength(0);
    const ag = shaped.ad_group_resource;
    expect(by("adGroupCriteria").map((o) => o.create)).toEqual([
      { adGroup: ag, location: { geoTargetConstant: "geoTargetConstants/2840" } },
      { adGroup: ag, language: { languageConstant: "languageConstants/1000" } },
    ]);
  });

  it("one YouTube asset per video, one IMAGE asset from the stored bytes, and the Demand Gen ad links them", () => {
    const assets = by("assets").map((o) => o.create);
    expect(assets.filter((a) => a.youtubeVideoAsset).map((a) => a.youtubeVideoAsset.youtubeVideoId)).toEqual(["dQw4w9WgXcQ", "9bZkp7q19f0"]);
    const image = assets.find((a) => a.imageAsset)!;
    expect(image).toMatchObject({ type: "IMAGE", name: "YT launch – video – logo", imageAsset: { data: "QUJD" } });
    const ad = by("adGroupAds")[0].create;
    expect(ad.adGroup).toBe(shaped.ad_group_resource);
    expect(ad.ad.finalUrls).toEqual(["https://example.com"]);
    expect(ad.ad.demandGenVideoResponsiveAd).toEqual({
      headlines: [{ text: "Book a car" }],
      longHeadlines: [{ text: "Book a car near you in minutes" }],
      descriptions: [{ text: "Cars from local hosts" }],
      videos: assets.filter((a) => a.youtubeVideoAsset).map((a) => ({ asset: a.resourceName })),
      logoImages: [{ asset: image.resourceName }],
      businessName: { text: "Upcar" },
    });
  });

  it("orders the ops so every temp id exists before it is referenced, all unique", () => {
    expect(shaped.ops.map((o) => o.service)).toEqual([
      "campaignBudgets", "campaigns", "adGroups", "adGroupCriteria", "adGroupCriteria", "assets", "assets", "assets", "adGroupAds",
    ]);
    const names = shaped.ops.map((o) => ("create" in o ? (o.create.resourceName as string | undefined) : undefined)).filter(Boolean);
    expect(new Set(names).size).toBe(names.length);
  });

  it("refuses to build without the logo bytes", () => {
    expect(() => shapeCreateCampaignOperations(body, CID)).toThrow(expect.objectContaining({ code: "google_ads_demand_gen_logo_missing" }));
  });

  it("a SEARCH body shapes exactly as before, with campaign criteria and no ad-group settings", () => {
    const search = createCampaignBodySchema.parse({ name: "S", channel_type: "SEARCH", daily_budget_usd: 5, bidding: { strategy: "MANUAL_CPC" }, location_ids: [2840], rationale: "" });
    const s = shapeCreateCampaignOperations(search, CID);
    expect(s.ops.map((o) => o.service)).toEqual(["campaignBudgets", "campaigns", "campaignCriteria"]);
    expect(s.ad_group_resource).toBeNull();
  });
});

describe("shapeCreateCampaignOperations: excluded places", () => {
  const base = { name: "S", channel_type: "SEARCH", daily_budget_usd: 5, bidding: { strategy: "MANUAL_CPC" }, location_ids: [21176], rationale: "" };

  it("adds each excluded place as a negative campaign location", () => {
    const body = createCampaignBodySchema.parse({ ...base, excluded_location_ids: [1026339] });
    const crit = shapeCreateCampaignOperations(body, CID).ops.filter((o) => o.service === "campaignCriteria").map((o) => (o as { create: Record<string, unknown> }).create);
    expect(crit).toEqual([
      expect.objectContaining({ location: { geoTargetConstant: "geoTargetConstants/21176" } }),
      expect.objectContaining({ negative: true, location: { geoTargetConstant: "geoTargetConstants/1026339" } }),
    ]);
    expect(crit[0]).not.toHaveProperty("negative");
  });

  it("an old body with no exclusions shapes no negative location", () => {
    const body = createCampaignBodySchema.parse(base);
    expect(body.excluded_location_ids).toEqual([]);
    expect(shapeCreateCampaignOperations(body, CID).ops.some((o) => "create" in o && (o.create as { negative?: boolean }).negative)).toBe(false);
  });

  it("refuses a place both targeted and excluded", () => {
    expect(createCampaignBodySchema.safeParse({ ...base, excluded_location_ids: [21176] }).success).toBe(false);
  });
});
