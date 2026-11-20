import type { CampaignMediaChannel } from "@zavi/shared";
import { readCampaignThumbnails } from "@/services/tools/meta-ads/campaign-thumbnails";
import { readGoogleCampaignThumbnails } from "@/services/tools/google-ads/campaign-thumbnails";
import { chatgptCampaignMedia } from "./chatgpt";
import { linkedinCampaignMedia, type CampaignMediaLevel } from "./linkedin";
import { redditCampaignMedia } from "./reddit";
import { tiktokCampaignMedia } from "./tiktok";
import { xCampaignMedia } from "./x";
import type { CampaignThumbnails } from "./media";

const providers = { tiktok_ads: tiktokCampaignMedia, linkedin_ads: linkedinCampaignMedia, reddit_ads: redditCampaignMedia, x_ads: xCampaignMedia, chatgpt_ads: chatgptCampaignMedia };
const cache = new Map<string, { value: CampaignThumbnails; expires: number }>();
const pending = new Map<string, Promise<CampaignThumbnails>>();

export function validCampaignMediaIds(channel: CampaignMediaChannel, ids: readonly string[]): boolean {
  const pattern = channel === "x_ads" ? /^[a-z0-9]{1,32}$/ : channel === "chatgpt_ads" ? /^[\w-]{1,200}$/ : channel === "reddit_ads" ? /^[\w-]{1,64}$/ : /^\d{1,32}$/;
  return ids.length > 0 && ids.length <= 50 && ids.every((id) => pattern.test(id));
}

export async function readChannelCampaignMedia(tenantId: string, channel: CampaignMediaChannel, campaignIds: readonly string[], refresh = false, level: CampaignMediaLevel = "campaign"): Promise<CampaignThumbnails> {
  if (!validCampaignMediaIds(channel, campaignIds)) throw new Error("Invalid campaign IDs");
  if (level === "ad" && channel !== "linkedin_ads") throw new Error("Ad-level media is LinkedIn only");
  if (channel === "meta_ads") return readCampaignThumbnails(tenantId, campaignIds, refresh);
  if (channel === "google_ads" || channel === "youtube_ads") return readGoogleCampaignThumbnails(tenantId, campaignIds, refresh);
  const ids = [...new Set(campaignIds)].sort();
  const key = `${tenantId}:${channel}:${level}:${ids.join(",")}`;
  const hit = cache.get(key);
  if (!refresh && hit && hit.expires > Date.now()) return hit.value;
  const inflight = pending.get(key);
  if (inflight) return inflight;
  const request = (level === "ad" ? linkedinCampaignMedia(tenantId, ids, "ad") : providers[channel](tenantId, ids)).then((value) => {
    if (cache.size >= 128) { const oldest = cache.keys().next().value; if (oldest) cache.delete(oldest); }
    cache.set(key, { value, expires: Date.now() + (!Object.keys(value).length || Object.values(value).some((urls) => !urls.length) ? 15_000 : 5 * 60_000) });
    return value;
  }).finally(() => pending.delete(key));
  pending.set(key, request);
  return request;
}
