
import { z } from "zod";
import { adStatesByCampaign, campaignDelivery } from "@/services/connectors/linkedin-ads/ad-delivery";
import { listLinkedInCampaigns, readLinkedInAdStates, readLinkedInAdStatesWithToken, toAdCampaign, type LiCampaign, type LinkedInAdCampaign } from "@/services/connectors/linkedin-ads/client";
import type { ToolSpec } from "@/services/tools/types";
import { campaignGroupRef, groupNamesOf, linkedinCampaignGroups } from "./_groups";
import { linkedinAccountAccess, type LinkedinAccountAccess } from "./_wallet";

export async function walletCampaigns(tenantId: string, access: Extract<LinkedinAccountAccess, { kind: "wallet" }>, limit: number): Promise<LinkedInAdCampaign[]> {
  const { goneLinkedinCampaignIds, linkedinCampaign } = await import("@/services/ads-wallet/adapters/linkedin");
  const gone = await goneLinkedinCampaignIds(tenantId);
  const live = access.group.campaignBindingIds.filter((id) => !gone.has(id)).slice(0, limit);
  const read = await Promise.allSettled(live.map((id) => linkedinCampaign(tenantId, id)));
  const failed = read.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) throw failed.reason;
  return read.flatMap((r) => (r.status === "fulfilled" ? [toAdCampaign(r.value.campaign as unknown as LiCampaign)] : []));
}

const inputSchema = z.object({
  account_id: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[1-9]\d*$/, "account_id must be a numeric LinkedIn ad-account id")
    .describe("LinkedIn Ads account id, from linkedin_ads_list_accounts."),
  limit: z.number().int().min(1).max(500).optional().default(100),
});

export const linkedinAdsListCampaignsTool: ToolSpec = {
  name: "linkedin_ads_list_campaigns",
  effect: "read",
  description:
    "List campaigns in one LinkedIn Ads ad account with status, objective, budget, delivery, delivery_note and the campaign_group " +
    "(id and name) each belongs to; a LinkedIn campaign is Meta's ad set and a campaign group is Meta's campaign. " +
    "ACTIVE only means switched on: say spending only as delivery_note allows. Read-only — never " +
    "edits or spends. Get account_id from linkedin_ads_list_accounts first.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const { account_id, limit } = inputSchema.parse(input);
    const access = await linkedinAccountAccess(ctx.tenant_id, account_id);
    const campaigns = access.kind === "wallet" ? await walletCampaigns(ctx.tenant_id, access, limit) : await listLinkedInCampaigns(ctx.tenant_id, account_id, limit);
    const [ads, names] = await Promise.all([
      adStatesByCampaign(campaigns, (ids) => (access.kind === "wallet" ? readLinkedInAdStatesWithToken(access.token, account_id, ids) : readLinkedInAdStates(ctx.tenant_id, account_id, ids))),
      linkedinCampaignGroups(ctx.tenant_id, access, account_id, campaigns)
        .then(groupNamesOf)
        .catch(() => new Map<string, string>()),
    ]);
    return {
      account_id,
      count: campaigns.length,
      campaigns: campaigns.map((c) => ({ ...c, campaign_group: campaignGroupRef(c, names), ...campaignDelivery(c.status, ads ? (ads.get(c.id) ?? []) : null) })),
    };
  },
};
