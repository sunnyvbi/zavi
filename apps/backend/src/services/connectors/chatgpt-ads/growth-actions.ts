import { z } from "zod";
import {
  campaignCreate,
  groupCreate,
  adCreative,
  groupBidding,
  CHATGPT_MIN_DAILY_MICROS,
  CHATGPT_MIN_DAILY_USD,
} from "./workspace";
export const CHATGPT_CREATE = "chatgpt_ads.create_and_launch";
export const CHATGPT_WALLET_SHORT_WORDS = "the prepaid ChatGPT wallet cannot cover this campaign schedule; add balance or choose a smaller experiment";
export const CHATGPT_BUDGET = "chatgpt_ads.update_campaign_budget";
export const CHATGPT_STATUS = "chatgpt_ads.set_status";
export const CHATGPT_GROWTH_CLASSES = new Set([
  CHATGPT_CREATE,
  CHATGPT_BUDGET,
  CHATGPT_STATUS,
]);
export function growthCampaignBudget(c: { daily_budget_micros?: number | null; lifetime_budget_micros?: number | null }):
  | { lifetime_spend_limit_micros: number }
  | { daily_spend_limit_micros: number | undefined } {
  return c.lifetime_budget_micros != null
    ? { lifetime_spend_limit_micros: c.lifetime_budget_micros }
    : { daily_spend_limit_micros: c.daily_budget_micros ?? undefined };
}
const explanation = {
  rationale: z.string().trim().min(10).max(4000),
  summary: z.string().trim().min(3).max(600),
};
const growthCampaign = z
  .object({
    ...campaignCreate.shape,
    daily_budget_micros: z
      .number()
      .int()
      .min(CHATGPT_MIN_DAILY_MICROS)
      .max(999_999_000_000)
      .optional(),
    lifetime_budget_micros: z.number().int().min(1_000_000).max(999_999_000_000).optional(),
    start_time: z.number().int().min(946684800).max(4102444800),
    end_time: z.number().int().min(946684800).max(4102444800),
  })
  .strict();
const growthAds = z
  .array(adCreative.omit({ ad_group_id: true }))
  .min(1)
  .max(2);
export const growthBundleInput = z
  .object({
    ...explanation,
    campaign: growthCampaign.partial({ daily_budget_micros: true, lifetime_budget_micros: true, start_time: true, end_time: true }),
    group: groupCreate,
    ads: growthAds,
  })
  .strict();
export const growthBundle = z
  .object({
    ...explanation,
    campaign: growthCampaign,
    group: groupCreate,
    ads: growthAds,
  })
  .strict()
  .superRefine((v, ctx) => {
    const campaign = campaignCreate.safeParse(v.campaign);
    if (!campaign.success)
      for (const issue of campaign.error.issues)
        ctx.addIssue({ ...issue, path: ["campaign", ...issue.path] });
    if (
      (v.campaign.daily_budget_micros == null) === (v.campaign.lifetime_budget_micros == null) ||
      !v.campaign.start_time ||
      !v.campaign.end_time ||
      v.campaign.end_time <= v.campaign.start_time ||
      v.campaign.end_time - v.campaign.start_time > 90 * 86400
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Autopilot needs one budget (daily or lifetime) and an explicit schedule of at most 90 days.",
      });
    if (
      !v.campaign.targeting?.locations?.countries?.length &&
      !v.campaign.targeting?.locations?.include?.length
    )
      ctx.addIssue({
        code: "custom",
        message: "Choose an explicit target location.",
      });
    try {
      groupBidding(
        {
          ...v.campaign,
          budget: growthCampaignBudget(v.campaign),
        },
        v.group,
      );
    } catch (e) {
      ctx.addIssue({
        code: "custom",
        path: ["group"],
        message: (e as Error).message,
      });
    }
    const product = v.campaign.mode === "product_feed";
    if (product && v.ads.length !== 1)
      ctx.addIssue({
        code: "custom",
        message: "One product template per group.",
      });
    for (const ad of v.ads) {
      if (product !== (ad.creative_type === "product_ad_template"))
        ctx.addIssue({
          code: "custom",
          message: "Creative type must match the campaign source.",
        });
      if (
        product
          ? !!(ad.image_url || ad.image_path || ad.image_artifact_id || ad.target_url)
          : [ad.image_url, ad.image_path, ad.image_artifact_id].filter(Boolean).length !== 1 || !ad.target_url
      )
        ctx.addIssue({
          code: "custom",
          message: product
            ? "Catalog templates use catalog images and destinations."
            : "Each chat card needs a destination and exactly one image.",
        });
    }
  });
const object = {
  campaign_id: z.union([
    z.string().regex(/^cmpn_[A-Za-z0-9]+$/),
    z.string().uuid(),
  ]),
  ...explanation,
};
export const growthBudgetInput = z
  .object({
    ...object,
    daily_budget_usd: z
      .number()
      .min(CHATGPT_MIN_DAILY_USD)
      .max(999999)
      .refine((v) => Number.isSafeInteger(v * 1e6)),
  })
  .strict();
export const growthStatusInput = z
  .object({ ...object, status: z.enum(["ACTIVE", "PAUSED"]) })
  .strict();
const stored = {
  name: z.string().min(1),
  origin: z.enum(["agent", "user_initiated_chat"]),
  expected_updated_at: z.number().int(),
};
export const growthCreateBody = z
  .object({
    bundle: growthBundle,
    name: stored.name,
    origin: stored.origin,
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .default("USD"),
    daily_budget_usd: z.number().positive().optional(),
    lifetime_budget_usd: z.number().positive().optional(),
    top_up_authorized: z.literal(false).optional(),
  })
  .strict()
  .refine((v) => v.daily_budget_usd == null || v.lifetime_budget_usd == null, "One budget: daily or lifetime.");
export const growthBudgetBody = growthBudgetInput
  .extend({
    ...stored,
    expected_current_daily_budget_usd: z.number().positive(),
  })
  .strict();
const statusPreview = z
  .object({
    daily_budget_usd: z.number().nullable(),
    lifetime_budget_usd: z.number().nullable(),
    start_time: z.number().nullable(),
    end_time: z.number().nullable(),
    groups_to_activate: z.number().int().min(0),
    ads_to_activate: z.number().int().min(0),
    currency: z.string().optional(),
  })
  .strict();
export const growthStatusBody = growthStatusInput
  .extend({
    ...stored,
    snapshot: z.string().regex(/^[0-9a-f]{64}$/),
    preview: statusPreview.optional(),
  })
  .strict();
export function parseGrowthAction(cls: string, body: unknown) {
  if (cls === CHATGPT_CREATE)
    return { kind: "create" as const, value: growthCreateBody.parse(body) };
  if (cls === CHATGPT_BUDGET)
    return { kind: "budget" as const, value: growthBudgetBody.parse(body) };
  if (cls === CHATGPT_STATUS)
    return { kind: "status" as const, value: growthStatusBody.parse(body) };
  throw new Error("Unknown ChatGPT Growth action");
}
