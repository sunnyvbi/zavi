
import { z } from "zod";
import { rationaleInput } from "@/services/tools/_shared/rationale";
import type { ToolSpec } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import { isHumanAuthoredCommand } from "@/services/agents/untrusted-context";
import { isMetaAdsWriteEnabled } from "./_flag-check";
import { shapeGeoLocations } from "./replace_ad_set_geo";
import {
  launchAdCopySchema,
  launchCampaignBodySchema,
  metaBidStrategySchema,
  metaCampaignObjectiveSchema,
  metaSpecialAdCategorySchema,
} from "./_decision-bodies";
import { promotedObjectSchema } from "./_targeting-validate";
import { readTenantCapAndToday } from "./cap-reader";
import { formatMoney, isWritableCurrency } from "./_currency";
import { resolveMetaAdCapability } from "./_library-ad-capability";
import { capabilityRefusal } from "./create_library_ad";
import { resolveCreateLocations, withCgoCountryDefault } from "./propose_new_ad_set";

export const META_LAUNCH_CAMPAIGN_CLASS = "meta_ads.launch_campaign";

const inputSchema = z.object({
  campaign: z.object({
    name: z.string().min(1).max(200),
    objective: metaCampaignObjectiveSchema,
    daily_budget_usd: z.number().positive().describe("The campaign's daily budget, in the ad account's currency (list_ad_sets `currency`)."),
    bid_strategy: metaBidStrategySchema
      .optional()
      .describe("Default LOWEST_COST_WITHOUT_CAP. LOWEST_COST_WITH_BID_CAP or COST_CAP need ad_set.bid_amount_usd. LOWEST_COST_WITH_MIN_ROAS is not supported yet."),
    special_ad_categories: z
      .array(metaSpecialAdCategorySchema)
      .optional()
      .describe("Only when the ads are about jobs, housing, credit/financial products or politics. Needs special_ad_category_country."),
    special_ad_category_country: z.array(z.string()).optional().describe("2-letter country codes the special category applies in."),
  }),
  ad_set: z.object({
    name: z.string().min(1).max(200).optional().describe("Defaults to the campaign's name."),
    optimization_goal: z.string().min(1).describe("Meta optimization_goal, e.g. OFFSITE_CONVERSIONS, LINK_CLICKS, LANDING_PAGE_VIEWS."),
    billing_event: z.string().min(1).describe("Meta billing_event, usually IMPRESSIONS."),
    targeting: z
      .record(z.string(), z.unknown())
      .default({})
      .describe("Meta targeting JSON (ages, genders, interests with real ids from search_interests). Put places in `locations`."),
    locations: z
      .array(z.string().trim().min(2).max(120))
      .max(25)
      .optional()
      .describe('Places by name ("Austin, TX", "Texas") or a picked id ("city:2421836"). An ambiguous or unknown name is refused with the choices: ask the founder, never guess.'),
    excluded_locations: z
      .array(z.string().regex(/^(country|region|city):[A-Za-z0-9]{1,32}$/, 'a picked place id like "city:2421836"'))
      .max(50)
      .optional()
      .describe('Places the ad set must never show in, as picked ids ("region:3847"). Becomes targeting.excluded_geo_locations.'),
    promoted_object: promotedObjectSchema
      .optional()
      .describe("REQUIRED for a conversion goal: {pixel_id, custom_event_type}, with a real pixel_id from meta_ads_pixel_health."),
    bid_amount_usd: z.number().positive().optional().describe("The bid cap or target cost per result, in the account's currency. Only with a bid cap or cost cap."),
  }),
  ad: launchAdCopySchema.extend({
    video_asset_id: z.string().optional().describe("A video already in this ad account's library, instead of image_url."),
    source: z.enum(["zavi_generated", "library", "copy"]).describe("zavi_generated (a rendered image), library (an asset already in the account), copy (reuse source_ad_id's image or video with new words)."),
    source_ad_id: z.string().optional(),
    name: z.string().max(200).optional(),
  }),
  about: z.string().optional().describe("ONE plain sentence on what this campaign is for. Shown on the card."),
  rationale: rationaleInput(),
});

