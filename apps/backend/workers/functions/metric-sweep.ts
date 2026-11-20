
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import {
  METRIC_REGISTRY,
  type MetricDef,
} from "@/services/analytics/metric-registry";
import {
  recordMetricSnapshot,
  readMetricHistory,
} from "@/services/analytics/record-metric-snapshot";
import { readTenantStripeMrr } from "@/services/analytics/stripe-mrr";
import { resolveConfirmedOperatorDb } from "@/services/analytics/confirmed-operator-db";
import { resolveReportingTimezone } from "@/services/analytics/tenant-timezone";
import { addDays, localDateOf, localDayStartUtc, startOfWeek } from "@/services/analytics/metric-time";
import type {
  OperatorDbDriver,
  SchemaMap,
  NewUsersInWindowResult,
} from "@/services/tools/operator-db/types";
import type {
  OperatorDbWindowExt,
  CountInRangeResult,
} from "@/services/analytics/operator-db-window-stubs";
import { readMetaSnapshot } from "@/services/growth/action-outcomes";
import { callGoogleAdsTool } from "@/services/mcp/internal/google-ads";
import { metaAdsCreds } from "@/services/tools/meta-ads/_client";
import { fullDaysWindow, lastCompleteDay } from "@/services/tools/ad-window";
import { watchTenant, watchedConnectorSlugs } from "@/services/analytics/anomaly-watch";
import { getBoolSettingStrictResolved } from "@/services/settings";

const MAX_TENANTS_PER_SWEEP = 200;

export const BACKFILL_WEEKS = 12;

const RELEVANT_CONNECTOR_SLUGS = ["operator_db", "meta_ads", "google_ads", "stripe"] as const;

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

export function truncToHourIso(d: Date): string {
  const t = new Date(Math.floor(d.getTime() / MS_PER_HOUR) * MS_PER_HOUR);
  return t.toISOString();
}

export function truncToDayIso(d: Date): string {
  const t = new Date(Math.floor(d.getTime() / MS_PER_DAY) * MS_PER_DAY);
  return t.toISOString();
}

export function rolling7dWindow(now: Date): { window_start: string; window_end: string } {
  const end = Date.parse(truncToHourIso(now));
  return {
    window_start: new Date(end - 7 * MS_PER_DAY).toISOString(),
    window_end: new Date(end).toISOString(),
  };
}

export type CalendarWeek = { window_start: string; window_end: string };

export function lastClosedCalendarWeeks(now: Date, n: number): CalendarWeek[] {
  const dayStart = Math.floor(now.getTime() / MS_PER_DAY) * MS_PER_DAY;
  const daysSinceMonday = (new Date(dayStart).getUTCDay() + 6) % 7;
  const thisWeekMonday = dayStart - daysSinceMonday * MS_PER_DAY;
  const weeks: CalendarWeek[] = [];
  for (let i = n; i >= 1; i--) {
    const start = thisWeekMonday - i * 7 * MS_PER_DAY;
    weeks.push({
      window_start: new Date(start).toISOString(),
      window_end: new Date(start + 7 * MS_PER_DAY).toISOString(),
    });
  }
  return weeks;
}

export function lastClosedCalendarWeeksInTz(now: Date, n: number, tz: string): CalendarWeek[] {
  const thisMonday = startOfWeek(localDateOf(now, tz));
  const weeks: CalendarWeek[] = [];
  for (let i = n; i >= 1; i--) {
    const start = addDays(thisMonday, -7 * i);
    weeks.push({
      window_start: localDayStartUtc(start, tz).toISOString(),
      window_end: localDayStartUtc(addDays(start, 7), tz).toISOString(),
    });
  }
  return weeks;
}

export type MeasureRead =
  | { ok: true; value: number }
  | { ok: false; reason: string };

export type SweepDeps = {
  readOperatorCount7d(
    tenant_id: string,
    kind: "users" | "bookings",
  ): Promise<MeasureRead>;
  readMetaAds7d(
    tenant_id: string,
  ): Promise<{ ok: true; spend: number; conversions: number } | { ok: false; reason: string }>;
  readGoogleAds7d(
    tenant_id: string,
  ): Promise<{ ok: true; spend: number; conversions: number } | { ok: false; reason: string }>;
  readStripeMrr(
    tenant_id: string,
  ): Promise<
    | { ok: true; value: number; meta?: Record<string, unknown> }
    | { ok: false; reason: string }
  >;
  readCountInRange(
    tenant_id: string,
    kind: "users" | "bookings",
    since: string,
    until: string,
  ): Promise<number | null>;
  resolveTimezone?(tenant_id: string): Promise<string>;
};

