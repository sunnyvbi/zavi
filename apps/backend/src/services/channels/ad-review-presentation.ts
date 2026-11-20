import { z } from "zod";
import { adReviewCreativeSchema, type AdReviewCreative, type AdReviewPresentation } from "@zavi/shared";
import { CHATGPT_CREATE, growthCreateBody } from "@/services/connectors/chatgpt-ads/growth-actions";
import { adReviewVersion, record } from "./ad-review/version";

const words = z.array(z.string());
const creativeFields = z.object({
  title: z.string().optional(), body: z.string().optional(), headline: z.string().optional(),
  primary_text: z.string().optional(), image_url: z.string().optional(), video_url: z.string().optional(),
  image_path: z.string().optional(), post_id: z.string().optional(), source_ad_id: z.string().optional(),
  image_artifact_id: z.string().optional(), video_asset_id: z.string().optional(),
  image_hash: z.string().optional(), long_headlines: words.optional(),
  target_url: z.string().optional(), destination_url: z.string().optional(), link_url: z.string().optional(),
  final_urls: words.optional(), headlines: words.optional(), descriptions: words.optional(),
  youtube_video_ids: words.optional(), business_name: z.string().optional(), source: z.string().optional(),
  cta: z.string().optional(), call_to_action: z.string().optional(),
});
const payloadSchema = creativeFields.extend({
  ad: creativeFields.optional(),
  ads: z.array(creativeFields).optional(),
  creatives: z.array(creativeFields).optional(),
  ad_group: z.object({ ads: z.array(creativeFields).optional() }).optional(),
  demand_gen_ad_group: z.object({ ad: creativeFields }).optional(),
  pmax_asset_group: creativeFields.optional(),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  ad_text: z.string().optional(), landing_url: z.string().optional(),
  identity: z.object({ display_name: z.string().nullable().optional() }).optional(),
  video: z.object({ video_id: z.string() }).optional(),
  tweet_ids: words.optional(),
  currency: z.string().nullable().optional(), daily_budget_usd: z.number().optional(),
  daily_budget: z.union([z.number(), z.object({ amount: z.string(), currency: z.string() })]).optional(),
  lifetime_budget_micros: z.number().optional(),
  campaign: z.object({
    daily_budget_usd: z.number().optional(), daily_budget: z.object({ amount: z.string(), currency: z.string() }).optional(), lifetime_budget_micros: z.number().optional(),
    start_time: z.union([z.string(), z.number()]).nullable().optional(), end_time: z.union([z.string(), z.number()]).nullable().optional(),
  }).optional(),
  creative: creativeFields.extend({ post_urn: z.string().regex(/^urn:li:(share|ugcPost):\d+$/).optional() }).optional(),
  start_time: z.union([z.string(), z.number()]).nullable().optional(), end_time: z.union([z.string(), z.number()]).nullable().optional(),
});

const SOURCE_LABELS: Record<string, string> = {
  zavi_generated: "Zavi-generated creative", library: "Your media library", copy: "An existing ad",
};
const PREFIXES = ["meta_ads.", "google_ads.", "tiktok_ads.", "reddit_ads.", "linkedin_ads.", "x_ads.", "chatgpt_ads."];

function creativeOf(value: z.infer<typeof creativeFields>): AdReviewCreative[] {
  const common = {
    title: value.title ?? value.headline ?? value.headlines?.join(" | "),
    body: value.body ?? value.primary_text ?? value.descriptions?.join(" "),
    image_url: value.image_url, image_path: value.image_path, video_url: value.video_url,
    image_artifact_id: value.image_url || value.image_path ? undefined : value.image_artifact_id,
    media_kind: value.video_url || value.video_asset_id || value.youtube_video_ids?.length ? "video" : value.image_url || value.image_path || value.image_artifact_id || value.image_hash ? "image" : undefined,
    target_url: value.target_url ?? value.destination_url ?? value.link_url ?? value.final_urls?.[0],
    advertiser: value.business_name, call_to_action: value.cta ?? value.call_to_action,
    source: value.source ? SOURCE_LABELS[value.source] : value.post_id || value.source_ad_id ? "An existing post or ad" : undefined,
    headlines: value.headlines, descriptions: value.descriptions,
  };
  const variants = value.youtube_video_ids?.length ? value.youtube_video_ids.map((youtube_video_id) => ({ ...common, youtube_video_id })) : [common];
  return variants.flatMap((variant) => {
    const parsed = adReviewCreativeSchema.safeParse(variant);
    return parsed.success && (parsed.data.title || parsed.data.body || parsed.data.media_kind || parsed.data.image_url || parsed.data.image_path || parsed.data.video_url || parsed.data.youtube_video_id || parsed.data.source) ? [parsed.data] : [];
  });
}

