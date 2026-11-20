
import { METRIC_CATALOG, type CatalogMetricMeta } from "@/services/analytics/metric-registry";
import { aggregate, catalogEntry, type FetchResult, type MetricFetchCtx, type MetricImpl } from "@/services/analytics/metric-catalog";
import { addDays, daysBetween, localDateOf, type LocalDate, type ResolvedWindow } from "@/services/analytics/metric-time";
import {
  ANOMALY_TRAILING_WEEKS,
  MIN_PRIOR_POINTS,
  detectAnomaly,
  isBadMove,
  severityOf,
  unusualWords,
  type AnomalyPoint,
  type MetricAnomalyWake,
} from "@/services/analytics/anomaly";
import { explainChange, type Driver, type ExplainResult } from "@/services/analytics/explain-change";
import { sendIncidentAlert, renderIncidentEmail, type AlertChannel, type IncidentAlert, type SymptomKind } from "@/services/analytics/anomaly-alert";
import { webBaseUrl } from "@/services/web-base";

export const WATCHED_METRICS = [
  "net_revenue",
  "new_customers",
  "signups",
  "bookings",
  "sessions",
  "key_events",
  "conversion_rate",
  "search_clicks",
  "meta_conversions",
  "meta_cpa",
  "meta_ad_spend",
  "google_conversions",
  "google_cpa",
  "google_ad_spend",
] as const;
export type WatchedMetric = (typeof WATCHED_METRICS)[number];

export type Family = "acquisition" | "conversion" | "ads_meta" | "ads_google" | "revenue" | "tracking";

export const FAMILY_OF: Record<WatchedMetric, Exclude<Family, "tracking">> = {
  sessions: "acquisition",
  search_clicks: "acquisition",
  key_events: "conversion",
  conversion_rate: "conversion",
  signups: "conversion",
  meta_conversions: "ads_meta",
  meta_cpa: "ads_meta",
  meta_ad_spend: "ads_meta",
  google_conversions: "ads_google",
  google_cpa: "ads_google",
  google_ad_spend: "ads_google",
  net_revenue: "revenue",
  new_customers: "revenue",
  bookings: "revenue",
};

export const ALERT_SEVERITY = 3;
export const WORSEN_STEP = 1;
export const RECOVER_AFTER = 2;
const READ_FAILED_SEVERITY = ALERT_SEVERITY;
const ZERO_SEVERITY = 10;

export const SETTLE_DAYS: Record<CatalogMetricMeta["source"], number> = {
  stripe: 0,
  operator_db: 0,
  google_analytics: 1,
  meta_ads: 3,
  google_ads: 3,
  derived: 1,
  google_search_console: 3,
};

export const METRIC_SETTLE_DAYS: Readonly<Record<string, number>> = {
  meta_ad_spend: 0,
  google_ad_spend: 0,
};

const SOURCE_WORDS: Record<CatalogMetricMeta["source"], string> = {
  stripe: "Stripe",
  operator_db: "your database",
  google_analytics: "Google Analytics",
  meta_ads: "Meta Ads",
  google_ads: "Google Ads",
  google_search_console: "Search Console",
  derived: "your ad and revenue data",
};

export function watchDirection(meta: CatalogMetricMeta): "up" | "down" {
  if (meta.direction === "context") return "down";
  return meta.direction;
}

export function watchedConnectorSlugs(): string[] {
  const s = new Set<string>();
  for (const id of WATCHED_METRICS) {
    const m = METRIC_CATALOG[id];
    if (!m) continue;
    for (const c of [...m.needs, ...(m.needs_any ?? [])]) s.add(c);
  }
  return [...s];
}

export function hasConnectors(meta: CatalogMetricMeta, slugs: ReadonlySet<string>): boolean {
  if (!meta.needs.every((n) => slugs.has(n))) return false;
  return !meta.needs_any || meta.needs_any.some((n) => slugs.has(n));
}

