import { createHash } from "node:crypto";
import type { OwnedComposioAccount } from "@/services/connectors/composio/api";
import { ExpectedToolError } from "@/services/tools/types";
import { ensureAdAccounts } from "./ad-accounts";
import { tiktokAdsAccount, tt, verifyAdvertisers } from "./composio-read";
import { isDailyMode, tiktokPost } from "./objects";
import { assertLandingUrl, readLaunchVideo, uploadLaunchImage } from "./launch-readiness";
import { isUsableTimeZone, scheduleWireTime, videoRefusal, withLaunchUtm } from "./launch-schema";
import { verifyTiktokLocations, readTiktokLocationNames, type TiktokPlace } from "./locations";
import { normalizeTiktokAudience, verifyTiktokLanguages } from "./targeting";
import { settingsChangeInput, tiktokSettingsBody, TIKTOK_UPDATE_SETTINGS_CLASS, type SettingsChangeInput, type SettingsLevel, type SettingsValue, type TiktokSettingsBody } from "./campaign-settings-schema";
import type { TiktokExecRow, TiktokExecResult } from "./execute";
import { advancedGroupKeys, advancedGroupValues, verifyAdvancedGroup } from "./campaign-advanced";
import { isKnownGeneratedVideo } from "./video-provenance";
import { fullGroupUpdate, projectGroupReadValue } from "./group-update";

