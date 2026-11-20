import { z } from "zod";
import { ExpectedToolError } from "@/services/tools/types";

const strings = ["adgroup_name", "catalog_authorized_bc_id", "deep_funnel_optimization_status", "deep_funnel_event_source", "deep_funnel_event_source_id", "deep_funnel_optimization_event", "audience_type", "saved_audience_id", "shopping_ads_retargeting_type", "shopping_ads_retargeting_custom_audience_relation", "gender", "spending_power", "min_android_version", "ios14_targeting", "min_ios_version", "brand_safety_type", "vertical_sensitivity_id", "schedule_type", "schedule_start_time", "schedule_end_time", "dayparting", "secondary_optimization_event", "bid_type", "deep_bid_type", "pacing"];
const booleans = ["comment_disabled", "share_disabled", "search_result_enabled", "automated_keywords_enabled", "auto_targeting_enabled", "exclude_age_under_eighteen", "smart_audience_enabled", "smart_interest_behavior_enabled", "is_hfss", "is_lhf_compliance"];
const numbers = ["shopping_ads_retargeting_actions_days", "budget", "frequency", "frequency_schedule", "bid_price", "conversion_bid_price", "roas_bid", "deep_cpa_bid", "next_day_retention"];
const memberships = ["blocked_pangle_app_ids", "location_ids", "zipcode_ids", "languages", "age_groups", "household_income", "audience_ids", "excluded_audience_ids", "interest_category_ids", "interest_keyword_ids", "purchase_intention_keyword_ids", "included_pangle_audience_package_ids", "excluded_pangle_audience_package_ids", "operating_systems", "device_model_ids", "network_types", "carrier_ids", "isp_ids", "contextual_tag_ids", "category_exclusion_ids"];
const nestedKeys: Record<string, string[]> = {
  search_keywords: ["keyword", "match_type", "keyword_bid_type", "keyword_bid"],
  actions: ["action_scene", "action_period", "video_user_actions", "action_category_ids"],
  included_custom_actions: ["code", "days"], excluded_custom_actions: ["code", "days"],
  targeting_expansion: ["expansion_enabled", "expansion_types"],
};
const customAction = z.object({ code: z.string(), days: z.number().int().min(1).max(180) });
const shape: Record<string, z.ZodTypeAny> = {
  ...Object.fromEntries(strings.map(k => [k, z.string()])),
  ...Object.fromEntries(booleans.map(k => [k, z.boolean()])),
  ...Object.fromEntries(numbers.map(k => [k, z.number().finite()])),
  ...Object.fromEntries(memberships.map(k => [k, z.array(z.string())])),
  device_price_ranges: z.array(z.number().finite()),
  search_keywords: z.array(z.object({ keyword: z.string(), match_type: z.string(), keyword_bid_type: z.string().optional(), keyword_bid: z.number().finite().optional() })),
  actions: z.array(z.object({ action_scene: z.string(), action_period: z.number().finite(), video_user_actions: z.array(z.string()), action_category_ids: z.array(z.string()) })),
  included_custom_actions: z.array(customAction), excluded_custom_actions: z.array(customAction),
  targeting_expansion: z.object({ expansion_enabled: z.boolean(), expansion_types: z.array(z.string()).optional() }),
};
export const groupUpdateKeys = Object.keys(shape);
const fail = (detail: string): never => { throw new ExpectedToolError("tiktok_ads_group_unreadable", `TikTok's full ad-group update cannot safely preserve ${detail}. Refresh or edit this group in Ads Manager.`); };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function projectGroupReadValue(key: string, value: unknown): unknown {
  const keys = nestedKeys[key];
  if (!keys) return value;
  const project = (v: unknown) => record(v) ? Object.fromEntries(keys.filter(k => v[k] !== undefined).map(k => [k, v[k]])) : v;
  return Array.isArray(value) ? value.map(project) : project(value);
}

