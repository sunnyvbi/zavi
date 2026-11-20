
import { z } from "zod";
import { rationaleInput } from "@/services/tools/_shared/rationale";
import type { ToolSpec, ToolContext } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import { isHumanAuthoredCommand } from "@/services/agents/untrusted-context";
import { isMetaAdsWriteEnabled } from "./_flag-check";
import {
  createAdBodySchema,
  createCustomAudienceBodySchema,
  createLookalikeAudienceBodySchema,
  duplicateAdBodySchema,
  duplicateAdSetBodySchema,
  duplicateCampaignBodySchema,
  launchCtaSchema,
  websiteAudienceName,
} from "./_decision-bodies";
import { readTenantCapAndToday } from "./cap-reader";
import { fbGet } from "../_client";
import { formatMoney } from "./_currency";

type Emit = (decision_class: string, body: unknown) => Promise<string>;

async function preflight(ctx: ToolContext): Promise<Emit> {
  if (!(await isMetaAdsWriteEnabled())) {
    throw new ExpectedToolError("meta_ads_write_disabled", "Meta Ads write is disabled at the platform level.");
  }
  if (typeof ctx.emit_decision !== "function") {
    throw new ExpectedToolError("meta_ads_propose_no_emit", "Cannot emit a decision in this context (no emit_decision plumbed).");
  }
  return ctx.emit_decision;
}

function originOf(ctx: ToolContext): { origin: "user_initiated_chat" } | Record<string, never> {
  return isHumanAuthoredCommand(ctx, "budget") ? { origin: "user_initiated_chat" } : {};
}

function parsedOrThrow<S extends z.ZodTypeAny>(schema: S, body: unknown, what: string): z.infer<S> {
  const r = schema.safeParse(body);
  if (!r.success) {
    throw new ExpectedToolError("meta_ads_invalid_launch_body", `This ${what} cannot be made as specified: ${r.error.issues.map((i) => i.message).join(" | ")}`);
  }
  return r.data;
}

const NOTICE = "Sent to approvals. Once approved (by the founder, or Autopilot when it runs the ads under a budget) it goes live.";

const duplicateInput = z.object({
  source_ad_set_id: z.string().min(1).optional().describe("A running ad set to copy with its ads. Ids only from list_ad_sets this turn."),
  source_campaign_id: z
    .string()
    .min(1)
    .optional()
    .describe("A running campaign that sets its own budget (Advantage campaign budget) to copy whole. Use this instead of source_ad_set_id when the ad set's campaign carries the budget."),
  source_ad_id: z.string().min(1).optional().describe("One ad to copy (with its creative) into ad_set_id. Ids only from list_ads this turn."),
  ad_set_id: z.string().min(1).optional().describe("With source_ad_id: the ad set the copy runs in. Omit to copy within the source's own ad set."),
  daily_budget_usd: z
    .number()
    .positive()
    .optional()
    .describe("The copy's own daily budget, in the ad account's currency (list_ad_sets `currency`). Required to copy an ad set or campaign; not used for an ad."),
  name: z.string().max(200).optional(),
  about: z.string().optional().describe("ONE plain sentence on why this copy. Shown on the card."),
  rationale: rationaleInput(),
});

export const metaProposeDuplicateTool: ToolSpec = {
  name: "meta_ads_propose_duplicate",
  effect: "write",
  description:
    "Propose a LIVE copy of a running ad set (with its ads) at a new daily budget, of a running campaign that sets its own budget, or of one ad into an ad set. The way to add spend fast on what already works: no learning from zero creative, no empty shell. Ads that are off in the source stay off in the copy. A card the founder, or cgo on Autopilot with an ad budget, approves.",
  input_schema: duplicateInput,
  async execute(ctx, input) {
    const emit = await preflight(ctx);
    const a = duplicateInput.parse(input);
    if ([a.source_ad_set_id, a.source_campaign_id, a.source_ad_id].filter(Boolean).length !== 1) {
      throw new ExpectedToolError("meta_ads_invalid_launch_body", "Name exactly one source: source_ad_set_id, source_campaign_id or source_ad_id.");
    }
    if (a.source_ad_id) {
      let ad_set_id = a.ad_set_id;
      if (!ad_set_id) {
        const src = (await fbGet(ctx.tenant_id, a.source_ad_id, { fields: "adset_id" })) as { adset_id?: string };
        ad_set_id = src?.adset_id;
      }
      const body = parsedOrThrow(
        duplicateAdBodySchema,
        { source_ad_id: a.source_ad_id, ad_set_id, name: a.name, about: a.about, rationale: a.rationale, ...originOf(ctx) },
        "copy",
      );
      const decision_id = await emit("meta_ads.duplicate_ad", body);
      return { decision_id, decision_class: "meta_ads.duplicate_ad", notice: NOTICE };
    }
    if (a.daily_budget_usd === undefined) {
      throw new ExpectedToolError("meta_ads_invalid_launch_body", "A copy of an ad set or campaign needs its own daily_budget_usd.");
    }
    const { cap, currency } = await readTenantCapAndToday(ctx.tenant_id);
    if (cap?.enabled && cap.max_daily_budget_usd != null && a.daily_budget_usd > cap.max_daily_budget_usd) {
      throw new ExpectedToolError(
        "meta_ads_proposal_over_absolute_cap",
        `Proposed daily budget ${formatMoney(a.daily_budget_usd, currency)} exceeds the tenant ceiling ${formatMoney(cap.max_daily_budget_usd, currency)}.`,
      );
    }
    const common = { daily_budget_usd: a.daily_budget_usd, currency, name: a.name, about: a.about, rationale: a.rationale, ...originOf(ctx) };
    const decision_class = a.source_ad_set_id ? "meta_ads.duplicate_ad_set" : "meta_ads.duplicate_campaign";
    const body: unknown = a.source_ad_set_id
      ? parsedOrThrow(duplicateAdSetBodySchema, { source_ad_set_id: a.source_ad_set_id, ...common }, "copy")
      : parsedOrThrow(duplicateCampaignBodySchema, { source_campaign_id: a.source_campaign_id, ...common }, "copy");
    const decision_id = await emit(decision_class, body);
    return { decision_id, decision_class, notice: NOTICE };
  },
};

