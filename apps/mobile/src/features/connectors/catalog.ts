import { CHANNELS, connectInfoFor, railFor } from "@zavi/shared";
import { GOAL_CONNECTORS, type ConnectorRow } from "./health";
import { NATIVE_SLUGS, WEB_LABELS } from "./webCatalog";

export const SUGGESTED_CONNECTORS = NATIVE_SLUGS;

const OTHER_USES: Readonly<Record<string, readonly string[]>> = {
  stripe: ["Revenue answers"],
  operator_db: ["Answers from your data"],
  slack: ["Chat in Slack", "Daily brief"],
  github: ["Engineer", "Build"],
};

export function connectorLabel(slug: string): string {
  const web = WEB_LABELS[slug];
  if (web) return web;
  const label = connectInfoFor(slug)?.label ?? slug.replace(/^composio\./, "").replace(/[._]/g, " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function connectorUses(slug: string): string[] {
  const uses = new Set<string>();
  if (GOAL_CONNECTORS.has(slug)) uses.add("Your goal");
  for (const use of OTHER_USES[slug] ?? []) uses.add(use);
  for (const channel of CHANNELS) {
    if ((channel.connectors as readonly string[]).includes(slug)) uses.add(channel.name);
  }
  return [...uses];
}

export function tenantRows(rows: readonly ConnectorRow[]): ConnectorRow[] {
  return rows.filter((r) => {
    if (r.slug.startsWith("pipedream.")) return false;
    return !(r.slug.startsWith("composio.") && railFor(r.slug.slice("composio.".length)) !== "composio");
  });
}

const GENERIC_DISCONNECT: ReadonlySet<string> = new Set([
  "jira",
  "higgsfield",
  "linear",
  "linkedin_social",
  "x_social",
  "reddit_social",
  "instagram_social",
  "reddit_ads",
  "tiktok_ads",
  "linkedin_ads",
  "snapchat_ads",
  "spotify_ads",
  "pinterest_ads",
  "microsoft_ads",
  "intercom",
]);

export function disconnectPath(slug: string): string | null {
  if (slug === "meta_ads") return "/api/connectors/meta-ads/disconnect";
  if (slug === "github") return "/api/connectors/github/disconnect";
  if (slug === "tiktok" || slug === "telegram" || slug === "discord" || slug === "whatsapp" || slug === "teams") {
    return `/api/connectors/${slug}/disconnect`;
  }
  if (slug.startsWith("composio.")) {
    return `/api/connectors/composio/${encodeURIComponent(slug.slice("composio.".length))}/disconnect`;
  }
  if (GENERIC_DISCONNECT.has(slug)) return `/api/connectors/${encodeURIComponent(slug)}/disconnect`;
  return null;
}

export type DisconnectCopy = { title: string; description: string };

const DISCONNECT_COPY: Readonly<Record<string, DisconnectCopy>> = {
  x_social: {
    title: "Disconnect X?",
    description: "Zavi stops posting to this account and deletes its stored tokens. You can reconnect anytime.",
  },
  meta_ads: {
    title: "Disconnect Meta Ads?",
    description: "Zavi stops reading this ad account and deletes its stored token. You can reconnect anytime.",
  },
  linkedin_ads: {
    title: "Disconnect LinkedIn Ads?",
    description:
      "Zavi stops reading the LinkedIn ad accounts you pay for yourself and deletes its stored tokens. Campaigns running on those accounts keep running and spending, and Zavi can no longer pause them, so pause them in LinkedIn Campaign Manager first if you want them stopped. Campaigns paid from your Zavi balance are not affected, and Zavi can still pause them. You can reconnect anytime.",
  },
  higgsfield: {
    title: "Disconnect Higgsfield?",
    description: "Zavi stops generating on this account and deletes its stored token. You can reconnect anytime.",
  },
  tiktok: {
    title: "Disconnect TikTok?",
    description: "Zavi stops posting to this account and deletes its stored tokens. You can reconnect anytime.",
  },
  discord: { title: "Disconnect Discord?", description: "Zavi stops answering in that server. The bot stays installed." },
  telegram: { title: "Disconnect Telegram?", description: "Zavi stops answering in every linked chat and group." },
  whatsapp: { title: "Disconnect WhatsApp?", description: "Zavi stops answering every linked number." },
  teams: {
    title: "Disconnect Microsoft Teams?",
    description: "Zavi will stop answering in Teams. To reconnect, re-add the Zavi app in Teams and enter the new code.",
  },
  github: {
    title: "Disconnect GitHub?",
    description: "Agents will immediately stop reading your repos. Your GitHub App install stays in place — reconnect anytime.",
  },
};

export function disconnectCopy(slug: string): DisconnectCopy | null {
  return DISCONNECT_COPY[slug] ?? null;
}

export function canManageConnectors(role: string | undefined): boolean {
  const r = (role ?? "").toLowerCase();
  return r === "owner" || r === "admin";
}
