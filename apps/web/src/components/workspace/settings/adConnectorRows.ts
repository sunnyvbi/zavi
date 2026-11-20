
export const AD_ROW_SLUGS: ReadonlyArray<{
  slug:
    | "linkedin_ads"
    | "x_ads"
    | "tiktok_ads"
    | "reddit_ads"
    | "snapchat_ads"
    | "spotify_ads"
    | "pinterest_ads"
    | "microsoft_ads"
    | "apple_ads";
  sources: readonly string[];
}> = [
  { slug: "linkedin_ads", sources: ["linkedin_ads"] },
  { slug: "x_ads", sources: ["x_ads"] },
  { slug: "tiktok_ads", sources: ["tiktok_ads", "composio.tiktok_ads"] },
  { slug: "reddit_ads", sources: ["reddit_ads", "composio.reddit_ads"] },
  { slug: "snapchat_ads", sources: ["snapchat_ads"] },
  { slug: "spotify_ads", sources: ["spotify_ads"] },
  { slug: "pinterest_ads", sources: ["pinterest_ads"] },
  { slug: "microsoft_ads", sources: ["microsoft_ads"] },
  { slug: "apple_ads", sources: ["apple_ads"] },
];

type MetaRow = {
  slug: string;
  team_name?: string | null;
  connected_at?: string | null;
  token_expires_at?: string | null;
};

export type AdConnectorRow = {
  slug: (typeof AD_ROW_SLUGS)[number]["slug"];
  connected: boolean;
  team_name?: string;
  connected_at?: string;
  token_expires_at?: string;
  source_slug?: string;
  source_slugs?: string[];
};

export function adConnectorRows(list: readonly MetaRow[]): AdConnectorRow[] {
  return AD_ROW_SLUGS.map(({ slug, sources }) => {
    const matches = sources
      .map((s) => list.find((r) => r.slug === s))
      .filter((r): r is MetaRow => Boolean(r));
    const row = matches[0];
    return {
      slug,
      connected: !!row,
      team_name: row?.team_name ?? undefined,
      connected_at: row?.connected_at ?? undefined,
      token_expires_at: row?.token_expires_at ?? undefined,
      source_slug: row?.slug,
      ...(matches.length ? { source_slugs: matches.map((r) => r.slug) } : {}),
    };
  });
}
