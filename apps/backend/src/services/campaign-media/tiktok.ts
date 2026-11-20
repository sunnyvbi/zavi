import { tiktokAdsAccount, tt } from "@/services/connectors/tiktok-ads/composio-read";
import { ensureAdAccounts } from "@/services/connectors/tiktok-ads/ad-accounts";
import { addMedia, emptyThumbnails, inGroups, isRecord, stringId } from "./media";

export async function tiktokCampaignMedia(tenantId: string, ids: readonly string[]) {
  const result = emptyThumbnails(ids);
  const [account, advertisers] = await Promise.all([tiktokAdsAccount(tenantId), ensureAdAccounts(tenantId)]);
  const selected = [...advertisers.accounts].sort((a, b) => Number(b.advertiser_id === advertisers.selected_id) - Number(a.advertiser_id === advertisers.selected_id)).slice(0, 10);
  await inGroups(selected, async (advertiser) => {
    const videos = new Map<string, Set<string>>();
    const images = new Map<string, Set<string>>();
    const references = new Map<string, number>();
    const add = (map: Map<string, Set<string>>, id: string, campaign: string) => { if (map.get(id)?.has(campaign) || (references.get(campaign) ?? 0) >= 3) return; references.set(campaign, (references.get(campaign) ?? 0) + 1); const campaigns = map.get(id) ?? new Set<string>(); campaigns.add(campaign); map.set(id, campaigns); };
    for (let page = 1; page <= 5; page++) {
      const params = new URLSearchParams({ advertiser_id: advertiser.advertiser_id, filtering: JSON.stringify({ campaign_ids: ids }), fields: JSON.stringify(["campaign_id", "ad_id", "video_id", "image_ids"]), page: String(page), page_size: "1000" });
      const data = await tt(account, `/ad/get/?${params}`);
      for (const item of Array.isArray(data.list) ? data.list : []) {
        if (!isRecord(item)) continue;
        const campaign = stringId(item.campaign_id);
        if (!campaign || !result[campaign]) continue;
        addMedia(result, campaign, item);
        const video = stringId(item.video_id);
        if (video) add(videos, video, campaign);
        for (const image of Array.isArray(item.image_ids) ? item.image_ids : []) { const id = stringId(image); if (id) add(images, id, campaign); }
      }
      const total = isRecord(data.page_info) ? Number(data.page_info.total_page ?? 1) : 1;
      if (page >= total || ids.every((id) => result[id]?.length || (references.get(id) ?? 0) >= 3)) break;
    }
    for (const [kind, objects] of [["video", videos], ["image", images]] as const) {
      const mediaIds = [...objects.keys()];
      for (let offset = 0; offset < mediaIds.length; offset += 100) {
        const params = new URLSearchParams({ advertiser_id: advertiser.advertiser_id, [`${kind}_ids`]: JSON.stringify(mediaIds.slice(offset, offset + 100)) });
        const data = await tt(account, `/file/${kind}/ad/info/?${params}`);
        for (const item of Array.isArray(data.list) ? data.list : []) {
          if (!isRecord(item)) continue;
          const id = stringId(item[`${kind}_id`]);
          for (const campaign of id ? objects.get(id) ?? [] : []) addMedia(result, campaign, item);
        }
      }
    }
  }, 2);
  return result;
}
