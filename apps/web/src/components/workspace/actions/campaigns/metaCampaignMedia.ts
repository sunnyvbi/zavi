import type { CampaignMediaChannel } from "@zavi/shared";
import { z } from "zod";
import { createBrowserSupabase } from "@/lib/supabase";
import { apiFetch } from "@/lib/api";
import { getActiveTenantId } from "@/lib/active-tenant-client";
import { PERFORMANCE_MARKETER_SLUG } from "@/lib/agentRegistry";

const response = z.object({ thumbnails: z.record(z.string(), z.array(z.string().url())) });
type Thumbnails = Record<string, string[]>;
export type CampaignMediaLevel = "campaign" | "ad";
const cache = new Map<string, { expires: number; request: Promise<Thumbnails> }>();

export function metaCampaignThumbnailUrl(ids: readonly string[], refresh: boolean, channel: CampaignMediaChannel = "meta_ads", level: CampaignMediaLevel = "campaign"): string {
  const params = new URLSearchParams({ campaign_ids: ids.join(","), channel, ...(level === "ad" ? { level } : {}), ...(refresh ? { refresh: "1" } : {}) });
  return `/api/agents/${PERFORMANCE_MARKETER_SLUG}/campaign-thumbnails?${params.toString()}`;
}

export async function loadMetaCampaignThumbnails(campaignIds: readonly string[], refresh = false, channel: CampaignMediaChannel = "meta_ads", level: CampaignMediaLevel = "campaign"): Promise<Thumbnails> {
  const tenant = await getActiveTenantId(createBrowserSupabase());
  if (!tenant) throw new Error("No active workspace");
  const ids = [...new Set(campaignIds)].sort();
  const key = `${tenant}:${channel}:${level}:${ids.join(",")}:${refresh}`;
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.request;
  const request = Promise.all(Array.from({ length: Math.ceil(ids.length / 50) }, (_, index) => ids.slice(index * 50, (index + 1) * 50)).map(async (chunk) => {
    const result = await apiFetch(metaCampaignThumbnailUrl(chunk, refresh, channel, level), { signal: AbortSignal.timeout(20_000) });
    if (!result.ok) throw new Error("Campaign media unavailable");
    return response.parse(await result.json()).thumbnails;
  })).then((chunks) => chunks.reduce<Thumbnails>((all, chunk) => ({ ...all, ...chunk }), {}));
  if (cache.size >= 64) { const oldest = cache.keys().next().value; if (oldest) cache.delete(oldest); }
  const entry = { expires: Number.POSITIVE_INFINITY, request };
  cache.set(key, entry);
  void request.then((result) => { entry.expires = Date.now() + (!Object.keys(result).length || Object.values(result).some((urls) => !urls.length) ? 15_000 : 5 * 60_000); }, () => { cache.delete(key); });
  return request;
}