export { settingsChangeInput, tiktokSettingsBody, TIKTOK_UPDATE_SETTINGS_CLASS } from "./campaign-settings-schema";
type Advertiser = { id: string; name: string; currency: string | null; timezone: string | null };
type Connection = { account: OwnedComposioAccount; advertiser: Advertiser };
export type SettingsObject = {
  id: string; level: SettingsLevel; campaign_id: string; ad_group_id: string | null;
  name: string; status: string; secondary_status: string | null;
  budget: number | null; budget_mode: string | null; revision: string;
  settings: Record<string, SettingsValue>; limitations: string[]; editable_fields: string[];
};
const paths = { campaign: "campaign", ad_group: "adgroup", ad: "ad" } as const;
const ids = { campaign: "campaign_id", ad_group: "adgroup_id", ad: "ad_id" } as const;
const names = { campaign: "campaign_name", ad_group: "adgroup_name", ad: "ad_name" } as const;
const settingKeys: Record<SettingsLevel, string[]> = {
  campaign: ["campaign_name", "objective_type", "budget_optimize_on", "special_industries", "campaign_automation_type", "is_smart_performance_campaign", "app_promotion_type", "campaign_type", "is_search_campaign", "campaign_product_source"],
  ad_group: ["adgroup_name", "location_ids", "age_groups", "gender", "languages", "schedule_start_time", "schedule_end_time", "schedule_type", "placements", "placement_type", "optimization_goal", "billing_event", "promotion_type", "auto_targeting_enabled", "creative_material_mode", "campaign_automation_type", "shopping_ads_type", ...advancedGroupKeys],
  ad: ["ad_name", "ad_text", "landing_page_url", "call_to_action", "video_id", "image_ids", "ad_format", "identity_type", "identity_id", "identity_authorized_bc_id", "tiktok_item_id", "is_aco", "ad_texts", "dynamic_format", "dynamic_destination", "vertical_video_strategy", "aigc_disclosure_type"],
};
const groupConfigurationKeys = [
  "actions", "adgroup_name", "age_groups", "audience_ids", "audience_rule", "audience_type", "auto_targeting_enabled", "automated_keywords_enabled", "bid_price", "bid_type", "blocked_pangle_app_ids", "brand_safety_type", "budget", "carrier_ids", "catalog_authorized_bc_id", "category_exclusion_ids", "comment_disabled", "contextual_tag_ids", "conversion_bid_price", "dayparting", "deep_bid_type", "deep_cpa_bid", "deep_funnel_event_source", "deep_funnel_event_source_id", "deep_funnel_optimization_event", "deep_funnel_optimization_status", "device_model_ids", "device_price_ranges", "exclude_age_under_eighteen", "excluded_audience_ids", "excluded_custom_actions", "excluded_pangle_audience_package_ids", "frequency", "frequency_schedule", "gender", "household_income", "included_custom_actions", "included_pangle_audience_package_ids", "interest_category_ids", "interest_keyword_ids", "ios14_targeting", "is_hfss", "is_lhf_compliance", "isp_ids", "languages", "location_ids", "min_android_version", "min_ios_version", "network_types", "next_day_retention", "operating_systems", "pacing", "purchase_intention_keyword_ids", "roas_bid", "saved_audience_id", "schedule_end_time", "schedule_start_time", "schedule_type", "search_keywords", "search_result_enabled", "secondary_optimization_event", "share_disabled", "shopping_ads_retargeting_actions_days", "shopping_ads_retargeting_custom_audience_relation", "shopping_ads_retargeting_type", "smart_audience_enabled", "smart_interest_behavior_enabled", "spending_power", "targeting_expansion", "vertical_sensitivity_id", "zipcode_ids",
  "budget_mode", "scheduled_budget", "placement_type", "placements", "optimization_goal", "optimization_event", "billing_event", "promotion_type", "promotion_target_type", "creative_material_mode", "app_id", "pixel_id", "attribution_event_count", "click_attribution_window", "view_attribution_window", "engaged_view_attribution_window", "video_download_disabled", "campaign_automation_type", "is_smart_performance_campaign", "buying_type", "product_source", "shopping_ads_type", "custom_conversion_id",
] as const;
const groupSnapshots = new WeakMap<SettingsObject, Record<string, unknown>>();
const parentRevisions = new WeakMap<SettingsObject, string>();
const parentContexts = new WeakMap<SettingsObject, Record<string, unknown>>();
const groupTimezone = new WeakMap<SettingsObject, string | null>();
function attachCampaignContext(group: SettingsObject, campaign: SettingsObject): SettingsObject {
  parentRevisions.set(group, campaign.revision);
  group.revision = createHash("sha256").update(JSON.stringify({ group: group.revision, parent: campaign.revision })).digest("hex");
  const s = group.settings, c = campaign.settings;
  parentContexts.set(group, c);
  try { fullGroupUpdate(groupSnapshots.get(group) ?? {}, {}, c); }
  catch (error) {
    group.editable_fields = [];
    group.limitations.push(error instanceof Error ? error.message : "This ad group's full update cannot be preserved safely.");
    return group;
  }
  const manualTraffic = c.objective_type === "TRAFFIC" && !c.is_smart_performance_campaign && (!c.campaign_automation_type || c.campaign_automation_type === "MANUAL")
    && (!Array.isArray(c.special_industries) || !c.special_industries.length) && s.auto_targeting_enabled !== true
    && (!s.campaign_automation_type || s.campaign_automation_type === "MANUAL") && (!s.creative_material_mode || s.creative_material_mode === "CUSTOM")
    && s.promotion_type === "WEBSITE" && Array.isArray(s.placements) && s.placements.length === 1 && s.placements[0] === "PLACEMENT_TIKTOK";
  if (manualTraffic) {
    group.editable_fields.push(...advancedGroupKeys.filter(k => !["bid_type", "bid_price"].includes(k) && (k !== "dayparting" || isUsableTimeZone(groupTimezone.get(group)))));
    if (s.billing_event === "CPC" && s.optimization_goal === "CLICK" && c.budget_optimize_on !== true && campaign.budget_mode === "BUDGET_MODE_INFINITE") group.editable_fields.push("bid_type", "bid_price");
  }
  group.editable_fields = [...new Set(group.editable_fields)];
  return group;
}
const groupMembershipKeys = new Set<string>(["age_groups", "audience_ids", "blocked_pangle_app_ids", "carrier_ids", "category_exclusion_ids", "contextual_tag_ids", "device_model_ids", "excluded_audience_ids", "excluded_pangle_audience_package_ids", "household_income", "included_pangle_audience_package_ids", "interest_category_ids", "interest_keyword_ids", "isp_ids", "languages", "location_ids", "network_types", "operating_systems", "purchase_intention_keyword_ids", "placements", "zipcode_ids"]);
function groupConfigurationValue(key: string, value: unknown): unknown {
  if (key === "dayparting" && (value == null || value === "" || value === "0".repeat(336))) return "1".repeat(336);
  return groupMembershipKeys.has(key) && Array.isArray(value) && value.every(v => typeof v === "string") ? set(value) : canonical(projectGroupReadValue(key, value));
}
const creativeWriteKeys = ["ad_format", "ad_id", "ad_name", "ad_text", "ad_texts", "aigc_disclosure_type", "app_name", "avatar_icon_web_uri", "brand_safety_postbid_partner", "brand_safety_vast_url", "call_to_action", "call_to_action_id", "card_id", "carousel_image_index", "click_tracking_url", "cpp_url", "creative_authorized", "creative_type", "dark_post_status", "deeplink", "deeplink_type", "deeplink_utm_params", "disclaimer_clickable_texts", "disclaimer_text", "disclaimer_type", "display_name", "dynamic_destination", "dynamic_format", "end_card_cta", "fallback_type", "identity_authorized_bc_id", "identity_id", "identity_type", "image_ids", "impression_tracking_url", "instant_product_page_used", "item_duet_status", "item_group_ids", "item_stitch_status", "landing_page_url", "music_id", "page_id", "page_image_index", "playable_url", "product_set_id", "product_specific_type", "promotional_music_disabled", "shopping_ads_deeplink_type", "shopping_ads_fallback_type", "shopping_ads_video_package_id", "sku_ids", "tiktok_item_id", "tracking_app_id", "tracking_offline_event_set_ids", "tracking_pixel_id", "utm_params", "vast_moat_enabled", "vertical_video_strategy", "video_id", "video_view_tracking_url", "viewability_postbid_partner", "viewability_vast_url"] as const;
const creativeSnapshots = new WeakMap<SettingsObject, Record<string, unknown>>();
const disclosureEligible = new WeakMap<SettingsObject, boolean>();
function fullCreativeReadable(creative: Record<string, unknown> | undefined | null): boolean {
  return typeof creative?.ad_name === "string" && typeof creative.ad_text === "string" && !!creative.identity_id && !!creative.identity_type && !!creative.ad_format && !!creative.video_id && Array.isArray(creative.image_ids) && creative.image_ids.length > 0;
}
function attachAdContext(ad: SettingsObject, campaign: SettingsObject, group: SettingsObject | undefined): SettingsObject {
  if (ad.settings.identity_type !== "CUSTOMIZED_USER" || !regularVideo(ad.settings)) return ad;
  if (!group) {
    ad.editable_fields = ad.editable_fields.filter(key => key !== "video_id");
    ad.limitations.push("The ad group's disclosure eligibility could not be checked. Refresh before replacing its video.");
    return ad;
  }
  const context = `${campaign.revision}:${group.revision}`;
  parentRevisions.set(ad, context);
  ad.revision = createHash("sha256").update(JSON.stringify({ ad: ad.revision, parent: context })).digest("hex");
  const supportedObjective = ["REACH", "TRAFFIC", "VIDEO_VIEWS", "APP_PROMOTION", "WEB_CONVERSIONS", "RF_REACH", "LEAD_GENERATION"].includes(String(campaign.settings.objective_type))
    || (campaign.settings.objective_type === "PRODUCT_SALES" && campaign.settings.campaign_product_source === "CATALOG" && group.settings.shopping_ads_type === "VIDEO");
  const eligible = supportedObjective
    && (group.settings.placement_type === "PLACEMENT_TYPE_AUTOMATIC" || (Array.isArray(group.settings.placements) && group.settings.placements.includes("PLACEMENT_TIKTOK")));
  disclosureEligible.set(ad, eligible);
  if (eligible && fullCreativeReadable(creativeSnapshots.get(ad))) ad.editable_fields.push("aigc_disclosure_type");
  else if (eligible) ad.editable_fields = ad.editable_fields.filter(key => key !== "video_id");
  return ad;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}
