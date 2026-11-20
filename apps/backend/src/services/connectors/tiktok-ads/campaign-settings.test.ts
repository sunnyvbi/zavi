import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/services/channels/exec-actions", () => ({ recordChannelExecAction: vi.fn() }));
vi.mock("@/services/channels/exec-emit", () => ({ cgoChannelRailEmit: vi.fn(), resolveChannelExecEmit: vi.fn() }));

const m = vi.hoisted(() => ({
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  posts: [] as Array<{ endpoint: string; body: Record<string, unknown> }>,
  readFail: false, readError: null as Error | null, postMode: "apply", role: "owner", currency: "USD", timezone: "America/Los_Angeles",
  knownAccount: true, locked: false, stops: [] as Array<Record<string, unknown>>,
  hold: { status: "held", tenant_id: "tenant", idem_key: "hold", fresh: true } as Record<string, unknown>,
  onReserve: null as (() => void) | null,
  pages: null as Array<{ list: Array<Record<string, unknown>>; page_info?: { total_page: number } }> | null,
  readPages: [] as number[],
  generatedVideo: false,
}));
vi.mock("./video-provenance", () => ({ isKnownGeneratedVideo: vi.fn(async () => m.generatedVideo) }));
vi.mock("./ad-accounts", () => ({ ensureAdAccounts: async () => ({ connected: true, accounts: m.knownAccount ? [{ advertiser_id: "111" }] : [] }) }));
vi.mock("./composio-read", () => ({
  tiktokAdsAccount: async () => ({ tenant_id: "tenant", connected_account_id: "ca", auth_config_id: "config" }),
  verifyAdvertisers: async () => [{ advertiser_id: "111", name: "Main", currency: m.currency, timezone: m.timezone }],
  tt: async (_: unknown, path: string) => {
    if (m.readFail) throw new Error("read failed");
    if (m.readError) throw m.readError;
    const url = new URL(path, "https://tiktok.invalid");
    const kind = url.pathname.split("/")[1];
    if (kind === "dmp") return { list: [{ custom_audience_id: "501", name: "Visitors", is_valid: true }], page_info: { total_page: 1 } };
    if (kind === "tool") return { interest_categories: [{ interest_category_id: "601", interest_category_name: "Sport", placements: ["PLACEMENT_TIKTOK"] }] };
    if (m.pages && kind === "ad") { const page = Number(url.searchParams.get("page")); m.readPages.push(page); return m.pages[page - 1]; }
    const filter = JSON.parse(url.searchParams.get("filtering")!);
    const rows = (m.rows[kind] ?? []).filter(row => Object.entries(filter).every(([key, ids]) => (ids as string[]).includes(String(row[key.slice(0, -1)]))));
    return { list: structuredClone(rows), page_info: { total_page: 1 } };
  },
}));
vi.mock("./objects", () => ({
  isDailyMode: (mode: string) => ["BUDGET_MODE_DAY", "BUDGET_MODE_DYNAMIC_DAILY_BUDGET"].includes(mode),
  tiktokPost: async (_: unknown, endpoint: string, body: Record<string, unknown>) => {
    m.posts.push({ endpoint, body });
    if (m.postMode === "transport") throw new Error("connection lost");
    if (m.postMode === "refuse") { const { ExpectedToolError } = await import("@/services/tools/types"); throw new ExpectedToolError("tiktok_ads_write_refused", "refused"); }
    if (m.postMode === "ignore") return {};
    const kind = endpoint.split("/")[1];
    const patch = kind === "ad" ? (body.creatives as Array<Record<string, unknown>>)[0] : body;
    const id = patch[`${kind}_id`];
    const row = m.rows[kind].find(row => row[`${kind}_id`] === id)!;
    if (kind === "adgroup" && m.postMode === "full_replace") { row.languages = []; row.dayparting = "1".repeat(336); row.audience_ids = []; row.interest_category_ids = []; }
    Object.assign(row, patch);
    if (m.postMode === "read_fail") m.readFail = true;
    if (m.postMode === "read_revoked") { const { ExpectedToolError } = await import("@/services/tools/types"); m.readError = new ExpectedToolError("tiktok_ads_token_revoked", "reconnect"); }
    if (m.postMode === "reset_identity") row.identity_id = "different";
    if (m.postMode === "reset_utm") row.utm_params = [];
    if (m.postMode === "reset_disclosure") row.aigc_disclosure_type = "NOT_DECLARED";
    if (m.postMode === "reset_nullable") row.click_tracking_url = "https://unexpected.example/track";
    if (m.postMode === "reset_group") row.targeting_expansion = { expansion_enabled: false, expansion_types: [] };
    if (m.postMode === "reset_parent") m.rows.campaign[0].budget_optimize_on = true;
    if (m.postMode === "reorder_group") for (const key of ["location_ids", "age_groups", "languages", "audience_ids", "interest_category_ids"]) if (Array.isArray(row[key])) row[key] = [...row[key] as unknown[]].reverse();
    return {};
  },
}));
vi.mock("./launch-readiness", () => ({
  assertLandingUrl: vi.fn(async (url: string) => { if (url.includes("localhost")) throw new Error("unsafe URL"); }),
  readLaunchVideo: vi.fn(async (_a: unknown, _adv: string, id: string) => id === "missing" ? null : ({ video_id: id, width: 1080, height: 1920, duration_s: 15, allowed_placements: ["PLACEMENT_TIKTOK"], displayable: true, cover_url: "https://tiktok.example/cover.jpg" })),
  uploadLaunchImage: vi.fn(async () => "new-cover"),
}));
vi.mock("./locations", () => ({ verifyTiktokLocations: vi.fn(async (_a: unknown, _adv: string, ids: string[]) => { if (ids.includes("999")) throw new Error("unknown place"); return ids.map(location_id => ({ location_id, name: location_id === "840" ? "United States" : "Canada", level: "COUNTRY", country_code: location_id === "840" ? "US" : "CA" })); }), readTiktokLocationNames: vi.fn(async (_a: unknown, _adv: string, ids: string[]) => Object.fromEntries(ids.map(id => [id, id === "840" ? "United States" : "Retired market"]))) }));
vi.mock("./targeting", async importOriginal => ({ ...await importOriginal<typeof import("./targeting")>(), verifyTiktokLanguages: vi.fn(async () => []) }));
vi.mock("@/services/auth/tenant-role", () => ({ loadTenantRoleFor: async () => m.role }));
vi.mock("@/services/channels/lock", () => ({ assertSpendWritesOn: async () => { if (m.locked) throw new Error("locked"); } }));
vi.mock("@/services/growth/preview-plan", () => ({ channelPlanLock: async () => null }));
vi.mock("@/services/growth/test-stops", () => ({ testStopsForObjects: async () => m.stops, isOpenStop: (s: { state: string }) => s.state === "monitoring" }));
vi.mock("@/services/decisions/ad-budget", () => ({
  reserveAdSpend: vi.fn(async () => { m.onReserve?.(); return m.hold; }),
  commitAdSpend: vi.fn(async () => {}), dropAdSpendHold: vi.fn(async () => {}),
}));

