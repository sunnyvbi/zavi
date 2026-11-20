const LABELS: Record<string, string> = {
  meta_ads: "Meta",
  google_ads: "Google",
  youtube_ads: "YouTube",
  tiktok_ads: "TikTok",
  reddit_ads: "Reddit",
  linkedin_ads: "LinkedIn",
  chatgpt_ads: "ChatGPT",
};

export function channelLabel(slug: string): string {
  if (LABELS[slug]) return LABELS[slug];
  return slug
    .replace(/_ads$/, "")
    .split(/[_-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}