export const metaProposeCampaignLaunchTool: ToolSpec = {
  name: "meta_ads_propose_campaign_launch",
  effect: "money",
  description:
    "Propose a brand-new Meta campaign that goes LIVE on one approval: the campaign (objective, daily budget, bid strategy), one ad set (audience, places, conversion event, bid amount) and one ad (image or video, text, link). One card; approving it builds all of it and switches it on, and Zavi confirms with Meta that it is live. The founder approves, or cgo on Autopilot with an ad budget. Use this whenever the founder wants a new campaign running; use propose_new_campaign only for an empty paused shell.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    if (!(await isMetaAdsWriteEnabled())) {
      throw new ExpectedToolError("meta_ads_write_disabled", "Meta Ads write is disabled at the platform level.");
    }
    if (typeof ctx.emit_decision !== "function") {
      throw new ExpectedToolError("meta_ads_propose_no_emit", "Cannot emit a decision in this context (no emit_decision plumbed).");
    }
    const a = inputSchema.parse(input);
    const { founderAskFor } = await import("@/services/approvals/approval-envelope");
    let ask = await founderAskFor(ctx, "meta_ads");

    const { cap, currency } = await readTenantCapAndToday(ctx.tenant_id);
    if (!isWritableCurrency(currency)) {
      throw new ExpectedToolError("meta_ads_unsupported_currency", `Zavi writes Meta budgets for USD and INR ad accounts only; this account is ${currency}. Nothing was proposed.`);
    }
    if (ask?.plan && currency.toUpperCase() !== "USD") ask = { plan: null, line: "I can only size a direct ask in USD; the card is waiting for you.", source: ask.source };
    const { flightEndMs, utcStamp } = await import("@/services/growth/ad-plan-shape");
    const endMs = ask?.plan ? flightEndMs(ask.plan, Date.now()) : null;
    const endTime = endMs != null ? new Date(endMs).toISOString().replace(/\.\d{3}Z$/, "+00:00") : undefined;
    if (ask?.plan && endMs != null) ask = { ...ask, line: `${ask.line} It stops ${utcStamp(endMs)}.` };
    if (ask?.plan) a.campaign.daily_budget_usd = ask.plan.daily_usd!;
    if (cap?.enabled && cap.max_daily_budget_usd != null && a.campaign.daily_budget_usd > cap.max_daily_budget_usd) {
      throw new ExpectedToolError(
        "meta_ads_proposal_over_absolute_cap",
        `Proposed daily budget ${formatMoney(a.campaign.daily_budget_usd, currency)} exceeds the tenant ceiling ${formatMoney(cap.max_daily_budget_usd, currency)}.`,
      );
    }
    const capability = await resolveMetaAdCapability(ctx.tenant_id);
    if (!capability.ok) throw capabilityRefusal(capability);

    const { locations, excluded_locations, ...adSet } = a.ad_set;
    let targeting = await withCgoCountryDefault(ctx, await resolveCreateLocations(ctx.tenant_id, adSet.targeting, locations));
    if (excluded_locations?.length) {
      const places = excluded_locations.map((id) => {
        const [type, key] = id.split(":") as ["country" | "region" | "city", string];
        return { type, key };
      });
      targeting = { ...targeting, excluded_geo_locations: shapeGeoLocations(places, null) };
    }
    const parsed = launchCampaignBodySchema.safeParse({
      campaign: a.campaign,
      ad_set: { ...adSet, targeting, ...(endTime ? { end_time: endTime } : {}) },
      ad: a.ad,
      currency,
      about: a.about,
      rationale: a.rationale,
      ...(isHumanAuthoredCommand(ctx, "budget") ? { origin: "user_initiated_chat" } : {}),
    });
    if (!parsed.success) {
      throw new ExpectedToolError(
        "meta_ads_invalid_launch_body",
        `This launch cannot be made as specified: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(" | ")}`,
      );
    }
    const decision_id = await ctx.emit_decision(META_LAUNCH_CAMPAIGN_CLASS, parsed.data);
    return {
      decision_id,
      decision_class: META_LAUNCH_CAMPAIGN_CLASS,
      notice: "Sent to approvals as one card. Once approved, Zavi builds the campaign, ad set and ad and switches them on.",
      ...(ask?.line ? { say_to_founder: ask.plan && ask.source === "ask" ? await (await import("@/services/approvals/envelope-door")).directAskSay(ctx.tenant_id, decision_id, ask.line, "Meta") : ask.line } : {}),
    };
  },
};
