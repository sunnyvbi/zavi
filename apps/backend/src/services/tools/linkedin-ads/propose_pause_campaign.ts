
import { z } from "zod";
import { getLinkedInCampaign, readLinkedInAdAnalytics, readLinkedInAdAnalyticsWithToken } from "@/services/connectors/linkedin-ads/client";
import type { ToolSpec } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import { isFounderChatOrder, isHumanAuthoredCommand, isRulesSteered } from "@/services/agents/untrusted-context";
import { LINKEDIN_SET_STATUS_CLASS, type LinkedInStatusBody } from "./_exec-action";
import { linkedinJudgedOn } from "./_objective";
import { readCampaignPauseSignal } from "./read_analytics";
import { LINKEDIN_ACCOUNT_NOT_IN_USE } from "./_wallet";

const RESULTS_UNREAD = "Zavi could not re-read this campaign's results when filing this card. Check its conversions and leads in LinkedIn Campaign Manager before approving.";
const RESULTS_UNREAD_WALLET = "Zavi could not re-read this campaign's results when filing this card. Check its conversions and leads on your LinkedIn Ads page in Zavi before approving.";

const inputSchema = z.object({
  campaign_id: z
    .string()
    .regex(/^\d{1,20}$/, "campaign_id must be a bare numeric LinkedIn campaign id")
    .describe("LinkedIn campaign id, from linkedin_ads_list_campaigns."),
  account_id: z
    .string()
    .regex(/^\d{1,20}$/, "account_id must be a bare numeric LinkedIn ad-account id")
    .describe("The ad account the campaign belongs to, from linkedin_ads_list_accounts."),
  rationale: z
    .string()
    .min(1)
    .max(500)
    .describe("Why it should stop, citing the numbers you read (spend, clicks, conversions, window)."),
});

type PauseTarget = { id: string; name: string; status: string | null; objective?: string | null; token?: string; funding_source?: string };

const REACH_NOTE =
  "This campaign's objective buys reach and clicks, not conversions, so zero conversions and leads are not waste and no pause card is filed for them. Judge it on impressions, reach and clicks instead.";

async function readPauseTarget(
  tenant_id: string,
  args: { campaign_id: string; account_id: string },
): Promise<PauseTarget | null> {
  const bindings = await import("@/services/ads-wallet/bindings");
  const bound = await bindings.findCampaignBinding(tenant_id, "linkedin", args.campaign_id);
  if (!bound) {
    const { linkedinAccountInUse } = await import("@/services/connectors/linkedin-ads/own-accounts");
    if (!(await linkedinAccountInUse(tenant_id, args.account_id))) throw LINKEDIN_ACCOUNT_NOT_IN_USE();
    return getLinkedInCampaign(tenant_id, args.account_id, args.campaign_id, { pauseCritical: true });
  }
  const account = await bindings.getAccountBinding(tenant_id, bound.account_binding_id);
  if (account.provider_account_id !== args.account_id) return null;
  const { linkedinCampaign } = await import("@/services/ads-wallet/adapters/linkedin");
  const { campaign, token } = await linkedinCampaign(tenant_id, bound.id, false, false, true);
  return { id: campaign.id, name: campaign.name, status: campaign.status, objective: campaign.objectiveType ?? null, token, funding_source: bound.funding_source };
}

function pauseBody(campaign: PauseTarget | null, args: { account_id: string; rationale: string }): LinkedInStatusBody {
  if (!campaign) {
    throw new ExpectedToolError(
      "linkedin_ads_campaign_not_found",
      "This campaign is no longer in your LinkedIn Ads account. Refresh the campaign list, then try again.",
    );
  }
  if (campaign.status !== "ACTIVE") {
    const label = campaign.name && campaign.name !== campaign.id ? `"${campaign.name}"` : "This campaign";
    throw new ExpectedToolError(
      "linkedin_ads_campaign_not_active",
      campaign.status === "PAUSED" ? `${label} is already paused.` : `${label} is not running, so there is nothing to pause.`,
    );
  }
  return {
    campaign_id: campaign.id,
    account_id: args.account_id,
    status: "PAUSED",
    name: campaign.name,
    rationale: args.rationale,
    ...(campaign.funding_source === "wallet" ? { funding_source: "wallet" as const } : {}),
  };
}

export async function readLinkedInPauseBody(
  tenant_id: string,
  args: { campaign_id: string; account_id: string; rationale: string },
): Promise<LinkedInStatusBody> {
  return pauseBody(await readPauseTarget(tenant_id, args), args);
}

async function checkedRationale(tenant_id: string, target: PauseTarget | null, body: LinkedInStatusBody): Promise<string> {
  if (linkedinJudgedOn(target?.objective) === "reach_and_clicks")
    throw new ExpectedToolError("linkedin_ads_pause_not_candidate", `No pause card filed. ${REACH_NOTE} The founder can still pause it from the campaign list.`, { pause_signal: "reach_and_clicks" });
  const token = target?.token;
  const check = await readCampaignPauseSignal(
    (o) => (token ? readLinkedInAdAnalyticsWithToken(token, body.account_id, o) : readLinkedInAdAnalytics(tenant_id, body.account_id, o)),
    body.campaign_id,
  ).catch(() => null);
  if (!check) return `${body.rationale}\n\n${body.funding_source === "wallet" ? RESULTS_UNREAD_WALLET : RESULTS_UNREAD}`;
  if (check.signal === "pause_candidate") return body.rationale;
  throw new ExpectedToolError("linkedin_ads_pause_not_candidate", `No pause card filed. ${check.note} The founder can still pause it from the campaign list.`, { pause_signal: check.signal });
}

export const linkedinAdsProposePauseCampaignTool: ToolSpec = {
  name: "linkedin_ads_propose_pause_campaign",
  effect: "write",
  description:
    "Propose pausing one ACTIVE LinkedIn Ads campaign. Your own proposal is refused unless its results re-read as a " +
    "pause_candidate (spend with zero results over the window, tracking verified); a CUT_CANDIDATE grade from linkedin_ads_analyst_brief rests on the same signal and adds nothing on its own. The founder's direct order is not checked. Files a card on the LinkedIn Ads channel's Actions tab; " +
    "nothing changes until the founder approves it. Only works on a linkedin_ads channel run.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const args = inputSchema.parse(input);
    if (typeof ctx.emit_decision !== "function") {
      throw new ExpectedToolError(
        "linkedin_ads_propose_not_channel_run",
        "This tool files a card on the LinkedIn Ads channel and only works on a linkedin_ads channel run.",
      );
    }
    const target = await readPauseTarget(ctx.tenant_id, args);
    const body = pauseBody(target, args);
    const founderOrder = isFounderChatOrder(ctx) && ctx.founder_order_unverified !== true && !isRulesSteered(ctx, "status");
    const rationale = founderOrder || isHumanAuthoredCommand(ctx, "status") ? body.rationale : await checkedRationale(ctx.tenant_id, target, body);
    const action_id = await ctx.emit_decision(LINKEDIN_SET_STATUS_CLASS, { ...body, rationale });
    return { action_id, status: "waiting_for_founder", campaign: { id: body.campaign_id, name: body.name } };
  },
};
