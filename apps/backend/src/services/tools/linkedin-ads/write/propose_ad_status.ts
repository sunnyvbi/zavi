import { z } from "zod";
import { withLinkedInAdsToken } from "@/services/connectors/linkedin-ads/client";
import { listLinkedInRawCreativesWithToken } from "@/services/connectors/linkedin-ads/write";
import { ExpectedToolError, type ToolSpec } from "@/services/tools/types";
import { LINKEDIN_AD_STATUS_CLASS, type LinkedInAdStatusBody } from "../_change-bodies";
import { readOwnCampaignTarget, requireChannelRun, emitLinkedInCard } from "./_own-target";

const numericId = z.string().regex(/^\d{1,20}$/);
const SWITCHABLE = new Set(["ACTIVE", "PAUSED", "DRAFT"]);

const inputSchema = z
  .object({
    creative_id: numericId.describe("The ad (creative) id, from linkedin_ads_list_ads."),
    campaign_id: numericId.describe("The campaign the ad belongs to."),
    account_id: numericId.describe("The ad account the campaign belongs to."),
    status: z.enum(["ACTIVE", "PAUSED"]).describe("ACTIVE turns the ad on, PAUSED turns it off."),
    rationale: z.string().min(1).max(500).describe("Why, citing the numbers you read for this ad."),
  })
  .strict();

export type AdStatusArgs = z.infer<typeof inputSchema>;

export async function readLinkedInAdStatusBody(tenant_id: string, args: AdStatusArgs): Promise<LinkedInAdStatusBody> {
  const t = await readOwnCampaignTarget(tenant_id, args, "Zavi does not switch its ads; its launch flow owns them");
  const ads = await withLinkedInAdsToken(tenant_id, (token) => listLinkedInRawCreativesWithToken(token, args.account_id, t.id));
  const ad = ads.find((a) => a.creative_id === args.creative_id);
  if (!ad) throw new ExpectedToolError("linkedin_ads_ad_not_found", `This ad is not in the campaign "${t.name}". Check linkedin_ads_list_ads, then try again.`);
  const ad_name = typeof ad.name === "string" && ad.name.trim() ? ad.name.trim() : `Ad ${args.creative_id}`;
  const label = `The ad "${ad_name}"`;
  const was = ad.intendedStatus ?? null;
  if (!was || !SWITCHABLE.has(was)) throw new ExpectedToolError("linkedin_ads_ad_not_switchable", `${label} is ${was ? was.toLowerCase().replace(/_/g, " ") : "in an unknown state"}, so it cannot be turned ${args.status === "ACTIVE" ? "on" : "off"}.`);
  if (was === args.status) throw new ExpectedToolError("linkedin_ads_change_empty", `${label} is already ${args.status === "ACTIVE" ? "on" : "off"}.`);
  if (args.status === "PAUSED" && t.status === "ACTIVE" && ads.filter((a) => a.intendedStatus === "ACTIVE").length <= 1)
    throw new ExpectedToolError("linkedin_ads_last_live_ad", `${label} is the only ad that is on in the running campaign "${t.name}". Turning it off would leave the campaign with nothing to show. Add another ad first, or pause the campaign with linkedin_ads_propose_pause_campaign.`);
  return { creative_id: args.creative_id, campaign_id: t.id, account_id: args.account_id, campaign_name: t.name, ad_name, expected_status: was as "ACTIVE" | "PAUSED" | "DRAFT", status: args.status, rationale: args.rationale };
}

export const linkedinAdsProposeAdStatusTool: ToolSpec = {
  name: "linkedin_ads_propose_ad_status",
  effect: "write",
  description:
    "Propose turning one ad in a LinkedIn Ads campaign on or off, in the founder's own ad account. Files a card on the LinkedIn Ads channel's Actions tab; turning an ad off can be approved by any workspace member, turning one on needs an owner or admin. Nothing is applied on its own, and if the ad changes state in LinkedIn before approval the card does nothing. The last ad that is on in a running campaign is never turned off. A campaign in Zavi's shared account is refused. Only works on a linkedin_ads channel run.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const args = inputSchema.parse(input);
    requireChannelRun(ctx);
    const body = await readLinkedInAdStatusBody(ctx.tenant_id, args);
    const action_id = await emitLinkedInCard(ctx, LINKEDIN_AD_STATUS_CLASS, body);
    return { action_id, status: body.status === "PAUSED" ? "waiting_for_approval" : "waiting_for_owner", ad: { id: body.creative_id, name: body.ad_name, was: body.expected_status, becomes: body.status }, campaign: { id: body.campaign_id, name: body.campaign_name } };
  },
};
