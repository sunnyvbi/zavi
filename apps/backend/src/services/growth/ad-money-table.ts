
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { serverClientFromBearer } from "@/services/supabase";
import { PERF_DASH_SCHEMA } from "./perf-dash-schema";

export type SpendRow = {
  platform: string;
  spend_date: string;
  amount_usd: number | string;
  account_id?: string | null;
  object_id?: string | null;
  provisional?: boolean | null;
};

export type ResultPoint = { date?: unknown; bookings?: unknown; spend_usd?: unknown; maturing?: unknown };
type ResultSeries = { points?: ResultPoint[]; meta_truncated?: unknown } | null;
type ChannelRead = { read_at?: unknown; error?: unknown } | null;
export type ResultsSnapshot = {
  series: { meta?: ResultSeries; google?: ResultSeries } | null;
  reads?: { meta?: ChannelRead; google?: ChannelRead } | null;
  fetched_at: string;
};

export type MoneyTableResults = {
  count: number;
  label: string;
  cost_each_usd: number | null;
  source: string;
  from: string;
  to: string;
  settling: boolean;
};

export type MoneyTableRow = {
  platform: string;
  name: string;
  spent_usd: number;
  share: number | null;
  last7_usd: number;
  prev7_usd: number;
  change: number | null;
  results: MoneyTableResults | null;
  results_status: "platform" | "not_synced" | "unavailable" | "read_failed";
  spend_read_failed: boolean;
};

export type MoneyTable = {
  month_start: string;
  today: string;
  spend_through: string | null;
  rows: MoneyTableRow[];
  total: { spent_usd: number; last7_usd: number; prev7_usd: number; change: number | null };
  budget: { status: "active" | "stopped"; month_cap_usd: number; monthly_usd: number; spent_usd: number } | null;
  results_read_at: string | null;
};

const DAY_MS = 86_400_000;
const STALE_RESULTS_DAYS = 7;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const round2 = (n: number) => Math.round(n * 100) / 100;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const RESULT_PLATFORMS = {
  meta: { label: "purchases", source: "Meta's own count" },
  google: { label: "conversions", source: "Google's own count" },
} as const;

const PLATFORM_NAMES: Record<string, string> = {
  meta: "Meta Ads",
  google: "Google Ads",
  reddit: "Reddit Ads",
  tiktok: "TikTok Ads",
  linkedin: "LinkedIn Ads",
  x: "X Ads",
  chatgpt: "ChatGPT Ads",
  pinterest: "Pinterest Ads",
  snapchat: "Snapchat Ads",
  microsoft: "Microsoft Ads",
  apple: "Apple Ads",
  spotify: "Spotify Ads",
};

export function platformName(platform: string): string {
  return PLATFORM_NAMES[platform] ?? `${platform.charAt(0).toUpperCase()}${platform.slice(1)} Ads`;
}

export function spendReadSince(monthStart: string, today: string): string {
  const back = isoDay(Date.parse(`${today}T00:00:00Z`) - 18 * DAY_MS);
  return back < monthStart ? back : monthStart;
}

