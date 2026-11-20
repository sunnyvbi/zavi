
import { z } from "zod";
import { CONNECTOR_DESCRIPTORS } from "./connector-descriptor";
import { railFor } from "./rails";

export type ConnectKind = "oauth" | "key_form" | "pipedream" | "composio";

export type ConnectInfo = {
  connect: ConnectKind;
  label: string;
  settingsAnchor: string | null;
};

export const CONNECTOR_CONNECT: Readonly<Record<string, ConnectInfo>> = {
  slack: { connect: "oauth", label: "Slack", settingsAnchor: "slack" },
  github: { connect: "oauth", label: "GitHub", settingsAnchor: "github" },
  meta_ads: { connect: "oauth", label: "Meta Ads", settingsAnchor: "meta_ads" },
  google_ads: { connect: "oauth", label: "Google Ads", settingsAnchor: "google_ads" },
  operator_db: { connect: "key_form", label: "your database", settingsAnchor: "operator_db" },
  jira: { connect: "oauth", label: "Jira", settingsAnchor: "jira" },
  stripe: { connect: "key_form", label: "Stripe", settingsAnchor: "stripe" },
  linear: { connect: "oauth", label: "Linear", settingsAnchor: "linear" },
  google_analytics: { connect: "oauth", label: "Google Analytics", settingsAnchor: "google_analytics" },
  posthog: { connect: "key_form", label: "PostHog", settingsAnchor: "posthog" },
  google_search_console: { connect: "oauth", label: "Google Search Console", settingsAnchor: "google_search_console" },
  sentry: { connect: "key_form", label: "Sentry", settingsAnchor: "sentry" },
  figma: { connect: "key_form", label: "Figma", settingsAnchor: "figma" },
  google_calendar: { connect: "oauth", label: "Google Calendar", settingsAnchor: "google_calendar" },
  google_sheets: { connect: "oauth", label: "Google Sheets", settingsAnchor: "google_sheets" },
  supabase: { connect: "key_form", label: "Supabase", settingsAnchor: "supabase" },
  reddit_ads: { connect: "oauth", label: "Reddit Ads", settingsAnchor: "reddit_ads" },
  tiktok_ads: { connect: "oauth", label: "TikTok Ads", settingsAnchor: "tiktok_ads" },
  linkedin_ads: { connect: "oauth", label: "LinkedIn Ads", settingsAnchor: "linkedin_ads" },
  snapchat_ads: { connect: "oauth", label: "Snapchat Ads", settingsAnchor: "snapchat_ads" },
  spotify_ads: { connect: "oauth", label: "Spotify Ads", settingsAnchor: "spotify_ads" },
  pinterest_ads: { connect: "oauth", label: "Pinterest Ads", settingsAnchor: "pinterest_ads" },
  microsoft_ads: { connect: "oauth", label: "Microsoft Ads", settingsAnchor: "microsoft_ads" },
  x_ads: { connect: "oauth", label: "X Ads", settingsAnchor: "x_ads" },
  apple_ads: { connect: "key_form", label: "Apple Ads", settingsAnchor: "apple_ads" },
  tiktok: { connect: "oauth", label: "TikTok", settingsAnchor: "tiktok" },
  email: { connect: "key_form", label: "SendGrid", settingsAnchor: "email" },
  linkedin_social: { connect: "oauth", label: "LinkedIn", settingsAnchor: "linkedin_social" },
  x_social: { connect: "oauth", label: "X", settingsAnchor: "x_social" },
  reddit_social: { connect: "oauth", label: "Reddit", settingsAnchor: "reddit_social" },
  instagram_social: { connect: "oauth", label: "Instagram", settingsAnchor: "instagram_social" },
  "composio.instagram": { connect: "composio", label: "Instagram", settingsAnchor: null },
  "composio.youtube": { connect: "composio", label: "YouTube", settingsAnchor: null },
  "composio.pinterest": { connect: "composio", label: "Pinterest", settingsAnchor: null },
  "composio.gmail": { connect: "composio", label: "Gmail", settingsAnchor: null },
  "composio.mailchimp": { connect: "composio", label: "Mailchimp", settingsAnchor: null },
  "composio.klaviyo": { connect: "composio", label: "Klaviyo", settingsAnchor: null },
  higgsfield: { connect: "key_form", label: "Higgsfield", settingsAnchor: "higgsfield" },
};