function fail(code: string, message: string): never { throw new ExpectedToolError(`tiktok_ads_${code}`, message); }
const str = (v: unknown): string | null => typeof v === "string" && v.length ? v : null;
const numeric = (v: unknown): number | null => v !== null && v !== "" && v !== undefined && Number.isFinite(Number(v)) ? Number(v) : null;
const set = (xs: string[]) => [...new Set(xs)].sort();
const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

export function tiktokScheduleInstant(value: string, _zone?: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return null;
  const ms = Date.parse(value.replace(" ", "T") + "Z");
  if (!Number.isFinite(ms)) return null;
  const iso = new Date(ms).toISOString();
  return iso.slice(0, 19).replace("T", " ") === value ? iso : null;
}

async function connect(tenantId: string, advertiserId: string): Promise<Connection> {
  if (!/^\d{1,32}$/.test(advertiserId)) fail("unknown_account", "Choose a valid TikTok ad account.");
  const state = await ensureAdAccounts(tenantId);
  if (!state.connected || !state.accounts.some(a => a.advertiser_id === advertiserId)) fail("unknown_account", "This TikTok ad account is not connected to this workspace.");
  const account = await tiktokAdsAccount(tenantId);
  const live = (await verifyAdvertisers(account, [advertiserId])).find(a => a.advertiser_id === advertiserId);
  if (!live) fail("unknown_account", "TikTok no longer allows this workspace to read this ad account.");
  return { account, advertiser: { id: live.advertiser_id, name: live.name, currency: live.currency, timezone: live.timezone } };
}

