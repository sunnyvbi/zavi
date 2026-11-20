
import { beforeEach, describe, expect, it, vi } from "vitest";

const g = vi.hoisted(() => ({
  writeEnabled: true,
  currency: "USD",
  cap: null as null | { enabled: boolean; max_daily_budget_usd: number | null },
  capAbsent: true,
  failEmitAt: 0,
  campaign: {} as Record<string, unknown>,
  geoFingerprint: "a".repeat(64),
  liveGeo: [2840] as number[],
  knownPlaces: new Set([2840, 1014221]),
  names: ["Spring"] as string[],
  adGroupCampaign: "12000100",
  keyword: { text: "car rental", negative: false },
  emitted: [] as Array<{ cls: string; body: Record<string, unknown> }>,
  decided: [] as string[],
  decideCode: "ok",
  decideStatus: null as string | null,
  rowStatus: "proposed",
  rowOverride: null as null | Record<string, unknown>,
  validated: [] as Array<Record<string, unknown>>,
  validateError: null as null | Error,
  fetchedLogo: [] as string[],
}));
vi.mock("@/services/tools/google-ads/write/_logo", () => ({
  pinnedFetch: async (url: string) => (g.fetchedLogo.push(url), { bytes: Buffer.from("png"), content_type: "image/png" }),
  storeLogo: async () => ({ storage_path: `${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}/logos/${"a".repeat(64)}.png`, sha256: "a".repeat(64), mime: "image/png", width: 512, height: 512 }),
}));
vi.mock("@/services/tools/google-ads/write/create_campaign", () => ({
  googleValidateCreateCampaign: async (_t: string, body: Record<string, unknown>) => {
    if (g.validateError) throw g.validateError;
    g.validated.push(body);
  },
}));

vi.mock("@/services/tools/google-ads/_client", () => ({
  gadsSearch: async (_t: string, q: string) => {
    if (q.includes("FROM campaign WHERE")) return [{ campaign: g.campaign, campaignBudget: { amountMicros: "50000000", explicitlyShared: false } }];
    if (q.includes("SELECT ad_group.cpc_bid_micros")) return [{ adGroup: { cpcBidMicros: "1500000" } }];
    return [];
  },
  gadsGetCampaign: async () => ({ campaign_resource: "customers/1/campaigns/12000100", campaign_id: "12000100", name: "Spring", status: "ENABLED", channel_type: (g.campaign.advertisingChannelType as string) ?? "SEARCH", bidding_strategy_type: "", budget_resource: "b", amount_micros: 0 }),
  gadsGetAdGroup: async (_t: string, id: string) => ({ ad_group_resource: `customers/1/adGroups/${id}`, ad_group_id: id, name: "General", status: "ENABLED", type: "SEARCH_STANDARD", campaign_id: g.adGroupCampaign, campaign_resource: "c" }),
  gadsGetKeyword: async (_t: string, _s: unknown, id: string) => ({ criterion_resource: "r", criterion_id: id, text: g.keyword.text, match_type: "PHRASE", negative: g.keyword.negative, status: "ENABLED" }),
  gadsListCampaignNames: async () => g.names,
  gadsListAdGroupNames: async () => ["General"],
}));
vi.mock("@/services/tools/google-ads/write/_flag-check", () => ({ isGoogleAdsWriteEnabled: async () => g.writeEnabled }));
vi.mock("@/services/tools/google-ads/write/_currency-guard", () => ({ readGoogleAccountCurrency: async () => g.currency }));
vi.mock("@/services/tools/google-ads/write/cap-reader", () => ({ readTenantGoogleCapAndToday: async () => ({ cap: g.cap, cap_row_absent: g.cap === null && g.capAbsent, today_total_change_usd: 0 }) }));
vi.mock("@/services/tools/google-ads/write/replace_geo_targets", async (orig) => ({
  ...(await orig<object>()),
  readGoogleGeoTargets: async () => ({ level: "campaign", owners: [{ resource: "c", criteria: g.liveGeo.map((geo_id) => ({ resource_name: `r${geo_id}`, geo_id })) }] }),
  geoFingerprint: () => g.geoFingerprint,
}));
vi.mock("@/services/ad-locations/places", () => ({
  readGooglePlaces: async (_t: string, ids: number[]) => new Map(ids.filter((id) => g.knownPlaces.has(id)).map((id) => [id, { id: String(id), name: `Place ${id}`, kind: "City", country_code: "US" }])),
  googlePlaceNames: async (_t: string, ids: number[]) => ids.map((id) => ({ id: String(id), name: `Place ${id}`, kind: "Country" })),
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  tenantRpc: async (_t: string, fn: string, args: { p_decision_class: string; p_body: Record<string, unknown> }) => {
    expect(fn).toBe("emit_decision");
    if (g.failEmitAt === g.emitted.length + 1) return { data: null, error: { message: "db down" } };
    g.emitted.push({ cls: args.p_decision_class, body: JSON.parse(JSON.stringify(args.p_body)) });
    return { data: `d-${g.emitted.length}`, error: null };
  },
  tenantClient: (t: string) => ({
    from: (table: string) => {
      expect(t).toBe("t-1");
      expect(table).toBe("decisions");
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => {
              const last = g.emitted[g.emitted.length - 1]!;
              return { data: g.rowOverride ?? { decision_class: last.cls, status: g.rowStatus, body: last.body }, error: null };
            },
          }),
        }),
      };
    },
  }),
}));
vi.mock("@/services/approvals/decide-service", () => ({
  decideOnDecision: async (a: { decision_id: string; action: string; actor: { user_id: string } }) => {
    expect(a.action).toBe("approve");
    expect(a.actor.user_id).toBe("u-1");
    g.decided.push(a.decision_id);
    return { ok: g.decideCode === "ok", code: g.decideCode, status: g.decideStatus };
  },
}));

