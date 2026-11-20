import { listLinkedInCampaignGroups, readLinkedInCampaignGroupsByIdWithToken, type LinkedInAdCampaign, type LinkedInCampaignGroup } from "@/services/connectors/linkedin-ads/client";
import type { LinkedinAccountAccess } from "./_wallet";

export const CAMPAIGN_GROUP_LIST_LIMIT = 500;

export async function linkedinCampaignGroups(tenant_id: string, access: LinkedinAccountAccess, account_id: string, campaigns?: LinkedInAdCampaign[]): Promise<LinkedInCampaignGroup[]> {
  if (access.kind !== "wallet") return listLinkedInCampaignGroups(tenant_id, account_id, CAMPAIGN_GROUP_LIST_LIMIT);
  return readLinkedInCampaignGroupsByIdWithToken(access.token, account_id, ownCampaignGroupIds(campaigns ?? []));
}

export const ownCampaignGroupIds = (campaigns: ReadonlyArray<Pick<LinkedInAdCampaign, "campaign_group_id">>): string[] => [...new Set(campaigns.flatMap((c) => (c.campaign_group_id === null ? [] : [c.campaign_group_id])))];

export const groupNamesOf = (groups: LinkedInCampaignGroup[]): Map<string, string> => new Map(groups.map((g) => [g.id, g.name]));

export const campaignGroupRef = (campaign: Pick<LinkedInAdCampaign, "campaign_group_id">, names: Map<string, string>): { id: string; name: string | null } | null =>
  campaign.campaign_group_id === null ? null : { id: campaign.campaign_group_id, name: names.get(campaign.campaign_group_id) ?? null };