export function watchWindow(meta: CatalogMetricMeta, now: Date, tz: string): ResolvedWindow {
  const settle = METRIC_SETTLE_DAYS[meta.id] ?? SETTLE_DAYS[meta.source] ?? 1;
  const until = addDays(localDateOf(now, tz), -1 - settle);
  return { since: addDays(until, -7 * ANOMALY_TRAILING_WEEKS), until, tz, notes: [] };
}

export type Signal = {
  key: string;
  family: Family;
  kind: SymptomKind;
  metric_id: string | null;
  label: string;
  unit: CatalogMetricMeta["unit"];
  currency: string | null;
  date: LocalDate;
  direction: "up" | "down";
  bad: boolean;
  severity: number;
  z: number | null;
  weekday_z: number | null;
  value: number | null;
  typical: number | null;
};

export type Observation = {
  signals: Signal[];
  observed: Set<Family>;
  observedKeys?: Set<string>;
};

export function isZeroCollapse(series: AnomalyPoint[], date: LocalDate): boolean {
  const today = series.find((p) => p.date === date);
  if (!today || today.value !== 0) return false;
  const since = addDays(date, -7 * ANOMALY_TRAILING_WEEKS);
  const same = series.filter((p) => p.date >= since && p.date < date && (daysBetween(p.date, date) - 1) % 7 === 0 && p.value !== null);
  return same.length >= MIN_PRIOR_POINTS && same.every((p) => (p.value as number) > 0);
}

export async function findSignals(
  tenant_id: string,
  slugs: ReadonlySet<string>,
  tz: string,
  now: Date,
  deps: Pick<WatchDeps, "fetch">,
): Promise<Observation> {
  const signals: Signal[] = [];
  const observed = new Set<Family>();
  const observedKeys = new Set<string>();
  const failedSources = new Set<string>();
  const cache = new Map<MetricImpl["fetch"], Map<string, Promise<FetchResult>>>();
  for (const id of WATCHED_METRICS) {
    const entry = catalogEntry(id);
    if (!entry || entry.meta.point_in_time) continue;
    const { meta, impl } = entry;
    if (!hasConnectors(meta, slugs)) continue;
    const w = watchWindow(meta, now, tz);
    const ctx: MetricFetchCtx = { tenant_id, tz, now, grain: "day", gateway: { tenant_id, caller: { kind: "background", feature: "Anomaly watch" } } };
    const key = `${w.since}:${w.until}`;
    const byWindow = cache.get(impl.fetch) ?? new Map<string, Promise<FetchResult>>();
    cache.set(impl.fetch, byWindow);
    let p = byWindow.get(key);
    if (!p) {
      p = deps.fetch(id, ctx, w).catch((e): FetchResult => ({ ok: false, reason: "read_failed", message: (e as Error).message }));
      byWindow.set(key, p);
    }
    const f = await p;
    if (!f.ok) {
      if (f.reason === "read_failed" && !failedSources.has(meta.source)) {
        failedSources.add(meta.source);
        signals.push({
          key: `read_failed:${meta.source}`,
          family: "tracking",
          kind: "read_failed",
          metric_id: null,
          label: SOURCE_WORDS[meta.source],
          unit: meta.unit,
          currency: null,
          date: w.until,
          direction: "down",
          bad: true,
          severity: READ_FAILED_SEVERITY,
          z: null,
          weekday_z: null,
          value: null,
          typical: null,
        });
      }
      continue;
    }
    const family = FAMILY_OF[id];
    observed.add(family);
    observed.add("tracking");
    observedKeys.add(`read_failed:${meta.source}`);
    const series: AnomalyPoint[] = aggregate(meta, impl, f, w, "day").series.map((s) => ({ date: s.start, value: s.value }));
    const settled = series.find((p) => p.date === w.until)?.value;
    if (settled !== null && settled !== undefined && Number.isFinite(settled)) observedKeys.add(id);
    const base = { metric_id: id, label: meta.label, unit: meta.unit, currency: f.currency, date: w.until };

    if ((meta.unit === "count" || meta.unit === "currency") && isZeroCollapse(series, w.until)) {
      signals.push({ ...base, key: id, family: "tracking", kind: "zero", direction: "down", bad: true, severity: ZERO_SEVERITY, z: null, weekday_z: null, value: 0, typical: null });
      continue;
    }
    const v = detectAnomaly(series, { kind: "daily", isCount: meta.unit === "count", date: w.until });
    if (!v.anomaly) continue;
    signals.push({
      ...base,
      key: id,
      family,
      kind: "anomaly",
      direction: v.direction,
      bad: isBadMove(watchDirection(meta), v.direction) === true,
      severity: severityOf(v.z, v.weekday_z),
      z: v.z,
      weekday_z: v.weekday_z,
      value: v.value,
      typical: v.typical,
    });
  }
  return { signals, observed, observedKeys };
}

