export const NATIVE_DESCRIPTOR_TO_COMPOSIO: Record<string, readonly string[]> = {
  slack: ["slack", "slackbot"], github: ["github", "github_mcp"], meta_ads: ["metaads"],
  google_ads: ["googleads"], operator_db: [], jira: ["jira"], stripe: ["stripe", "stripe_mcp"],
  linear: ["linear", "linear_mcp"], google_analytics: ["google_analytics"],
  posthog: ["posthog", "posthog_mcp"], google_search_console: ["google_search_console"],
  sentry: ["sentry", "sentry_mcp"], figma: ["figma"], google_calendar: ["googlecalendar"],
  google_sheets: ["googlesheets"], supabase: ["supabase", "supabase_mcp", "supabase_read_mcp"],
  reddit_ads: ["reddit_ads"], tiktok_ads: ["tiktok_ads"], linkedin_ads: ["linkedin_ads"],
  snapchat_ads: ["snapchat"], spotify_ads: [], pinterest_ads: ["pinterest_ads"],
  microsoft_ads: [], x_ads: [], apple_ads: [], tiktok: ["tiktok"], email: ["sendgrid"],
  linkedin_social: ["linkedin"], x_social: ["twitter"], reddit_social: ["reddit"],
  instagram_social: ["instagram"], higgsfield: ["higgsfield_mcp"],
  telegram: ["telegram"],
};
