
export const SUGGESTION_CATEGORIES = ["creative", "campaign", "landing_page", "budget", "other"] as const;
export const SUGGESTION_PRIORITIES = ["high", "medium", "low"] as const;
export const SUGGESTION_STATUSES = ["draft", "awaiting_client", "approved", "archived"] as const;
export const SUGGESTION_SOURCES = ["ai_evidence", "ai_ads", "manual", "paste"] as const;
export const SUGGESTION_EVIDENCE_PROVIDERS = [
  "meta_ads",
  "google_ads",
  "ga4",
  "autopilot_goals",
  "competitor_intel_weekly",
  "human_reviewed_profile",
] as const;

export type SuggestionCategory = (typeof SUGGESTION_CATEGORIES)[number];
export type SuggestionPriority = (typeof SUGGESTION_PRIORITIES)[number];
export type SuggestionStatus = (typeof SUGGESTION_STATUSES)[number];
export type SuggestionSource = (typeof SUGGESTION_SOURCES)[number];
export type SuggestionEvidenceProvider = (typeof SUGGESTION_EVIDENCE_PROVIDERS)[number];
