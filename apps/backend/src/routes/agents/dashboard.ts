
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { serverClientFromBearer } from "@/services/supabase";
import { PERF_DASH_SCHEMA } from "@/services/growth/perf-dash-schema";
import type { ToolContext } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import { loadAgentDefinition } from "@/services/agents/registry";
import {
  parseSurfaceSource,
  trackSurfaceOpened,
} from "@/services/analytics/surface-events";
import { DASHBOARD_BUILDERS } from "./dashboards/registry";
import { metaListCampaignsTool } from "@/services/tools/meta-ads/list_campaigns";
import { metaListAdSetsTool, enumerateCampaignAdSets } from "@/services/tools/meta-ads/list_ad_sets";
import { metaPixelHealthTool } from "@/services/tools/meta-ads/pixel_health";
import { fbGet, metaAdsCreds, metaDateRange, getAdAccountCurrency } from "@/services/tools/meta-ads/_client";
import { fetchRecentlyChangedObjectIds } from "@/services/tools/meta-ads/recent_changes";
import { gadsSearch } from "@/services/tools/google-ads/_client";
import { googleCampaignUrl, readGoogleCampaigns } from "./dashboards/_google-campaigns";
import {
  fetchMetaDailySeries,
  type MetaDailyPreset,
  type MetaDailyRow,
} from "@/services/tools/meta-ads/daily_series";
import {
  type GoogleDailyRange,
  type GoogleDailyRow,
} from "@/services/tools/google-ads/daily_series";
import { buildDailyTrend } from "@/services/growth/perf-brief/daily-trend";
import { buildMetaDailyBudget, fetchMetaTodaySpend, type MetaTodaySpend } from "@/services/agents/dashboards/meta-daily-budget";
import { buildBookingTrend, type BookingTrend } from "@/services/growth/booking-metrics/trend";

type Channel = "meta" | "google";
type ObjectiveKey =
  | "renter_bookings"
  | "renter_signups"
  | "host_supply"
  | "expansion_metros"
  | "remarketing"
  | "uncategorized";
type ObjectiveStatus = "scale" | "watch" | "cut" | "pause" | "hold";

type DashboardActiveRun = {
  run_id: string;
  status: "queued" | "running";
  enqueued_at: string | null;
  started_at: string | null;
};

const WINDOWS = {
  last_7d: { meta: "last_7d", google: "LAST_7_DAYS", label: "Last 7 days" },
  last_14d: { meta: "last_14d", google: "LAST_14_DAYS", label: "Last 14 days" },
  last_28d: { meta: "last_28d", google: "LAST_30_DAYS", label: "Last 28 days" },
  last_30d: { meta: "last_30d", google: "LAST_30_DAYS", label: "Last 30 days" },
  this_month: { meta: "this_month", google: "THIS_MONTH", label: "This month" },
  last_month: { meta: "last_month", google: "LAST_MONTH", label: "Last month" },
} as const;
type WindowKey = keyof typeof WINDOWS;

function parseWindow(raw: unknown): WindowKey {
  return typeof raw === "string" && raw in WINDOWS
    ? (raw as WindowKey)
    : "last_30d";
}

export const DASHBOARD_RANGE_DAYS = [7, 14, 30] as const;

export function parseRangeDays(raw: unknown): number | null {
  const n = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : NaN;
  return (DASHBOARD_RANGE_DAYS as readonly number[]).includes(n) ? n : null;
}

export function parseRequestedDays(raw: unknown): number | null {
  const n = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 366 ? n : null;
}

export type CustomRange = { since: string; until: string };

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_CUSTOM_RANGE_DAYS = 366;

export function parseCustomRange(
  rawSince: unknown,
  rawUntil: unknown,
  now: Date = new Date(),
): CustomRange | null {
  if (typeof rawSince !== "string" || typeof rawUntil !== "string") return null;
  if (!YMD_RE.test(rawSince) || !YMD_RE.test(rawUntil)) return null;
  const since = new Date(`${rawSince}T00:00:00Z`);
  const until = new Date(`${rawUntil}T00:00:00Z`);
  if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime())) return null;
  if (since.getTime() > until.getTime()) return null;
  const spanDays = Math.round((until.getTime() - since.getTime()) / 86400000) + 1;
  if (spanDays < 1 || spanDays > MAX_CUSTOM_RANGE_DAYS) return null;
  const todayYmd = now.toISOString().slice(0, 10);
  const tomorrowYmd = new Date(now.getTime() + 86400000).toISOString().slice(0, 10);
  const cappedUntil = rawUntil > todayYmd ? todayYmd : rawUntil;
  const cappedSince = rawSince === tomorrowYmd ? todayYmd : rawSince;
  if (cappedSince > cappedUntil) return null;
  return { since: cappedSince, until: cappedUntil };
}

export const BUILDER_RANGE_MAX_DAYS = 90;

export function parseBuilderRange(rawSince: unknown, rawUntil: unknown, now: Date = new Date()): CustomRange | null {
  const range = parseCustomRange(rawSince, rawUntil, now);
  return range && rangeDays(range) <= BUILDER_RANGE_MAX_DAYS ? range : null;
}

type WindowSpec = {
  key: WindowKey | "custom";
  meta: string;
  google: string;
  label: string;
  days: number;
  range: CustomRange | null;
};

function customLabel(r: CustomRange): string {
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const fmt = (ymd: string) => {
    const [y, m, d] = ymd.split("-").map(Number);
    return `${MON[m - 1]} ${d}, ${y}`;
  };
  return r.since === r.until ? fmt(r.since) : `${fmt(r.since)} – ${fmt(r.until)}`;
}

function rangeDays(r: CustomRange): number {
  const s = new Date(`${r.since}T00:00:00Z`).getTime();
  const u = new Date(`${r.until}T00:00:00Z`).getTime();
  return Math.max(1, Math.round((u - s) / 86400000) + 1);
}

export function resolveWindowSpec(
  windowKey: WindowKey,
  range: CustomRange | null,
): WindowSpec {
  if (range) {
    return {
      key: "custom",
      meta: "last_30d",
      google: "LAST_30_DAYS",
      label: customLabel(range),
      days: rangeDays(range),
      range,
    };
  }
  const win = WINDOWS[windowKey];
  return {
    key: windowKey,
    meta: win.meta,
    google: win.google,
    label: win.label,
    days: windowDays(windowKey),
    range: null,
  };
}

const DAILY_TREND_TIMEOUT_MS = 6000;
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let t: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((res) => {
    t = setTimeout(() => res(null), ms);
  });
  return Promise.race([p.finally(() => clearTimeout(t)), timeout]);
}

async function readActiveDashboardRun({
  accessToken,
  tenantId,
  slug,
}: {
  accessToken: string;
  tenantId: string;
  slug: string;
}): Promise<DashboardActiveRun | null> {
  try {
    const sb = serverClientFromBearer(accessToken);
    const { data, error } = await sb
      .from("agent_runs")
      .select("id,status,enqueued_at,started_at")
      .eq("tenant_id", tenantId)
      .eq("agent_slug", slug)
      .in("status", ["queued", "running"])
      .order("enqueued_at", { ascending: false })
      .limit(1);
    if (error || !Array.isArray(data) || data.length === 0) return null;
    const row = data[0] as {
      id?: unknown;
      status?: unknown;
      enqueued_at?: unknown;
      started_at?: unknown;
    };
    if (
      typeof row.id !== "string" ||
      (row.status !== "queued" && row.status !== "running")
    ) {
      return null;
    }
    return {
      run_id: row.id,
      status: row.status,
      enqueued_at:
        typeof row.enqueued_at === "string" ? row.enqueued_at : null,
      started_at: typeof row.started_at === "string" ? row.started_at : null,
    };
  } catch {
    return null;
  }
}

export type CampaignLite = {
  channel: Channel;
  campaign_id: string;
  campaign_name: string;
  status?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  reach?: number | null;
  spend_usd: number;
  conversions: number;
  revenue_usd: number;
  roas: number | null;
  cpa_usd: number | null;
  impressions: number;
  clicks: number;
  ctr_percent: number | null;
  cpc_usd: number | null;
  cpm_usd: number | null;
  frequency: number | null;
  purchases: number;
  sign_ups: number;
  leads: number;
  cost_per_booking_usd: number | null;
  active_daily_budget_usd: number | null;
  optimization_label?: string | null;
  ad_sets?: AdSetLite[];
  objective_key: ObjectiveKey;
  objective_label: string;
  primary_result_label: string;
  primary_result_count: number;
  primary_cost_label: string | null;
  primary_cost_usd: number | null;
  objective_status: ObjectiveStatus;
  confidence_reasons: string[];
  triage_reasons: string[];
  is_delivering: boolean;
  pending_change: { kind: "budget" | "status"; label: string } | null;
  recent_daily_spend_usd: number | null;
  triage_state: TriageState;
  manage_url: string | null;
};