import { createGoogleAd, createGoogleAdGroup, createGoogleCampaign, createYoutubeCampaign, googleAdCreateSchema, googleAdGroupCreateSchema, googleCampaignCreateSchema, saveGoogleCampaignEdits, youtubeCampaignCreateSchema } from "../campaign-editor";
import { ExpectedToolError } from "@/services/tools/types";
import { EditorPartialSaveError } from "@/services/connectors/_editor-save";
import { createCampaignBodySchema } from "@/services/tools/google-ads/write/_decision-bodies";

const T = "t-1" as never;

const NEW = {
  name: "Rentals NYC",
  daily_budget: 40,
  goal: "clicks",
  places: ["1014221"],
  keywords: [{ text: "car rental nyc", match_type: "PHRASE" }],
  final_url: "https://example.com/book",
  headlines: ["Rent a car today", "Cars near you", "Book in minutes"],
  descriptions: ["Pick up a car near you in minutes.", "No paperwork, no queue."],
};

beforeEach(() => {
  g.writeEnabled = true;
  g.currency = "USD";
  g.cap = null;
  g.capAbsent = true;
  g.failEmitAt = 0;
  g.campaign = {
    id: "12000100",
    name: "Spring",
    status: "ENABLED",
    advertisingChannelType: "SEARCH",
    biddingStrategyType: "MAXIMIZE_CONVERSIONS",
    maximizeConversions: { targetCpaMicros: "20000000" },
    networkSettings: { targetGoogleSearch: true, targetSearchNetwork: false, targetContentNetwork: false, targetPartnerSearchNetwork: false },
  };
  g.liveGeo = [2840];
  g.names = ["Spring"];
  g.adGroupCampaign = "12000100";
  g.keyword = { text: "car rental", negative: false };
  g.emitted = [];
  g.decided = [];
  g.decideCode = "ok";
  g.decideStatus = null;
  g.rowStatus = "proposed";
  g.rowOverride = null;
  g.validated = [];
  g.validateError = null;
  g.fetchedLogo = [];
});

