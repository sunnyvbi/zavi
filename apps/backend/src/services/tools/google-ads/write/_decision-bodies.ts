import { z } from "zod";
import { rationaleBody } from "@/services/tools/_shared/rationale";
import { CAP_REASONS } from "@/services/tools/meta-ads/write/_cap-evaluator";
import { VIDEO_AD_FORMATS, isYoutubeVideoId } from "./_video-formats";

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

const numericId = z.string().regex(/^[0-9]+$/, "must be a numeric Google Ads id");
const rationale = rationaleBody();
const origin = z.enum(["user_initiated_chat", "user_initiated_ledger", "agent"]).optional();
const url = z.string().url().max(2048);
const youtubeVideoId = z
  .string()
  .refine(isYoutubeVideoId, "must be an 11-character YouTube video id");

export const updateCampaignBudgetBodySchema = z.object({
  campaign_id: z.string().min(1),
  daily_budget_usd: z.number().positive(),
  expected_current_daily_budget_usd: z.number().nonnegative(),
  rationale,
  over_cap: z.boolean(),
  cap_reason: z.enum(CAP_REASONS).optional(),
  name: displayName,
  about: displayAbout,
  origin,
});

export type UpdateCampaignBudgetBody = z.infer<typeof updateCampaignBudgetBodySchema>;

export const STATUS_LEVELS = ["campaign", "ad_group", "ad"] as const;
export type StatusLevel = (typeof STATUS_LEVELS)[number];

export const googleSetStatusBodySchema = z
  .object({
    campaign_id: z.string().min(1),
    level: z.enum(STATUS_LEVELS).default("campaign"),
    ad_group_id: numericId.optional(),
    ad_id: numericId.optional(),
    status: z.enum(["ENABLED", "PAUSED"]),
    rationale,
    over_cap: z.boolean(),
    expected_current_status: z.enum(["ENABLED", "PAUSED"]).optional(),
    name: displayName,
    about: displayAbout,
    origin,
  })
  .superRefine((b, ctx) => {
    if (b.level !== "campaign" && !b.ad_group_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ad_group_id"],
        message: `ad_group_id is required when level is ${b.level}`,
      });
    }
    if (b.level === "ad" && !b.ad_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ad_id"],
        message: "ad_id is required when level is ad",
      });
    }
  });

export type GoogleSetStatusBody = z.infer<typeof googleSetStatusBodySchema>;

export const CAMPAIGN_CHANNEL_TYPES = [
  "SEARCH",
  "DISPLAY",
  "VIDEO",
  "DEMAND_GEN",
  "PERFORMANCE_MAX",
] as const;
export type CampaignChannelType = (typeof CAMPAIGN_CHANNEL_TYPES)[number];

export const biddingSchema = z.discriminatedUnion("strategy", [
  z.strictObject({ strategy: z.literal("MANUAL_CPC"), enhanced_cpc: z.boolean().default(false) }),
  z.strictObject({ strategy: z.literal("MANUAL_CPV") }),
  z.strictObject({ strategy: z.literal("MANUAL_CPM") }),
  z.strictObject({ strategy: z.literal("TARGET_CPM") }),
  z.strictObject({
    strategy: z.literal("TARGET_SPEND"),
    cpc_bid_ceiling_usd: z
      .number()
      .positive()
      .optional()
      .describe("Max cost per click in USD for Maximize clicks; set it only from a real cost estimate, else omit."),
  }),
  z.strictObject({
    strategy: z.literal("MAXIMIZE_CONVERSIONS"),
    target_cpa_usd: z.number().positive().optional(),
  }),
  z.strictObject({
    strategy: z.literal("MAXIMIZE_CONVERSION_VALUE"),
    target_roas: z.number().positive().optional(),
  }),
]);
export type BiddingSpec = z.infer<typeof biddingSchema>;

const ALLOWED_BIDDING_BY_CHANNEL: Record<CampaignChannelType, ReadonlySet<BiddingSpec["strategy"]>> = {
  SEARCH: new Set(["MANUAL_CPC", "TARGET_SPEND", "MAXIMIZE_CONVERSIONS", "MAXIMIZE_CONVERSION_VALUE"]),
  DISPLAY: new Set(["MANUAL_CPC", "MANUAL_CPM", "TARGET_SPEND", "MAXIMIZE_CONVERSIONS", "MAXIMIZE_CONVERSION_VALUE"]),
  VIDEO: new Set(["MANUAL_CPV", "MANUAL_CPM", "TARGET_CPM", "MAXIMIZE_CONVERSIONS", "MAXIMIZE_CONVERSION_VALUE"]),
  DEMAND_GEN: new Set(["MAXIMIZE_CONVERSIONS", "MAXIMIZE_CONVERSION_VALUE"]),
  PERFORMANCE_MAX: new Set(["MAXIMIZE_CONVERSIONS", "MAXIMIZE_CONVERSION_VALUE"]),
};

