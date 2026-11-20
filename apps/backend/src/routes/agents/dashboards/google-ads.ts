
import type { DashboardBuilder, DashboardContext } from "./_contract";
import { readGoogleCampaigns, googleCampaignUrl, type GoogleCampaignRow } from "./_google-campaigns";
import { listCampaignsTool } from "@/services/tools/google-ads/list_campaigns";
import { createGoogleAdsReadSession, type GoogleAdsSearch } from "@/services/tools/google-ads/_client";
import { gadsChangeRows } from "@/services/tools/google-ads/write/_change-rows";
import { adChangeHeadline } from "@zavi/shared";
import type { GoogleDailyRow } from "@/services/tools/google-ads/daily_series";
import { buildGoogleDailyBudget, readGoogleTodaySpend } from "@/services/agents/dashboards/google-daily-budget";
import {
  channelIsSwitched,
  readSwitchedChannelRows,
  type ChannelStepRow,
} from "./_channel-action-rows";

export const GADS_RANGES = [
  { id: "7d", label: "Last 7 days", days: 7 },
  { id: "14d", label: "Last 14 days", days: 14 },
  { id: "30d", label: "Last 30 days", days: 30 },
] as const;
const DEFAULT_DAYS = 30;
const CAP_HIT_RATIO = 0.95;
const MAX_ACTIONS = 20;
const NEW_MS = 24 * 60 * 60 * 1000;

export type GadsKpiKey = "spend" | "conversions" | "cpa" | "conv_value" | "roas" | "pacing";

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