import { readCampaignSettings, readSettingsObject, proposeSettingsBody, executeTiktokSettings, settingsChangeInput, settingsUpdateRequest, tiktokScheduleInstant, resolveSettingsHold } from "./campaign-settings";
import { tiktokActionRaisesSpend } from "./held-schema";
import { isKnownGeneratedVideo } from "./video-provenance";
import { reserveAdSpend, commitAdSpend, dropAdSpendHold } from "@/services/decisions/ad-budget";
import { verifyTiktokLocations } from "./locations";
import { assertLandingUrl, readLaunchVideo, uploadLaunchImage } from "./launch-readiness";
import { verdictFor } from "@/services/channels/exec-failure";

beforeEach(() => {
  vi.clearAllMocks();
  m.rows = {
    campaign: [{ campaign_id: "101", campaign_name: "Zavi · Test · campaign · zv1234567890", operation_status: "ENABLE", budget_mode: "BUDGET_MODE_INFINITE", budget: 0, objective_type: "TRAFFIC" }],
    adgroup: [{ campaign_id: "101", adgroup_id: "201", adgroup_name: "Group", operation_status: "ENABLE", budget_mode: "BUDGET_MODE_DAY", budget: 30, location_ids: ["840"], age_groups: ["AGE_25_34"], gender: "GENDER_UNLIMITED", languages: [], schedule_type: "SCHEDULE_START_END", schedule_start_time: "2027-05-01 08:00:00", schedule_end_time: "2027-05-15 08:00:00" }],
    ad: [{ campaign_id: "101", adgroup_id: "201", ad_id: "301", ad_name: "Video", operation_status: "ENABLE", ad_format: "SINGLE_VIDEO", identity_id: "identity", identity_type: "TT_USER", video_id: "video1", image_ids: ["cover1"], ad_text: "Before", landing_page_url: "https://example.com", call_to_action: "LEARN_MORE" }],
  };
  m.rows.adgroup[0].pacing = "PACING_MODE_SMOOTH";
  m.posts = []; m.readFail = false; m.readError = null; m.postMode = "apply"; m.role = "owner"; m.currency = "USD"; m.timezone = "America/Los_Angeles"; m.knownAccount = true; m.locked = false; m.stops = []; m.onReserve = null;
  m.hold = { status: "held", tenant_id: "tenant", idem_key: "hold", fresh: true };
  m.pages = null; m.readPages = [];
  m.generatedVideo = false;
});
const objectIds = { campaign: "101", ad_group: "201", ad: "301" } as const;
async function proposal(level: "campaign" | "ad_group" | "ad", changes: Record<string, unknown>) {
  const current = await readSettingsObject("tenant", "111", "101", level, objectIds[level]);
  return proposeSettingsBody("tenant", { advertiser_id: "111", campaign_id: "101", level, object_id: current.id, revision: current.revision, changes });
}
const execution = (body: unknown, extra: Record<string, unknown> = {}) => executeTiktokSettings({ id: "action", tenant_id: "tenant", decision_class: "tiktok_ads.update_settings", body, approved_by: "owner", approved_by_source: null, exec_source: "channel_actions", ...extra });

describe("advanced manual Traffic edits", () => {
  beforeEach(() => {
    Object.assign(m.rows.adgroup[0], { promotion_type: "WEBSITE", placements: ["PLACEMENT_TIKTOK"], optimization_goal: "CLICK", billing_event: "CPC", bid_type: "BID_TYPE_NO_BID" });
  });
  it("writes exact reviewed audience, device, schedule and interaction settings", async () => {
    const changes = { audience_ids: ["501"], interest_category_ids: ["601"], operating_systems: ["IOS"], network_types: ["WIFI"], dayparting: "1".repeat(48) + "0".repeat(288), comment_disabled: true, share_disabled: true };
    const body = await proposal("ad_group", changes);
    const out = await execution(body);
    expect(out.ok).toBe(true);
    expect(m.posts[0].body).toMatchObject({ advertiser_id: "111", adgroup_id: "201", ...changes, pacing: "PACING_MODE_SMOOTH", location_ids: ["840"] });
    expect(reserveAdSpend).not.toHaveBeenCalled();
  });
  it("validates CPC bid pairing and detects provider resets", async () => {
    await expect(proposal("ad_group", { bid_type: "BID_TYPE_CUSTOM" })).rejects.toThrow("positive CPC");
    const body = await proposal("ad_group", { bid_type: "BID_TYPE_CUSTOM", bid_price: 2 });
    expect((await execution(body)).ok).toBe(true);
  });
  it("switches from cost cap to maximum delivery without requiring the old inactive bid to remain visible", async () => {
    Object.assign(m.rows.adgroup[0], { bid_type: "BID_TYPE_CUSTOM", bid_price: 2 });
    const body = await proposal("ad_group", { bid_type: "BID_TYPE_NO_BID" });
    expect(await execution(body)).toMatchObject({ ok: true });
    expect(m.posts[0].body.bid_type).toBe("BID_TYPE_NO_BID");
    expect(m.posts[0].body).not.toHaveProperty("bid_price");
  });
  it("rejects advanced controls on incompatible placements and CBO bids", async () => {
    m.rows.adgroup[0].placements = ["PLACEMENT_PANGLE"];
    await expect(proposal("ad_group", { comment_disabled: true })).rejects.toMatchObject({ code: "tiktok_ads_settings_unsupported" });
    m.rows.adgroup[0].placements = ["PLACEMENT_TIKTOK"];
    m.rows.campaign[0].budget_optimize_on = true;
    await expect(proposal("ad_group", { bid_type: "BID_TYPE_CUSTOM", bid_price: 2 })).rejects.toMatchObject({ code: "tiktok_ads_settings_unsupported" });
  });
  it("rejects an approved group edit if parent budget strategy changes", async () => {
    const body = await proposal("ad_group", { bid_type: "BID_TYPE_CUSTOM", bid_price: 2 });
    m.rows.campaign[0].budget_optimize_on = true;
    expect(await execution(body)).toMatchObject({ ok: false });
    expect(m.posts).toHaveLength(0);
  });
  it("reports uncertainty when parent budget strategy changes during the write", async () => {
    const body = await proposal("ad_group", { comment_disabled: true });
    m.postMode = "reset_parent";
    expect(await execution(body)).toMatchObject({ ok: false, code: "exec_outcome_unknown" });
  });
  it("does not offer account-time dayparting without a known timezone", async () => {
    m.timezone = "";
    await expect(proposal("ad_group", { dayparting: "1".repeat(336) })).rejects.toMatchObject({ code: "tiktok_ads_settings_unsupported" });
  });
  it("reserves the dynamic daily allowance when an end-date edit extends exposure", async () => {
    m.rows.adgroup[0].budget_mode = "BUDGET_MODE_DYNAMIC_DAILY_BUDGET";
    const body = await proposal("ad_group", { schedule_end_time: "2027-05-16T15:00:00.000Z" });
    expect((await execution(body)).ok).toBe(true);
    expect(reserveAdSpend).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ daily_delta_usd: 30, delivery_factor: 1.25 }));
  });
  it("supports long existing names without shortening unrelated settings", async () => {
    m.rows.adgroup[0].adgroup_name = "A".repeat(400);
    const body = await proposal("ad_group", { comment_disabled: true });
    expect(body.name).toHaveLength(400);
    expect((await execution(body)).ok).toBe(true);
  });
});