type ResolvedOperatorDb = {
  driver: OperatorDbDriver & OperatorDbWindowExt;
  cfg: SchemaMap;
  close: () => Promise<void>;
};

async function resolveDb(
  tenant_id: string,
  kind: "users" | "bookings",
): Promise<ResolvedOperatorDb | { error: string }> {
  const db = await resolveConfirmedOperatorDb({ tenant_id, caller: { kind: "background", feature: "Metric sweep" } }, kind);
  if (!db.ok) return { error: db.reason === "needs_confirmation" ? "mapping_not_confirmed" : db.reason };
  return { driver: db.driver, cfg: db.cfg, close: db.close };
}

function errReason(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const code = (e as { code?: unknown })?.code;
  return typeof code === "string" && code.length > 0 ? code : msg.slice(0, 200);
}

export const realSweepDeps: SweepDeps = {
  async readOperatorCount7d(tenant_id, kind) {
    try {
      const db = await resolveDb(tenant_id, kind);
      if ("error" in db) return { ok: false, reason: db.error };
      const { driver, cfg } = db;
      let res: { ok?: boolean; data?: NewUsersInWindowResult };
      try {
        const fn =
          kind === "users"
            ? driver.query_new_users_in_window.bind(driver)
            : driver.query_new_bookings_in_window?.bind(driver);
        if (typeof fn !== "function") {
          return { ok: false, reason: "driver_method_missing_query_new_bookings_in_window" };
        }
        res = (await fn({ window_days: 7 }, cfg)) as { ok?: boolean; data?: NewUsersInWindowResult };
      } finally {
        await db.close();
      }
      if (!res?.ok || !res.data?.available) {
        return { ok: false, reason: res?.data?.reason ?? "not_available" };
      }
      const count = Number(res.data.count);
      if (!Number.isFinite(count)) return { ok: false, reason: "non_numeric_count" };
      return { ok: true, value: count };
    } catch (e) {
      return { ok: false, reason: errReason(e) };
    }
  },

  async readMetaAds7d(tenant_id) {
    try {
      const creds = await metaAdsCreds(tenant_id);
      const until = lastCompleteDay();
      const since = new Date(until.getTime() - 6 * MS_PER_DAY);
      const snap = await readMetaSnapshot(
        tenant_id,
        creds.ad_account_id,
        since.toISOString().slice(0, 10),
        until.toISOString().slice(0, 10),
      );
      if (!snap) return { ok: false, reason: "no_insight_rows_in_window" };
      return {
        ok: true,
        spend: Number(snap.spend ?? 0),
        conversions: Number(snap.conversions ?? 0),
      };
    } catch (e) {
      return { ok: false, reason: errReason(e) };
    }
  },

  async readGoogleAds7d(tenant_id) {
    try {
      const res = await callGoogleAdsTool({ tenant_id }, "list_campaigns", {
        custom_range: fullDaysWindow(7),
        status: "ALL",
      });
      if (!res.ok || res.is_error) {
        return { ok: false, reason: "google_ads_read_failed" };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(res.content);
      } catch {
        return { ok: false, reason: "google_ads_unparseable" };
      }
      const rows = (parsed as { campaigns?: unknown })?.campaigns;
      if (!Array.isArray(rows)) return { ok: false, reason: "google_ads_no_campaigns_field" };
      if (rows.length === 0) return { ok: false, reason: "no_campaign_rows_in_window" };

      let spend = 0;
      let conversions = 0;
      for (const r of rows as Array<Record<string, unknown>>) {
        const s = Number(r.spend_usd ?? 0);
        const c = Number(r.conversions ?? 0);
        if (Number.isFinite(s)) spend += s;
        if (Number.isFinite(c)) conversions += c;
      }
      return { ok: true, spend, conversions };
    } catch (e) {
      return { ok: false, reason: errReason(e) };
    }
  },

  async readStripeMrr(tenant_id) {
    try {
      const res = await readTenantStripeMrr(tenant_id);
      if (!res.available) return { ok: false, reason: res.reason };
      if (res.mrr_usd == null) return { ok: false, reason: `non_usd_currency:${res.currency}` };
      return { ok: true, value: res.mrr_usd, meta: res.meta };
    } catch (e) {
      return { ok: false, reason: errReason(e) };
    }
  },

  async readCountInRange(tenant_id, kind, since, until) {
    try {
      const db = await resolveDb(tenant_id, kind);
      if ("error" in db) return null;
      const { driver, cfg } = db;
      let res: { ok?: boolean; data?: CountInRangeResult };
      try {
        const fn =
          kind === "users"
            ? driver.query_new_users_in_range?.bind(driver)
            : driver.query_new_bookings_in_range?.bind(driver);
        if (typeof fn !== "function") return null;
        res = (await fn({ since, until }, cfg)) as { ok?: boolean; data?: CountInRangeResult };
      } finally {
        await db.close();
      }
      if (!res?.ok || !res.data?.available) return null;
      const count = Number(res.data.count);
      return Number.isFinite(count) ? count : null;
    } catch {
      return null;
    }
  },

  async resolveTimezone(tenant_id) {
    return (await resolveReportingTimezone(tenant_id)).tz;
  },
};

