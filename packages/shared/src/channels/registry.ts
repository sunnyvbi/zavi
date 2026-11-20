
export const CONNECTOR_FREE_TOOLS = [
  "growth_seo_audit",
  "growth_geo_visibility",
  "growth_geo_readiness",
  "youtube_search_videos",
  "youtube_video_stats",
  "youtube_channel_stats",
  "reddit_thread_read",
  "pinterest_public_pins",
  "pinterest_site_readiness",
] as const;
export type ConnectorFreeTool = (typeof CONNECTOR_FREE_TOOLS)[number];

export const CHANNEL_CATEGORIES = [
  "paid",
  "organic",
  "owned",
  "earned",
  "partner",
] as const;
export type ChannelCategory = (typeof CHANNEL_CATEGORIES)[number];

export const CHANNEL_READINESS = [
  "live",
  "read_only",
  "connector_only",
  "planned",
] as const;
export type ChannelReadiness = (typeof CHANNEL_READINESS)[number];

export const ACTION_TYPES = [
  "text_post",
  "image_post",
  "video_post",
  "reply",
  "send_message",
  "create_ad",
  "update_ad",
  "pause_ad",
  "fix",
  "check",
  "setup",
  "page",
  "other",
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export const DRAFT_ACTION_TYPES = [
  "text_post",
  "image_post",
  "video_post",
] as const satisfies readonly ActionType[];

export function isDraftActionType(t: string | null | undefined): boolean {
  return !!t && (DRAFT_ACTION_TYPES as readonly string[]).includes(t);
}

export const ACTIONS_STORES = ["decisions", "channel_actions"] as const;
export type ActionsStore = (typeof ACTIONS_STORES)[number];

const PAID_ADS_ACTION_TYPES = [
  "create_ad",
  "update_ad",
  "pause_ad",
  "fix",
  "check",
  "setup",
  "page",
  "text_post",
  "image_post",
  "video_post",
] as const satisfies readonly ActionType[];
const ORGANIC_ACTION_TYPES = [
  "text_post",
  "image_post",
  "video_post",
  "reply",
  "fix",
  "check",
  "setup",
] as const satisfies readonly ActionType[];
const SEARCH_ACTION_TYPES = ["fix", "text_post", "check", "page"] as const satisfies readonly ActionType[];
const BLOG_ACTION_TYPES = ["text_post", "check", "fix", "setup"] as const satisfies readonly ActionType[];
const EMAIL_ACTION_TYPES = ["send_message", "fix", "check"] as const satisfies readonly ActionType[];
const SMS_ACTION_TYPES = ["send_message", "fix", "check", "setup"] as const satisfies readonly ActionType[];
const UGC_ACTION_TYPES = ["video_post", "send_message", "fix", "check"] as const satisfies readonly ActionType[];

export type Channel = {
  slug: string;
  name: string;
  category: ChannelCategory;
  description: string;
  connectors: readonly string[];
  tools: readonly string[];
  measured_on: readonly string[];
  executor: string;
  readiness: ChannelReadiness;
  action_types?: readonly ActionType[];
  actions_store?: ActionsStore;
  require_action_responsibility?: boolean;
  retain_action_overflow?: boolean;
  plan_only?: boolean;
  section?: "creators";
  human?: {
    available: boolean;
    disciplines: readonly HumanDiscipline[];
    brief_kind: HumanBriefKind;
  };
};

export const HUMAN_DISCIPLINES = [
  "ugc_creator",
  "engineer",
  "designer",
  "support",
] as const;
export type HumanDiscipline = (typeof HUMAN_DISCIPLINES)[number];

export const HUMAN_BRIEF_KINDS = ["creative"] as const;
export type HumanBriefKind = (typeof HUMAN_BRIEF_KINDS)[number];

export const CHANNELS = [
  {
    slug: "meta_ads",
    name: "Meta Ads",
    category: "paid",
    description: "Paid acquisition on Facebook and Instagram.",
    connectors: ["meta_ads"],
    tools: [
      "meta_ads_list_campaigns",
      "meta_ads_list_ad_sets",
      "meta_ads_list_ads",
      "meta_ads_analyst_brief",
      "meta_ads_pixel_health",
      "meta_ads_search_interests",
      "meta_ads_propose_budget_change",
      "meta_ads_propose_status_change",
      "meta_ads_propose_new_ad_set",
      "meta_ads_propose_duplicate",
      "meta_ads_propose_new_ad",
      "meta_ads_propose_custom_audience",
      "meta_ads_propose_campaign_launch",
      "meta_ads_propose_new_campaign",
      "meta_ads_propose_campaign_update",
      "meta_ads_propose_campaign_delete",
      "meta_ads_propose_ad_set_update",
      "meta_ads_propose_ad_update",
      "meta_ads_propose_creative",
      "meta_ads_propose_asset_upload",
      "meta_ads_list_creative_assets",
      "meta_ads_preview",
      "meta_ads_list_measurement",
      "meta_ads_propose_custom_conversion",
      "meta_ads_list_pages",
      "meta_ads_list_lead_forms",
      "meta_ads_propose_lead_form",
      "meta_ads_account_read",
      "meta_ads_list_custom_audiences",
      "meta_ads_daily_series",
      "meta_ads_recent_changes",
      "growth_read_verified_bookings_by_campaign",
      "growth_propose_creative_brief",
    ],
    measured_on: ["spend", "cost per result", "return on ad spend", "click-through rate"],
    executor: "meta_ads",
    readiness: "live",
    action_types: PAID_ADS_ACTION_TYPES,
    actions_store: "channel_actions",
  },
  {
    slug: "google_ads",
    name: "Google Ads",
    category: "paid",
    description: "Paid Search and Performance Max campaign actions.",
    connectors: ["google_ads"],
    tools: [
      "google_ads_list_campaigns",
      "google_ads_list_ad_groups",
      "google_ads_conversion_tracking_health",
      "google_ads_change_history",
      "google_ads_conversion_lag",
      "google_ads_search_terms",
      "google_ads_campaign_diagnostics",
      "google_ads_existing_negatives",
      "google_ads_list_locations",
      "google_ads_list_ads",
      "google_ads_list_keywords",
      "google_ads_propose_budget_change",
      "google_ads_propose_status_change",
      "google_ads_propose_new_campaign",
      "google_ads_propose_campaign_update",
      "google_ads_propose_new_ad_group",
      "google_ads_propose_ad_group_update",
      "google_ads_propose_new_ad",
      "google_ads_propose_keywords",
      "google_ads_propose_removal",
    ],
    measured_on: [
      "spend",
      "cost per conversion",
      "return on ad spend (needs conversion values)",
      "share of searches you appeared in (Search only)",
    ],
    executor: "google_ads",
    readiness: "live",
    action_types: PAID_ADS_ACTION_TYPES,
    actions_store: "channel_actions",
  },
  {
    slug: "youtube_ads",
    name: "YouTube Ads",
    category: "paid",
    description: "Video campaigns bought through Google Ads.",
    connectors: ["google_ads"],
    tools: [
      "google_ads_list_campaigns",
      "google_ads_list_video_campaigns",
      "google_ads_video_performance",
      "google_ads_list_ad_groups",
      "google_ads_list_ads",
      "google_ads_conversion_tracking_health",
      "google_ads_change_history",
      "google_ads_conversion_lag",
      "google_ads_campaign_diagnostics",
      "google_ads_propose_video_campaign",
      "google_ads_propose_video_ad",
      "google_ads_propose_status_change",
      "google_ads_propose_budget_change",
    ],
    measured_on: ["spend", "cost per view", "view rate"],
    executor: "youtube_ads",
    readiness: "live",
    action_types: PAID_ADS_ACTION_TYPES,
    actions_store: "channel_actions",
  },
  {
    slug: "tiktok_ads",
    name: "TikTok Ads",
    category: "paid",
    description: "Paid acquisition on TikTok.",
    connectors: ["tiktok_ads"],
    tools: [
      "tiktok_ads_list_accounts",
      "tiktok_ads_list_campaigns",
      "tiktok_ads_propose_budget_change",
      "tiktok_ads_propose_status_change",
      "tiktok_ads_launch_readiness",
      "tiktok_ads_propose_launch",
      "paid_acquisition_get_latest_snapshot",
    ],
    measured_on: ["spend and conversions from your linked TikTok Ads account", "plays on public posts", "the numbers you paste from Ads Manager"],
    executor: "tiktok_ads",
    readiness: "live",
    action_types: PAID_ADS_ACTION_TYPES,
    actions_store: "channel_actions",
  },
  {
    slug: "linkedin_ads",
    name: "LinkedIn Ads",
    category: "paid",
    description: "Paid B2B acquisition on LinkedIn.",
    connectors: ["linkedin_ads"],
    tools: [
      "linkedin_ads_list_accounts",
      "linkedin_ads_list_campaign_groups",
      "linkedin_ads_list_campaigns",
      "linkedin_ads_read_analytics",
      "linkedin_ads_daily_series",
      "linkedin_ads_analyst_brief",
      "linkedin_ads_list_ads",
      "linkedin_ads_recent_changes",
      "linkedin_ads_measurement_health",
      "linkedin_ads_list_saved_audiences",
      "linkedin_ads_propose_pause_campaign",
      "linkedin_ads_propose_resume_campaign",
      "linkedin_ads_propose_budget_change",
      "linkedin_ads_propose_targeting_change",
      "linkedin_ads_propose_campaign_edit",
      "linkedin_ads_propose_campaign_group_edit",
      "linkedin_ads_propose_archive",
      "linkedin_ads_propose_ad_status",
      "linkedin_ads_propose_new_ad",
      "linkedin_ads_propose_ad_swap",
      "linkedin_ads_propose_new_campaign",
      "linkedin_ads_propose_duplicate",
      "linkedin_ads_search_targeting",
      "linkedin_ads_preview_ad",
      "linkedin_ads_list_media",
      "linkedin_ads_bound_campaigns",
      "linkedin_ads_launch_review",
      "linkedin_ads_propose_launch_campaign",
      "growth_read_verified_bookings_by_campaign",
      "paid_acquisition_get_latest_snapshot",
    ],
    measured_on: [
      "spend and clicks from your linked LinkedIn Ads account",
      "impressions and conversions on those campaigns",
      "the numbers you paste from Campaign Manager",
    ],
    executor: "linkedin_ads",
    readiness: "live",
    action_types: PAID_ADS_ACTION_TYPES,
    actions_store: "channel_actions",
  },
  {
    slug: "reddit_ads",
    name: "Reddit Ads",
    category: "paid",
    description: "Paid acquisition on Reddit.",
    connectors: ["reddit_ads"],
    tools: [
      "reddit_ads_list_accounts",
      "reddit_ads_list_campaigns",
      "reddit_ads_check_readiness",
      "reddit_ads_read_performance",
      "reddit_ads_read_objects",
      "reddit_ads_list_targeting",
      "reddit_ads_read_operation",
      "reddit_ads_propose_authorize_account",
      "reddit_ads_propose_prepare_campaign",
      "reddit_ads_propose_launch_campaign",
      "reddit_ads_propose_update_budget",
      "reddit_ads_propose_update_targeting",
      "reddit_ads_propose_update_ad",
      "reddit_ads_propose_replace_creative",
      "reddit_ads_propose_set_object_status",
      "reddit_ads_propose_rename_object",
      "reddit_ads_propose_remove_object",
      "reddit_ads_propose_pause_campaign",
    ],
    measured_on: ["spend and conversions from your linked Reddit Ads account", "public Reddit communities"],
    executor: "reddit_ads",
    readiness: "live",
    action_types: PAID_ADS_ACTION_TYPES,
    actions_store: "channel_actions",
  },
  {
    slug: "x_ads",
    name: "X Ads",
    category: "paid",
    description: "Paid acquisition on X.",
    connectors: ["x_ads"],
    tools: [
      "x_ads_verify_permissions",
      "x_ads_read_ad_groups",
      "x_ads_check_conversions",
      "x_ads_propose_manage_objects",
      "x_ads_list_accounts",
      "x_ads_list_funding_instruments",
      "x_ads_list_campaigns",
      "x_ads_search_locations",
      "x_ads_propose_pause_campaign",
      "x_ads_propose_resume_campaign",
      "x_ads_propose_update_campaign",
      "x_ads_propose_create_campaign",
    ],
    measured_on: ["spend and conversions from your linked X Ads account"],
    executor: "x_ads",
    readiness: "live",
    action_types: PAID_ADS_ACTION_TYPES,
    actions_store: "channel_actions",
  },
  {
    slug: "chatgpt_ads",
    require_action_responsibility: true,
    retain_action_overflow: true,
    name: "ChatGPT Ads",
    category: "paid",
    description: "Paid acquisition in ChatGPT answers.",
    connectors: [],
    tools: [
      "chatgpt_ads_read_performance",
      "chatgpt_ads_propose_new_campaign",
      "chatgpt_ads_propose_budget_change",
      "chatgpt_ads_propose_status",
      "paid_acquisition_get_latest_snapshot",
    ],
    measured_on: [
      "spend and clicks on the campaigns Zavi runs for you",
      "CTR and CPC on those campaigns",
      "attributed conversions on those campaigns",
      "the numbers you paste from Ads Manager",
    ],
    executor: "chatgpt_ads",
    readiness: "live",
    action_types: PAID_ADS_ACTION_TYPES,
    actions_store: "channel_actions",
  },

  {
    slug: "seo",
    name: "SEO",
    category: "organic",
    description: "Non-paid search traffic and the pages that earn it.",
    connectors: ["google_analytics", "google_search_console"],
    tools: [
      "growth_seo_audit",
      "google_analytics_run_report",
      "growth_read_metric_history",
      "google_search_console_query",
      "google_search_console_page_performance",
      "google_search_console_opportunities",
      "seo_propose_pr",
    ],
    measured_on: ["organic_sessions", "indexed_pages", "rankings"],
    executor: "seo",
    readiness: "read_only",
    action_types: SEARCH_ACTION_TYPES,
    actions_store: "channel_actions",
  },
  {
    slug: "geo",
    name: "GEO",
    category: "organic",
    description: "Whether AI assistants can read the site and cite the brand.",
    connectors: [],
    tools: ["growth_seo_audit", "growth_geo_visibility", "growth_geo_readiness", "geo_propose_pr"],
    measured_on: ["AI crawler access", "whether your page answers the question", "off-site brand mentions"],
    executor: "geo",
    readiness: "read_only",
    action_types: SEARCH_ACTION_TYPES,
    actions_store: "channel_actions",
  },
  {
    slug: "blog",
    name: "Blog",
    category: "organic",
    description: "A blog strategy and finished posts that answer what your buyers search for.",
    connectors: ["google_search_console"],
    tools: [
      "growth_seo_audit",
      "google_search_console_query",
      "google_search_console_page_performance",
      "google_search_console_opportunities",
    ],
    measured_on: ["posts drafted", "posts published", "search clicks"],
    executor: "blog",
    readiness: "read_only",
    action_types: BLOG_ACTION_TYPES,
    actions_store: "channel_actions",
  },
  {
    slug: "linkedin_organic",
    name: "LinkedIn",
    category: "organic",
    description: "Unpaid posting and presence on LinkedIn.",
    connectors: ["linkedin_social"],
    tools: ["social_propose_post", "report_render_social_image"],
    measured_on: ["posts", "reactions", "comments"],
    executor: "linkedin_organic",
    readiness: "live",
    action_types: ORGANIC_ACTION_TYPES,
    actions_store: "channel_actions",
  },
  {
    slug: "reddit_organic",
    name: "Reddit",
    category: "organic",
    description:
      "Find buyer questions and prepare helpful answers, plus one community-native post.",
    connectors: [],
    tools: ["reddit_thread_read"],
    measured_on: ["answers drafted", "posts drafted", "communities researched"],
    executor: "reddit_organic",
    readiness: "read_only",
    action_types: ORGANIC_ACTION_TYPES,
    actions_store: "channel_actions",
  },
  {
    slug: "x_organic",
    name: "X",
    category: "organic",
    description: "Unpaid posting and presence on X.",
    connectors: ["x_social"],
    tools: ["social_propose_post", "x_social_read_post_metrics"],
    measured_on: ["posts", "replies", "impressions"],
    executor: "x_organic",
    readiness: "live",
    action_types: ORGANIC_ACTION_TYPES,
    actions_store: "channel_actions",
  },
  {
    slug: "instagram_organic",
    name: "Instagram",
    category: "organic",
    description: "Unpaid posting and presence on Instagram.",
    connectors: ["instagram_social", "composio.instagram"],
    tools: [
      "social_propose_post",
      "report_render_social_image",
      "instagram_read_insights",
    ],
    measured_on: ["posts", "reach", "saves"],
    executor: "instagram_organic",
    readiness: "live",
    action_types: ORGANIC_ACTION_TYPES,
    actions_store: "channel_actions",
  },
  {
    slug: "tiktok_organic",
    name: "TikTok",
    category: "organic",
    description: "Unpaid short-form video on TikTok.",
    connectors: ["tiktok"],
    tools: [
      "tiktok_get_creator_info",
      "tiktok_list_videos",
      "tiktok_analyze_content",
      "tiktok_list_scheduled_posts",
      "tiktok_get_post_status",
    ],
    measured_on: ["posts", "views", "likes"],
    executor: "tiktok_organic",
    readiness: "read_only",
    action_types: ORGANIC_ACTION_TYPES,
    actions_store: "channel_actions",
  },
  {
    slug: "pinterest_organic",
    name: "Pinterest",
    category: "organic",
    description: "Pins shoppers find by search, drafted from what already gets saved in your niche.",
    connectors: ["composio.pinterest"],
    tools: [
      "pinterest_public_pins",
      "pinterest_site_readiness",
      "report_render_social_image",
      "pinterest_insights_read",
      "social_propose_post",
    ],
    measured_on: ["pins drafted", "impressions", "outbound clicks"],
    executor: "pinterest_organic",
    plan_only: true,
    readiness: "live",
    action_types: ORGANIC_ACTION_TYPES,
    actions_store: "channel_actions",
  },
  {
    slug: "ugc",
    section: "creators",
    name: "UGC Videos",
    category: "organic",
    description:
      "A creator films a video you own and run on your own accounts and ads.",
    connectors: [],
    tools: [
      "growth_propose_creative_brief",
      "growth_search_human_members",
      "report_render_pdf",
    ],
    measured_on: ["briefs written", "creators hired"],
    executor: "ugc",
    readiness: "live",
    action_types: UGC_ACTION_TYPES,
    actions_store: "channel_actions",
    human: {
      available: true,
      disciplines: ["ugc_creator"],
      brief_kind: "creative",
    },
  },
  {
    slug: "generated_video",
    section: "creators",
    name: "AI UGC Videos",
    category: "organic",
    description:
      "AI makes a UGC-style video in minutes. Test hooks before you pay a creator.",
    connectors: [],
    tools: ["generated_video_propose"],
    measured_on: ["scripts written", "videos made"],
    executor: "generated_video",
    plan_only: true,
    readiness: "read_only",
    action_types: ["video_post", "check"],
    actions_store: "channel_actions",
  },
  {
    slug: "youtube_organic",
    name: "YouTube",
    category: "organic",
    description: "Owned video channel and its search surface.",
    connectors: ["composio.youtube"],
    tools: [
      "youtube_search_videos",
      "youtube_video_stats",
      "youtube_channel_stats",
      "youtube_insights_read",
    ],
    measured_on: ["views", "subscribers"],
    executor: "youtube_organic",
    readiness: "read_only",
    action_types: ORGANIC_ACTION_TYPES,
    actions_store: "channel_actions",
  },

  {
    slug: "email_marketing",
    name: "Email campaigns",
    category: "owned",
    description: "Email for your own list. Connect Mailchimp, Klaviyo or SendGrid, or send from Zavi's own sender to a list you upload, and Zavi sends what you approve.",
    connectors: ["composio.mailchimp", "composio.klaviyo", "composio.gmail", "email"],
    tools: [
      "email_send",
      "outbound__propose_email",
      "outbound__list_email_lists",
      "email_list_inbox",
      "email_get_thread",
      "email_campaign_list_audiences",
      "email_campaign_get_results",
      "email_propose_campaign",
    ],
    measured_on: [
      "email authentication (SPF/DKIM/DMARC)",
      "where you capture signups",
      "opens and clicks your email tool reports",
    ],
    executor: "email_marketing",
    readiness: "live",
    action_types: EMAIL_ACTION_TYPES,
    actions_store: "channel_actions",
  },
  {
    slug: "sms",
    name: "SMS",
    category: "owned",
    description: "Text messaging to your own list.",
    connectors: [],
    tools: [],
    measured_on: ["nothing yet"],
    executor: "sms",
    readiness: "planned",
    action_types: SMS_ACTION_TYPES,
    actions_store: "channel_actions",
  },
] as const satisfies readonly Channel[];

export type ChannelSlug = (typeof CHANNELS)[number]["slug"];

export const CHANNEL_CATEGORY_ORDER: readonly ChannelCategory[] = [
  "paid",
  "organic",
  "owned",
  "earned",
  "partner",
];

const BY_SLUG = new Map<string, Channel>(CHANNELS.map((c) => [c.slug, c]));

export function getChannel(slug: string): Channel | undefined {
  return BY_SLUG.get(slug);
}

export const RETIRED_CHANNEL_SLUGS: ReadonlySet<string> = new Set<string>(["blog"]);

export const RETIRED_CHANNEL_MESSAGE = "Blog has been retired. SEO now writes one page a month for you.";

export function isChannelSlug(slug: string): slug is ChannelSlug {
  return BY_SLUG.has(slug);
}

export function channelsByCategory(
  category: ChannelCategory,
): readonly Channel[] {
  return CHANNELS.filter((c) => c.category === category);
}

export function actionableChannels(): readonly Channel[] {
  return CHANNELS.filter((c) => c.readiness === "live");
}

export function channelForBriefKind(briefKind: string): Channel | undefined {
  return (CHANNELS as readonly Channel[]).find(
    (c) => c.human?.available === true && c.human.brief_kind === briefKind,
  );
}

const ACTION_TYPE_SET: ReadonlySet<string> = new Set(ACTION_TYPES);

export function isActionType(value: unknown): value is ActionType {
  return typeof value === "string" && ACTION_TYPE_SET.has(value);
}

export function allowedActionTypes(slug: string): readonly ActionType[] {
  const channel = getChannel(slug);
  if (!channel) return [];
  const own = (channel.action_types ?? []).filter((t) => t !== "other");
  return [...own, "other"];
}

export function coerceActionType(
  slug: string,
  value: unknown,
): { action_type: ActionType; coerced: boolean } {
  if (isActionType(value) && allowedActionTypes(slug).includes(value)) {
    return { action_type: value, coerced: false };
  }
  return { action_type: "other", coerced: value !== "other" };
}

export function actionsStoreFor(slug: string): ActionsStore {
  return getChannel(slug)?.actions_store ?? "decisions";
}

export function isCustomerChannelAction(slug: string, body: unknown): boolean {
  const responsibility = (body as { step?: { responsibility?: unknown } } | null)?.step?.responsibility;
  return getChannel(slug)?.require_action_responsibility
    ? responsibility === "client"
    : responsibility !== "zavi";
}

export function anyChannelUsesChannelActions(): boolean {
  return (CHANNELS as readonly Channel[]).some((c) => c.actions_store === "channel_actions");
}
