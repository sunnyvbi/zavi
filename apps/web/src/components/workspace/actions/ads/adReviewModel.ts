import { adReviewCreativeSchema, adReviewPresentationSchema, isChannelSlug, type AdReviewCreative, type AdReviewPresentation, type ChannelSlug } from "@zavi/shared";
import { adCreatives } from "./adCreative";
import { deliverableOf, deliverableParts, exactChangeRows, mediaOf, type ActionItem } from "../types";

export type AdPreviewFormat = "feed" | "search" | "video" | "vertical" | "conversation";

const FORMATS: Partial<Record<ChannelSlug, AdPreviewFormat>> = {
  meta_ads: "feed", google_ads: "search", youtube_ads: "video", tiktok_ads: "vertical",
  linkedin_ads: "feed", reddit_ads: "feed", x_ads: "feed", chatgpt_ads: "conversation",
};

export interface AdReviewModel {
  channelSlug: string;
  creatives: AdReviewCreative[];
  format: AdPreviewFormat;
  cost: string | null;
  provenance: string | null;
  schedule: AdReviewPresentation["schedule"] | null;
  draftOnly: boolean;
  showPreview: boolean;
  kind: string;
}

export function adCtaLabel(value: string | undefined): string | null {
  const words = value?.trim().replace(/_/g, " ").toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : null;
}

function draftCreatives(action: ActionItem, saved: AdReviewCreative[]): AdReviewCreative[] {
  if (saved.length) return saved;
  if (action.body?.step?.deliverable?.presentation) return [];
  const draft = deliverableOf(action);
  if (draft?.kind !== "ad") return [];
  const parts = deliverableParts(action);
  return (parts ?? [{ content: draft.content }]).map((part) => ({ body: part.content }));
}

export function adReviewModel(action: ActionItem): AdReviewModel {
  const parsed = adReviewPresentationSchema.safeParse(action.body?.ad_review);
  const review = parsed.success ? parsed.data : null;
  const saved = adCreatives(action).flatMap((creative) => {
    const result = adReviewCreativeSchema.safeParse(creative);
    return result.success ? [result.data] : [];
  });
  const creatives = review?.creatives.length ? review.creatives : draftCreatives(action, saved);
  const media = mediaOf(action);
  if (media && (!review?.creatives.length || (creatives.length === 1 && !creatives[0].image_url && !creatives[0].image_path && !creatives[0].video_url))) {
    const data = adReviewCreativeSchema.safeParse({
      ...creatives[0], ...(media.kind === "image" ? { image_url: media.url } : { video_url: media.url }),
    });
    if (data.success) {
      if (creatives.length) creatives[0] = data.data;
      else creatives.push(data.data);
    }
  }
  const budget = exactChangeRows(action).find((row) => /budget|spend cap|lifetime cap/i.test(row.item));
  const draftOnly = !review?.creatives.length && saved.length === 0 && !media;
  const video = creatives.some((creative) => creative.media_kind === "video" || creative.video_url || creative.youtube_video_id);
  const format = action.channel_slug === "google_ads" && video ? "video" : action.channel_slug === "google_ads" && creatives.some((creative) => creative.image_url || creative.image_path) ? "feed" : (isChannelSlug(action.channel_slug) ? FORMATS[action.channel_slug] : undefined) ?? "feed";
  return {
    channelSlug: action.channel_slug, creatives, format, cost: review?.cost ?? budget?.after ?? null,
    provenance: review?.provenance ?? creatives.find((creative) => creative.source)?.source ?? (saved.length ? "Saved campaign draft" : null),
    schedule: review?.schedule ?? null, draftOnly,
    showPreview: action.action_type === "create_ad" || creatives.length > 0,
    kind: video ? "Video ad" : creatives.some((creative) => creative.media_kind === "image" || creative.image_url || creative.image_path) ? "Image ad" : "Ad",
  };
}