const newAdInput = z.object({
  ad_set_id: z.string().min(1).describe("The ad set the ad runs in. Ids only from list_ad_sets this turn."),
  image_url: z
    .string()
    .optional()
    .describe("A public https image that stays reachable (e.g. the url report__render_social_image returned). Zavi-generated images are fine; never one depicting the business's real product, premises or people."),
  video_asset_id: z.string().optional().describe("A video already in this ad account's library."),
  primary_text: z.string().min(1).max(2000),
  headline: z.string().min(1).max(255),
  link_url: z.string().describe("The https landing page."),
  cta: launchCtaSchema.optional(),
  source: z.enum(["zavi_generated", "library", "copy"]).describe("zavi_generated (a rendered image), library (an asset already in the account), copy (reuse source_ad_id's image or video with new words)."),
  source_ad_id: z.string().optional(),
  name: z.string().max(200).optional(),
  about: z.string().optional(),
  rationale: rationaleInput(),
});

export const metaProposeNewAdTool: ToolSpec = {
  name: "meta_ads_propose_new_ad",
  effect: "write",
  description:
    "Propose a new LIVE ad in an existing ad set: a fresh variant against fatigue, or the first ad in an ad set that has none. Adds no budget (the ad set's budget is the spend). A card the founder, or cgo on Autopilot with an ad budget, approves.",
  input_schema: newAdInput,
  async execute(ctx, input) {
    const emit = await preflight(ctx);
    const a = newAdInput.parse(input);
    const body = parsedOrThrow(createAdBodySchema, { ...a, ...originOf(ctx) }, "ad");
    const decision_id = await emit("meta_ads.create_ad", body);
    return { decision_id, decision_class: "meta_ads.create_ad", notice: NOTICE };
  },
};

const audienceInput = z.object({
  kind: z.enum(["website_visitors", "lookalike"]).optional().describe("Default website_visitors."),
  retention_days: z.union([z.literal(30), z.literal(90)]).optional().describe("website_visitors: 30 or 90 days."),
  origin_audience_id: z.string().optional().describe("lookalike: the source audience (list_custom_audiences), ideally buyers or leads."),
  country: z.string().optional().describe("lookalike: 2-letter country code."),
  ratio: z.number().optional().describe("lookalike: 0.01 (closest 1%) to 0.10."),
  pixel_id: z.string().optional().describe("Needed only when the account has more than one pixel. From pixel_health this turn."),
  rationale: rationaleInput(),
});

export const metaProposeCustomAudienceTool: ToolSpec = {
  name: "meta_ads_propose_custom_audience",
  effect: "write",
  description:
    "Propose a website-visitor audience (everyone the pixel saw in 30 or 90 days) for retargeting and prospecting exclusions, or a lookalike of one of the account's audiences for prospecting. Spends nothing. A card the founder, or cgo on Autopilot with an ad budget, approves.",
  input_schema: audienceInput,
  async execute(ctx, input) {
    const emit = await preflight(ctx);
    const a = audienceInput.parse(input);
    if (a.kind === "lookalike") {
      const body = parsedOrThrow(
        createLookalikeAudienceBodySchema,
        { origin_audience_id: a.origin_audience_id, country: a.country, ratio: a.ratio, rationale: a.rationale, ...originOf(ctx) },
        "lookalike",
      );
      const decision_id = await emit("meta_ads.create_lookalike_audience", body);
      return { decision_id, decision_class: "meta_ads.create_lookalike_audience", notice: NOTICE };
    }
    if (a.retention_days === undefined) {
      throw new ExpectedToolError("meta_ads_invalid_launch_body", "A website-visitor audience needs retention_days (30 or 90).");
    }
    const body = parsedOrThrow(
      createCustomAudienceBodySchema,
      {
        kind: "website_visitors",
        retention_days: a.retention_days,
        pixel_id: a.pixel_id,
        name: websiteAudienceName(a.retention_days),
        rationale: a.rationale,
        ...originOf(ctx),
      },
      "audience",
    );
    const decision_id = await emit("meta_ads.create_custom_audience", body);
    return { decision_id, decision_class: "meta_ads.create_custom_audience", notice: NOTICE };
  },
};
