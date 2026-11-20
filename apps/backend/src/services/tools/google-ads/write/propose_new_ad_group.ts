import { z } from "zod";
import { rationaleInput } from "@/services/tools/_shared/rationale";
import { buildGoogleAdsDecisionEvidence, cardEvidenceInputShape } from "./_card-evidence";
import type { ToolSpec } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import { assertUsdGoogleAccount } from "./_currency-guard";
import { GOOGLE_ADS_DECISION_CLASSES } from "./_class-router";
import { AD_GROUP_TYPES, adSpecSchema, createAdGroupBodySchema, keywordSchema } from "./_decision-bodies";
import { assertGoogleAdsProposeAllowed } from "./_propose-guard";
import { assertNotVideoCampaign } from "./_video-guard";

const inputSchema = z.object({
  ...cardEvidenceInputShape,
  campaign_id: z.string().regex(/^[0-9]+$/).describe("The campaign to add the ad group to."),
  name: z.string().min(1).max(255).describe("Ad group name, unique within the campaign."),
  type: z
    .enum(AD_GROUP_TYPES)
    .describe("SEARCH_STANDARD for Search campaigns, DISPLAY_STANDARD for Display. YouTube video ad groups are Demand Gen: use google_ads_propose_video_campaign."),
  cpc_bid_usd: z.number().positive().optional().describe("Default max CPC bid (manual CPC search ad groups)."),
  cpm_bid_usd: z.number().positive().optional().describe("Default CPM bid (manual CPM display ad groups)."),
  keywords: z.array(keywordSchema).max(200).default([]).describe("Positive keywords. SEARCH_STANDARD only."),
  ads: z.array(adSpecSchema).max(3).default([]).describe("Ads to create PAUSED inside the new ad group. Kinds must match the ad group type."),
  rationale: rationaleInput(),
  about: z.string().optional().describe("ONE plain sentence on what this ad group targets."),
});

export const googleProposeNewAdGroupTool: ToolSpec = {
  name: "google_ads_propose_new_ad_group",
  effect: "write",
  description:
    "Propose creating a new ad group (PAUSED) inside an existing Google Ads campaign, optionally with keywords and ads in the same atomic write. The founder approves it, or cgo can when Autopilot runs the ads under a budget. On by default; the google_ads_write_enabled platform kill switch can disable it.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const emit = await assertGoogleAdsProposeAllowed(ctx);
    const args = inputSchema.parse(input);
    if (args.cpc_bid_usd !== undefined || args.cpm_bid_usd !== undefined) await assertUsdGoogleAccount(ctx, "bids");
    await assertNotVideoCampaign(ctx.tenant_id, args.campaign_id);
    const parsed = createAdGroupBodySchema.safeParse(args);
    if (!parsed.success) {
      throw new ExpectedToolError(
        "google_ads_invalid_create_body",
        `This ad group cannot be created as specified: ${parsed.error.issues.map((i) => i.message).join(" | ")}`,
      );
    }
    const decision_class = GOOGLE_ADS_DECISION_CLASSES.create_ad_group;
    const decision_id = await emit(decision_class, {
      ...parsed.data,
      decision_evidence: buildGoogleAdsDecisionEvidence("create", args.rationale, args),
    });
    return { decision_id, decision_class };
  },
};
