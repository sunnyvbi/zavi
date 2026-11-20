import { z } from "zod";
import { withLinkedInAdsToken } from "@/services/connectors/linkedin-ads/client";
import { listLinkedInRawCreativesWithToken } from "@/services/connectors/linkedin-ads/write";
import { ExpectedToolError, type ToolSpec } from "@/services/tools/types";
import { LINKEDIN_CREATE_AD_CLASS, type LinkedInCreateAdBody } from "../_change-bodies";
import { adSourceFields, adSourceOf, associatedEntityOf, checkPostSource, countsAsAd, exactlyOneSource, ONE_SOURCE_MESSAGE, refuseAdLimit, refuseEnded } from "./_ad-source";
import { readOwnCampaignTarget, requireChannelRun, emitLinkedInCard } from "./_own-target";

const inputSchema = z
  .object({
    campaign_id: z.string().regex(/^\d{1,20}$/).describe("LinkedIn campaign id, from linkedin_ads_list_campaigns."),
    account_id: z.string().regex(/^\d{1,20}$/).describe("The ad account the campaign belongs to."),
    ...adSourceFields,
    go_live: z.boolean().default(false).describe("true switches the new ad on as soon as LinkedIn's review passes; false (default) adds it paused."),
    rationale: z.string().min(1).max(500).describe("Why this ad, citing the numbers you read on the campaign's current ads."),
  })
  .strict()
  .refine(exactlyOneSource, { message: ONE_SOURCE_MESSAGE });

type Args = z.infer<typeof inputSchema>;

export async function readLinkedInNewAdBody(tenant_id: string, args: Args): Promise<LinkedInCreateAdBody> {
  const t = await readOwnCampaignTarget(tenant_id, args, "its ads are set when it is launched and Zavi does not add to them");
  const label = t.name !== t.id ? `"${t.name}"` : "This campaign";
  refuseEnded(t.status, label, "no ad can be added");
  if (!t.status) throw new ExpectedToolError("linkedin_ads_status_unread", `LinkedIn did not return the status of ${label}, so Zavi cannot write a card against it.`);
  const associated_entity = associatedEntityOf(t.live, label);
  const source = adSourceOf(args);
  return withLinkedInAdsToken(tenant_id, async (token) => {
    const ads = await listLinkedInRawCreativesWithToken(token, args.account_id, t.id);
    refuseAdLimit(ads, label);
    await checkPostSource(token, source, associated_entity, ads, label);
    return {
      campaign_id: t.id,
      account_id: args.account_id,
      campaign_name: t.name,
      campaign_status: t.status as string,
      associated_entity,
      source,
      go_live: args.go_live,
      expected_ad_count: ads.filter(countsAsAd).length,
      rationale: args.rationale,
    };
  });
}

export const linkedinAdsProposeNewAdTool: ToolSpec = {
  name: "linkedin_ads_propose_new_ad",
  effect: "write",
  description:
    "Propose adding one ad to a LinkedIn Ads campaign in the founder's own ad account, either from an existing post of the company page (post_urn) or as a new direct ad (inline). Files a card on the LinkedIn Ads channel's Actions tab; nothing is created until it is approved, and if the campaign's ads change in LinkedIn before approval the card does nothing. Paused by default; go_live needs the founder, or cgo on Autopilot with an ad budget. A post from another page, a post already used in the campaign, an ended campaign and a campaign at LinkedIn's 100-ad limit are refused. Only works on a linkedin_ads channel run.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const args = inputSchema.parse(input);
    requireChannelRun(ctx);
    const body = await readLinkedInNewAdBody(ctx.tenant_id, args);
    const action_id = await emitLinkedInCard(ctx, LINKEDIN_CREATE_AD_CLASS, body);
    return { action_id, status: body.go_live ? "waiting_for_owner" : "waiting_for_approval", campaign: { id: body.campaign_id, name: body.campaign_name, ads_now: body.expected_ad_count }, source: body.source, go_live: body.go_live };
  },
};
