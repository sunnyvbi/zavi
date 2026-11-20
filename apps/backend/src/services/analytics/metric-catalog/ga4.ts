
import { runReport, type GaRunReportBody, type GaRunReportResponse } from "@/services/tools/google-analytics/_client";
import { compactToLocalDate, type LocalDate, type ResolvedWindow } from "@/services/analytics/metric-time";
import { div, failFrom, sumByKey } from "./shared";
import type { FetchOk, FetchResult, MetricFetchCtx, MetricImpl, Parts } from "./types";

const ROW_LIMIT = 100_000;
const BREAKDOWN_TOP = 50;

const GA4_BREAKDOWN_DIMS: Partial<Record<string, { dim: string; words: string }>> = {
  source_medium: { dim: "sessionSourceMedium", words: "source/mediums" },
  device: { dim: "deviceCategory", words: "devices" },
  country: { dim: "country", words: "countries" },
  landing_page: { dim: "landingPage", words: "landing pages" },
};

function num(v?: string): number {
  const n = Number(v ?? "0");
  return Number.isFinite(n) ? n : 0;
}

async function report(
  tenant_id: string,
  w: ResolvedWindow,
  dimensions: string[],
  metrics: string[],
): Promise<{ rows: Array<{ dims: string[]; vals: number[] }>; truncated: boolean }> {
  const body: GaRunReportBody = {
    dateRanges: [{ startDate: w.since, endDate: w.until }],
    dimensions: dimensions.map((name) => ({ name })),
    metrics: metrics.map((name) => ({ name })),
    limit: String(ROW_LIMIT),
  };
  const res: GaRunReportResponse = await runReport(tenant_id, body);
  const rows = (res.rows ?? []).map((r) => ({
    dims: (r.dimensionValues ?? []).map((d) => d.value ?? ""),
    vals: (r.metricValues ?? []).map((m) => num(m.value)),
  }));
  return { rows, truncated: typeof res.rowCount === "number" && res.rowCount > rows.length };
}

export const EMPTY_WINDOW_MESSAGE = "the connected GA property has no data for this window; check the property";
const isEmpty = (rows: Array<{ vals: number[] }>) => !rows.some((r) => r.vals.some((v) => v !== 0));
const EMPTY = { ok: false as const, reason: "empty_window" as const, message: EMPTY_WINDOW_MESSAGE };

const TRUNCATED = (what: string) => ({
  ok: false as const,
  reason: "too_many_rows" as const,
  message: `GA4 returned only part of the ${what} rows. Pick a shorter window or no breakdown; a partial sum would undercount.`,
});

async function fetchSessionsAndEvents(ctx: MetricFetchCtx, w: ResolvedWindow): Promise<FetchResult> {
  try {
    const daily = await report(ctx.tenant_id, w, ["date"], ["sessions", "keyEvents"]);
    if (daily.truncated) return TRUNCATED("daily");
    if (isEmpty(daily.rows)) return EMPTY;
    const out: FetchOk = {
      ok: true,
      daily: daily.rows
        .map((r) => ({ date: compactToLocalDate(r.dims[0]) ?? "", parts: { sessions: r.vals[0], key_events: r.vals[1] } }))
        .filter((r) => r.date)
        .sort((a, b) => a.date.localeCompare(b.date)),
      currency: null,
      row_count: daily.rows.length,
      truncated: false,
      caveats: [],
      params: { source: "ga4.runReport", dimensions: ["date"], metrics: ["sessions", "keyEvents"], since: w.since, until: w.until },
    };
    const bd = ctx.breakdown ? GA4_BREAKDOWN_DIMS[ctx.breakdown] : undefined;
    if (bd) {
      const by = await report(ctx.tenant_id, w, [bd.dim], ["sessions", "keyEvents"]);
      if (by.truncated) return TRUNCATED(bd.words);
      if (isEmpty(by.rows)) return EMPTY;
      const all = sumByKey(
        by.rows.map((r) => ({ key: r.dims[0] || "(not set)", parts: { sessions: r.vals[0], key_events: r.vals[1] } })),
        "sessions",
      );
      out.breakdown = all.slice(0, BREAKDOWN_TOP);
      if (all.length > BREAKDOWN_TOP) out.caveats.push(`Breakdown shows the top ${BREAKDOWN_TOP} of ${all.length} ${bd.words} by sessions.`);
    }
    return out;
  } catch (e) {
    return failFrom(e, "Google Analytics");
  }
}

