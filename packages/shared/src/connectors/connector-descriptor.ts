
export type ConnectorDescriptor = {
  slug: string;
  toolPrefix: string;
  recommenderVisible: boolean;
  settingsTile: boolean;
};

export const CONNECTOR_DESCRIPTORS: readonly ConnectorDescriptor[] = [
  { slug: "slack", toolPrefix: "slack", recommenderVisible: true, settingsTile: true },
  { slug: "github", toolPrefix: "github", recommenderVisible: true, settingsTile: true },
  { slug: "meta_ads", toolPrefix: "meta_ads", recommenderVisible: true, settingsTile: true },
  { slug: "google_ads", toolPrefix: "google_ads", recommenderVisible: true, settingsTile: true },
  { slug: "operator_db", toolPrefix: "operator_db", recommenderVisible: true, settingsTile: true },
  { slug: "jira", toolPrefix: "jira", recommenderVisible: true, settingsTile: true },
  { slug: "stripe", toolPrefix: "stripe", recommenderVisible: true, settingsTile: true },
  { slug: "linear", toolPrefix: "linear", recommenderVisible: true, settingsTile: true },
  { slug: "google_analytics", toolPrefix: "google_analytics", recommenderVisible: true, settingsTile: true },
  { slug: "posthog", toolPrefix: "posthog", recommenderVisible: true, settingsTile: true },
  { slug: "google_search_console", toolPrefix: "google_search_console", recommenderVisible: true, settingsTile: true },

  { slug: "sentry", toolPrefix: "sentry", recommenderVisible: true, settingsTile: true },
  { slug: "figma", toolPrefix: "figma", recommenderVisible: true, settingsTile: true },
  { slug: "google_calendar", toolPrefix: "google_calendar", recommenderVisible: true, settingsTile: true },
  { slug: "google_sheets", toolPrefix: "google_sheets", recommenderVisible: true, settingsTile: true },
  { slug: "supabase", toolPrefix: "supabase", recommenderVisible: true, settingsTile: true },
  { slug: "reddit_ads", toolPrefix: "reddit_ads", recommenderVisible: true, settingsTile: true },
  { slug: "tiktok_ads", toolPrefix: "tiktok_ads", recommenderVisible: true, settingsTile: true },
  { slug: "linkedin_ads", toolPrefix: "linkedin_ads", recommenderVisible: true, settingsTile: true },
  { slug: "snapchat_ads", toolPrefix: "snapchat_ads", recommenderVisible: true, settingsTile: true },
  { slug: "spotify_ads", toolPrefix: "spotify_ads", recommenderVisible: true, settingsTile: true },
  { slug: "pinterest_ads", toolPrefix: "pinterest_ads", recommenderVisible: true, settingsTile: true },
  { slug: "microsoft_ads", toolPrefix: "microsoft_ads", recommenderVisible: true, settingsTile: true },
  { slug: "x_ads", toolPrefix: "x_ads", recommenderVisible: true, settingsTile: true },
  { slug: "apple_ads", toolPrefix: "apple_ads", recommenderVisible: true, settingsTile: true },
  { slug: "tiktok", toolPrefix: "tiktok", recommenderVisible: true, settingsTile: true },
  { slug: "email", toolPrefix: "email", recommenderVisible: false, settingsTile: true },
  { slug: "linkedin_social", toolPrefix: "linkedin_social", recommenderVisible: false, settingsTile: true },
  { slug: "x_social", toolPrefix: "x_social", recommenderVisible: false, settingsTile: true },
  { slug: "reddit_social", toolPrefix: "reddit_social", recommenderVisible: false, settingsTile: true },
  { slug: "instagram_social", toolPrefix: "instagram_social", recommenderVisible: false, settingsTile: true },
  { slug: "composio.instagram", toolPrefix: "instagram", recommenderVisible: false, settingsTile: false },
  { slug: "composio.youtube", toolPrefix: "youtube_insights", recommenderVisible: false, settingsTile: false },
  { slug: "composio.pinterest", toolPrefix: "pinterest_insights", recommenderVisible: false, settingsTile: false },
  { slug: "composio.gmail", toolPrefix: "gmail", recommenderVisible: false, settingsTile: false },
  { slug: "composio.mailchimp", toolPrefix: "mailchimp", recommenderVisible: false, settingsTile: false },
  { slug: "composio.klaviyo", toolPrefix: "klaviyo", recommenderVisible: false, settingsTile: false },
  { slug: "higgsfield", toolPrefix: "higgsfield", recommenderVisible: false, settingsTile: true },
];

export function recommenderSlugs(): string[] {
  return CONNECTOR_DESCRIPTORS.filter((d) => d.recommenderVisible).map((d) => d.slug);
}

export function toolPrefixToConnector(): Record<string, string> {
  return Object.fromEntries(CONNECTOR_DESCRIPTORS.map((d) => [d.toolPrefix, d.slug]));
}

export function recommenderToolPrefixToConnector(): Record<string, string> {
  return Object.fromEntries(
    CONNECTOR_DESCRIPTORS.filter((d) => d.recommenderVisible).map((d) => [d.toolPrefix, d.slug]),
  );
}