export function minorMoves(signals: Signal[]): Signal[] {
  return signals.filter((s) => s.kind === "anomaly" && (!s.bad || s.severity < ALERT_SEVERITY));
}

export type ActiveIncident = {
  id: string;
  family: Family;
  status: "open" | "worsened";
  primary_key: string;
  severity: number;
  notice_severity: number | null;
  notices: number;
  normal_streak: number;
  last_eval_on: LocalDate;
  pending_notice: boolean;
  signals: Signal[];
};

export type IncidentAction =
  | { kind: "open"; family: Family; primary: Signal; supporting: Signal[] }
  | { kind: "worsen"; id: string; family: Family; primary: Signal; supporting: Signal[] }
  | { kind: "update"; id: string; family: Family; primary: Signal; supporting: Signal[] }
  | { kind: "hold"; id: string; family: Family }
  | { kind: "normal"; id: string; family: Family; normal_streak: number; recover: boolean }
  | { kind: "retry_notice"; id: string; family: Family };

export function planIncidents(active: ActiveIncident[], obs: Observation, today: LocalDate): IncidentAction[] {
  const out: IncidentAction[] = [];
  const byFamily = new Map<Family, Signal[]>();
  for (const s of obs.signals) {
    if (!s.bad || s.severity < ALERT_SEVERITY) continue;
    byFamily.set(s.family, [...(byFamily.get(s.family) ?? []), s]);
  }
  const activeBy = new Map(active.map((a) => [a.family, a]));

  for (const [family, sigs] of byFamily) {
    const sorted = [...sigs].sort((a, b) => b.severity - a.severity);
    const primary = sorted[0];
    const extra = obs.signals.filter((s) => s.family === family && s.bad && s.severity < ALERT_SEVERITY);
    const supporting = [...sorted.slice(1), ...extra];
    const inc = activeBy.get(family);
    if (!inc) {
      out.push({ kind: "open", family, primary, supporting });
      continue;
    }
    if (inc.last_eval_on === today) {
      if (inc.pending_notice) out.push({ kind: "retry_notice", id: inc.id, family });
      continue;
    }
    const told = inc.notice_severity ?? inc.severity;
    const worse = primary.severity >= told + WORSEN_STEP;
    out.push({ kind: worse ? "worsen" : "update", id: inc.id, family, primary, supporting });
    if (!worse && inc.pending_notice) out.push({ kind: "retry_notice", id: inc.id, family });
  }

  for (const inc of active) {
    if (byFamily.has(inc.family)) continue;
    if (inc.last_eval_on === today) {
      if (inc.pending_notice) out.push({ kind: "retry_notice", id: inc.id, family: inc.family });
      continue;
    }
    const badHere = obs.signals.some((s) => s.family === inc.family && s.bad);
    const primaryMeasured = obs.observedKeys ? obs.observedKeys.has(inc.primary_key) : obs.observed.has(inc.family);
    if (badHere || !obs.observed.has(inc.family) || !primaryMeasured) {
      out.push({ kind: "hold", id: inc.id, family: inc.family });
      if (inc.pending_notice) out.push({ kind: "retry_notice", id: inc.id, family: inc.family });
      continue;
    }
    const streak = inc.normal_streak + 1;
    const recover = streak >= RECOVER_AFTER;
    out.push({ kind: "normal", id: inc.id, family: inc.family, normal_streak: streak, recover });
    if (!recover && inc.pending_notice) out.push({ kind: "retry_notice", id: inc.id, family: inc.family });
  }
  return out;
}

