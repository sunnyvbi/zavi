
import { z } from "zod";
import { rationaleBody } from "@/services/tools/_shared/rationale";
import { CAP_REASONS } from "./_cap-evaluator";
import {
  checkPromotedObjectForGoal,
  checkTargetingInterestIds,
  checkTargetingGeo,
  checkTargetingPlacements,
  metaGeoPlaceSchema,
  promotedObjectSchema,
} from "./_targeting-validate";

const copyPlaces = z.array(metaGeoPlaceSchema).min(1).max(10).optional();

const authorizedEffectiveCapSchema = z.object({
  enabled: z.literal(true),
  max_daily_budget_usd: z.number().positive(),
  max_pct_change_per_run: z.number().positive(),
});

export type AuthorizedEffectiveCap = z.infer<typeof authorizedEffectiveCapSchema>;

const displayName = z
  .string()
  .trim()
  .transform((s) => s.slice(0, 200))
  .optional();
const displayAbout = z
  .string()
  .trim()
  .transform((s) => s.slice(0, 280))
  .optional();

const bodyCurrency = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, "must be an ISO currency code")
  .optional();

export const updateAdSetBudgetBodySchema = z.object({
  ad_set_id: z.string().min(1),
  daily_budget_usd: z.number().positive(),
  expected_current_daily_budget_usd: z.number().nonnegative(),
  currency: bodyCurrency,
  rationale: rationaleBody(),
  over_cap: z.boolean(),
  cap_reason: z.enum(CAP_REASONS).optional(),
  campaign_id: z.string().min(1).optional(),
  name: displayName,
  about: displayAbout,
  origin: z
    .enum(["user_initiated_chat", "user_initiated_ledger", "agent"])
    .optional(),
  authorized_effective_cap: authorizedEffectiveCapSchema.optional(),
});

export type UpdateAdSetBudgetBody = z.infer<typeof updateAdSetBudgetBodySchema>;

export const updateCampaignBudgetBodySchema = z.object({
  campaign_id: z.string().min(1),
  daily_budget_usd: z.number().positive(),
  expected_current_daily_budget_usd: z.number().nonnegative(),
  currency: bodyCurrency,
  rationale: rationaleBody(),
  over_cap: z.boolean(),
  cap_reason: z.enum(CAP_REASONS).optional(),
  name: displayName,
  about: displayAbout,
  origin: z
    .enum(["user_initiated_chat", "user_initiated_ledger", "agent"])
    .optional(),
  authorized_effective_cap: authorizedEffectiveCapSchema.optional(),
});

export type UpdateCampaignBudgetBody = z.infer<typeof updateCampaignBudgetBodySchema>;

export const setStatusBodySchema = z.object({
  object_id: z.string().min(1),
  level: z.enum(["campaign", "adset"]),
  status: z.enum(["ACTIVE", "PAUSED"]),
  rationale: rationaleBody(),
  over_cap: z.boolean(),
  expected_current_status: z.enum(["ACTIVE", "PAUSED"]).optional(),
  name: displayName,
  about: displayAbout,
});

export type SetStatusBody = z.infer<typeof setStatusBodySchema>;