function finite(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

export type SnapshotRead = ResultsSnapshot | null | "failed";

function platformReadFailed(platform: "meta" | "google", snap: ResultsSnapshot | null): boolean {
  return !!snap?.reads?.[platform]?.error;
}

function resultsFor(platform: "meta" | "google", snap: ResultsSnapshot | null): MoneyTableResults | null {
  const series = snap?.series?.[platform];
  if (!series || series.meta_truncated === true) return null;
  const points = series.points;
  if (!Array.isArray(points) || points.length === 0) return null;
  let count = 0;
  let spend = 0;
  let settling = false;
  const dates: string[] = [];
  for (const p of points) {
    if (typeof p?.date !== "string" || !DATE_RE.test(p.date)) continue;
    count += Math.max(0, finite(p.bookings));
    spend += Math.max(0, finite(p.spend_usd));
    if (p.maturing === true) settling = true;
    dates.push(p.date);
  }
  if (dates.length === 0) return null;
  dates.sort();
  const rounded = round2(count);
  return {
    count: rounded,
    label: RESULT_PLATFORMS[platform].label,
    cost_each_usd: rounded > 0 ? round2(spend / rounded) : null,
    source: RESULT_PLATFORMS[platform].source,
    from: dates[0],
    to: dates[dates.length - 1],
    settling,
  };
}

function lastDayOfMonth(monthStart: string): string {
  const [y, m] = monthStart.split("-").map(Number);
  return isoDay(Date.UTC(y, m, 0));
}

const change = (last7: number, prev7: number) => (prev7 > 0 ? Math.round(((last7 - prev7) / prev7) * 1000) / 1000 : null);

export function buildMoneyTable(input: {
  spend: SpendRow[];
  snapshot: SnapshotRead;
  budget: { status: "active" | "stopped"; month_cap_usd: number; monthly_usd: number; spent_usd: number; month_start: string } | null;
  today: string;
  spendReadFailed?: readonly string[];
}): MoneyTable {
  const { today } = input;
  const monthStart = input.budget?.month_start ?? `${today.slice(0, 7)}-01`;
  const monthEnd = lastDayOfMonth(monthStart);
  const shift = (day: string, days: number) => isoDay(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS);

  const perDay = new Map<string, { platform: string; account: string; day: string; amount: number; provisional: boolean }>();
  for (const r of input.spend) {
    const platform = String(r.platform ?? "").trim();
    const day = String(r.spend_date ?? "").slice(0, 10);
    if (!platform || !DATE_RE.test(day)) continue;
    const amount = Math.max(0, finite(r.amount_usd));
    const account = `${platform}|${r.account_id ?? ""}`;
    const key = `${account}|${r.object_id ?? ""}|${day}`;
    const cur = perDay.get(key);
    const provisional = r.provisional === true || cur?.provisional === true;
    perDay.set(key, { platform, account, day, amount: Math.max(amount, cur?.amount ?? 0), provisional });
  }

  const openDay = new Map<string, string>();
  const near = (day: string) => day >= shift(today, -4) && day <= shift(today, 1);
  for (const d of perDay.values()) {
    if (!d.provisional || !near(d.day)) continue;
    const cur = openDay.get(d.account);
    if (!cur || d.day < cur) openDay.set(d.account, d.day);
  }

  type Acc = { month: number; last7: number; prev7: number };
  const by = new Map<string, Acc>();
  let through: string | null = null;
  for (const { platform, account, day, amount, provisional } of perDay.values()) {
    const a = by.get(platform) ?? { month: 0, last7: 0, prev7: 0 };
    if (day >= monthStart && day <= monthEnd) a.month += amount;
    const end = openDay.get(account) ?? today;
    if (!provisional && day < end) {
      if (day >= shift(end, -7)) a.last7 += amount;
      else if (day >= shift(end, -14)) a.prev7 += amount;
    }
    by.set(platform, a);
    if (day <= monthEnd && (through === null || day > through)) through = day;
  }

  const monthTotal = [...by.values()].reduce((s, a) => s + a.month, 0);
  const unread = new Set(input.spendReadFailed ?? []);
  const snapshot = input.snapshot === "failed" ? null : input.snapshot;
  const rows: MoneyTableRow[] = [...by.entries()].map(([platform, a]) => {
    const hasResults = platform === "meta" || platform === "google";
    const failed = input.snapshot === "failed" || (hasResults && platformReadFailed(platform, snapshot));
    const read = hasResults && !failed ? resultsFor(platform, snapshot) : null;
    const results = read && read.to >= shift(today, -STALE_RESULTS_DAYS) ? read : null;
    const spendReadFailed = unread.has(platform);
    return {
      platform,
      name: platformName(platform),
      spent_usd: round2(a.month),
      share: monthTotal > 0 ? Math.round((a.month / monthTotal) * 1000) / 1000 : null,
      last7_usd: round2(a.last7),
      prev7_usd: round2(a.prev7),
      change: spendReadFailed ? null : change(a.last7, a.prev7),
      results,
      results_status: !hasResults ? "not_synced" : results ? "platform" : failed ? "read_failed" : "unavailable",
      spend_read_failed: spendReadFailed,
    };
  });
  rows.sort((x, y) => y.spent_usd - x.spent_usd || y.last7_usd - x.last7_usd || x.name.localeCompare(y.name));

  const last7 = rows.reduce((s, r) => s + r.last7_usd, 0);
  const prev7 = rows.reduce((s, r) => s + r.prev7_usd, 0);
  const anyUnread = rows.some((r) => r.spend_read_failed);
  const anyResults = rows.some((r) => r.results !== null);
  const b = input.budget;
  return {
    month_start: monthStart,
    today,
    spend_through: through,
    rows,
    total: { spent_usd: round2(monthTotal), last7_usd: round2(last7), prev7_usd: round2(prev7), change: anyUnread ? null : change(last7, prev7) },
    budget: b
      ? { status: b.status, month_cap_usd: round2(b.month_cap_usd), monthly_usd: round2(b.monthly_usd), spent_usd: round2(b.spent_usd) }
      : null,
    results_read_at: anyResults && input.snapshot !== "failed" ? (input.snapshot?.fetched_at ?? null) : null,
  };
}

const PAGE = 1000;
const MAX_PAGES = 50;

export async function readSpendRows(tenant_id: string, since: string): Promise<SpendRow[]> {
  const out: SpendRow[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await tenantClient(asTenantId(tenant_id))
      .from("ad_spend_daily")
      .select("platform, account_id, object_id, spend_date, amount_usd, provisional")
      .gte("spend_date", since)
      .order("id", { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw new Error(`ad_spend_daily read failed: ${error.message}`);
    const rows = (data ?? []) as SpendRow[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
  throw new Error(`ad_spend_daily read exceeded ${MAX_PAGES * PAGE} rows`);
}

export async function readSpendReadFailures(tenant_id: string, budget_id: string | null): Promise<string[]> {
  if (!budget_id) return [];
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("ad_budgets")
    .select("read_failed")
    .eq("id", budget_id)
    .maybeSingle();
  if (error) throw new Error(`ad_budgets read failed: ${error.message}`);
  const rf = (data as { read_failed?: unknown } | null)?.read_failed;
  return rf && typeof rf === "object" && !Array.isArray(rf) ? Object.keys(rf as Record<string, unknown>) : [];
}

export async function readResultsSnapshot(access_token: string, tenant_id: string): Promise<SnapshotRead> {
  try {
    const { data, error } = await serverClientFromBearer(access_token).rpc("get_perf_dashboard_snapshot", {
      p_tenant_id: tenant_id,
      p_window: "last_30d",
    });
    if (error) {
      console.warn(`[ad-money-table] snapshot read failed for tenant ${tenant_id}: ${error.message}`);
      return "failed";
    }
    const row = (Array.isArray(data) ? data[0] : data) as
      | { payload?: unknown; schema_version?: unknown; fetched_at?: unknown }
      | null
      | undefined;
    if (!row || row.schema_version !== PERF_DASH_SCHEMA) return null;
    const payload = row.payload as { daily_series_by_channel?: unknown; channel_reads?: unknown } | undefined;
    const series = payload?.daily_series_by_channel;
    if (!series || typeof series !== "object") return null;
    const fetchedMs = new Date(String(row.fetched_at ?? "")).getTime();
    if (!Number.isFinite(fetchedMs)) return null;
    const pick = (r: unknown): ChannelRead =>
      r && typeof r === "object" ? { read_at: (r as { read_at?: unknown }).read_at, error: (r as { error?: unknown }).error ?? null } : null;
    const cr = payload?.channel_reads as { meta?: unknown; google?: unknown } | undefined;
    return {
      series: series as ResultsSnapshot["series"],
      reads: cr && typeof cr === "object" ? { meta: pick(cr.meta), google: pick(cr.google) } : null,
      fetched_at: new Date(fetchedMs).toISOString(),
    };
  } catch (e) {
    console.warn(`[ad-money-table] snapshot read threw for tenant ${tenant_id}: ${(e as Error).message}`);
    return "failed";
  }
}
