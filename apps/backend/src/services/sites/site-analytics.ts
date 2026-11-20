
import { isBookingCollection } from "./booking-signal";
import type { SiteRow } from "./contract";
import type { SiteAuthDirectory, SubmissionStatRow, SubmissionWindow } from "@/services/site-auth/types";
import { asTenantId, tenantRpc } from "@/services/tenant-client";

export const ANALYTICS_RANGES = [7, 30, 90] as const;
export type AnalyticsRange = (typeof ANALYTICS_RANGES)[number];

export const SUBMISSION_STATS_SCHEMA = "1040_submission_stats";

export type SubmissionKind = "form" | "booking";

export type SiteAnalytics = {
  state: "ready" | "no_database";
  range: { days: AnalyticsRange; tz: string; from: string; to: string };
  total: number;
  previous_total: number;
  all_time: number;
  daily: Array<{ day: string; count: number }>;
  forms: Array<{
    collection: string;
    label: string;
    kind: SubmissionKind;
    count: number;
    previous: number;
    all_time: number;
    last_at: string | null;
  }>;
  traffic: SiteTraffic;
};

export type SiteTraffic = {
  visits: number;
  previous_visits: number;
  pageviews: number;
  conversion: number | null;
  daily: Array<{ day: string; visits: number; pageviews: number }>;
  pages: Array<{ path: string; pageviews: number; visits: number }>;
  sources: Array<{ source: string | null; visits: number }>;
};

export type TrafficStats = {
  pageviews?: unknown;
  visits?: unknown;
  previous_visits?: unknown;
  daily?: unknown;
  pages?: unknown;
  sources?: unknown;
};

export class AnalyticsUnavailable extends Error {
  constructor(
    readonly code: "analytics_unavailable" | "analytics_updating",
    message: string,
  ) {
    super(message);
    this.name = "AnalyticsUnavailable";
  }
}

export function parseRange(raw: unknown): AnalyticsRange {
  const n = typeof raw === "string" ? Number(raw) : raw;
  return (ANALYTICS_RANGES as readonly unknown[]).includes(n) ? (n as AnalyticsRange) : 30;
}

const TZ_CHARS = /^[A-Za-z0-9_+\-/]{1,64}$/;

export function parseTimeZone(raw: unknown): string {
  if (typeof raw !== "string" || !TZ_CHARS.test(raw)) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: raw });
    return raw;
  } catch {
    return "UTC";
  }
}

export function localDate(at: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

function offsetMs(at: Date, tz: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

const QUARTER_HOUR_MS = 15 * 60 * 1000;

export function zonedMidnight(date: string, tz: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d);
  let at = guess - offsetMs(new Date(guess), tz);
  at = guess - offsetMs(new Date(at), tz);
  for (let i = 0; i < 16 && localDate(new Date(at), tz) < date; i++) at += QUARTER_HOUR_MS;
  for (let i = 0; i < 16 && localDate(new Date(at - QUARTER_HOUR_MS), tz) === date; i++) at -= QUARTER_HOUR_MS;
  return new Date(at);
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function analyticsWindow(now: Date, days: AnalyticsRange, tz: string): SubmissionWindow & { from: string; to: string } {
  const to = localDate(now, tz);
  const from = addDays(to, -(days - 1));
  return {
    from,
    to,
    since: zonedMidnight(from, tz),
    until: zonedMidnight(addDays(to, 1), tz),
    prevSince: zonedMidnight(addDays(from, -days), tz),
    tz,
  };
}

export function collectionLabel(name: string): string {
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : name;
}

export function shapeAnalytics(rows: SubmissionStatRow[], w: { from: string; to: string; tz: string }, days: AnalyticsRange): SiteAnalytics {
  const perDay = new Map<string, number>();
  const forms = new Map<string, SiteAnalytics["forms"][number]>();
  const form = (r: SubmissionStatRow) => {
    let f = forms.get(r.collection);
    if (!f) {
      f = {
        collection: r.collection,
        label: collectionLabel(r.collection),
        kind: r.viaAction || isBookingCollection(r.collection) ? "booking" : "form",
        count: 0,
        previous: 0,
        all_time: 0,
        last_at: null,
      };
      forms.set(r.collection, f);
    }
    return f;
  };
  for (const r of rows) {
    const f = form(r);
    if (r.day) {
      if (r.day < w.from || r.day > w.to) continue;
      const n = r.n ?? 0;
      f.count += n;
      perDay.set(r.day, (perDay.get(r.day) ?? 0) + n);
    } else {
      f.previous = r.prevN ?? 0;
      f.all_time = r.totalN ?? 0;
      f.last_at = r.lastAt;
    }
  }
  const daily: SiteAnalytics["daily"] = [];
  for (let d = w.from; d <= w.to; d = addDays(d, 1)) daily.push({ day: d, count: perDay.get(d) ?? 0 });
  const list = [...forms.values()].sort((a, b) => b.count - a.count || b.all_time - a.all_time || a.label.localeCompare(b.label));
  return {
    state: "ready",
    traffic: shapeTraffic({}, w, 0),
    range: { days, tz: w.tz, from: w.from, to: w.to },
    total: list.reduce((s, f) => s + f.count, 0),
    previous_total: list.reduce((s, f) => s + f.previous, 0),
    all_time: list.reduce((s, f) => s + f.all_time, 0),
    daily,
    forms: list,
  };
}

const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : Number(v) >= 0 ? Math.floor(Number(v)) : 0);
const list = (v: unknown) => (Array.isArray(v) ? (v as Array<Record<string, unknown>>) : []);

export function shapeTraffic(raw: TrafficStats, w: { from: string; to: string }, submissions: number): SiteTraffic {
  const byDay = new Map(list(raw.daily).map((d) => [String(d.day), { visits: count(d.visits), pageviews: count(d.pageviews) }]));
  const daily: SiteTraffic["daily"] = [];
  for (let d = w.from; d <= w.to; d = addDays(d, 1)) daily.push({ day: d, ...(byDay.get(d) ?? { visits: 0, pageviews: 0 }) });
  const visits = count(raw.visits);
  return {
    visits,
    previous_visits: count(raw.previous_visits),
    pageviews: count(raw.pageviews),
    conversion: visits > 0 ? Math.min(1, submissions / visits) : null,
    daily,
    pages: list(raw.pages).map((p) => ({ path: String(p.path), pageviews: count(p.pageviews), visits: count(p.visits) })),
    sources: list(raw.sources).map((x) => ({ source: typeof x.source === "string" && x.source ? x.source : null, visits: count(x.visits) })),
  };
}

export function emptyAnalytics(w: { from: string; to: string; tz: string }, days: AnalyticsRange): SiteAnalytics {
  return { ...shapeAnalytics([], w, days), state: "no_database" };
}

export type SiteAnalyticsDeps = {
  directory: () => SiteAuthDirectory;
  traffic: (tenant_id: string, site_id: string, w: SubmissionWindow) => Promise<TrafficStats>;
  now: () => Date;
  requestSchema: (shardRef: string, version: string) => void;
};

function isMissingFunction(e: unknown): boolean {
  const err = e as { code?: unknown; message?: unknown };
  return err?.code === "42883" || (typeof err?.message === "string" && /site_submission_stats.*does not exist/.test(err.message));
}

const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; value: SiteAnalytics }>();
const inFlight = new Map<string, Promise<SiteAnalytics>>();

