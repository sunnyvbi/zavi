import { z } from "zod";
import { rationaleInput } from "@/services/tools/_shared/rationale";
import { buildGoogleAdsDecisionEvidence, cardEvidenceInputShape } from "./_card-evidence";
import type { ToolSpec } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import { GOOGLE_ADS_DECISION_CLASSES } from "./_class-router";
import { addKeywordsBodySchema, keywordSchema } from "./_decision-bodies";
import { assertGoogleAdsProposeAllowed } from "./_propose-guard";
import { assertNotVideoAdGroup, assertNotVideoCampaign } from "./_video-guard";

const inputSchema = z.object({
  ...cardEvidenceInputShape,
  level: z.enum(["ad_group", "campaign"]).describe("ad_group for positive or negative keywords in one ad group; campaign for campaign-level negatives."),
  ad_group_id: z.string().regex(/^[0-9]+$/).optional().describe("Required at ad_group level."),
  campaign_id: z.string().regex(/^[0-9]+$/).optional().describe("Required at campaign level."),
  negative: z.boolean().describe("true adds negatives (blocks these terms). Campaign level must be negative."),
  keywords: z
    .array(keywordSchema)
    .min(1)
    .max(200)
    .describe("Keywords with match type. Dedupe against google_ads__existing_negatives and google_ads__list_keywords before proposing."),
  rationale: rationaleInput(),
  name: z.string().optional().describe("Name of the ad group or campaign, for the approval card."),
  about: z.string().optional().describe("ONE plain sentence on why these terms."),
});

export const googleProposeKeywordsTool: ToolSpec = {
  name: "google_ads_propose_keywords",
  effect: "write",
  description:
    "Propose adding keywords to a Google Ads ad group (positive or negative) or negative keywords to a campaign. The founder approves it, or cgo can when Autopilot runs the ads under a budget. On by default; the google_ads_write_enabled platform kill switch can disable it.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const emit = await assertGoogleAdsProposeAllowed(ctx);
    const args = inputSchema.parse(input);
    const parsed = addKeywordsBodySchema.safeParse(args);
    if (!parsed.success) {
      throw new ExpectedToolError(
        "google_ads_invalid_keywords_body",
        parsed.error.issues.map((i) => i.message).join(" | "),
      );
    }
    if (parsed.data.level === "ad_group" && parsed.data.ad_group_id) await assertNotVideoAdGroup(ctx.tenant_id, parsed.data.ad_group_id);
    else if (parsed.data.campaign_id) await assertNotVideoCampaign(ctx.tenant_id, parsed.data.campaign_id);
    const decision_class = GOOGLE_ADS_DECISION_CLASSES.add_keywords;
    const decision_id = await emit(decision_class, {
      ...parsed.data,
      decision_evidence: buildGoogleAdsDecisionEvidence("keywords", args.rationale, args),
    });
    return { decision_id, decision_class, keyword_count: parsed.data.keywords.length };
  },
};