export function isoWeekToMonday(yw: string): LocalDate | null {
  const m = /^(\d{4})(\d{2})$/.exec(yw);
  if (!m) return null;
  const year = Number(m[1]);
  const week = Number(m[2]);
  const jan4 = new Date(Date.UTC(year, 0, 4, 12));
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7));
  week1Monday.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);
  return week1Monday.toISOString().slice(0, 10);
}

function bucketKeyToStart(dim: string, grain: MetricFetchCtx["grain"]): LocalDate | null {
  if (grain === "day") return compactToLocalDate(dim);
  if (grain === "week") return isoWeekToMonday(dim);
  return /^\d{6}$/.test(dim) ? `${dim.slice(0, 4)}-${dim.slice(4, 6)}-01` : null;
}

async function fetchUsers(ctx: MetricFetchCtx, w: ResolvedWindow): Promise<FetchResult> {
  const dim = ctx.grain === "day" ? "date" : ctx.grain === "week" ? "isoYearIsoWeek" : "yearMonth";
  try {
    const [series, total] = await Promise.all([
      report(ctx.tenant_id, w, [dim], ["totalUsers"]),
      report(ctx.tenant_id, w, [], ["totalUsers"]),
    ]);
    if (series.truncated) return TRUNCATED("users");
    if (isEmpty(series.rows) && isEmpty(total.rows)) return EMPTY;
    const buckets: Array<{ start: LocalDate; parts: Parts }> = [];
    for (const r of series.rows) {
      const start = bucketKeyToStart(r.dims[0], ctx.grain);
      if (start) buckets.push({ start, parts: { users: r.vals[0] } });
    }
    buckets.sort((a, b) => a.start.localeCompare(b.start));
    const out: FetchOk = {
      ok: true,
      buckets,
      total_parts: { users: total.rows[0]?.vals[0] ?? 0 },
      currency: null,
      row_count: series.rows.length,
      truncated: false,
      caveats: [],
      params: { source: "ga4.runReport", dimensions: [dim], metrics: ["totalUsers"], since: w.since, until: w.until },
    };
    const bd = ctx.breakdown ? GA4_BREAKDOWN_DIMS[ctx.breakdown] : undefined;
    if (bd) {
      const by = await report(ctx.tenant_id, w, [bd.dim], ["totalUsers"]);
      if (by.truncated) return TRUNCATED(bd.words);
      if (isEmpty(by.rows)) return EMPTY;
      const all = sumByKey(by.rows.map((r) => ({ key: r.dims[0] || "(not set)", parts: { users: r.vals[0] } })), "users");
      out.breakdown = all.slice(0, BREAKDOWN_TOP);
      out.caveats.push("A user can show up under several values of a breakdown, so it can add up to more than the total.");
    }
    return out;
  } catch (e) {
    return failFrom(e, "Google Analytics");
  }
}

export const ga4Metrics: Record<string, MetricImpl> = {
  sessions: { value: (p) => p.sessions ?? 0, fetch: fetchSessionsAndEvents },
  key_events: { value: (p) => p.key_events ?? 0, fetch: fetchSessionsAndEvents },
  conversion_rate: { value: (p) => div(p.key_events, p.sessions), fetch: fetchSessionsAndEvents },
  users: { value: (p) => p.users ?? 0, fetch: fetchUsers },
};