export const PIPEDREAM_PREFIX = "pipedream.";
export const COMPOSIO_PREFIX = "composio.";

export function connectInfoFor(slug: string, label?: string): ConnectInfo | null {
  const known = CONNECTOR_CONNECT[slug];
  if (known) return known;
  if (/^composio\.[a-z0-9_-]{1,64}$/.test(slug) && railFor(slug.slice(COMPOSIO_PREFIX.length)) === "composio") {
    return { connect: "composio", label: label ?? slug.slice(COMPOSIO_PREFIX.length), settingsAnchor: null };
  }
  if (slug.startsWith(PIPEDREAM_PREFIX) && /^pipedream\.[a-z0-9_]{1,64}$/.test(slug)) {
    return { connect: "pipedream", label: label ?? slug.slice(PIPEDREAM_PREFIX.length), settingsAnchor: null };
  }
  return null;
}

export function hasConnectPath(slug: string): boolean {
  const info = connectInfoFor(slug);
  return !(info && info.connect === "key_form" && !info.settingsAnchor);
}

export function connectorHasConnectPath(slug: string): boolean {
  const info = connectInfoFor(slug);
  if (!info) return false;
  if (info.connect !== "key_form" || info.settingsAnchor) return true;
  const descriptor = CONNECTOR_DESCRIPTORS.find((d) => d.slug === slug);
  return descriptor ? descriptor.settingsTile : true;
}

export function descriptorsMissingConnectInfo(): string[] {
  return CONNECTOR_DESCRIPTORS.map((d) => d.slug).filter((s) => !(s in CONNECTOR_CONNECT));
}

export function connectorSettingsPath(info: ConnectInfo): string {
  return info.settingsAnchor
    ? `/workspace?tab=settings#connector-${info.settingsAnchor}`
    : "/workspace?tab=settings#integration";
}

export const CONNECTOR_ROW_ALIASES: Readonly<Record<string, readonly string[]>> = {
  instagram_social: ["composio.instagram"],
  reddit_social: ["composio.reddit"],
  tiktok_ads: ["composio.tiktok_ads"],
  reddit_ads: ["composio.reddit_ads"],
};

export function satisfyingSlugs(slug: string): string[] {
  return [slug, ...(CONNECTOR_ROW_ALIASES[slug] ?? [])];
}

export function linkedWithAliases(rowSlugs: Iterable<string>): Set<string> {
  const linked = new Set(rowSlugs);
  for (const [slug, aliases] of Object.entries(CONNECTOR_ROW_ALIASES)) {
    if (aliases.some((a) => linked.has(a))) linked.add(slug);
  }
  return linked;
}

export const UMBRELLA_GITHUB_LOGIN = "Praxis-build";

const ZAVI_APP_HOSTS = ["onrender.com", "zaviagent.com"];

export function isOwnExternalSite(marketing: unknown): boolean {
  if (typeof marketing !== "string" || !marketing) return false;
  let host: string;
  try {
    host = new URL(marketing).host.toLowerCase();
  } catch {
    return false;
  }
  if (!host) return false;
  return !ZAVI_APP_HOSTS.some((z) => host === z || host.endsWith(`.${z}`));
}

export function rowSatisfiesConnectorRequest(
  row: { slug: string; account_login?: string | null },
  slug: string,
): boolean {
  if (!satisfyingSlugs(slug).includes(row.slug)) return false;
  return !(row.slug === "github" && (row.account_login ?? "") === UMBRELLA_GITHUB_LOGIN);
}

export const CONNECTOR_REQUEST_KIND = "connector_request" as const;

export const ConnectorRequestSchema = z.object({
  kind: z.literal(CONNECTOR_REQUEST_KIND),
  v: z.literal(1),
  request_id: z.string().min(1).max(64),
  slug: z.string().min(1).max(80),
  label: z.string().min(1).max(80),
  connect: z.enum(["oauth", "key_form", "pipedream", "composio"]),
  reason: z.string().max(200),
  origin: z.enum(["model", "tool_error", "gate"]),
  mode: z.enum(["connect", "reconnect"]),
  run_id: z.string().min(1).max(64),
  created_at: z.string().min(1).max(40),
});

export type ConnectorRequest = z.infer<typeof ConnectorRequestSchema>;

export function parseConnectorRequest(value: unknown): ConnectorRequest | null {
  const r = ConnectorRequestSchema.safeParse(value);
  return r.success ? r.data : null;
}
