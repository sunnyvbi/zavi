import { paceTone, roasVerdict, type ChannelMetric } from "./channelPage";

export const GADS_SLUG = "google_ads";

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
  key: string;
  value: number | null;
  prev: number | null;
  unit: "usd" | "count" | "ratio" | "pct";
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
};

export type GadsRange = { id: string; label: string; days: number };

export type GadsPayload = {
  generic?: boolean;
  connected: boolean;
  error_code: string | null;
  ranges?: GadsRange[];
  period?: { from: string; to: string };
  prev_period?: { from: string; to: string };
  account: { name: string | null; customer_id: string | null; campaign_count: number | null } | null;
  kpis: GadsKpi[];
  campaigns: GadsCampaign[];
  totals: { campaigns: number; spend: number; conversions: number; cpa: number | null; conv_value: number; roas: number | null } | null;
};

export const DEFAULT_RANGES: GadsRange[] = [
  { id: "7d", label: "Last 7 days", days: 7 },
  { id: "14d", label: "Last 14 days", days: 14 },
  { id: "30d", label: "Last 30 days", days: 30 },
];

export const DEFAULT_RANGE_ID = "30d";

export function rangeFor(id: string, ranges?: readonly GadsRange[]): GadsRange {
  const list = ranges?.length ? ranges : DEFAULT_RANGES;
  return list.find((r) => r.id === id) ?? DEFAULT_RANGES.find((r) => r.id === id) ?? DEFAULT_RANGES[2];
}

export function money(n: number | null | undefined, cents = false): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 })}`;
}

export function count(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-";
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

export function roas(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-";
  return `${n.toFixed(2)}×`;
}

function shortDate(ymd: string): string {
  return new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export function periodLabel(range: GadsRange, period?: { from: string; to: string }): string {
  if (!period) return range.label;
  const year = new Date(`${period.to}T00:00:00Z`).getUTCFullYear();
  return `${range.label}: ${shortDate(period.from)} – ${shortDate(period.to)}, ${year}`;
}

function paceDisplay(k: GadsKpi): Pick<ChannelMetric, "tone" | "note"> {
  const p = k.pacing;
  const tone = paceTone(k.value);
  const note =
    p && p.spend !== null && p.plan !== null ? `${money(p.spend)} of ${money(p.plan)} · day ${p.days_elapsed} of ${p.days_in_month}` : undefined;
  return { ...(tone ? { tone } : {}), ...(note ? { note } : {}) };
}

export function kpisToMetrics(d: Pick<GadsPayload, "kpis" | "period" | "prev_period">): ChannelMetric[] {
  const day = d.period?.to ?? "";
  return d.kpis.map((k) => ({
    key: k.key,
    value: k.value ?? Number.NaN,
    unit: k.key === "pacing" ? "pct" : k.unit,
    grounded: k.value !== null,
    prev_value: k.floor === true ? null : k.prev,
    day,
    ...(k.key === "roas" ? roasVerdict(k.value, { floor: k.floor === true }) : {}),
    ...(k.key === "pacing" ? paceDisplay(k) : {}),
  }));
}

export type AccountLine = { title: string; sub: string };

export function accountLine(account: GadsPayload["account"]): AccountLine {
  const n = account?.campaign_count;
  const camps = n === null || n === undefined ? "Campaigns could not be read" : `${n} ${n === 1 ? "campaign" : "campaigns"}`;
  return { title: `Google Ads${account?.name ? ` · ${account.name}` : ""}`, sub: camps };
}

export type Banner = { kind: "reconnect" | "unreadable"; text: string };

export function errorBanner(d: Pick<GadsPayload, "connected" | "error_code">): Banner | null {
  if (!d.connected || !d.error_code) return null;
  if (d.error_code === "google_ads_token_revoked") {
    return { kind: "reconnect", text: "Google Ads stopped accepting Zavi's access, so these numbers could not be read. Reconnect to bring them back." };
  }
  return { kind: "unreadable", text: "Zavi could not read your Google Ads account just now. Try Refresh in a minute." };
}

export type StatusChip = { label: string; tone: "warn" | "good" | "muted" };

export function statusChip(c: Pick<GadsCampaign, "status" | "limited_by_budget">): StatusChip {
  if (c.status === "ENABLED" && c.limited_by_budget) return { label: "Limited", tone: "warn" };
  if (c.status === "ENABLED") return { label: "Enabled", tone: "good" };
  return { label: c.status ? c.status.charAt(0) + c.status.slice(1).toLowerCase() : "Unknown", tone: "muted" };
}

export function planLine(p: GadsPacing): string {
  if (p.plan === null) return "No plan yet: set one or add daily budgets";
  const caps =
    p.capped_campaigns !== null && p.campaigns !== null && p.campaigns > 0
      ? ` · ${p.capped_campaigns} of ${p.campaigns} campaigns spent their full daily budget on most days`
      : "";
  return `${money(p.spend)} of ${money(p.plan)} this month${caps}`;
}

export function planEditLabel(p: Pick<GadsPacing, "plan_basis">): string {
  return p.plan_basis === "founder" ? "Your plan · Edit plan" : "Plan from your daily budgets · Edit plan";
}

export function parseBudget(text: string): number | null {
  const n = Number(text.replace(/[$,\s]/g, ""));
  return text.trim() !== "" && Number.isFinite(n) && n >= 0 ? n : null;
}
