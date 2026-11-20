import { z } from "zod";
import { withLinkedInAdsToken } from "@/services/connectors/linkedin-ads/client";
import { listLinkedInRawCreativesWithToken } from "@/services/connectors/linkedin-ads/write";
import { ExpectedToolError, type ToolSpec } from "@/services/tools/types";
import { LINKEDIN_SWAP_AD_CLASS, type LinkedInSwapAdBody } from "../_change-bodies";
import { adSourceFields, adSourceOf, associatedEntityOf, checkPostSource, exactlyOneSource, ONE_SOURCE_MESSAGE, refuseAdLimit, refuseEnded } from "./_ad-source";
import { readOwnCampaignTarget, requireChannelRun, emitLinkedInCard } from "./_own-target";

const inputSchema = z
  .object({
    campaign_id: z.string().regex(/^\d{1,20}$/).describe("LinkedIn campaign id, from linkedin_ads_list_campaigns."),
    account_id: z.string().regex(/^\d{1,20}$/).describe("The ad account the campaign belongs to."),
    old_creative_id: z.string().regex(/^\d{1,20}$/).describe("The ad to replace, from linkedin_ads_list_ads. It must be on."),
    ...adSourceFields,
    rationale: z.string().min(1).max(500).describe("Why replace it, citing the old ad's numbers (fatigue, CTR, cost per result)."),
  })
  .strict()
  .refine(exactlyOneSource, { message: ONE_SOURCE_MESSAGE });

type Args = z.infer<typeof inputSchema>;

export async function readLinkedInAdSwapBody(tenant_id: string, args: Args): Promise<LinkedInSwapAdBody> {
  const t = await readOwnCampaignTarget(tenant_id, args, "its ads are set when it is launched and Zavi does not swap them");
  const label = t.name !== t.id ? `"${t.name}"` : "This campaign";
  refuseEnded(t.status, label, "its ads cannot be swapped");
  const associated_entity = associatedEntityOf(t.live, label);
  const source = adSourceOf(args);
  return withLinkedInAdsToken(tenant_id, async (token) => {
    const ads = await listLinkedInRawCreativesWithToken(token, args.account_id, t.id);
    const old = ads.find((a) => a.creative_id === args.old_creative_id);
    if (!old) throw new ExpectedToolError("linkedin_ads_ad_not_found", `${label} has no ad ${args.old_creative_id}. Call linkedin_ads_list_ads and use an id from there.`);
    const old_ad_name = old.name ?? `Ad ${old.creative_id}`;
    if (old.intendedStatus !== "ACTIVE")
      throw new ExpectedToolError("linkedin_ads_ad_not_active", `The ad "${old_ad_name}" is ${old.intendedStatus?.toLowerCase() ?? "in an unknown state"}, not on, so there is nothing to replace. Use linkedin_ads_propose_new_ad to add an ad instead.`);
    refuseAdLimit(ads, label);
    await checkPostSource(token, source, associated_entity, ads, label);
    return {
      campaign_id: t.id,
      account_id: args.account_id,
      campaign_name: t.name,
      associated_entity,
      old_creative_id: old.creative_id,
      old_ad_name,
      source,
      rationale: args.rationale,
    };
  });
}

export const linkedinAdsProposeAdSwapTool: ToolSpec = {
  name: "linkedin_ads_propose_ad_swap",
  effect: "write",
  description:
    "Propose replacing one ad that is on in a LinkedIn Ads campaign in the founder's own ad account: a new ad from a company-page post (post_urn) or a new direct ad (inline) is added switched on, then the old ad is turned off. Files a card on the LinkedIn Ads channel's Actions tab for the founder, or cgo on Autopilot with an ad budget, to approve; if the old ad is no longer on at approval the card does nothing. A post from another page or one already used in the campaign is refused. Only works on a linkedin_ads channel run.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const args = inputSchema.parse(input);
    requireChannelRun(ctx);
    const body = await readLinkedInAdSwapBody(ctx.tenant_id, args);
    const action_id = await emitLinkedInCard(ctx, LINKEDIN_SWAP_AD_CLASS, body);
    return { action_id, status: "waiting_for_owner", campaign: { id: body.campaign_id, name: body.campaign_name }, old_ad: { id: body.old_creative_id, name: body.old_ad_name }, source: body.source };
  },
};
