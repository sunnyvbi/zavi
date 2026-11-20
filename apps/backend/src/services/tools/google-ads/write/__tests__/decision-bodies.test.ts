import { describe, it, expect } from "vitest";
import {
  addKeywordsBodySchema,
  createAdBodySchema,
  createAdGroupBodySchema,
  createCampaignBodySchema,
  googleSetStatusBodySchema,
  removeResourceBodySchema,
  updateAdGroupBodySchema,
  updateCampaignBodySchema,
} from "../_decision-bodies";
import { gadsChangeRows } from "../_change-rows";

const rsa = {
  kind: "responsive_search" as const,
  final_urls: ["https://example.com/landing"],
  headlines: ["One", "Two", "Three"],
  descriptions: ["Desc one", "Desc two"],
};

describe("googleSetStatusBodySchema", () => {
  it("defaults level to campaign for legacy bodies", () => {
    const r = googleSetStatusBodySchema.safeParse({ campaign_id: "1", status: "PAUSED", over_cap: false });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.level).toBe("campaign");
  });

  it("requires ad_group_id at ad_group level and ad_id at ad level", () => {
    expect(googleSetStatusBodySchema.safeParse({ campaign_id: "1", level: "ad_group", status: "PAUSED", over_cap: false }).success).toBe(false);
    expect(googleSetStatusBodySchema.safeParse({ campaign_id: "1", level: "ad", ad_group_id: "2", status: "PAUSED", over_cap: false }).success).toBe(false);
    expect(googleSetStatusBodySchema.safeParse({ campaign_id: "1", level: "ad", ad_group_id: "2", ad_id: "3", status: "ENABLED", over_cap: true }).success).toBe(true);
  });
});

describe("createCampaignBodySchema", () => {
  it("accepts a search campaign with a typed first ad group", () => {
    const r = createCampaignBodySchema.safeParse({
      name: "Brand",
      channel_type: "SEARCH",
      daily_budget_usd: 20,
      bidding: { strategy: "MANUAL_CPC" },
      ad_group: { name: "Core", type: "SEARCH_STANDARD", keywords: [{ text: "zavi", match_type: "EXACT" }], ads: [rsa] },
    });
    expect(r.success).toBe(true);
  });

  it("refuses VIDEO, whatever else the body says (Google's API cannot create it)", () => {
    const bodies = [
      { name: "V", channel_type: "VIDEO", daily_budget_usd: 20, bidding: { strategy: "MANUAL_CPV" } },
      { name: "V", channel_type: "VIDEO", daily_budget_usd: 20, bidding: { strategy: "TARGET_CPM" } },
      { name: "V", channel_type: "VIDEO", daily_budget_usd: 20, bidding: { strategy: "MAXIMIZE_CONVERSIONS" } },
      { name: "V", channel_type: "VIDEO", daily_budget_usd: 20, bidding: { strategy: "MANUAL_CPM" } },
    ];
    for (const b of bodies) {
      const r = createCampaignBodySchema.safeParse(b);
      expect(r.success).toBe(false);
      if (!r.success) expect(r.error.issues.map((i) => i.message)).toContain("Google's API cannot create VIDEO campaigns");
    }
  });

  it("rejects a bidding strategy that is invalid for the channel", () => {
    const r = createCampaignBodySchema.safeParse({ name: "Brand", channel_type: "SEARCH", daily_budget_usd: 20, bidding: { strategy: "MANUAL_CPV" } });
    expect(r.success).toBe(false);
  });

  it("rejects an ad whose kind does not match the ad group type", () => {
    const r = createCampaignBodySchema.safeParse({
      name: "Brand",
      channel_type: "SEARCH",
      daily_budget_usd: 20,
      bidding: { strategy: "MANUAL_CPC" },
      ad_group: { name: "Core", type: "SEARCH_STANDARD", ads: [{ kind: "video_bumper", youtube_video_id: "dQw4w9WgXcQ" }] },
    });
    expect(r.success).toBe(false);
  });

  it("rejects network settings off SEARCH", () => {
    expect(
      createCampaignBodySchema.safeParse({
        name: "Display",
        channel_type: "DISPLAY",
        daily_budget_usd: 20,
        bidding: { strategy: "MANUAL_CPC" },
        network: { google_search: true },
      }).success,
    ).toBe(false);
  });
});

