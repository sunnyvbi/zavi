
export type GadsKpiKey = "spend" | "conversions" | "cpa" | "conv_value" | "roas" | "pacing";

export type GadsPacing = {
  spend: number | null;
  plan: number | null;
  plan_basis: "auto" | "founder";
  pct: number | null;
  capped_campaigns: number | null;
  campaigns: number | null;
  days_elapsed: number;
  days_in_month: number;
};

export type GadsKpi = {
  key: GadsKpiKey;
  label: string;
  value: number | null;
  prev: number | null;
  delta_pct: number | null;
  delta_abs: number | null;
  delta_good: boolean | null;
  unit: "usd" | "count" | "ratio" | "pct";
  conversions?: { calls: number; forms: number; other: number; by_kind?: Array<{ label: string; count: number }> } | null;
  partial?: boolean;
  floor?: boolean;
  pacing?: GadsPacing;
};

export type GadsCampaign = {
  id: string;
  name: string;
  status: string;
  limited_by_budget: boolean;
  spend: number;
  conversions: number;
  cpa: number | null;
  conv_value: number;
  url: string | null;
  daily_budget?: number | null;
  budget_shared?: boolean;
  channel_type?: string | null;
  views?: number | null;
  view_rate?: number | null;
  cpv?: number | null;
};

export type GadsTile = { value: string; caption: string };

export type GadsAction = {
  key: string;
  decision_id: string;
  decision_class: string;
  bucket: "needs_approval" | "needs_you" | "autonomous";
  title: string;
  is_new: boolean;
  effort_label: string;
  change_sentence: string | null;
  evidence: { window_label: string | null; tiles: GadsTile[]; reasoning: string | null } | null;
  exact_change: { rows: Array<{ item: string; before: string; after: string }> } | null;
  estimate: { tiles: GadsTile[] } | null;
  link: string | null;
  applied_at: string | null;
};

export type GadsDailyBudget = {
  total_daily_budget_usd: number | null;
  active_campaigns: number;
  today: { date: string; spend_usd: number; by_campaign: Record<string, number> } | null;
  days: Array<{ date: string; spend_usd: number; by_campaign: Record<string, number> }>;
  campaigns: Array<{ campaign_id: string; campaign_name: string; status: string | null; daily_budget_usd: number | null; shared: boolean }>;
  history_unreadable?: boolean;
};

export type GadsRange = { id: string; label: string; days: number };

export type GadsPayload = {
  platform?: "google_ads" | "youtube_ads";
  currency?: string | null;
  campaigns_note?: string;
  generic?: boolean;
  connected: boolean;
  error_code: string | null;
  window_days: number;
  ranges?: GadsRange[];
  period?: { from: string; to: string };
  prev_period?: { from: string; to: string };
  account: { name: string | null; customer_id: string | null; campaign_count: number | null } | null;
  kpis: GadsKpi[];
  campaigns: GadsCampaign[];
  totals: {
    campaigns: number;
    spend: number;
    conversions: number;
    cpa: number | null;
    conv_value: number;
    roas: number | null;
    views?: number | null;
    view_rate?: number | null;
    cpv?: number | null;
  } | null;
  paused_campaigns?: Array<{ id: string; name: string; channel_type?: string | null; url: string | null; daily_budget: number | null }>;
  daily_budget?: GadsDailyBudget | null;
  actions: GadsAction[];
  counts: { all: number; needs_you: number; autonomous: number };
  actions_more?: number;
};

export const DEFAULT_RANGES: GadsRange[] = [
  { id: "7d", label: "Last 7 days", days: 7 },
  { id: "14d", label: "Last 14 days", days: 14 },
  { id: "30d", label: "Last 30 days", days: 30 },
];

export function money(n: number | null | undefined, cents = false): string {
  if (n === null || n === undefined) return "-";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 })}`;
}

export function count(n: number | null | undefined): string {
  if (n === null || n === undefined) return "-";
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

export function roas(n: number | null | undefined): string {
  if (n === null || n === undefined) return "-";
  return `${n.toFixed(2)}×`;
}

export function shortDate(ymd: string): string {
  return new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export function periodLabel(range: GadsRange, period?: { from: string; to: string }): string {
  if (!period) return range.label;
  const year = new Date(`${period.to}T00:00:00Z`).getUTCFullYear();
  return `${range.label}: ${shortDate(period.from)} – ${shortDate(period.to)}, ${year}`;
}