export function resetAnalyticsCache(): void {
  cache.clear();
  inFlight.clear();
}

export async function siteAnalytics(
  deps: SiteAnalyticsDeps,
  site: AnalyticsSite,
  days: AnalyticsRange,
  tz: string,
): Promise<SiteAnalytics> {
  try {
    return await readAnalytics(deps, site, days, tz);
  } catch (e) {
    if (tz !== "UTC" && /invalid_timezone/.test(String((e as Error)?.message ?? ""))) return readAnalytics(deps, site, days, "UTC");
    throw e;
  }
}

type AnalyticsSite = Pick<SiteRow, "id" | "tenant_id" | "backend_mode" | "shard_id" | "kernel_shard_id">;

async function readAnalytics(deps: SiteAnalyticsDeps, site: AnalyticsSite, days: AnalyticsRange, tz: string): Promise<SiteAnalytics> {
  const now = deps.now();
  const w = analyticsWindow(now, days, tz);
  const key = `${site.tenant_id}:${site.id}:${days}:${tz}:${w.to}`;
  const hit = cache.get(key);
  if (hit && now.getTime() - hit.at < CACHE_MS) return hit.value;
  const running = inFlight.get(key);
  if (running) return running;

  const p = (async () => {
    const [submissions, traffic] = await Promise.all([readSubmissions(deps, site, w, days), deps.traffic(site.tenant_id, site.id, w)]);
    const value: SiteAnalytics = { ...submissions, traffic: shapeTraffic(traffic, w, submissions.total) };
    if (cache.size >= 1000) cache.clear();
    cache.set(key, { at: deps.now().getTime(), value });
    return value;
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

async function readSubmissions(
  deps: SiteAnalyticsDeps,
  site: AnalyticsSite,
  w: ReturnType<typeof analyticsWindow>,
  days: AnalyticsRange,
): Promise<SiteAnalytics> {
  const hasDatabase = (site.backend_mode === "pooled" && !!site.shard_id) || (site.backend_mode === "dedicated" && !!site.kernel_shard_id);
  if (!hasDatabase) return emptyAnalytics(w, days);
  {
    const directory = deps.directory();
    const record = await directory.site(site.id);
    if (!record) throw new AnalyticsUnavailable("analytics_unavailable", "Couldn't reach your site's database. Try again in a moment.");
    const handle = await directory.shard(record.shardId);
    if (!handle) throw new AnalyticsUnavailable("analytics_unavailable", "Couldn't reach your site's database. Try again in a moment.");
    let rows: SubmissionStatRow[];
    try {
      rows = await handle.store.submissionStats(site.id, w);
    } catch (e) {
      if (isMissingFunction(e)) {
        deps.requestSchema(record.shardId, SUBMISSION_STATS_SCHEMA);
        throw new AnalyticsUnavailable("analytics_updating", "Analytics are being set up for your site. Check back in a few minutes.");
      }
      throw e;
    }
    return shapeAnalytics(rows, w, days);
  }
}

export async function readTrafficStats(tenant_id: string, site_id: string, w: SubmissionWindow): Promise<TrafficStats> {
  const { data, error } = await tenantRpc(asTenantId(tenant_id), "site_traffic_stats", {
    p_site_id: site_id,
    p_since: w.since.toISOString(),
    p_until: w.until.toISOString(),
    p_prev_since: w.prevSince.toISOString(),
    p_tz: w.tz,
  });
  if (error) throw new Error(`site_traffic_stats: ${error.message}`);
  return (data ?? {}) as TrafficStats;
}
