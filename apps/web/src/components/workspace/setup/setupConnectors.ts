
import { railFor } from "@zavi/shared";
import { findConnectorRow, type ConnectorListRow } from "@/app/connectors/connectStrategies";
import { isZaviManagedGithubLogin } from "@/components/workspace/build/existingProduct";

export type SetupCategory = "Ads" | "Analytics" | "Social" | "Revenue" | "Product & data" | "Messaging" | "Team";
export type SetupConnector = {
  slug: string;
  name: string;
  category: SetupCategory;
  what: string;
  via: "row" | "launch" | "teams";
};

export const MESSAGING: SetupConnector[] = [
  { slug: "whatsapp", name: "WhatsApp", category: "Messaging", what: "Approve from your phone", via: "row" },
  { slug: "slack", name: "Slack", category: "Messaging", what: "Updates and approvals in Slack", via: "launch" },
  { slug: "telegram", name: "Telegram", category: "Messaging", what: "Chat with Zavi on Telegram", via: "row" },
];
export const MESSAGING_MORE: SetupConnector[] = [
  { slug: "discord", name: "Discord", category: "Messaging", what: "Chat with Zavi in your Discord", via: "row" },
  { slug: "imessage", name: "iMessage", category: "Messaging", what: "Text Zavi from your iPhone", via: "row" },
];

export const TOP_CONNECTORS: SetupConnector[] = [
  { slug: "meta_ads", name: "Meta Ads", category: "Ads", what: "Reads your Meta Ads spend and results", via: "launch" },
  { slug: "google_ads", name: "Google Ads", category: "Ads", what: "Reads your Google and YouTube Ads spend and results", via: "launch" },
  { slug: "linkedin_ads", name: "LinkedIn Ads", category: "Ads", what: "Reads your LinkedIn Ads spend and results", via: "launch" },
  { slug: "x_ads", name: "X Ads", category: "Ads", what: "Reads your X Ads spend and results", via: "launch" },
  { slug: "reddit_ads", name: "Reddit Ads", category: "Ads", what: "Reads your Reddit Ads spend and results", via: "launch" },
  { slug: "tiktok_ads", name: "TikTok Ads", category: "Ads", what: "Reads your TikTok Ads spend and results", via: "launch" },
  { slug: "microsoft_ads", name: "Microsoft Ads", category: "Ads", what: "Reads your Bing ads spend and results", via: "launch" },
  { slug: "pinterest_ads", name: "Pinterest Ads", category: "Ads", what: "Reads your Pinterest Ads spend and results", via: "launch" },
  { slug: "snapchat_ads", name: "Snapchat Ads", category: "Ads", what: "Reads your Snapchat Ads spend and results", via: "launch" },
  { slug: "spotify_ads", name: "Spotify Ads", category: "Ads", what: "Reads your Spotify Ads spend and results", via: "launch" },
  { slug: "google_analytics", name: "Google Analytics", category: "Analytics", what: "Traffic and drop-off", via: "launch" },
  { slug: "google_search_console", name: "Search Console", category: "Analytics", what: "What people search to find you", via: "launch" },
  { slug: "instagram_social", name: "Instagram", category: "Social", what: "Posts, Reels and reach", via: "launch" },
  { slug: "linkedin_social", name: "LinkedIn", category: "Social", what: "Publish and track your posts", via: "launch" },
  { slug: "x_social", name: "X", category: "Social", what: "Publish and read your post metrics", via: "launch" },
  { slug: "stripe", name: "Stripe", category: "Revenue", what: "Revenue, cohorts and churn", via: "row" },
  { slug: "operator_db", name: "Your database", category: "Product & data", what: "Signups and funnel, read-only", via: "row" },
  { slug: "tiktok", name: "TikTok", category: "Social", what: "Videos and reach", via: "launch" },
  { slug: "composio.youtube", name: "YouTube", category: "Social", what: "Channel analytics", via: "launch" },
  { slug: "email", name: "SendGrid", category: "Revenue", what: "Email sends and results", via: "row" },
  { slug: "composio.mailchimp", name: "Mailchimp", category: "Revenue", what: "Email lists and campaigns", via: "launch" },
  { slug: "composio.klaviyo", name: "Klaviyo", category: "Revenue", what: "Email lists and campaigns", via: "launch" },
  { slug: "composio.shopify", name: "Shopify", category: "Revenue", what: "Orders and repeat buyers", via: "launch" },
  { slug: "composio.hubspot", name: "HubSpot", category: "Revenue", what: "Leads, deals and emails", via: "launch" },
  { slug: "posthog", name: "PostHog", category: "Analytics", what: "Product usage and funnels", via: "row" },
  { slug: "supabase", name: "Supabase", category: "Product & data", what: "Your app's own data", via: "row" },
  { slug: "github", name: "GitHub", category: "Product & data", what: "Your code and what shipped", via: "launch" },
  { slug: "teams", name: "Microsoft Teams", category: "Team", what: "Updates and approvals in Teams", via: "teams" },
  { slug: "composio.salesforce", name: "Salesforce", category: "Revenue", what: "Pipeline and accounts", via: "launch" },
];

