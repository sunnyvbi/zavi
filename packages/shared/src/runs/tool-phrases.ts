
export const BUILD_STEP_PHRASE = "Ran a build step";
const SOCIAL_POST_PHRASE = "Worked on a social post";
const SOCIAL_READ_PHRASE = "Looked at social media data";
const SOCIAL_READ_VERB = /(?:^|_)(?:list|get|read|search|fetch|find|lookup)(?:_|$)/i;

const FAMILIES: ReadonlyArray<readonly [RegExp, string]> = [
  [/ui__show_chart$/, "Drew a chart"],
  [/ui__show_kpis$/, "Built a numbers card"],
  [/ui__show_table$/, "Built a table"],
  [/ui__show_posts$/, "Drafted post previews"],
  [/ui__show_/, "Built a visual"],
  [/ui__open_/, "Opened a page for you"],
  [/operator_db|operator-db|mongo|sql|postgres|database/i, "Checked your database"],
  [/investor_db/i, "Searched the investor database"],
  [/investor_discovery/i, "Searched for investors"],
  [/growth__seo_audit/i, "Audited your SEO"],
  [/growth__geo_visibility/i, "Checked your AI-answer visibility"],
  [/growth__geo_readiness/i, "Checked which AI crawlers can read your site"],
  [/growth__propose_creative_brief/i, "Drafted a creative brief"],
  [/growth__search_human_members/i, "Looked for a specialist"],
  [/growth__(read_|diagnose_)/i, "Checked your growth data"],
  [/growth__/i, "Ran a growth check"],
  [/(^|__)praxis__handoff|^handoff(_parallel)?$/i, "Brought in a specialist"],
  [/praxis__render_video/i, "Rendered a video"],
  [/praxis__action/i, "Set up an action for your approval"],
  [/memory__|brain__|memory_search|company_facts|notes/i, "Checked what it knows about your company"],
  [/(?:^|__)code_index__/, "Looked at your code"],
  [/web_search|tavily|perplexity/i, "Searched the web"],
  [/web_fetch|fetch_url|browse|scrape|apify/i, "Read a web page"],
  [/meta_ads|google_ads|tiktok_ads|linkedin_ads|reddit_ads|x_ads|chatgpt_ads|_ads__/i, "Checked your ads"],
  [/stripe|payment|invoice/i, "Checked payments"],
  [/slack|discord|telegram|whatsapp/i, "Checked your team chat"],
  [/github|git_|(?:^|__|_)repos?(?:$|__|_)|pull_request/i, "Looked at your code"],
  [/social__|linkedin_social|reddit_social|x_social|instagram|youtube/i, SOCIAL_POST_PHRASE],
  [/email|gmail|sendgrid|outreach/i, "Worked on email"],
  [/calendar|meet|notetaker/i, "Checked your calendar"],
  [/analytics|posthog|mixpanel|amplitude|ga4|search_console/i, "Checked your analytics"],
  [/artifact|report|pdf|deck|export/i, "Prepared a file"],
  [/(?:^|__)praxis__run_site_check$/, "Checked your site"],
  [/bash|exec|npm|deploy|sandbox/i, BUILD_STEP_PHRASE],
];