export function metaActionRaisesSpend(execClass: string | null | undefined, body: unknown): boolean {
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  switch (execClass) {
    case "meta_ads.launch_campaign":
    case "meta_ads.duplicate_campaign":
    case "meta_ads.duplicate_ad_set":
    case "meta_ads.create_ad":
    case "meta_ads.duplicate_ad":
      return true;
    case "meta_ads.update_campaign": {
      if (b.bid_strategy !== undefined && b.bid_strategy !== b.expected_current_bid_strategy) return true;
      if (b.spend_cap_usd === undefined) return false;
      const to = b.spend_cap_usd, from = b.expected_current_spend_cap_usd;
      if (to === null) return from !== null;
      if (from === null) return !Number.isFinite(Number(to));
      return !(typeof to === "number" && typeof from === "number" && Number.isFinite(to) && Number.isFinite(from) && to <= from);
    }
    case "meta_ads.update_ad_set": {
      if (b.bid_strategy !== undefined && b.bid_strategy !== b.expected_current_bid_strategy) return true;
      if (b.bid_amount_usd !== undefined) {
        const to = b.bid_amount_usd, from = b.expected_current_bid_amount_usd;
        if (!(typeof to === "number" && typeof from === "number" && Number.isFinite(to) && Number.isFinite(from) && to <= from)) return true;
      }
      if (b.end_time !== undefined) {
        const from = b.expected_current_end_time;
        if (from === null) return typeof b.end_time !== "string" || !Number.isFinite(Date.parse(b.end_time));
        const to = typeof b.end_time === "string" ? Date.parse(b.end_time) : NaN;
        const was = typeof from === "string" ? Date.parse(from) : NaN;
        if (!(Number.isFinite(to) && Number.isFinite(was) && to <= was)) return true;
      }
      return false;
    }
    case "meta_ads.set_status":
    case "meta_ads.set_status_review":
      return b.status !== "PAUSED";
    case "meta_ads.replace_ad_set_geo_review":
      return true;
    case "meta_ads.update_ad":
      return b.status !== undefined && b.status !== "PAUSED";
    case "meta_ads.update_ad_set_budget":
    case "meta_ads.update_ad_set_budget_review":
    case "meta_ads.update_campaign_budget":
    case "meta_ads.update_campaign_budget_review": {
      const to = Number(b.daily_budget_usd), from = Number(b.expected_current_daily_budget_usd);
      return !(Number.isFinite(to) && Number.isFinite(from) && to <= from);
    }
    default:
      return false;
  }
}

export const metaBidStrategySchema = z.enum([
  "LOWEST_COST_WITHOUT_CAP",
  "LOWEST_COST_WITH_BID_CAP",
  "COST_CAP",
  "LOWEST_COST_WITH_MIN_ROAS",
]);
export type MetaBidStrategy = z.infer<typeof metaBidStrategySchema>;

export const BID_AMOUNT_STRATEGIES: ReadonlySet<MetaBidStrategy> = new Set(["LOWEST_COST_WITH_BID_CAP", "COST_CAP"]);

const WHOLE_CENTS_ERR = "bid_amount_usd must be a whole number of cents";
function wholeCents(n: number): boolean {
  return Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;
}

export function checkNewAdSetBid(strategy: MetaBidStrategy | undefined, amount: number | undefined): string | null {
  if (amount !== undefined && !wholeCents(amount)) return WHOLE_CENTS_ERR;
  if (strategy === "LOWEST_COST_WITH_MIN_ROAS") {
    return "a minimum-ROAS bid is not supported on a new ad set yet; use lowest cost, a bid cap or a cost cap";
  }
  if (strategy && BID_AMOUNT_STRATEGIES.has(strategy)) {
    return amount === undefined ? `${strategy} needs bid_amount_usd` : null;
  }
  if (amount !== undefined) {
    return strategy
      ? `${strategy} takes no bid amount; drop bid_amount_usd or use a bid cap or cost cap`
      : "a bid amount needs bid_strategy LOWEST_COST_WITH_BID_CAP or COST_CAP";
  }
  return null;
}

export function checkCampaignAdSetBid(b: {
  campaign_bid_strategy?: MetaBidStrategy;
  bid_strategy?: MetaBidStrategy;
  bid_amount_usd?: number;
  roas_floor?: number;
  optimization_goal: string;
}): string | null {
  const c = b.campaign_bid_strategy;
  if (c === undefined) return null;
  if (b.bid_amount_usd !== undefined && !wholeCents(b.bid_amount_usd)) return WHOLE_CENTS_ERR;
  if (b.bid_strategy !== undefined) return "the campaign sets the bid strategy; an ad set in it carries no bid_strategy of its own";
  if (BID_AMOUNT_STRATEGIES.has(c)) {
    if (b.roas_floor !== undefined) return `${c} takes a bid amount, not a ROAS floor`;
    return b.bid_amount_usd === undefined ? `the campaign uses ${c}, so the ad set needs bid_amount_usd` : null;
  }
  if (c === "LOWEST_COST_WITH_MIN_ROAS") {
    if (b.bid_amount_usd !== undefined) return "a minimum-ROAS campaign takes a ROAS floor, not a bid amount";
    if (b.optimization_goal !== "VALUE") return "a minimum-ROAS campaign's ad sets must optimise for VALUE";
    return b.roas_floor === undefined ? "the campaign uses a minimum ROAS, so the ad set needs roas_floor" : null;
  }
  return b.bid_amount_usd !== undefined || b.roas_floor !== undefined ? `the campaign uses ${c}, which takes no bid on its ad sets` : null;
}