function objectOf(raw: Record<string, unknown>, level: SettingsLevel, conn: Connection): SettingsObject {
  if (raw.advertiser_id != null && raw.advertiser_id !== conn.advertiser.id) fail("bad_response", "TikTok returned an object from another ad account.");
  const id = str(raw[ids[level]]);
  const campaignId = str(raw.campaign_id) ?? (level === "campaign" ? id : null);
  const groupId = level === "ad_group" ? id : level === "ad" ? str(raw.adgroup_id) : null;
  if (!id || !campaignId || (level === "ad" && !groupId)) fail("bad_response", "TikTok returned an object without its campaign or ad group.");
  const settings: Record<string, SettingsValue> = {};
  const fingerprint: Record<string, unknown> = {};
  const limitations: string[] = [];
  for (const key of settingKeys[level]) {
    const value = raw[key];
    let normalized = Array.isArray(value) && value.every(x => typeof x === "string") ? set(value) : typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : null;
    if (key === "bid_price" && raw.bid_type === "BID_TYPE_NO_BID") normalized = null;
    if (key === "dayparting" && (normalized == null || normalized === "" || normalized === "0".repeat(336))) normalized = "1".repeat(336);
    fingerprint[key] = normalized;
    if ((key === "schedule_start_time" || key === "schedule_end_time") && typeof value === "string" && value) {
      settings[key] = tiktokScheduleInstant(value);
      if (!settings[key]) limitations.push("TikTok's schedule has an ambiguous or unreadable time. Edit its schedule in TikTok Ads Manager.");
    } else settings[key] = normalized;
  }
  const status = raw.operation_status === "ENABLE" ? "ACTIVE" : raw.operation_status === "DISABLE" ? "PAUSED" : str(raw.operation_status) ?? "UNKNOWN";
  if (level === "ad" && settings.is_aco === true) limitations.push("Edit this automated creative in TikTok Ads Manager. Its settings cannot be changed in this editor.");
  else if (level === "ad" && !regularVideo(settings)) limitations.push("Only the name can be edited for this ad format or source post. Edit the original post or automated creative in TikTok Ads Manager.");
  const creative = level === "ad" ? Object.fromEntries(creativeWriteKeys.filter(key => raw[key] !== undefined).map(key => [key, canonical(raw[key])])) : null;
  const groupConfiguration = level === "ad_group" ? Object.fromEntries(groupConfigurationKeys.map(key => [key, groupConfigurationValue(key, key in fingerprint ? fingerprint[key] : raw[key] ?? null)])) : null;
  const stable = { advertiser: conn.advertiser, account: conn.account.connected_account_id, id, campaignId, groupId, level, status, budget: numeric(raw.budget), budget_mode: str(raw.budget_mode), settings: fingerprint, creative, groupConfiguration };
  const editable_fields: string[] = level === "ad" && settings.is_aco === true ? [] : [names[level]];
  if (level === "ad" && regularVideo(settings)) editable_fields.push("ad_text", "landing_page_url", "call_to_action", "video_id");
  if (level === "ad_group") {
    const readableSchedule = settings.schedule_start_time && (!fingerprint.schedule_end_time || settings.schedule_end_time) && (settings.schedule_type !== "SCHEDULE_START_END" || settings.schedule_end_time);
    if (settings.auto_targeting_enabled !== true) {
      editable_fields.push("location_ids", "age_groups", "gender");
      if (settings.smart_audience_enabled !== true) editable_fields.push("languages");
      else limitations.push("Smart Audience is enabled. Age, gender and location can be edited here; edit languages in TikTok Ads Manager.");
    } else limitations.push("Automatic targeting is enabled. Edit targeting in TikTok Ads Manager.");
    if (readableSchedule) {
      editable_fields.push("schedule_end_time");
      if (Date.parse(String(settings.schedule_start_time)) > Date.now()) editable_fields.push("schedule_start_time");
    }
  }
  if (level === "ad" && creative?.call_to_action_id) {
    const index = editable_fields.indexOf("call_to_action"); if (index >= 0) editable_fields.splice(index, 1);
    limitations.push("This ad uses an automatic call-to-action portfolio. Edit its call to action in TikTok Ads Manager.");
  }
  if (level === "ad" && !fullCreativeReadable(creative)) {
    for (const key of ["landing_page_url", "call_to_action"]) { const index = editable_fields.indexOf(key); if (index >= 0) editable_fields.splice(index, 1); }
    if (regularVideo(settings)) limitations.push("TikTok did not return the identity or cover needed to preserve a full creative update. Edit its destination and call to action in TikTok Ads Manager.");
  }
  const object: SettingsObject = { id, level, campaign_id: campaignId, ad_group_id: groupId, name: str(raw[names[level]]) ?? id, status, secondary_status: str(raw.secondary_status), budget: numeric(raw.budget), budget_mode: str(raw.budget_mode), settings, limitations: [...new Set(limitations)], editable_fields, revision: createHash("sha256").update(JSON.stringify(stable)).digest("hex") };
  if (creative) creativeSnapshots.set(object, creative);
  if (groupConfiguration) { groupSnapshots.set(object, groupConfiguration); groupTimezone.set(object, conn.advertiser.timezone); }
  return object;
}

function regularVideo(settings: Record<string, SettingsValue>): boolean {
  const dynamic = (v: SettingsValue | undefined) => v != null && v !== false && v !== "" && v !== "DISABLED" && v !== "OFF";
  return settings.ad_format === "SINGLE_VIDEO" && !settings.tiktok_item_id && settings.is_aco !== true
    && (!settings.vertical_video_strategy || settings.vertical_video_strategy === "SINGLE_VIDEO")
    && !(Array.isArray(settings.ad_texts) && settings.ad_texts.length > 0)
    && !dynamic(settings.dynamic_format) && !dynamic(settings.dynamic_destination);
}

async function readObjects(conn: Connection, level: SettingsLevel, filtering: Record<string, string[]>): Promise<SettingsObject[]> {
  const all: SettingsObject[] = [];
  let knownPages: number | undefined;
  for (let page = 1; page <= 20; page++) {
    const query = new URLSearchParams({ advertiser_id: conn.advertiser.id, filtering: JSON.stringify(filtering), page: String(page), page_size: "100" });
    const data = await tt(conn.account, `/${paths[level]}/get/?${query}`);
    if (!Array.isArray(data.list) || !data.list.every(x => x && typeof x === "object" && !Array.isArray(x))) fail("bad_response", "TikTok returned an invalid campaign detail list.");
    all.push(...data.list.map(x => objectOf(x as Record<string, unknown>, level, conn)));
    const pages = (data.page_info as { total_page?: unknown } | undefined)?.total_page;
    if (pages !== undefined && (!Number.isInteger(pages) || Number(pages) < 0)) fail("bad_response", "TikTok returned invalid pagination.");
    if (pages !== undefined) knownPages = Math.max(knownPages ?? 0, Number(pages));
    if (knownPages === undefined && data.list.length >= 100) fail("bad_response", "TikTok did not confirm that its campaign detail list is complete.");
    if (knownPages === undefined || page >= knownPages) return all;
  }
  return fail("bad_response", "This campaign has more objects than this editor can read. Open TikTok Ads Manager.");
}

function requireObject(objects: SettingsObject[], campaignId: string, objectId: string): SettingsObject {
  const object = objects.find(o => o.id === objectId && o.campaign_id === campaignId);
  if (!object || object.status === "DELETED" || object.secondary_status?.includes("DELETE")) fail("object_not_found", "This object is no longer in the selected TikTok campaign.");
  return object;
}