export const READ_ONLY_TOOLS: ReadonlyArray<readonly [server: string, tools: readonly string[], phrase?: string]> = [
  ["ui", ["show_chart", "show_kpis", "show_table", "show_posts", "show_html"]],
  ["praxis", ["list_product_builds"], "Looked up your builds"],
  ["praxis", ["list_reminders"], "Checked your reminders"],
  ["praxis", ["second_opinion"], "Asked for a second opinion"],
  ["outbound", ["list_email_lists"], "Checked your contact lists"],
  ["praxis_corpus", ["get_channel_action", "query_decision_stats", "query_operator_feedback", "query_pending_decisions", "query_recent_runs", "query_support_themes", "read_run_output"], "Looked through earlier work"],
  ["sandbox", ["read_file", "view"], "Read your project"],
  ["sandbox", ["git_diff", "git_status"], "Looked at your code"],
  ["apple_ads", ["list_accounts", "list_campaigns"]],
  ["artifacts", ["get", "list"]],
  ["buffer", ["list_profiles"]],
  ["chatgpt_ads", ["read_performance"]],
  ["connectors", ["search"]],
  ["email", ["get_thread", "list_inbox"]],
  ["email_campaign", ["get_results", "list_audiences"]],
  ["figma", ["get_file", "list_files"]],
  ["generated_video", ["account_status"]],
  ["github", ["get_me", "get_pr", "get_pr_diff", "grep", "list_branches", "list_commits", "list_files", "list_open_prs", "list_pr_status", "list_repos", "list_teams", "read_file", "search_code", "search_issues"]],
  ["google_ads", ["campaign_diagnostics", "change_history", "conversion_lag", "conversion_tracking_health", "existing_negatives", "list_ad_groups", "list_ads", "list_locations", "list_campaigns", "list_keywords", "list_video_campaigns", "search_terms", "video_performance"]],
  ["google_analytics", ["run_report"]],
  ["google_calendar", ["list_events"]],
  ["google_search_console", ["compare_periods", "inspect_url", "list_sitemaps", "opportunities", "page_performance", "query"]],
  ["google_sheets", ["list_tabs", "read_range"]],
  ["growth", ["compute", "constraint_diagnosis", "content_punchlist", "diagnose_funnel", "explain_change", "geo_readiness", "geo_visibility", "get_metric", "liquidity_gap", "marketplace_intelligence", "read_action_outcomes", "read_ads_perf", "read_business_controls", "read_cohort", "read_experiment_ledger", "read_metric_history", "read_revenue", "read_verified_bookings_by_campaign", "search_human_members", "seo_audit"]],
  ["instagram", ["read_insights"]],
  ["investor_db", ["search"]],
  ["jira", ["atlassian_user_info", "count", "get_attachment", "get_issue", "get_issue_remote_links", "get_issue_type_metadata", "get_transitions", "get_visible_projects", "lookup_account_id", "search"]],
  ["linear", ["get_issue", "get_team", "get_user", "list_my_issues", "list_projects", "list_teams", "list_users", "search"]],
  ["linkedin_ads", ["analyst_brief", "bound_campaigns", "daily_series", "launch_review", "list_accounts", "list_ads", "list_campaign_groups", "list_campaigns", "list_media", "list_saved_audiences", "measurement_health", "preview_ad", "read_analytics", "recent_changes", "search_targeting"]],
  ["memory", ["list_topics", "read"]],
  ["meta_ads", ["account_read", "analyst_brief", "daily_series", "list_ad_sets", "list_ads", "list_campaigns", "list_creative_assets", "list_custom_audiences", "list_lead_forms", "list_measurement", "list_pages", "pixel_health", "preview", "recent_changes", "search_interests"]],
  ["microsoft_ads", ["list_accounts", "list_campaigns"]],
  ["operator_db", ["catalog", "query", "query_active_supply_by_geo_category", "query_bookings_by_geo_category", "query_funnel_by_geo_category", "query_listing", "query_new_bookings", "query_new_users", "query_recent_transactions", "query_user", "query_verified_bookings_by_campaign", "summary"]],
  ["paid_acquisition", ["get_latest_snapshot"]],
  ["pinterest_ads", ["list_accounts", "list_campaigns"]],
  ["pinterest_insights", ["read"]],
  ["pinterest", ["public_pins", "site_readiness"]],
  ["posthog", ["query"]],
  ["product", ["probe"], "Checked your site"],
  ["qa_engineer", ["count_test_cases", "get_runtime_config", "list_active_tests"]],
  ["reddit_ads", ["list_accounts", "list_campaigns", "check_readiness", "read_performance", "read_objects", "list_targeting", "read_operation"]],
  ["report", ["get_page_design_guide"]],
  ["sentry", ["get_issue", "list_issues"]],
  ["skill", ["load"]],
  ["slack", ["get_channel_history", "get_reactions", "list_channel_members", "list_channels", "read_file", "read_thread", "read_user_profile", "search_users"]],
  ["snapchat_ads", ["list_accounts", "list_campaigns"]],
  ["social", ["list_posts"]],
  ["spotify_ads", ["list_accounts", "list_campaigns"]],
  ["stripe", ["list_charges", "list_customers", "list_invoices", "list_payment_intents", "list_payouts", "retrieve_dispute", "retrieve_payout", "search_stripe_resources"]],
  ["supabase", ["list_edge_functions", "project_info", "query_logs"]],
  ["support_inbox", ["get_thread", "list_threads"]],
  ["tiktok_ads", ["launch_readiness", "list_accounts", "list_ad_groups", "list_campaigns"]],
  ["tiktok", ["analyze_content", "get_account_stats", "get_creator_info", "get_post_status", "list_scheduled_posts", "list_videos"]],
  ["web_fetch", ["find_google_docs"]],
  ["x_ads", ["check_conversions", "list_accounts", "list_campaigns", "list_funding_instruments", "read_ad_groups", "search_locations", "verify_permissions"]],
  ["x_social", ["read_post_metrics"]],
  ["youtube_insights", ["read"]],
  ["youtube", ["channel_stats", "search_videos", "video_stats"]],
];

const READ_ONLY_INDEX: ReadonlyMap<string, string | null> = new Map(
  READ_ONLY_TOOLS.flatMap(([server, tools, phrase]) =>
    tools.map((tool) => [`${server}__${tool}`, phrase ?? null] as const),
  ),
);

function readOnlyEntry(name: string): string | null | undefined {
  const segments = name.split("__");
  if (segments.length < 2) return undefined;
  return READ_ONLY_INDEX.get(segments.slice(-2).join("__"));
}

export function isReadOnlyTool(raw: string | null | undefined): boolean {
  return readOnlyEntry((raw ?? "").trim()) !== undefined;
}

export const GENERIC_TOOL_PHRASE = "Used a connected tool";

const PLUMBING = /^toolsearch$/i;

export function isPlumbingToolName(raw: string | null | undefined): boolean {
  const bare = (raw ?? "").split("__").pop() ?? "";
  return PLUMBING.test(bare.trim());
}

export function describeTool(raw: string | null | undefined): string {
  const name = (raw ?? "").trim();
  if (!name) return GENERIC_TOOL_PHRASE;
  const readOnlyPhrase = readOnlyEntry(name);
  if (readOnlyPhrase) return readOnlyPhrase;
  for (const [re, phrase] of FAMILIES) {
    if (!re.test(name)) continue;
    if (phrase === SOCIAL_POST_PHRASE && (readOnlyPhrase === null || SOCIAL_READ_VERB.test(name.split("__").pop() ?? ""))) {
      return SOCIAL_READ_PHRASE;
    }
    return phrase;
  }
  return GENERIC_TOOL_PHRASE;
}
