import { z } from "zod";
import { rationaleInput } from "@/services/tools/_shared/rationale";
import { buildGoogleAdsDecisionEvidence, cardEvidenceInputShape } from "./_card-evidence";
import type { ToolSpec } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import { isHumanAuthoredCommand } from "@/services/agents/untrusted-context";
import { assertUsdGoogleAccount } from "./_currency-guard";
import { readTenantGoogleCapAndToday } from "./cap-reader";
import { GOOGLE_ADS_DECISION_CLASSES } from "./_class-router";
import {
  CAMPAIGN_CHANNEL_TYPES,
  adGroupSpecSchema,
  biddingSchema,
  createCampaignBodySchema,
  keywordSchema,
  networkSettingsSchema,
} from "./_decision-bodies";
import { assertGoogleAdsProposeAllowed } from "./_propose-guard";

const PROPOSABLE_CHANNEL_TYPES = ["SEARCH", "DISPLAY", "DEMAND_GEN", "PERFORMANCE_MAX"] as const satisfies readonly (typeof CAMPAIGN_CHANNEL_TYPES)[number][];

const inputSchema = z.object({
  ...cardEvidenceInputShape,
  name: z.string().min(1).max(255).describe("Campaign name. Must be unique in the account."),
  channel_type: z
    .enum(PROPOSABLE_CHANNEL_TYPES)
    .describe("SEARCH or DISPLAY. Google's API cannot create VIDEO campaigns. For a YouTube video campaign use google_ads_propose_video_campaign (Demand Gen with its video ad); for Performance Max use google_ads_propose_pmax_campaign (with its asset group)."),
  daily_budget_usd: z.number().positive().describe("Daily budget in USD."),
  bidding: biddingSchema.describe("Bidding strategy valid for the channel type: SEARCH takes MANUAL_CPC / TARGET_SPEND / MAXIMIZE_CONVERSIONS / MAXIMIZE_CONVERSION_VALUE; DISPLAY adds MANUAL_CPM; PERFORMANCE_MAX takes MAXIMIZE_CONVERSIONS / MAXIMIZE_CONVERSION_VALUE."),
  network: networkSettingsSchema
    .optional()
    .describe("SEARCH only. Defaults to Google Search alone with search partners and display expansion OFF."),
  location_ids: z
    .array(z.number().int().positive())
    .max(50)
    .default([])
    .describe("Geo target constant ids, e.g. 2840 for the United States. Omit for no location restriction."),
  excluded_location_ids: z
    .array(z.number().int().positive())
    .max(50)
    .default([])
    .describe("Geo target constant ids the campaign must never show in (inside its locations)."),
  language_ids: z
    .array(z.number().int().positive())
    .max(20)
    .default([])
    .describe("Language constant ids, e.g. 1000 for English."),
  negative_keywords: z.array(keywordSchema).max(200).default([]).describe("Campaign-level negative keywords."),
  ad_group: adGroupSpecSchema
    .optional()
    .describe("Optional first ad group with its keywords and ads, created PAUSED in the same atomic write. A responsive_search ad needs a SEARCH_STANDARD ad group."),
  rationale: rationaleInput(),
  about: z.string().optional().describe("ONE plain sentence on what this campaign is for. Shown on the approval card."),
});

export const googleProposeNewCampaignTool: ToolSpec = {
  name: "google_ads_propose_new_campaign",
  effect: "write",
  description:
    "Propose creating a new Google Ads campaign (with its budget and, optionally, a first ad group, keywords and ads) in one atomic write. Operator-approved: created PAUSED, enabled by a separate google_ads_propose_status_change. Autopilot-approved with a location: created and switched on. The result says which happened.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    if ((input as { channel_type?: unknown } | null)?.channel_type === "DEMAND_GEN") {
      throw new ExpectedToolError(
        "google_ads_demand_gen_use_video_tool",
        "A Demand Gen campaign needs its video ad bundle; use google_ads_propose_video_campaign.",
      );
    }
    if ((input as { channel_type?: unknown } | null)?.channel_type === "PERFORMANCE_MAX") {
      throw new ExpectedToolError(
        "google_ads_pmax_use_pmax_tool",
        "A Performance Max campaign needs its asset group (copy, images, logo) to serve; use google_ads_propose_pmax_campaign.",
      );
    }
    const emit = await assertGoogleAdsProposeAllowed(ctx);
    let args = inputSchema.parse(input);
    const { founderAskFor } = await import("@/services/approvals/approval-envelope");
    const ask = await founderAskFor(ctx, "google_ads");
    if (ask?.plan) args = { ...args, daily_budget_usd: ask.plan.daily_usd! };
    const parsed = createCampaignBodySchema.safeParse(ask?.plan ? { ...args, end_date: ask.plan.end } : args);
    if (!parsed.success) {
      throw new ExpectedToolError(
        "google_ads_invalid_create_body",
        `This campaign cannot be created as specified: ${parsed.error.issues.map((i) => i.message).join(" | ")}`,
      );
    }
    await assertUsdGoogleAccount(ctx, "campaign budgets");
    const { cap } = await readTenantGoogleCapAndToday(ctx.tenant_id);
    if (cap?.enabled && cap.max_daily_budget_usd != null && args.daily_budget_usd > cap.max_daily_budget_usd) {
      throw new ExpectedToolError(
        "google_ads_proposal_over_absolute_cap",
        `Proposed daily budget $${args.daily_budget_usd} exceeds the tenant ceiling $${cap.max_daily_budget_usd}. Lower the proposal or ask the operator to raise the cap.`,
      );
    }
    const d = await import("./_launch-defaults");
    let body = parsed.data;
    if (body.location_ids.length === 0) body = { ...body, location_ids: await d.countryIfNoLocation(ctx.tenant_id, body.location_ids) };
    const { cgoAdBudget } = await import("@/services/growth/cgo-ads");
    if (!isHumanAuthoredCommand(ctx, "budget") && (await cgoAdBudget(ctx.tenant_id))) {
      body = d.withClickBiddingWhenBlind(body, await d.readAccountConversions30d(ctx.tenant_id));
    }
    const noPlace = !!ask?.plan && body.location_ids.length === 0;
    const decision_class = GOOGLE_ADS_DECISION_CLASSES.create_campaign;
    const decision_id = await emit(decision_class, {
      ...body,
      decision_evidence: buildGoogleAdsDecisionEvidence("create", args.rationale, args),
    });
    return {
      decision_id,
      decision_class,
      notice: ask?.plan && !noPlace
        ? "Filed. The founder's own ask approves it, so it is created and switched on inside their total and end date; if it does not fit the ask it stays a card."
        : "Filed as a card. Approved by you, it is created PAUSED; approved by Autopilot under the ad budget, it is created and switched on.",
      ...(ask?.line
        ? { say_to_founder: noPlace ? "Zavi needs a country or city to run this Google campaign, so it is a card for you to approve. Tell me where to run it, or set your company's country." : ask.plan && ask.source === "ask" ? await (await import("@/services/approvals/envelope-door")).directAskSay(ctx.tenant_id, decision_id, ask.line, "Google") : ask.line }
        : {}),
    };
  },
};