export const networkSettingsSchema = z.object({
  google_search: z.boolean().default(true),
  search_network: z.boolean().default(false),
  content_network: z.boolean().default(false),
  partner_search_network: z.boolean().default(false),
});
export type NetworkSettings = z.infer<typeof networkSettingsSchema>;

export const KEYWORD_MATCH_TYPES = ["EXACT", "PHRASE", "BROAD"] as const;
export const keywordSchema = z.object({
  text: z.string().trim().min(1).max(80),
  match_type: z.enum(KEYWORD_MATCH_TYPES),
});
export type KeywordSpec = z.infer<typeof keywordSchema>;

const textList = (min: number, max: number, len: number) =>
  z.array(z.string().trim().min(1).max(len)).min(min).max(max);

export const adSpecSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("responsive_search"),
    final_urls: z.array(url).min(1).max(5),
    headlines: textList(3, 15, 30),
    descriptions: textList(2, 4, 90),
    path1: z.string().trim().max(15).optional(),
    path2: z.string().trim().max(15).optional(),
  }),
]);
export type AdSpec = z.infer<typeof adSpecSchema>;

export const AD_GROUP_TYPES = ["SEARCH_STANDARD", "DISPLAY_STANDARD"] as const;
export type AdGroupType = (typeof AD_GROUP_TYPES)[number];

const AD_KIND_TO_AD_GROUP_TYPES: Record<AdSpec["kind"], ReadonlySet<AdGroupType>> = {
  responsive_search: new Set(["SEARCH_STANDARD"]),
};

const AD_GROUP_TYPES_BY_CHANNEL: Record<CampaignChannelType, ReadonlySet<AdGroupType>> = {
  SEARCH: new Set(["SEARCH_STANDARD"]),
  DISPLAY: new Set(["DISPLAY_STANDARD"]),
  VIDEO: new Set([]),
  DEMAND_GEN: new Set([]),
  PERFORMANCE_MAX: new Set([]),
};

export function checkAdKindForAdGroupType(kind: AdSpec["kind"], type: string): string | null {
  const allowed = AD_KIND_TO_AD_GROUP_TYPES[kind];
  if (allowed.has(type as AdGroupType)) return null;
  return `an ad of kind ${kind} needs an ad group of type ${[...allowed].join(" or ")}; got ${type || "unknown"}`;
}

export function checkAdGroupTypeForChannel(type: AdGroupType, channel: string): string | null {
  const allowed = AD_GROUP_TYPES_BY_CHANNEL[channel as CampaignChannelType];
  if (!allowed) return `unknown campaign channel type ${channel || "(empty)"}`;
  if (allowed.size === 0) {
    return `${channel} campaigns do not take a manually created ad group on this path`;
  }
  if (!allowed.has(type)) {
    return `ad group type ${type} is not valid inside a ${channel} campaign`;
  }
  return null;
}

export function checkBiddingForChannel(bidding: BiddingSpec, channel: CampaignChannelType): string | null {
  if (ALLOWED_BIDDING_BY_CHANNEL[channel].has(bidding.strategy)) return null;
  return `bidding strategy ${bidding.strategy} is not valid for a ${channel} campaign`;
}

const bidsSchema = {
  cpc_bid_usd: z.number().positive().optional(),
  cpv_bid_usd: z.number().positive().optional(),
  cpm_bid_usd: z.number().positive().optional(),
};

export const adGroupSpecSchema = z.object({
  name: z.string().trim().min(1).max(255),
  type: z.enum(AD_GROUP_TYPES),
  ...bidsSchema,
  keywords: z.array(keywordSchema).max(200).default([]),
  ads: z.array(adSpecSchema).max(3).default([]),
});
export type AdGroupSpec = z.infer<typeof adGroupSpecSchema>;

function adGroupIssues(spec: AdGroupSpec, ctx: z.RefinementCtx, path: (string | number)[]): void {
  spec.ads.forEach((ad, i) => {
    const err = checkAdKindForAdGroupType(ad.kind, spec.type);
    if (err) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path, "ads", i], message: err });
    }
  });
  if (spec.keywords.length > 0 && spec.type !== "SEARCH_STANDARD") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [...path, "keywords"],
      message: "keywords can only be attached to a SEARCH_STANDARD ad group",
    });
  }
}