export const createAdSetBodySchema = z
  .object({
    campaign_id: z.string().min(1),
    name: z.string().min(1).max(200),
    daily_budget_usd: z.number().positive(),
    currency: bodyCurrency,
    optimization_goal: z.string().min(1),
    billing_event: z.string().min(1),
    targeting: z.record(z.string(), z.unknown()),
    rationale: rationaleBody(),
    promoted_object: promotedObjectSchema.optional(),
    bid_strategy: metaBidStrategySchema.optional(),
    bid_amount_usd: z.number().positive().optional(),
    campaign_bid_strategy: metaBidStrategySchema.optional(),
    roas_floor: z.number().min(0.01).max(1000).optional(),
    bid_copied_from: z.object({ ad_sets: z.number().int().positive(), result: z.string().min(1).max(80) }).strict().optional(),
  })
  .superRefine((body, ctx) => {
    const goalErr = checkPromotedObjectForGoal(body.optimization_goal, body.promoted_object);
    if (goalErr) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: goalErr, path: ["promoted_object"] });
    }
    const bidErr = body.campaign_bid_strategy !== undefined
      ? checkCampaignAdSetBid(body)
      : body.roas_floor !== undefined || body.bid_copied_from !== undefined
        ? "roas_floor and bid_copied_from come only with campaign_bid_strategy"
        : checkNewAdSetBid(body.bid_strategy, body.bid_amount_usd);
    if (bidErr) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: bidErr, path: ["bid_strategy"] });
    }
    const interestErr = checkTargetingInterestIds(body.targeting);
    if (interestErr) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: interestErr, path: ["targeting"] });
    }
    const geoErr = checkTargetingGeo(body.targeting);
    if (geoErr) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: geoErr, path: ["targeting"] });
    }
    const placementErr = checkTargetingPlacements(body.targeting);
    if (placementErr) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: placementErr, path: ["targeting"] });
    }
  });

export type CreateAdSetBody = z.infer<typeof createAdSetBodySchema>;

const metaId = z.string().trim().regex(/^\d{5,25}$/, "must be a Meta object id");

const launchOrigin = z.enum(["user_initiated_chat", "user_initiated_ledger", "agent"]).optional();

export const metaCampaignObjectiveSchema = z.enum([
  "OUTCOME_AWARENESS",
  "OUTCOME_TRAFFIC",
  "OUTCOME_ENGAGEMENT",
  "OUTCOME_LEADS",
  "OUTCOME_APP_PROMOTION",
  "OUTCOME_SALES",
]);

export const metaSpecialAdCategorySchema = z.enum([
  "EMPLOYMENT",
  "HOUSING",
  "FINANCIAL_PRODUCTS_SERVICES",
  "ISSUES_ELECTIONS_POLITICS",
]);

const countryCodes = z.array(z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, "must be a 2-letter country code")).max(50);

function checkSpecialCategories(
  b: { special_ad_categories?: string[]; special_ad_category_country?: string[] },
  ctx: z.RefinementCtx,
): void {
  const cats = b.special_ad_categories ?? [];
  const countries = b.special_ad_category_country ?? [];
  if (cats.length > 0 && countries.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["special_ad_category_country"], message: "a special ad category needs the countries it applies in" });
  }
}