export const COMPACT_SLUGS = [
  "stripe", "google_analytics", "meta_ads", "google_ads", "google_search_console", "slack", "whatsapp", "github", "instagram_social",
  "linkedin_social", "composio.shopify", "composio.hubspot",
  "x_social", "tiktok", "posthog",
] as const;
export const COMPACT_ALWAYS = 9;
export function compactConnectors(): SetupConnector[] {
  const all = [...MESSAGING, ...MESSAGING_MORE, ...TOP_CONNECTORS];
  return COMPACT_SLUGS.map((slug) => all.find((c) => c.slug === slug)).filter((c): c is SetupConnector => !!c);
}

export const CATEGORIES: Array<"All" | SetupCategory> = ["All", "Ads", "Analytics", "Social", "Revenue", "Product & data", "Messaging", "Team"];

export function filterConnectors(cat: "All" | SetupCategory, query: string): SetupConnector[] {
  const q = query.trim().toLowerCase();
  const all = [...MESSAGING, ...MESSAGING_MORE, ...TOP_CONNECTORS];
  if (q) return all.filter((c) => `${c.name} ${c.what} ${c.category}`.toLowerCase().includes(q));
  if (cat === "All") return TOP_CONNECTORS;
  if (cat === "Messaging") return [...MESSAGING, ...MESSAGING_MORE];
  return TOP_CONNECTORS.filter((c) => c.category === cat);
}

export function isConnected(rows: readonly ConnectorListRow[], slug: string): boolean {
  return findConnectorRow(rows, slug) !== null;
}

export function connectedNames(
  rows: readonly ConnectorListRow[],
  catalog: ReadonlyArray<{ slug: string; name: string }>,
): string[] {
  const all = [...MESSAGING, ...MESSAGING_MORE, ...TOP_CONNECTORS];
  const names: string[] = [];
  for (const r of rows) {
    if (r.slug === "github" && isZaviManagedGithubLogin(r.account_login)) continue;
    if (r.slug.startsWith("pipedream.")) continue;
    const app = r.slug.startsWith("composio.") ? r.slug.slice("composio.".length) : null;
    if (app !== null && railFor(app) !== "composio") continue;
    if (app !== null && all.some((c) => c.slug === app) && findConnectorRow([r], app) === null) continue;
    const tile = all.find((c) => findConnectorRow([r], c.slug) !== null);
    const fromCatalog = app ? catalog.find((a) => a.slug === app)?.name : undefined;
    const name = tile?.name ?? fromCatalog ?? (app ?? r.slug).replace(/[_.]/g, " ");
    if (!names.includes(name)) names.push(name);
  }
  return names;
}
