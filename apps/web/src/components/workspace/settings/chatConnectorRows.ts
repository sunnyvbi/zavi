
export const CHAT_SLUGS = ["slack", "whatsapp", "imessage", "telegram", "discord"] as const;

export type ChatSlug = (typeof CHAT_SLUGS)[number];

export type ChatConnectorMetaRow = {
  slug: string;
  team_name?: string | null;
  connected_at?: string | null;
};

export type ChatConnectorRow = {
  slug: ChatSlug;
  connected: boolean;
  team_name?: string;
  connected_at?: string;
};

export function chatConnectorRows(
  list: readonly ChatConnectorMetaRow[],
): ChatConnectorRow[] {
  const find = (slug: ChatSlug) => list.find((r) => r.slug === slug);
  const slack = find("slack");
  const whatsapp = find("whatsapp");
  const imessage = find("imessage");
  const telegram = find("telegram");
  const discord = find("discord");

  return [
    {
      slug: "slack",
      connected: !!slack,
      team_name: slack?.team_name ?? undefined,
      connected_at: slack?.connected_at ?? undefined,
    },
    {
      slug: "whatsapp",
      connected: !!whatsapp,
      connected_at: whatsapp?.connected_at ?? undefined,
    },
    {
      slug: "imessage",
      connected: !!imessage,
      connected_at: imessage?.connected_at ?? undefined,
    },
    {
      slug: "telegram",
      connected: !!telegram,
      connected_at: telegram?.connected_at ?? undefined,
    },
    {
      slug: "discord",
      connected: !!discord,
      team_name: discord?.team_name ?? undefined,
      connected_at: discord?.connected_at ?? undefined,
    },
  ];
}
