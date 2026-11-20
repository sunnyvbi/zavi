import { getChatgptAdsApiKey } from "@/services/connectors/chatgpt-ads/key-provider";
import { chatgptAdsGet, type ChatgptAdsQuery } from "@/services/connectors/chatgpt-ads/http";
import { listChatgptAdsCampaigns } from "@/services/connectors/chatgpt-ads/client";
import { ownsCampaignName, resolveTenantCampaignPrefix } from "@/services/connectors/chatgpt-ads/tenant-scope";
import { addSavedChatgptMedia } from "./chatgpt-sources";
import { addMedia, emptyThumbnails, inGroups, isRecord, stringId } from "./media";

async function list(key: string, path: string, query: ChatgptAdsQuery): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  let after: string | undefined;
  for (let page = 0; page < 5; page++) {
    const data = await chatgptAdsGet<unknown>(key, path, { ...query, limit: 100, after });
    if (!isRecord(data) || !Array.isArray(data.data)) throw new Error("Unreadable campaign media");
    rows.push(...data.data.filter(isRecord));
    if (!data.has_more) return rows;
    const next = stringId(data.last_id);
    if (!next || next === after) break;
    after = next;
  }
  throw new Error("Campaign media list incomplete");
}

export async function chatgptCampaignMedia(tenantId: string, ids: readonly string[]) {
  const result = emptyThumbnails(ids);
  const files = new Map<string, Set<string>>();
  const [key, prefix] = await Promise.all([getChatgptAdsApiKey(), resolveTenantCampaignPrefix(tenantId)]);
  const inventory = await listChatgptAdsCampaigns(key);
  const campaigns = inventory.campaigns.filter((campaign) => Object.hasOwn(result, campaign.id) && ownsCampaignName(campaign.name, prefix));
  await inGroups(campaigns, async (campaign) => {
    const groups = await list(key, "/ad_groups", { campaign_id: campaign.id });
    await inGroups(groups.filter((group) => group.campaign_id == null || group.campaign_id === campaign.id), async (group) => {
      const groupId = stringId(group.id);
      if (!groupId) return;
      const ads = await list(key, "/ads", { ad_group_id: groupId });
      for (const ad of ads) {
        if (ad.campaign_id != null && ad.campaign_id !== campaign.id || ad.ad_group_id != null && ad.ad_group_id !== groupId) continue;
        addMedia(result, campaign.id, { creative: ad.creative });
        const fileId = isRecord(ad.creative) ? stringId(ad.creative.file_id) : null;
        if (fileId && ([...files.values()].filter((owners) => owners.has(campaign.id)).length < 3 || files.get(fileId)?.has(campaign.id))) { const owners = files.get(fileId) ?? new Set<string>(); owners.add(campaign.id); files.set(fileId, owners); }
      }
    }, 2);
  }, 2);
  await addSavedChatgptMedia(tenantId, files, result).catch(() => undefined);
  return result;
}
