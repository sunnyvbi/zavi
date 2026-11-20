export const CONNECT_APPS_TITLE = "Connect your apps";
export const CONNECT_APPS_SUBTITLE = "Connect where your numbers live, so Zavi can measure what actually moves.";
export const CONNECT_APPS_SEARCH = "Search apps";
export const CONNECT_APPS_HEADING = "Zavi works across your channels";
export const CONNECT_APPS_INTRO = "Connect once, and Zavi reads your numbers, works on your channels with your approval and checks in with you.";
export const CONNECT_APPS_NOTE = "Connect what you use now. Add the rest any time.";
export const CONNECT_APPS_BENEFITS = [
  { title: "Your numbers", detail: "Revenue, traffic and searches, so Zavi measures what actually moves." },
  { title: "Your channels", detail: "Ads, social and email, so Zavi sees what works. Acting on them depends on your plan and your approval." },
  { title: "Your team", detail: "Slack and WhatsApp, so you approve Zavi's work from where you already are." },
] as const;
export const CONNECT_APPS_GROUPS: ReadonlyArray<{ title: string; slugs: readonly string[]; more: readonly string[] }> = [
  { title: "Messaging", slugs: ["slack", "whatsapp"], more: ["teams", "telegram", "imessage", "discord"] },
  { title: "Analytics", slugs: ["google_analytics", "google_search_console"], more: ["posthog"] },
  { title: "Ads", slugs: ["meta_ads", "google_ads", "linkedin_ads"], more: ["x_ads", "reddit_ads", "tiktok_ads", "microsoft_ads", "pinterest_ads", "snapchat_ads", "spotify_ads"] },
  { title: "Social", slugs: ["instagram_social", "composio.youtube", "x_social", "linkedin_social"], more: ["tiktok"] },
  { title: "Revenue", slugs: ["stripe", "composio.hubspot"], more: ["composio.mailchimp", "composio.klaviyo", "email", "composio.salesforce", "composio.shopify"] },
  { title: "Product & data", slugs: ["github", "operator_db"], more: ["supabase"] },
];
export const CONNECT_APPS_STARTERS = CONNECT_APPS_GROUPS.flatMap((group) => [...group.slugs, ...group.more]);
export const SEE_MORE = "See more";
export const SEE_LESS = "See less";
export const CONNECT_APPS_ALSO_CONNECTED = "Also connected";
export const connectedAppCount = (count: number) => `${count} connected so far`;
export const startGrowingLabel = (count: number) => `Start growing with ${count} app${count === 1 ? "" : "s"}`;
