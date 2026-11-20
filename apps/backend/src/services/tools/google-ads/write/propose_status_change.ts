import { z } from "zod";
import { rationaleInput } from "@/services/tools/_shared/rationale";
import { buildGoogleAdsDecisionEvidence, cardEvidenceInputShape } from "./_card-evidence";
import type { ToolSpec } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import { assertUsdGoogleAccount } from "./_currency-guard";
import { readTenantGoogleCapAndToday } from "./cap-reader";
import { pickGoogleDecisionClass } from "./_class-router";
import { hasUntrustedContext, isRulesSteered } from "@/services/agents/untrusted-context";
import { STATUS_LEVELS } from "./_decision-bodies";
import { assertGoogleAdsProposeAllowed, displayFields } from "./_propose-guard";
import { assertNotVideoCampaign } from "./_video-guard";

const inputSchema = z.object({
  ...cardEvidenceInputShape,
  campaign_id: z.string().regex(/^[0-9]+$/).describe("Google Ads campaign ID (numeric). Required at every level — an ad group or ad is always addressed inside its campaign."),
  level: z
    .enum(STATUS_LEVELS)
    .default("campaign")
    .describe("What to pause or enable: the whole campaign (default), one ad group, or one ad."),
  ad_group_id: z.string().regex(/^[0-9]+$/).optional().describe("Required when level is ad_group or ad."),
  ad_id: z.string().regex(/^[0-9]+$/).optional().describe("Required when level is ad."),
  status: z
    .enum(["ENABLED", "PAUSED"])
    .describe(
      "Target status. PAUSED auto-applies ONLY if the tenant has opted in via tenant_ads_write_caps.enabled=true (platform=google_ads); ENABLED always waits for operator approval.",
    ),
  rationale: rationaleInput(),
  name: z
    .string()
    .optional()
    .describe("The human-readable name of the campaign, ad group or ad. ALWAYS pass this so the approval card shows what it is."),
  about: z
    .string()
    .optional()
    .describe("ONE plain sentence describing what this object is about. ALWAYS pass this so the reviewer knows what they're approving."),
});

export const googleProposeStatusChangeTool: ToolSpec = {
  name: "google_ads_propose_status_change",
  effect: "write",
  description:
    "Propose pausing or enabling a Google Ads campaign, ad group, or ad. PAUSED proposals auto-apply IF the operator has opted in to write-caps (otherwise they wait for operator approval); ENABLED proposals wait for the founder (or cgo can approve when Autopilot runs the ads under a budget), because they re-open spend; a non-USD account is refused. On by default; the google_ads_write_enabled platform kill switch can disable it.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const emit = await assertGoogleAdsProposeAllowed(ctx);
    const args = inputSchema.parse(input);
    if (args.status === "ENABLED") await assertUsdGoogleAccount(ctx, "budgets");
    await assertNotVideoCampaign(ctx.tenant_id, args.campaign_id);
    if (args.level !== "campaign" && !args.ad_group_id) {
      throw new ExpectedToolError("google_ads_invalid_target", `ad_group_id is required when level is ${args.level}`);
    }
    if (args.level === "ad" && !args.ad_id) {
      throw new ExpectedToolError("google_ads_invalid_target", "ad_id is required when level is ad");
    }

    const { cap } = await readTenantGoogleCapAndToday(ctx.tenant_id);
    const decision_class = pickGoogleDecisionClass({
      op: "status",
      status: args.status,
      capEnabled: !!cap?.enabled,
      forceApproval: isRulesSteered(ctx, "status") || hasUntrustedContext(ctx),
    });
    const auto = decision_class === "google_ads.set_status";
    const body = {
      campaign_id: args.campaign_id,
      level: args.level,
      ...(args.ad_group_id ? { ad_group_id: args.ad_group_id } : {}),
      ...(args.ad_id ? { ad_id: args.ad_id } : {}),
      status: args.status,
      rationale: args.rationale,
      decision_evidence: buildGoogleAdsDecisionEvidence(
        args.status === "PAUSED" ? "status_pause" : "status_enable",
        args.rationale,
        args,
      ),
      over_cap: !auto,
      ...displayFields(args),
      ...(args.level === "campaign" && args.status === "ENABLED" ? await (await import("@/services/tools/_object-daily-budget")).googleCampaignDailyBudget(ctx.tenant_id, args.campaign_id) : {}),
    };

    const decision_id = await emit(decision_class, body);
    return { decision_id, decision_class, will_auto_apply: auto };
  },
};
