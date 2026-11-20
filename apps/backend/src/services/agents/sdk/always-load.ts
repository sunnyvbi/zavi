export const ALWAYS_LOAD_WHEN_GRANTED: readonly string[] = [
  "praxis__propose_custom_agent",
  "operator_db__catalog",
  "operator_db__query",
];

export function alwaysLoadWhenGranted(granted: readonly string[]): string[] {
  return ALWAYS_LOAD_WHEN_GRANTED.filter((t) => granted.includes(t));
}

export const ALWAYS_LOAD_BY_AGENT: Readonly<Record<string, readonly string[]>> = {
  operator: ["praxis__handoff", "growth__get_metric", "growth__utilization_by_location"],
  chatgpt_ads: ["chatgpt_ads__read_performance"],
  meta_ads: [
    "meta_ads__list_campaigns",
    "meta_ads__list_pages",
    "meta_ads__pixel_health",
    "meta_ads__propose_campaign_launch",
    "meta_ads__propose_new_campaign",
    "meta_ads__propose_status_change",
    "meta_ads__propose_campaign_update",
    "meta_ads__propose_budget_change",
  ],
  instagram_organic: ["report__render_social_image", "social__propose_post", "social__list_posts", "instagram__read_insights"],
  reddit_ads: [
    "reddit_ads__check_readiness",
    "reddit_ads__read_objects",
    "reddit_ads__read_performance",
    "reddit_ads__propose_prepare_campaign",
    "reddit_ads__propose_launch_campaign",
    "reddit_ads__propose_update_budget",
    "reddit_ads__propose_update_targeting",
    "reddit_ads__propose_update_ad",
    "reddit_ads__propose_replace_creative",
    "reddit_ads__propose_set_object_status",
    "reddit_ads__propose_rename_object",
    "reddit_ads__propose_remove_object",
  ],
  cgo: [
    "growth__get_metric",
    "operator_db__catalog",
    "operator_db__query",
    "memory__search",
    "web_fetch__fetch",
    "web_search__search",
    "growth__read_business_controls",
  ],
};

const CGO_STAGE_PRELOADS: Readonly<Record<string, readonly string[]>> = {
  draft_strategy: ["growth__seo_audit", "growth__diagnose_funnel"],
  own_goals: ["growth__compute", "growth__ad_budget_room"],
};

export function alwaysLoadForAgent(slug: string, granted: readonly string[], stage?: unknown): string[] {
  const staged = slug === "cgo" && typeof stage === "string" &&
    Object.prototype.hasOwnProperty.call(CGO_STAGE_PRELOADS, stage) ? CGO_STAGE_PRELOADS[stage] : [];
  return [...new Set([...alwaysLoadWhenGranted(granted), ...(ALWAYS_LOAD_BY_AGENT[slug] ?? []), ...staged])];
}
