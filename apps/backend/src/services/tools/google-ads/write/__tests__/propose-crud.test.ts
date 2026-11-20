import { describe, it, expect, vi, beforeEach } from "vitest";

const flagEnabled = vi.fn(async () => true);
const videoGuard = vi.hoisted(() => ({ campaign: vi.fn(async (_t: string, _id: string) => {}), adGroup: vi.fn(async (_t: string, _id: string) => {}) }));
vi.mock("../_video-guard", () => ({ assertNotVideoCampaign: videoGuard.campaign, assertNotVideoAdGroup: videoGuard.adGroup }));
vi.mock("../_flag-check", () => ({ isGoogleAdsWriteEnabled: () => flagEnabled() }));

const capState = {
  cap: { enabled: true, max_daily_budget_usd: 100, max_pct_change_per_run: null, max_daily_total_change_usd: null } as unknown,
  today_total_change_usd: 0,
};
vi.mock("../cap-reader", () => ({ readTenantGoogleCapAndToday: vi.fn(async () => capState) }));
vi.mock("@/services/ad-locations/country", async (orig) => ({
  ...(await orig<typeof import("@/services/ad-locations/country")>()),
  businessCountry: vi.fn(async () => null),
  businessCountryOrThrow: vi.fn(async () => null),
}));

const dg = vi.hoisted(() => ({
  objects: new Map<string, Buffer>(),
  fetch: vi.fn(),
  validate: vi.fn(),
  facts: vi.fn(async (_t: string, _c: string | null) => ({ currency_code: "USD" as string | null, budget_period: null as string | null })),
}));
vi.mock("../_logo", async () => {
  const actual = await vi.importActual<typeof import("../_logo")>("../_logo");
  const bucket = () => ({
    upload: async (path: string, b: Buffer) => {
      if (dg.objects.has(path)) return { data: null, error: { message: "The resource already exists", statusCode: "409" } };
      dg.objects.set(path, Buffer.from(b));
      return { data: { path }, error: null };
    },
    download: async (path: string) => ({ data: new Blob([new Uint8Array(dg.objects.get(path)!)]), error: null }),
  });
  return {
    ...actual,
    pinnedFetch: dg.fetch,
    storeLogo: (tid: Parameters<typeof actual.storeLogo>[0], bytes: Buffer) =>
      actual.storeLogo(tid, bytes, { bucket: bucket as unknown as NonNullable<Parameters<typeof actual.storeLogo>[2]>["bucket"] }),
  };
});
const kw = vi.hoisted(() => ({ get: vi.fn(async (..._a: unknown[]): Promise<{ negative: boolean }> => { throw new Error("no account in this test"); }) }));
vi.mock("../../_client", async () => {
  const actual = await vi.importActual<typeof import("../../_client")>("../../_client");
  return { ...actual, gadsGetBudgetGuardFacts: dg.facts, gadsGetKeyword: (...a: unknown[]) => kw.get(...a) };
});
vi.mock("../create_campaign", async () => {
  const actual = await vi.importActual<typeof import("../create_campaign")>("../create_campaign");
  return { ...actual, googleValidateCreateCampaign: dg.validate };
});

import { googleProposeNewCampaignTool } from "../propose_new_campaign";
import { googleProposeVideoCampaignTool } from "../propose_video_campaign";
import { googleProposeVideoAdTool } from "../propose_video_ad";
import { googleProposeNewAdTool } from "../propose_new_ad";
import { googleProposeAdGroupUpdateTool } from "../propose_ad_group_update";
import { googleProposeStatusChangeTool } from "../propose_status_change";
import { googleProposeRemovalTool } from "../propose_removal";
import { googleProposeKeywordsTool } from "../propose_keywords";
import { googleProposeBudgetChangeTool } from "../propose_budget_change";
import { googleProposeNewAdGroupTool } from "../propose_new_ad_group";
import { googleProposeCampaignUpdateTool } from "../propose_campaign_update";
import { clearGoogleCurrencyRunCache } from "../_currency-guard";
import type { ToolContext } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";

const TENANT = "11111111-1111-4111-8111-111111111111";

