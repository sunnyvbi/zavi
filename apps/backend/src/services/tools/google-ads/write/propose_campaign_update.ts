import { z } from "zod";
import { rationaleInput } from "@/services/tools/_shared/rationale";
import { buildGoogleAdsDecisionEvidence, cardEvidenceInputShape } from "./_card-evidence";
import type { ToolSpec } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import { assertUsdGoogleAccount } from "./_currency-guard";
import { GOOGLE_ADS_DECISION_CLASSES } from "./_class-router";
import { networkSettingsSchema, updateCampaignBodySchema } from "./_decision-bodies";
import { assertGoogleAdsProposeAllowed } from "./_propose-guard";
import { assertNotVideoCampaign } from "./_video-guard";

const inputSchema = z.object({
  ...cardEvidenceInputShape,
  campaign_id: z.string().regex(/^[0-9]+$/).describe("Google Ads campaign ID (numeric)."),
  new_name: z.string().min(1).max(255).optional().describe("Rename the campaign."),
  target_cpa_usd: z
    .number()
    .positive()
    .optional()
    .describe("New target CPA in USD. Only valid when the campaign bids with MAXIMIZE_CONVERSIONS or TARGET_CPA (see google_ads__campaign_diagnostics bidding_strategy_type)."),
  target_roas: z
    .number()
    .positive()
    .optional()
    .describe("New target ROAS as a ratio (2.5 = 250%). Only valid for MAXIMIZE_CONVERSION_VALUE or TARGET_ROAS campaigns."),
  network: networkSettingsSchema.optional().describe("SEARCH only: which networks the campaign serves on."),
  rationale: rationaleInput(),
  name: z.string().optional().describe("Current campaign name, for the approval card."),
  about: z.string().optional().describe("ONE plain sentence on what this campaign is about."),
});

export const googleProposeCampaignUpdateTool: ToolSpec = {
  name: "google_ads_propose_campaign_update",
  effect: "write",
  description:
    "Propose changing a Google Ads campaign's settings: name, bidding target (target CPA / target ROAS), or search network settings. Budget and status have their own tools. Always operator-approved. On by default; the google_ads_write_enabled platform kill switch can disable it.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const emit = await assertGoogleAdsProposeAllowed(ctx);
    const args = inputSchema.parse(input);
    if (args.target_cpa_usd !== undefined) await assertUsdGoogleAccount(ctx, "target CPAs");
    await assertNotVideoCampaign(ctx.tenant_id, args.campaign_id);
    const parsed = updateCampaignBodySchema.safeParse(args);
    if (!parsed.success) {
      throw new ExpectedToolError(
        "google_ads_invalid_update_body",
        parsed.error.issues.map((i) => i.message).join(" | "),
      );
    }
    const decision_class = GOOGLE_ADS_DECISION_CLASSES.update_campaign;
    const decision_id = await emit(decision_class, {
      ...parsed.data,
      decision_evidence: buildGoogleAdsDecisionEvidence("update", args.rationale, args),
    });
    return { decision_id, decision_class, will_auto_apply: false };
  },
};
