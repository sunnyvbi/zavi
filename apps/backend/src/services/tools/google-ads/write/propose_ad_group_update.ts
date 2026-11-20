import { z } from "zod";
import { rationaleInput } from "@/services/tools/_shared/rationale";
import { buildGoogleAdsDecisionEvidence, cardEvidenceInputShape } from "./_card-evidence";
import type { ToolSpec } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import { assertUsdGoogleAccount } from "./_currency-guard";
import { GOOGLE_ADS_DECISION_CLASSES } from "./_class-router";
import { updateAdGroupBodySchema } from "./_decision-bodies";
import { assertGoogleAdsProposeAllowed } from "./_propose-guard";
import { assertNotVideoAdGroup } from "./_video-guard";

const inputSchema = z.object({
  ...cardEvidenceInputShape,
  ad_group_id: z.string().regex(/^[0-9]+$/).describe("Google Ads ad group ID (numeric)."),
  new_name: z.string().min(1).max(255).optional(),
  cpc_bid_usd: z.number().positive().optional().describe("New default max CPC bid in USD."),
  cpv_bid_usd: z.number().positive().optional().describe("New default max CPV bid in USD."),
  cpm_bid_usd: z.number().positive().optional().describe("New default CPM bid in USD."),
  rationale: rationaleInput(),
  name: z.string().optional().describe("Current ad group name, for the approval card."),
  about: z.string().optional().describe("ONE plain sentence on what this ad group targets."),
});

export const googleProposeAdGroupUpdateTool: ToolSpec = {
  name: "google_ads_propose_ad_group_update",
  effect: "write",
  description:
    "Propose renaming a Google Ads ad group or changing its default bids (CPC / CPV / CPM). Pause and enable have their own tool. Always operator-approved. On by default; the google_ads_write_enabled platform kill switch can disable it.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const emit = await assertGoogleAdsProposeAllowed(ctx);
    const args = inputSchema.parse(input);
    const parsed = updateAdGroupBodySchema.safeParse(args);
    if (!parsed.success) {
      throw new ExpectedToolError(
        "google_ads_invalid_update_body",
        parsed.error.issues.map((i) => i.message).join(" | "),
      );
    }
    if (args.cpc_bid_usd !== undefined || args.cpv_bid_usd !== undefined || args.cpm_bid_usd !== undefined) await assertUsdGoogleAccount(ctx, "bids");
    await assertNotVideoAdGroup(ctx.tenant_id, parsed.data.ad_group_id);
    const decision_class = GOOGLE_ADS_DECISION_CLASSES.update_ad_group;
    const decision_id = await emit(decision_class, {
      ...parsed.data,
      decision_evidence: buildGoogleAdsDecisionEvidence("update", args.rationale, args),
    });
    return { decision_id, decision_class, will_auto_apply: false };
  },
};
