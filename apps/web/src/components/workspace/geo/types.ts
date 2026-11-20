
export type GeoEngine = "chatgpt" | "claude" | "gemini" | "perplexity";

export type LaneError = { error: true };
export type Lane<T> = T | LaneError;

export type Rate = {
  numerator: number;
  denominator: number;
  rate: number | null;
  ci95: { low: number; high: number } | null;
  margin_pp: number | null;
};

export type EngineRate = Rate & { engine: GeoEngine; label: string };

export type RateDelta = { delta_pp: number; significant: boolean };

export type DeltaOr = RateDelta | { unavailable: string };

export type SourceDomain = {
  domain: string;
  responses: number;
  used: number;
  citations: number;
  kind: "owned" | "rival" | "other";
  rival: string | null;
};

export type PromptCell = { collected: number; mentioned: number; cited: number };

export type PromptGridRow = {
  prompt_id: string;
  prompt_text: string;
  engines: Partial<Record<GeoEngine, PromptCell>>;
  all: PromptCell;
};

export type VisibilityMetrics = {
  prompt_coverage?: { engine: GeoEngine; planned: number }[];
  prompt_grid?: { rows: PromptGridRow[]; totals: { engines: Partial<Record<GeoEngine, PromptCell>>; all: PromptCell } };
  disclosure: string;
  responses: {
    planned: number;
    collected: number;
    failed: number;
    sweeps: number;
    prompts: number;
    engines: number;
  };
  mention_rate: Rate & { by_engine: EngineRate[] };
  citation_rate: Rate & { by_engine: EngineRate[] };
  source_mix: { domains: SourceDomain[]; domains_total: number };
  share_of_voice: {
    state: "ok" | "no_rivals" | "no_mentions";
    share: number | null;
    brand_mentions: number;
    rival_mentions: number;
    rivals: { name: string; mentions: number; share: number | null }[];
  };
};

export type VisibilityHistoryRow = {
  sweep_id: string;
  finished_at: string | null;
  mention_rate: number | null;
  citation_rate: number | null;
  share_of_voice: number | null;
  rival_set_changed: boolean;
  prompt_set_changed: boolean;
};

export type VisibilityPanel = {
  state: "not_configured" | "no_prompts" | "never_run" | "no_data_in_window" | "ok";
  country: string;
  window_days: number;
  metrics: VisibilityMetrics | null;
  deltas: {
    mention_rate: DeltaOr;
    citation_rate: DeltaOr;
    share_of_voice: DeltaOr;
  };
  running: {
    sweep_id: string;
    country: string;
    started_at: string;
    planned: number;
    collected: number;
  } | null;
  history: VisibilityHistoryRow[];
  config: {
    enabled: boolean;
    configured: boolean;
    brand: string | null;
    prompts_active: number;
    suggestions_pending: number;
    starter_stale?: boolean;
    engines: { id: GeoEngine; label: string }[];
    countries: { country: string; label: string; tracked: boolean }[];
    run_limit_reached?: boolean;
  };
};

export type BotClass = "training" | "search" | "user";

export type CrawlerBotSummary = {
  bot: string;
  owner: string;
  class: BotClass;
  recommended: boolean;
  hits: number;
  blocked_hits: number;
  robots: { state: "allowed" | "blocked" | "partial" | null };
  callout: string | null;
};

export type CrawlerDay = {
  day: string;
  hits: number;
  blocked_hits: number;
  by_class: Record<BotClass, number>;
};

export type CrawlerHitsPanel = {
  disclosure: string;
  state: "not_connected" | "awaiting_logs" | "ok";
  window_days: number;
  ingest: {
    connected: boolean;
    created_at: string | null;
    last_received_at: string | null;
  };
  totals: { hits: number; blocked_hits: number };
  bots: CrawlerBotSummary[];
  daily: CrawlerDay[];
};

export type ReadinessBand = {
  key: string;
  label: string;
  weight: number;
  score: number;
  note: string;
};

export type ReadinessFinding = {
  code: string;
  severity: "blocker" | "high" | "medium";
  summary: string;
  urls: string[];
};

export type ReadinessCrawler = {
  name: string;
  recommended: boolean;
  state: "allowed" | "blocked" | "partial" | "unknown";
  directive?: string | null;
  from_wildcard?: boolean;
  disallowed_paths?: string[];
  public_blocked?: string[];
};

export type ReadinessLane = {
  status: "ok" | "error";
  site: string | null;
  fetched_at: string;
  pages_analyzed: number;
  score: { total: number; bands: ReadinessBand[] };
  completeness: { below_floor: boolean; warning: string | null };
  disclosure: string;
  crawlers: ReadinessCrawler[];
  llms_txt: boolean | null;
  findings: ReadinessFinding[];
  not_checked: string[];
  grade: "low" | "medium" | "high" | "not_measured";
};

export type GeoMetricsPayload = {
  readiness: Lane<ReadinessLane | null>;
  visibility: Lane<VisibilityPanel>;
  crawler_hits: Lane<CrawlerHitsPanel>;
};

export type GeoPrompt = {
  id: string;
  prompt_text: string;
  rationale: string | null;
  status?: "suggested" | "active" | "archived";
};

export type GeoChannelPayload = GeoMetricsPayload & {
  prompts?: { active: GeoPrompt[]; suggested: GeoPrompt[] } | null;
};