function makeCtx() {
  const emit = vi.fn(async (_cls: string, _body: unknown) => "decision-1");
  const ctx: ToolContext = { tenant_id: TENANT, log: () => {}, emit_decision: emit };
  return { ctx, emit };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearGoogleCurrencyRunCache();
  dg.facts.mockImplementation(async () => ({ currency_code: "USD", budget_period: null }));
  flagEnabled.mockResolvedValue(true);
  capState.cap = { enabled: true, max_daily_budget_usd: 100, max_pct_change_per_run: null, max_daily_total_change_usd: null };
});

describe("google_ads_propose_new_campaign", () => {
  it("flag OFF → refuses and emits nothing", async () => {
    flagEnabled.mockResolvedValue(false);
    const { ctx, emit } = makeCtx();
    await expect(
      googleProposeNewCampaignTool.execute(ctx, { name: "x", channel_type: "SEARCH", daily_budget_usd: 10, bidding: { strategy: "MANUAL_CPC" }, rationale: "r" }),
    ).rejects.toMatchObject({ code: "google_ads_write_disabled" });
    expect(emit).not.toHaveBeenCalled();
  });

  it("over the absolute ceiling → refuses before any decision", async () => {
    const { ctx, emit } = makeCtx();
    await expect(
      googleProposeNewCampaignTool.execute(ctx, { name: "x", channel_type: "SEARCH", daily_budget_usd: 500, bidding: { strategy: "MANUAL_CPC" }, rationale: "r" }),
    ).rejects.toMatchObject({ code: "google_ads_proposal_over_absolute_cap" });
    expect(emit).not.toHaveBeenCalled();
  });

  it("structurally impossible body → refuses at the propose boundary", async () => {
    const { ctx, emit } = makeCtx();
    await expect(
      googleProposeNewCampaignTool.execute(ctx, { name: "x", channel_type: "SEARCH", daily_budget_usd: 10, bidding: { strategy: "MANUAL_CPV" }, rationale: "r" }),
    ).rejects.toMatchObject({ code: "google_ads_invalid_create_body" });
    expect(emit).not.toHaveBeenCalled();
  });

  it("valid → emits google_ads.create_campaign with the parsed body", async () => {
    const { ctx, emit } = makeCtx();
    const out = (await googleProposeNewCampaignTool.execute(ctx, {
      name: "Brand",
      channel_type: "SEARCH",
      daily_budget_usd: 10,
      bidding: { strategy: "MANUAL_CPC" },
      rationale: "r",
    })) as { decision_class: string; will_auto_apply?: boolean };
    expect(out.decision_class).toBe("google_ads.create_campaign");
    expect("will_auto_apply" in out).toBe(false);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0]).toBe("google_ads.create_campaign");
    expect(emit.mock.calls[0][1]).toMatchObject({ name: "Brand", channel_type: "SEARCH", daily_budget_usd: 10, location_ids: [] });
  });
});

describe("VIDEO creates are refused before anything is filed", () => {
  it("google_ads_propose_video_ad", async () => {
    const { ctx, emit } = makeCtx();
    await expect(
      googleProposeVideoAdTool.execute(ctx, { ad_group_id: "1", format: "bumper", youtube_video_ids: ["dQw4w9WgXcQ"], rationale: "r" }),
    ).rejects.toMatchObject({ code: "google_ads_video_create_unsupported" });
    expect(emit).not.toHaveBeenCalled();
  });

  it("google_ads_propose_new_campaign refuses VIDEO in its schema", async () => {
    const { ctx, emit } = makeCtx();
    await expect(
      googleProposeNewCampaignTool.execute(ctx, { name: "v", channel_type: "VIDEO", daily_budget_usd: 10, bidding: { strategy: "MANUAL_CPV" }, rationale: "r" }),
    ).rejects.toThrow();
    expect(emit).not.toHaveBeenCalled();
  });

  it("google_ads_propose_new_campaign sends DEMAND_GEN to the video tool", async () => {
    const { ctx, emit } = makeCtx();
    await expect(
      googleProposeNewCampaignTool.execute(ctx, { name: "d", channel_type: "DEMAND_GEN", daily_budget_usd: 10, bidding: { strategy: "MAXIMIZE_CONVERSIONS" }, rationale: "r" }),
    ).rejects.toMatchObject({ code: "google_ads_demand_gen_use_video_tool" });
    expect(emit).not.toHaveBeenCalled();
  });

  it("the tool descriptions say so", () => {
    expect(googleProposeVideoAdTool.description).toMatch(/^NOT AVAILABLE/);
    expect(googleProposeNewCampaignTool.description).not.toMatch(/Always operator-approved/);
  });
});