export async function readCampaignSettings(tenantId: string, advertiserId: string, campaignId: string) {
  if (!/^\d{1,32}$/.test(campaignId)) fail("object_not_found", "Choose a valid campaign.");
  const conn = await connect(tenantId, advertiserId);
  const campaign = requireObject(await readObjects(conn, "campaign", { campaign_ids: [campaignId] }), campaignId, campaignId);
  const [groups, ads] = await Promise.all([readObjects(conn, "ad_group", { campaign_ids: [campaignId] }), readObjects(conn, "ad", { campaign_ids: [campaignId] })]);
  const adGroups = groups.filter(o => o.campaign_id === campaignId && !o.secondary_status?.includes("DELETE") && o.status !== "DELETED").map(group => attachCampaignContext(group, campaign));
  return { advertiser: conn.advertiser, campaign, ad_groups: adGroups, ads: ads.filter(o => o.campaign_id === campaignId && !o.secondary_status?.includes("DELETE") && o.status !== "DELETED").map(ad => attachAdContext(ad, campaign, adGroups.find(group => group.id === ad.ad_group_id))) };
}

async function readOne(conn: Connection, level: SettingsLevel, campaignId: string, objectId: string) {
  const key = level === "campaign" ? "campaign_ids" : level === "ad_group" ? "adgroup_ids" : "ad_ids";
  const object = requireObject(await readObjects(conn, level, { [key]: [objectId] }), campaignId, objectId);
  if (level === "ad_group") {
    const campaign = requireObject(await readObjects(conn, "campaign", { campaign_ids: [campaignId] }), campaignId, campaignId);
    return attachCampaignContext(object, campaign);
  }
  if (level === "ad" && object.settings.identity_type === "CUSTOMIZED_USER" && regularVideo(object.settings)) {
    const [campaigns, groups] = await Promise.all([readObjects(conn, "campaign", { campaign_ids: [campaignId] }), readObjects(conn, "ad_group", { adgroup_ids: [object.ad_group_id!] })]);
    const campaign = requireObject(campaigns, campaignId, campaignId);
    const group = attachCampaignContext(requireObject(groups, campaignId, object.ad_group_id!), campaign);
    return attachAdContext(object, campaign, group);
  }
  return object;
}

export async function readSettingsObject(tenantId: string, advertiserId: string, campaignId: string, level: SettingsLevel, objectId: string) {
  const conn = await connect(tenantId, advertiserId);
  return readOne(conn, level, campaignId, objectId);
}

export async function resolveSettingsHold(tenantId: string, objectId: string, value: unknown): Promise<"landed" | "not_landed" | null> {
  const parsed = tiktokSettingsBody.safeParse(value);
  if (!parsed.success || parsed.data.level !== "ad_group" || parsed.data.object_id !== objectId) return null;
  const body = parsed.data;
  const schedule = Object.entries(body.changes).filter(([key]) => key === "schedule_start_time" || key === "schedule_end_time");
  if (!schedule.length) return null;
  const current = await readSettingsObject(tenantId, body.advertiser_id, body.campaign_id, "ad_group", objectId);
  if (current.ad_group_id !== body.ad_group_id) return null;
  if (current.revision === body.revision) return "not_landed";
  if (schedule.every(([key, value]) => same(current.settings[key], value)) && isDailyMode(current.budget_mode) && current.budget === body.daily_budget_usd) return "landed";
  return null;
}

function preserveName(value: string, old: string): string {
  const tag = / · (?:campaign|ad group|ad) · zv[0-9a-f]{10}$/.exec(old)?.[0] ?? "";
  let name = value;
  if (tag && !name.endsWith(tag)) name += tag;
  if (old.startsWith("Zavi · ") && !name.startsWith("Zavi · ")) name = `Zavi · ${name}`;
  if (name.length > 512) fail("name_too_long", "Use a shorter name so Zavi can retain its campaign tracking tag.");
  return name;
}

function scheduleExtends(object: SettingsObject, changes: Record<string, SettingsValue>): boolean {
  const oldStart = object.settings.schedule_start_time;
  const oldEnd = object.settings.schedule_end_time;
  return (typeof changes.schedule_start_time === "string" && typeof oldStart === "string" && Date.parse(changes.schedule_start_time) < Date.parse(oldStart))
    || (typeof changes.schedule_end_time === "string" && typeof oldEnd === "string" && Date.parse(changes.schedule_end_time) > Date.parse(oldEnd));
}

