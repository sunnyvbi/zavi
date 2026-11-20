
import { z } from "zod";
import { getCampaign, redditAdsAccount } from "@/services/connectors/reddit-ads/composio-read";
import type { ToolSpec } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import { REDDIT_SET_STATUS_CLASS, type RedditStatusBody } from "./_exec-action";

const inputSchema = z.object({
  campaign_id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/, "campaign_id must be a bare Reddit campaign id")
    .describe("Reddit campaign id, from reddit_ads_list_campaigns."),
  account_id: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/, "account_id must be a bare Reddit ad-account id")
    .describe("The ad account the campaign belongs to, from reddit_ads_list_accounts."),
  rationale: z
    .string()
    .min(1)
    .max(500)
    .describe("Why it should stop, citing the numbers you read (spend, clicks, conversions, window)."),
});

export const redditAdsProposePauseCampaignTool: ToolSpec = {
  name: "reddit_ads_propose_pause_campaign",
  effect: "write",
  description:
    "Propose pausing one ACTIVE Reddit Ads campaign. Files a card on the Reddit Ads channel's Actions tab; " +
    "nothing changes until the founder approves it. Only works on a Reddit Ads channel run. In chat, " +
    "use composio REDDIT_ADS_UPDATE_CAMPAIGN with configured_status PAUSED instead.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const args = inputSchema.parse(input);
    if (typeof ctx.emit_decision !== "function") {
      throw new ExpectedToolError(
        "reddit_ads_propose_not_channel_run",
        "This tool files a card on the Reddit Ads channel and only works on a Reddit Ads channel run. In a chat, propose the pause with composio REDDIT_ADS_UPDATE_CAMPAIGN (data.configured_status = PAUSED); the founder approves it there.",
      );
    }
    const campaign = await getCampaign(await redditAdsAccount(ctx.tenant_id), args.campaign_id);
    if (!campaign) {
      throw new ExpectedToolError("reddit_ads_campaign_not_found", `No campaign ${args.campaign_id} in the linked Reddit Ads account.`);
    }
    if (campaign.ad_account_id !== args.account_id) {
      throw new ExpectedToolError(
        "reddit_ads_campaign_account_mismatch",
        `Campaign ${args.campaign_id} belongs to ad account ${campaign.ad_account_id || "(none returned)"}, not ${args.account_id}.`,
      );
    }
    if (campaign.status !== "ACTIVE") {
      throw new ExpectedToolError(
        "reddit_ads_campaign_not_active",
        `Campaign "${campaign.name}" is ${campaign.status}, not ACTIVE, so there is nothing to pause.`,
      );
    }
    const body: RedditStatusBody = {
      campaign_id: campaign.campaign_id,
      ad_account_id: args.account_id,
      status: "PAUSED",
      name: campaign.name,
      rationale: args.rationale,
    };
    const action_id = await ctx.emit_decision(REDDIT_SET_STATUS_CLASS, body);
    return { action_id, status: "waiting_for_founder", campaign: { id: campaign.campaign_id, name: campaign.name } };
  },
};