describe("google_ads_propose_video_campaign (Demand Gen)", () => {
  function png(width: number, height: number): Buffer {
    const b = Buffer.alloc(64);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
    b.writeUInt32BE(13, 8);
    b.write("IHDR", 12, "latin1");
    b.writeUInt32BE(width, 16);
    b.writeUInt32BE(height, 20);
    return b;
  }
  const input = (over: Record<string, unknown> = {}) => ({
    name: "YT launch",
    daily_budget_usd: 30,
    youtube_video_ids: ["dQw4w9WgXcQ"],
    final_url: "https://example.com/start",
    headlines: ["Book a car"],
    long_headlines: ["Book a car near you in minutes"],
    descriptions: ["Cars from local hosts"],
    business_name: "Upcar",
    logo_image_url: "https://cdn.example.com/logo.png",
    location_ids: [2840],
    rationale: "Video reaches renters search misses",
    ...over,
  });

  beforeEach(() => {
    dg.objects.clear();
    dg.fetch.mockReset();
    dg.validate.mockReset();
    dg.fetch.mockImplementation(async () => ({ bytes: png(256, 256), content_type: "image/png" }));
    dg.validate.mockResolvedValue(undefined);
  });

  it("happy path: one fetch, stored by hash, dry run on the same body, then one DEMAND_GEN create card", async () => {
    const { ctx, emit } = makeCtx();
    const out = (await googleProposeVideoCampaignTool.execute(ctx, input())) as Record<string, unknown>;
    expect(dg.fetch).toHaveBeenCalledTimes(1);
    expect(dg.fetch).toHaveBeenCalledWith("https://cdn.example.com/logo.png");
    expect(dg.objects.size).toBe(1);
    const [storedPath] = [...dg.objects.keys()];
    expect(storedPath).toMatch(new RegExp(`^${TENANT}/logos/[0-9a-f]{64}\\.png$`));

    expect(emit).toHaveBeenCalledTimes(1);
    const [cls, body] = emit.mock.calls[0] as [string, Record<string, any>];
    expect(cls).toBe("google_ads.create_campaign");
    expect(body).toMatchObject({
      name: "YT launch",
      channel_type: "DEMAND_GEN",
      daily_budget_usd: 30,
      bidding: { strategy: "MAXIMIZE_CONVERSIONS" },
      location_ids: [2840],
      demand_gen_ad_group: {
        name: "YT launch – video",
        ad: {
          final_urls: ["https://example.com/start"],
          youtube_video_ids: ["dQw4w9WgXcQ"],
          business_name: "Upcar",
          logo: { storage_path: storedPath, mime: "image/png", width: 256, height: 256 },
        },
      },
    });
    expect(JSON.stringify(body)).not.toContain("cdn.example.com");
    expect(dg.validate).toHaveBeenCalledTimes(1);
    expect(dg.validate.mock.calls[0][0]).toBe(TENANT);
    const { decision_evidence: _ev, ...filed } = body;
    expect(dg.validate.mock.calls[0][1]).toEqual(filed);
    expect(dg.validate.mock.invocationCallOrder[0]).toBeLessThan(emit.mock.invocationCallOrder[0]);

    expect(out).toMatchObject({
      decision_class: "google_ads.create_campaign",
      campaign_type: "DEMAND_GEN",
      approval: "you, or Autopilot when it runs your ads under a budget",
    });
  });

  it("a non-USD account is refused before the logo is fetched", async () => {
    dg.facts.mockResolvedValueOnce({ currency_code: "EUR", budget_period: null });
    const { ctx, emit } = makeCtx();
    await expect(googleProposeVideoCampaignTool.execute(ctx, input())).rejects.toMatchObject({ code: "google_ads_non_usd_account" });
    expect(dg.fetch).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("a target CPA rides on maximize conversions", async () => {
    const { ctx, emit } = makeCtx();
    await googleProposeVideoCampaignTool.execute(ctx, input({ target_cpa_usd: 12 }));
    expect((emit.mock.calls[0][1] as Record<string, unknown>).bidding).toEqual({ strategy: "MAXIMIZE_CONVERSIONS", target_cpa_usd: 12 });
  });

  it("Google's dry-run refusal files nothing and passes Google's reasons through", async () => {
    dg.validate.mockRejectedValue(
      new ExpectedToolError("google_ads_demand_gen_rejected", "Google refused this Demand Gen campaign in a dry run, so no card was filed: YOUTUBE_VIDEO_NOT_FOUND: The YouTube video was not found."),
    );
    const { ctx, emit } = makeCtx();
    await expect(googleProposeVideoCampaignTool.execute(ctx, input())).rejects.toMatchObject({
      code: "google_ads_demand_gen_rejected",
      message: expect.stringContaining("YOUTUBE_VIDEO_NOT_FOUND: The YouTube video was not found."),
    });
    expect(emit).not.toHaveBeenCalled();
  });

  it("a non-square logo is refused: no store, no dry run, no card", async () => {
    dg.fetch.mockImplementation(async () => ({ bytes: png(400, 200), content_type: "image/png" }));
    const { ctx, emit } = makeCtx();
    await expect(googleProposeVideoCampaignTool.execute(ctx, input())).rejects.toMatchObject({ code: "google_ads_demand_gen_logo_invalid" });
    expect(dg.objects.size).toBe(0);
    expect(dg.validate).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("an http logo URL or landing page is a schema refusal before any fetch", async () => {
    const { ctx, emit } = makeCtx();
    await expect(googleProposeVideoCampaignTool.execute(ctx, input({ logo_image_url: "http://cdn.example.com/logo.png" }))).rejects.toThrow(/https/);
    await expect(googleProposeVideoCampaignTool.execute(ctx, input({ final_url: "http://example.com" }))).rejects.toThrow(/https/);
    expect(dg.fetch).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("over the tenant ceiling refuses before the logo is fetched", async () => {
    const { ctx, emit } = makeCtx();
    await expect(googleProposeVideoCampaignTool.execute(ctx, input({ daily_budget_usd: 500 }))).rejects.toMatchObject({ code: "google_ads_proposal_over_absolute_cap" });
    expect(dg.fetch).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("the write switch off refuses before anything", async () => {
    flagEnabled.mockResolvedValue(false);
    const { ctx, emit } = makeCtx();
    await expect(googleProposeVideoCampaignTool.execute(ctx, input())).rejects.toMatchObject({ code: "google_ads_write_disabled" });
    expect(dg.fetch).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("over-long copy is refused by the schema, never truncated", async () => {
    const { ctx } = makeCtx();
    await expect(googleProposeVideoCampaignTool.execute(ctx, input({ headlines: ["x".repeat(41)] }))).rejects.toThrow();
    await expect(googleProposeVideoCampaignTool.execute(ctx, input({ business_name: "x".repeat(26) }))).rejects.toThrow();
    expect(dg.fetch).not.toHaveBeenCalled();
  });

  it("the description is truthful: Demand Gen, not Display, Autopilot may approve, never 'always operator-approved'", () => {
    const d = googleProposeVideoCampaignTool.description;
    expect(d).toMatch(/Demand Gen/);
    expect(d).toMatch(/not Display/);
    expect(d).toMatch(/Autopilot can when it runs your ads under a budget/);
    expect(d).toMatch(/one enable of the campaign makes it eligible to serve/);
    expect(d).not.toMatch(/operator-approved|NOT AVAILABLE|everything is created PAUSED/);
  });
});

describe("approval copy on cgo-approvable Google classes", () => {
  it.each([
    ["new ad group", () => googleProposeNewAdGroupTool.description],
    ["new ad", () => googleProposeNewAdTool.description],
    ["keywords", () => googleProposeKeywordsTool.description],
    ["status change", () => googleProposeStatusChangeTool.description],
    ["new campaign", () => googleProposeNewCampaignTool.description],
  ])("%s", (_n, d) => {
    expect(d()).not.toMatch(/always operator-approved|always wait for operator/i);
    expect(d()).toMatch(/Autopilot/);
  });
});

describe("google_ads_propose_status_change levels", () => {
  it("ad-group PAUSE with cap enabled → auto class carrying the level", async () => {
    const { ctx, emit } = makeCtx();
    const out = (await googleProposeStatusChangeTool.execute(ctx, {
      campaign_id: "1",
      level: "ad_group",
      ad_group_id: "22",
      status: "PAUSED",
      rationale: "r",
    })) as { decision_class: string };
    expect(out.decision_class).toBe("google_ads.set_status");
    expect(emit.mock.calls[0][1]).toMatchObject({ level: "ad_group", ad_group_id: "22", status: "PAUSED" });
  });

  it("ad level without ad_id → refuses", async () => {
    const { ctx, emit } = makeCtx();
    await expect(
      googleProposeStatusChangeTool.execute(ctx, { campaign_id: "1", level: "ad", ad_group_id: "22", status: "PAUSED", rationale: "r" }),
    ).rejects.toMatchObject({ code: "google_ads_invalid_target" });
    expect(emit).not.toHaveBeenCalled();
  });
});

describe("google_ads_propose_removal / propose_keywords", () => {
  it("nested keyword wins over a leftover flat keyword_text, so the card cannot name a different keyword", async () => {
    const { ctx, emit } = makeCtx();
    await googleProposeRemovalTool.execute(ctx, {
      level: "keyword",
      keyword: { scope: "ad_group", parent_id: "111", criterion_id: "222" },
      parent_id: "333",
      criterion_id: "444",
      keyword_text: "cheap cars",
      rationale: "r",
    });
    const body = emit.mock.calls[0][1] as Record<string, unknown>;
    expect(body.criterion_id).toBe("222");
    expect(body.keyword_text).toBeUndefined();
  });

  it("keyword_text sent inside the nested object survives to the card", async () => {
    const { ctx, emit } = makeCtx();
    await googleProposeRemovalTool.execute(ctx, {
      level: "keyword",
      keyword: { scope: "ad_group", parent_id: "198340816265", criterion_id: "479795307", keyword_text: "turo" },
      name: "Upcar Sales Search Campaign — General ad group",
      rationale: "r",
    });
    const body = emit.mock.calls[0][1] as Record<string, unknown>;
    expect(body.keyword_text).toBe("turo");
    expect(body.criterion_id).toBe("479795307");
  });

  it("removal emits the remove_resource class with a strict body", async () => {
    const { ctx, emit } = makeCtx();
    await googleProposeRemovalTool.execute(ctx, { level: "keyword", scope: "ad_group", parent_id: "5", criterion_id: "9", rationale: "r" });
    expect(emit.mock.calls[0][0]).toBe("google_ads.remove_resource");
    expect(emit.mock.calls[0][1]).toMatchObject({ level: "keyword", scope: "ad_group", parent_id: "5", criterion_id: "9" });
  });

  it("a keyword removal carries whether the keyword is negative, read from the account, never from the model", async () => {
    const args = { level: "keyword", scope: "ad_group", parent_id: "5", criterion_id: "9", rationale: "r", criterion_negative: false };
    for (const [live, want] of [[{ negative: true }, true], [{ negative: false }, false]] as const) {
      kw.get.mockResolvedValueOnce(live);
      const { ctx, emit } = makeCtx();
      await googleProposeRemovalTool.execute(ctx, args);
      expect((emit.mock.calls[0][1] as Record<string, unknown>).criterion_negative).toBe(want);
    }
    expect(kw.get).toHaveBeenCalledWith(TENANT, { level: "ad_group", ad_group_id: "5" }, "9");
    kw.get.mockRejectedValueOnce(new Error("api down"));
    const { ctx, emit } = makeCtx();
    await googleProposeRemovalTool.execute(ctx, args);
    expect(emit.mock.calls[0][1]).not.toHaveProperty("criterion_negative");
  });

  it("positive campaign-level keywords are refused", async () => {
    const { ctx, emit } = makeCtx();
    await expect(
      googleProposeKeywordsTool.execute(ctx, { level: "campaign", campaign_id: "1", negative: false, keywords: [{ text: "a", match_type: "EXACT" }], rationale: "r" }),
    ).rejects.toMatchObject({ code: "google_ads_invalid_keywords_body" });
    expect(emit).not.toHaveBeenCalled();
  });
});

describe("changes to a VIDEO campaign are refused at propose time", () => {
  const refusal = () => Object.assign(new Error("Google's Ads API cannot change VIDEO campaigns."), { code: "google_ads_video_mutate_unsupported" });

  it("status change checks the campaign and files nothing when it is VIDEO", async () => {
    videoGuard.campaign.mockRejectedValueOnce(refusal());
    const { ctx, emit } = makeCtx();
    await expect(googleProposeStatusChangeTool.execute(ctx, { campaign_id: "7", status: "PAUSED", rationale: "r" })).rejects.toMatchObject({ code: "google_ads_video_mutate_unsupported" });
    expect(videoGuard.campaign).toHaveBeenCalledWith(TENANT, "7");
    expect(emit).not.toHaveBeenCalled();
  });

  it("a removal checks the container it lands in", async () => {
    const { ctx } = makeCtx();
    await googleProposeRemovalTool.execute(ctx, { level: "campaign", campaign_id: "7", rationale: "r" });
    expect(videoGuard.campaign).toHaveBeenLastCalledWith(TENANT, "7");
    await googleProposeRemovalTool.execute(ctx, { level: "ad", ad_group_id: "8", ad_id: "9", rationale: "r" });
    expect(videoGuard.adGroup).toHaveBeenLastCalledWith(TENANT, "8");
    videoGuard.adGroup.mockRejectedValueOnce(refusal());
    const { ctx: ctx2, emit } = makeCtx();
    await expect(googleProposeRemovalTool.execute(ctx2, { level: "ad_group", ad_group_id: "8", rationale: "r" })).rejects.toMatchObject({ code: "google_ads_video_mutate_unsupported" });
    expect(emit).not.toHaveBeenCalled();
  });

  it("keywords check the ad group or campaign they land in", async () => {
    const { ctx } = makeCtx();
    await googleProposeKeywordsTool.execute(ctx, { level: "ad_group", ad_group_id: "8", negative: false, keywords: [{ text: "suv", match_type: "PHRASE" }], rationale: "r" });
    expect(videoGuard.adGroup).toHaveBeenLastCalledWith(TENANT, "8");
    await googleProposeKeywordsTool.execute(ctx, { level: "campaign", campaign_id: "7", negative: true, keywords: [{ text: "free", match_type: "PHRASE" }], rationale: "r" });
    expect(videoGuard.campaign).toHaveBeenLastCalledWith(TENANT, "7");
  });

  it("a new ad and an ad-group update check their ad group; a VIDEO_* one files nothing", async () => {
    const { ctx, emit } = makeCtx();
    videoGuard.adGroup.mockRejectedValueOnce(refusal());
    await expect(
      googleProposeNewAdTool.execute(ctx, { ad_group_id: "8", ad: { kind: "responsive_search", final_urls: ["https://x.com"], headlines: ["a", "b", "c"], descriptions: ["d", "e"] }, rationale: "r" }),
    ).rejects.toMatchObject({ code: "google_ads_video_mutate_unsupported" });
    videoGuard.adGroup.mockRejectedValueOnce(refusal());
    await expect(googleProposeAdGroupUpdateTool.execute(ctx, { ad_group_id: "9", cpc_bid_usd: 1, rationale: "r" })).rejects.toMatchObject({ code: "google_ads_video_mutate_unsupported" });
    expect(videoGuard.adGroup.mock.calls.slice(-2).map((c) => c[1])).toEqual(["8", "9"]);
    expect(emit).not.toHaveBeenCalled();
  });
});

describe("USD guard at propose time", () => {
  type Case = { name: string; run: (ctx: ToolContext) => Promise<unknown>; cls: string };
  const cases: Case[] = [
    { name: "budget change", cls: "google_ads.update_campaign_budget", run: (ctx) => googleProposeBudgetChangeTool.execute(ctx, { campaign_id: "123", current_daily_budget_usd: 50, proposed_daily_budget_usd: 55, rationale: "r" }) },
    { name: "enable", cls: "google_ads.set_status_review", run: (ctx) => googleProposeStatusChangeTool.execute(ctx, { campaign_id: "123", level: "campaign", status: "ENABLED", rationale: "r" }) },
    { name: "new campaign", cls: "google_ads.create_campaign", run: (ctx) => googleProposeNewCampaignTool.execute(ctx, { name: "Brand", channel_type: "SEARCH", daily_budget_usd: 10, bidding: { strategy: "MANUAL_CPC" }, rationale: "r" }) },
    { name: "new ad group with a bid", cls: "google_ads.create_ad_group", run: (ctx) => googleProposeNewAdGroupTool.execute(ctx, { campaign_id: "123", name: "G", type: "SEARCH_STANDARD", cpc_bid_usd: 2, rationale: "r" }) },
    { name: "ad group bid", cls: "google_ads.update_ad_group", run: (ctx) => googleProposeAdGroupUpdateTool.execute(ctx, { ad_group_id: "456", cpc_bid_usd: 1.5, rationale: "r" }) },
    { name: "target CPA", cls: "google_ads.update_campaign", run: (ctx) => googleProposeCampaignUpdateTool.execute(ctx, { campaign_id: "123", target_cpa_usd: 12, rationale: "r" }) },
  ];

  it.each(cases)("$name: a USD account files the card", async (c) => {
    const { ctx, emit } = makeCtx();
    await c.run(ctx);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0]).toBe(c.cls);
  });

  it.each(cases)("$name: a EUR account is refused before any other Google read", async (c) => {
    dg.facts.mockImplementation(async () => ({ currency_code: "EUR", budget_period: null }));
    const { ctx, emit } = makeCtx();
    await expect(c.run(ctx)).rejects.toMatchObject({ code: "google_ads_non_usd_account", message: expect.stringMatching(/bills in EUR/) });
    expect(emit).not.toHaveBeenCalled();
    expect(videoGuard.campaign).not.toHaveBeenCalled();
    expect(videoGuard.adGroup).not.toHaveBeenCalled();
  });

  it.each(cases)("$name: an unreadable currency is refused", async (c) => {
    dg.facts.mockImplementation(async () => {
      throw new Error("google down");
    });
    const { ctx, emit } = makeCtx();
    await expect(c.run(ctx)).rejects.toMatchObject({ code: "google_ads_non_usd_account", message: expect.stringMatching(/could not be read/) });
    expect(emit).not.toHaveBeenCalled();
  });

  it("an unreadable currency keeps the read's own code", async () => {
    dg.facts.mockImplementation(async () => {
      throw new ExpectedToolError("google_ads_not_connected", "not connected");
    });
    const { ctx } = makeCtx();
    await expect(cases[0].run(ctx)).rejects.toMatchObject({ code: "google_ads_not_connected" });
  });

  it("no amount, no read: a pause, a ROAS target, a rename, a bid-less ad group", async () => {
    dg.facts.mockImplementation(async () => ({ currency_code: "EUR", budget_period: null }));
    const { ctx, emit } = makeCtx();
    await googleProposeStatusChangeTool.execute(ctx, { campaign_id: "123", level: "campaign", status: "PAUSED", rationale: "r" });
    await googleProposeCampaignUpdateTool.execute(ctx, { campaign_id: "123", target_roas: 3, rationale: "r" });
    await googleProposeAdGroupUpdateTool.execute(ctx, { ad_group_id: "456", new_name: "Renamed", rationale: "r" });
    await googleProposeNewAdGroupTool.execute(ctx, { campaign_id: "123", name: "G", type: "SEARCH_STANDARD", rationale: "r" });
    expect(emit).toHaveBeenCalledTimes(4);
    expect(dg.facts).not.toHaveBeenCalled();
  });

  it("one read per run and account; another run reads again", async () => {
    const { ctx } = makeCtx();
    const inRun: ToolContext = { ...ctx, run_id: "run-a" };
    await cases[0].run(inRun);
    await cases[1].run(inRun);
    await cases[5].run(inRun);
    expect(dg.facts).toHaveBeenCalledTimes(1);
    await cases[0].run({ ...ctx, run_id: "run-b" });
    expect(dg.facts).toHaveBeenCalledTimes(2);
    await cases[0].run({ ...ctx, run_id: "run-b", tenant_id: "22222222-2222-4222-8222-222222222222" });
    expect(dg.facts).toHaveBeenCalledTimes(3);
  });

  it("without a run id nothing is cached", async () => {
    const { ctx } = makeCtx();
    await cases[0].run(ctx);
    await cases[0].run(ctx);
    expect(dg.facts).toHaveBeenCalledTimes(2);
  });
});