async function validateChanges(tenantId: string, conn: Connection, object: SettingsObject, input: SettingsChangeInput): Promise<{ changes: Record<string, SettingsValue>; locations?: TiktokPlace[] }> {
  const changes = { ...input.changes } as Record<string, SettingsValue>;
  let locations: TiktokPlace[] | undefined;
  const nameKey = names[input.level];
  if (typeof changes[nameKey] === "string") changes[nameKey] = preserveName(changes[nameKey], object.name);
  if (input.level === "ad_group") {
    const advanced = advancedGroupValues(input.changes);
    if (Object.keys(advanced).some(key => !object.editable_fields.includes(key))) fail("settings_unsupported", "This advanced setting is not available for the campaign's current type, placement or budget strategy.");
    await verifyAdvancedGroup(conn.account, conn.advertiser.id, advanced, object.settings);
    if (changes.languages && (changes.smart_audience_enabled ?? object.settings.smart_audience_enabled) === true) fail("targeting_unsupported", "Change languages with Smart Audience switched off.");
    for (const key of advancedGroupKeys) if (Array.isArray(changes[key])) changes[key] = set(changes[key] as string[]);
    if (changes.dayparting === "0".repeat(336)) changes.dayparting = "1".repeat(336);
    if (changes.location_ids) locations = await verifyTiktokLocations(conn.account, conn.advertiser.id, changes.location_ids as string[]);
    if (changes.languages) await verifyTiktokLanguages(conn.account, conn.advertiser.id, changes.languages as string[]);
    if (changes.age_groups) changes.age_groups = normalizeTiktokAudience({ age_groups: input.changes.age_groups }).age_groups;
    for (const key of ["location_ids", "languages"]) if (Array.isArray(changes[key])) changes[key] = set(changes[key] as string[]);
    if (Object.keys(changes).some(k => ["location_ids", "age_groups", "gender", "languages"].includes(k) && !object.editable_fields.includes(k))) fail("targeting_unsupported", "This targeting setting uses an automatic audience configuration. Edit it in TikTok Ads Manager.");
    if (changes.schedule_start_time || changes.schedule_end_time) {
      if (!object.editable_fields.includes("schedule_end_time")) fail("schedule_unreadable", "The current schedule cannot be read unambiguously. Edit it in TikTok Ads Manager.");
      if (object.settings.schedule_type === "SCHEDULE_START_END" && !object.settings.schedule_end_time) fail("schedule_unreadable", "The current end time cannot be read unambiguously. Edit it in TikTok Ads Manager.");
      const start = String(changes.schedule_start_time ?? object.settings.schedule_start_time);
      const end = changes.schedule_end_time ?? object.settings.schedule_end_time;
      if (changes.schedule_start_time && (Date.parse(String(object.settings.schedule_start_time)) <= Date.now() || Date.parse(start) <= Date.now())) fail("schedule_invalid", "The start time cannot be changed after delivery has started. Choose a future start for an unstarted ad group.");
      if (typeof end === "string" && (Date.parse(end) <= Math.max(Date.parse(start), Date.now()))) fail("schedule_invalid", "Choose an end after the start and in the future.");
      for (const key of ["schedule_start_time", "schedule_end_time"]) if (typeof changes[key] === "string") {
        const iso = new Date(changes[key] as string).toISOString();
        scheduleWireTime(iso, key === "schedule_start_time" ? "start" : "end");
        changes[key] = iso;
      }
      if (scheduleExtends(object, changes)) {
        if (conn.advertiser.currency !== "USD") fail("currency_unsupported", "Extending a TikTok schedule currently supports USD ad accounts only.");
        if (!isDailyMode(object.budget_mode) || !object.budget || object.budget <= 0) fail("budget_unknown", "Extending a schedule requires this ad group's own daily budget.");
        const { testStopsForObjects, isOpenStop } = await import("@/services/growth/test-stops");
        const stops = await testStopsForObjects(tenantId, "tiktok", [object.id, object.campaign_id]);
        if (stops.some(s => s.account_id === conn.advertiser.id && isOpenStop(s))) fail("test_schedule_bound", "This campaign has an approved test stop. You can shorten its schedule; start a new campaign to run beyond the test's original limit.");
      }
    }
  }
  if (input.level === "ad") {
    if (object.settings.is_aco === true) fail("creative_unsupported", "Edit this automated creative in TikTok Ads Manager. Its settings cannot be changed in this editor.");
    if (Object.keys(changes).some(k => k !== "ad_name") && !regularVideo(object.settings)) fail("creative_unsupported", "Edit this source post or automated creative in TikTok Ads Manager. Only its ad name can be changed here.");
    if (changes.call_to_action && !object.editable_fields.includes("call_to_action")) fail("creative_unsupported", "This ad's call to action cannot be safely changed here. Edit it in TikTok Ads Manager.");
    if (changes.landing_page_url && !object.editable_fields.includes("landing_page_url")) fail("creative_unreadable", "TikTok did not return the full creative needed to preserve this ad. Edit its destination in TikTok Ads Manager.");
    const replacingVideo = typeof changes.video_id === "string" && changes.video_id !== object.settings.video_id;
    if (changes.aigc_disclosure_type !== undefined && (!replacingVideo || !object.editable_fields.includes("aigc_disclosure_type"))) fail("disclosure_unsupported", "AI disclosure can change only with a replacement video on a supported non-Spark ad.");
    if (replacingVideo && disclosureEligible.get(object)) {
      if (!object.editable_fields.includes("aigc_disclosure_type")) fail("creative_unreadable", "TikTok did not return the full creative needed to replace this video and its disclosure. Edit it in TikTok Ads Manager.");
      if (changes.aigc_disclosure_type === undefined) fail("disclosure_required", "Choose whether the replacement video contains AI-generated content before reviewing this edit.");
      if (changes.aigc_disclosure_type !== "SELF_DISCLOSURE" && await isKnownGeneratedVideo(tenantId, conn.advertiser.id, changes.video_id as string)) fail("disclosure_required", "This video was generated by Zavi. Select the AI-generated disclosure for the replacement.");
    }
    if (typeof changes.landing_page_url === "string") {
      const tag = /^Zavi · .* · ad · (zv[0-9a-f]{10})$/.exec(object.name)?.[1];
      if (tag) {
        const destination = new URL(changes.landing_page_url);
        if (destination.searchParams.get("utm_campaign") !== tag && destination.searchParams.get("zavi_launch") !== tag) changes.landing_page_url = withLaunchUtm(changes.landing_page_url, tag);
      }
      await assertLandingUrl(changes.landing_page_url);
    }
    if (typeof changes.video_id === "string") {
      const video = await readLaunchVideo(conn.account, conn.advertiser.id, changes.video_id);
      if (!video || video.video_id !== changes.video_id) fail("video_unreadable", "That video is not in this ad account's library.");
      const problem = videoRefusal(video); if (problem) throw problem;
      if (!video.cover_url) fail("video_unreadable", "TikTok has not made this video's cover yet. Try again once the video is ready.");
    }
  }
  for (const [key, value] of Object.entries(changes)) if (same(value, object.settings[key]) && !(key === "aigc_disclosure_type" && changes.video_id && changes.video_id !== object.settings.video_id)) delete changes[key];
  if (!Object.keys(changes).length) fail("no_change", "These settings already match TikTok.");
  if (input.level === "ad_group") fullGroupUpdate(groupSnapshots.get(object) ?? {}, changes, parentContexts.get(object));
  return { changes, locations };
}