export type WakeOutcome = { enqueued: true; run_id: string } | { enqueued: false; skipped: string };
export type AlertsMode = "shadow" | "on";

export type IncidentPatch = Partial<{
  status: "open" | "worsened" | "recovered";
  primary_key: string;
  severity: number;
  signals: Signal[];
  last_eval_on: LocalDate;
  normal_streak: number;
  recovered_on: LocalDate | null;
  notice_severity: number;
  notices: number;
  pending_notice: boolean;
  last_notice_mode: "shadow" | "on" | "muted";
  last_message_subject: string;
  last_message_text: string;
  last_channel: AlertChannel | "failed";
  wake_run_id: string | null;
  wake_status: string;
  updated_at: string;
}>;

export type NewIncident = {
  family: Family;
  status: "open";
  primary_key: string;
  severity: number;
  signals: Signal[];
  opened_on: LocalDate;
  last_eval_on: LocalDate;
  pending_notice: boolean;
};

export type WatchDeps = {
  resolveTz: (tenant_id: string) => Promise<string>;
  fetch: (metric_id: string, ctx: MetricFetchCtx, w: ResolvedWindow) => Promise<FetchResult>;
  explain: (tenant_id: string, tz: string, now: Date, s: Signal) => Promise<ExplainResult>;
  loadActive: (tenant_id: string) => Promise<ActiveIncident[]>;
  insertIncident: (tenant_id: string, row: NewIncident) => Promise<ActiveIncident | null>;
  updateIncident: (tenant_id: string, id: string, patch: IncidentPatch) => Promise<void>;
  recordMoves: (tenant_id: string, moves: Signal[]) => Promise<void>;
  mode: () => Promise<AlertsMode>;
  mutedKeys: (tenant_id: string) => Promise<Set<string>>;
  wake: (tenant_id: string, anomaly: MetricAnomalyWake, now: Date) => Promise<WakeOutcome>;
  send: (alert: IncidentAlert) => Promise<AlertChannel>;
  companyName: (tenant_id: string) => Promise<string>;
  workspaceUrl: (tenant_id: string) => string;
  muteUrl: (tenant_id: string, key: string) => string;
};

export function contributorsFor(s: Pick<Signal, "direction">, e: ExplainResult): Driver[] {
  if (e.status !== "ok" || !("drivers" in e) || e.change === null || e.change === 0) return [];
  if ((e.change > 0 ? "up" : "down") !== s.direction) return [];
  return e.drivers;
}

export type NoticeOutcome = { mode: "shadow" | "on" | "muted"; channel: AlertChannel | "failed" | null; woke: boolean };

