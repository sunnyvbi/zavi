import { z } from "zod";
import { gadsSearch } from "./_client";

const row = z.object({
  campaign: z.object({ id: z.union([z.string(), z.number()]).transform(String) }),
  asset: z.object({ imageAsset: z.object({ fullSize: z.object({ url: z.string().optional() }).optional() }).optional(), youtubeVideoAsset: z.object({ youtubeVideoId: z.string().optional() }).optional() }).optional(),
});
const cache = new Map<string, { value: Record<string, string[]>; expires: number }>();
const pending = new Map<string, Promise<Record<string, string[]>>>();

export function googleCampaignThumbnailUrls(values: readonly unknown[], ids: readonly string[]): Record<string, string[]> {
  const result: Record<string, string[]> = Object.fromEntries(ids.map((id) => [id, []]));
  for (const value of values) {
    const parsed = row.safeParse(value);
    if (!parsed.success || !result[parsed.data.campaign.id]) continue;
    const asset = parsed.data.asset;
    const video = asset?.youtubeVideoAsset?.youtubeVideoId;
    const candidates = [asset?.imageAsset?.fullSize?.url, video && /^[\w-]{11}$/.test(video) ? `https://i.ytimg.com/vi/${video}/hqdefault.jpg` : undefined];
    for (const candidate of candidates) {
      if (!candidate) continue;
      try {
        const url = new URL(candidate);
        const urls = result[parsed.data.campaign.id];
        if (url.protocol === "https:" && !url.username && !url.password && urls && !urls.includes(url.href) && urls.length < 6) urls.push(url.href);
      } catch {}
    }
  }
  return result;
}

export async function readGoogleCampaignThumbnails(tenantId: string, campaignIds: readonly string[], refresh = false): Promise<Record<string, string[]>> {
  const ids = [...new Set(campaignIds)].sort();
  if (!ids.length || ids.some((id) => !/^\d{1,30}$/.test(id))) throw new Error("Invalid campaign IDs");
  const key = `${tenantId}:${ids.join(",")}`;
  const hit = cache.get(key);
  if (!refresh && hit && hit.expires > Date.now()) return hit.value;
  const inflight = pending.get(key);
  if (inflight) return inflight;
  const request = Promise.allSettled(["campaign_asset", "ad_group_ad_asset_view", "asset_group_asset"].map((view) => gadsSearch(tenantId, `SELECT campaign.id, asset.image_asset.full_size.url, asset.youtube_video_asset.youtube_video_id FROM ${view} WHERE campaign.id IN (${ids.join(",")}) AND asset.type IN ('IMAGE', 'YOUTUBE_VIDEO') LIMIT 1000`)))
    .then((results) => {
      if (results.every((result) => result.status === "rejected")) throw new Error("Campaign media unavailable");
      const rows = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
      const value = googleCampaignThumbnailUrls(rows, ids);
      if (cache.size >= 128) { const oldest = cache.keys().next().value; if (oldest) cache.delete(oldest); }
      cache.set(key, { value, expires: Date.now() + (Object.values(value).some((urls) => !urls.length) ? 15_000 : 5 * 60_000) });
      return value;
    }).finally(() => pending.delete(key));
  pending.set(key, request);
  return request;
}
