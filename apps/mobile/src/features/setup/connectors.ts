import { railFor } from "@zavi/shared";
import { findConnectorRow, isZaviManagedGithubLogin, type ConnectorListRow } from "../connectors/connectPlan";

export type SetupCategory = "Ads" | "Analytics" | "Social" | "Revenue" | "Product & data" | "Messaging";
export type SetupConnector = { slug: string; name: string; category: SetupCategory; what: string };

const MESSAGING: SetupConnector[] = [
  { slug: "whatsapp", name: "WhatsApp", category: "Messaging", what: "Chat with Zavi and approve from your phone" },
  { slug: "slack", name: "Slack", category: "Messaging", what: "Updates and approvals in your team's Slack" },
  { slug: "telegram", name: "Telegram", category: "Messaging", what: "Chat with Zavi on Telegram" },
  { slug: "discord", name: "Discord", category: "Messaging", what: "Chat with Zavi in your Discord" },
];

const TOP: SetupConnector[] = [
  { slug: "meta_ads", name: "Meta Ads", category: "Ads", what: "Runs your Meta Ads channel" },
  { slug: "google_ads", name: "Google Ads", category: "Ads", what: "Runs Google Ads and YouTube Ads" },
  { slug: "linkedin_ads", name: "LinkedIn Ads", category: "Ads", what: "Reads your LinkedIn Ads spend and results" },
  { slug: "google_analytics", name: "Google Analytics", category: "Analytics", what: "Traffic and drop-off, for SEO" },
  { slug: "google_search_console", name: "Search Console", category: "Analytics", what: "What people search to find you" },
  { slug: "instagram_social", name: "Instagram", category: "Social", what: "Posts, Reels and reach" },
  { slug: "linkedin_social", name: "LinkedIn", category: "Social", what: "Publish and track your posts" },
  { slug: "x_social", name: "X", category: "Social", what: "Publish and read your post metrics" },
  { slug: "stripe", name: "Stripe", category: "Revenue", what: "Revenue, cohorts and churn" },
  { slug: "operator_db", name: "Your database", category: "Product & data", what: "Signups and funnel, read-only" },
  { slug: "tiktok", name: "TikTok", category: "Social", what: "Videos and reach" },
  { slug: "composio.youtube", name: "YouTube", category: "Social", what: "Channel analytics" },
  { slug: "email", name: "SendGrid", category: "Revenue", what: "Email sends and results" },
  { slug: "composio.mailchimp", name: "Mailchimp", category: "Revenue", what: "Email lists and campaigns" },
  { slug: "composio.shopify", name: "Shopify", category: "Revenue", what: "Orders and repeat buyers" },
  { slug: "composio.hubspot", name: "HubSpot", category: "Revenue", what: "Leads, deals and emails" },
  { slug: "posthog", name: "PostHog", category: "Analytics", what: "Product usage and funnels" },
  { slug: "supabase", name: "Supabase", category: "Product & data", what: "Your app's own data" },
  { slug: "github", name: "GitHub", category: "Product & data", what: "Your code and what shipped" },
  { slug: "composio.salesforce", name: "Salesforce", category: "Revenue", what: "Pipeline and accounts" },
];

export const ALL_SETUP_CONNECTORS: readonly SetupConnector[] = [...MESSAGING, ...TOP];

export const COMPACT_SLUGS = [
  "stripe", "google_analytics", "meta_ads", "google_ads", "google_search_console", "slack", "whatsapp", "github", "instagram_social",
  "linkedin_social", "composio.shopify", "composio.hubspot",
  "x_social", "tiktok", "posthog",
] as const;

export function compactConnectors(): SetupConnector[] {
  return COMPACT_SLUGS.map((slug) => ALL_SETUP_CONNECTORS.find((c) => c.slug === slug)).filter(
    (c): c is SetupConnector => !!c,
  );
}

export function searchConnectors(
  query: string,
  catalog: ReadonlyArray<{ slug: string; name: string }>,
): SetupConnector[] {
  const q = query.trim().toLowerCase();
  if (!q) return compactConnectors();
  const tiles = ALL_SETUP_CONNECTORS.filter((c) => `${c.name} ${c.what} ${c.category}`.toLowerCase().includes(q));
  if (q.length < 2) return tiles;
  const known = new Set(tiles.map((c) => c.slug));
  const more = catalog
    .filter((a) => `${a.name} ${a.slug}`.toLowerCase().includes(q))
    .map((a): SetupConnector => ({ slug: `composio.${a.slug}`, name: a.name, category: "Product & data", what: "From the app catalog" }))
    .filter((c) => !known.has(c.slug));
  return [...tiles, ...more];
}

export function isConnected(rows: readonly ConnectorListRow[], slug: string): boolean {
  return findConnectorRow(rows, slug) !== null;
}

export function connectedNames(
  rows: readonly ConnectorListRow[],
  catalog: ReadonlyArray<{ slug: string; name: string }>,
): string[] {
  const names: string[] = [];
  for (const r of rows) {
    if (r.slug === "github" && isZaviManagedGithubLogin(r.account_login)) continue;
    if (r.slug.startsWith("pipedream.")) continue;
    const app = r.slug.startsWith("composio.") ? r.slug.slice("composio.".length) : null;
    if (app !== null && railFor(app) !== "composio") continue;
    const tile = ALL_SETUP_CONNECTORS.find((c) => findConnectorRow([r], c.slug) !== null);
    const fromCatalog = app ? catalog.find((a) => a.slug === app)?.name : undefined;
    const name = tile?.name ?? fromCatalog ?? (app ?? r.slug).replace(/[_.]/g, " ");
    if (!names.includes(name)) names.push(name);
  }
  return names;
}