export type GadsCampaign = {
  id: string;
  name: string;
  status: string;
  channel_type: string | null;
  limited_by_budget: boolean;
  spend: number;
  conversions: number;
  cpa: number | null;
  conv_value: number;
  url: string | null;
  daily_budget?: number | null;
  budget_shared?: boolean;
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

type DecisionRow = {
  id: string;
  decision_class: string;
  body: Record<string, unknown> | null;
  emitted_at: string | null;
  agent_run_id: string | null;
  dispatched_at?: string | null;
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function shiftDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function todayIn(timeZone: string | null): string {
  try {
    if (timeZone) {
      return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    }
  } catch {
  }
  return new Date().toISOString().slice(0, 10);
}

function deltaPct(value: number | null, prev: number | null): number | null {
  if (value === null || prev === null || prev === 0) return null;
  return Math.round(((value - prev) / Math.abs(prev)) * 1000) / 10;
}

function kpi(
  key: GadsKpiKey,
  label: string,
  unit: GadsKpi["unit"],
  value: number | null,
  prev: number | null,
  upIsGood: boolean | null,
): GadsKpi {
  const abs = value !== null && prev !== null ? round2(value - prev) : null;
  return {
    key,
    label,
    unit,
    value,
    prev,
    delta_pct: deltaPct(value, prev),
    delta_abs: abs,
    delta_good: upIsGood === null || abs === null || abs === 0 ? null : upIsGood ? abs > 0 : abs < 0,
  };
}

type Totals = { spend: number; conversions: number; conv_value: number };

function totalsOf(rows: GoogleCampaignRow[]): Totals {
  let spend = 0;
  let conversions = 0;
  let conv_value = 0;
  for (const r of rows) {
    spend += Number(r.spend_usd ?? 0);
    conversions += Number(r.conversions ?? 0);
    conv_value += Number(r.conversions_value_usd ?? 0);
  }
  return { spend: round2(spend), conversions: round2(conversions), conv_value: round2(conv_value) };
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const YMD = /^\d{4}-\d{2}-\d{2}$/;

export function windowLabel(w: { from?: unknown; to?: unknown } | null | undefined): string | null {
  if (!w || typeof w.from !== "string" || typeof w.to !== "string") return null;
  if (!YMD.test(w.from) || !YMD.test(w.to)) return `${w.from} – ${w.to}`;
  const f = (ymd: string) => {
    const [, m, d] = ymd.split("-").map(Number);
    return `${MON[m - 1]} ${d}`;
  };
  const days = Math.round((Date.parse(`${w.to}T00:00:00Z`) - Date.parse(`${w.from}T00:00:00Z`)) / 86_400_000) + 1;
  return `${f(w.from)} – ${f(w.to)}, ${w.to.slice(0, 4)} · ${days} ${days === 1 ? "day" : "days"}`;
}

function tiles(raw: unknown): GadsTile[] {
  if (!Array.isArray(raw)) return [];
  const out: GadsTile[] = [];
  for (const t of raw) {
    if (t && typeof t === "object" && typeof (t as GadsTile).value === "string" && typeof (t as GadsTile).caption === "string") {
      out.push({ value: (t as GadsTile).value.slice(0, 40), caption: (t as GadsTile).caption.slice(0, 140) });
    }
  }
  return out.slice(0, 4);
}

function firstSentence(s: string): string {
  const t = s.trim().replace(/\s+/g, " ");
  const m = t.match(/^(.{20,240}?[.!?])(\s|$)/);
  return m ? m[1] : t.slice(0, 200);
}

const CALL_TYPES = new Set([
  "AD_CALL",
  "CLICK_TO_CALL",
  "WEBSITE_CALL",
  "UPLOAD_CALLS",
  "SMART_CAMPAIGN_AD_CLICKS_TO_CALL",
  "SMART_CAMPAIGN_TRACKED_CALLS",
]);

const CATEGORY_LABEL: Record<string, string> = {
  PURCHASE: "purchases",
  SUBMIT_LEAD_FORM: "form fills",
  SIGNUP: "sign-ups",
  BOOK_APPOINTMENT: "bookings",
  REQUEST_QUOTE: "quote requests",
  CONTACT: "contacts",
  QUALIFIED_LEAD: "qualified leads",
  CONVERTED_LEAD: "converted leads",
  DOWNLOAD: "downloads",
  ADD_TO_CART: "add-to-carts",
  BEGIN_CHECKOUT: "checkouts",
  SUBSCRIBE_PAID: "paid subscriptions",
  STORE_VISIT: "store visits",
};

export type ConversionSplitRow = { action: string | null; category: string | null; conversions: number; value: number };

export function conversionSplit(
  rows: ConversionSplitRow[],
  typeByAction: Map<string, string>,
): { calls: number; forms: number; other: number; by_kind: Array<{ label: string; count: number }>; partial: boolean } {
  let calls = 0;
  let forms = 0;
  let other = 0;
  const byKind = new Map<string, number>();
  const byAction = new Map<string, { conv: number; value: number }>();
  for (const r of rows) {
    const type = r.action ? typeByAction.get(r.action) ?? null : null;
    const isCall = r.category === "PHONE_CALL_LEAD" || (type !== null && CALL_TYPES.has(type));
    if (isCall) calls += r.conversions;
    else if (r.category === "SUBMIT_LEAD_FORM") forms += r.conversions;
    else other += r.conversions;
    const label = isCall ? "calls" : CATEGORY_LABEL[r.category ?? ""] ?? "other";
    byKind.set(label, (byKind.get(label) ?? 0) + r.conversions);
    const k = r.action ?? `category:${r.category ?? "unknown"}`;
    const acc = byAction.get(k) ?? { conv: 0, value: 0 };
    acc.conv += r.conversions;
    acc.value += r.value;
    byAction.set(k, acc);
  }
  const partial = Array.from(byAction.values()).some((a) => a.conv > 0 && a.value === 0);
  const by_kind = Array.from(byKind, ([label, n]) => ({ label, count: Math.round(n) }))
    .filter((k) => k.count > 0)
    .sort((a, b) => b.count - a.count);
  return { calls: Math.round(calls), forms: Math.round(forms), other: Math.round(other), by_kind, partial };
}

export type CampaignBudget = { campaign_id: string; status: string; budget_resource: string | null; daily_budget: number | null; limited_by_budget: boolean };

export function sumDailyBudgets(budgets: CampaignBudget[]): number | null {
  const seen = new Map<string, number>();
  for (const b of budgets) {
    if (b.status !== "ENABLED" || b.daily_budget === null) continue;
    seen.set(b.budget_resource ?? `campaign:${b.campaign_id}`, b.daily_budget);
  }
  if (seen.size === 0) return null;
  return round2(Array.from(seen.values()).reduce((a, n) => a + n, 0));
}

export function cappedCampaigns(daily: GoogleDailyRow[], budgets: CampaignBudget[]): { capped: number; campaigns: number } {
  const budgetOf = new Map(budgets.filter((b) => b.daily_budget !== null && b.daily_budget > 0).map((b) => [b.campaign_id, b.daily_budget as number]));
  const perCampaign = new Map<string, { days: number; hit: number }>();
  for (const r of daily) {
    const budget = budgetOf.get(r.campaign_id);
    if (!budget || !(r.spend_usd > 0)) continue;
    const acc = perCampaign.get(r.campaign_id) ?? { days: 0, hit: 0 };
    acc.days += 1;
    if (r.spend_usd >= budget * CAP_HIT_RATIO) acc.hit += 1;
    perCampaign.set(r.campaign_id, acc);
  }
  let capped = 0;
  for (const a of perCampaign.values()) if (a.hit > 0 && a.hit * 2 >= a.days) capped += 1;
  return { capped, campaigns: perCampaign.size };
}

export function computePacing(input: {
  today: string;
  mtdSpend: number | null;
  founderPlan: number | null;
  dailyBudgetSum: number | null;
  capped: { capped: number; campaigns: number } | null;
}): GadsPacing {
  const [y, m, d] = input.today.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const daysElapsed = d;
  const founder = input.founderPlan !== null && input.founderPlan > 0;
  const plan = founder ? input.founderPlan : input.dailyBudgetSum !== null ? round2(input.dailyBudgetSum * daysInMonth) : null;
  const plannedToDate = plan !== null ? (plan * daysElapsed) / daysInMonth : null;
  const pct = input.mtdSpend !== null && plannedToDate ? Math.round((input.mtdSpend / plannedToDate) * 100) : null;
  return {
    spend: input.mtdSpend,
    plan,
    plan_basis: founder ? "founder" : "auto",
    pct,
    capped_campaigns: input.capped ? input.capped.capped : null,
    campaigns: input.capped ? input.capped.campaigns : null,
    days_elapsed: daysElapsed,
    days_in_month: daysInMonth,
  };
}

export function buildKpis(input: {
  cur: Totals;
  prev: Totals | null;
  split: { calls: number; forms: number; other: number; by_kind: Array<{ label: string; count: number }>; partial: boolean } | null;
  pacing: GadsPacing;
}): GadsKpi[] {
  const { cur, prev, split } = input;
  const cpa = (t: Totals) => (t.conversions > 0 ? round2(t.spend / t.conversions) : null);
  const roas = (t: Totals) => (t.spend > 0 ? round2(t.conv_value / t.spend) : null);
  const partial = split?.partial === true;
  return [
    kpi("spend", "Spend", "usd", cur.spend, prev ? prev.spend : null, null),
    { ...kpi("conversions", "Conversions", "count", cur.conversions, prev ? prev.conversions : null, true), conversions: split ? { calls: split.calls, forms: split.forms, other: split.other, by_kind: split.by_kind } : null },
    kpi("cpa", "Cost per conversion", "usd", cpa(cur), prev ? cpa(prev) : null, false),
    { ...kpi("conv_value", "Conversion value", "usd", cur.conv_value, prev ? prev.conv_value : null, true), partial },
    { ...kpi("roas", "ROAS", "ratio", roas(cur), prev ? roas(prev) : null, true), floor: partial },
    { ...kpi("pacing", "Spend vs plan", "pct", input.pacing.pct, null, null), pacing: input.pacing },
  ];
}

const EFFORT_LABEL: Record<string, string> = { minutes: "a few minutes", hours: "about an hour", days: "a few days" };

export function toAction(
  d: DecisionRow,
  bucket: GadsAction["bucket"],
  customerId: string | null,
  now: number,
): GadsAction | null {
  const body = (d.body ?? {}) as Record<string, unknown>;
  const isNew = !!d.emitted_at && now - Date.parse(d.emitted_at) < NEW_MS;

  if (d.decision_class === "channel.recipe_step") {
    const step = (body.step ?? {}) as Record<string, unknown>;
    const title = typeof step.title === "string" ? step.title.trim() : "";
    if (!title) return null;
    const text = typeof step.body === "string" ? step.body.trim() : "";
    const first = text ? firstSentence(text) : "";
    const rest = text.slice(text.indexOf(first) + first.length).trim();
    const ce = (step.card_evidence ?? null) as Record<string, unknown> | null;
    const evTiles = tiles(ce?.stats);
    const estTiles = tiles(ce?.estimate);
    const reasoning = rest ? rest.slice(0, 600) : null;
    return {
      key: `step:${d.id}`,
      decision_id: d.id,
      decision_class: d.decision_class,
      bucket,
      title,
      is_new: isNew,
      effort_label: EFFORT_LABEL[String(step.effort)] ?? "a few minutes",
      change_sentence: first || null,
      evidence: evTiles.length || reasoning ? { window_label: windowLabel(ce?.window as never), tiles: evTiles, reasoning } : null,
      exact_change: null,
      estimate: estTiles.length ? { tiles: estTiles } : null,
      link: null,
      applied_at: null,
    };
  }

  const change = gadsChangeRows(d.decision_class, body);
  if (!change) return null;
  const ev = (body.decision_evidence ?? null) as Record<string, unknown> | null;
  const evTiles = tiles(ev?.stats);
  const estTiles = tiles(ev?.estimate);
  const reason =
    (typeof ev?.reason_text === "string" && ev.reason_text.trim()) ||
    (typeof body.rationale === "string" && body.rationale.trim()) ||
    null;
  return {
    key: `gads:${d.id}`,
    decision_id: d.id,
    decision_class: d.decision_class,
    bucket,
    title:
      adChangeHeadline(d.decision_class, body) ??
      (typeof ev?.headline === "string" && ev.headline.trim().length >= 3
        ? ev.headline.trim().slice(0, 80)
        : change.title),
    is_new: isNew,
    effort_label: "1 min",
    change_sentence: change.change_sentence,
    evidence: evTiles.length || reason ? { window_label: windowLabel(ev?.window as never), tiles: evTiles, reasoning: reason ? reason.slice(0, 600) : null } : null,
    exact_change: change.rows.length ? { rows: change.rows } : null,
    estimate: estTiles.length ? { tiles: estTiles } : null,
    link: change.campaign_id ? googleCampaignUrl(customerId, change.campaign_id) : null,
    applied_at: bucket === "autonomous" ? d.dispatched_at ?? null : null,
  };
}

export function toChannelActionCard(r: ChannelStepRow, now: number): GadsAction | null {
  const body = (r.body ?? {}) as Record<string, unknown>;
  const step = (body.step ?? {}) as Record<string, unknown>;
  const title = typeof step.title === "string" ? step.title.trim() : "";
  if (!title) return null;
  const isNew = !!r.emitted_at && now - Date.parse(r.emitted_at) < NEW_MS;

  if (!r.executable) return toAction(r, "needs_you", null, now);

  const ev = (body.decision_evidence ?? null) as Record<string, unknown> | null;
  const evTiles = tiles(ev?.stats);
  const estTiles = tiles(ev?.estimate);
  const reason =
    (typeof ev?.reason_text === "string" && ev.reason_text.trim()) ||
    (typeof step.body === "string" && step.body.trim()) ||
    null;
  type ChangeRows = NonNullable<GadsAction["exact_change"]>["rows"];
  const rows = ((body.exact_change ?? null) as { rows?: ChangeRows } | null)?.rows;
  return {
    key: `gads:${r.id}`,
    decision_id: r.id,
    decision_class: "channel.recipe_step",
    bucket: "needs_approval",
    title: title.slice(0, 160),
    is_new: isNew,
    effort_label: "1 min",
    change_sentence: typeof body.change_sentence === "string" ? body.change_sentence : null,
    evidence:
      evTiles.length || reason
        ? { window_label: windowLabel(ev?.window as never), tiles: evTiles, reasoning: reason ? reason.slice(0, 600) : null }
        : null,
    exact_change: Array.isArray(rows) && rows.length ? { rows } : null,
    estimate: estTiles.length ? { tiles: estTiles } : null,
    link: typeof body.link === "string" ? body.link : null,
    applied_at: null,
  };
}

function errorCode(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "google_ads_read_failed";
}

function isNotConnected(code: string): boolean {
  return code.endsWith("_not_connected") || code === "google_ads_not_configured";
}

async function readAccount(search: GoogleAdsSearch): Promise<{ name: string | null; customer_id: string | null; time_zone: string | null; currency: string | null }> {
  const rows = (await search("SELECT customer.id, customer.descriptive_name, customer.time_zone, customer.currency_code FROM customer LIMIT 1")) as Array<{
    customer?: { id?: string | number; descriptiveName?: string; timeZone?: string; currencyCode?: string };
  }>;
  const c = rows[0]?.customer;
  return {
    name: c?.descriptiveName ? String(c.descriptiveName) : null,
    customer_id: c?.id != null ? String(c.id) : null,
    time_zone: c?.timeZone ?? null,
    currency: c?.currencyCode ?? null,
  };
}

export async function readBudgets(search: GoogleAdsSearch): Promise<CampaignBudget[] | null> {
  try {
    const rows = (await search(
      "SELECT campaign.id, campaign.status, campaign.campaign_budget, campaign_budget.amount_micros FROM campaign WHERE campaign.status != 'REMOVED'",
    )) as Array<{
      campaign?: { id?: string | number; status?: string; campaignBudget?: string };
      campaignBudget?: { amountMicros?: string | number };
    }>;
    const limited = new Set<string>();
    try {
      const statusRows = (await search(
        "SELECT campaign.id, campaign.primary_status, campaign.primary_status_reasons FROM campaign WHERE campaign.status = 'ENABLED'",
      )) as Array<{ campaign?: { id?: string | number; primaryStatus?: string; primaryStatusReasons?: string[] } }>;
      for (const r of statusRows) {
        if (Array.isArray(r.campaign?.primaryStatusReasons) && r.campaign!.primaryStatusReasons!.includes("BUDGET_CONSTRAINED")) {
          limited.add(String(r.campaign?.id ?? ""));
        }
      }
    } catch {
    }
    return rows.map((r) => {
      const id = String(r.campaign?.id ?? "");
      return {
        campaign_id: id,
        status: String(r.campaign?.status ?? ""),
        budget_resource: r.campaign?.campaignBudget ?? null,
        daily_budget: r.campaignBudget?.amountMicros != null ? round2(Number(r.campaignBudget.amountMicros) / 1_000_000) : null,
        limited_by_budget: limited.has(id),
      };
    });
  } catch {
    return null;
  }
}

async function readSplit(search: GoogleAdsSearch, since: string, until: string): Promise<ReturnType<typeof conversionSplit> | null> {
  try {
    const [metricRows, actionRows] = await Promise.all([
      search(
        `SELECT segments.conversion_action, segments.conversion_action_category, metrics.conversions, metrics.conversions_value FROM customer WHERE segments.date BETWEEN '${since}' AND '${until}'`,
      ) as Promise<Array<{ segments?: { conversionAction?: string; conversionActionCategory?: string }; metrics?: { conversions?: number | string; conversionsValue?: number | string } }>>,
      search("SELECT conversion_action.resource_name, conversion_action.type FROM conversion_action") as Promise<
        Array<{ conversionAction?: { resourceName?: string; type?: string } }>
      >,
    ]);
    const types = new Map<string, string>();
    for (const a of actionRows) if (a.conversionAction?.resourceName && a.conversionAction.type) types.set(a.conversionAction.resourceName, a.conversionAction.type);
    return conversionSplit(
      metricRows.map((r) => ({
        action: r.segments?.conversionAction ?? null,
        category: r.segments?.conversionActionCategory ?? null,
        conversions: Number(r.metrics?.conversions ?? 0),
        value: Number(r.metrics?.conversionsValue ?? 0),
      })),
      types,
    );
  } catch {
    return null;
  }
}

async function readMtdSpend(search: GoogleAdsSearch): Promise<number | null> {
  try {
    const rows = (await search("SELECT metrics.cost_micros FROM customer WHERE segments.date DURING THIS_MONTH")) as Array<{ metrics?: { costMicros?: string | number } }>;
    return round2(rows.reduce((a, r) => a + Number(r.metrics?.costMicros ?? 0), 0) / 1_000_000);
  } catch {
    return null;
  }
}

async function readFounderPlan(c: DashboardContext): Promise<number | null> {
  try {
    const { data, error } = await c.sb
      .from("tenant_channels")
      .select("monthly_budget_usd")
      .eq("tenant_id", c.tenantId)
      .eq("channel_slug", "google_ads")
      .maybeSingle();
    if (error || !data) return null;
    const v = (data as { monthly_budget_usd?: number | string | null }).monthly_budget_usd;
    const n = v === null || v === undefined ? null : Number(v);
    return n !== null && Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export async function readActions(
  c: DashboardContext,
  since: string,
  customerId: string | null,
): Promise<{ actions: GadsAction[]; counts: { all: number; needs_you: number; autonomous: number }; more: number }> {
  const cols = "id, decision_class, body, emitted_at, agent_run_id, dispatched_at";
  const q = async (build: (qb: ReturnType<DashboardContext["sb"]["from"]>) => unknown): Promise<DecisionRow[]> => {
    try {
      const { data, error } = (await build(c.sb.from("decisions"))) as { data: unknown; error: unknown };
      return error || !Array.isArray(data) ? [] : (data as DecisionRow[]);
    } catch {
      return [];
    }
  };
  const switched = channelIsSwitched("google_ads");
  const [proposals, steps, channelRows, applied] = await Promise.all([
    switched
      ? Promise.resolve([] as DecisionRow[])
      : q((t) => t.select(cols).eq("tenant_id", c.tenantId).eq("status", "proposed").like("decision_class", "google_ads.%").is("superseded_at", null).order("emitted_at", { ascending: false }).limit(200)),
    switched
      ? Promise.resolve([] as DecisionRow[])
      : q((t) => t.select(cols).eq("tenant_id", c.tenantId).eq("status", "proposed").eq("decision_class", "channel.recipe_step").order("emitted_at", { ascending: false }).limit(200)),
    switched ? readSwitchedChannelRows(c.tenantId, "google_ads") : Promise.resolve([] as ChannelStepRow[]),
    q((t) => t.select(cols).eq("tenant_id", c.tenantId).like("decision_class", "google_ads.%").eq("autonomy_at_emit", "auto").gte("dispatched_at", `${since}T00:00:00Z`).is("dispatch_error", null).order("dispatched_at", { ascending: false }).limit(100)),
  ]);

  const runIds = Array.from(new Set(steps.map((s) => s.agent_run_id).filter((x): x is string => !!x)));
  const gadsRuns = new Set<string>();
  if (runIds.length) {
    try {
      const { data } = await c.sb.from("agent_runs").select("id, agent_slug").eq("tenant_id", c.tenantId).in("id", runIds);
      for (const r of (data ?? []) as Array<{ id: string; agent_slug: string }>) if (r.agent_slug === "google_ads") gadsRuns.add(r.id);
    } catch {
    }
  }

  const now = Date.now();
  const fromChannel = channelRows
    .map((r) => toChannelActionCard(r, now))
    .filter((a): a is GadsAction => !!a);
  const needsApproval = [
    ...proposals.map((d) => toAction(d, "needs_approval", customerId, now)).filter((a): a is GadsAction => !!a),
    ...fromChannel.filter((a) => a.bucket === "needs_approval"),
  ];
  const needsYou = [
    ...steps
      .filter((d) => d.agent_run_id && gadsRuns.has(d.agent_run_id))
      .map((d) => toAction(d, "needs_you", customerId, now))
      .filter((a): a is GadsAction => !!a),
    ...fromChannel.filter((a) => a.bucket === "needs_you"),
  ];
  const autonomous = applied.map((d) => toAction(d, "autonomous", customerId, now)).filter((a): a is GadsAction => !!a);

  const all = [...needsApproval, ...needsYou, ...autonomous];
  return {
    actions: all.slice(0, MAX_ACTIONS),
    counts: { all: all.length, needs_you: needsApproval.length + needsYou.length, autonomous: autonomous.length },
    more: Math.max(0, all.length - MAX_ACTIONS),
  };
}

export const build: DashboardBuilder = async (c) => {
  const custom = c.customRange ?? null;
  const days = custom
    ? Math.round((Date.parse(`${custom.until}T00:00:00Z`) - Date.parse(`${custom.since}T00:00:00Z`)) / 86_400_000) + 1
    : c.rangeDays && GADS_RANGES.some((r) => r.days === c.rangeDays) ? c.rangeDays : DEFAULT_DAYS;
  const search = createGoogleAdsReadSession(c.tenantId);
  const base = { ranges: GADS_RANGES, window_days: days };

  let account: Awaited<ReturnType<typeof readAccount>>;
  try {
    account = await readAccount(search);
  } catch (e) {
    const code = errorCode(e);
    if (isNotConnected(code)) {
      return { ...base, connected: false, error_code: "not_connected", account: null, kpis: [], campaigns: [], totals: null, actions: [], counts: { all: 0, needs_you: 0, autonomous: 0 }, actions_more: 0 };
    }
    const today = new Date().toISOString().slice(0, 10);
    const acts = await readActions(c, shiftDays(today, -days), null);
    return { ...base, connected: true, error_code: code, account: null, kpis: [], campaigns: [], totals: null, actions: acts.actions, counts: acts.counts, actions_more: acts.more };
  }

  const today = todayIn(account.time_zone);
  const until = custom ? custom.until : shiftDays(today, -1);
  const since = custom ? custom.since : shiftDays(today, -days);
  const prevUntil = shiftDays(since, -1);
  const prevSince = shiftDays(since, -days);

  const [cur, prevRows, budgets, split, mtd, founderPlan, todaySpend] = await Promise.all([
    readGoogleCampaigns(c.tenantId, { date_range: "LAST_30_DAYS", custom_range: { since, until } }, "google_ads").catch((e: unknown) => e as Error),
    (listCampaignsTool.execute(c.ctx, { custom_range: { since: prevSince, until: prevUntil }, status: "ALL" }) as Promise<{ campaigns?: GoogleCampaignRow[] }>)
      .then((r) => r.campaigns ?? [])
      .catch(() => null),
    readBudgets(search),
    readSplit(search, since, until),
    readMtdSpend(search),
    readFounderPlan(c),
    readGoogleTodaySpend(search, today),
  ]);

  const customerId = account.customer_id ?? (cur instanceof Error ? null : cur.customer_id);
  const acts = await readActions(c, since, customerId);

  if (cur instanceof Error) {
    return {
      ...base,
      connected: true,
      error_code: errorCode(cur),
      currency: account.currency,
    period: { from: since, to: until },
      prev_period: { from: prevSince, to: prevUntil },
      account: { name: account.name, customer_id: customerId, campaign_count: null },
      kpis: [],
      campaigns: [],
      totals: null,
      actions: acts.actions,
      counts: acts.counts,
      actions_more: acts.more,
    };
  }

  const limited = new Map((budgets ?? []).map((b) => [b.campaign_id, b.limited_by_budget]));
  const budgetOf = new Map((budgets ?? []).map((b) => [b.campaign_id, b]));
  const sharedCount = new Map<string, number>();
  for (const b of budgets ?? []) if (b.budget_resource) sharedCount.set(b.budget_resource, (sharedCount.get(b.budget_resource) ?? 0) + 1);
  const shownRows = cur.campaigns.filter((r) => Number(r.spend_usd ?? 0) > 0 || Number(r.conversions ?? 0) > 0 || r.status === "ENABLED");
  const campaigns: GadsCampaign[] = shownRows.map((r) => {
    const id = String(r.campaign_id ?? "");
    const spend = round2(Number(r.spend_usd ?? 0));
    const conv = round2(Number(r.conversions ?? 0));
    return {
      id,
      name: String(r.campaign_name ?? ""),
      status: String(r.status ?? ""),
      channel_type: typeof r.channel_type === "string" ? r.channel_type : null,
      limited_by_budget: limited.get(id) === true,
      spend,
      conversions: conv,
      cpa: conv > 0 ? round2(spend / conv) : null,
      conv_value: round2(Number(r.conversions_value_usd ?? 0)),
      url: googleCampaignUrl(customerId, id),
      daily_budget: budgetOf.get(id)?.daily_budget ?? null,
      budget_shared: (sharedCount.get(budgetOf.get(id)?.budget_resource ?? "") ?? 0) > 1,
    };
  });

  const curTotals = totalsOf(cur.campaigns);
  const prevTotals = prevRows ? totalsOf(prevRows) : null;
  const pacing = computePacing({
    today,
    mtdSpend: mtd,
    founderPlan,
    dailyBudgetSum: budgets ? sumDailyBudgets(budgets) : null,
    capped: budgets && cur.daily ? cappedCampaigns(cur.daily.rows, budgets) : null,
  });

  return {
    ...base,
    connected: true,
    error_code: null,
    currency: account.currency,
    period: { from: since, to: until },
    prev_period: { from: prevSince, to: prevUntil },
    account: { name: account.name, customer_id: customerId, campaign_count: campaigns.length },
    kpis: buildKpis({ cur: curTotals, prev: prevTotals, split, pacing }),
    campaigns,
    paused_campaigns: cur.campaigns
      .filter((r) => r.status === "PAUSED" && !shownRows.includes(r))
      .slice(0, 50)
      .map((r) => ({
        id: String(r.campaign_id ?? ""),
        name: String(r.campaign_name ?? ""),
        channel_type: typeof r.channel_type === "string" ? r.channel_type : null,
        url: googleCampaignUrl(customerId, String(r.campaign_id ?? "")),
        daily_budget: budgetOf.get(String(r.campaign_id ?? ""))?.daily_budget ?? null,
      })),
    totals: {
      campaigns: campaigns.length,
      spend: curTotals.spend,
      conversions: curTotals.conversions,
      cpa: curTotals.conversions > 0 ? round2(curTotals.spend / curTotals.conversions) : null,
      conv_value: curTotals.conv_value,
      roas: curTotals.spend > 0 ? round2(curTotals.conv_value / curTotals.spend) : null,
    },
    daily_budget: budgets
      ? buildGoogleDailyBudget({
          budgets,
          names: new Map(cur.campaigns.map((r) => [String(r.campaign_id ?? ""), String(r.campaign_name ?? "")])),
          daily: cur.daily ? cur.daily.rows : null,
          today: todaySpend,
        })
      : null,
    actions: acts.actions,
    counts: acts.counts,
    actions_more: acts.more,
  };
};