export async function proposeSettingsBody(tenantId: string, value: unknown): Promise<TiktokSettingsBody> {
  const input = settingsChangeInput.parse(value);
  const conn = await connect(tenantId, input.advertiser_id);
  const object = await readOne(conn, input.level, input.campaign_id, input.object_id);
  if (object.revision !== input.revision) fail("settings_drifted", "This campaign changed since you opened it. Refresh and review its current settings.");
  const { changes, locations } = await validateChanges(tenantId, conn, object, input);
  let locationNames: Record<string, string> | undefined;
  if (changes.location_ids && locations) {
    const verified = Object.fromEntries(locations.map(place => [place.location_id, place.name]));
    const oldIds = Array.isArray(object.settings.location_ids) ? object.settings.location_ids : [];
    locationNames = { ...await readTiktokLocationNames(conn.account, conn.advertiser.id, oldIds.filter(id => !verified[id])), ...verified };
  }
  return tiktokSettingsBody.parse({ ...input, changes, ...(locationNames ? { location_names: locationNames } : {}), advertiser_name: conn.advertiser.name, name: object.name, ad_group_id: object.ad_group_id, daily_budget_usd: conn.advertiser.currency === "USD" && isDailyMode(object.budget_mode) ? object.budget : null, before: Object.fromEntries(Object.keys(changes).map(key => [key, object.settings[key] ?? null])), origin: "user_initiated_ledger", rationale: "The workspace administrator chose these settings in the campaign editor." });
}

export function settingsUpdateRequest(body: TiktokSettingsBody, timezone: string | null, coverImageId?: string, current?: SettingsObject): { endpoint: string; body: Record<string, unknown>; expected: Record<string, SettingsValue> } {
  const changes = { ...body.changes } as Record<string, SettingsValue>;
  if (body.level === "ad" && changes.video_id && coverImageId) changes.image_ids = [coverImageId];
  const expected = { ...changes };
  if (body.level === "ad_group") {
    for (const key of ["schedule_start_time", "schedule_end_time"]) if (typeof changes[key] === "string") {
      changes[key] = scheduleWireTime(changes[key] as string, key === "schedule_start_time" ? "start" : "end");
    }
    if (changes.schedule_end_time) { changes.schedule_type = "SCHEDULE_START_END"; expected.schedule_type = "SCHEDULE_START_END"; }
    const snapshot = current ? groupSnapshots.get(current) : undefined;
    if (!snapshot) fail("group_unreadable", "Refresh this ad group before updating it. TikTok requires its current settings for a full update.");
    return { endpoint: "/adgroup/update/", body: { advertiser_id: body.advertiser_id, adgroup_id: body.object_id, ...fullGroupUpdate(snapshot, changes, parentContexts.get(current!)) }, expected };
  }
  const fullCreative = body.level === "ad" && ("landing_page_url" in changes || "call_to_action" in changes || "aigc_disclosure_type" in changes);
  const preserved = current ? creativeSnapshots.get(current) : undefined;
  if (fullCreative && !fullCreativeReadable(preserved)) fail("creative_unreadable", "TikTok did not return the complete creative needed to preserve this ad. Refresh or edit it in Ads Manager.");
  const preservedPayload = Object.fromEntries(Object.entries(preserved ?? {}).filter(([, value]) => value !== null));
  if (preserved?.identity_type !== "CUSTOMIZED_USER") delete preservedPayload.aigc_disclosure_type;
  return body.level === "ad"
    ? { endpoint: "/ad/update/", body: { advertiser_id: body.advertiser_id, adgroup_id: body.ad_group_id, patch_update: !fullCreative, creatives: [{ ...(fullCreative ? preservedPayload : {}), ad_id: body.object_id, ...changes }] }, expected }
    : { endpoint: `/${paths[body.level]}/update/`, body: { advertiser_id: body.advertiser_id, [ids[body.level]]: body.object_id, ...changes }, expected };
}

async function guard(row: TiktokExecRow) {
  if (!row.approved_by || row.approved_by_source != null || row.exec_source !== "channel_actions") fail("approval_required", "These settings need a workspace owner or admin to approve them in the campaign editor.");
  const { loadTenantRoleFor } = await import("@/services/auth/tenant-role");
  const role = await loadTenantRoleFor(row.approved_by, row.tenant_id);
  if (role !== "owner" && role !== "admin") fail("admin_required", "Only a workspace owner or admin can approve campaign settings.");
  const { assertSpendWritesOn } = await import("@/services/channels/lock");
  await assertSpendWritesOn("tiktok_ads", "TikTok Ads", "tiktok_ads");
  const { channelPlanLock } = await import("@/services/growth/preview-plan");
  if (await channelPlanLock(row.tenant_id, "tiktok_ads")) fail("plan_required", "Your plan does not allow TikTok Ads changes.");
}