type ObjectiveGroup = {
  objective_key: ObjectiveKey;
  objective_label: string;
  spend_usd: number;
  active_daily_budget_usd: number | null;
  revenue_usd: number;
  roas: number | null;
  conversions: number;
  primary_result_label: string;
  primary_result_count: number;
  primary_cost_label: string | null;
  primary_cost_usd: number | null;
  status: ObjectiveStatus;
  confidence_reasons: string[];
  campaigns_count: number;
};

function metaCampaignUrl(accountNum: string | null, campaignId: string): string | null {
  if (!accountNum || !campaignId) return null;
  return `https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${accountNum}&selected_campaign_ids=${campaignId}`;
}

type AttentionItem = {
  severity: "high" | "warn";
  title: string;
  detail: string;
  ask: string;
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export type AdSetLite = {
  ad_set_id: string;
  ad_set_name: string;
  optimization_event: string | null;
  daily_budget_usd: number | null;
};
type AdSetEnrichment = {
  activeDailyBudgetUsd: number | null;
  adSetNames: string[];
  optimizationGoals: string[];
  isDelivering: boolean;
  recentlyChanged: boolean;
  adSets: AdSetLite[];
  optimizationLabel: string | null;
};
const EMPTY_ENRICHMENT: AdSetEnrichment = {
  activeDailyBudgetUsd: null,
  adSetNames: [],
  optimizationGoals: [],
  isDelivering: true,
  recentlyChanged: false,
  adSets: [],
  optimizationLabel: null,
};

const STOPPED_CAMPAIGN_STATUSES = new Set(["PAUSED", "ARCHIVED", "DELETED"]);
export function needsAdSetEnrichment(c: Record<string, unknown>): boolean {
  const stopped = STOPPED_CAMPAIGN_STATUSES.has(String(c.status ?? "").toUpperCase());
  const spend = Number(c.spend_usd ?? 0);
  return !stopped || !(Number.isFinite(spend) && spend === 0);
}

export function anyAdSetDelivering(
  adSets: Array<{ effective_status?: unknown; configured_status?: unknown; status?: unknown }>,
): boolean {
  if (adSets.length === 0) return true;
  const EXCLUDED = new Set(["DELETED", "ARCHIVED"]);
  const live = adSets.filter((a) => {
    const eff = String(a.effective_status ?? "").toUpperCase();
    const cfg = String(a.configured_status ?? a.status ?? "").toUpperCase();
    return !EXCLUDED.has(eff) && !EXCLUDED.has(cfg);
  });
  if (live.length === 0) return true;
  return live.some((a) => String(a.effective_status ?? "").toUpperCase() === "ACTIVE");
}

export function buildPendingByCampaign(
  rows: Array<{ decision_class?: unknown; body?: unknown }>,
): Map<string, { kind: "budget" | "status"; label: string }> {
  const out = new Map<string, { kind: "budget" | "status"; label: string }>();
  for (const r of rows) {
    const cls = String(r.decision_class ?? "");
    const body = (r.body ?? {}) as Record<string, unknown>;
    let campaignId: string | null = null;
    let entry: { kind: "budget" | "status"; label: string } | null = null;
    if (cls === "meta_ads.update_ad_set_budget_review" || cls === "meta_ads.update_campaign_budget_review") {
      campaignId = body.campaign_id ? String(body.campaign_id) : null;
      entry = { kind: "budget", label: "Budget change pending approval" };
    } else if (cls === "meta_ads.set_status_review") {
      if (String(body.level ?? "") === "campaign" && body.object_id) {
        campaignId = String(body.object_id);
        const paused = String(body.status ?? "").toUpperCase() === "PAUSED";
        entry = {
          kind: "status",
          label: paused ? "Pause pending approval" : "Resume pending approval",
        };
      }
    }
    if (campaignId && entry && !out.has(campaignId)) out.set(campaignId, entry);
  }
  return out;
}

export function combineOptimizationEvents(events: Array<string | null | undefined>): string | null {
  const seen: string[] = [];
  for (const e of events) {
    const v = (e ?? "").trim();
    if (v && !seen.includes(v)) seen.push(v);
  }
  return seen.length > 0 ? seen.join(" + ") : null;
}

const AD_SET_FETCH_CONCURRENCY = 4;
export async function mapInChunks<T, R>(
  items: T[],
  size: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}

function windowDays(windowKey: WindowKey): number {
  if (windowKey === "last_7d") return 7;
  if (windowKey === "last_14d") return 14;
  if (windowKey === "last_28d") return 28;
  if (windowKey === "last_30d") return 30;
  const now = new Date();
  if (windowKey === "this_month") return Math.max(1, now.getUTCDate());
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

const OBJECTIVE_LABELS: Record<ObjectiveKey, string> = {
  renter_bookings: "Renter bookings",
  renter_signups: "Renter signups",
  host_supply: "Host supply",
  expansion_metros: "Expansion metros",
  remarketing: "Remarketing",
  uncategorized: "Uncategorized",
};

const EXPANSION_MARKET_RX =
  /\b(vegas|las\s+vegas|orlando|miami|phoenix|fort\s+lauderdale|ft\.?\s+lauderdale|non[-\s]?ca|arizona|florida|nevada)\b/i;

function classifyObjective(input: {
  channel: Channel;
  campaignName: string;
  adSetNames?: string[];
  optimizationGoals?: string[];
  purchases: number;
  leads: number;
  signUps: number;
}): ObjectiveKey {
  const haystack = [
    input.campaignName,
    ...(input.adSetNames ?? []),
    ...(input.optimizationGoals ?? []),
  ]
    .join(" ")
    .toLowerCase();
  if (/\b(retarget|remarket|remarketing|warm|re[-\s]?engage|reengage)\b/.test(haystack)) {
    return "remarketing";
  }
  if (/\b(host|hosts|owner|owners|supply|list(ing|ed)?|car\s*supply|provider)\b/.test(haystack)) {
    return "host_supply";
  }
  if (EXPANSION_MARKET_RX.test(haystack)) return "expansion_metros";
  if (/\b(purchase|book|booking|rental|rentals|conversion|conversions|sales)\b/.test(haystack)) {
    return "renter_bookings";
  }
  if (/\b(lead|leads|signup|sign[-\s]?up|registration|register|prospect)\b/.test(haystack)) {
    return "renter_signups";
  }
  if (input.purchases > 0) return "renter_bookings";
  if (input.leads > 0 || input.signUps > 0) return "renter_signups";
  return input.channel === "google" ? "uncategorized" : "renter_signups";
}

const REVENUE_OBJECTIVES: ReadonlySet<ObjectiveKey> = new Set<ObjectiveKey>([
  "renter_bookings",
  "remarketing",
  "expansion_metros",
]);

export function isRevenueObjective(objective: ObjectiveKey): boolean {
  return REVENUE_OBJECTIVES.has(objective);
}

export function isUnprofitableCampaign(
  c: Pick<CampaignLite, "objective_key" | "spend_usd" | "roas">,
): boolean {
  return isRevenueObjective(c.objective_key) && c.spend_usd >= 5 && c.roas !== null && c.roas < 1;
}

function resultForObjective(
  objective: ObjectiveKey,
  campaign: Pick<CampaignLite, "purchases" | "sign_ups" | "leads" | "conversions" | "spend_usd">,
): {
  primary_result_label: string;
  primary_result_count: number;
  primary_cost_label: string | null;
  primary_cost_usd: number | null;
} {
  if (isRevenueObjective(objective)) {
    const count = campaign.purchases;
    return {
      primary_result_label: count === 1 ? "booking" : "bookings",
      primary_result_count: count,
      primary_cost_label: count > 0 ? "Cost / booking" : null,
      primary_cost_usd: count > 0 ? round2(campaign.spend_usd / count) : null,
    };
  }
  if (objective === "host_supply") {
    const count = campaign.leads || campaign.sign_ups || campaign.conversions;
    return {
      primary_result_label: count === 1 ? "host lead" : "host leads",
      primary_result_count: count,
      primary_cost_label: count > 0 ? "Cost / host lead" : null,
      primary_cost_usd: count > 0 ? round2(campaign.spend_usd / count) : null,
    };
  }
  if (objective === "renter_signups") {
    const count = campaign.sign_ups || campaign.leads || campaign.conversions;
    return {
      primary_result_label: count === 1 ? "signup" : "signups",
      primary_result_count: count,
      primary_cost_label: count > 0 ? "Cost / signup" : null,
      primary_cost_usd: count > 0 ? round2(campaign.spend_usd / count) : null,
    };
  }
  const count = campaign.conversions;
  return {
    primary_result_label: count === 1 ? "conversion" : "conversions",
    primary_result_count: count,
    primary_cost_label: count > 0 ? "Cost / conversion" : null,
    primary_cost_usd: count > 0 ? round2(campaign.spend_usd / count) : null,
  };
}

const SCALE_MIN_BUDGET_UTILIZATION = 0.7;

export function statusForObjective(input: {
  objective: ObjectiveKey;
  spend_usd: number;
  roas: number | null;
  primary_result_count: number;
  purchases: number;
  active_daily_budget_usd?: number | null;
  recent_daily_spend_usd?: number | null;
}): ObjectiveStatus {
  if (input.spend_usd >= 20 && input.primary_result_count === 0) return "pause";
  if (
    isRevenueObjective(input.objective) &&
    input.roas !== null &&
    input.roas < 1 &&
    input.spend_usd >= 5
  )
    return "cut";
  if (
    (input.objective === "renter_bookings" || input.objective === "remarketing") &&
    input.purchases >= 10 &&
    input.roas !== null &&
    input.roas >= 1.5
  ) {
    const cap = input.active_daily_budget_usd;
    const recentDailySpend = input.recent_daily_spend_usd;
    if (
      cap != null &&
      cap > 0 &&
      recentDailySpend != null &&
      recentDailySpend / cap < SCALE_MIN_BUDGET_UTILIZATION
    ) {
      return "hold";
    }
    return "scale";
  }
  if (input.objective === "renter_signups" || input.objective === "host_supply") return "watch";
  return "hold";
}

export type TriageState = "act_now" | "watch" | "settling" | "ok";

export function triageState(input: {
  objective_status: ObjectiveStatus;
  has_pending_change: boolean;
  is_delivering: boolean;
  recently_changed: boolean;
}): TriageState {
  if (input.has_pending_change) return "settling";
  if (input.is_delivering === false) return "settling";
  if (input.recently_changed) return "settling";
  const s = input.objective_status;
  if (s === "cut" || s === "pause" || s === "scale") return "act_now";
  if (s === "watch") return "watch";
  return "ok";
}

export const TRIAGE_ORDER: Record<TriageState, number> = {
  act_now: 0,
  watch: 1,
  ok: 2,
  settling: 3,
};

const FATIGUE_FREQ_FLOOR = 3.5;
const FATIGUE_MIN_IMPRESSIONS = 1000;
const ANOMALY_SPIKE_MULT = 2;
const THIN_SAMPLE_PURCHASES = 10;

export function deriveTriageReasons(input: {
  objective_status: ObjectiveStatus;
  is_revenue_objective: boolean;
  roas: number | null;
  spend_usd: number;
  frequency: number | null;
  impressions: number;
  recent_daily_spend_usd: number | null;
  window_daily_avg_usd: number | null;
  active_daily_budget_usd: number | null;
  purchases: number;
  tracking_degraded: boolean;
}): string[] {
  const reasons: string[] = [];
  if (input.tracking_degraded) reasons.push("Tracking degraded — treat ROAS as unverified");
  if (input.is_revenue_objective && input.roas !== null && input.roas < 1 && input.spend_usd >= 5) {
    reasons.push(`Losing money (${input.roas.toFixed(2)}x ROAS)`);
  }
  if (
    input.frequency !== null &&
    input.frequency >= FATIGUE_FREQ_FLOOR &&
    input.impressions >= FATIGUE_MIN_IMPRESSIONS
  ) {
    reasons.push(`Audience saturated (freq ${input.frequency.toFixed(1)})`);
  }
  if (
    input.recent_daily_spend_usd !== null &&
    input.window_daily_avg_usd !== null &&
    input.window_daily_avg_usd > 0 &&
    input.recent_daily_spend_usd > ANOMALY_SPIKE_MULT * input.window_daily_avg_usd
  ) {
    reasons.push("Spend spiking vs its recent baseline");
  }
  if (
    input.is_revenue_objective &&
    input.roas !== null &&
    input.roas >= 1.5 &&
    input.active_daily_budget_usd !== null &&
    input.active_daily_budget_usd > 0 &&
    input.recent_daily_spend_usd !== null &&
    input.recent_daily_spend_usd / input.active_daily_budget_usd < SCALE_MIN_BUDGET_UTILIZATION
  ) {
    reasons.push("Underspending its budget — diagnose delivery, don't just raise it");
  }
  if (input.is_revenue_objective && input.purchases > 0 && input.purchases < THIN_SAMPLE_PURCHASES) {
    reasons.push(`Thin sample (n=${input.purchases})`);
  }
  return reasons;
}

function mergeReasons(...sets: Array<Array<string>>): string[] {
  const out = new Set<string>();
  for (const set of sets) {
    for (const reason of set) out.add(reason);
  }
  return [...out];
}

export function buildObjectiveGroups(campaigns: CampaignLite[], pixelStatus: string | null): ObjectiveGroup[] {
  const groups = new Map<ObjectiveKey, CampaignLite[]>();
  for (const campaign of campaigns) {
    const bucket = groups.get(campaign.objective_key) ?? [];
    bucket.push(campaign);
    groups.set(campaign.objective_key, bucket);
  }

  const order: ObjectiveKey[] = [
    "renter_bookings",
    "renter_signups",
    "host_supply",
    "expansion_metros",
    "remarketing",
    "uncategorized",
  ];

  return order
    .map((objective) => {
      const rows = groups.get(objective) ?? [];
      if (rows.length === 0) return null;
      const agg = aggregate(rows);
      const activeCaps = rows
        .map((c) => c.active_daily_budget_usd)
        .filter((n): n is number => typeof n === "number" && Number.isFinite(n));
      const pseudoCampaign = {
        purchases: round2(rows.reduce((a, c) => a + c.purchases, 0)),
        sign_ups: round2(rows.reduce((a, c) => a + c.sign_ups, 0)),
        leads: round2(rows.reduce((a, c) => a + c.leads, 0)),
        conversions: agg.conversions,
        spend_usd: agg.spend_usd,
      };
      const result = resultForObjective(objective, pseudoCampaign);
      const status = statusForObjective({
        objective,
        spend_usd: agg.spend_usd,
        roas: agg.roas,
        primary_result_count: result.primary_result_count,
        purchases: pseudoCampaign.purchases,
      });
      const confidence = mergeReasons(...rows.map((c) => c.confidence_reasons));
      if (pixelStatus && pixelStatus !== "healthy") {
        confidence.unshift("Tracking degraded");
      }
      return {
        objective_key: objective,
        objective_label: OBJECTIVE_LABELS[objective],
        spend_usd: agg.spend_usd,
        active_daily_budget_usd: activeCaps.length > 0 ? round2(activeCaps.reduce((a, n) => a + n, 0)) : null,
        revenue_usd: agg.revenue_usd,
        roas: agg.roas,
        conversions: agg.conversions,
        primary_result_label: result.primary_result_label,
        primary_result_count: result.primary_result_count,
        primary_cost_label: result.primary_cost_label,
        primary_cost_usd: result.primary_cost_usd,
        status,
        confidence_reasons: confidence,
        campaigns_count: rows.length,
      };
    })
    .filter((g): g is ObjectiveGroup => Boolean(g));
}

function aggregate(campaigns: CampaignLite[]) {
  const spend_usd = round2(campaigns.reduce((a, c) => a + c.spend_usd, 0));
  const conversions = round2(campaigns.reduce((a, c) => a + c.conversions, 0));
  const revenue_usd = round2(campaigns.reduce((a, c) => a + c.revenue_usd, 0));
  const impressions = campaigns.reduce((a, c) => a + c.impressions, 0);
  const clicks = campaigns.reduce((a, c) => a + c.clicks, 0);
  return {
    spend_usd,
    conversions,
    revenue_usd,
    roas: spend_usd > 0 ? round2(revenue_usd / spend_usd) : null,
    cpa_usd: conversions > 0 ? round2(spend_usd / conversions) : null,
    impressions,
    clicks,
    ctr_percent: impressions > 0 ? round2((clicks / impressions) * 100) : null,
    cpc_usd: clicks > 0 ? round2(spend_usd / clicks) : null,
    cpm_usd: impressions > 0 ? round2((spend_usd / impressions) * 1000) : null,
  };
}

export async function agentDashboard(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const slug = req.params.slug;

  const def = await loadAgentDefinition(slug, auth.tenant_id);
  if (!def) {
    res
      .status(404)
      .json({ error: { code: "unknown_agent", message: `no agent ${slug}` } });
    return;
  }

  if (req.query.refresh !== "1") {
    trackSurfaceOpened({
      tenant_id: auth.tenant_id,
      user_id: auth.user_id,
      agent_slug: slug,
      source: parseSurfaceSource(req.query.source),
    });
  }

  if (slug !== "performance-marketer") {
    const builder = DASHBOARD_BUILDERS[slug];
    if (!builder) {
      res.json({ agent_slug: slug, generic: true });
      return;
    }
    try {
      const ctx: ToolContext = {
        tenant_id: auth.tenant_id,
        log: () => {},
        agent_slug: slug,
      };
      const payload = await builder({
        tenantId: auth.tenant_id,
        accessToken: auth.access_token,
        ctx,
        sb: serverClientFromBearer(auth.access_token),
        refresh: req.query.refresh === "1" && req.query.scope !== "selection",
        meteredRefresh: req.query.meter === "1",
        rangeDays: parseRangeDays(req.query.days),
        requestedDays: parseRequestedDays(req.query.days),
        customRange: parseBuilderRange(req.query.since, req.query.until),
      });
      const activeRun =
        "active_run" in payload
          ? (payload.active_run as unknown)
          : await readActiveDashboardRun({
              accessToken: auth.access_token,
              tenantId: auth.tenant_id,
              slug,
            });
      res.json({
        agent_slug: slug,
        generic: false,
        refreshed_at: new Date().toISOString(),
        active_run: activeRun,
        ...payload,
      });
    } catch {
      res.json({ agent_slug: slug, generic: true });
    }
    return;
  }

  const windowKey = parseWindow(req.query.window);
  const customRange = parseCustomRange(req.query.since, req.query.until);
  const spec = resolveWindowSpec(windowKey, customRange);
  const forceRefresh = req.query.refresh === "1";
  const { adData, fetchedAt, cached, stale, servedLastGood, servedLastGoodChannels, channelErrors } =
    await resolvePerfMarketerDashboard(auth, slug, spec, forceRefresh);
  res.json({
    ...adData,
    refreshed_at: new Date().toISOString(),
    fetched_at: fetchedAt,
    cached,
    stale,
    served_last_good: servedLastGood,
    served_last_good_channels: servedLastGoodChannels,
    channel_errors:
      channelErrors && Object.keys(channelErrors).length > 0 ? channelErrors : null,
  });
}

const PERF_DASH_TTL_MS = 3 * 60 * 60 * 1000;
export { PERF_DASH_SCHEMA };
const CHANNEL_READ_BUDGET_MS = 45_000;
const CHANNELS: Channel[] = ["meta", "google"];

type PlacementRow = { label: string; spend_usd: number; share_pct: number };

function shareRows(byLabel: Map<string, number>): PlacementRow[] {
  const total = [...byLabel.values()].reduce((a, b) => a + b, 0);
  if (!(total > 0)) return [];
  return [...byLabel.entries()]
    .map(([label, spend]) => ({
      label,
      spend_usd: Math.round(spend * 100) / 100,
      share_pct: Math.round((spend / total) * 100),
    }))
    .sort((a, b) => b.spend_usd - a.spend_usd)
    .slice(0, 6);
}

function networkLabel(t: string): string {
  switch (t) {
    case "SEARCH":
      return "Search";
    case "SEARCH_PARTNERS":
      return "Search Partners";
    case "CONTENT":
      return "Display";
    case "YOUTUBE":
    case "YOUTUBE_SEARCH":
    case "YOUTUBE_WATCH":
      return "YouTube";
    case "DISCOVERY":
    case "DEMAND_GEN":
      return "Discovery";
    case "GOOGLE_TV":
      return "Google TV";
    case "MIXED":
      return "Cross-network";
    default:
      return "Other";
  }
}

function placementLabel(platform: string, position: string): string {
  const p = position.toLowerCase();
  if (platform === "audience_network") return "Audience Network";
  if (p.includes("reel")) return "Reels";
  if (p.includes("stor")) return "Stories";
  if (p.includes("feed")) return "Feed";
  if (p.includes("marketplace")) return "Marketplace";
  if (p.includes("search")) return "Search";
  if (p.includes("explore")) return "Explore";
  if (p.includes("right_hand")) return "Right column";
  return "Other";
}

function isNotConnected(e: unknown): boolean {
  if (e instanceof ExpectedToolError) return e.code.endsWith("_not_connected");
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.endsWith("_not_connected");
}

export type ChannelError = { code: string; message: string };
export type ChannelErrors = { meta?: ChannelError; google?: ChannelError };

function toChannelError(e: unknown): ChannelError {
  if (e instanceof ExpectedToolError) return { code: e.code, message: e.message };
  return {
    code: "query_failed",
    message: e instanceof Error ? e.message : "channel read failed",
  };
}

export function channelRequiresReconnect(code: string | undefined): boolean {
  return (
    code === "meta_ads_token_expired" ||
    code === "meta_ads_permission_revoked" ||
    code === "google_ads_token_revoked"
  );
}

type ChannelReadBase = {
  connected: boolean;
  rows: CampaignLite[];
  read_at: string;
  error?: ChannelError;
};
type MetaRead = ChannelReadBase & {
  placements: PlacementRow[];
  pixel_status: string | null;
  daily: { rows: MetaDailyRow[]; truncated: boolean } | null;
  today?: MetaTodaySpend | null;
  currency?: string | null;
};
type GoogleRead = ChannelReadBase & {
  networks: PlacementRow[];
  daily: { rows: GoogleDailyRow[] } | null;
};
export type ChannelReads = { meta: MetaRead; google: GoogleRead };

export type PerfBuildResult = { payload: Record<string, unknown>; reads: ChannelReads };
export type PerfBuild = (
  a: { tenant_id: string; access_token: string },
  s: string,
  w: WindowSpec,
  reuse?: Partial<ChannelReads>,
) => Promise<PerfBuildResult>;

function copyRead(into: Partial<ChannelReads>, from: ChannelReads, ch: Channel): void {
  if (ch === "meta") into.meta = from.meta;
  else into.google = from.google;
}

function errorsOf(reads: ChannelReads | null): ChannelErrors {
  const out: ChannelErrors = {};
  if (reads?.meta.error) out.meta = reads.meta.error;
  if (reads?.google.error) out.google = reads.google.error;
  return out;
}

const CUSTOM_LAST_GOOD_MAX = 200;
type TimedReads = { meta?: { at: number; read: MetaRead }; google?: { at: number; read: GoogleRead } };
const CUSTOM_LAST_GOOD = new Map<string, TimedReads>();

function customLastGoodKey(tenantId: string, spec: WindowSpec): string {
  return `${tenantId}:${spec.range?.since ?? ""}:${spec.range?.until ?? ""}`;
}

function readCustomLastGood(key: string, nowMs: number = Date.now()): Partial<ChannelReads> {
  const hit = CUSTOM_LAST_GOOD.get(key);
  const out: Partial<ChannelReads> = {};
  if (hit?.meta && nowMs - hit.meta.at <= PERF_DASH_TTL_MS) out.meta = hit.meta.read;
  if (hit?.google && nowMs - hit.google.at <= PERF_DASH_TTL_MS) out.google = hit.google.read;
  return out;
}

function writeCustomLastGood(key: string, reads: ChannelReads, nowMs: number = Date.now()): void {
  const next: TimedReads = { ...(CUSTOM_LAST_GOOD.get(key) ?? {}) };
  if (reads.meta.connected && !reads.meta.error) next.meta = { at: nowMs, read: reads.meta };
  if (reads.google.connected && !reads.google.error) next.google = { at: nowMs, read: reads.google };
  if (!next.meta && !next.google) return;
  CUSTOM_LAST_GOOD.delete(key);
  CUSTOM_LAST_GOOD.set(key, next);
  while (CUSTOM_LAST_GOOD.size > CUSTOM_LAST_GOOD_MAX) {
    const oldest = CUSTOM_LAST_GOOD.keys().next().value;
    if (oldest === undefined) break;
    CUSTOM_LAST_GOOD.delete(oldest);
  }
}

export function clearCustomLastGood(): void {
  CUSTOM_LAST_GOOD.clear();
}

export type AdConnectorState = {
  token_expires_at_ms: number | null;
  connected_at_ms: number | null;
};
export type AdConnectorStates = Partial<Record<Channel, AdConnectorState>>;

const AD_CONNECTOR_SLUGS: Record<string, Channel> = { meta_ads: "meta", google_ads: "google" };

function parseMs(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

export async function readAdConnectorStates(auth: {
  tenant_id: string;
  access_token: string;
}): Promise<AdConnectorStates> {
  try {
    const sb = serverClientFromBearer(auth.access_token);
    const { data, error } = await sb
      .from("connector_metadata")
      .select("slug, token_expires_at, connected_at")
      .eq("tenant_id", auth.tenant_id)
      .in("slug", Object.keys(AD_CONNECTOR_SLUGS));
    if (error || !Array.isArray(data)) return {};
    const out: AdConnectorStates = {};
    for (const row of data as Array<Record<string, unknown>>) {
      const ch = AD_CONNECTOR_SLUGS[String(row.slug)];
      if (!ch) continue;
      out[ch] = {
        token_expires_at_ms: parseMs(row.token_expires_at),
        connected_at_ms: parseMs(row.connected_at),
      };
    }
    return out;
  } catch {
    return {};
  }
}

export function channelNeedsLiveRead(
  state: AdConnectorState | undefined,
  snapshotFetchedAtMs: number | null,
  nowMs: number = Date.now(),
): boolean {
  if (!state) return false;
  if (state.token_expires_at_ms !== null && state.token_expires_at_ms <= nowMs) return true;
  return (
    snapshotFetchedAtMs !== null &&
    state.connected_at_ms !== null &&
    state.connected_at_ms > snapshotFetchedAtMs
  );
}

type Snapshot = { payload: Record<string, unknown>; reads: ChannelReads | null; fetchedAt: string };

function isChannelReads(x: unknown): x is ChannelReads {
  return !!x && typeof x === "object" && "meta" in x && "google" in x;
}

async function readSnapshot(
  sb: ReturnType<typeof serverClientFromBearer>,
  tenantId: string,
  windowKey: WindowKey,
): Promise<Snapshot | null> {
  try {
    const { data, error } = await sb.rpc("get_perf_dashboard_snapshot", {
      p_tenant_id: tenantId,
      p_window: windowKey,
    });
    const row = (Array.isArray(data) ? data[0] : data) as
      | { payload?: unknown; schema_version?: unknown; fetched_at?: unknown }
      | null
      | undefined;
    if (error || !row?.payload || row.schema_version !== PERF_DASH_SCHEMA) return null;
    const { channel_reads, ...payload } = row.payload as Record<string, unknown>;
    return {
      payload,
      reads: isChannelReads(channel_reads) ? channel_reads : null,
      fetchedAt:
        typeof row.fetched_at === "string"
          ? row.fetched_at
          : new Date(row.fetched_at as string).toISOString(),
    };
  } catch {
    return null;
  }
}

export async function resolvePerfMarketerDashboard(
  auth: { tenant_id: string; access_token: string },
  slug: string,
  windowOrSpec: WindowKey | WindowSpec,
  forceRefresh: boolean,
  build: PerfBuild = buildPerfMarketerAdData,
  connectorStates: (a: { tenant_id: string; access_token: string }) => Promise<AdConnectorStates> =
    readAdConnectorStates,
): Promise<{
  adData: Record<string, unknown>;
  fetchedAt: string;
  cached: boolean;
  stale: boolean;
  servedLastGood: boolean;
  servedLastGoodChannels: string[];
  channelErrors?: ChannelErrors;
}> {
  const spec: WindowSpec =
    typeof windowOrSpec === "string"
      ? resolveWindowSpec(windowOrSpec, null)
      : windowOrSpec;

  if (spec.key === "custom") {
    const { payload: built, reads } = await build(auth, slug, spec);
    let adData = built;
    const channelErrors = errorsOf(reads);
    const lgKey = customLastGoodKey(auth.tenant_id, spec);
    const last = readCustomLastGood(lgKey);
    writeCustomLastGood(lgKey, reads);
    const substitute: Partial<ChannelReads> = {};
    for (const ch of CHANNELS) {
      const err = reads[ch].error;
      if (!err || channelRequiresReconnect(err.code)) continue;
      if (ch === "meta" && last.meta) substitute.meta = last.meta;
      if (ch === "google" && last.google) substitute.google = last.google;
    }
    const servedLastGoodChannels = Object.keys(substitute);
    if (servedLastGoodChannels.length > 0) {
      ({ payload: adData } = await build(auth, slug, spec, { ...reads, ...substitute }));
    }
    return {
      adData,
      fetchedAt: new Date().toISOString(),
      cached: false,
      stale: false,
      servedLastGood: servedLastGoodChannels.length > 0,
      servedLastGoodChannels,
      channelErrors,
    };
  }
  const windowKey: WindowKey = spec.key;
  const sb = serverClientFromBearer(auth.access_token);
  const nowMs = Date.now();

  const [snapshot, states] = await Promise.all([
    readSnapshot(sb, auth.tenant_id, windowKey),
    connectorStates(auth),
  ]);
  const snapshotFetchedAtMs = snapshot ? Date.parse(snapshot.fetchedAt) : null;
  const snapshotFresh = snapshotFetchedAtMs !== null && nowMs - snapshotFetchedAtMs <= PERF_DASH_TTL_MS;
  const mustReread = CHANNELS.filter(
    (ch) =>
      channelNeedsLiveRead(states[ch], snapshotFetchedAtMs, nowMs) ||
      !!snapshot?.reads?.[ch].error,
  );

  if (!forceRefresh && snapshot && mustReread.length === 0) {
    return {
      adData: snapshot.payload,
      fetchedAt: snapshot.fetchedAt,
      cached: true,
      stale: !snapshotFresh,
      servedLastGood: false,
      servedLastGoodChannels: [],
      channelErrors: errorsOf(snapshot.reads),
    };
  }

  const reuse: Partial<ChannelReads> = {};
  if (!forceRefresh && snapshot?.reads && snapshotFresh) {
    for (const ch of CHANNELS) {
      if (!mustReread.includes(ch)) copyRead(reuse, snapshot.reads, ch);
    }
  }
  let { payload, reads } = await build(auth, slug, spec, reuse);
  const channelErrors = errorsOf(reads);

  const substitute: Partial<ChannelReads> = {};
  for (const ch of CHANNELS) {
    const err = reads[ch].error;
    if (!err || channelRequiresReconnect(err.code)) continue;
    const last = snapshot?.reads?.[ch];
    if (last?.connected && !last.error) copyRead(substitute, snapshot!.reads!, ch);
  }
  const servedLastGood = Object.keys(substitute).length > 0;
  if (servedLastGood) {
    ({ payload, reads } = await build(auth, slug, spec, { ...reads, ...substitute }));
  }

  let fetchedAt = new Date().toISOString();
  try {
    const { data, error } = await sb.rpc("upsert_perf_dashboard_snapshot", {
      p_tenant_id: auth.tenant_id,
      p_window: windowKey,
      p_payload: { ...payload, channel_reads: reads },
      p_schema_version: PERF_DASH_SCHEMA,
    });
    if (!error && data) {
      fetchedAt =
        typeof data === "string"
          ? data
          : new Date(data as string).toISOString();
    }
  } catch {
  }
  return {
    adData: payload,
    fetchedAt,
    cached: false,
    stale: false,
    servedLastGood,
    servedLastGoodChannels: Object.keys(substitute),
    channelErrors,
  };
}

function withBudget<T>(p: Promise<T>, ms: number, code: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, rej) => {
    t = setTimeout(
      () => rej(new ExpectedToolError(code, `channel read exceeded ${ms / 1000}s`)),
      ms,
    );
  });
  return Promise.race([p.finally(() => clearTimeout(t)), timeout]);
}

async function readChannel<T extends ChannelReadBase>(
  empty: T,
  budgetCode: string,
  read: () => Promise<T>,
): Promise<T> {
  try {
    return await withBudget(read(), CHANNEL_READ_BUDGET_MS, budgetCode);
  } catch (e) {
    if (isNotConnected(e)) return empty;
    return { ...empty, connected: true, error: toChannelError(e) };
  }
}

export function googleCampaignLite(
  c: Record<string, unknown>,
  googleCustomerId: string | null,
): CampaignLite {
    const spend = Number(c.spend_usd ?? 0);
    const revenue = Number(c.conversions_value_usd ?? 0);
    const conv = Number(c.conversions ?? 0);
    const campaignId = String(c.campaign_id ?? "");
    const objective = classifyObjective({
      channel: "google",
      campaignName: String(c.campaign_name ?? ""),
      purchases: 0,
      leads: 0,
      signUps: 0,
    });
    const result = resultForObjective(objective, {
      purchases: 0,
      sign_ups: 0,
      leads: 0,
      conversions: round2(conv),
      spend_usd: round2(spend),
    });
    const roas = spend > 0 ? round2(revenue / spend) : null;
    const gObjStatus = statusForObjective({
      objective,
      spend_usd: round2(spend),
      roas,
      primary_result_count: result.primary_result_count,
      purchases: 0,
    });
    return {
      channel: "google",
      campaign_id: campaignId,
      campaign_name: String(c.campaign_name ?? ""),
      status: c.status != null ? String(c.status) : null,
      start_time: c.start_time != null ? String(c.start_time) : null,
      end_time: c.end_time != null ? String(c.end_time) : null,
      reach: null,
      spend_usd: round2(spend),
      conversions: round2(conv),
      revenue_usd: round2(revenue),
      roas,
      cpa_usd: conv > 0 ? round2(spend / conv) : null,
      impressions: Number(c.impressions ?? 0),
      clicks: Number(c.clicks ?? 0),
      ctr_percent: round2(Number(c.ctr ?? 0) * 100),
      cpc_usd: round2(Number(c.avg_cpc_usd ?? 0)),
      cpm_usd:
        Number(c.impressions ?? 0) > 0
          ? round2((spend / Number(c.impressions)) * 1000)
          : null,
      frequency: null,
      purchases: 0,
      sign_ups: 0,
      leads: 0,
      cost_per_booking_usd: null,
      active_daily_budget_usd:
        c.daily_budget_usd != null ? round2(Number(c.daily_budget_usd)) : null,
      optimization_label: null,
      ad_sets: [],
      objective_key: objective,
      objective_label: OBJECTIVE_LABELS[objective],
      primary_result_label: result.primary_result_label,
      primary_result_count: result.primary_result_count,
      primary_cost_label: result.primary_cost_label,
      primary_cost_usd: result.primary_cost_usd,
      objective_status: gObjStatus,
      triage_reasons: [],
      confidence_reasons: [
        "Platform-reported Google Ads data",
        "Daily cap unavailable",
        "Generic conversions are not bookings",
      ],
      is_delivering: true,
      pending_change: null,
      recent_daily_spend_usd: null,
      triage_state: triageState({
        objective_status: gObjStatus,
        has_pending_change: false,
        is_delivering: true,
        recently_changed: false,
      }),
      manage_url: googleCampaignUrl(googleCustomerId, campaignId),
    };
}

async function buildPerfMarketerAdData(
  auth: { tenant_id: string; access_token: string },
  slug: string,
  spec: WindowSpec,
  reuse: Partial<ChannelReads> = {},
): Promise<PerfBuildResult> {
  const win = { meta: spec.meta, google: spec.google, label: spec.label };
  const metaRange = spec.range ?? undefined;
  let metaCurrency: string | null = null;

  const ctx: ToolContext = {
    tenant_id: auth.tenant_id,
    log: () => {},
    agent_slug: slug,
  };

  const campaigns: CampaignLite[] = [];

  let pendingByCampaign = new Map<string, { kind: "budget" | "status"; label: string }>();
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const sb = serverClientFromBearer(auth.access_token);
    const { data: pendingRows } = await sb
      .from("decisions")
      .select("decision_class, body, emitted_at")
      .eq("tenant_id", auth.tenant_id)
      .in("decision_class", [
        "meta_ads.update_ad_set_budget_review",
        "meta_ads.update_campaign_budget_review",
        "meta_ads.set_status_review",
      ])
      .eq("status", "proposed")
      .is("superseded_at", null)
      .gte("emitted_at", sevenDaysAgo)
      .order("emitted_at", { ascending: false })
      .limit(200);
    pendingByCampaign = buildPendingByCampaign(
      (pendingRows ?? []) as Array<{ decision_class?: unknown; body?: unknown }>,
    );
  } catch {
  }

  const started = <T,>(p: Promise<T>): Promise<T> => {
    p.catch(() => {});
    return p;
  };

  const readMeta = async (): Promise<MetaRead> => {
    const metaRows: CampaignLite[] = [];
    const pixelPromise = started(metaPixelHealthTool.execute(ctx, {}));
    const recentMetaPromise =
      win.meta === "last_7d"
        ? null
        : started(
            metaListCampaignsTool.execute(ctx, { date_preset: "last_7d", status: "ALL" }),
          );
    const meta = (await metaListCampaignsTool.execute(ctx, {
      date_preset: win.meta,
      time_range: metaRange,
      status: "ALL",
    })) as { campaigns?: Array<Record<string, unknown>> };
    const dailyPromise = withTimeout(
      fetchMetaDailySeries(auth.tenant_id, {
        level: "campaign",
        date_preset: win.meta as MetaDailyPreset,
        time_range: metaRange,
      }).catch(() => null),
      DAILY_TREND_TIMEOUT_MS,
    );
    const todayPromise = withTimeout(fetchMetaTodaySpend(auth.tenant_id), DAILY_TREND_TIMEOUT_MS);
    const placementsPromise = (async (): Promise<PlacementRow[]> => {
      try {
        const creds = await metaAdsCreds(auth.tenant_id);
        const j = (await fbGet(auth.tenant_id, `${creds.ad_account_id}/insights`, {
          level: "account",
          time_range: JSON.stringify(metaRange ?? metaDateRange(win.meta)),
          breakdowns: "publisher_platform,platform_position",
          fields: "spend",
          limit: 200,
        })) as {
          data?: Array<{
            spend?: string;
            publisher_platform?: string;
            platform_position?: string;
          }>;
        };
        const byLabel = new Map<string, number>();
        for (const r of j.data ?? []) {
          const spend = Number(r.spend ?? 0);
          if (!(spend > 0)) continue;
          const label = placementLabel(
            String(r.publisher_platform ?? ""),
            String(r.platform_position ?? ""),
          );
          byLabel.set(label, (byLabel.get(label) ?? 0) + spend);
        }
        return shareRows(byLabel);
      } catch {
        return [];
      }
    })();
    let metaAccountNum: string | null = null;
    try {
      const creds = await metaAdsCreds(auth.tenant_id);
      metaAccountNum = creds.ad_account_id.replace(/^act_/, "");
      metaCurrency = await getAdAccountCurrency(auth.tenant_id).catch(() => null);
    } catch {
      metaAccountNum = null;
    }
    const allMeta = meta.campaigns ?? [];
    const RECENT_GATE_DAYS = 7;
    const CHANGE_LOOKBACK_DAYS = 3;
    const changeSince = new Date(Date.now() - CHANGE_LOOKBACK_DAYS * 24 * 3600 * 1000)
      .toISOString()
      .slice(0, 10);
    const changedIdsPromise = fetchRecentlyChangedObjectIds(auth.tenant_id, changeSince);
    const recentDailySpendById = new Map<string, number>();
    try {
      const recentCampaigns =
        win.meta === "last_7d"
          ? allMeta
          : ((await recentMetaPromise) as { campaigns?: Array<Record<string, unknown>> })
              .campaigns ?? [];
      for (const c of allMeta) {
        const id = String(c.campaign_id ?? "");
        if (id) recentDailySpendById.set(id, 0);
      }
      for (const rc of recentCampaigns) {
        const id = String(rc.campaign_id ?? "");
        const sp = Number(rc.spend_usd);
        if (id && Number.isFinite(sp)) recentDailySpendById.set(id, sp / RECENT_GATE_DAYS);
      }
    } catch {
      recentDailySpendById.clear();
    }
    const recentlyChangedIds = await changedIdsPromise;
    const fetchAdSetEnrichment = async (campaignId: string, cboDailyUsd: number | null = null): Promise<AdSetEnrichment> => {
      try {
        const edgePromise = enumerateCampaignAdSets(auth.tenant_id, campaignId).catch(
          () => null,
        );
        const adSetsResp = (await metaListAdSetsTool.execute(ctx, {
          campaign_id: campaignId,
          date_preset: win.meta,
          time_range: metaRange,
        })) as { ad_sets?: Array<Record<string, unknown>>; currency?: string | null };
        const rawAdSets = adSetsResp.ad_sets ?? [];
        const usdAccount = String(adSetsResp.currency ?? "").toUpperCase() === "USD";
        const caps = rawAdSets
          .filter(() => usdAccount)
          .filter((a) => String(a.effective_status ?? "").toUpperCase() === "ACTIVE")
          .map((a) => Number(a.daily_budget_usd))
          .filter((n) => Number.isFinite(n) && n > 0);
        const adSets: AdSetLite[] = rawAdSets.map((a) => {
          const daily = usdAccount ? Number(a.daily_budget_usd) : NaN;
          return {
            ad_set_id: String(a.ad_set_id ?? ""),
            ad_set_name: String(a.ad_set_name ?? ""),
            optimization_event:
              a.optimization_event != null ? String(a.optimization_event) : null,
            daily_budget_usd: Number.isFinite(daily) && daily > 0 ? round2(daily) : null,
          };
        });
        let isDelivering = true;
        let recentlyChanged = recentlyChangedIds.has(campaignId);
        const edgeAdSets = await edgePromise;
        if (edgeAdSets) {
          isDelivering = anyAdSetDelivering(edgeAdSets);
          if (!recentlyChanged) {
            recentlyChanged = edgeAdSets.some((a) =>
              recentlyChangedIds.has(String((a as { id?: unknown }).id ?? "")),
            );
          }
        }
        return {
          recentlyChanged,
          activeDailyBudgetUsd:
            caps.length > 0
              ? round2(caps.reduce((a, n) => a + n, 0))
              : usdAccount && isDelivering && cboDailyUsd !== null && cboDailyUsd > 0
                ? round2(cboDailyUsd)
                : null,
          adSetNames: rawAdSets.map((a) => String(a.ad_set_name ?? "")).filter(Boolean),
          optimizationGoals: rawAdSets
            .map((a) => String(a.optimization_goal ?? ""))
            .filter(Boolean),
          isDelivering,
          adSets,
          optimizationLabel: combineOptimizationEvents(adSets.map((a) => a.optimization_event)),
        };
      } catch {
        return { ...EMPTY_ENRICHMENT };
      }
    };
    const enrichmentById = new Map<string, AdSetEnrichment>();
    const enriched = await mapInChunks(
      allMeta,
      AD_SET_FETCH_CONCURRENCY,
      async (c) => {
        const id = String(c.campaign_id ?? "");
        if (!needsAdSetEnrichment(c)) {
          return {
            campaignId: id,
            enrichment: { ...EMPTY_ENRICHMENT, isDelivering: false, recentlyChanged: recentlyChangedIds.has(id) },
          };
        }
        const cbo = String(c.status ?? "").toUpperCase() === "ACTIVE" ? Number(c.campaign_daily_budget) : NaN;
        return { campaignId: id, enrichment: await fetchAdSetEnrichment(id, Number.isFinite(cbo) ? cbo : null) };
      },
    );
    for (const e of enriched) enrichmentById.set(e.campaignId, e.enrichment);

    for (const c of allMeta) {
      const spend = Number(c.spend_usd ?? 0);
      const revenue = Number(c.purchase_value_usd ?? 0);
      const conv = Number(c.conversions ?? 0);
      const campaignId = String(c.campaign_id ?? "");
      const {
        activeDailyBudgetUsd,
        adSetNames,
        optimizationGoals,
        isDelivering,
        recentlyChanged,
        adSets,
        optimizationLabel,
      } = enrichmentById.get(campaignId) ?? EMPTY_ENRICHMENT;
      const purchases = round2(Number(c.purchases ?? 0));
      const signUps = round2(Number(c.sign_ups ?? 0));
      const leads = round2(Number(c.leads ?? 0));
      const objective = classifyObjective({
        channel: "meta",
        campaignName: String(c.campaign_name ?? ""),
        adSetNames,
        optimizationGoals,
        purchases,
        leads,
        signUps,
      });
      const result = resultForObjective(objective, {
        purchases,
        sign_ups: signUps,
        leads,
        conversions: round2(conv),
        spend_usd: round2(spend),
      });
      const roas = spend > 0 ? round2(revenue / spend) : null;
      const recentBurn = recentDailySpendById.get(campaignId) ?? null;
      const objStatus = statusForObjective({
        objective,
        spend_usd: round2(spend),
        roas,
        primary_result_count: result.primary_result_count,
        purchases,
        active_daily_budget_usd: activeDailyBudgetUsd,
        recent_daily_spend_usd: recentBurn,
      });
      const pendingCh = pendingByCampaign.get(campaignId) ?? null;
      metaRows.push({
        channel: "meta",
        campaign_id: campaignId,
        campaign_name: String(c.campaign_name ?? ""),
        status: c.status != null ? String(c.status) : null,
        start_time: c.start_time != null ? String(c.start_time) : null,
        end_time: c.end_time != null ? String(c.end_time) : null,
        reach: Number.isFinite(Number(c.reach)) ? Number(c.reach) : null,
        spend_usd: round2(spend),
        conversions: round2(conv),
        revenue_usd: round2(revenue),
        roas,
        cpa_usd: conv > 0 ? round2(spend / conv) : null,
        impressions: Number(c.impressions ?? 0),
        clicks: Number(c.clicks ?? 0),
        ctr_percent: round2(Number(c.ctr_percent ?? 0)),
        cpc_usd: round2(Number(c.cpc_usd ?? 0)),
        cpm_usd: round2(Number(c.cpm_usd ?? 0)),
        frequency: c.frequency != null ? round2(Number(c.frequency)) : null,
        purchases,
        sign_ups: signUps,
        leads,
        cost_per_booking_usd:
          c.cost_per_booking_usd != null ? round2(Number(c.cost_per_booking_usd)) : null,
        active_daily_budget_usd: activeDailyBudgetUsd,
        optimization_label: optimizationLabel,
        ad_sets: adSets,
        objective_key: objective,
        objective_label: OBJECTIVE_LABELS[objective],
        primary_result_label: result.primary_result_label,
        primary_result_count: result.primary_result_count,
        primary_cost_label: result.primary_cost_label,
        primary_cost_usd: result.primary_cost_usd,
        objective_status: objStatus,
        triage_reasons: [],
        confidence_reasons: [
          "Platform-reported Meta data",
          ...(activeDailyBudgetUsd === null ? ["Daily cap unavailable"] : []),
          ...(purchases < 10 ? ["Thin purchase sample"] : []),
        ],
        is_delivering: isDelivering,
        pending_change: pendingCh,
        recent_daily_spend_usd: recentBurn,
        triage_state: triageState({
          objective_status: objStatus,
          has_pending_change: pendingCh != null,
          is_delivering: isDelivering,
          recently_changed: recentlyChanged,
        }),
        manage_url: metaCampaignUrl(metaAccountNum, campaignId),
      });
    }
    const pixel_status = await pixelPromise
      .then((px) => (px as { overall_status?: string }).overall_status ?? null)
      .catch(() => null);
    const daily = await dailyPromise;
    return {
      connected: true,
      rows: metaRows,
      placements: await placementsPromise,
      pixel_status,
      daily: daily ? { rows: daily.rows, truncated: daily.truncated } : null,
      today: await todayPromise.catch(() => null),
      currency: metaCurrency,
      read_at: new Date().toISOString(),
    };
  };

  const readGoogle = async (): Promise<GoogleRead> => {
    const networksPromise = (async (): Promise<PlacementRow[]> => {
      try {
        const ymdRe = /^\d{4}-\d{2}-\d{2}$/;
        const dateClause =
          metaRange && ymdRe.test(metaRange.since) && ymdRe.test(metaRange.until)
            ? `segments.date BETWEEN '${metaRange.since}' AND '${metaRange.until}'`
            : `segments.date DURING ${win.google}`;
        const rows = (await gadsSearch(
          auth.tenant_id,
          `SELECT segments.ad_network_type, metrics.cost_micros FROM campaign WHERE ${dateClause}`,
        )) as Array<{
          segments?: { adNetworkType?: string };
          metrics?: { costMicros?: string };
        }>;
        const byLabel = new Map<string, number>();
        for (const r of rows) {
          const spend = Number(r.metrics?.costMicros ?? 0) / 1_000_000;
          if (!(spend > 0)) continue;
          const label = networkLabel(String(r.segments?.adNetworkType ?? ""));
          byLabel.set(label, (byLabel.get(label) ?? 0) + spend);
        }
        return shareRows(byLabel);
      } catch {
        return [];
      }
    })();
    const g = await readGoogleCampaigns(
      auth.tenant_id,
      { date_range: win.google as GoogleDailyRange, custom_range: metaRange },
      slug,
    );
    const googleRows: CampaignLite[] = g.campaigns.map((c) => googleCampaignLite(c, g.customer_id));
    return {
      connected: true,
      rows: googleRows,
      networks: await networksPromise,
      daily: g.daily,
      read_at: new Date().toISOString(),
    };
  };

  const emptyRead = { connected: false, rows: [], read_at: new Date().toISOString() };
  const [metaRead, googleRead] = await Promise.all([
    reuse.meta ??
      readChannel<MetaRead>(
        { ...emptyRead, placements: [], pixel_status: null, daily: null },
        "meta_ads_read_timeout",
        readMeta,
      ),
    reuse.google ??
      readChannel<GoogleRead>({ ...emptyRead, networks: [], daily: null }, "google_ads_read_timeout", readGoogle),
  ]);
  const reads: ChannelReads = { meta: metaRead, google: googleRead };
  const metaConnected = metaRead.connected;
  const googleConnected = googleRead.connected;
  const pixelStatus = metaRead.pixel_status;
  const placements = metaRead.placements;
  const networks = googleRead.networks;
  campaigns.push(...metaRead.rows, ...googleRead.rows);

  const blended = aggregate(campaigns);
  const channels = (["meta", "google"] as Channel[]).map((ch) => {
    const connected = ch === "meta" ? metaConnected : googleConnected;
    const agg = aggregate(campaigns.filter((c) => c.channel === ch));
    return { channel: ch, connected, ...agg };
  });

  const pixelDegraded = pixelStatus !== null && pixelStatus !== "healthy";
  const windowAvgDenom = spec.days;
  for (const c of campaigns) {
    c.triage_reasons = deriveTriageReasons({
      objective_status: c.objective_status,
      is_revenue_objective: isRevenueObjective(c.objective_key),
      roas: c.roas,
      spend_usd: c.spend_usd,
      frequency: c.frequency,
      impressions: c.impressions,
      recent_daily_spend_usd: c.recent_daily_spend_usd,
      window_daily_avg_usd: windowAvgDenom > 0 ? c.spend_usd / windowAvgDenom : null,
      active_daily_budget_usd: c.active_daily_budget_usd,
      purchases: c.purchases,
      tracking_degraded: pixelDegraded && c.channel === "meta",
    });
  }

  const all_campaigns = [...campaigns]
    .sort((a, b) => {
      const t = TRIAGE_ORDER[a.triage_state] - TRIAGE_ORDER[b.triage_state];
      if (t !== 0) return t;
      const burn = (b.recent_daily_spend_usd ?? -1) - (a.recent_daily_spend_usd ?? -1);
      if (burn !== 0) return burn;
      return b.spend_usd - a.spend_usd;
    })
    .slice(0, 50);

  const ranked = campaigns
    .filter((c) => c.spend_usd >= 1 && c.roas !== null)
    .sort((a, b) => (b.roas ?? 0) - (a.roas ?? 0));
  const top_campaigns = ranked.slice(0, 3);
  const bottom_campaigns = ranked.slice(-3).reverse();
  const objective_groups = buildObjectiveGroups(campaigns, pixelStatus);
  const activeDailyCaps = campaigns
    .map((c) => c.active_daily_budget_usd)
    .filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  const active_daily_budget_usd =
    activeDailyCaps.length > 0 ? round2(activeDailyCaps.reduce((a, n) => a + n, 0)) : null;
  const daily_run_rate_usd = round2(blended.spend_usd / spec.days);
  const primaryObjective =
    objective_groups.find((g) => g.objective_key === "renter_bookings") ??
    objective_groups[0] ??
    null;
  const confidence_reasons = [
    ...(pixelStatus && pixelStatus !== "healthy" ? ["Tracking degraded"] : []),
    "Platform-reported ad data",
    ...(active_daily_budget_usd === null ? ["Some daily caps unavailable"] : []),
  ];

  const attention: AttentionItem[] = [];
  if (pixelStatus && pixelStatus !== "healthy") {
    attention.push({
      severity: pixelStatus === "no_pixel" ? "high" : "warn",
      title:
        pixelStatus === "no_pixel"
          ? "No Meta pixel detected"
          : `Meta pixel ${pixelStatus.replace("_", " ")}`,
      detail:
        "Conversion tracking is degraded, so every ROAS number below is less trustworthy than it looks.",
      ask: "My Meta pixel health looks off — diagnose what's wrong and how to fix tracking.",
    });
  }

  if (metaConnected && googleConnected) {
    const chName = (c: Channel) => (c === "meta" ? "Meta" : "Google");
    const m = channels.find((c) => c.channel === "meta");
    const g = channels.find((c) => c.channel === "google");
    if (
      m &&
      g &&
      m.roas !== null &&
      g.roas !== null &&
      m.spend_usd > 0 &&
      g.spend_usd > 0
    ) {
      const better = m.roas >= g.roas ? m : g;
      const worse = better === m ? g : m;
      if (better.roas! >= worse.roas! * 1.25 && worse.spend_usd >= 20) {
        attention.push({
          severity: "warn",
          title: `${chName(better.channel)} is outperforming ${chName(worse.channel)}`,
          detail: `${chName(better.channel)} returns ${better.roas}× vs ${chName(worse.channel)} at ${worse.roas}× — ${chName(worse.channel)} is spending $${worse.spend_usd} at a weaker return.`,
          ask: `${chName(better.channel)} is returning ${better.roas}× vs ${chName(worse.channel)} at ${worse.roas}× — should I shift budget from ${chName(worse.channel)} to ${chName(better.channel)}?`,
        });
      }
    }
  }

  type DailySeriesPayload = {
    points: ReturnType<typeof buildDailyTrend>;
    meta_truncated: boolean;
    channels: { meta: boolean; google: boolean };
  };
  let daily_series: DailySeriesPayload | null = null;
  const daily_series_by_channel: { meta: DailySeriesPayload | null; google: DailySeriesPayload | null } = {
    meta: null,
    google: null,
  };
  const metaDaily = metaRead.daily;
  const googleDaily = googleRead.daily;
  const nowIso = new Date().toISOString().slice(0, 10);
  const points = buildDailyTrend(metaDaily?.rows ?? [], googleDaily?.rows ?? [], { nowIso });
  if (points.length > 0) {
    daily_series = {
      points,
      meta_truncated: metaDaily?.truncated ?? false,
      channels: { meta: !!metaDaily, google: !!googleDaily },
    };
  }
  if (metaDaily) {
    const metaPoints = buildDailyTrend(metaDaily.rows ?? [], [], { nowIso });
    if (metaPoints.length > 0) {
      daily_series_by_channel.meta = {
        points: metaPoints,
        meta_truncated: metaDaily.truncated ?? false,
        channels: { meta: true, google: false },
      };
    }
  }
  if (googleDaily) {
    const googlePoints = buildDailyTrend([], googleDaily.rows ?? [], { nowIso });
    if (googlePoints.length > 0) {
      daily_series_by_channel.google = {
        points: googlePoints,
        meta_truncated: false,
        channels: { meta: false, google: true },
      };
    }
  }

  let booking_trend: BookingTrend | null = null;
  try {
    const spendByDate = new Map<string, number>(
      (daily_series?.points ?? []).map((p) => [p.date, p.spend_usd]),
    );
    booking_trend = await buildBookingTrend(auth.tenant_id, auth.access_token, spendByDate);
  } catch {
    booking_trend = null;
  }

  const payload = {
    agent_slug: slug,
    generic: false,
    window: spec.key,
    window_label: spec.label,
    meta_currency: metaRead.currency ?? null,
    period: { from: (metaRange ?? metaDateRange(win.meta)).since, to: (metaRange ?? metaDateRange(win.meta)).until },
    refreshed_at: new Date().toISOString(),
    connected: { meta: metaConnected, google: googleConnected },
    kpis: blended,
    daily_series,
    daily_series_by_channel,
    meta_daily_budget:
      metaConnected && !metaRead.error
        ? buildMetaDailyBudget({
            campaigns: campaigns.filter((c) => c.channel === "meta"),
            daily: metaRead.daily,
            today: metaRead.today ?? null,
          })
        : null,
    booking_trend,
    spend_summary: {
      spend_usd: blended.spend_usd,
      daily_run_rate_usd,
      active_daily_budget_usd,
      revenue_usd: blended.revenue_usd,
      roas: blended.roas,
      primary_result_label: primaryObjective?.primary_result_label ?? "conversions",
      primary_result_count: primaryObjective?.primary_result_count ?? blended.conversions,
      primary_cost_label: primaryObjective?.primary_cost_label ?? "Cost / conversion",
      primary_cost_usd: primaryObjective?.primary_cost_usd ?? blended.cpa_usd,
      target_outcome_label: "Completed bookings / verified renters",
      confidence_reasons,
    },
    objective_groups,
    channels,
    campaigns: all_campaigns,
    total_campaigns: campaigns.length,
    top_campaigns,
    bottom_campaigns,
    pixel: pixelStatus ? { status: pixelStatus } : null,
    attention,
    placements,
    networks,
  };

  return { payload, reads };
}