export const createCampaignBodySchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    objective: metaCampaignObjectiveSchema,
    special_ad_categories: z.array(metaSpecialAdCategorySchema).max(4).default([]),
    special_ad_category_country: countryCodes.optional(),
    daily_budget_usd: z.number().positive().optional(),
    bid_strategy: metaBidStrategySchema.optional(),
    currency: bodyCurrency,
    about: displayAbout,
    rationale: rationaleBody(),
    origin: launchOrigin,
  })
  .superRefine((b, ctx) => {
    checkSpecialCategories(b, ctx);
    if (b.bid_strategy && b.daily_budget_usd === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["bid_strategy"], message: "a campaign bid strategy needs a campaign daily budget" });
    }
  });
export type CreateCampaignBody = z.infer<typeof createCampaignBodySchema>;

export const updateCampaignBodySchema = z
  .object({
    campaign_id: metaId,
    new_name: z.string().trim().min(1).max(200).optional(),
    spend_cap_usd: z.number().positive().nullable().optional(),
    expected_current_spend_cap_usd: z.number().positive().nullable().optional(),
    bid_strategy: metaBidStrategySchema.optional(),
    expected_current_bid_strategy: z.string().trim().min(1).nullable().optional(),
    special_ad_categories: z.array(metaSpecialAdCategorySchema).max(4).optional(),
    special_ad_category_country: countryCodes.optional(),
    currency: bodyCurrency,
    name: displayName,
    about: displayAbout,
    rationale: rationaleBody(),
    origin: launchOrigin,
  })
  .superRefine((b, ctx) => {
    const fields = [b.new_name, b.spend_cap_usd, b.bid_strategy, b.special_ad_categories];
    if (fields.every((f) => f === undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "change at least one of new_name, spend_cap_usd, bid_strategy, special_ad_categories" });
    }
    if (b.spend_cap_usd !== undefined && b.expected_current_spend_cap_usd === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["expected_current_spend_cap_usd"], message: "a spend cap change needs the current cap (null for none)" });
    }
    if (b.bid_strategy !== undefined && b.expected_current_bid_strategy === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["expected_current_bid_strategy"], message: "a bid strategy change needs the current one (null for none)" });
    }
    if (b.special_ad_categories !== undefined) checkSpecialCategories(b, ctx);
  });
export type UpdateCampaignBody = z.infer<typeof updateCampaignBodySchema>;

export const deleteCampaignBodySchema = z.object({
  campaign_id: metaId,
  name: displayName,
  about: displayAbout,
  rationale: rationaleBody(),
  origin: launchOrigin,
});
export type DeleteCampaignBody = z.infer<typeof deleteCampaignBodySchema>;

export const adSetTargetingPatchSchema = z
  .object({
    age_min: z.number().int().min(13).max(65).optional(),
    age_max: z.number().int().min(13).max(65).optional(),
    genders: z.array(z.union([z.literal(1), z.literal(2)])).max(2).optional(),
    flexible_spec: z.array(z.record(z.string(), z.unknown())).max(10).optional(),
    custom_audiences: z.array(z.object({ id: metaId })).max(50).optional(),
    excluded_custom_audiences: z.array(z.object({ id: metaId })).max(50).optional(),
    publisher_platforms: z.array(z.enum(["facebook", "instagram", "messenger", "audience_network", "threads"])).max(5).optional(),
    facebook_positions: z.array(z.string().trim().min(1)).max(20).optional(),
    instagram_positions: z.array(z.string().trim().min(1)).max(20).optional(),
  })
  .strict()
  .refine((t) => Object.keys(t).length > 0, "the targeting change is empty")
  .refine((t) => checkTargetingPlacements(t) === null, "Meta no longer accepts the Facebook video feeds placement (video_feeds); drop it from facebook_positions")
  .refine((t) => t.age_min === undefined || t.age_max === undefined || t.age_min <= t.age_max, "age_min is above age_max");
export type AdSetTargetingPatch = z.infer<typeof adSetTargetingPatchSchema>;

export function normalizeMetaTime(t: string): string {
  return t.trim().replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
}

const isoTime = z.string().transform(normalizeMetaTime).pipe(z.string().datetime({ offset: true }));

