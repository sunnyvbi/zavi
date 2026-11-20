import { z } from "zod";
import { AD_IMAGE_PATH_RE } from "@zavi/shared";
import { redditId, redditLevel, type RedditLevel } from "./identifiers";

export { redditId, redditLevel, type RedditLevel };
export const operationKey = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
const webUrl = z.string().url().max(2048).refine((v) => {
  const u = new URL(v);
  return u.protocol === "https:" && !u.username && !u.password;
}, "Use an HTTPS website URL without credentials");
export function samePage(a: string, b: string): boolean {
  try {
    const x = new URL(a), y = new URL(b);
    return x.origin === y.origin && x.pathname === y.pathname;
  } catch {
    return false;
  }
}
export const targetingSchema = z.object({
  geolocations: z.array(z.string().regex(/^[A-Za-z0-9:_-]{1,128}$/)).min(1).max(100),
  excluded_geolocations: z.array(z.string().regex(/^[A-Za-z0-9:_-]{1,128}$/)).min(1).max(100).optional().describe("Places to leave out, same ids as geolocations. Omit when nothing is excluded."),
  communities: z.array(z.string().regex(/^[A-Za-z0-9_]{1,64}$/)).max(100).default([]),
  interests: z.array(redditId).max(100).default([]),
  locations: z.array(z.enum(["FEED", "CONVERSATION"])).min(1).default(["FEED"]),
  expand_targeting: z.literal(false).default(false),
}).strict();
export const creativeSchema = z.object({
  name: z.string().min(3).max(200),
  headline: z.string().min(3).max(250),
  image_url: webUrl.optional().describe("A public https JPG or PNG. Give this OR image_artifact_id."),
  image_artifact_id: z.string().uuid().optional().describe("An image Zavi made for this workspace (report__render_social_image artifact_id). Give this OR image_url. Zavi signs a short link to it only when the approved preparation creates the ad."),
  image_path: z.string().regex(AD_IMAGE_PATH_RE).optional().describe("A photo the founder attached in chat: its exact image_path from the stored photo references. Give this, image_artifact_id OR image_url."),
  destination_url: webUrl,
  click_url: webUrl.optional().describe("Optional tracking link for the ad: the same page as destination_url, only the query or fragment may differ. Omit to use destination_url."),
  allow_comments: z.boolean().default(false),
}).strict().refine((c) => [c.image_url, c.image_artifact_id, c.image_path].filter(Boolean).length === 1, "Give exactly one of image_url, image_artifact_id or image_path").refine((c) => !c.click_url || samePage(c.click_url, c.destination_url), "click_url must be the same page as destination_url; only tracking parameters may differ");
const common = {
  ad_account_id: redditId,
  name: z.string().min(3).max(200),
  rationale: z.string().min(1).max(1000),
  origin: z.enum(["specialist", "user_initiated_chat", "user_initiated_ledger"]).default("specialist"),
};
const prepareFields = {
  ...common,
  operation_key: operationKey,
  profile_id: redditId,
  pixel_id: redditId,
  objective: z.literal("CLICKS"),
  daily_budget_usd: z.number().min(5).max(100000),
  lifetime_cap_usd: z.number().min(100, "Reddit requires a campaign lifetime cap of at least $100").max(1000000),
  start_time: z.string().datetime({ offset: true }),
  targeting: targetingSchema,
};
const capCoversDaily = (v: { lifetime_cap_usd: number; daily_budget_usd: number }) => v.lifetime_cap_usd >= v.daily_budget_usd;
const placeKey = (g: string) => (/^[A-Za-z]{2}$/.test(g) ? g.toUpperCase() : g);
const noTargetedExclusion = (v: { targeting: { geolocations: string[]; excluded_geolocations?: string[] } }) => {
  const targeted = new Set(v.targeting.geolocations.map(placeKey));
  return !v.targeting.excluded_geolocations?.some((g) => targeted.has(placeKey(g)));
};
export const prepareSchema = z.object({ ...prepareFields, creatives: z.array(creativeSchema).min(1).max(5) }).strict().refine(capCoversDaily, "Lifetime cap must cover the daily budget").refine(noTargetedExclusion, "A place cannot be both targeted and excluded");