export const logoRefSchema = z.object({
  storage_path: z.string().regex(/^[0-9a-f-]{36}\/logos\/[0-9a-f]{64}\.(png|jpg)$/, "must be a stored logo path"),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, "must be a sha256 hex digest"),
  mime: z.enum(["image/png", "image/jpeg"]),
  width: z.number().int().min(128),
  height: z.number().int().min(128),
});
export type LogoRefBody = z.infer<typeof logoRefSchema>;

export const demandGenVideoAdSchema = z.object({
  final_urls: z.array(url).min(1).max(5),
  youtube_video_ids: z.array(youtubeVideoId).min(1).max(5),
  headlines: textList(1, 5, 40),
  long_headlines: textList(1, 5, 90),
  descriptions: textList(1, 5, 90),
  business_name: z.string().trim().min(1).max(25),
  logo: logoRefSchema,
});
export type DemandGenVideoAdSpec = z.infer<typeof demandGenVideoAdSchema>;

export const demandGenAdGroupSpecSchema = z.object({
  name: z.string().trim().min(1).max(255),
  ad: demandGenVideoAdSchema,
});
export type DemandGenAdGroupSpec = z.infer<typeof demandGenAdGroupSpecSchema>;

export const adImageRefSchema = z.object({
  storage_path: z.string().regex(/^[0-9a-f-]{36}\/images\/[0-9a-f]{64}\.(png|jpg)$/, "must be a stored ad image path"),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, "must be a sha256 hex digest"),
  mime: z.enum(["image/png", "image/jpeg"]),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type AdImageRefBody = z.infer<typeof adImageRefSchema>;

export const pmaxAssetGroupSpecSchema = z.object({
  name: z.string().trim().min(1).max(255),
  final_urls: z.array(url).min(1).max(5),
  headlines: textList(3, 15, 30),
  long_headlines: textList(1, 5, 90),
  descriptions: textList(2, 5, 90),
  business_name: z.string().trim().min(1).max(25),
  landscape_images: z.array(adImageRefSchema).min(1).max(5),
  square_images: z.array(adImageRefSchema).min(1).max(5),
  portrait_images: z.array(adImageRefSchema).max(5).default([]),
  logo: logoRefSchema,
});
export type PmaxAssetGroupSpec = z.infer<typeof pmaxAssetGroupSpecSchema>;

export const createCampaignBodySchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    channel_type: z.enum(CAMPAIGN_CHANNEL_TYPES),
    daily_budget_usd: z.number().positive(),
    bidding: biddingSchema,
    bidding_replaced: biddingSchema.optional(),
    network: networkSettingsSchema.optional(),
    location_ids: z.array(z.number().int().positive()).max(50).default([]),
    excluded_location_ids: z.array(z.number().int().positive()).max(50).default([]),
    language_ids: z.array(z.number().int().positive()).max(20).default([]),
    negative_keywords: z.array(keywordSchema).max(200).default([]),
    ad_group: adGroupSpecSchema.optional(),
    demand_gen_ad_group: demandGenAdGroupSpecSchema.optional(),
    pmax_asset_group: pmaxAssetGroupSpecSchema.optional(),
    end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    rationale,
    about: displayAbout,
    origin,
  })
  .superRefine((b, ctx) => {
    if (b.channel_type === "VIDEO") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["channel_type"], message: "Google's API cannot create VIDEO campaigns" });
    }
    const bidErr = checkBiddingForChannel(b.bidding, b.channel_type);
    if (bidErr) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["bidding"], message: bidErr });
    if (b.network && b.channel_type !== "SEARCH") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["network"],
        message: "network settings apply to SEARCH campaigns only",
      });
    }
    const both = b.excluded_location_ids.filter((id) => b.location_ids.includes(id));
    if (both.length > 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["excluded_location_ids"], message: `a place cannot be both targeted and excluded (${both.join(", ")})` });
    }
    if (b.channel_type === "DEMAND_GEN") {
      if (b.excluded_location_ids.length > 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["excluded_location_ids"], message: "excluded places are not offered on a DEMAND_GEN campaign" });
      }
      if (!b.demand_gen_ad_group) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["demand_gen_ad_group"],
          message: "a DEMAND_GEN campaign needs its demand_gen_ad_group (use google_ads_propose_video_campaign)",
        });
      }
      if (b.negative_keywords.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["negative_keywords"],
          message: "campaign negative keywords are not offered on a DEMAND_GEN campaign",
        });
      }
    } else if (b.demand_gen_ad_group) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["demand_gen_ad_group"],
        message: "demand_gen_ad_group belongs only to a DEMAND_GEN campaign",
      });
    }
    if (b.pmax_asset_group && b.channel_type !== "PERFORMANCE_MAX") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["pmax_asset_group"],
        message: "pmax_asset_group belongs only to a PERFORMANCE_MAX campaign",
      });
    }
    if (b.ad_group) {
      const typeErr = checkAdGroupTypeForChannel(b.ad_group.type, b.channel_type);
      if (typeErr) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["ad_group", "type"], message: typeErr });
      adGroupIssues(b.ad_group, ctx, ["ad_group"]);
    }
  });