export const updateAdSetBodySchema = z
  .object({
    ad_set_id: metaId,
    new_name: z.string().trim().min(1).max(200).optional(),
    end_time: isoTime.optional(),
    expected_current_end_time: isoTime.nullable().optional(),
    bid_strategy: metaBidStrategySchema.optional(),
    expected_current_bid_strategy: z.string().trim().min(1).nullable().optional(),
    bid_amount_usd: z.number().positive().optional(),
    expected_current_bid_amount_usd: z.number().positive().nullable().optional(),
    targeting_patch: adSetTargetingPatchSchema.optional(),
    expected_targeting_fingerprint: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    currency: bodyCurrency,
    name: displayName,
    about: displayAbout,
    rationale: rationaleBody(),
    origin: launchOrigin,
  })
  .superRefine((b, ctx) => {
    if ([b.new_name, b.end_time, b.bid_strategy, b.bid_amount_usd, b.targeting_patch].every((f) => f === undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "change at least one of new_name, end_time, bid_strategy, bid_amount_usd, targeting_patch" });
    }
    const pairs: Array<[unknown, unknown, string]> = [
      [b.end_time, b.expected_current_end_time, "expected_current_end_time"],
      [b.bid_strategy, b.expected_current_bid_strategy, "expected_current_bid_strategy"],
      [b.bid_amount_usd, b.expected_current_bid_amount_usd, "expected_current_bid_amount_usd"],
      [b.targeting_patch, b.expected_targeting_fingerprint, "expected_targeting_fingerprint"],
    ];
    for (const [changed, expected, key] of pairs) {
      if (changed !== undefined && expected === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `${key} is required with that change` });
      }
    }
    if (b.targeting_patch) {
      const interestErr = checkTargetingInterestIds(b.targeting_patch as Record<string, unknown>);
      if (interestErr) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["targeting_patch"], message: interestErr });
    }
  });
export type UpdateAdSetBody = z.infer<typeof updateAdSetBodySchema>;

export const updateAdBodySchema = z
  .object({
    ad_id: metaId,
    new_name: z.string().trim().min(1).max(200).optional(),
    creative_id: metaId.optional(),
    expected_current_creative_id: metaId.nullable().optional(),
    status: z.enum(["ACTIVE", "PAUSED"]).optional(),
    name: displayName,
    about: displayAbout,
    rationale: rationaleBody(),
    origin: launchOrigin,
  })
  .superRefine((b, ctx) => {
    if ([b.new_name, b.creative_id, b.status].every((f) => f === undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "change at least one of new_name, creative_id, status" });
    }
    if (b.creative_id !== undefined && b.expected_current_creative_id === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["expected_current_creative_id"], message: "a creative swap needs the current creative" });
    }
  });
export type UpdateAdBody = z.infer<typeof updateAdBodySchema>;

export const duplicateAdBodySchema = z.object({
  source_ad_id: metaId,
  ad_set_id: metaId,
  name: displayName,
  about: displayAbout,
  rationale: rationaleBody(),
  origin: launchOrigin,
});
export type DuplicateAdBody = z.infer<typeof duplicateAdBodySchema>;

export const duplicateAdSetBodySchema = z.object({
  source_ad_set_id: metaId,
  daily_budget_usd: z.number().positive(),
  places: copyPlaces,
  currency: bodyCurrency,
  name: displayName,
  about: displayAbout,
  rationale: rationaleBody(),
  origin: launchOrigin,
});
export type DuplicateAdSetBody = z.infer<typeof duplicateAdSetBodySchema>;

export const duplicateCampaignBodySchema = z.object({
  source_campaign_id: metaId,
  daily_budget_usd: z.number().positive(),
  places: copyPlaces,
  currency: bodyCurrency,
  name: displayName,
  about: displayAbout,
  rationale: rationaleBody(),
  origin: launchOrigin,
});
export type DuplicateCampaignBody = z.infer<typeof duplicateCampaignBodySchema>;

export function websiteAudienceName(retention_days: 30 | 90): string {
  return `Website visitors, ${retention_days} days`;
}

