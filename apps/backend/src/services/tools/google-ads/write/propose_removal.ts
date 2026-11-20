import { z } from "zod";
import { rationaleInput } from "@/services/tools/_shared/rationale";
import { buildGoogleAdsDecisionEvidence, cardEvidenceInputShape } from "./_card-evidence";
import type { ToolSpec } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import { GOOGLE_ADS_DECISION_CLASSES } from "./_class-router";
import { removeResourceBodySchema, type RemoveResourceBody } from "./_decision-bodies";
import { assertGoogleAdsProposeAllowed } from "./_propose-guard";
import { assertNotVideoAdGroup, assertNotVideoCampaign } from "./_video-guard";

const numericId = z.string().regex(/^[0-9]+$/);

const inputSchema = z.object({
  ...cardEvidenceInputShape,
  level: z.enum(["campaign", "ad_group", "ad", "keyword"]).describe("What to remove."),
  campaign_id: numericId.optional().describe("Required for level campaign."),
  ad_group_id: numericId.optional().describe("Required for level ad_group and ad."),
  ad_id: numericId.optional().describe("Required for level ad."),
  keyword: z
    .object({
      scope: z.enum(["ad_group", "campaign"]).describe("Whether the criterion lives on an ad group or a campaign."),
      parent_id: numericId.describe("The ad group id or campaign id that owns the criterion."),
      criterion_id: numericId.describe("The criterion id from google_ads__list_keywords or google_ads__existing_negatives."),
      keyword_text: z
        .string()
        .optional()
        .describe("The keyword's own text exactly as it appears in the account, e.g. turo. This is what the approval card names."),
    })
    .optional()
    .describe("REQUIRED when level is keyword. All three fields travel together; a keyword removal without them is rejected."),
  scope: z.enum(["ad_group", "campaign"]).optional().describe("Deprecated flat form — prefer the `keyword` object."),
  parent_id: numericId.optional().describe("Deprecated flat form — prefer the `keyword` object."),
  criterion_id: numericId.optional().describe("Deprecated flat form — prefer the `keyword` object."),
  rationale: rationaleInput(),
  keyword_text: z
    .string()
    .optional()
    .describe(
      "Keyword only, REQUIRED for a keyword removal: the keyword's own text exactly as it appears in the account, e.g. turo. NOT the ad group or campaign it sits in.",
    ),
  name: z
    .string()
    .optional()
    .describe(
      "Name of the object being removed, for the approval card. For a campaign/ad group/ad this is that object's name. For a KEYWORD do not use this — pass keyword_text instead; the container's name here would misdescribe an irreversible change.",
    ),
  about: z.string().optional().describe("ONE plain sentence on why it should go."),
});

async function refuseVideoTarget(tenant_id: string, body: RemoveResourceBody): Promise<void> {
  switch (body.level) {
    case "campaign":
      return assertNotVideoCampaign(tenant_id, body.campaign_id);
    case "ad_group":
    case "ad":
      return assertNotVideoAdGroup(tenant_id, body.ad_group_id);
    case "keyword":
      return body.scope === "campaign" ? assertNotVideoCampaign(tenant_id, body.parent_id) : assertNotVideoAdGroup(tenant_id, body.parent_id);
  }
}

export const googleProposeRemovalTool: ToolSpec = {
  name: "google_ads_propose_removal",
  effect: "write",
  description:
    "Propose REMOVING a Google Ads campaign, ad group, ad, or keyword. Removal is permanent in Google Ads (a removed campaign cannot be re-enabled) — prefer google_ads_propose_status_change PAUSED unless removal is clearly intended. Always operator-approved, never auto-applies. On by default; the google_ads_write_enabled platform kill switch can disable it.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const emit = await assertGoogleAdsProposeAllowed(ctx);
    const args = inputSchema.parse(input);
    const flat = {
      ...args,
      scope: args.keyword?.scope ?? args.scope,
      parent_id: args.keyword?.parent_id ?? args.parent_id,
      criterion_id: args.keyword?.criterion_id ?? args.criterion_id,
      keyword_text: args.keyword ? args.keyword.keyword_text : args.keyword_text,
    };
    const parsed = removeResourceBodySchema.safeParse(flat);
    if (!parsed.success) {
      const missing =
        flat.level === "keyword"
          ? (["scope", "parent_id", "criterion_id"] as const).filter((k) => !flat[k])
          : [];
      throw new ExpectedToolError(
        "google_ads_invalid_removal_body",
        missing.length
          ? `A keyword removal needs keyword.{${missing.join(", ")}}. Get them from google_ads__list_keywords. Also send keyword.keyword_text or keyword_text so the approval card names the keyword, never its container.`
          : parsed.error.issues.map((i) => i.message).join(" | "),
      );
    }
    await refuseVideoTarget(ctx.tenant_id, parsed.data);
    const decision_class = GOOGLE_ADS_DECISION_CLASSES.remove_resource;
    const { criterion_negative: _ignored, ...data } = parsed.data as typeof parsed.data & { criterion_negative?: unknown };
    let criterionNegative: boolean | null = null;
    if (data.level === "keyword") {
      try {
        const { gadsGetKeyword } = await import("../_client");
        const live = await gadsGetKeyword(
          ctx.tenant_id,
          data.scope === "ad_group" ? { level: "ad_group", ad_group_id: data.parent_id } : { level: "campaign", campaign_id: data.parent_id },
          data.criterion_id,
        );
        criterionNegative = live.negative === true;
      } catch (e) {
        ctx.log("keyword read for the removal card failed; it needs an owner or admin to approve", { error: (e as Error).message });
      }
    }
    const decision_id = await emit(decision_class, {
      ...data,
      ...(criterionNegative !== null ? { criterion_negative: criterionNegative } : {}),
      decision_evidence: buildGoogleAdsDecisionEvidence("removal", args.rationale, args),
    });
    return { decision_id, decision_class, will_auto_apply: false };
  },
};
