import { readLinkedInRawCampaign, type LiRawCampaign } from "@/services/connectors/linkedin-ads/write";
import { ExpectedToolError } from "@/services/tools/types";
import { LINKEDIN_ACCOUNT_NOT_IN_USE } from "../_wallet";
import { isFounderChatOrder, isHumanAuthoredCommand } from "@/services/agents/untrusted-context";
import { LINKEDIN_AGENT_ORIGIN, type LinkedInCardOrigin } from "../_change-bodies";

export type OwnCampaignTarget = { id: string; name: string; status: string | null; objective: string | null; live: LiRawCampaign };

export const WALLET_MANAGED = (what: string) =>
  new ExpectedToolError(
    "linkedin_ads_wallet_campaign",
    `This campaign runs in Zavi's shared LinkedIn ad account and is paid from the founder's Zavi wallet, so ${what}. Say so in the report instead of proposing it.`,
  );

export async function readOwnCampaignTarget(tenant_id: string, args: { campaign_id: string; account_id: string }, what: string): Promise<OwnCampaignTarget> {
  const bindings = await import("@/services/ads-wallet/bindings");
  const bound = await bindings.findCampaignBinding(tenant_id, "linkedin", args.campaign_id);
  if (bound?.funding_source === "wallet") throw WALLET_MANAGED(what);
  const { linkedinAccountInUse } = await import("@/services/connectors/linkedin-ads/own-accounts");
  if (!(await linkedinAccountInUse(tenant_id, args.account_id))) throw LINKEDIN_ACCOUNT_NOT_IN_USE();
  const live = await readLinkedInRawCampaign(tenant_id, args.account_id, args.campaign_id);
  if (!live) throw new ExpectedToolError("linkedin_ads_campaign_not_found", "This campaign is not in this LinkedIn Ads account. Refresh the campaign list, then try again.");
  const id = String(live.id);
  return { id, name: live.name ?? id, status: live.status ?? null, objective: live.objectiveType ?? live.type ?? null, live };
}

export function requireChannelRun(ctx: { emit_decision?: unknown }): void {
  if (typeof ctx.emit_decision !== "function")
    throw new ExpectedToolError("linkedin_ads_propose_not_channel_run", "This tool files a card on the LinkedIn Ads channel and only works on a linkedin_ads channel run.");
}

type CardCtx = Parameters<typeof isHumanAuthoredCommand>[0] & Parameters<typeof isFounderChatOrder>[0] & { emit_decision?: unknown };

export function linkedinCardOriginOf(ctx: CardCtx): LinkedInCardOrigin {
  return isFounderChatOrder(ctx) || isHumanAuthoredCommand(ctx) ? "user_initiated_chat" : LINKEDIN_AGENT_ORIGIN;
}

export async function emitLinkedInCard(ctx: CardCtx, execClass: string, body: object): Promise<string> {
  requireChannelRun(ctx);
  return (ctx.emit_decision as (c: string, b: unknown) => Promise<string>)(execClass, { ...body, origin: linkedinCardOriginOf(ctx) });
}
