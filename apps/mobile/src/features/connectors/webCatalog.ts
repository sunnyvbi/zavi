
export const WEB_LABELS: Readonly<Record<string, string>> = {
  slack: "Slack",
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  discord: "Discord",
  teams: "Microsoft Teams",
  github: "GitHub",
  meta_ads: "Meta Ads",
  google_ads: "Google Ads",
  google_analytics: "Google Analytics",
  google_search_console: "Google Search Console",
  operator_db: "Your database",
  jira: "Jira",
  stripe: "Stripe",
  posthog: "PostHog",
  higgsfield: "Higgsfield",
  sentry: "Sentry",
  figma: "Figma",
  supabase: "Supabase",
  google_calendar: "Google Calendar",
  google_sheets: "Google Sheets",
  linear: "Linear",
  intercom: "Intercom",
  linkedin_social: "LinkedIn",
  x_social: "X (Twitter)",
  reddit_social: "Reddit",
  instagram_social: "Instagram",
  tiktok: "TikTok",
};

export const WEB_ROW_ORDER: readonly string[] = [
  "slack",
  "whatsapp",
  "telegram",
  "discord",
  "github",
  "meta_ads",
  "google_ads",
  "google_analytics",
  "google_search_console",
  "operator_db",
  "jira",
  "stripe",
  "linear",
  "linkedin_social",
  "x_social",
  "reddit_social",
  "instagram_social",
  "higgsfield",
  "sentry",
  "figma",
  "supabase",
  "google_calendar",
  "google_sheets",
  "intercom",
  "tiktok",
];

export const NATIVE_SLUGS: readonly string[] = WEB_ROW_ORDER;

export function webOrder(slug: string): number {
  const i = WEB_ROW_ORDER.indexOf(slug);
  if (i !== -1) return i;
  return slug.startsWith("composio.") ? WEB_ROW_ORDER.length + 1 : WEB_ROW_ORDER.length;
}

const PURPOSE: Readonly<Record<string, string>> = {
  slack: "Read channels so agents answer with real team context.",
  whatsapp: "Message your agents from WhatsApp.",
  telegram: "Message your agents from Telegram.",
  discord: "Message your agents from a Discord server.",
  teams: "Message your agents from Microsoft Teams.",
  github: "Let engineer read repos and open PRs.",
  meta_ads: "Read Facebook + Instagram campaigns and propose reallocations.",
  google_ads: "Read Google Ads campaigns and spend.",
  google_analytics: "Read GA4 traffic and conversions by source.",
  google_search_console: "Read clicks, impressions, and rankings by query.",
  operator_db: "Read listings, users, and transactions from your DB.",
  jira: "Give pm, engineer, and qa your Atlassian context.",
  stripe: "Read charges, payouts, and disputes.",
  posthog: "Answer funnel and retention questions from product events.",
  higgsfield: "Stage creator-style videos for your approval.",
  linear: "Give engineer and pm issue + project context.",
  sentry: "Read issues and error volume when investigating regressions.",
  figma: "Read design files and projects.",
  supabase: "Read project metadata, edge functions, and analytics.",
  google_calendar: "Let chief-of-staff see what your week looks like.",
  google_sheets: "Read spreadsheets your Google account can open.",
  intercom: "Read support conversations as evidence.",
  linkedin_social: "Publish approved posts to LinkedIn.",
  x_social: "Publish approved posts to X.",
  reddit_social: "Publish approved text posts to a subreddit.",
  instagram_social: "Publish approved image posts to Instagram.",
  instagram: "Read and publish to an Instagram account.",
  tiktok: "Publish approved videos to TikTok.",
  gmail: "Read and draft email on your behalf.",
  notion: "Read pages and databases for company context.",
  hubspot: "Read contacts, deals, and pipelines.",
  shopify: "Read orders, products, and customers.",
};

export function purposeFor(slug: string, name: string): string {
  return PURPOSE[slug] ?? PURPOSE[slug.replace(/^composio\./, "")] ?? `Connect ${name} so agents can use it.`;
}

export const CATEGORY_ORDER = [
  "Communication",
  "Marketing",
  "Analytics",
  "Productivity",
  "CRM & Support",
  "Payments",
  "Social",
  "Developer Tools",
  "Data",
  "Other",
] as const;

const CATEGORY: Readonly<Record<string, (typeof CATEGORY_ORDER)[number]>> = {
  slack: "Communication",
  whatsapp: "Communication",
  telegram: "Communication",
  discord: "Communication",
  teams: "Communication",
  meta_ads: "Marketing",
  google_ads: "Marketing",
  google_search_console: "Marketing",
  higgsfield: "Marketing",
  google_analytics: "Analytics",
  posthog: "Analytics",
  jira: "Productivity",
  linear: "Productivity",
  google_calendar: "Productivity",
  google_sheets: "Productivity",
  figma: "Productivity",
  intercom: "CRM & Support",
  stripe: "Payments",
  linkedin_social: "Social",
  x_social: "Social",
  reddit_social: "Social",
  instagram_social: "Social",
  github: "Developer Tools",
  sentry: "Developer Tools",
  supabase: "Developer Tools",
  operator_db: "Data",
};

export function categoryOf(slug: string): string {
  return CATEGORY[slug] ?? "Other";
}

export function categoryRank(category: string): number {
  const i = (CATEGORY_ORDER as readonly string[]).indexOf(category);
  return i === -1 ? CATEGORY_ORDER.length : i;
}

export const DEFAULT_FOR_YOU_SLUGS: readonly string[] = [
  "slack",
  "github",
  "telegram",
  "discord",
  "meta_ads",
  "google_ads",
  "google_analytics",
  "google_search_console",
  "posthog",
  "stripe",
  "jira",
  "linear",
  "intercom",
  "linkedin_social",
  "x_social",
  "reddit_social",
  "instagram_social",
  "tiktok",
];

export const FOR_YOU_CAP = 6;

export const ZAVI_MANAGED_DB_DETAIL = "Your app's database, set up by Zavi";

export type MetadataRow = {
  slug: string;
  team_id?: string | null;
  team_name?: string | null;
  account_login?: string | null;
  repo_full_names?: string[] | null;
  managed_by?: string | null;
};

const meaningful = (v: string | null | undefined): v is string => {
  const t = (v ?? "").trim();
  return t.length > 0 && t.toLowerCase() !== "unknown";
};

export function connectedDetail(row: MetadataRow): string {
  const s = row.slug;
  if (s === "google_ads") return "";
  if (s === "meta_ads" || s === "google_analytics" || s === "google_search_console" || s === "google_calendar") {
    return row.team_id ?? "";
  }
  if (s === "operator_db") return row.managed_by === "zavi" ? ZAVI_MANAGED_DB_DETAIL : row.team_id ?? "";
  if (s === "stripe") return meaningful(row.team_name) ? row.team_name : meaningful(row.account_login) ? row.account_login : "";
  if (s === "sentry") return row.team_id ?? "";
  if (
    [
      "jira",
      "linear",
      "figma",
      "supabase",
      "intercom",
      "discord",
      "linkedin_social",
      "x_social",
      "reddit_social",
      "instagram_social",
    ].includes(s)
  ) {
    return row.team_name ?? "";
  }
  if (s === "github") return `${row.account_login ?? "—"} · ${row.repo_full_names?.length ?? 0} repos`;
  return "";
}
