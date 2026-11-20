
export const START_CARD_STATUSES = ["queued", "running", "done", "failed", "expired", "removed"] as const;
export type StartCardStatus = (typeof START_CARD_STATUSES)[number];

export const START_CARD_CHECK_KEYS = ["google", "ai", "seo", "design", "compare"] as const;
export type StartCardCheckKey = (typeof START_CARD_CHECK_KEYS)[number];

export const START_CARD_POINTS_PER_CHECK = 20;

export const START_CARD_AI_ENGINES = ["chatgpt", "gemini", "perplexity", "claude"] as const;
export type StartCardAiEngine = (typeof START_CARD_AI_ENGINES)[number];

export const START_CARD_LOCALES = ["US", "IN", "GB", "CA", "AU", "SG", "AE", "IE", "NZ", "DE", "FR"] as const;
export type StartCardLocale = (typeof START_CARD_LOCALES)[number];

export type StartCardPartState = "pending" | "done" | "unavailable";

export type StartCardPart<E> = {
  state: StartCardPartState;
  evidence: E | null;
  points?: number;
  max_points?: number;
  unavailable_reason?: string;
  fetched_at: string | null;
};

export type StartCardRival = {
  name: string;
  domain: string | null;
  no_site: boolean;
  source_url: string | null;
};

export type StartCardProfileEvidence = {
  company_name: string;
  category: string;
  description?: string;
  search_term: string;
  country: StartCardLocale;
  country_from: "cctld" | "address" | "visitor" | "default_us";
  country_label?: string;
  city?: string | null;
  rivals: StartCardRival[];
  company_type?: StartCardCompanyType;
};

export const START_CARD_COMPANY_TYPES = ["marketplace", "saas", "ecommerce", "services", "fintech", "other"] as const;
export type StartCardCompanyType = (typeof START_CARD_COMPANY_TYPES)[number];

export type StartCardDiagnosisEvidence = {
  constraint: { check_key: StartCardCheckKey; title: string; why: string };
  action_this_week: { title: string; why: string };
};

export type StartCardGoogleEvidence = {
  search_term: string;
  term_source?: "ranked" | "profile";
  scored_term?: string;
  broad_term?: string;
  broad_position?: number | null;
  broad_results_checked?: number;
  broad_top_domain?: string | null;
  locale: StartCardLocale;
  results_checked: number;
  position: number | null;
  rivals: { domain: string; position: number | null }[];
  top_domains?: string[];
  note?: string;
};

export type StartCardAiEvidence = {
  prompt: string;
  engines: {
    engine: StartCardAiEngine;
    answered: boolean;
    mentioned: boolean | null;
    rivals_mentioned?: string[];
  }[];
  note?: string;
};

export type StartCardSeoEvidence = {
  pages_checked: string[];
  title: string | null;
  meta_description: string | null;
  h1_count: number;
  schema_types: string[];
  robots_allows_root: boolean | null;
  sitemap_found: boolean;
  broken_links: { url: string; status: number }[];
  site_pages?: string[];
  rivals?: { domain: string; points: number | null }[];
  note?: string;
};

export type StartCardRenderResult = {
  cta_above_fold: boolean;
  body_text_px: number | null;
  overlapping_boxes: boolean;
  horizontal_scroll: boolean;
  overlap_pairs?: number;
  cta_text?: string | null;
};

export type StartCardDesignEvidence = {
  pagespeed: { performance: number; accessibility: number } | null;
  render: StartCardRenderResult | null;
  rivals: { domain: string; render: StartCardRenderResult | null; points: number | null }[];
  note?: string;
};

export type StartCardCompareEvidence = {
  ranking: { domain: string; is_business: boolean; checks_total: number; rank: number }[];
  checks_used?: StartCardCheckKey[];
  note?: string;
};

export type StartCardParts = {
  profile?: StartCardPart<StartCardProfileEvidence>;
  google?: StartCardPart<StartCardGoogleEvidence>;
  ai?: StartCardPart<StartCardAiEvidence>;
  seo?: StartCardPart<StartCardSeoEvidence>;
  design?: StartCardPart<StartCardDesignEvidence>;
  compare?: StartCardPart<StartCardCompareEvidence>;
  diagnosis?: StartCardPart<StartCardDiagnosisEvidence>;
};

export type StartCardPartKey = keyof StartCardParts;
export const START_CARD_PART_KEYS: readonly StartCardPartKey[] = [
  "profile",
  "google",
  "ai",
  "seo",
  "design",
  "compare",
  "diagnosis",
];

export type StartCardScore = {
  total: number;
  out_of: number;
  by_check: Record<StartCardCheckKey, number | null>;
};

export type StartCard = {
  public_id: string;
  domain: string;
  locale: StartCardLocale;
  search_term: string | null;
  status: StartCardStatus;
  parts: StartCardParts;
  score: StartCardScore | null;
  scorer_version: string;
  created_at: string;
  expires_at: string;
};

export type StartCardCreateRequest = {
  url: string;
  turnstile_token?: string | null;
  ref?: string | null;
};

export type StartCardCreateResponse =
  | { state: "created"; public_id: string; reused: boolean }
  | { state: "queued" };

export type StartCardQueueRequest = {
  url: string;
  email: string;
  turnstile_token?: string | null;
};

export type StartCardQueueResponse = { state: "confirm_sent" };

export type StartCardConfigResponse = {
  captcha: { required: boolean; site_key: string | null };
};

export const GROWTH_LEADERBOARD_CATEGORIES = [
  { key: "ecommerce", label: "E-commerce" },
  { key: "saas", label: "SaaS" },
  { key: "marketplace", label: "Marketplace" },
  { key: "local", label: "Local business" },
  { key: "agency", label: "Agency" },
  { key: "other", label: "Other" },
] as const;
export type GrowthLeaderboardCategory = (typeof GROWTH_LEADERBOARD_CATEGORIES)[number]["key"];

export type GrowthLeaderboardRow = {
  rank: number;
  public_id: string;
  domain: string;
  score: { total: number; out_of: number };
  category: GrowthLeaderboardCategory;
  country: StartCardLocale | null;
  constraint: string | null;
  is_new: true;
};

export type GrowthLeaderboardResponse = {
  total: number;
  rows: GrowthLeaderboardRow[];
  generated_at: string;
};

export type GrowthLeaderboardRankResponse = { listed: false } | { listed: true; rank: number; total: number };