describe("update schemas require at least one change", () => {
  it("updateCampaignBodySchema", () => {
    expect(updateCampaignBodySchema.safeParse({ campaign_id: "1" }).success).toBe(false);
    expect(updateCampaignBodySchema.safeParse({ campaign_id: "1", target_cpa_usd: 12 }).success).toBe(true);
  });
  it("updateAdGroupBodySchema", () => {
    expect(updateAdGroupBodySchema.safeParse({ ad_group_id: "1" }).success).toBe(false);
    expect(updateAdGroupBodySchema.safeParse({ ad_group_id: "1", cpc_bid_usd: 1.5 }).success).toBe(true);
  });
});

describe("createAdGroupBodySchema / createAdBodySchema", () => {
  it("accepts a search ad group and rejects an RSA in a video group", () => {
    expect(createAdGroupBodySchema.safeParse({ campaign_id: "1", name: "g", type: "SEARCH_STANDARD", ads: [rsa] }).success).toBe(true);
    expect(createAdGroupBodySchema.safeParse({ campaign_id: "1", name: "g", type: "VIDEO_RESPONSIVE", ads: [rsa] }).success).toBe(false);
  });
  it("refuses a VIDEO_* ad kind and ad group type: those only live in VIDEO campaigns, which Google's API cannot change", () => {
    const r = createAdBodySchema.safeParse({
      ad_group_id: "5",
      ad: {
        kind: "video_responsive",
        final_urls: ["https://example.com"],
        youtube_video_ids: ["dQw4w9WgXcQ"],
        headlines: ["Hi"],
        long_headlines: ["Longer"],
        descriptions: ["Desc"],
      },
    });
    expect(r.success).toBe(false);
    expect(createAdBodySchema.safeParse({ ad_group_id: "5", ad: rsa }).success).toBe(true);
    expect(createAdGroupBodySchema.safeParse({ campaign_id: "1", name: "g", type: "VIDEO_BUMPER" }).success).toBe(false);
  });
});

describe("addKeywordsBodySchema", () => {
  it("forces campaign-level keywords to be negative", () => {
    expect(addKeywordsBodySchema.safeParse({ level: "campaign", campaign_id: "1", negative: false, keywords: [{ text: "a", match_type: "EXACT" }] }).success).toBe(false);
    expect(addKeywordsBodySchema.safeParse({ level: "campaign", campaign_id: "1", negative: true, keywords: [{ text: "a", match_type: "EXACT" }] }).success).toBe(true);
    expect(addKeywordsBodySchema.safeParse({ level: "ad_group", negative: false, keywords: [{ text: "a", match_type: "EXACT" }] }).success).toBe(false);
  });
});

describe("removeResourceBodySchema", () => {
  it("is a strict discriminated union", () => {
    expect(removeResourceBodySchema.safeParse({ level: "campaign", campaign_id: "1" }).success).toBe(true);
    expect(removeResourceBodySchema.safeParse({ level: "ad", ad_group_id: "1" }).success).toBe(false);
    expect(removeResourceBodySchema.safeParse({ level: "keyword", scope: "ad_group", parent_id: "1", criterion_id: "2" }).success).toBe(true);
  });
});

describe("remove_resource names the keyword, never its container", () => {
  const proddish = {
    level: "keyword" as const,
    scope: "ad_group" as const,
    parent_id: "198340816265",
    criterion_id: "479795307",
    rationale: "Competitor brand keyword driving a query flood.",
    name: "Upcar Sales Search Campaign — General ad group",
    about: 'Broad match keyword "turo" in the General ad group.',
  };

  it("does not claim the ad group is being removed", () => {
    const r = gadsChangeRows("google_ads.remove_resource", proddish)!;
    expect(r.change_sentence).not.toContain("removes “Upcar Sales Search Campaign");
    expect(r.title).not.toBe("Remove “Upcar Sales Search Campaign — General ad group”");
    expect(r.change_sentence).toContain("keyword");
  });

  it("names the keyword itself when the text is supplied", () => {
    const r = gadsChangeRows("google_ads.remove_resource", { ...proddish, keyword_text: "turo" })!;
    expect(r.title).toContain("turo");
    expect(r.change_sentence).toContain("turo");
    expect(r.change_sentence).toContain("in Upcar Sales Search Campaign");
  });

  it("falls back to the criterion id rather than the parent name", () => {
    const r = gadsChangeRows("google_ads.remove_resource", proddish)!;
    expect(r.change_sentence).toContain("479795307");
  });

  it("still names a campaign removal by its own name", () => {
    const r = gadsChangeRows("google_ads.remove_resource", {
      level: "campaign" as const,
      campaign_id: "123456",
      rationale: "Dead campaign.",
      name: "Old Brand Campaign",
    })!;
    expect(r.title).toContain("Old Brand Campaign");
  });
});

