
import { CHANNELS, type Channel } from "@zavi/shared";

export type FeedDecision = { id: string; channel_slug?: string | null };

const KNOWN = new Set<string>(CHANNELS.map((c) => c.slug));

const ORGANIC_STUB = {
  category: "organic",
  connectors: [],
  tools: [],
  measured_on: [],
  executor: "social",
  readiness: "planned",
} satisfies Omit<Channel, "slug" | "name" | "description">;

const UI_ONLY_CHANNELS: readonly Channel[] = [];

const NAME_OVERRIDE: Record<string, string> = {};

const VISIBLE_ORDER = [
  "meta_ads",
  "google_ads",
  "tiktok_ads",
  "linkedin_ads",
  "youtube_ads",
  "reddit_ads",
  "x_ads",
  "chatgpt_ads",
  "seo",
  "geo",
  "linkedin_organic",
  "reddit_organic",
  "x_organic",
  "instagram_organic",
  "tiktok_organic",
  "pinterest_organic",
  "youtube_organic",
  "ugc",
  "generated_video",
  "email_marketing",
  "sms",
] as const;

export const DISPLAY_CHANNELS: readonly Channel[] = VISIBLE_ORDER.map((slug) => {
  const base =
    (CHANNELS as readonly Channel[]).find((c) => c.slug === slug) ??
    UI_ONLY_CHANNELS.find((c) => c.slug === slug);
  if (!base) throw new Error(`unknown display channel: ${slug}`);
  const name = NAME_OVERRIDE[slug];
  return name ? { ...base, name } : base;
});

export function actionsByChannel<T extends FeedDecision>(
  decisions: readonly T[],
): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const d of decisions) {
    if (!d.channel_slug || !KNOWN.has(d.channel_slug)) continue;
    const list = m.get(d.channel_slug) ?? [];
    list.push(d);
    m.set(d.channel_slug, list);
  }
  return m;
}

export function orderedChannels(): Channel[] {
  return [...DISPLAY_CHANNELS];
}

export type ChannelWorkState = "idle" | "running" | "needs_review" | "delivered";

export type AttentionSignals = {
  pendingBySlug: ReadonlyMap<string, number>;
  stateBySlug: ReadonlyMap<string, ChannelWorkState | string>;
};

const STATE_TIER: Record<string, number> = { needs_review: 1, running: 2 };

export function sortChannelsByAttention(
  channels: readonly Channel[],
  { pendingBySlug, stateBySlug }: AttentionSignals,
): Channel[] {
  const tier = (slug: string) => {
    if ((pendingBySlug.get(slug) ?? 0) > 0) return 0;
    return STATE_TIER[stateBySlug.get(slug) ?? ""] ?? 3;
  };
  return channels
    .map((channel, index) => ({ channel, index, tier: tier(channel.slug) }))
    .sort((a, b) => a.tier - b.tier || a.index - b.index)
    .map((r) => r.channel);
}