export const createCustomAudienceBodySchema = z.object({
  kind: z.literal("website_visitors"),
  retention_days: z.union([z.literal(30), z.literal(90)]),
  pixel_id: metaId.optional(),
  name: displayName,
  about: displayAbout,
  rationale: rationaleBody(),
  origin: launchOrigin,
});
export type CreateCustomAudienceBody = z.infer<typeof createCustomAudienceBodySchema>;

const httpsUrl = z
  .string()
  .trim()
  .url()
  .refine((u) => /^https:\/\//i.test(u), "must be an https URL");

const landingUrl = httpsUrl.refine((u) => {
  try {
    return !new URL(u).searchParams.has("zavi_launch");
  } catch {
    return true;
  }
}, "remove zavi_launch from the link; Zavi sets it on each ad");

export const launchCtaSchema = z.enum([
  "LEARN_MORE",
  "SHOP_NOW",
  "SIGN_UP",
  "BOOK_TRAVEL",
  "GET_OFFER",
  "CONTACT_US",
  "SUBSCRIBE",
  "APPLY_NOW",
  "DOWNLOAD",
  "ORDER_NOW",
  "GET_QUOTE",
]);

export type LaunchCtaValue = z.infer<typeof launchCtaSchema>;

const CTA_EQUIVALENT: Readonly<Record<string, LaunchCtaValue>> = {
  SEE_DETAILS: "LEARN_MORE",
  GET_DETAILS: "LEARN_MORE",
  SEE_MORE: "LEARN_MORE",
  FIND_OUT_MORE: "LEARN_MORE",
  VISIT_WEBSITE: "LEARN_MORE",
  OPEN_LINK: "LEARN_MORE",
  WATCH_MORE: "LEARN_MORE",
  WATCH_VIDEO: "LEARN_MORE",
  GET_STARTED: "SIGN_UP",
  BOOK_NOW: "BOOK_TRAVEL",
  MAKE_AN_APPOINTMENT: "BOOK_TRAVEL",
  BOOK_A_CONSULTATION: "BOOK_TRAVEL",
  BUY_NOW: "SHOP_NOW",
  BUY: "SHOP_NOW",
  SEE_SHOP: "SHOP_NOW",
  BROWSE_SHOP: "SHOP_NOW",
  VIEW_PRODUCT: "SHOP_NOW",
  ADD_TO_CART: "SHOP_NOW",
  START_ORDER: "ORDER_NOW",
  GET_A_QUOTE: "GET_QUOTE",
  GET_OFFER_VIEW: "GET_OFFER",
  GET_PROMOTIONS: "GET_OFFER",
  CONTACT: "CONTACT_US",
  GET_IN_TOUCH: "CONTACT_US",
  INQUIRE_NOW: "CONTACT_US",
  ASK_ABOUT_SERVICES: "CONTACT_US",
  ASK_FOR_MORE_INFO: "CONTACT_US",
  INSTALL_APP: "DOWNLOAD",
  INSTALL_MOBILE_APP: "DOWNLOAD",
  MOBILE_DOWNLOAD: "DOWNLOAD",
};

export function normalizeLaunchCta(raw: unknown): LaunchCtaValue | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim().toUpperCase();
  if (!t || t === "NO_BUTTON") return null;
  const direct = launchCtaSchema.safeParse(t);
  if (direct.success) return direct.data;
  return CTA_EQUIVALENT[t] ?? "LEARN_MORE";
}

const launchAdCopyShape = {
  image_url: httpsUrl.optional(),
  primary_text: z.string().trim().min(1).max(2000),
  headline: z.string().trim().min(1).max(255),
  link_url: landingUrl,
  cta: launchCtaSchema.optional(),
};
export const launchAdCopySchema = z.object(launchAdCopyShape);

export const createAdBodySchema = z
  .object({
    ad_set_id: metaId,
    ...launchAdCopyShape,
    video_asset_id: metaId.optional(),
    source: z.enum(["zavi_generated", "library", "copy"]),
    source_ad_id: metaId.optional(),
    name: displayName,
    about: displayAbout,
    rationale: rationaleBody(),
    origin: launchOrigin,
  })
  .superRefine((b, ctx) => checkAdMedia(b, ctx, []));