describe("createCampaignBodySchema: Demand Gen", () => {
  const T = "11111111-1111-4111-8111-111111111111";
  const SHA = "a".repeat(64);
  const logo = { storage_path: `${T}/logos/${SHA}.png`, sha256: SHA, mime: "image/png", width: 256, height: 256 };
  const group = (over: Record<string, unknown> = {}) => ({
    name: "YT – video",
    ad: {
      final_urls: ["https://example.com"],
      youtube_video_ids: ["dQw4w9WgXcQ"],
      headlines: ["Book a car"],
      long_headlines: ["Book a car near you in minutes"],
      descriptions: ["Cars from local hosts"],
      business_name: "Upcar",
      logo,
      ...over,
    },
  });
  const dg = (over: Record<string, unknown> = {}) => ({
    name: "YT",
    channel_type: "DEMAND_GEN",
    daily_budget_usd: 20,
    bidding: { strategy: "MAXIMIZE_CONVERSIONS" },
    demand_gen_ad_group: group(),
    rationale: "r",
    ...over,
  });
  const issues = (b: unknown) => {
    const r = createCampaignBodySchema.safeParse(b);
    return r.success ? [] : r.error.issues.map((i) => i.message);
  };

  it("a complete Demand Gen body parses, logo as a stored ref", () => {
    const r = createCampaignBodySchema.safeParse(dg());
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.demand_gen_ad_group?.ad.logo).toEqual(logo);
  });

  it("DEMAND_GEN without its group says which tool builds it", () => {
    expect(issues(dg({ demand_gen_ad_group: undefined }))).toContain(
      "a DEMAND_GEN campaign needs its demand_gen_ad_group (use google_ads_propose_video_campaign)",
    );
  });

  it("DEMAND_GEN with a typed ad_group, negative keywords or target CPM fails", () => {
    expect(issues(dg({ ad_group: { name: "x", type: "SEARCH_STANDARD" } })).join(" ")).toMatch(/do not take a manually created ad group/);
    expect(issues(dg({ negative_keywords: [{ text: "free", match_type: "PHRASE" }] })).join(" ")).toMatch(/negative keywords/);
    expect(issues(dg({ bidding: { strategy: "TARGET_CPM" } })).join(" ")).toMatch(/not valid for a DEMAND_GEN/);
  });

  it("the group on a SEARCH campaign fails", () => {
    expect(issues({ ...dg(), channel_type: "SEARCH", bidding: { strategy: "MANUAL_CPC" } })).toContain(
      "demand_gen_ad_group belongs only to a DEMAND_GEN campaign",
    );
  });

  it("VIDEO still fails", () => {
    expect(issues({ ...dg(), channel_type: "VIDEO" })).toContain("Google's API cannot create VIDEO campaigns");
  });

  it.each([
    ["a headline over 40", group({ headlines: ["x".repeat(41)] })],
    ["a long headline over 90", group({ long_headlines: ["x".repeat(91)] })],
    ["a business name over 25", group({ business_name: "x".repeat(26) })],
    ["six videos", group({ youtube_video_ids: Array(6).fill("dQw4w9WgXcQ") })],
    ["no description", group({ descriptions: [] })],
    ["a non-hex sha256", group({ logo: { ...logo, sha256: "z".repeat(64) } })],
    ["a logo URL instead of a stored ref", group({ logo: "https://example.com/logo.png" })],
    ["a stored path outside logos/", group({ logo: { ...logo, storage_path: `${T}/other/${SHA}.png` } })],
    ["a logo under 128px", group({ logo: { ...logo, width: 100, height: 100 } })],
  ])("%s fails", (_l, g) => {
    expect(createCampaignBodySchema.safeParse(dg({ demand_gen_ad_group: g })).success).toBe(false);
  });
});