export type CreateCampaignBody = z.infer<typeof createCampaignBodySchema>;

export const updateCampaignBodySchema = z
  .object({
    campaign_id: numericId,
    new_name: z.string().trim().min(1).max(255).optional(),
    target_cpa_usd: z.number().positive().optional(),
    target_roas: z.number().positive().optional(),
    network: networkSettingsSchema.optional(),
    rationale,
    name: displayName,
    about: displayAbout,
    origin,
  })
  .refine(
    (b) =>
      b.new_name !== undefined ||
      b.target_cpa_usd !== undefined ||
      b.target_roas !== undefined ||
      b.network !== undefined,
    { message: "an update must change at least one field" },
  );
export type UpdateCampaignBody = z.infer<typeof updateCampaignBodySchema>;

export const createAdGroupBodySchema = adGroupSpecSchema
  .extend({
    campaign_id: numericId,
    rationale,
    about: displayAbout,
    origin,
  })
  .superRefine((b, ctx) => adGroupIssues(b, ctx, []));
export type CreateAdGroupBody = z.infer<typeof createAdGroupBodySchema>;

export const updateAdGroupBodySchema = z
  .object({
    ad_group_id: numericId,
    new_name: z.string().trim().min(1).max(255).optional(),
    ...bidsSchema,
    rationale,
    name: displayName,
    about: displayAbout,
    origin,
  })
  .refine(
    (b) =>
      b.new_name !== undefined ||
      b.cpc_bid_usd !== undefined ||
      b.cpv_bid_usd !== undefined ||
      b.cpm_bid_usd !== undefined,
    { message: "an update must change at least one field" },
  );
export type UpdateAdGroupBody = z.infer<typeof updateAdGroupBodySchema>;

export const createAdBodySchema = z.object({
  ad_group_id: numericId,
  ad: adSpecSchema,
  rationale,
  name: displayName,
  about: displayAbout,
  origin,
});
export type CreateAdBody = z.infer<typeof createAdBodySchema>;

export const addKeywordsBodySchema = z
  .object({
    level: z.enum(["ad_group", "campaign"]),
    ad_group_id: numericId.optional(),
    campaign_id: numericId.optional(),
    negative: z.boolean(),
    keywords: z.array(keywordSchema).min(1).max(200),
    rationale,
    name: displayName,
    about: displayAbout,
    origin,
  })
  .superRefine((b, ctx) => {
    if (b.level === "ad_group" && !b.ad_group_id) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["ad_group_id"], message: "ad_group_id is required at ad_group level" });
    }
    if (b.level === "campaign" && !b.campaign_id) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["campaign_id"], message: "campaign_id is required at campaign level" });
    }
    if (b.level === "campaign" && !b.negative) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["negative"], message: "campaign-level keywords must be negative; positive keywords live in an ad group" });
    }
  });
export type AddKeywordsBody = z.infer<typeof addKeywordsBodySchema>;

const removeCommon = { rationale, name: displayName, about: displayAbout, origin };

export const removeResourceBodySchema = z.discriminatedUnion("level", [
  z.object({ level: z.literal("campaign"), campaign_id: numericId, ...removeCommon }),
  z.object({ level: z.literal("ad_group"), ad_group_id: numericId, ...removeCommon }),
  z.object({ level: z.literal("ad"), ad_group_id: numericId, ad_id: numericId, ...removeCommon }),
  z.object({
    level: z.literal("keyword"),
    scope: z.enum(["ad_group", "campaign"]),
    parent_id: numericId,
    criterion_id: numericId,
    keyword_text: z.string().min(1).max(80).optional(),
    criterion_negative: z.boolean().optional(),
    ...removeCommon,
  }),
]);
export type RemoveResourceBody = z.infer<typeof removeResourceBodySchema>;

export const videoFormatSchema = z.enum(VIDEO_AD_FORMATS);
