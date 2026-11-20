
const SERVER_LABELS: Readonly<Record<string, string>> = {
  github: "GitHub",
  operator_db: "your database",
  supabase_connector: "your database",
  stripe: "Stripe",
  meta_ads: "Meta Ads",
  google_ads: "Google Ads",
  microsoft_ads: "Microsoft Ads",
  linkedin_ads: "LinkedIn Ads",
  tiktok_ads: "TikTok Ads",
  reddit_ads: "Reddit Ads",
  x_ads: "X Ads",
  snapchat_ads: "Snapchat Ads",
  pinterest_ads: "Pinterest Ads",
  apple_ads: "Apple Search Ads",
  spotify_ads: "Spotify Ads",
  google_analytics: "Google Analytics",
  google_search_console: "Google Search Console",
  google_sheets: "Google Sheets",
  google_calendar: "Google Calendar",
  posthog: "PostHog",
  sentry: "Sentry",
  slack: "Slack",
  jira: "Jira",
  linear: "Linear",
  figma: "Figma",
  instagram: "Instagram",
  tiktok: "TikTok",
  youtube: "YouTube",
  youtube_insights: "YouTube",
  reddit: "Reddit",
  pinterest: "Pinterest",
  pinterest_insights: "Pinterest",
  x_social: "X",
  web_search: "Web search",
  web_fetch: "A web page",
  support_inbox: "your support inbox",
  email: "email",
  email_campaign: "your email tool",
  memory: "company notes",
  brain: "company notes",
  growth: "your growth data",
};

const TOOL_LABELS: Readonly<Record<string, string>> = {
  github__list_open_prs: "open pull requests",
  github__get_pr_diff: "a pull request",
  github__list_repos: "repositories",
  github__list_files: "repository files",
  github__read_file: "a file in your repo",
  github__search_code: "code search",
  github__grep: "code search",
  github__search_issues: "issues",
  github__list_commits: "recent commits",
  operator_db__query: "a query",
  stripe__list_charges: "charges",
  stripe__list_disputes: "disputes",
  stripe__list_subscriptions: "subscriptions",
  slack__search: "message search",
};

const WHOLE_LABELS: Readonly<Record<string, string>> = {
  growth__read_business_controls: "your goals and limits",
  growth__propose_business_controls: "your goals and limits",
  growth__compute: "a calculation",
  growth__get_metric: "your metrics",
  growth__read_metric_history: "your metrics",
  growth__explain_change: "your metrics",
  growth__read_revenue: "your revenue",
  growth__ad_budget_room: "your ad budget",
  growth__read_ads_perf: "your ad results",
  growth__read_cohort: "your cohorts",
  growth__diagnose_funnel: "your funnel",
  growth__read_experiment_ledger: "your experiments",
  growth__read_action_outcomes: "your past actions",
};

export const GENERIC_SOURCE_LABEL = "a connected tool";

function bareToolName(name: string): string {
  let n = name.trim();
  if (n.startsWith("mcp__")) n = n.slice("mcp__".length);
  if (n.startsWith("server__")) n = n.slice("server__".length);
  return n;
}

export function toolSourceLabel(name: string | null | undefined): string {
  if (typeof name !== "string" || name.trim().length === 0) return GENERIC_SOURCE_LABEL;
  const bare = bareToolName(name);
  const whole = WHOLE_LABELS[bare];
  if (whole) return whole;
  const sep = bare.indexOf("__");
  if (sep <= 0) return GENERIC_SOURCE_LABEL;
  const server = SERVER_LABELS[bare.slice(0, sep)];
  if (!server) return GENERIC_SOURCE_LABEL;
  const tool = TOOL_LABELS[bare];
  return tool ? `${server}: ${tool}` : server;
}

export function isCompanyNotesTool(name: string | null | undefined): boolean {
  if (typeof name !== "string") return false;
  const bare = bareToolName(name);
  const sep = bare.indexOf("__");
  const server = sep > 0 ? bare.slice(0, sep) : "";
  return server === "memory" || server === "brain";
}
