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

export type ConnectorCategory = (typeof CATEGORY_ORDER)[number];

export const NATIVE_CATEGORY: Record<string, ConnectorCategory> = {
  slack: "Communication",
  whatsapp: "Communication",
  imessage: "Communication",
  telegram: "Communication",
  discord: "Communication",
  meta_ads: "Marketing",
  google_ads: "Marketing",
  linkedin_ads: "Marketing",
  x_ads: "Marketing",
  tiktok_ads: "Marketing",
  reddit_ads: "Marketing",
  snapchat_ads: "Marketing",
  spotify_ads: "Marketing",
  pinterest_ads: "Marketing",
  microsoft_ads: "Marketing",
  apple_ads: "Marketing",
  google_search_console: "Marketing",
  higgsfield: "Marketing",
  email: "Marketing",
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
  social: "Social",
  github: "Developer Tools",
  sentry: "Developer Tools",
  supabase: "Developer Tools",
  operator_db: "Data",
};

export const COMPOSIO_CATEGORY: Record<string, ConnectorCategory> = {
  instagram: "Social",
  tiktok: "Social",
  facebook: "Social",
  linkedin: "Social",
  twitter: "Social",
  youtube: "Social",
  gmail: "Communication",
  outlook: "Communication",
  notion: "Productivity",
  googledocs: "Productivity",
  googledrive: "Productivity",
  googlecalendar: "Productivity",
  googlesheets: "Productivity",
  hubspot: "CRM & Support",
  salesforce: "CRM & Support",
  zendesk: "CRM & Support",
  shopify: "Payments",
  mixpanel: "Analytics",
  amplitude: "Analytics",
};

export function categoryOf(
  slug: string,
  map: Record<string, ConnectorCategory>,
): ConnectorCategory {
  return map[slug] ?? "Other";
}

export function categoryRank(category: string): number {
  const i = (CATEGORY_ORDER as readonly string[]).indexOf(category);
  return i === -1 ? CATEGORY_ORDER.length : i;
}