export function fullGroupUpdate(snapshot: Record<string, unknown>, changes: Record<string, unknown>, parent: Record<string, unknown> = {}): Record<string, unknown> {
  if (snapshot.saved_audience_id) return fail("this saved audience binding");
  if (snapshot.audience_rule != null && (!record(snapshot.audience_rule) || Object.keys(snapshot.audience_rule).length)) return fail("this audience rule");
  if (snapshot.auto_targeting_enabled === true || (record(snapshot.targeting_expansion) && snapshot.targeting_expansion.expansion_enabled === true)) return fail("legacy automatic targeting");
  if (snapshot.brand_safety_type != null && snapshot.brand_safety_type !== "" && !["NO_BRAND_SAFETY", "EXPANDED_INVENTORY", "STANDARD_INVENTORY", "LIMITED_INVENTORY"].includes(String(snapshot.brand_safety_type))) return fail("this legacy or third-party brand-safety setting");
  const merged = { ...snapshot, ...changes };
  const out: Record<string, unknown> = {};
  for (const key of groupUpdateKeys) {
    const value = merged[key];
    if (value == null || value === "") continue;
    const parsed = shape[key].safeParse(projectGroupReadValue(key, value));
    if (!parsed.success) return fail(`the existing ${key.replaceAll("_", " ")} setting`);
    out[key] = parsed.data;
  }
  const requireFields = (...keys: string[]) => { for (const key of keys) if (out[key] == null || out[key] === "") fail(`the required ${key.replaceAll("_", " ")} setting`); };
  if (parent.budget_optimize_on === true) { delete out.budget; delete out.bid_type; delete out.pacing; }
  else requireFields("pacing");
  for (const key of ["share_disabled", "purchase_intention_keyword_ids"]) if (!(key in changes)) delete out[key];
  if (out.brand_safety_type === "NO_BRAND_SAFETY" && !("brand_safety_type" in changes)) delete out.brand_safety_type;
  if (snapshot.promotion_type !== "LEAD_GENERATION" && out.deep_funnel_optimization_status === "OFF") delete out.deep_funnel_optimization_status;
  if (parent.is_search_campaign !== true && out.automated_keywords_enabled === false) delete out.automated_keywords_enabled;
  if (out.deep_funnel_optimization_status === "ON") requireFields("deep_funnel_event_source", "deep_funnel_event_source_id", "deep_funnel_optimization_event");
  if (parent.app_promotion_type === "APP_RETARGETING") requireFields("audience_type");
  if (parent.objective_type === "APP_PROMOTION" || ["APP_IOS", "APP_ANDROID"].includes(String(snapshot.promotion_type))) requireFields("operating_systems");
  if (parent.campaign_type === "IOS14_CAMPAIGN") requireFields("ios14_targeting");
  if (out.ios14_targeting === "UNSET") delete out.ios14_targeting;
  else if (out.ios14_targeting) requireFields("min_ios_version");
  if (Array.isArray(out.operating_systems) && out.operating_systems.length > 1) return fail("the operating-system selection (TikTok accepts one)");
  if (out.schedule_type) requireFields("schedule_start_time");
  if (out.schedule_type === "SCHEDULE_START_END") requireFields("schedule_end_time");
  if (out.secondary_optimization_event) requireFields("deep_bid_type");
  if (out.deep_bid_type === "VO_MIN_ROAS") requireFields("roas_bid");
  if (["LAB1", "LAB2"].includes(String(out.shopping_ads_retargeting_type))) requireFields("shopping_ads_retargeting_actions_days");
  if (out.shopping_ads_retargeting_type === "LAB3" && !out.included_custom_actions && !out.excluded_custom_actions) return fail("the shopping retargeting actions");
  if (snapshot.product_source === "STORE") delete out.catalog_authorized_bc_id;
  if (merged.bid_type === "BID_TYPE_NO_BID") { delete out.bid_price; delete out.conversion_bid_price; }
  else if (merged.bid_type === "BID_TYPE_CUSTOM") {
    if (["CPC", "CPM", "CPV"].includes(String(snapshot.billing_event))) requireFields("bid_price");
    if (snapshot.billing_event === "OCPM") requireFields("conversion_bid_price");
  }
  return out;
}