export async function deliverNotice(
  tenant_id: string,
  inc: ActiveIncident,
  tz: string,
  now: Date,
  deps: WatchDeps,
): Promise<NoticeOutcome> {
  const primary = inc.signals.find((s) => s.key === inc.primary_key) ?? inc.signals[0];
  const supporting = inc.signals.filter((s) => s !== primary);
  const opening = inc.notices === 0;
  const [mode, muted] = await Promise.all([deps.mode(), deps.mutedKeys(tenant_id)]);
  const isMuted = muted.has("*") || muted.has(inc.primary_key);
  const explained =
    primary.kind === "anomaly" ? await deps.explain(tenant_id, tz, now, primary).catch((): ExplainResult => ({ status: "read_failed", metric_id: primary.key, message: "", caveats: [] })) : null;
  const contributors = explained ? contributorsFor(primary, explained) : [];

  let woke = false;
  let wake_status = "none";
  let wake_run_id: string | null = null;
  let wakeWrite = false;
  const live = mode === "on" && !isMuted;
  if (live && opening) {
    const wakeInfo: MetricAnomalyWake = {
      incident_id: inc.id,
      family: inc.family,
      metric_id: primary.key,
      label: primary.label,
      date: primary.date,
      direction: primary.direction,
      value: primary.value,
      typical: primary.typical,
      how_unusual: unusualWords(primary.severity),
      supporting: supporting.map((s) => ({ metric_id: s.key, label: s.label, direction: s.direction, value: s.value, typical: s.typical })),
      contributors: contributors.map((d) => ({ dimension: d.dimension, segment: d.segment, share_pct: d.share_pct, confidence: d.confidence })),
    };
    const w = await deps.wake(tenant_id, wakeInfo, now).catch((e): WakeOutcome => ({ enqueued: false, skipped: `failed:${(e as Error).message}`.slice(0, 60) }));
    woke = w.enqueued;
    wake_status = w.enqueued ? "enqueued" : `skipped:${w.skipped}`.slice(0, 64);
    wake_run_id = w.enqueued ? w.run_id : null;
    wakeWrite = !(!w.enqueued && w.skipped === "duplicate");
  }

  const alert: IncidentAlert = {
    tenant_id,
    incident_id: inc.id,
    notice_seq: inc.notices + 1,
    companyName: await deps.companyName(tenant_id).catch(() => "Your company"),
    kind: opening ? "opened" : "worsened",
    primary: {
      kind: primary.kind,
      label: primary.label,
      unit: primary.unit,
      currency: primary.currency,
      date: primary.date,
      direction: primary.direction,
      value: primary.value,
      typical: primary.typical,
      severity: primary.severity,
    },
    supporting: supporting.map((s) => ({ label: s.label, unit: s.unit, currency: s.currency, direction: s.direction, value: s.value, typical: s.typical })),
    contributors: contributors.map((d) => ({ dimension: d.dimension, segment: d.segment, share_pct: d.share_pct, confidence: d.confidence })),
    woke,
    workspaceUrl: deps.workspaceUrl(tenant_id),
    muteUrl: deps.muteUrl(tenant_id, inc.primary_key),
  };

  let channel: AlertChannel | "failed" | null = null;
  if (live) {
    try {
      channel = await deps.send(alert);
    } catch (e) {
      channel = "failed";
      console.warn(`[anomaly-watch] notice for incident ${inc.id} (tenant ${tenant_id}) failed: ${(e as Error).message}`);
    }
  }
  const copy = renderIncidentEmail(alert);
  const noticeMode: NoticeOutcome["mode"] = mode !== "on" ? "shadow" : isMuted ? "muted" : "on";
  if (live && channel !== "slack" && channel !== "email") {
    await deps.updateIncident(tenant_id, inc.id, {
      last_channel: channel ?? "failed",
      ...(wakeWrite ? { wake_status, wake_run_id } : {}),
      updated_at: now.toISOString(),
    });
    return { mode: noticeMode, channel, woke };
  }
  await deps.updateIncident(tenant_id, inc.id, {
    pending_notice: false,
    notices: inc.notices + 1,
    notice_severity: primary.severity,
    last_notice_mode: noticeMode,
    last_message_subject: copy.subject.slice(0, 300),
    last_message_text: copy.text.slice(0, 4000),
    ...(channel ? { last_channel: channel } : {}),
    ...(wakeWrite ? { wake_status, wake_run_id } : {}),
    updated_at: now.toISOString(),
  });
  return { mode: noticeMode, channel, woke };
}

export type TenantWatchResult = {
  signals: number;
  moves: number;
  opened: number;
  worsened: number;
  recovered: number;
  notices: number;
  sent: number;
  woke: number;
  errors: number;
};