describe("non-Spark replacement disclosure", () => {
  beforeEach(() => {
    Object.assign(m.rows.ad[0], { identity_type: "CUSTOMIZED_USER", aigc_disclosure_type: "NOT_DECLARED" });
    Object.assign(m.rows.adgroup[0], { placement_type: "PLACEMENT_TYPE_NORMAL", placements: ["PLACEMENT_TIKTOK"] });
  });
  it("uses the same capability and revision for the hierarchy and targeted read", async () => {
    const hierarchy = await readCampaignSettings("tenant", "111", "101");
    const targeted = await readSettingsObject("tenant", "111", "101", "ad", "301");
    expect(hierarchy.ads[0].revision).toBe(targeted.revision);
    expect(targeted.editable_fields).toContain("aigc_disclosure_type");
  });
  it("does not require the TikTok disclosure field on Pangle-only ads", async () => {
    m.rows.adgroup[0].placements = ["PLACEMENT_PANGLE"];
    const object = await readSettingsObject("tenant", "111", "101", "ad", "301");
    expect(object.editable_fields).not.toContain("aigc_disclosure_type");
    const body = await proposal("ad", { video_id: "video2" });
    expect(await execution(body)).toMatchObject({ ok: true });
    expect(m.posts[0].body).toMatchObject({ patch_update: true });
  });
  it("does not classify catalog videos as editable standard videos", async () => {
    m.rows.ad[0].vertical_video_strategy = "CATALOG_VIDEOS";
    await expect(proposal("ad", { video_id: "video2", aigc_disclosure_type: "SELF_DISCLOSURE" })).rejects.toMatchObject({ code: "tiktok_ads_creative_unsupported" });
  });
  it("does not offer a caption update that a search ad's ad_texts would override", async () => {
    m.rows.ad[0].ad_texts = ["Search caption"];
    const object = await readSettingsObject("tenant", "111", "101", "ad", "301");
    expect(object.editable_fields).toEqual(["ad_name"]);
    await expect(proposal("ad", { ad_text: "After", landing_page_url: "https://example.org" })).rejects.toMatchObject({ code: "tiktok_ads_creative_unsupported" });
  });
  it("requires the old caption before a full creative update", async () => {
    delete m.rows.ad[0].ad_text;
    const object = await readSettingsObject("tenant", "111", "101", "ad", "301");
    expect(object.editable_fields).not.toContain("landing_page_url");
    await expect(proposal("ad", { landing_page_url: "https://example.org" })).rejects.toMatchObject({ code: "tiktok_ads_creative_unreadable" });
  });
  it("supports single-video catalog-sales disclosure only in the documented configuration", async () => {
    Object.assign(m.rows.campaign[0], { objective_type: "PRODUCT_SALES", campaign_product_source: "CATALOG" });
    m.rows.adgroup[0].shopping_ads_type = "VIDEO";
    expect((await readSettingsObject("tenant", "111", "101", "ad", "301")).editable_fields).toContain("aigc_disclosure_type");
    m.rows.campaign[0].campaign_product_source = "STORE";
    expect((await readSettingsObject("tenant", "111", "101", "ad", "301")).editable_fields).not.toContain("aigc_disclosure_type");
  });
  it("invalidates reviewed disclosure edits when parent eligibility changes", async () => {
    const body = await proposal("ad", { video_id: "video2", aigc_disclosure_type: "SELF_DISCLOSURE" });
    m.rows.adgroup[0].placements = ["PLACEMENT_PANGLE"];
    expect(await execution(body)).toMatchObject({ ok: false, code: "tiktok_ads_settings_drifted" });
    expect(m.posts).toEqual([]);
  });
  it("requires a fresh choice for replacement media and disallows a standalone or same-video toggle", async () => {
    await expect(proposal("ad", { video_id: "video2" })).rejects.toMatchObject({ code: "tiktok_ads_disclosure_required" });
    await expect(proposal("ad", { aigc_disclosure_type: "SELF_DISCLOSURE" })).rejects.toMatchObject({ code: "tiktok_ads_disclosure_unsupported" });
    await expect(proposal("ad", { video_id: "video1", aigc_disclosure_type: "SELF_DISCLOSURE" })).rejects.toMatchObject({ code: "tiktok_ads_disclosure_unsupported" });
    expect(m.posts).toEqual([]);
  });
  it("preserves the fresh choice even when it equals the previous video's disclosure", async () => {
    const body = await proposal("ad", { video_id: "video2", aigc_disclosure_type: "NOT_DECLARED" });
    expect(body.changes).toMatchObject({ aigc_disclosure_type: "NOT_DECLARED" });
    expect(await execution(body)).toMatchObject({ ok: true });
    expect(m.posts[0].body).toMatchObject({ patch_update: false, creatives: [{ video_id: "video2", aigc_disclosure_type: "NOT_DECLARED", identity_type: "CUSTOMIZED_USER", ad_name: "Video", image_ids: ["new-cover"] }] });
  });
  it("rejects false declarations for known generated videos, including direct library reuse", async () => {
    m.generatedVideo = true;
    await expect(proposal("ad", { video_id: "video2", aigc_disclosure_type: "NOT_DECLARED" })).rejects.toMatchObject({ code: "tiktok_ads_disclosure_required" });
    const body = await proposal("ad", { video_id: "video2", aigc_disclosure_type: "SELF_DISCLOSURE" });
    expect(await execution(body)).toMatchObject({ ok: true });
  });
  it("does not depend on the upload cache when the user already selects AI disclosure", async () => {
    const body = await proposal("ad", { video_id: "video2", aigc_disclosure_type: "SELF_DISCLOSURE" });
    expect(await execution(body)).toMatchObject({ ok: true });
    expect(isKnownGeneratedVideo).not.toHaveBeenCalled();
  });
  it("rechecks provenance before executing a previously reviewed declaration", async () => {
    const body = await proposal("ad", { video_id: "video2", aigc_disclosure_type: "NOT_DECLARED" });
    m.generatedVideo = true;
    expect(await execution(body)).toMatchObject({ ok: false, code: "tiktok_ads_disclosure_required" });
    expect(m.posts).toEqual([]);
  });
  it("does not offer or send the non-Spark disclosure field for linked Spark identities", async () => {
    m.rows.ad[0].identity_type = "TT_USER";
    const object = await readSettingsObject("tenant", "111", "101", "ad", "301");
    expect(object.editable_fields).not.toContain("aigc_disclosure_type");
    await expect(proposal("ad", { video_id: "video2", aigc_disclosure_type: "SELF_DISCLOSURE" })).rejects.toMatchObject({ code: "tiktok_ads_disclosure_unsupported" });
  });
  it("requires a complete preserved creative and confirms disclosure after the write", async () => {
    const body = await proposal("ad", { video_id: "video2", aigc_disclosure_type: "SELF_DISCLOSURE" });
    m.postMode = "reset_disclosure";
    expect(await execution(body)).toMatchObject({ ok: false, code: "exec_outcome_unknown" });
    delete m.rows.ad[0].image_ids;
    const object = await readSettingsObject("tenant", "111", "101", "ad", "301");
    expect(object.editable_fields).not.toContain("video_id");
    expect(object.editable_fields).not.toContain("aigc_disclosure_type");
  });
  it("detects a provider default replacing an explicit null during a full creative update", async () => {
    m.rows.ad[0].click_tracking_url = null;
    const body = await proposal("ad", { landing_page_url: "https://example.org" });
    m.postMode = "reset_nullable";
    expect(await execution(body)).toMatchObject({ ok: false, code: "exec_outcome_unknown" });
    expect((m.posts[0].body.creatives as Record<string, unknown>[])[0]).not.toHaveProperty("click_tracking_url");
  });
});

