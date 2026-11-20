
import { SOCIAL_LIMITS, satisfyingSlugs, railFor } from "@zavi/shared";

export const SOCIAL_SLUGS = [
  "linkedin_social",
  "x_social",
  "reddit_social",
  "instagram_social",
  "tiktok",
  "composio.pinterest",
  "composio.youtube",
] as const;

export type SocialSlug = (typeof SOCIAL_SLUGS)[number];

export const SOCIAL_ROW_SLUGS: readonly string[] = SOCIAL_SLUGS.flatMap((s) => satisfyingSlugs(s));

export const SOCIAL_CHANNEL_CONNECTOR: Record<keyof typeof SOCIAL_LIMITS, SocialSlug> = {
  linkedin: "linkedin_social",
  linkedin_image: "linkedin_social",
  linkedin_video: "linkedin_social",
  x: "x_social",
  x_image: "x_social",
  x_video: "x_social",
  reddit: "reddit_social",
  reddit_comment: "reddit_social",
  instagram_image: "instagram_social",
  instagram_video: "instagram_social",
  youtube_video: "composio.youtube",
  tiktok_video: "tiktok",
  pinterest_pin: "composio.pinterest",
};

export const SOCIAL_PLATFORM_LABEL: Record<SocialSlug, string> = {
  linkedin_social: "LinkedIn",
  x_social: "X",
  reddit_social: "Reddit",
  instagram_social: "Instagram",
  tiktok: "TikTok",
  "composio.pinterest": "Pinterest",
  "composio.youtube": "YouTube",
};

export type SocialConnectorMetaRow = {
  slug: string;
  team_name?: string | null;
  team_id?: string | null;
  connected_at?: string | null;
};

export function socialConnectorSlug(channel: string): SocialSlug | null {
  return (SOCIAL_CHANNEL_CONNECTOR as Record<string, SocialSlug>)[channel] ?? null;
}

export function socialPlatformLabel(channel: string): string {
  const slug = socialConnectorSlug(channel);
  return slug ? SOCIAL_PLATFORM_LABEL[slug] : channel.replace(/_/g, " ");
}

export function socialAccountName(
  channel: string,
  rows: readonly SocialConnectorMetaRow[],
): { connected: boolean; name: string | null } {
  const row = socialConnectorRow(channel, rows);
  if (!row) return { connected: false, name: null };
  const nativeSlug = socialConnectorSlug(channel);
  if (row.slug !== nativeSlug && rows.some((r) => r.slug === nativeSlug)) return { connected: true, name: null };
  const name = typeof row.team_name === "string" ? row.team_name.trim() : "";
  return { connected: true, name: name || null };
}

export function socialConnectorRow(channel: string, rows: readonly SocialConnectorMetaRow[]): SocialConnectorMetaRow | undefined {
  const slug = socialConnectorSlug(channel);
  if (!slug) return undefined;
  const candidates = satisfyingSlugs(slug);
  return rows.find((r) => candidates.includes(r.slug) && r.slug.startsWith("composio.") && railFor(r.slug.slice(9)) === "composio")
    ?? rows.find((r) => r.slug === slug);
}