export async function watchTenant(
  tenant_id: string,
  slugs: ReadonlySet<string>,
  now: Date,
  deps: WatchDeps = realWatchDeps,
  find: typeof findSignals = findSignals,
): Promise<TenantWatchResult> {
  const out: TenantWatchResult = { signals: 0, moves: 0, opened: 0, worsened: 0, recovered: 0, notices: 0, sent: 0, woke: 0, errors: 0 };
  const tz = await deps.resolveTz(tenant_id).catch(() => "UTC");
  const today = localDateOf(now, tz);
  const obs = await find(tenant_id, slugs, tz, now, deps);
  out.signals = obs.signals.length;

  const moves = minorMoves(obs.signals);
  if (moves.length) {
    try {
      await deps.recordMoves(tenant_id, moves);
      out.moves = moves.length;
    } catch (e) {
      out.errors += 1;
      console.warn(`[anomaly-watch] recording moves (tenant ${tenant_id}) failed: ${(e as Error).message}`);
    }
  }

  const active = await deps.loadActive(tenant_id);
  const byId = new Map(active.map((a) => [a.id, a]));
  const notify = async (inc: ActiveIncident) => {
    const r = await deliverNotice(tenant_id, inc, tz, now, deps);
    out.notices += 1;
    if (r.channel === "slack" || r.channel === "email") out.sent += 1;
    if (r.woke) out.woke += 1;
  };

  for (const a of planIncidents(active, obs, today)) {
    try {
      if (a.kind === "open") {
        const inc = await deps.insertIncident(tenant_id, {
          family: a.family,
          status: "open",
          primary_key: a.primary.key,
          severity: a.primary.severity,
          signals: [a.primary, ...a.supporting],
          opened_on: today,
          last_eval_on: today,
          pending_notice: true,
        });
        if (!inc) continue;
        out.opened += 1;
        await notify(inc);
      } else if (a.kind === "worsen" || a.kind === "update") {
        const patch: IncidentPatch = {
          primary_key: a.primary.key,
          severity: a.primary.severity,
          signals: [a.primary, ...a.supporting],
          last_eval_on: today,
          normal_streak: 0,
          updated_at: now.toISOString(),
          ...(a.kind === "worsen" ? { status: "worsened" as const, pending_notice: true } : {}),
        };
        await deps.updateIncident(tenant_id, a.id, patch);
        const prevRow = byId.get(a.id);
        if (prevRow) byId.set(a.id, { ...prevRow, signals: patch.signals!, primary_key: a.primary.key, severity: a.primary.severity });
        if (a.kind === "worsen") {
          out.worsened += 1;
          const prev = byId.get(a.id)!;
          await notify({ ...prev, ...patch, status: "worsened", signals: patch.signals!, primary_key: a.primary.key, severity: a.primary.severity } as ActiveIncident);
        }
      } else if (a.kind === "hold") {
        await deps.updateIncident(tenant_id, a.id, { last_eval_on: today, normal_streak: 0, updated_at: now.toISOString() });
      } else if (a.kind === "normal") {
        await deps.updateIncident(tenant_id, a.id, {
          last_eval_on: today,
          normal_streak: a.normal_streak,
          updated_at: now.toISOString(),
          ...(a.recover ? { status: "recovered" as const, recovered_on: today, pending_notice: false } : {}),
        });
        if (a.recover) out.recovered += 1;
      } else if (a.kind === "retry_notice") {
        await notify(byId.get(a.id)!);
      }
    } catch (e) {
      out.errors += 1;
      console.warn(`[anomaly-watch] ${a.kind} ${a.family} (tenant ${tenant_id}) threw: ${(e as Error).message}`);
    }
  }
  return out;
}

async function db(tenant_id: string) {
  const { asTenantId, tenantClient } = await import("@/services/tenant-client");
  return tenantClient(asTenantId(tenant_id));
}

const ACTIVE_COLS = "id, family, status, primary_key, severity, notice_severity, notices, normal_streak, last_eval_on, pending_notice, signals";

function toActive(r: Record<string, unknown>): ActiveIncident {
  return {
    id: String(r.id),
    family: r.family as Family,
    status: r.status as "open" | "worsened",
    primary_key: String(r.primary_key),
    severity: Number(r.severity),
    notice_severity: r.notice_severity == null ? null : Number(r.notice_severity),
    notices: Number(r.notices ?? 0),
    normal_streak: Number(r.normal_streak ?? 0),
    last_eval_on: String(r.last_eval_on),
    pending_notice: r.pending_notice === true,
    signals: (Array.isArray(r.signals) ? r.signals : []) as Signal[],
  };
}