describe("TikTok settings reads and proposals", () => {
  it("treats reordered provider membership selections as the same group revision", async () => {
    m.rows.adgroup[0].audience_ids = ["audience-b", "audience-a"];
    m.rows.adgroup[0].interest_category_ids = ["interest-b", "interest-a"];
    m.rows.adgroup[0].location_ids = ["840", "124"];
    const before = await readSettingsObject("tenant", "111", "101", "ad_group", "201");
    m.rows.adgroup[0].audience_ids = ["audience-a", "audience-b"];
    m.rows.adgroup[0].interest_category_ids = ["interest-a", "interest-b"];
    m.rows.adgroup[0].location_ids = ["124", "840"];
    expect((await readSettingsObject("tenant", "111", "101", "ad_group", "201")).revision).toBe(before.revision);
  });
  it("preserves ordering in nested actions rather than treating every array as a membership set", async () => {
    m.rows.adgroup[0].actions = [{ action_category_ids: ["first", "second"], action_scene: "VIDEO_RELATED" }];
    const before = await readSettingsObject("tenant", "111", "101", "ad_group", "201");
    m.rows.adgroup[0].actions = [{ action_category_ids: ["second", "first"], action_scene: "VIDEO_RELATED" }];
    expect((await readSettingsObject("tenant", "111", "101", "ad_group", "201")).revision).not.toBe(before.revision);
  });
  it.each([
    ["bid_price", 2],
    ["interest_category_ids", ["new-interest"]],
    ["audience_ids", ["new-audience"]],
    ["dayparting", "1".repeat(48) + "0".repeat(288)],
    ["placement_type", "PLACEMENT_TYPE_AUTOMATIC"],
    ["targeting_expansion", { expansion_enabled: true, expansion_types: ["INTEREST"] }],
  ])("rejects an opened ad group when private %s configuration changes", async (key, value) => {
    const current = await readSettingsObject("tenant", "111", "101", "ad_group", "201");
    m.rows.adgroup[0][String(key)] = value;
    await expect(proposeSettingsBody("tenant", { advertiser_id: "111", campaign_id: "101", object_id: "201", level: "ad_group", revision: current.revision, changes: { gender: "GENDER_FEMALE" } })).rejects.toMatchObject({ code: "tiktok_ads_settings_drifted" });
  });
  it("exposes supported advanced selections, keeps nested rules private and ignores unrelated provider telemetry", async () => {
    m.rows.adgroup[0].audience_ids = ["private-audience"];
    m.rows.adgroup[0].targeting_expansion = { expansion_types: ["INTEREST"], expansion_enabled: true };
    const current = await readSettingsObject("tenant", "111", "101", "ad_group", "201");
    expect(current.settings.audience_ids).toEqual(["private-audience"]);
    expect(current.settings).not.toHaveProperty("targeting_expansion");
    m.rows.adgroup[0].modify_time = "provider timestamp";
    m.rows.adgroup[0].targeting_expansion = { expansion_enabled: true, expansion_types: ["INTEREST"] };
    expect((await readSettingsObject("tenant", "111", "101", "ad_group", "201")).revision).toBe(current.revision);
  });
  it("allows Smart Audience demographics while retaining automatic targeting and language restrictions", async () => {
    m.rows.adgroup[0].smart_audience_enabled = true;
    const current = await readSettingsObject("tenant", "111", "101", "ad_group", "201");
    expect(current.editable_fields).toEqual(expect.arrayContaining(["age_groups", "gender", "location_ids"]));
    expect(current.editable_fields).not.toContain("languages");
    expect(await execution(await proposal("ad_group", { gender: "GENDER_FEMALE", location_ids: ["124"], age_groups: ["AGE_18_24"] }))).toMatchObject({ ok: true });
    expect(m.rows.adgroup[0].smart_audience_enabled).toBe(true);
    await expect(proposal("ad_group", { languages: ["en"] })).rejects.toMatchObject({ code: "tiktok_ads_targeting_unsupported" });
    m.rows.adgroup[0].auto_targeting_enabled = true;
    await expect(proposal("ad_group", { gender: "GENDER_MALE" })).rejects.toMatchObject({ code: "tiktok_ads_targeting_unsupported" });
  });
  it("retains the highest page count when later pages omit or lower it", async () => {
    m.pages = [{ list: [], page_info: { total_page: 3 } }, { list: [] }, { list: m.rows.ad, page_info: { total_page: 1 } }];
    expect((await readCampaignSettings("tenant", "111", "101")).ads).toHaveLength(1);
    expect(m.readPages).toEqual([1, 2, 3]);
  });
  it("disables unreadable finite schedules without blocking names or regular targeting", async () => {
    m.rows.adgroup[0].schedule_end_time = "2027-02-30 01:30:00";
    const object = await readSettingsObject("tenant", "111", "101", "ad_group", "201");
    expect(object.editable_fields).toContain("adgroup_name");
    expect(object.editable_fields).not.toContain("schedule_end_time");
    await expect(proposal("ad_group", { schedule_end_time: "2027-05-20T15:00:00.000Z" })).rejects.toMatchObject({ code: "tiktok_ads_schedule_unreadable" });
  });
  it("keeps an active group's end editable but cannot move its past start", async () => {
    m.rows.adgroup[0].schedule_start_time = "2020-01-01 00:00:00";
    const current = await readSettingsObject("tenant", "111", "101", "ad_group", "201");
    expect(current.editable_fields).not.toContain("schedule_start_time");
    expect(current.editable_fields).toContain("schedule_end_time");
    expect((await proposal("ad_group", { schedule_end_time: "2027-05-10T08:00:00.000Z" })).changes).toMatchObject({ schedule_end_time: "2027-05-10T08:00:00.000Z" });
    await expect(proposal("ad_group", { schedule_start_time: "2027-05-02T08:00:00.000Z" })).rejects.toMatchObject({ code: "tiktok_ads_schedule_invalid" });
  });
  it("reads and edits UTC schedules even when account timezone is unavailable", async () => {
    m.timezone = "";
    const current = await readSettingsObject("tenant", "111", "101", "ad_group", "201");
    expect(current.settings.schedule_start_time).toBe("2027-05-01T08:00:00.000Z");
    expect((await proposal("ad_group", { schedule_end_time: "2027-05-10T08:00:00.000Z" })).changes).toMatchObject({ schedule_end_time: "2027-05-10T08:00:00.000Z" });
  });
  it("rejects documented schedule limits and fractional seconds before proposal", async () => {
    await expect(proposal("ad_group", { schedule_start_time: "2028-01-01T00:00:01.000Z", schedule_end_time: "2028-01-02T00:00:00.000Z" })).rejects.toMatchObject({ code: "tiktok_ads_schedule_invalid" });
    await expect(proposal("ad_group", { schedule_end_time: "2038-01-01T00:00:01.000Z" })).rejects.toMatchObject({ code: "tiktok_ads_schedule_invalid" });
    await expect(proposal("ad_group", { schedule_end_time: "2027-05-10T08:00:00.100Z" })).rejects.toMatchObject({ code: "tiktok_ads_schedule_invalid" });
    expect(m.posts).toEqual([]);
    expect(reserveAdSpend).not.toHaveBeenCalled();
  });
  it("returns the campaign hierarchy, UTC schedule and revisions without private provider fields", async () => {
    m.rows.ad[0].unrelated_provider_secret = "never exposed";
    const detail = await readCampaignSettings("tenant", "111", "101");
    expect(detail.advertiser).toEqual({ id: "111", name: "Main", currency: "USD", timezone: "America/Los_Angeles" });
    expect(detail.ad_groups[0].settings.schedule_start_time).toBe("2027-05-01T08:00:00.000Z");
    expect(detail.ads[0]).toMatchObject({ campaign_id: "101", ad_group_id: "201", revision: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(JSON.stringify(detail)).not.toContain("never exposed");
  });
  it("refuses foreign advertiser and campaign lineage", async () => {
    m.knownAccount = false;
    await expect(readCampaignSettings("tenant", "111", "101")).rejects.toMatchObject({ code: "tiktok_ads_unknown_account" });
    m.knownAccount = true;
    await expect(readSettingsObject("tenant", "111", "999", "ad", "301")).rejects.toMatchObject({ code: "tiktok_ads_object_not_found" });
    m.rows.ad[0].advertiser_id = "222";
    await expect(readSettingsObject("tenant", "111", "101", "ad", "301")).rejects.toMatchObject({ code: "tiktok_ads_bad_response" });
  });
  it("binds the opened revision including changes to status, creative and account timezone", async () => {
    const current = await readSettingsObject("tenant", "111", "101", "ad", "301");
    m.rows.ad[0].ad_text = "Someone changed it";
    await expect(proposeSettingsBody("tenant", { advertiser_id: "111", campaign_id: "101", object_id: "301", level: "ad", revision: current.revision, changes: { ad_text: "After" } })).rejects.toMatchObject({ code: "tiktok_ads_settings_drifted" });
  });
  it("uses strict per-level fields and refuses spend, objective and identity injection", () => {
    for (const changes of [{ budget: 100 }, { status: "ACTIVE" }, { objective_type: "CONVERSIONS" }, { identity_id: "other" }, { ad_text: "wrong level" }]) expect(settingsChangeInput.safeParse({ advertiser_id: "111", campaign_id: "101", object_id: "101", level: "campaign", revision: "a".repeat(64), changes }).success).toBe(false);
  });
  it("retains Zavi's prefix and launch tag when renaming", async () => {
    expect((await proposal("campaign", { campaign_name: "Better" })).changes).toEqual({ campaign_name: "Zavi · Better · campaign · zv1234567890" });
  });
  it("keeps launch attribution on a new destination through proposal and execution", async () => {
    m.rows.ad[0].ad_name = "Zavi · Test · ad · zv1234567890";
    m.rows.ad[0].landing_page_url = "https://example.com/?utm_campaign=zv1234567890";
    const body = await proposal("ad", { landing_page_url: "https://example.org/new?offer=spring#details" });
    const expected = "https://example.org/new?offer=spring&utm_source=tiktok&utm_medium=paid_social&utm_campaign=zv1234567890#details";
    expect(body.changes).toMatchObject({ landing_page_url: expected });
    expect(await execution(body)).toMatchObject({ ok: true });
    expect(m.rows.ad[0].landing_page_url).toBe(expected);
  });
  it("respects supplied attribution parameters and does not tag unrelated ads", async () => {
    m.rows.ad[0].ad_name = "Zavi · Test · ad · zv1234567890";
    const supplied = "https://example.org/?utm_source=partner&utm_medium=email&utm_campaign=custom&offer=one#details";
    const body = await proposal("ad", { landing_page_url: supplied });
    expect(body.changes).toMatchObject({ landing_page_url: "https://example.org/?utm_source=partner&utm_medium=email&utm_campaign=custom&offer=one&zavi_launch=zv1234567890#details" });
    expect(await execution(body)).toMatchObject({ ok: true });
    m.rows.ad[0].ad_name = "Customer's own ad";
    expect((await proposal("ad", { landing_page_url: "https://example.net/new" })).changes).toEqual({ landing_page_url: "https://example.net/new" });
  });
  it("preserves an explicitly supplied launch attribution parameter", async () => {
    m.rows.ad[0].ad_name = "Zavi · Test · ad · zv1234567890";
    const destination = "https://example.org/?utm_campaign=custom&zavi_launch=customer-choice";
    const body = await proposal("ad", { landing_page_url: destination });
    expect(body.changes).toMatchObject({ landing_page_url: `${destination}&utm_source=tiktok&utm_medium=paid_social` });
    expect(await execution(body)).toMatchObject({ ok: true });
  });
  it("does not offer or accept name edits for explicitly automated creatives", async () => {
    m.rows.ad[0].is_aco = true;
    const current = await readSettingsObject("tenant", "111", "101", "ad", "301");
    expect(current.editable_fields).toEqual([]);
    await expect(proposal("ad", { ad_name: "Other name" })).rejects.toMatchObject({ code: "tiktok_ads_creative_unsupported" });
    expect(m.posts).toEqual([]);
  });
  it("normalizes broad adult ages and validates locations, languages, destination and video", async () => {
    const group = await proposal("ad_group", { age_groups: [], location_ids: ["840", "840", "124"] });
    expect(group.changes).toMatchObject({ age_groups: ["AGE_18_24", "AGE_25_34", "AGE_35_44", "AGE_45_54", "AGE_55_100"], location_ids: ["124", "840"] });
    expect(verifyTiktokLocations).toHaveBeenCalled();
    await proposal("ad", { landing_page_url: "https://example.org", video_id: "video2" });
    expect(assertLandingUrl).toHaveBeenCalledWith("https://example.org");
    expect(readLaunchVideo).toHaveBeenCalledWith(expect.anything(), "111", "video2");
    await expect(proposal("ad", { video_id: "missing" })).rejects.toMatchObject({ code: "tiktok_ads_video_unreadable" });
  });
  it("allows nonspend settings for verified non-USD accounts but refuses exposure extensions", async () => {
    m.currency = "EUR";
    const shortened = await proposal("ad_group", { schedule_end_time: "2027-05-10T15:00:00.000Z" });
    expect(shortened.daily_budget_usd).toBeNull();
    expect(await execution(await proposal("ad", { ad_text: "After" }))).toMatchObject({ ok: true });
    await expect(proposal("ad_group", { schedule_end_time: "2027-05-20T15:00:00.000Z" })).rejects.toMatchObject({ code: "tiktok_ads_currency_unsupported" });
  });
  it("fingerprints preserved nested creative fields without exposing them to the UI", async () => {
    m.rows.ad[0].utm_params = [{ key: "campaign", value: "original" }];
    const current = await readSettingsObject("tenant", "111", "101", "ad", "301");
    expect(JSON.stringify(current)).not.toContain("original");
    m.rows.ad[0].utm_params = [{ key: "campaign", value: "changed" }];
    await expect(proposeSettingsBody("tenant", { advertiser_id: "111", campaign_id: "101", object_id: "301", level: "ad", revision: current.revision, changes: { landing_page_url: "https://example.org" } })).rejects.toMatchObject({ code: "tiktok_ads_settings_drifted" });
  });
  it("does not treat Spark or automated ads as editable regular video creatives", async () => {
    m.rows.ad[0].tiktok_item_id = "source-post";
    await expect(proposal("ad", { ad_text: "After" })).rejects.toMatchObject({ code: "tiktok_ads_creative_unsupported" });
    expect((await proposal("ad", { ad_name: "Other name" })).changes).toEqual({ ad_name: "Other name" });
  });
  it("does not overwrite automatic CTA portfolios or incompletely read creatives", async () => {
    m.rows.ad[0].call_to_action_id = "portfolio";
    await expect(proposal("ad", { call_to_action: "SHOP_NOW" })).rejects.toMatchObject({ code: "tiktok_ads_creative_unsupported" });
    delete m.rows.ad[0].call_to_action_id;
    delete m.rows.ad[0].image_ids;
    const current = await readSettingsObject("tenant", "111", "101", "ad", "301");
    expect(current.editable_fields).not.toContain("landing_page_url");
    await expect(proposal("ad", { landing_page_url: "https://example.org" })).rejects.toMatchObject({ code: "tiktok_ads_creative_unreadable" });
    expect((await proposal("ad", { ad_text: "After" })).changes).toEqual({ ad_text: "After" });
  });
  it("reads UTC on repeated or missing local DST hours and rejects invalid dates", () => {
    expect(tiktokScheduleInstant("2026-11-01 01:30:00", "America/Los_Angeles")).toBe("2026-11-01T01:30:00.000Z");
    expect(tiktokScheduleInstant("2026-03-08 02:30:00", "America/Los_Angeles")).toBe("2026-03-08T02:30:00.000Z");
    expect(tiktokScheduleInstant("2026-11-01 03:30:00", "Asia/Kolkata")).toBe("2026-11-01T03:30:00.000Z");
    expect(tiktokScheduleInstant("2026-02-30 00:00:00")).toBeNull();
  });
});

describe("TikTok settings execution", () => {
  it("does not replay a non-Spark disclosure default in a linked-identity full update", async () => {
    m.rows.ad[0].aigc_disclosure_type = "NOT_DECLARED";
    const body = await proposal("ad", { landing_page_url: "https://example.org/after" });
    expect((await execution(body)).ok).toBe(true);
    expect(m.posts[0].body).toMatchObject({ patch_update: false });
    expect((m.posts[0].body.creatives as Array<Record<string, unknown>>)[0]).not.toHaveProperty("aigc_disclosure_type");
    m.rows.ad[0].landing_page_url = "https://example.com";
    const again = await proposal("ad", { landing_page_url: "https://example.org/after" });
    m.rows.ad[0].aigc_disclosure_type = "SELF_DISCLOSURE";
    expect(await execution(again)).toMatchObject({ ok: false, code: "tiktok_ads_settings_drifted" });
  });

  it("confirms a patch when TikTok reorders both changed and preserved membership arrays", async () => {
    m.rows.adgroup[0].audience_ids = ["audience-b", "audience-a"];
    m.rows.adgroup[0].interest_category_ids = ["interest-b", "interest-a"];
    const body = await proposal("ad_group", { location_ids: ["840", "124"], age_groups: ["AGE_18_24", "AGE_25_34"], languages: ["en", "fr"] });
    m.postMode = "reorder_group";
    expect(await execution(body)).toMatchObject({ ok: true });
    expect(m.posts).toHaveLength(1);
  });
  it("checks advanced group drift again at approval execution", async () => {
    const body = await proposal("ad_group", { adgroup_name: "Renamed" });
    m.rows.adgroup[0].bid_price = 3;
    expect(await execution(body)).toMatchObject({ ok: false, code: "tiktok_ads_settings_drifted" });
    expect(m.posts).toEqual([]);
  });
  it("preserves writable group configuration and detects a provider reset of nested settings", async () => {
    m.rows.adgroup[0].targeting_expansion = { expansion_enabled: false, expansion_types: ["INTEREST_AND_BEHAVIOR"] };
    m.rows.adgroup[0].bid_price = 2;
    const body = await proposal("ad_group", { gender: "GENDER_FEMALE" });
    m.postMode = "reset_group";
    expect(await execution(body)).toMatchObject({ ok: false, code: "exec_outcome_unknown", outcome_unknown: true });
    expect(m.posts[0]).toMatchObject({ endpoint: "/adgroup/update/", body: { advertiser_id: "111", adgroup_id: "201", gender: "GENDER_FEMALE", pacing: "PACING_MODE_SMOOTH" } });
  });
  it("keeps languages, audience selections and delivery windows when the provider replaces omitted fields", async () => {
    Object.assign(m.rows.adgroup[0], { languages: ["en"], audience_ids: ["501"], interest_category_ids: ["601"], dayparting: "1".repeat(48) + "0".repeat(288), provider_read_only: "never send" });
    const body = await proposal("ad_group", { adgroup_name: "Renamed" });
    m.postMode = "full_replace";
    expect(await execution(body)).toMatchObject({ ok: true });
    expect(m.posts[0].body).toMatchObject({ adgroup_name: "Renamed", languages: ["en"], audience_ids: ["501"], interest_category_ids: ["601"], dayparting: "1".repeat(48) + "0".repeat(288), pacing: "PACING_MODE_SMOOTH", schedule_type: "SCHEDULE_START_END", schedule_start_time: "2027-05-01 08:00:00", schedule_end_time: "2027-05-15 08:00:00" });
    expect(m.posts[0].body).not.toHaveProperty("provider_read_only");
    expect(m.posts[0].body).not.toHaveProperty("campaign_id");
    expect(m.posts[0].body).not.toHaveProperty("budget_mode");
  });
  it.each([null, "", "0".repeat(336), "1".repeat(336)])("accepts equivalent unrestricted dayparting on provider readback (%s)", async dayparting => {
    Object.assign(m.rows.adgroup[0], { audience_ids: [], interest_category_ids: [] });
    m.rows.adgroup[0].dayparting = dayparting;
    const body = await proposal("ad_group", { adgroup_name: "Renamed" });
    m.postMode = "full_replace";
    expect(await execution(body)).toMatchObject({ ok: true });
    expect(m.posts[0].body.dayparting).toBe("1".repeat(336));
  });
  it("allows an ordinary Traffic group with the documented default brand-safety setting", async () => {
    m.rows.adgroup[0].brand_safety_type = "NO_BRAND_SAFETY";
    const body = await proposal("ad_group", { adgroup_name: "Renamed" });
    expect(await execution(body)).toMatchObject({ ok: true });
    expect(m.posts[0].body).not.toHaveProperty("brand_safety_type");
  });
  it("replaces one standard creative while preserving existing SDK fields, with a fresh video cover", async () => {
    m.rows.ad[0].utm_params = [{ key: "campaign", value: "original" }];
    m.rows.ad[0].creative_authorized = false;
    m.rows.ad[0].provider_read_only = "do not send";
    const body = await proposal("ad", { ad_text: "After", video_id: "video2", call_to_action: "SHOP_NOW" });
    expect(await execution(body)).toMatchObject({ ok: true });
    expect(m.posts).toEqual([{ endpoint: "/ad/update/", body: { advertiser_id: "111", adgroup_id: "201", patch_update: false, creatives: [{ ad_id: "301", ad_name: "Video", ad_format: "SINGLE_VIDEO", identity_id: "identity", identity_type: "TT_USER", ad_text: "After", landing_page_url: "https://example.com", call_to_action: "SHOP_NOW", video_id: "video2", image_ids: ["new-cover"], utm_params: [{ key: "campaign", value: "original" }], creative_authorized: false }] } }]);
    expect(uploadLaunchImage).toHaveBeenCalledWith(expect.anything(), "111", "https://tiktok.example/cover.jpg", "edit-action-cover");
    expect(m.rows.ad[0].identity_id).toBe("identity");
    expect(reserveAdSpend).not.toHaveBeenCalled();
  });
  it("uses a narrow patch for text and refuses a readback that reset preserved nested fields", async () => {
    m.rows.ad[0].utm_params = [{ key: "campaign", value: "original" }];
    const body = await proposal("ad", { ad_text: "After" }); m.postMode = "reset_utm";
    expect(await execution(body)).toMatchObject({ ok: false, code: "exec_outcome_unknown" });
    expect(m.posts[0].body).toEqual({ advertiser_id: "111", adgroup_id: "201", patch_update: true, creatives: [{ ad_id: "301", ad_text: "After" }] });
  });
  it.each(["member", "staff"])("refuses %s approval", async role => {
    const body = await proposal("campaign", { campaign_name: "Better" }); m.role = role;
    expect(await execution(body)).toMatchObject({ ok: false, code: "tiktok_ads_admin_required" }); expect(m.posts).toEqual([]);
  });
  it("refuses Autopilot and locks without writing", async () => {
    const body = await proposal("campaign", { campaign_name: "Better" });
    expect(await execution(body, { approved_by_source: "cgo" })).toMatchObject({ ok: false, code: "tiktok_ads_approval_required" });
    m.locked = true;
    expect(await execution(body)).toMatchObject({ ok: false }); expect(m.posts).toEqual([]);
  });
  it("refuses drift at execution, including a second execution of the same approved edit", async () => {
    const body = await proposal("campaign", { campaign_name: "Better" });
    expect(await execution(body)).toMatchObject({ ok: true });
    expect(await execution(body)).toMatchObject({ ok: false, code: "tiktok_ads_settings_drifted" }); expect(m.posts).toHaveLength(1);
  });
  it("holds before extending a schedule, writes provider wall time, and confirms it", async () => {
    const body = await proposal("ad_group", { schedule_end_time: "2027-05-20T15:00:00.000Z" });
    const current = await readSettingsObject("tenant", "111", "101", "ad_group", "201");
    expect(settingsUpdateRequest(body, "America/Los_Angeles", undefined, current).body.schedule_end_time).toBe("2027-05-20 15:00:00");
    expect(await execution(body)).toMatchObject({ ok: true });
    expect(reserveAdSpend).toHaveBeenCalledWith(expect.anything(), { platform: "tiktok", op: "raise", object_id: "201", daily_delta_usd: 30, currency: "USD" });
    expect(commitAdSpend).toHaveBeenCalledWith(m.hold, "201");
  });
  it("refuses an extension past an active test limit but permits shortening", async () => {
    m.stops = [{ account_id: "111", state: "monitoring" }];
    await expect(proposal("ad_group", { schedule_end_time: "2027-05-20T15:00:00.000Z" })).rejects.toMatchObject({ code: "tiktok_ads_test_schedule_bound" });
    expect(await execution(await proposal("ad_group", { schedule_end_time: "2027-05-10T15:00:00.000Z" }))).toMatchObject({ ok: true });
    expect(reserveAdSpend).not.toHaveBeenCalled();
  });
  it("rechecks drift after the spend hold and releases it before sending", async () => {
    const body = await proposal("ad_group", { schedule_end_time: "2027-05-20T15:00:00.000Z" });
    m.onReserve = () => { m.rows.adgroup[0].budget = 50; };
    expect(await execution(body)).toMatchObject({ ok: false, code: "tiktok_ads_settings_drifted" });
    expect(m.posts).toEqual([]); expect(dropAdSpendHold).toHaveBeenCalledWith(m.hold);
  });
  it.each(["transport", "read_fail", "ignore"])("keeps the hold and reports uncertain outcome on %s", async mode => {
    const body = await proposal("ad_group", { schedule_end_time: "2027-05-20T15:00:00.000Z" }); m.postMode = mode;
    const result = await execution(body);
    expect(result).toMatchObject({ ok: false, code: "exec_outcome_unknown", outcome_unknown: true });
    expect(verdictFor(result, "tiktok_ads.update_settings")).toMatchObject({ bucket: "partial_risk" });
    expect(dropAdSpendHold).not.toHaveBeenCalled(); expect(m.posts).toHaveLength(1);
  });
  it("keeps the hold when the readback itself is refused after the write was sent", async () => {
    const body = await proposal("ad_group", { schedule_end_time: "2027-05-20T15:00:00.000Z" }); m.postMode = "read_revoked";
    const result = await execution(body);
    expect(result).toMatchObject({ ok: false, code: "exec_outcome_unknown", outcome_unknown: true });
    expect(dropAdSpendHold).not.toHaveBeenCalled(); expect(commitAdSpend).not.toHaveBeenCalled(); expect(m.posts).toHaveLength(1);
  });
  it("releases a hold when TikTok definitely refuses", async () => {
    const body = await proposal("ad_group", { schedule_end_time: "2027-05-20T15:00:00.000Z" }); m.postMode = "refuse";
    expect(await execution(body)).toMatchObject({ ok: false, code: "tiktok_ads_write_refused" }); expect(dropAdSpendHold).toHaveBeenCalledWith(m.hold);
  });
  it("keeps settings approval owner/admin-only", () => { expect(tiktokActionRaisesSpend("tiktok_ads.update_settings", {})).toBe(true); });
  it("reports uncertainty if TikTok resets an unchanged creative identity", async () => {
    const body = await proposal("ad", { ad_text: "After" }); m.postMode = "reset_identity";
    expect(await execution(body)).toMatchObject({ ok: false, code: "exec_outcome_unknown" });
  });
  it("recovers a schedule hold from fresh exact settings, keeping ambiguous or foreign targets", async () => {
    const body = await proposal("ad_group", { schedule_end_time: "2027-05-20T15:00:00.000Z" });
    expect(await resolveSettingsHold("tenant", "201", body)).toBe("not_landed");
    expect(await resolveSettingsHold("tenant", "999", body)).toBeNull();
    m.rows.adgroup[0].schedule_end_time = "2027-05-21 08:00:00";
    expect(await resolveSettingsHold("tenant", "201", body)).toBeNull();
    m.rows.adgroup[0].schedule_end_time = "2027-05-20 15:00:00";
    expect(await resolveSettingsHold("tenant", "201", body)).toBe("landed");
    m.rows.adgroup[0].budget = 50;
    expect(await resolveSettingsHold("tenant", "201", body)).toBeNull();
  });
});

describe("reviewed location names", () => {
  it("shows provider-resolved Before/After names while executing the exact reviewed IDs", async () => {
    const body = await proposal("ad_group", {location_ids: ["124"]});
    const {describeTiktokAction} = await import("@/services/tools/tiktok-ads/_exec-action");
    expect(describeTiktokAction("tiktok_ads.update_settings", body).rows).toContainEqual({item: "Locations", before: "United States", after: "Canada"});
    expect(await execution(body)).toMatchObject({ok: true});
    expect(m.posts[0].body.location_ids).toEqual(["124"]);
    expect(m.posts[0].body).not.toHaveProperty("location_names");
  });
  it("can replace an old location that is no longer targetable", async () => {
    m.rows.adgroup[0].location_ids = ["999"];
    const body = await proposal("ad_group", {location_ids: ["124"]});
    const {describeTiktokAction} = await import("@/services/tools/tiktok-ads/_exec-action");
    expect(describeTiktokAction("tiktok_ads.update_settings", body).rows).toContainEqual({item: "Locations", before: "Retired market", after: "Canada"});
    expect(verifyTiktokLocations).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), ["999"]);
  });
});
