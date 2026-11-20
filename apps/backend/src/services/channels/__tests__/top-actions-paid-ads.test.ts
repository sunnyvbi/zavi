
import { describe, it, expect, vi, beforeEach } from "vitest";

const audienceCatalog = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@/services/connectors/tiktok-ads/targeting", async (orig) => ({
  ...(await orig<typeof import("@/services/connectors/tiktok-ads/targeting")>()),
  readTiktokTargetingForTenant: audienceCatalog.read,
}));
vi.mock("@/services/connectors/tiktok-ads/zavi-videos", async (orig) => ({
  ...(await orig<typeof import("@/services/connectors/tiktok-ads/zavi-videos")>()),
  listZaviVideos: async () => [],
}));

const db = vi.hoisted(() => ({ row: null as Record<string, unknown> | null }));
vi.mock("@/services/tenant-client", () => {
  const chain: Record<string, unknown> = {};
  for (const k of ["from", "select", "eq", "in", "order", "limit"]) chain[k] = () => chain;
  chain.maybeSingle = async () => ({ data: db.row, error: null });
  const storage = { from: () => ({ createSignedUrl: async (path: string) => ({ data: { signedUrl: `https://storage.example/${path}` }, error: null }) }) };
  class StaleRevisionError extends Error {}
  return {
    asTenantId: (s: string) => s,
    tenantClient: () => chain,
    tenantStorage: () => storage,
    tenantRpc: async () => ({ data: null, error: null }),
    globalClient: () => chain,
    applySecretListEditRpc: async () => ({ data: null, error: null }),
    StaleRevisionError,
  };
});
const budget = vi.hoisted(() => ({ read: vi.fn(async () => null) }));
vi.mock("@/services/decisions/ad-budget", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/services/decisions/ad-budget")>()), readActiveAdBudget: budget.read }));

const writerCtx = vi.hoisted(() => {
  const seen: Array<{ top_action_run?: boolean }> = [];
  const passThrough = async (ctx: { emit_decision?: unknown; top_action_run?: boolean }) => {
    seen.push(ctx);
    return ctx.emit_decision;
  };
  return { seen, passThrough };
});
vi.mock("@/services/tools/google-ads/write/_exec-action", () => ({ resolveGoogleAdsEmit: writerCtx.passThrough }));
vi.mock("@/services/tools/reddit-ads/_exec-action", () => ({ resolveRedditAdsEmit: writerCtx.passThrough }));
vi.mock("@/services/tools/x-ads/_exec-action", async (orig) => ({ ...(await orig<object>()), resolveXAdsEmit: writerCtx.passThrough }));
vi.mock("@/services/tools/google-ads/write/_flag-check", () => ({ isGoogleAdsWriteEnabled: async () => true }));
vi.mock("@/services/tools/google-ads/write/_video-guard", () => ({ assertNotVideoAdGroup: async () => {}, assertNotVideoCampaign: async () => {} }));
vi.mock("@/services/connectors/reddit-ads/adapter", async (orig) => ({ ...(await orig<object>()), ownedAccount: async () => ({}) }));
vi.mock("@/services/connectors/reddit-ads/creative-images", () => ({ checkCreativeImage: async () => {} }));
vi.mock("@/services/connectors/x-ads/client", async (orig) => ({
  ...(await orig<object>()),
  xAdsTenantToken: async () => ({ token: "t" }),
  listXOwnPosts: async (_t: unknown, _a: string, ids: string[]) => new Map(ids.filter((id) => id !== "999").map((id) => [id, { has_link: id !== "777", has_video: false }])),
  listXFundingInstruments: async () => [{ id: "fi1", able_to_fund: true, currency: "USD", description: "Visa" }],
}));
vi.mock("@/services/connectors/x-ads/resources", async (orig) => ({ ...(await orig<object>()), assertXWriteAccess: async () => {} }));

import {
  TOP_ACTIONS,
  googleCreateNewAdInputs,
  redditCreateNewAdInputs,
  redditLifetimeCap,
  redditWriteAdCopyInputs,
  subredditOf,
  tiktokCreateNewAdInputs,
  topActionFilesSteps,
  topActionModeKeeps,
  topActionRefusesClass,
  xPostIdsOf,
  xPromotePostInputs,
  youtubePromoteVideoInputs,
  youtubeVideoIdOf,
} from "@/services/channels/top-actions";
import { callGoogleAdsTool } from "@/services/mcp/internal/google-ads";
import { callRedditAdsTool } from "@/services/mcp/internal/reddit-ads";
import { callXAdsTool } from "@/services/mcp/internal/x-ads";
import { cgoApproveChannelAction } from "@/services/growth/cgo-ads";
import { isExecutableAdClass } from "@/services/growth/unattended-policy";
import { evaluateRedditAd } from "@/services/growth/reddit-ad-policy";
import { evaluateXAd } from "@/services/growth/x-ad-policy";
import { googleCreateNewAdInputs as googleInputs, metaCreateNewAdInputs, metaPlacesMustMatch, placesMustMatch, tiktokPlacesMustMatch, tiktokVideoOptions, topActionProposalProblem, xPlacesMustMatch, xPromotePostClientInputs, zaviVideoAspect } from "@/services/channels/top-actions";
import { resolveChannelExecEmit } from "@/services/channels/exec-emit";
import { recipeDeliverableSchema } from "@/agents/lib/channel-recipe-step";
import { signedUploadedVideoUrl } from "@/services/connectors/tiktok-ads/zavi-videos";
import { videoSourceKey } from "@/services/connectors/tiktok-ads/video-uploads";
import { TIKTOK_AGE_GROUPS } from "@/services/connectors/tiktok-ads/targeting";

describe("TikTok founder audience choices", () => {
  const cls = "tiktok_ads.create_launch";
  it("the existing form context uses the tenant's catalog and distinguishes failed discovery", async () => {
    const context = TOP_ACTIONS.tiktok_ads.create_new_ad.context!;
    audienceCatalog.read.mockResolvedValueOnce({ languages: [{ id: "zh-Hant", name: "Traditional Chinese" }] });
    expect(await context("tenant-a")).toMatchObject({ languages: [{ id: "zh-Hant", label: "Traditional Chinese" }], languages_error: false });
    expect(audienceCatalog.read).toHaveBeenLastCalledWith("tenant-a");
    audienceCatalog.read.mockRejectedValueOnce(new Error("catalog unavailable"));
    expect(await context("tenant-b")).toMatchObject({ currency: "USD", languages: [], languages_error: true });
    expect(audienceCatalog.read).toHaveBeenLastCalledWith("tenant-b");
  });
  it("checks audience even with no picked places, and accepts only equivalent sets", () => {
    const inputs = { age_groups: ["AGE_25_34", "AGE_35_44"], gender: "GENDER_FEMALE", languages: ["en", "zh-Hant"] };
    expect(tiktokPlacesMustMatch(inputs, cls, { age_groups: ["AGE_35_44", "AGE_25_34"], gender: "GENDER_FEMALE", languages: ["zh-Hant", "en"] })).toBeNull();
    for (const change of [{ age_groups: [] }, { gender: "GENDER_UNLIMITED" }, { languages: [] }]) {
      expect(tiktokPlacesMustMatch(inputs, cls, { ...inputs, ...change })).toContain("exactly the founder's audience");
    }
  });
  it("blank fields mean broad adult targeting, never model-inferred narrowing", () => {
    expect(tiktokPlacesMustMatch({}, cls, { age_groups: [...TIKTOK_AGE_GROUPS], gender: "GENDER_UNLIMITED", languages: [] })).toBeNull();
    for (const body of [{ age_groups: ["AGE_25_34"] }, { gender: "GENDER_FEMALE" }, { languages: ["en"] }]) {
      expect(tiktokPlacesMustMatch({}, cls, body)).toContain("exactly the founder's audience");
    }
    expect(tiktokPlacesMustMatch({}, cls, { age_groups: ["AGE_13_17"] })).toContain("invalid audience");
  });
  it("accepts the form's targeting shape and rejects unsupported age and gender values", () => {
    const inputs = { about: "An ad", link: "https://example.com", daily_budget: 30, video: "zavi:11111111-2222-4333-8444-555555555555", age_groups: ["AGE_25_34"], gender: "GENDER_FEMALE", languages: ["zh-Hant"] };
    expect(tiktokCreateNewAdInputs.safeParse(inputs).success).toBe(true);
    expect(tiktokCreateNewAdInputs.safeParse({ ...inputs, age_groups: ["AGE_13_17"] }).success).toBe(false);
    expect(tiktokCreateNewAdInputs.safeParse({ ...inputs, gender: "female" }).success).toBe(false);
    expect(topActionProposalProblem(payload("tiktok_ads", "create_new_ad", inputs), cls, { ...inputs, languages: [] })).toContain("exactly the founder's audience");
  });
});

const payload = (channel_slug: string, key: string, inputs: Record<string, unknown>) => ({
  channel_slug,
  top_action: { key, inputs, instruction: "x", by: "u1" },
});

beforeEach(() => {
  writerCtx.seen.length = 0;
  budget.read.mockClear();
  db.row = null;
});

describe("inputs", () => {
  it("reads YouTube links, X post links and community names", () => {
    expect(youtubeVideoIdOf("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3")).toBe("dQw4w9WgXcQ");
    expect(youtubeVideoIdOf("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(youtubeVideoIdOf("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(youtubeVideoIdOf("http://youtu.be/dQw4w9WgXcQ")).toBeNull();
    expect(youtubeVideoIdOf("https://vimeo.com/123")).toBeNull();
    expect(xPostIdsOf("https://x.com/upcar/status/123\nhttps://twitter.com/upcar/status/456?s=20\n123")).toEqual(["123", "456"]);
    expect(xPostIdsOf("https://x.com/upcar/status/123 not-a-post")).toEqual([]);
    expect(subredditOf("r/roadtrip")).toBe("roadtrip");
    expect(subredditOf("https://www.reddit.com/r/roadtrip/")).toBe("roadtrip");
    expect(subredditOf("road trip")).toBeNull();
  });

  it("refuses what each platform cannot take", () => {
    expect(googleCreateNewAdInputs.safeParse({ about: "a", link: "https://x.example", goal: "visit", daily_budget: 20, places: [{ id: "2840", name: "United States" }] }).success).toBe(true);
    expect(googleCreateNewAdInputs.safeParse({ about: "a", link: "https://x.example", goal: "message", daily_budget: 20, places: [{ id: "2840", name: "United States" }] }).success).toBe(false);
    expect(googleCreateNewAdInputs.safeParse({ about: "a", link: "https://x.example", goal: "visit", daily_budget: 20, places: [] }).success).toBe(false);
    expect(googleCreateNewAdInputs.safeParse({ about: "a", link: "https://x.example", goal: "visit", daily_budget: 20, places: [{ id: "Austin", name: "Austin" }] }).success).toBe(false);
    expect(youtubePromoteVideoInputs.safeParse({ video: "https://vimeo.com/1", link: "https://x.example", daily_budget: 20, places: [{ id: "2840", name: "United States" }] }).success).toBe(false);
    expect(youtubePromoteVideoInputs.safeParse({ video: "https://youtu.be/dQw4w9WgXcQ", link: "https://x.example", daily_budget: 20 }).success).toBe(false);
    expect(redditCreateNewAdInputs.safeParse({ about: "a", link: "https://x.example", daily_budget: 4 }).success).toBe(false);
    expect(redditCreateNewAdInputs.safeParse({ about: "a", link: "https://x.example", daily_budget: 20, countries: "US" }).success).toBe(true);
    expect(redditWriteAdCopyInputs.safeParse({ community: "r/roadtrip" }).success).toBe(true);
    const vid = "zavi:11111111-2222-4333-8444-555555555555";
    expect(tiktokCreateNewAdInputs.safeParse({ about: "a", link: "https://x.example", daily_budget: 20, video: vid }).success).toBe(false);
    expect(tiktokCreateNewAdInputs.safeParse({ about: "a", link: "https://x.example", daily_budget: 25, video: vid }).success).toBe(true);
    expect(tiktokCreateNewAdInputs.safeParse({ about: "a", link: "https://x.example", daily_budget: 25 }).success).toBe(false);
    expect(tiktokCreateNewAdInputs.safeParse({ about: "a", link: "https://x.example", daily_budget: 25, video: "https://evil.example/v.mp4" }).success).toBe(false);
    const eleven = Array.from({ length: 11 }, (_, i) => `https://x.com/u/status/${i + 1}`).join("\n");
    expect(xPromotePostClientInputs.safeParse({ posts: eleven, daily_budget: 10 }).success).toBe(false);
    expect(xPromotePostClientInputs.safeParse({ posts: "https://x.com/u/status/1", daily_budget: 10 }).success).toBe(true);
    expect(xPromotePostInputs.safeParse({ posts: "https://x.com/u/status/1", daily_budget: 10 }).success).toBe(false);
    const us = { id: "96683cc9126741d1", name: "United States" };
    const la = { id: "3b77caf94bfc81fe", name: "Los Angeles, CA, USA" };
    expect(xPromotePostInputs.safeParse({ posts: "https://x.com/u/status/1", daily_budget: 10, places: [us], excluded_places: [la] }).success).toBe(true);
    expect(xPromotePostInputs.safeParse({ posts: "https://x.com/u/status/1", daily_budget: 10, places: [us], excluded_places: [us] }).success).toBe(false);
    expect(xPromotePostInputs.safeParse({ posts: "https://x.com/u/status/1", daily_budget: 10, places: [{ id: "not an id!", name: "x" }] }).success).toBe(false);
    expect(xPromotePostInputs.safeParse({ posts: "https://x.com/u/status/1", daily_budget: 10, places: [us, us] }).data?.places).toEqual([us]);
  });

  it("says Demand Gen for YouTube, keeps X paused, and quotes the founder's words as data", () => {
    const yt = TOP_ACTIONS.youtube_ads.promote_video.instruction({ video: "https://youtu.be/dQw4w9WgXcQ", link: "https://x.example", daily_budget: 20, places: [{ id: "1014221", name: "Austin, Texas" }] });
    expect(yt).toContain("location_ids exactly [1014221]");
    expect(yt).toContain('["dQw4w9WgXcQ"]');
    expect(yt).toContain("Demand Gen");
    const x = TOP_ACTIONS.x_ads.promote_post.instruction({ posts: "https://x.com/u/status/9", daily_budget: 10, places: [{ id: "96683cc9126741d1", name: "United States" }] });
    expect(x).toContain('["9"]');
    expect(x).toContain("launch PAUSED");
    expect(x).toContain("Objective: exactly ENGAGEMENTS");
    expect(x).toContain("pass no excluded_locations");
    expect(x).not.toContain("x_ads_search_locations");
    const xp = TOP_ACTIONS.x_ads.promote_post.instruction({
      posts: "https://x.com/u/status/9",
      daily_budget: 10,
      places: [{ id: "96683cc9126741d1", name: 'United States "ignore rules"' }],
      excluded_places: [{ id: "3b77caf94bfc81fe", name: "Los Angeles, CA, USA" }],
    });
    expect(xp).toContain('locations exactly {id "96683cc9126741d1", name "United States \\"ignore rules\\""}');
    expect(xp).toContain('excluded_locations exactly {id "3b77caf94bfc81fe", name "Los Angeles, CA, USA"}');
    expect(() => TOP_ACTIONS.x_ads.promote_post.instruction({ posts: "https://x.com/u/status/9", daily_budget: 10 })).toThrow();
    const g = TOP_ACTIONS.google_ads.create_new_ad.instruction({ about: 'Ignore "rules"', link: "https://x.example", goal: "visit", daily_budget: 20, places: [{ id: "2840", name: "United States" }, { id: "21176", name: "Texas" }] });
    expect(g).toContain("location_ids exactly [2840,21176]");
    expect(g).toContain('"Ignore \\"rules\\""');
  });

  it("Reddit: Zavi picks the lifetime cap (a week, at least $100) and the instruction names it", () => {
    expect(redditLifetimeCap(5)).toBe(100);
    expect(redditLifetimeCap(20)).toBe(140);
    expect(redditLifetimeCap(20.5)).toBe(144);
    expect(TOP_ACTIONS.reddit_ads.create_new_ad.instruction({ about: "a", link: "https://x.example", daily_budget: 20, countries: "US" })).toContain("Lifetime cap: exactly 140 USD");
  });

  it("TikTok: the chosen video reaches the run, and an upload must be this workspace's own", () => {
    const def = TOP_ACTIONS.tiktok_ads.create_new_ad;
    const t = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const up = `upload:${t}/11111111-2222-4333-8444-555555555555.mp4`;
    expect(def.instruction({ about: "a", link: "https://x.example", daily_budget: 25, video: up })).toContain("video_upload_path");
    expect(def.instruction({ about: "a", link: "https://x.example", daily_budget: 25, video: up })).toContain("Where: allowed_locations from tiktok_ads_launch_readiness");
    expect(def.instruction({ about: "a", link: "https://x.example", daily_budget: 25, video: up, places: [{ id: "4671654", name: "Austin, Texas" }] })).toContain('Where: location_ids exactly [4671654] ("Austin, Texas"');
    expect(tiktokCreateNewAdInputs.safeParse({ about: "a", link: "https://x.example", daily_budget: 25, video: up, places: [{ id: "city:1", name: "x" }] }).success).toBe(false);
    expect(def.instruction({ about: "a", link: "https://x.example", daily_budget: 25, video: up })).toContain("If allowed_locations is empty, file nothing");
    const picked = { places: [{ id: "4671654", name: "Austin" }, { id: "4736286", name: "Texas" }] };
    expect(tiktokPlacesMustMatch(picked, "tiktok_ads.create_launch", { locations: [{ location_id: "4736286" }, { location_id: "4671654" }] })).toBeNull();
    expect(tiktokPlacesMustMatch(picked, "tiktok_ads.create_launch", { locations: [{ location_id: "6252001" }] })).toContain("exactly the places the founder picked");
    expect(tiktokPlacesMustMatch({}, "tiktok_ads.create_launch", { locations: [{ location_id: "6252001" }] })).toBeNull();
    expect(tiktokPlacesMustMatch(picked, "tiktok_ads.update_budget", {})).toBeNull();
    expect(topActionProposalProblem(payload("tiktok_ads", "create_new_ad", { about: "a", link: "https://x.example", daily_budget: 25, video: up, ...picked }), "tiktok_ads.create_launch", { locations: [{ location_id: "6252001" }] })).toContain("exactly the places");
    expect(def.instruction({ about: "a", link: "https://x.example", daily_budget: 25, video: "zavi:11111111-2222-4333-8444-555555555555" })).toContain("video_artifact_id");
    expect(def.owned!({ video: up }, t)).toBe(true);
    expect(def.owned!({ video: up }, "ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee")).toBe(false);
    expect(def.owned!({ video: "zavi:11111111-2222-4333-8444-555555555555" }, t)).toBe(true);
  });
});

describe("what each run may hold and file", () => {
  const cases: Array<[string, string, Record<string, unknown>, string, string, string]> = [
    ["google_ads", "create_new_ad", { about: "a", link: "https://x.example", goal: "visit", daily_budget: 20, places: [{ id: "2840", name: "US" }] }, "google_ads__propose_new_campaign", "google_ads.create_campaign", "google_ads.create_ad"],
    ["google_ads", "add_keywords", { ad_group_id: "123" }, "google_ads__propose_keywords", "google_ads.add_keywords", "google_ads.create_campaign"],
    ["youtube_ads", "promote_video", { video: "https://youtu.be/dQw4w9WgXcQ", link: "https://x.example", daily_budget: 20, places: [{ id: "2840", name: "US" }] }, "google_ads__propose_video_campaign", "google_ads.create_campaign", "google_ads.set_status"],
    ["reddit_ads", "create_new_ad", { about: "a", link: "https://x.example", daily_budget: 20, countries: "US" }, "reddit_ads__propose_prepare_campaign", "reddit_ads.prepare_campaign", "reddit_ads.launch_campaign"],
    ["tiktok_ads", "create_new_ad", { about: "a", link: "https://x.example", daily_budget: 25, video: "zavi:11111111-2222-4333-8444-555555555555" }, "tiktok_ads__propose_launch", "tiktok_ads.create_launch", "tiktok_ads.update_budget"],
    ["x_ads", "promote_post", { posts: "https://x.com/u/status/1", daily_budget: 10, places: [{ id: "96683cc9126741d1", name: "US" }] }, "x_ads__propose_create_campaign", "x_ads.create_campaign", "x_ads.update_campaign"],
    ["x_ads", "create_new_ad", { about: "a", daily_budget: 10, places: [{ id: "96683cc9126741d1", name: "US" }] }, "x_ads__propose_create_campaign", "x_ads.create_campaign", "x_ads.set_status"],
  ];
  it.each(cases)("%s/%s keeps its propose tool and files only its class", (slug, key, inputs, tool, allowed, refused) => {
    const p = payload(slug, key, inputs);
    expect(topActionModeKeeps(tool, p)).toBe(true);
    expect(topActionModeKeeps(`${slug}__propose_budget_change`, p)).toBe(false);
    expect(topActionRefusesClass(p, allowed)).toBe(false);
    expect(topActionRefusesClass(p, refused)).toBe(true);
    expect(topActionFilesSteps(p)).toBe(false);
  });

  it("Write ad copy holds no propose tool, files no platform change, and its drafts become cards", () => {
    const p = payload("reddit_ads", "write_ad_copy", { community: "r/roadtrip" });
    expect(topActionModeKeeps("reddit_ads__propose_prepare_campaign", p)).toBe(false);
    expect(topActionModeKeeps("web_fetch__fetch", p)).toBe(true);
    expect(topActionRefusesClass(p, "reddit_ads.prepare_campaign")).toBe(true);
    expect(topActionFilesSteps(p)).toBe(true);
    expect(topActionFilesSteps({ channel_slug: "reddit_ads" })).toBe(true);
    expect(topActionFilesSteps({ channel_slug: "reddit_ads", top_action: { key: "nope", by: "u", inputs: {} } })).toBe(false);
  });
});

describe("Write ad copy: the reply shape it asks for survives the step schema", () => {
  it("each draft's deliverable, filled in as instructed, is kept (a missing label drops it)", () => {
    const text = TOP_ACTIONS.reddit_ads!.write_ad_copy!.instruction({ community: "r/roadtrip" });
    const shape = /"deliverable": (\{[^{}]*\})/.exec(text)?.[1];
    expect(shape).toBeTruthy();
    const filled = JSON.parse(shape!.replace(/"<[^"]*>"/g, '"Weekend getaway: one short honest line"'));
    expect(recipeDeliverableSchema.safeParse(filled).success).toBe(true);
    const { label: _drop, ...noLabel } = filled;
    expect(recipeDeliverableSchema.safeParse(noLabel).success).toBe(false);
  });
});

describe("Autopilot can never approve a button-started proposal", () => {
  const keywords = { level: "ad_group", ad_group_id: "123", negative: false, keywords: [{ text: "tesla rental", match_type: "PHRASE" }], rationale: "Searches that reach this ad group." };

  it("Google: the run's keyword card carries the human origin, and the cgo door refuses it", async () => {
    const emit = vi.fn(async (_c: string, _b: unknown) => "a-1");
    const r = await callGoogleAdsTool({ tenant_id: "t1", run_id: "r1", emit_decision: emit, top_action_run: true }, "propose_keywords", keywords);
    expect(r.ok).toBe(true);
    expect(writerCtx.seen[0].top_action_run).toBe(true);
    const body = emit.mock.calls[0][1] as Record<string, unknown>;
    expect(body.origin).toBe("user_initiated_chat");

    db.row = { channel_slug: "google_ads", run_id: "r1", title: "t", exec_class: "google_ads.add_keywords", exec_payload: body, exec_status: null, status: "pending", approved_by_source: null };
    await expect(cgoApproveChannelAction("t1", "a-1")).resolves.toBe(false);
    expect(budget.read).not.toHaveBeenCalled();
  });

  it("Google: a normal channel run's card has no human origin and reaches the budget check", async () => {
    const emit = vi.fn(async (_c: string, _b: unknown) => "a-2");
    await callGoogleAdsTool({ tenant_id: "t1", run_id: "r1", emit_decision: emit }, "propose_keywords", keywords);
    const body = emit.mock.calls[0][1] as Record<string, unknown>;
    expect(body.origin).toBeUndefined();
    db.row = { channel_slug: "google_ads", run_id: "r1", title: "t", exec_class: "google_ads.add_keywords", exec_payload: body, exec_status: null, status: "pending", approved_by_source: null };
    await expect(cgoApproveChannelAction("t1", "a-2")).resolves.toBe(false);
    expect(budget.read).toHaveBeenCalled();
  });

  const prepare = {
    ad_account_id: "t2_abc",
    name: "Halloween Teslas",
    rationale: "One paused campaign.",
    origin: "specialist",
    operation_key: "op_12345678",
    profile_id: "t2_prof",
    pixel_id: "t2_pix",
    objective: "CLICKS",
    daily_budget_usd: 20,
    lifetime_cap_usd: 100,
    start_time: "2026-10-15T00:00:00Z",
    targeting: { geolocations: ["US"] },
    creatives: [{ name: "Ad one", headline: "Teslas for Halloween", image_url: "https://x.example/i.png", destination_url: "https://upcar.ai/h" }],
  };

  it("Reddit: the preparation carries the human origin whatever the model wrote, and the policy asks the founder", async () => {
    db.row = { exec_status: null, exec_result: null, approved_by_source: null };
    const emit = vi.fn(async (_c: string, _b: unknown) => "a-3");
    const r = await callRedditAdsTool({ tenant_id: "t1", run_id: "r1", emit_decision: emit, top_action_run: true }, "propose_prepare_campaign", prepare);
    expect(r.ok).toBe(true);
    expect(writerCtx.seen[0].top_action_run).toBe(true);
    const body = emit.mock.calls[0][1] as Record<string, unknown>;
    expect(body.origin).toBe("user_initiated_chat");
    const v = evaluateRedditAd({ kind: "ad", exec_class: "reddit_ads.prepare_campaign", payload: body, source: { table: "channel_actions", id: "a-3", run_id: "r1" } }, {} as never);
    expect(v).toMatchObject({ verdict: "ask_founder", reasons: ["founder_staged_change"] });
  });

  it("Reddit: a normal run's preparation keeps the specialist origin", async () => {
    db.row = { exec_status: null, exec_result: null, approved_by_source: null };
    const emit = vi.fn(async (_c: string, _b: unknown) => "a-4");
    await callRedditAdsTool({ tenant_id: "t1", run_id: "r1", emit_decision: emit }, "propose_prepare_campaign", prepare);
    expect((emit.mock.calls[0][1] as Record<string, unknown>).origin).toBe("specialist");
  });

  const create = {
    account_id: "abc12",
    funding_instrument_id: "fi1",
    name: "Promote launch posts",
    objective: "ENGAGEMENTS",
    daily_budget: 10,
    tweet_ids: ["123"],
    launch: "ACTIVE",
    rationale: "Promotes the founder's post.",
  };

  it("X: the campaign is paused and carries the human origin, and the policy asks the founder", async () => {
    const emit = vi.fn(async (_c: string, _b: unknown) => "a-5");
    const r = await callXAdsTool({ tenant_id: "t1", run_id: "r1", emit_decision: emit, top_action_run: true }, "propose_create_campaign", create);
    expect(r.ok).toBe(true);
    expect(writerCtx.seen[0].top_action_run).toBe(true);
    const body = emit.mock.calls[0][1] as Record<string, unknown>;
    expect(body.launch).toBe("PAUSED");
    expect(body.origin).toBe("user_initiated_chat");
    const v = evaluateXAd({ kind: "ad", exec_class: "x_ads.create_campaign", payload: body, source: { table: "channel_actions", id: "a-5", run_id: "r1" } }, {} as never);
    expect(v.verdict).toBe("ask_founder");
    expect(v.reasons).toContain("founder_staged_change");
  });

  it("X: a normal run keeps the model's launch choice and no origin", async () => {
    const emit = vi.fn(async (_c: string, _b: unknown) => "a-6");
    await callXAdsTool({ tenant_id: "t1", run_id: "r1", emit_decision: emit }, "propose_create_campaign", create);
    const body = emit.mock.calls[0][1] as Record<string, unknown>;
    expect(body.launch).toBe("ACTIVE");
    expect(body.origin).toBeUndefined();
  });

  it("TikTok: a button-started launch carries the human origin, so cgo may not approve it", () => {
    expect(isExecutableAdClass("tiktok_ads.create_launch")).toBe(true);
  });

});

describe("TikTok: a founder-uploaded video", () => {
  const t = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const path = `${t}/11111111-2222-4333-8444-555555555555.mp4`;
  it("signs only this workspace's own upload path", async () => {
    await expect(signedUploadedVideoUrl(t, path)).resolves.toMatchObject({ url: `https://storage.example/${path}` });
    await expect(signedUploadedVideoUrl("ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee", path)).rejects.toMatchObject({ code: "tiktok_ads_no_usable_video" });
    await expect(signedUploadedVideoUrl(t, "https://evil.example/v.mp4")).rejects.toMatchObject({ code: "tiktok_ads_no_usable_video" });
  });
  it("has its own upload key, so a retry reuses the same library video", () => {
    expect(videoSourceKey({ upload_path: path })).toBe(`upload:${path}`);
  });
});

describe("Google and YouTube: the proposal targets exactly the founder's places", () => {
  const inputs = { about: "a", link: "https://x.example", goal: "visit", daily_budget: 20, places: [{ id: "21176", name: "Texas" }, { id: "2840", name: "United States" }] };
  const p = payload("google_ads", "create_new_ad", inputs);
  it("never reuses a running ad group: no propose_new_ad, no create_ad class", () => {
    expect(topActionModeKeeps("google_ads__propose_new_ad", p)).toBe(false);
    expect(topActionRefusesClass(p, "google_ads.create_ad")).toBe(true);
    expect(TOP_ACTIONS.google_ads.create_new_ad.instruction(inputs)).not.toContain("propose_new_ad");
  });
  it("matches the same ids in any order, refuses others or a missing list", () => {
    expect(placesMustMatch(inputs, "google_ads.create_campaign", { location_ids: [2840, 21176] })).toBeNull();
    expect(placesMustMatch(inputs, "google_ads.create_campaign", { location_ids: [2840] })).toMatch(/exactly the places/);
    expect(placesMustMatch(inputs, "google_ads.create_campaign", { location_ids: [2840, 21176, 1014221] })).toMatch(/exactly the places/);
    expect(placesMustMatch(inputs, "google_ads.create_campaign", {})).toMatch(/exactly the places/);
    expect(topActionProposalProblem({ channel_slug: "google_ads" }, "google_ads.create_campaign", {})).toBeNull();
  });
  it("excludes exactly the founder's excluded places, and refuses one place in both lists", () => {
    const withOut = { ...inputs, excluded_places: [{ id: "1026339", name: "Round Rock" }] };
    expect(placesMustMatch(withOut, "google_ads.create_campaign", { location_ids: [2840, 21176], excluded_location_ids: [1026339] })).toBeNull();
    expect(placesMustMatch(withOut, "google_ads.create_campaign", { location_ids: [2840, 21176] })).toMatch(/exclude exactly/);
    expect(placesMustMatch(withOut, "google_ads.create_campaign", { location_ids: [2840, 21176], excluded_location_ids: [1026339, 1026339] })).toMatch(/exclude exactly/);
    expect(placesMustMatch(inputs, "google_ads.create_campaign", { location_ids: [2840, 21176], excluded_location_ids: [1026339] })).toMatch(/exclude exactly/);
    expect(TOP_ACTIONS.google_ads.create_new_ad.instruction(withOut)).toContain("excluded_location_ids exactly [1026339]");
    expect(googleInputs.safeParse({ ...inputs, excluded_places: [{ id: "2840", name: "United States" }] }).success).toBe(false);
  });
  it("the card rail refuses a mismatched campaign before writing anything", async () => {
    db.row = { channel_slug: "youtube_ads" };
    const write = vi.fn(async () => "a-1");
    const scope = vi.fn(async () => ({ channel_slug: "youtube_ads", top_action: { key: "promote_video", by: "u", instruction: "x", inputs: { video: "https://youtu.be/dQw4w9WgXcQ", link: "https://x.example", daily_budget: 20, places: [{ id: "2840", name: "US" }] } } }));
    const emit = await resolveChannelExecEmit(new Set(["youtube_ads"]), { tenant_id: "t", run_id: "r", emit_decision: vi.fn(), top_action_run: true }, write, scope);
    await expect(emit!("google_ads.create_campaign", { location_ids: [2276] })).rejects.toMatchObject({ code: "top_action_mismatch" });
    expect(write).not.toHaveBeenCalled();
    await expect(emit!("google_ads.create_campaign", { location_ids: [2840] })).resolves.toBe("a-1");
  });
});

describe("X: only the advertiser's own posts", () => {
  const create = { account_id: "abc12", funding_instrument_id: "fi1", name: "Promote posts", objective: "ENGAGEMENTS", daily_budget: 10, tweet_ids: ["123", "999"], rationale: "r" };
  it("a button-started campaign with another handle's post is refused before any card", async () => {
    const emit = vi.fn(async () => "a-7");
    const r = await callXAdsTool({ tenant_id: "t1", run_id: "r1", emit_decision: emit, top_action_run: true }, "propose_create_campaign", create);
    expect(r.ok).toBe(false);
    expect(r.content).toContain("x_ads_post_not_owned");
    expect(r.content).toContain("999");
    expect(emit).not.toHaveBeenCalled();
  });
});

describe("TikTok video picker", () => {
  it("offers only vertical or unknown-shape Zavi videos, each with a distinct label", () => {
    expect(zaviVideoAspect("video-9x16.mp4")).toBe("vertical");
    expect(zaviVideoAspect("launch-video-16x9.mp4")).toBe("other");
    expect(zaviVideoAspect("video-a-1x1.mp4")).toBe("other");
    expect(zaviVideoAspect("ugc-ab12cd34.mp4")).toBeNull();
    const opts = tiktokVideoOptions([
      { artifact_id: "aaaaaaaa-1111-4111-8111-111111111111", filename: "video-16x9.mp4", created_at: "2026-10-10T09:00:00Z" },
      { artifact_id: "bbbbbbbb-1111-4111-8111-111111111111", filename: "video-9x16.mp4", created_at: "2026-10-10T09:00:00Z" },
      { artifact_id: "cccccccc-1111-4111-8111-111111111111", filename: "video-9x16.mp4", created_at: "2026-10-10T09:00:00Z" },
      { artifact_id: "dddddddd-1111-4111-8111-111111111111", filename: "ugc-dddd.mp4", created_at: null },
    ]);
    expect(opts.map((o) => o.id)).toEqual(["zavi:bbbbbbbb-1111-4111-8111-111111111111", "zavi:cccccccc-1111-4111-8111-111111111111", "zavi:dddddddd-1111-4111-8111-111111111111"]);
    expect(new Set(opts.map((o) => o.label)).size).toBe(3);
    expect(opts[0].label).toContain("2026-10-10 09:00 UTC");
    expect(opts[2].label).toContain("shape not known");
  });
});

describe("Meta: picked places hold on the proposal", () => {
  const base = { about: "a", link: "https://x.example", goal: "visit", placement: "both", daily_budget: 20 };
  const inputs = { ...base, places: [{ id: "region:3886", name: "Texas" }, { id: "country:us", name: "United States" }], excluded_places: [{ id: "city:2418956", name: "Dallas" }] };
  const body = (targeting: Record<string, unknown>) => ({ ad_set: { targeting } });

  it("no places picked: Zavi still picks, any proposal passes", () => {
    expect(metaPlacesMustMatch(base, "meta_ads.create_ad", {})).toBeNull();
    expect(metaPlacesMustMatch(base, "meta_ads.launch_campaign", body({}))).toBeNull();
    expect(TOP_ACTIONS.meta_ads.create_new_ad.instruction(base)).toContain("meta_ads_propose_new_ad");
  });

  it("places picked: a new campaign only, shown exactly there and excluding exactly the excluded", () => {
    expect(metaPlacesMustMatch(inputs, "meta_ads.create_ad", {})).toMatch(/new campaign/);
    const good = body({ geo_locations: { countries: ["US"], regions: [{ key: "3886" }] }, excluded_geo_locations: { cities: [{ key: "2418956" }] } });
    expect(metaPlacesMustMatch(inputs, "meta_ads.launch_campaign", good)).toBeNull();
    expect(metaPlacesMustMatch(inputs, "meta_ads.launch_campaign", body({ geo_locations: { countries: ["US"] }, excluded_geo_locations: { cities: [{ key: "2418956" }] } }))).toMatch(/exactly the places/);
    expect(metaPlacesMustMatch(inputs, "meta_ads.launch_campaign", body({ geo_locations: { countries: ["US"], regions: [{ key: "3886" }] } }))).toMatch(/exclude exactly/);
    const text = TOP_ACTIONS.meta_ads.create_new_ad.instruction(inputs);
    expect(text).toContain('ad_set.excluded_locations exactly ["city:2418956"]');
    expect(text).not.toContain("meta_ads_propose_new_ad.");
  });

  it("refuses zips or other place shapes beside the picked ones, and a place both shown and excluded", () => {
    const zip = body({ geo_locations: { countries: ["US"], regions: [{ key: "3886" }], zips: [{ key: "US:94105" }] }, excluded_geo_locations: { cities: [{ key: "2418956" }] } });
    expect(metaPlacesMustMatch(inputs, "meta_ads.launch_campaign", zip)).toMatch(/only the founder's places/);
    const onlyOut = { ...base, excluded_places: [{ id: "country:us", name: "United States" }] };
    const both = body({ geo_locations: { countries: ["US"] }, excluded_geo_locations: { countries: ["US"] } });
    expect(metaPlacesMustMatch(onlyOut, "meta_ads.launch_campaign", both)).toMatch(/both included and excluded/);
    expect(metaPlacesMustMatch(onlyOut, "meta_ads.launch_campaign", body({ geo_locations: { countries: ["CA"] }, excluded_geo_locations: { countries: ["US"] } }))).toBeNull();
    expect(metaCreateNewAdInputs.safeParse({ ...base, places: Array.from({ length: 26 }, (_, k) => ({ id: `city:${k}`, name: `C${k}` })) }).success).toBe(false);
  });

  it("refuses a place in both lists, and an id that is not Meta's", () => {
    expect(metaCreateNewAdInputs.safeParse(inputs).success).toBe(true);
    expect(metaCreateNewAdInputs.safeParse({ ...base, places: [{ id: "city:1", name: "A" }], excluded_places: [{ id: "city:1", name: "A" }] }).success).toBe(false);
    expect(metaCreateNewAdInputs.safeParse({ ...base, places: [{ id: "2840", name: "US" }] }).success).toBe(false);
  });
});

describe("X Ads promote_post places", () => {
  const us = { id: "96683cc9126741d1", name: "United States" };
  const la = { id: "3b77caf94bfc81fe", name: "Los Angeles, CA, USA" };
  const posts = "https://x.com/u/status/1";

  it("files only a campaign with exactly the founder's targeted and excluded places", () => {
    const inputs = { places: [us], excluded_places: [la] };
    expect(xPlacesMustMatch(inputs, "x_ads.create_campaign", { locations: [us], excluded_locations: [la] })).toBeNull();
    expect(xPlacesMustMatch(inputs, "x_ads.create_campaign", { locations: [la], excluded_locations: [la] })).toContain("target exactly the places");
    expect(xPlacesMustMatch(inputs, "x_ads.create_campaign", { locations: [us], excluded_locations: [] })).toContain("exclude exactly the places");
    expect(xPlacesMustMatch(inputs, "x_ads.update_campaign", {})).toBeNull();
  });

  it("with no resolved places nothing may be filed: the server fills the country before the run", () => {
    expect(xPlacesMustMatch({}, "x_ads.create_campaign", { locations: [us] })).toContain("no target locations");
    expect(xPlacesMustMatch({ places: [us] }, "x_ads.create_campaign", { locations: [us], excluded_locations: [la] })).toContain("excluded no places");
  });

  it("is wired into the X top action's proposal check", () => {
    expect(
      topActionProposalProblem(payload("x_ads", "promote_post", { posts, daily_budget: 10, places: [us] }), "x_ads.create_campaign", { locations: [la] }),
    ).toContain("target exactly the places");
  });
});