type SweepLogger = {
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

export type TenantSweepResult = {
  measured: number;
  unavailable: number;
  backfilled_rows: number;
  errors: number;
};

export async function sweepTenantMetrics(
  tenant_id: string,
  connectorSlugs: ReadonlySet<string>,
  now: Date,
  deps: SweepDeps,
  logger: SweepLogger,
): Promise<TenantSweepResult> {
  const out: TenantSweepResult = {
    measured: 0,
    unavailable: 0,
    backfilled_rows: 0,
    errors: 0,
  };

  let metaRead: Awaited<ReturnType<SweepDeps["readMetaAds7d"]>> | null = null;
  const getMetaRead = async () => {
    if (metaRead == null) metaRead = await deps.readMetaAds7d(tenant_id);
    return metaRead;
  };
  let googleRead: Awaited<ReturnType<SweepDeps["readGoogleAds7d"]>> | null = null;
  const getGoogleRead = async () => {
    if (googleRead == null) googleRead = await deps.readGoogleAds7d(tenant_id);
    return googleRead;
  };

  for (const def of Object.values(METRIC_REGISTRY)) {
    if (!connectorSlugs.has(def.source)) continue;
    try {
      const window =
        def.window_kind === "point"
          ? { window_start: undefined as string | undefined, window_end: truncToDayIso(now) }
          : rolling7dWindow(now);

      const read = await measureOne(def, tenant_id, deps, getMetaRead, getGoogleRead);
      if (read.ok) {
        out.measured += 1;
        await recordMetricSnapshot({
          tenant_id,
          metric_key: def.key,
          value: read.value,
          status: "measured",
          source: def.source,
          window_kind: def.window_kind,
          window_start: window.window_start,
          window_end: window.window_end,
          meta: read.meta,
        });
      } else {
        out.unavailable += 1;
        await recordMetricSnapshot({
          tenant_id,
          metric_key: def.key,
          value: null,
          status: "unavailable",
          source: def.source,
          window_kind: def.window_kind,
          window_start: window.window_start,
          window_end: window.window_end,
          meta: { reason: read.reason },
        });
      }
    } catch (e) {
      out.errors += 1;
      logger.warn(
        `[metric-sweep] metric ${def.key} (tenant ${tenant_id}) threw: ${(e as Error).message}`,
      );
    }
  }

  if (connectorSlugs.has("operator_db")) {
    try {
      out.backfilled_rows += await backfillClosedWeeks(tenant_id, now, deps, logger);
    } catch (e) {
      out.errors += 1;
      logger.warn(
        `[metric-sweep] backfill (tenant ${tenant_id}) threw: ${(e as Error).message}`,
      );
    }
  }

  return out;
}

type MeasureOneResult =
  | { ok: true; value: number; meta?: Record<string, unknown> }
  | { ok: false; reason: string };

async function measureOne(
  def: MetricDef,
  tenant_id: string,
  deps: SweepDeps,
  getMetaRead: () => Promise<Awaited<ReturnType<SweepDeps["readMetaAds7d"]>>>,
  getGoogleRead: () => Promise<Awaited<ReturnType<SweepDeps["readGoogleAds7d"]>>>,
): Promise<MeasureOneResult> {
  switch (def.key) {
    case "weekly_signups": {
      return deps.readOperatorCount7d(tenant_id, "users");
    }
    case "weekly_bookings": {
      return deps.readOperatorCount7d(tenant_id, "bookings");
    }
    case "ads_spend_7d": {
      const m = await getMetaRead();
      if (!m.ok) return m;
      return { ok: true, value: m.spend };
    }
    case "ads_cpa_7d": {
      const m = await getMetaRead();
      if (!m.ok) return m;
      if (!(m.conversions > 0)) return { ok: false, reason: "no_conversions_in_window" };
      return {
        ok: true,
        value: Math.round((m.spend / m.conversions) * 100) / 100,
        meta: { spend: m.spend, conversions: m.conversions },
      };
    }
    case "google_ads_spend_7d": {
      const g = await getGoogleRead();
      if (!g.ok) return g;
      return { ok: true, value: g.spend };
    }
    case "google_ads_cpa_7d": {
      const g = await getGoogleRead();
      if (!g.ok) return g;
      if (!(g.conversions > 0)) return { ok: false, reason: "no_conversions_in_window" };
      return {
        ok: true,
        value: Math.round((g.spend / g.conversions) * 100) / 100,
        meta: { spend: g.spend, conversions: g.conversions },
      };
    }
    case "stripe_mrr": {
      return deps.readStripeMrr(tenant_id);
    }
    default: {
      return { ok: false, reason: `unmeasurable_metric_${def.key}` };
    }
  }
}

export async function backfillClosedWeeks(
  tenant_id: string,
  now: Date,
  deps: SweepDeps,
  logger: SweepLogger,
): Promise<number> {
  let rows = 0;
  const targets: Array<{ key: "weekly_signups" | "weekly_bookings"; kind: "users" | "bookings" }> = [
    { key: "weekly_signups", kind: "users" },
    { key: "weekly_bookings", kind: "bookings" },
  ];

  let tz: string | null = null;
  const tenantTz = async (): Promise<string> => {
    if (tz === null) {
      tz = deps.resolveTimezone ? await deps.resolveTimezone(tenant_id).catch(() => "UTC") : "UTC";
    }
    return tz;
  };

  for (const t of targets) {
    const history = await readMetricHistory(tenant_id, t.key, {
      window_kind: "calendar_week",
      limit: 1,
    });
    if (history.length > 0) continue;

    const weeks = lastClosedCalendarWeeksInTz(now, BACKFILL_WEEKS, await tenantTz());
    for (const week of weeks) {
      const count = await deps.readCountInRange(
        tenant_id,
        t.kind,
        week.window_start,
        week.window_end,
      );
      if (count == null) {
        logger.warn(
          `[metric-sweep] backfill ${t.key} (tenant ${tenant_id}): explicit-range read unavailable — skipped`,
        );
        break;
      }
      await recordMetricSnapshot({
        tenant_id,
        metric_key: t.key,
        value: count,
        status: "measured",
        source: "operator_db",
        window_kind: "calendar_week",
        window_start: week.window_start,
        window_end: week.window_end,
        meta: { backfill: true },
      });
      rows += 1;
    }
  }
  return rows;
}

export type SweepResult = {
  skipped?: true;
  reason?: string;
  scanned?: number;
  tenants_swept?: number;
  skipped_no_connectors?: number;
  measured?: number;
  unavailable?: number;
  backfilled_rows?: number;
  errors?: number;
};

export async function runMetricSweep(
  logger: SweepLogger,
  deps: SweepDeps = realSweepDeps,
  now: Date = new Date(),
): Promise<SweepResult> {
  const svc = serviceClient();

  const { data: halted, error: killErr } = await svc.rpc("is_fleet_halted");
  if (killErr) {
    logger.error(
      `metric-sweep: is_fleet_halted failed (fail-closed, skipping): ${killErr.message}`,
    );
    return { skipped: true, reason: "fleet_kill_check_failed" };
  }
  if (halted === true) {
    return { skipped: true, reason: "fleet_halted" };
  }

  const { data, error } = await svc
    .from("tenants")
    .select("id")
    .order("created_at", { ascending: true })
    .limit(MAX_TENANTS_PER_SWEEP);
  if (error) {
    logger.error(`metric-sweep: tenant scan failed: ${error.message}`);
    return { scanned: 0, errors: 1 };
  }
  const tenants = (data ?? []) as Array<{ id: string }>;

  const tenantIds = tenants.map((t) => t.id);
  const connectorsByTenant = new Map<string, Set<string>>();
  if (tenantIds.length > 0) {
    const { data: connRows, error: connErr } = await svc
      .from("connector_metadata")
      .select("tenant_id, slug")
      .in("tenant_id", tenantIds)
      .in("slug", [...RELEVANT_CONNECTOR_SLUGS]);
    if (connErr) {
      logger.error(`metric-sweep: connector_metadata read failed: ${connErr.message}`);
      return { skipped: true, reason: "connector_read_failed" };
    }
    for (const row of (connRows ?? []) as Array<{ tenant_id: string; slug: string }>) {
      const set = connectorsByTenant.get(row.tenant_id) ?? new Set<string>();
      set.add(row.slug);
      connectorsByTenant.set(row.tenant_id, set);
    }
  }

  let tenants_swept = 0;
  let skipped_no_connectors = 0;
  let measured = 0;
  let unavailable = 0;
  let backfilled_rows = 0;
  let errors = 0;

  for (const t of tenants) {
    try {
      const slugs = connectorsByTenant.get(t.id);
      if (!slugs || slugs.size === 0) {
        skipped_no_connectors += 1;
        continue;
      }
      const r = await sweepTenantMetrics(t.id, slugs, now, deps, logger);
      tenants_swept += 1;
      measured += r.measured;
      unavailable += r.unavailable;
      backfilled_rows += r.backfilled_rows;
      errors += r.errors;
    } catch (e) {
      errors += 1;
      logger.warn(`[metric-sweep] tenant ${t.id} threw: ${(e as Error).message}`);
    }
  }

  return {
    scanned: tenants.length,
    tenants_swept,
    skipped_no_connectors,
    measured,
    unavailable,
    backfilled_rows,
    errors,
  };
}

export type AnomalyWatchRunResult = {
  skipped?: true;
  reason?: string;
  tenants_watched?: number;
  signals?: number;
  moves?: number;
  opened?: number;
  worsened?: number;
  recovered?: number;
  notices?: number;
  sent?: number;
  woke?: number;
  errors?: number;
};

export async function runAnomalyWatch(
  logger: SweepLogger,
  now: Date = new Date(),
  watch: typeof watchTenant = watchTenant,
  enabled: (tenant_id: string) => Promise<boolean> = (t) => getBoolSettingStrictResolved("metric_anomaly_alerts_enabled", t),
): Promise<AnomalyWatchRunResult> {
  const svc = serviceClient();
  const { data: halted, error: killErr } = await svc.rpc("is_fleet_halted");
  if (killErr) {
    logger.error(`anomaly-watch: is_fleet_halted failed (fail-closed, skipping): ${killErr.message}`);
    return { skipped: true, reason: "fleet_kill_check_failed" };
  }
  if (halted === true) return { skipped: true, reason: "fleet_halted" };

  const { data, error } = await svc
    .from("tenants")
    .select("id")
    .or("kind.is.null,kind.neq.test")
    .is("deleted_at", null)
    .order("created_at", { ascending: true })
    .limit(MAX_TENANTS_PER_SWEEP);
  if (error) {
    logger.error(`anomaly-watch: tenant scan failed: ${error.message}`);
    return { skipped: true, reason: "tenant_scan_failed" };
  }
  const ids = ((data ?? []) as Array<{ id: string }>).map((t) => t.id);
  if (ids.length === 0) return { tenants_watched: 0 };

  const { data: connRows, error: connErr } = await svc
    .from("connector_metadata")
    .select("tenant_id, slug")
    .in("tenant_id", ids)
    .in("slug", watchedConnectorSlugs());
  if (connErr) {
    logger.error(`anomaly-watch: connector_metadata read failed: ${connErr.message}`);
    return { skipped: true, reason: "connector_read_failed" };
  }
  const slugsByTenant = new Map<string, Set<string>>();
  for (const r of (connRows ?? []) as Array<{ tenant_id: string; slug: string }>) {
    const s = slugsByTenant.get(r.tenant_id) ?? new Set<string>();
    s.add(r.slug);
    slugsByTenant.set(r.tenant_id, s);
  }

  const out: Required<Omit<AnomalyWatchRunResult, "skipped" | "reason">> = {
    tenants_watched: 0,
    signals: 0,
    moves: 0,
    opened: 0,
    worsened: 0,
    recovered: 0,
    notices: 0,
    sent: 0,
    woke: 0,
    errors: 0,
  };
  for (const tenant_id of ids) {
    const slugs = slugsByTenant.get(tenant_id);
    if (!slugs || slugs.size === 0) continue;
    try {
      if (!(await enabled(tenant_id))) continue;
      const r = await watch(tenant_id, slugs, now);
      out.tenants_watched += 1;
      for (const k of ["signals", "moves", "opened", "worsened", "recovered", "notices", "sent", "woke", "errors"] as const) out[k] += r[k];
    } catch (e) {
      out.errors += 1;
      logger.warn(`[anomaly-watch] tenant ${tenant_id} threw: ${(e as Error).message}`);
    }
  }
  return out;
}

export const metricSweepFn = inngest.createFunction(
  { id: "metric-sweep", concurrency: 1 },
  { cron: "41 5 * * *" },
  async ({ logger }) => {
    const sweep = await runMetricSweep(logger);
    const anomalies = await runAnomalyWatch(logger).catch((e: Error) => {
      logger.error(`anomaly-watch threw: ${e.message}`);
      return { skipped: true as const, reason: "threw" };
    });
    return { ...sweep, anomalies };
  },
);