export const realWatchDeps: WatchDeps = {
  async resolveTz(tenant_id) {
    const { resolveReportingTimezone } = await import("@/services/analytics/tenant-timezone");
    return (await resolveReportingTimezone(tenant_id)).tz;
  },
  async fetch(metric_id, ctx, w) {
    const entry = catalogEntry(metric_id);
    if (!entry) return { ok: false, reason: "unsupported", message: `${metric_id} has no implementation` };
    return entry.impl.fetch(ctx, w);
  },
  explain(tenant_id, tz, now, s) {
    return explainChange({ tenant_id, tz, now, gateway: { tenant_id, caller: { kind: "background", feature: "Anomaly watch" } } }, { metric_id: s.metric_id ?? s.key, window: { since: s.date, until: s.date }, compare: "previous_week" });
  },
  async loadActive(tenant_id) {
    const { data, error } = await (await db(tenant_id)).from("metric_incidents").select(ACTIVE_COLS).neq("status", "recovered").limit(20);
    if (error) throw new Error(`active incidents read failed: ${error.message}`);
    return ((data ?? []) as Array<Record<string, unknown>>).map(toActive);
  },
  async insertIncident(tenant_id, row) {
    const { data, error } = await (await db(tenant_id)).from("metric_incidents").insert({ ...row }).select(ACTIVE_COLS);
    if (error) {
      if ((error as { code?: string }).code === "23505") return null;
      throw new Error(`incident insert failed: ${error.message}`);
    }
    const r = ((data ?? []) as Array<Record<string, unknown>>)[0];
    return r ? toActive(r) : null;
  },
  async updateIncident(tenant_id, id, patch) {
    const { error } = await (await db(tenant_id)).from("metric_incidents").update(patch).eq("id", id);
    if (error) throw new Error(`incident update failed: ${error.message}`);
  },
  async recordMoves(tenant_id, moves) {
    const rows = moves.map((m) => ({
      metric_id: m.key,
      move_date: m.date,
      direction: m.direction,
      good: !m.bad,
      severity: m.severity,
      value: m.value,
      typical: m.typical,
    }));
    const { error } = await (await db(tenant_id))
      .from("metric_moves")
      .upsert(rows, { onConflict: "tenant_id,metric_id,move_date", ignoreDuplicates: true });
    if (error) throw new Error(`moves insert failed: ${error.message}`);
  },
  async mode() {
    const { getStringSetting } = await import("@/services/settings");
    return (await getStringSetting("anomaly_alerts_mode").catch(() => "shadow")) === "on" ? "on" : "shadow";
  },
  async mutedKeys(tenant_id) {
    const { data, error } = await (await db(tenant_id)).from("metric_alert_mutes").select("mute_key").limit(200);
    if (error) return new Set(["*"]);
    return new Set(((data ?? []) as Array<{ mute_key: string }>).map((r) => r.mute_key));
  },
  async wake(tenant_id, anomaly, now) {
    const { enqueueGoalOwnerRun } = await import("@/services/growth/goal-owner");
    const { isInsufficientCreditsError } = await import("@/services/agents/credits");
    try {
      const r = await enqueueGoalOwnerRun({ tenant_id, reason: "metric_anomaly", anomaly, now });
      return r.enqueued ? { enqueued: true, run_id: r.run_id } : { enqueued: false, skipped: r.skipped };
    } catch (e) {
      const err = e as Error | null;
      if (err?.name === "InsufficientCreditsError" || isInsufficientCreditsError(err)) return { enqueued: false, skipped: "no_credits" };
      throw e;
    }
  },
  send: (alert) => sendIncidentAlert(alert),
  async companyName(tenant_id) {
    const { data } = await (await db(tenant_id)).from("tenants").select("display_name, slug").maybeSingle<{ display_name: string | null; slug: string | null }>();
    return (data?.display_name ?? "").trim() || (data?.slug ?? "").trim() || "Your company";
  },
  workspaceUrl(tenant_id) {
    return `${webBaseUrl()}/workspace?company=${encodeURIComponent(tenant_id)}`;
  },
  muteUrl(tenant_id, key) {
    return `${webBaseUrl()}/workspace?company=${encodeURIComponent(tenant_id)}&mute_alert=${encodeURIComponent(key)}`;
  },
};
