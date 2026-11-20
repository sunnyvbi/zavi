
export const PENDING_STRATEGIST_CLASS = "perfmkt.create_ad_set_pending_strategist";

export const PENDING_STRATEGIST_KIND = "create_ad_set_pending_strategist";

export const FINAL_CREATE_CLASS = "meta_ads.create_ad_set";

export const REVIEW_FAILED_ADVISORY_CLASS = "agent.urgent_advisory";

export const STRATEGIST_AGENT_SLUG = "growth-lead";

export type ReviewStatus = "pending" | "resolving" | "approved" | "bounced" | "failed";

export const REVIEW_STATUS_TERMINAL: ReadonlySet<ReviewStatus> = new Set([
  "approved",
  "bounced",
  "failed",
]);

export const MAX_REVIEW_ATTEMPTS = 3;

export const REVIEW_STALE_MS = 20 * 60 * 1000;

export const RESOLVE_STALE_MS = 5 * 60 * 1000;

export type MarketFitVerdict = "approve" | "bounce";