function costOf(value: z.infer<typeof payloadSchema>, execClass: string): string | undefined {
  if (value.campaign?.daily_budget) return `${value.campaign.daily_budget.amount} ${value.campaign.daily_budget.currency} a day`;
  if (value.campaign?.daily_budget_usd !== undefined && value.currency) return `${value.campaign.daily_budget_usd} ${value.currency} a day`;
  if (value.campaign?.lifetime_budget_micros !== undefined && value.currency) return `${value.campaign.lifetime_budget_micros / 1e6} ${value.currency} total`;
  if (value.daily_budget_usd !== undefined) {
    const currency = value.currency ?? (execClass.startsWith("meta_ads.") ? null : "USD");
    return currency ? `${value.daily_budget_usd} ${currency} a day` : undefined;
  }
  if (typeof value.daily_budget === "object") return `${value.daily_budget.amount} ${value.daily_budget.currency} a day`;
  if (typeof value.daily_budget === "number" && value.currency) return `${value.daily_budget} ${value.currency} a day`;
  if (value.lifetime_budget_micros !== undefined && value.currency) return `${value.lifetime_budget_micros / 1e6} ${value.currency} total`;
  return undefined;
}

export function projectAdReview(execClass: string | null | undefined, payload: unknown): AdReviewPresentation | null {
  if (!execClass || !PREFIXES.some((prefix) => execClass.startsWith(prefix))) return null;
  let projected = payload;
  if (execClass === CHATGPT_CREATE) {
    const current = growthCreateBody.safeParse(payload);
    if (!current.success) return null;
    const { campaign, ads } = current.data.bundle;
    projected = { currency: current.data.currency, ads, campaign: {
      ...campaign, daily_budget_usd: campaign.daily_budget_micros == null ? undefined : campaign.daily_budget_micros / 1e6,
    } };
  }
  const parsed = payloadSchema.safeParse(projected);
  if (!parsed.success) return null;
  const value = parsed.data;
  const single = execClass.startsWith("reddit_ads.") ? value.creative : undefined;
  const candidates = value.creatives ?? value.ads ?? value.ad_group?.ads ?? [value.demand_gen_ad_group?.ad ?? value.pmax_asset_group ?? value.ad ?? single ?? value];
  const creatives = candidates.flatMap(creativeOf);
  if (value.ad_text) {
    const creative = adReviewCreativeSchema.safeParse({ body: value.ad_text, target_url: value.landing_url, advertiser: value.identity?.display_name ?? undefined, call_to_action: value.call_to_action, media_kind: value.video ? "video" : undefined });
    if (creative.success) creatives.push(creative.data);
  }
  if (execClass.startsWith("x_ads.") && value.tweet_ids) {
    for (const id of value.tweet_ids.filter((id) => /^\d{1,25}$/.test(id))) creatives.push({ target_url: `https://x.com/i/web/status/${id}`, source: "An existing X post" });
  }
  if (execClass.startsWith("linkedin_ads.") && value.creative?.post_urn) creatives.push({ target_url: `https://www.linkedin.com/feed/update/${value.creative.post_urn}/`, source: "An existing company post" });
  const start = value.campaign?.start_time ?? value.start_time;
  const end = execClass === "tiktok_ads.create_launch" && value.end_date ? `${value.end_date}T00:00:00Z` : value.campaign?.end_time ?? value.end_time;
  const time = (value: string | number | null | undefined): string | null => {
    if (value == null) return null;
    const date = new Date(typeof value === "number" ? value * 1000 : value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  };
  if (!creatives.length && !start && !end) return null;
  return {
    creatives, cost: costOf(value, execClass), provenance: creatives.find((creative) => creative.source)?.source,
    revision: adReviewVersion(execClass, payload),
    ...((start || end) ? { schedule: { start: time(start), end: time(end) } } : {}),
  };
}

export function withAdReview(body: unknown, execClass: string | null | undefined, payload: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const review = projectAdReview(execClass, payload);
  return review ? { ...body, ad_review: record(body) && body.ad_review_edited === true ? { ...review, provenance: "Edited by you" } : review } : body;
}
