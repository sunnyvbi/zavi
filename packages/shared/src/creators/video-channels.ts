
export const CREATOR_VIDEO_CHANNELS = [
  "meta_ads",
  "tiktok_ads",
  "youtube_ads",
  "tiktok_organic",
  "instagram_organic",
  "youtube_organic",
] as const;

export type CreatorVideoChannel = (typeof CREATOR_VIDEO_CHANNELS)[number];

export type CreatorVideoChannelSpec = {
  slug: CreatorVideoChannel;
  name: string;
  placement: string;
  platform: "Instagram" | "TikTok" | "YouTube";
  use: "ad" | "post";
  push: "meta" | "youtube" | null;
};

export const CREATOR_VIDEO_CHANNEL_SPECS: Record<CreatorVideoChannel, CreatorVideoChannelSpec> = {
  meta_ads: { slug: "meta_ads", name: "Meta Ads", placement: "Instagram and Facebook Reels", platform: "Instagram", use: "ad", push: "meta" },
  tiktok_ads: { slug: "tiktok_ads", name: "TikTok Ads", placement: "TikTok in-feed ads", platform: "TikTok", use: "ad", push: null },
  youtube_ads: { slug: "youtube_ads", name: "YouTube Ads", placement: "YouTube Shorts ads", platform: "YouTube", use: "ad", push: "youtube" },
  tiktok_organic: { slug: "tiktok_organic", name: "TikTok", placement: "Your TikTok account", platform: "TikTok", use: "post", push: null },
  instagram_organic: { slug: "instagram_organic", name: "Instagram", placement: "Your Instagram Reels", platform: "Instagram", use: "post", push: null },
  youtube_organic: { slug: "youtube_organic", name: "YouTube", placement: "Your YouTube Shorts", platform: "YouTube", use: "post", push: null },
};

export const CREATOR_VIDEO_PREFILL = {
  format: "Vertical 9:16, 30 seconds",
  video_length_seconds: 30,
  ad_rights_days: 90,
  deliverables: 1,
} as const;

export function isCreatorVideoChannel(slug: unknown): slug is CreatorVideoChannel {
  return typeof slug === "string" && (CREATOR_VIDEO_CHANNELS as readonly string[]).includes(slug);
}