export type CreateAdBody = z.infer<typeof createAdBodySchema>;

function checkAdMedia(
  b: { image_url?: string; video_asset_id?: string; source: string; source_ad_id?: string },
  ctx: z.RefinementCtx,
  at: string[],
): void {
  const media = (b.image_url ? 1 : 0) + (b.video_asset_id ? 1 : 0);
  if (media > 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...at, "image_url"], message: "give image_url or video_asset_id, not both" });
  }
  if (media === 0 && !(b.source === "copy" && b.source_ad_id)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...at, "image_url"], message: "an ad needs image_url or video_asset_id (or source 'copy' with source_ad_id)" });
  }
  if (b.source === "copy" && !b.source_ad_id) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...at, "source_ad_id"], message: "source 'copy' needs source_ad_id" });
  }
}

function namesAPlace(targeting: Record<string, unknown>): boolean {
  const geo = targeting.geo_locations as Record<string, unknown> | undefined;
  if (!geo || typeof geo !== "object") return false;
  return ["countries", "regions", "cities", "zips"].some((k) => Array.isArray(geo[k]) && (geo[k] as unknown[]).length > 0);
}

export const launchCampaignBodySchema = z
  .object({
    campaign: z.object({
      name: z.string().trim().min(1).max(200),
      objective: metaCampaignObjectiveSchema,
      special_ad_categories: z.array(metaSpecialAdCategorySchema).max(4).default([]),
      special_ad_category_country: countryCodes.optional(),
      daily_budget_usd: z.number().positive(),
      bid_strategy: metaBidStrategySchema.default("LOWEST_COST_WITHOUT_CAP"),
    }),
    ad_set: z.object({
      name: z.string().trim().min(1).max(200).optional(),
      optimization_goal: z.string().trim().min(1),
      billing_event: z.string().trim().min(1),
      targeting: z.record(z.string(), z.unknown()),
      promoted_object: promotedObjectSchema.optional(),
      bid_amount_usd: z.number().positive().optional(),
      end_time: isoTime.optional(),
    }),
    ad: z.object({
      ...launchAdCopyShape,
      video_asset_id: metaId.optional(),
      source: z.enum(["zavi_generated", "library", "copy"]),
      source_ad_id: metaId.optional(),
      name: displayName,
    }),
    switch_on: z.boolean().optional(),
    currency: bodyCurrency,
    about: displayAbout,
    rationale: rationaleBody(),
    origin: launchOrigin,
  })
  .superRefine((b, ctx) => {
    checkSpecialCategories(b.campaign, ctx);
    if (b.switch_on === false && b.origin !== "user_initiated_ledger") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["switch_on"], message: "only the founder's campaign editor builds a launch paused" });
    }
    const bidErr = checkNewAdSetBid(b.campaign.bid_strategy, b.ad_set.bid_amount_usd);
    if (bidErr) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["campaign", "bid_strategy"], message: bidErr });
    const goalErr = checkPromotedObjectForGoal(b.ad_set.optimization_goal, b.ad_set.promoted_object);
    if (goalErr) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["ad_set", "promoted_object"], message: goalErr });
    const interestErr = checkTargetingInterestIds(b.ad_set.targeting);
    if (interestErr) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["ad_set", "targeting"], message: interestErr });
    const geoErr = checkTargetingGeo(b.ad_set.targeting);
    if (geoErr) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["ad_set", "targeting"], message: geoErr });
    const placementErr = checkTargetingPlacements(b.ad_set.targeting);
    if (placementErr) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["ad_set", "targeting"], message: placementErr });
    if (!namesAPlace(b.ad_set.targeting)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["ad_set", "targeting"], message: "a launch needs at least one place to show in (targeting.geo_locations, or `locations`)" });
    }
    checkAdMedia(b.ad, ctx, ["ad"]);
  });
export type LaunchCampaignBody = z.infer<typeof launchCampaignBodySchema>;

