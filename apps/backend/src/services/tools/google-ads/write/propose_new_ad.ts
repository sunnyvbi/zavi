import { z } from "zod";
import { rationaleInput } from "@/services/tools/_shared/rationale";
import { buildGoogleAdsDecisionEvidence, cardEvidenceInputShape } from "./_card-evidence";
import type { ToolSpec } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import { GOOGLE_ADS_DECISION_CLASSES } from "./_class-router";
import { adSpecSchema, createAdBodySchema } from "./_decision-bodies";
import { assertGoogleAdsProposeAllowed } from "./_propose-guard";
import { assertNotVideoAdGroup } from "./_video-guard";

const inputSchema = z.object({
  ...cardEvidenceInputShape,
  ad_group_id: z.string().regex(/^[0-9]+$/).describe("The ad group to add the ad to. Its type must match the ad kind."),
  ad: adSpecSchema.describe(
    "The ad: a responsive_search ad, for a SEARCH_STANDARD ad group.",
  ),
  rationale: rationaleInput(),
  name: z.string().optional().describe("A short label for the ad, for the approval card."),
  about: z.string().optional().describe("ONE plain sentence on what this ad says or shows."),
});

export const googleProposeNewAdTool: ToolSpec = {
  name: "google_ads_propose_new_ad",
  effect: "write",
  description:
    "Propose a new responsive search ad (PAUSED) in an existing Google Ads search ad group; YouTube video ads are Demand Gen (google_ads_propose_video_campaign). Google ads are immutable once created, so edits mean a new ad plus removing the old one. The founder approves it, or cgo can when Autopilot runs the ads under a budget. On by default; the google_ads_write_enabled platform kill switch can disable it.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const emit = await assertGoogleAdsProposeAllowed(ctx);
    const args = inputSchema.parse(input);
    const parsed = createAdBodySchema.safeParse(args);
    if (!parsed.success) {
      throw new ExpectedToolError(
        "google_ads_invalid_create_body",
        `This ad cannot be created as specified: ${parsed.error.issues.map((i) => i.message).join(" | ")}`,
      );
    }
    await assertNotVideoAdGroup(ctx.tenant_id, parsed.data.ad_group_id);
    const decision_class = GOOGLE_ADS_DECISION_CLASSES.create_ad;
    const decision_id = await emit(decision_class, {
      ...parsed.data,
      decision_evidence: buildGoogleAdsDecisionEvidence("create", args.rationale, args),
    });
    return { decision_id, decision_class };
  },
};