describe("createGoogleCampaign", () => {
  it("files one founder-origin Search create, approved by the Save", async () => {
    const out = await createGoogleCampaign(T, "u-1", googleCampaignCreateSchema.parse({ ...NEW, end_date: "2099-01-31", max_cpc_usd: 2 }));
    expect(out).toMatchObject({ approved: true, decision_id: "d-1" });
    expect(g.emitted).toHaveLength(1);
    const { cls, body } = g.emitted[0]!;
    expect(cls).toBe("google_ads.create_campaign");
    expect(createCampaignBodySchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({
      channel_type: "SEARCH",
      daily_budget_usd: 40,
      bidding: { strategy: "TARGET_SPEND", cpc_bid_ceiling_usd: 2 },
      location_ids: [1014221],
      origin: "user_initiated_ledger",
      end_date: "2099-02-01",
      ad_group: { type: "SEARCH_STANDARD", keywords: [{ text: "car rental nyc", match_type: "PHRASE" }] },
    });
    expect(g.decided).toEqual(["d-1"]);
  });

  it("a Google daily limit that could not be read refuses the create (fail closed)", async () => {
    g.capAbsent = false;
    await expect(createGoogleCampaign(T, "u-1", googleCampaignCreateSchema.parse(NEW))).rejects.toMatchObject({ code: "google_editor_cap_unreadable" });
    await expect(createYoutubeCampaign(T, "u-1", youtubeCampaignCreateSchema.parse({ name: "Video", daily_budget: 40, places: ["1014221"], videos: ["https://youtu.be/dQw4w9WgXcQ"], final_url: "https://example.com", headlines: ["h"], long_headlines: ["lh"], descriptions: ["d"], business_name: "Biz", logo_url: "https://example.com/logo.png" }))).rejects.toMatchObject({ code: "google_editor_cap_unreadable" });
    expect(g.emitted).toEqual([]);
    expect(g.fetchedLogo).toEqual([]);
  });

  it("refuses over the tenant's Google daily limit before staging anything", async () => {
    g.cap = { enabled: true, max_daily_budget_usd: 25 };
    await expect(createGoogleCampaign(T, "u-1", googleCampaignCreateSchema.parse(NEW))).rejects.toMatchObject({ code: "google_editor_over_cap" });
    expect(g.emitted).toEqual([]);
  });

  it("refuses with the write switch off, a non-USD account, a taken name or an unknown place", async () => {
    g.writeEnabled = false;
    await expect(createGoogleCampaign(T, "u-1", googleCampaignCreateSchema.parse(NEW))).rejects.toMatchObject({ code: "google_ads_write_disabled" });
    g.writeEnabled = true;
    g.currency = "EUR";
    await expect(createGoogleCampaign(T, "u-1", googleCampaignCreateSchema.parse(NEW))).rejects.toMatchObject({ code: "google_ads_non_usd_account" });
    g.currency = "USD";
    g.names = ["rentals nyc"];
    await expect(createGoogleCampaign(T, "u-1", googleCampaignCreateSchema.parse(NEW))).rejects.toMatchObject({ code: "google_ads_campaign_name_exists" });
    g.names = [];
    await expect(createGoogleCampaign(T, "u-1", googleCampaignCreateSchema.parse({ ...NEW, places: ["99"] }))).rejects.toMatchObject({ code: "ad_locations_bad_place" });
    expect(g.emitted).toEqual([]);
  });

  it("an approval that can't pass here leaves the card waiting", async () => {
    g.decideCode = "budget_choice_required";
    const out = await createGoogleCampaign(T, "u-1", googleCampaignCreateSchema.parse(NEW));
    expect(out).toMatchObject({ approved: false, code: "budget_choice_required" });
  });

  it("never approves an open card emit_decision kept instead of this one", async () => {
    g.rowOverride = { decision_class: "google_ads.create_campaign", status: "proposed", body: { name: "Other" } };
    await expect(createGoogleCampaign(T, "u-1", googleCampaignCreateSchema.parse(NEW))).rejects.toMatchObject({ code: "google_editor_change_open" });
    expect(g.decided).toEqual([]);
  });

  it("keeps a bid target with its own goal", () => {
    expect(googleCampaignCreateSchema.safeParse({ ...NEW, target_cpa_usd: 30 }).success).toBe(false);
    expect(googleCampaignCreateSchema.safeParse({ ...NEW, goal: "conversions", target_cpa_usd: 30 }).success).toBe(true);
  });
});

describe("saveGoogleCampaignEdits", () => {
  it("sends nothing for unchanged values", async () => {
    const out = await saveGoogleCampaignEdits(T, "u-1", "12000100", {
      name: "Spring",
      target_cpa_usd: 20,
      network: { search_network: false, content_network: false },
      places: { ids: ["2840"], fingerprint: g.geoFingerprint },
      ad_groups: [{ id: "12000300", cpc_bid_usd: 1.5 }],
    });
    expect(out).toEqual([]);
    expect(g.emitted).toEqual([]);
  });

  it("stages name, bid target and networks as one update, keeping Google Search on", async () => {
    await saveGoogleCampaignEdits(T, "u-1", "12000100", { name: "Spring sale", target_cpa_usd: 25, network: { search_network: true, content_network: false } });
    expect(g.emitted).toHaveLength(1);
    expect(g.emitted[0]).toMatchObject({
      cls: "google_ads.update_campaign",
      body: {
        campaign_id: "12000100",
        new_name: "Spring sale",
        target_cpa_usd: 25,
        network: { google_search: true, search_network: true, content_network: false, partner_search_network: false },
        origin: "user_initiated_ledger",
      },
    });
  });

  it("refuses a bid target the campaign's bidding does not take", async () => {
    await expect(saveGoogleCampaignEdits(T, "u-1", "12000100", { target_roas: 3 })).rejects.toMatchObject({ code: "google_editor_invalid" });
  });

  it("replaces places only against the targeting the founder opened", async () => {
    await expect(saveGoogleCampaignEdits(T, "u-1", "12000100", { places: { ids: ["1014221"], fingerprint: "b".repeat(64) } })).rejects.toMatchObject({ code: "google_editor_drift" });
    await saveGoogleCampaignEdits(T, "u-1", "12000100", { places: { ids: ["1014221"], fingerprint: g.geoFingerprint } });
    expect(g.emitted[0]).toMatchObject({
      cls: "google_ads.replace_geo_targets_review",
      body: { campaign_id: "12000100", level: "campaign", location_ids: [1014221], place_names: ["Place 1014221"], before_names: ["Place 2840"], expected_fingerprint: g.geoFingerprint },
    });
  });

  it("stages keyword adds, removals (live text and sign) and negatives", async () => {
    await saveGoogleCampaignEdits(T, "u-1", "12000100", {
      add_keywords: [{ ad_group_id: "12000300", keywords: [{ text: "suv rental", match_type: "EXACT" }] }],
      remove_keywords: [{ ad_group_id: "12000300", criterion_id: "555" }],
      add_negatives: [{ text: "free", match_type: "BROAD" }],
    });
    expect(g.emitted.map((e) => e.cls)).toEqual(["google_ads.add_keywords", "google_ads.remove_resource", "google_ads.add_keywords"]);
    expect(g.emitted[1]!.body).toMatchObject({ level: "keyword", scope: "ad_group", parent_id: "12000300", criterion_id: "555", keyword_text: "car rental", criterion_negative: false });
    expect(g.emitted[2]!.body).toMatchObject({ level: "campaign", campaign_id: "12000100", negative: true });
  });

  it("every read and check runs before anything is staged: a bad ad group stages not even the rename", async () => {
    g.adGroupCampaign = "999";
    await expect(
      saveGoogleCampaignEdits(T, "u-1", "12000100", { name: "Spring v2", ad_groups: [{ id: "12000300", name: "x" }] }),
    ).rejects.toMatchObject({ code: "google_ads_invalid_target" });
    expect(g.emitted).toEqual([]);
    expect(g.decided).toEqual([]);
  });

  it("a later change that fails after one landed names what was saved and what was not", async () => {
    g.failEmitAt = 2;
    const err = await saveGoogleCampaignEdits(T, "u-1", "12000100", {
      name: "Spring v2",
      add_keywords: [{ ad_group_id: "12000300", keywords: [{ text: "suv rental", match_type: "EXACT" }] }],
      add_negatives: [{ text: "free", match_type: "BROAD" }],
    }).catch((e) => e);
    expect(err).toBeInstanceOf(EditorPartialSaveError);
    const p = err as EditorPartialSaveError;
    expect(p.landed).toMatchObject([{ label: "Spring: name", decision_id: "d-1", approved: true }]);
    expect(p.failed_label).toBe("General: add 1 keyword");
    expect(p.not_sent).toEqual(["Spring: add 1 negative keyword"]);
    expect(g.decided).toEqual(["d-1"]);
  });

  it("refuses an ad group from another campaign", async () => {
    g.adGroupCampaign = "999";
    await expect(saveGoogleCampaignEdits(T, "u-1", "12000100", { ad_groups: [{ id: "12000300", name: "x" }] })).rejects.toMatchObject({ code: "google_ads_invalid_target" });
    expect(g.emitted).toEqual([]);
  });

  it("refuses keywords on a campaign that is not Search", async () => {
    g.campaign = { ...g.campaign, advertisingChannelType: "PERFORMANCE_MAX" };
    await expect(saveGoogleCampaignEdits(T, "u-1", "12000100", { add_negatives: [{ text: "free", match_type: "BROAD" }] })).rejects.toMatchObject({ code: "google_editor_invalid" });
  });
});

const YT = {
  name: "Shorts push",
  daily_budget: 30,
  places: ["2840"],
  videos: ["https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
  final_url: "https://example.com",
  headlines: ["Rent a car"],
  long_headlines: ["Rent a car near you in minutes"],
  descriptions: ["No paperwork, no queue."],
  business_name: "Upcar",
  logo_url: "https://example.com/logo.png",
};

describe("createGoogleAdGroup and createGoogleAd", () => {
  const ad = { final_url: "https://example.com", headlines: ["Rent a car", "From $35 a day", "Book today"], descriptions: ["Clean cars near you.", "Lower fees than rentals."] };
  const group = googleAdGroupCreateSchema.parse({ name: "Airport", max_cpc_usd: 2, keywords: [{ text: "car rental", match_type: "PHRASE" }], ...ad });

  it("files a paused Search ad group with its keywords and ad, founder-origin, and approves it", async () => {
    const out = await createGoogleAdGroup(T, "u-1", "12000100", group);
    expect(g.emitted.map((e) => e.cls)).toEqual(["google_ads.create_ad_group"]);
    expect(g.emitted[0]!.body).toMatchObject({
      campaign_id: "12000100",
      name: "Airport",
      type: "SEARCH_STANDARD",
      cpc_bid_usd: 2,
      keywords: [{ text: "car rental", match_type: "PHRASE" }],
      ads: [{ kind: "responsive_search", final_urls: ["https://example.com"], headlines: ad.headlines }],
      origin: "user_initiated_ledger",
    });
    expect(out).toMatchObject({ decision_id: "d-1", approved: true });
  });

  it("refuses a name the campaign already uses and a campaign that is not Search, with nothing filed", async () => {
    await expect(createGoogleAdGroup(T, "u-1", "12000100", { ...group, name: "general" })).rejects.toMatchObject({ code: "google_ads_ad_group_name_exists" });
    g.campaign = { ...g.campaign, advertisingChannelType: "DEMAND_GEN" };
    await expect(createGoogleAdGroup(T, "u-1", "12000100", group)).rejects.toMatchObject({ code: "google_editor_search_only" });
    expect(g.emitted).toEqual([]);
  });

  it("files a paused ad in the campaign's ad group, and refuses an ad group from another campaign", async () => {
    await createGoogleAd(T, "u-1", "12000100", googleAdCreateSchema.parse({ ad_group_id: "500", ...ad }));
    expect(g.emitted.map((e) => e.cls)).toEqual(["google_ads.create_ad"]);
    expect(g.emitted[0]!.body).toMatchObject({ ad_group_id: "500", ad: { kind: "responsive_search", descriptions: ad.descriptions }, origin: "user_initiated_ledger" });
    g.adGroupCampaign = "999";
    await expect(createGoogleAd(T, "u-1", "12000100", googleAdCreateSchema.parse({ ad_group_id: "500", ...ad }))).rejects.toMatchObject({ code: "google_ads_invalid_target" });
    expect(g.emitted).toHaveLength(1);
  });
});

describe("createYoutubeCampaign", () => {
  it("files a Demand Gen video create, dry-run by Google first, with the stored logo and the video id", async () => {
    const out = await createYoutubeCampaign(T, "u-1", youtubeCampaignCreateSchema.parse({ ...YT, end_date: "2099-03-31" }));
    expect(out).toMatchObject({ approved: true });
    const { cls, body } = g.emitted[0]!;
    expect(cls).toBe("google_ads.create_campaign");
    expect(createCampaignBodySchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({
      channel_type: "DEMAND_GEN",
      bidding: { strategy: "MAXIMIZE_CONVERSIONS" },
      location_ids: [2840],
      end_date: "2099-04-01",
      origin: "user_initiated_ledger",
      demand_gen_ad_group: { ad: { youtube_video_ids: ["dQw4w9WgXcQ"], business_name: "Upcar", logo: { sha256: "a".repeat(64) } } },
    });
    expect(JSON.stringify(body)).not.toContain("logo.png");
    expect(g.validated).toHaveLength(1);
  });

  it("refuses a link that is not a YouTube video, and checks the cap before fetching the logo", async () => {
    await expect(createYoutubeCampaign(T, "u-1", youtubeCampaignCreateSchema.parse({ ...YT, videos: ["https://vimeo.com/1"] }))).rejects.toMatchObject({ code: "google_editor_invalid" });
    g.cap = { enabled: true, max_daily_budget_usd: 10 };
    await expect(createYoutubeCampaign(T, "u-1", youtubeCampaignCreateSchema.parse(YT))).rejects.toMatchObject({ code: "google_editor_over_cap" });
    expect(g.fetchedLogo).toEqual([]);
    expect(g.emitted).toEqual([]);
  });

  it("a dry-run refusal stages nothing", async () => {
    g.validateError = new ExpectedToolError("google_ads_demand_gen_rejected", "Google refused this Demand Gen campaign in a dry run, so no card was filed: bad logo");
    await expect(createYoutubeCampaign(T, "u-1", youtubeCampaignCreateSchema.parse(YT))).rejects.toMatchObject({ code: "google_editor_rejected", message: expect.stringContaining("nothing was saved") });
    expect(g.emitted).toEqual([]);
  });
});

describe("YouTube campaigns in the editor", () => {
  it("refuses any change to a classic VIDEO campaign", async () => {
    g.campaign = { ...g.campaign, advertisingChannelType: "VIDEO" };
    await expect(saveGoogleCampaignEdits(T, "u-1", "12000100", { name: "x" })).rejects.toMatchObject({ code: "google_ads_video_mutate_unsupported" });
    expect(g.emitted).toEqual([]);
  });

  it("replaces a Demand Gen campaign's places on every ad group", async () => {
    g.campaign = { ...g.campaign, advertisingChannelType: "DEMAND_GEN", biddingStrategyType: "MAXIMIZE_CONVERSIONS" };
    await saveGoogleCampaignEdits(T, "u-1", "12000100", { places: { ids: ["1014221"], fingerprint: g.geoFingerprint } });
    expect(g.emitted[0]).toMatchObject({ cls: "google_ads.replace_geo_targets_review", body: { level: "ad_group", scope: "all_ad_groups", location_ids: [1014221] } });
  });
});
