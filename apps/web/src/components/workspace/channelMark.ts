import { CHANNELS } from "@zavi/shared";
import { Mail, MessageSquareText, Newspaper, Radio, Search, Sparkles, type LucideIcon } from "lucide-react";

export type ChannelMark =
  | { kind: "logo"; src: string; bg: string; fit: "cover" | "contain" }
  | { kind: "glyph"; Icon: LucideIcon; bg: string; fg: string };

const LOGOS: Record<string, ChannelMark> = {
  meta_ads: { kind: "logo", src: "/logos/meta-icon.svg", bg: "bg-logo", fit: "contain" },
  google_ads: { kind: "logo", src: "/logos/google-ads-icon.svg", bg: "bg-logo", fit: "contain" },
  youtube_ads: { kind: "logo", src: "/logos/youtube-channel.svg", bg: "bg-logo", fit: "contain" },
  tiktok_ads: { kind: "logo", src: "/logos/tiktok-channel.svg", bg: "bg-black", fit: "cover" },
  linkedin_ads: { kind: "logo", src: "/logos/linkedin-channel.svg", bg: "bg-channel-linkedin", fit: "cover" },
  reddit_ads: { kind: "logo", src: "/logos/reddit-channel.svg", bg: "bg-channel-reddit", fit: "cover" },
  x_ads: { kind: "logo", src: "/logos/twitter-channel.svg", bg: "bg-black", fit: "cover" },
  chatgpt_ads: { kind: "logo", src: "/logos/openai-channel.svg", bg: "bg-black", fit: "contain" },

  seo: { kind: "glyph", Icon: Search, bg: "bg-channel-seo", fg: "text-white" },
  geo: { kind: "glyph", Icon: Sparkles, bg: "bg-channel-geo", fg: "text-white" },
  blog: { kind: "glyph", Icon: Newspaper, bg: "bg-[#0f766e]", fg: "text-white" },
  linkedin_organic: { kind: "logo", src: "/logos/linkedin-channel.svg", bg: "bg-channel-linkedin", fit: "cover" },
  reddit_organic: { kind: "logo", src: "/logos/reddit-channel.svg", bg: "bg-channel-reddit", fit: "cover" },
  x_organic: { kind: "logo", src: "/logos/twitter-channel.svg", bg: "bg-black", fit: "cover" },
  instagram_organic: { kind: "logo", src: "/logos/instagram-channel.svg", bg: "bg-logo", fit: "contain" },
  tiktok_organic: { kind: "logo", src: "/logos/tiktok-channel.svg", bg: "bg-black", fit: "cover" },
  pinterest_organic: { kind: "logo", src: "/logos/pinterest-channel.svg", bg: "bg-white", fit: "cover" },
  youtube_organic: { kind: "logo", src: "/logos/youtube-channel.svg", bg: "bg-logo", fit: "contain" },
  ugc: { kind: "logo", src: "/logos/ugc-channel.svg", bg: "bg-logo", fit: "contain" },
  generated_video: { kind: "logo", src: "/logos/ai-ugc-channel.svg", bg: "bg-logo", fit: "contain" },

  email_marketing: { kind: "glyph", Icon: Mail, bg: "bg-[#2563eb]", fg: "text-white" },
  sms: { kind: "glyph", Icon: MessageSquareText, bg: "bg-[#16a34a]", fg: "text-white" },
};

const FALLBACK: ChannelMark = {
  kind: "glyph",
  Icon: Radio,
  bg: "bg-creamDeep",
  fg: "text-inkSoft",
};

export function channelMark(slug: string): ChannelMark {
  return LOGOS[slug.replace(/[-.]/g, "_")] ?? FALLBACK;
}

export const MARKED_SLUGS = Object.keys(LOGOS);

const PAID = new Set<string>(
  CHANNELS.filter((c) => c.category === "paid").map((c) => c.slug),
);

export function isPaidChannel(slug: string): boolean {
  return PAID.has(slug.replace(/[-.]/g, "_"));
}