export const createCreativeBodySchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    primary_text: z.string().trim().min(1).max(2000),
    headline: z.string().trim().min(1).max(255),
    link_url: landingUrl,
    cta: launchCtaSchema.optional(),
    image_url: httpsUrl.optional(),
    image_hash: z.string().trim().regex(/^[0-9a-f]{32}$/i, "must be a Meta image hash").optional(),
    video_asset_id: metaId.optional(),
    source_ad_id: metaId.optional(),
    about: displayAbout,
    rationale: rationaleBody(),
    origin: launchOrigin,
  })
  .superRefine((b, ctx) => {
    const media = [b.image_url, b.image_hash, b.video_asset_id, b.source_ad_id].filter(Boolean).length;
    if (media !== 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["image_url"], message: "give exactly one of image_url, image_hash, video_asset_id, source_ad_id" });
    }
  });
export type CreateCreativeBody = z.infer<typeof createCreativeBodySchema>;

export const updateCreativeBodySchema = z.object({
  creative_id: metaId,
  new_name: z.string().trim().min(1).max(200),
  name: displayName,
  about: displayAbout,
  rationale: rationaleBody(),
  origin: launchOrigin,
});
export type UpdateCreativeBody = z.infer<typeof updateCreativeBodySchema>;

export const uploadAssetBodySchema = z.object({
  kind: z.enum(["image", "video"]),
  url: httpsUrl,
  name: z.string().trim().min(1).max(200),
  about: displayAbout,
  rationale: rationaleBody(),
  origin: launchOrigin,
});
export type UploadAssetBody = z.infer<typeof uploadAssetBodySchema>;

export const createLookalikeAudienceBodySchema = z.object({
  origin_audience_id: metaId,
  country: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, "must be a 2-letter country code"),
  ratio: z.number().min(0.01).max(0.1),
  name: displayName,
  about: displayAbout,
  rationale: rationaleBody(),
  origin: launchOrigin,
});
export type CreateLookalikeAudienceBody = z.infer<typeof createLookalikeAudienceBodySchema>;

export const metaConversionEventSchema = z.enum([
  "PURCHASE",
  "LEAD",
  "COMPLETE_REGISTRATION",
  "ADD_TO_CART",
  "INITIATED_CHECKOUT",
  "ADD_PAYMENT_INFO",
  "CONTACT",
  "SUBMIT_APPLICATION",
  "SCHEDULE",
  "START_TRIAL",
  "SUBSCRIBE",
  "SEARCH",
  "CONTENT_VIEW",
  "OTHER",
]);

export const createCustomConversionBodySchema = z.object({
  name: z.string().trim().min(1).max(200),
  pixel_id: metaId,
  custom_event_type: metaConversionEventSchema,
  url_contains: z.string().trim().min(2).max(300),
  about: displayAbout,
  rationale: rationaleBody(),
  origin: launchOrigin,
});
export type CreateCustomConversionBody = z.infer<typeof createCustomConversionBodySchema>;

export const leadFormQuestionSchema = z.union([
  z.object({
    type: z.enum(["EMAIL", "FULL_NAME", "FIRST_NAME", "LAST_NAME", "PHONE", "CITY", "STATE", "ZIP", "COUNTRY", "COMPANY_NAME", "JOB_TITLE", "WORK_EMAIL"]),
  }),
  z.object({
    type: z.literal("CUSTOM"),
    key: z.string().trim().regex(/^[a-z0-9_]{1,40}$/, "a custom question key is lowercase letters, digits and _"),
    label: z.string().trim().min(1).max(200),
  }),
]);

export const createLeadFormBodySchema = z.object({
  page_id: metaId,
  name: z.string().trim().min(1).max(200),
  questions: z.array(leadFormQuestionSchema).min(1).max(15),
  privacy_policy_url: httpsUrl,
  privacy_link_text: z.string().trim().min(1).max(70).optional(),
  follow_up_action_url: httpsUrl,
  page_name: displayName,
  about: displayAbout,
  rationale: rationaleBody(),
  origin: launchOrigin,
});
export type CreateLeadFormBody = z.infer<typeof createLeadFormBodySchema>;
