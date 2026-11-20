import { z } from "zod";
import { ExpectedToolError } from "@/services/tools/types";
import { resourceOptions, requireOption, type ResourceAccount } from "./resources";
import { adConstraint } from "@zavi/shared";

export const CHATGPT_MIN_DAILY_USD = adConstraint("chatgpt_ads")!.min_daily_usd;
export const CHATGPT_MIN_DAILY_MICROS = CHATGPT_MIN_DAILY_USD * 1_000_000;

export const resourceId = z.string().min(1).max(200).regex(/^[a-zA-Z0-9_-]+$/);
const countries = z.array(z.string().regex(/^[A-Z]{2}$/)).max(250);
const geo = z.object({ countries: countries.optional(), include: z.array(z.object({ id: resourceId }).strict()).max(2500).optional() }).strict();
export const targeting = z.object({
  locations: geo.optional(), excluded_locations: geo.optional(),
  platforms: z.object({ included: z.array(z.enum(["ios_app", "android_app", "web"])).min(1).max(3) }).strict().optional(),
  custom_audiences: z.object({ ids: z.array(resourceId).max(100) }).strict().optional(),
  excluded_custom_audiences: z.object({ ids: z.array(resourceId).max(100) }).strict().optional(),
}).strict();
export const tracking = z.string().max(2000).refine(value => {
  if (!value) return true;
  const fields = [...new URLSearchParams(value)];
  return fields.length > 0 && fields.every(([k, v]) => /^(utm_[a-z_]+|click_id)$/.test(k) && !/[\r\n]/.test(v) && [...v.matchAll(/\{([^}]+)\}/g)].every(m => ["campaign_id", "ad_group_id", "ad_id", "oppref"].includes(m[1])));
}, "Use UTM fields or click_id with supported tracking placeholders.");
export const scheduleFields = {
  start_time: z.number().int().min(946684800).max(4102444800).nullable().optional(),
  end_time: z.number().int().min(946684800).max(4102444800).nullable().optional(),
  targeting: targeting.optional(),
  landing_page_configuration: z.object({ query_string_template: tracking }).strict().optional(),
};
export async function checkResources(tenantId: string, value: Record<string, any>,account?:ResourceAccount) {
  const included = value.targeting?.custom_audiences?.ids ?? [], excluded = value.targeting?.excluded_custom_audiences?.ids ?? [];
  if (included.some((v: string) => excluded.includes(v))) throw new ExpectedToolError("chatgpt_ads_conflict", "An audience cannot be both included and excluded.");
  if (!value.conversion_event_setting_ids?.length && !value.product_feed_id && !included.length && !excluded.length) return;
  const options = await resourceOptions(tenantId,account);
  for (const v of value.conversion_event_setting_ids ?? []) requireOption(options.conversion_events, v);
  for (const v of included) requireOption(options.inclusion_audiences, v);
  for (const v of excluded) requireOption(options.exclusion_audiences, v);
  if (value.product_feed_id) requireOption(options.product_feeds, value.product_feed_id);
}
export function validateSchedule(campaign: Record<string, any>, now = Date.now() / 1000) {
  const { start_time: start, end_time: end } = campaign;
  if (end != null && (end <= (start ?? now) || end <= now)) throw new ExpectedToolError("chatgpt_ads_conflict", "Choose an end time after the start and in the future.");
  if (campaign.budget?.daily_spend_limit_micros != null && (!start || !end || end - start > 90 * 86400)) throw new ExpectedToolError("chatgpt_ads_conflict", "Daily-budget campaigns need explicit start and end times, no more than 90 days apart.");
}
export function fundingLimit(campaign: Record<string, any>): number {
  const budget = campaign.budget;
  if (Number.isSafeInteger(budget?.lifetime_spend_limit_micros) && budget.lifetime_spend_limit_micros > 0 && budget.daily_spend_limit_micros == null) return budget.lifetime_spend_limit_micros;
  const daily = budget?.daily_spend_limit_micros;
  const start = Math.min(campaign.start_time ?? Infinity, campaign.created_at ?? Infinity);
  const end = campaign.end_time;
  if (!Number.isSafeInteger(daily) || daily < CHATGPT_MIN_DAILY_MICROS || !Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 366 * 86400) throw new ExpectedToolError("chatgpt_ads_conflict", "A bounded campaign budget and schedule are required before funding.");
  const limit = daily * 2 * (Math.ceil((end - start) / 86400) + 2);
  if (!Number.isSafeInteger(limit)) throw new ExpectedToolError("chatgpt_ads_conflict", "Campaign funding amount is too large.");
  return limit;
}