export const launchSchema = z.object({ ...common, operation_key: operationKey }).strict();
export const budgetSchema = z.object({
  ...common, ad_group_id: redditId,
  expected_current_daily_budget_usd: z.number().min(5), daily_budget_usd: z.number().min(5).max(100000),
}).strict();
export const targetUpdateSchema = z.object({ ...common, ad_group_id: redditId, expected_modified_at: z.string(), targeting: targetingSchema }).strict().refine(noTargetedExclusion, "A place cannot be both targeted and excluded");
export const adUpdateSchema = z.object({ ...common, ad_id: redditId, expected_modified_at: z.string(), destination_url: webUrl.describe("The ad's new click link. It must be the same page as the ad's image post (only tracking parameters may differ); a different page is propose_replace_creative.") }).strict();
export const replacementSchema = z.object({ ...common, operation_key: operationKey, ad_group_id: redditId, profile_id: redditId, creative: creativeSchema }).strict();
export const statusSchema = z.object({
  ...common, level: redditLevel, object_id: redditId,
  status: z.enum(["PAUSED", "ACTIVE"]), expected_modified_at: z.string(),
}).strict();
export const renameSchema = z.object({
  ...common, level: redditLevel, object_id: redditId, expected_modified_at: z.string(),
  new_name: z.string().trim().min(3).max(200).describe("The new name the founder wants shown in Reddit Ads Manager. Zavi keeps its own [prax:...] tag on objects it created."),
}).strict();
export const removeSchema = z.object({
  ...common, level: redditLevel, object_id: redditId, expected_modified_at: z.string(),
  mode: z.enum(["archive", "delete"]).describe("archive: hides a PAUSED object from Ads Manager; it stops for good. delete: removes an object that is already ARCHIVED; Reddit allows it only some hours after the archive."),
}).strict();
export const authoritySchema = z.object({ ...common, daily_limit_usd: z.number().min(5).max(100000), campaign_lifetime_limit_usd: z.number().min(100, "Reddit requires a campaign lifetime cap of at least $100").max(1000000), objectives: z.array(z.literal("CLICKS")).min(1), geolocations: targetingSchema.shape.geolocations, expires_at: z.string().datetime(), goal_id: z.string().uuid() }).strict();
export const REDDIT_ACTION_SCHEMAS = {
  "reddit_ads.authorize_account": authoritySchema,
  "reddit_ads.prepare_campaign": prepareSchema,
  "reddit_ads.launch_campaign": launchSchema,
  "reddit_ads.update_budget": budgetSchema,
  "reddit_ads.update_targeting": targetUpdateSchema,
  "reddit_ads.update_ad": adUpdateSchema,
  "reddit_ads.replace_creative": replacementSchema,
  "reddit_ads.set_object_status": statusSchema,
  "reddit_ads.rename_object": renameSchema,
  "reddit_ads.remove_object": removeSchema,
} as const;
export type RedditActionClass = keyof typeof REDDIT_ACTION_SCHEMAS;
export function redditActionRaisesSpend(execClass: string | null | undefined, body: unknown): boolean {
  if (execClass === "reddit_ads.authorize_account" || execClass === "reddit_ads.launch_campaign") return true;
  const b = body && typeof body === "object" ? body as Record<string, unknown> : {};
  if (execClass === "reddit_ads.set_object_status") return b.status !== "PAUSED";
  if (execClass !== "reddit_ads.update_budget") return false;
  const to = Number(b.daily_budget_usd), from = Number(b.expected_current_daily_budget_usd);
  return !(Number.isFinite(to) && Number.isFinite(from) && to <= from);
}
export function redditActionNeedsAdmin(execClass: string | null | undefined, body: unknown): boolean {
  return execClass === "reddit_ads.update_targeting" || execClass === "reddit_ads.remove_object" || redditActionRaisesSpend(execClass, body);
}
export type CampaignPlan = z.infer<typeof prepareSchema>;
export type Replacement = z.infer<typeof replacementSchema>;
