import { createElement } from "react";
import { z } from "zod";
import { isAdImagePath } from "@zavi/shared";
import { CampaignThumbnail } from "./CampaignThumbnail";

const fields = z.object({ thumbnail_url: z.string().nullish(), image_url: z.string().nullish(), image_path: z.string().nullish(), cover_url: z.string().nullish(), video_thumbnail_url: z.string().nullish() });
const media = fields.extend({ creative: fields.nullish(), ads: z.array(fields.extend({ creative: fields.nullish() })).nullish() });

function validImage(value: string | null | undefined): value is string {
  if (!value) return false;
  if (isAdImagePath(value)) return true;
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password; } catch { return false; }
}

export function campaignImageUrls(value: unknown): string[] {
  const parsed = media.safeParse(value);
  if (!parsed.success) return [];
  const values = [parsed.data, parsed.data.creative, ...(parsed.data.ads ?? []).flatMap((ad) => [ad, ad.creative])];
  return [...new Set(values.flatMap((item) => item ? [item.thumbnail_url, item.image_url, item.image_path, item.cover_url, item.video_thumbnail_url] : []).filter(validImage))];
}

export function adThumbnail(channel: string, adId: string, name: string, campaignIds: string, adSetId?: string) {
  return createElement(CampaignThumbnail, { key: `${channel}:ad:${adId}`, channel, campaignId: adId, campaignIds, name, level: "ad", fallbackId: adSetId });
}

export function campaignThumbnail(channel: string, campaign: unknown, campaignId: string, name: string, campaignIds = campaignId) {
  return createElement(CampaignThumbnail, { key: `${channel}:${campaignId}`, channel, campaignId, campaignIds, name, images: campaignImageUrls(campaign) });
}