export async function executeTiktokSettings(row: TiktokExecRow): Promise<TiktokExecResult> {
  const { reserveAdSpend, commitAdSpend, dropAdSpendHold } = await import("@/services/decisions/ad-budget");
  let hold: Awaited<ReturnType<typeof reserveAdSpend>> = { status: "no_budget" };
  let sent = false;
  try {
    if (row.decision_class !== TIKTOK_UPDATE_SETTINGS_CLASS) fail("action_unknown", "Unsupported TikTok settings action.");
    await guard(row);
    const body = tiktokSettingsBody.parse(row.body);
    const conn = await connect(row.tenant_id, body.advertiser_id);
    const current = await readOne(conn, body.level, body.campaign_id, body.object_id);
    if (current.revision !== body.revision || current.ad_group_id !== body.ad_group_id) fail("settings_drifted", "These TikTok settings changed after review. Refresh and propose the edit again.");
    const input = settingsChangeInput.parse({ advertiser_id: body.advertiser_id, campaign_id: body.campaign_id, object_id: body.object_id, level: body.level, revision: body.revision, changes: body.changes });
    const { changes } = await validateChanges(row.tenant_id, conn, current, input);
    if (!same(changes, body.changes)) fail("settings_drifted", "The reviewed settings no longer match the change. Refresh and review again.");
    let coverImageId: string | undefined;
    if (body.level === "ad" && body.changes.video_id) {
      const video = await readLaunchVideo(conn.account, body.advertiser_id, body.changes.video_id);
      if (!video?.cover_url) fail("video_unreadable", "TikTok has not made this video's cover yet.");
      await guard(row);
      coverImageId = await uploadLaunchImage(conn.account, body.advertiser_id, video.cover_url, `edit-${row.id}-cover`);
    }
    if (body.level === "ad_group" && scheduleExtends(current, changes)) {
      hold = await reserveAdSpend(row, { platform: "tiktok", op: "raise", object_id: current.id, daily_delta_usd: current.budget!, currency: conn.advertiser.currency ?? "UNKNOWN", ...(current.budget_mode === "BUDGET_MODE_DYNAMIC_DAILY_BUDGET" ? { delivery_factor: 1.25 } : {}) });
      if (hold.status === "refused") fail("budget_refused", hold.error);
    }
    await guard(row);
    const fresh = await readOne(conn, body.level, body.campaign_id, body.object_id);
    if (fresh.revision !== body.revision) fail("settings_drifted", "TikTok changed while this edit was being prepared. Nothing was sent.");
    const request = settingsUpdateRequest(body, conn.advertiser.timezone, coverImageId, fresh);
    sent = true;
    await tiktokPost(conn.account, request.endpoint, request.body);
    const after = await readOne(conn, body.level, body.campaign_id, body.object_id).catch(() => fail("outcome_unknown", "TikTok did not confirm the settings after the update. Check Ads Manager before making another edit."));
    if (parentRevisions.get(current) !== parentRevisions.get(after)) fail("outcome_unknown", "The parent campaign or ad group changed during this update. Check Ads Manager before making another edit.");
    const expected = { ...current.settings, ...request.expected };
    const originalGroup = groupSnapshots.get(current);
    const actualGroup = groupSnapshots.get(after);
    const expectedGroup = { ...originalGroup, ...request.body };
    if (expectedGroup.bid_type === "BID_TYPE_NO_BID") { expectedGroup.bid_price = null; expected.bid_price = null; }
    if (originalGroup && Object.keys(originalGroup).some(key => !same(actualGroup?.[key], groupConfigurationValue(key, expectedGroup[key])))) fail("outcome_unknown", "TikTok did not confirm preservation of the ad group's other settings. Check Ads Manager before making another edit.");
    const expectedCreative = body.level === "ad" ? { ...creativeSnapshots.get(current), ...request.expected } : null;
    const actualCreative = creativeSnapshots.get(after);
    if (after.status !== current.status || after.budget !== current.budget || after.budget_mode !== current.budget_mode || Object.entries(expected).some(([key, value]) => !same(after.settings[key], value)) || (expectedCreative && Object.entries(expectedCreative).some(([key, value]) => !same(actualCreative?.[key], value)))) fail("outcome_unknown", "TikTok did not confirm every changed setting. Check Ads Manager before making another edit.");
    await commitAdSpend(hold, current.id);
    return { ok: true, notice: `TikTok confirmed the settings for “${after.name}”. Creative changes may need TikTok's review before delivery.` };
  } catch (e) {
    const code = e instanceof ExpectedToolError ? e.code : "tiktok_ads_settings_failed";
    const definite = ["tiktok_ads_write_refused", "tiktok_ads_token_revoked", "tiktok_ads_rate_limited"].includes(code);
    if (!sent || definite) {
      await dropAdSpendHold(hold);
      return { ok: false, code, error: e instanceof Error ? e.message : "TikTok settings could not be changed." };
    }
    return { ok: false, code: "exec_outcome_unknown", outcome_unknown: true, error: "TikTok may have applied this edit but did not confirm it. Check the current settings in TikTok Ads Manager before another edit." };
  }
}
