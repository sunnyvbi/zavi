import { z } from "zod";
import { fbGet, metaAdsCreds } from "./_client";

const image = z.object({ url: z.string().nullish() });
const creative = z.object({
  thumbnail_url: z.string().nullish(), image_url: z.string().nullish(),
  object_story_spec: z.object({
    video_data: z.object({ image_url: z.string().nullish() }).nullish(),
    link_data: z.object({ image_hash: z.string().nullish(), picture: z.string().nullish(), child_attachments: z.array(z.object({ picture: z.string().nullish() })).nullish() }).nullish(),
  }).nullish(),
  asset_feed_spec: z.object({ images: z.array(image).nullish() }).nullish(),
});
const campaign = z.object({ account_id: z.string().optional(), ads: z.object({ data: z.array(z.object({ effective_status: z.string().nullish(), creative: creative.nullish() })) }).nullish() });
const response = z.record(z.string(), campaign);
const cache = new Map<string, { expires: number; value: Record<string, string[]> }>();
const pending = new Map<string, Promise<Record<string, string[]>>>();
const TTL = 5 * 60_000;

function safeUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    const expiration = url.searchParams.get("oe");
    if (expiration && /^[a-f\d]+$/i.test(expiration) && parseInt(expiration, 16) * 1000 < Date.now() + TTL) return null;
    return url.href;
  } catch { return null; }
}

export function campaignThumbnailUrls(raw: unknown, ids: readonly string[], accountId: string): Record<string, string[]> {
  const parsed = response.safeParse(raw);
  if (!parsed.success) return Object.fromEntries(ids.map((id) => [id, []]));
  return Object.fromEntries(ids.map((id) => {
    if (parsed.data[id]?.account_id?.replace(/^act_/, "") !== accountId.replace(/^act_/, "")) return [id, []];
    const ads = [...(parsed.data[id]?.ads?.data ?? [])].sort((a, b) => Number(b.effective_status === "ACTIVE") - Number(a.effective_status === "ACTIVE"));
    const urls = ads.flatMap(({ creative: c }) => c ? [c.thumbnail_url, c.image_url, c.object_story_spec?.video_data?.image_url, c.object_story_spec?.link_data?.picture, ...(c.object_story_spec?.link_data?.child_attachments ?? []).map((child) => child.picture), ...(c.asset_feed_spec?.images ?? []).map((item) => item.url)] : []).flatMap((url) => { const valid = safeUrl(url); return valid ? [valid] : []; });
    return [id, [...new Set(urls)].slice(0, 6)];
  }));
}

export async function readCampaignThumbnails(tenantId: string, campaignIds: readonly string[], refresh = false): Promise<Record<string, string[]>> {
  const ids = [...new Set(campaignIds)].sort();
  if (!ids.length || ids.some((id) => !/^\d{1,32}$/.test(id))) throw new Error("Invalid campaign IDs");
  const creds = await metaAdsCreds(tenantId);
  const key = `${tenantId}:${creds.ad_account_id}:${ids.join(",")}`;
  const hit = cache.get(key);
  if (!refresh && hit && hit.expires > Date.now()) return hit.value;
  const inflight = pending.get(key);
  if (inflight) return inflight;
  const read = fbGet(tenantId, "", {
    ids: ids.join(","),
    fields: "id,account_id,ads.limit(50){effective_status,creative{thumbnail_url,image_url,object_story_spec{video_data{image_url},link_data{picture,child_attachments{picture}}},asset_feed_spec{images}}}",
  }).then((raw) => {
    const value = campaignThumbnailUrls(raw, ids, creds.ad_account_id);
    if (cache.size >= 128) { const oldest = cache.keys().next().value; if (oldest) cache.delete(oldest); }
    cache.set(key, { expires: Date.now() + (Object.values(value).some((urls) => !urls.length) ? 15_000 : TTL), value });
    return value;
  }).finally(() => pending.delete(key));
  pending.set(key, read);
  return read;
}
