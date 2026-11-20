
import type { ShardEnv, ShardRow, ShardSql } from "./contract";
import type { ShardMetricsRecord, ShardRegistry } from "./registry";

export type MetricSource = "db" | "gateway" | "cpu";
export const METRIC_SOURCES: readonly MetricSource[] = ["db", "gateway", "cpu"];

export const DEFAULT_METRICS_MAX_AGE_S = 1800;
export const STALE_ALERT_EVERY_S = 3600;
export const OVER_ALERT_EVERY_S = 6 * 3600;
export const PAUSE_ALERT_AFTER_S = 2 * 3600;
export const ROLLOUT_IN_PROGRESS = "schema rollout in progress";

export const LOAD_DIMS = [
  ["m_records", "lim_records"],
  ["m_bytes", "lim_bytes"],
  ["m_requests_per_min", "lim_requests_per_min"],
  ["m_p95_ms", "lim_p95_ms"],
  ["m_cpu_pct", "lim_cpu_pct"],
  ["m_connections", "lim_connections"],
  ["m_auth_users", "lim_auth_users"],
  ["m_sessions", "lim_sessions"],
  ["m_emails_per_hour", "lim_emails_per_hour"],
] as const;

export type ShardMetricsRow = ShardRow & Partial<Record<string, unknown>>;

export async function measureShardSql(sql: ShardSql, ref: string): Promise<ShardMetricsRecord> {
  const rows = (await sql.query(
    ref,
    `select coalesce((select sum(records) from zsite.usage), 0)::bigint as records,
            coalesce((select sum(bytes) from zsite.usage), 0)::bigint as bytes,
            (select count(*) from auth.users)::bigint as auth_users,
            (select count(*) from auth.sessions where not_after is null or not_after > now())::bigint as sessions,
            (select count(*) from pg_stat_activity where datname = current_database())::int as connections,
            to_regclass('zsite_auth.rate_counters') is not null as has_mail`,
  )) as Array<Record<string, unknown>>;
  const r = rows[0] ?? {};
  const n = (v: unknown) => (v !== null && v !== "" && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : undefined);
  const out: ShardMetricsRecord = { records: n(r.records), bytes: n(r.bytes), auth_users: n(r.auth_users), sessions: n(r.sessions), connections: n(r.connections) };
  out.emails_per_hour = 0;
  if (r.has_mail === true) {
    const m = (await sql.query(
      ref,
      `select coalesce(max(n), 0)::bigint as emails from (
         select sum(hits) as n from zsite_auth.rate_counters
          where key like 'mail:site:%' and window_start >= now() - interval '2 hours'
          group by window_start) w`,
    )) as Array<Record<string, unknown>>;
    out.emails_per_hour = n(m[0]?.emails) ?? 0;
  }
  return out;
}

export type GatewayReading = { requests_per_min: number; p95_ms: number | null; errors_5xx_per_min: number };

export interface GatewayMetricsSource {
  read(refs: string[]): Promise<{ measured_at: string; byRef: Map<string, GatewayReading> }>;
}

export type CpuSample = { idle_s: number; total_s: number; at_ms: number; ncpu: number };

export interface CpuMetricsSource {
  read(shard: ShardRow, prev: CpuSample | null): Promise<{ cpu_pct: number; sample: CpuSample; measured_at: string }>;
}

export type SourceStatus = "ok" | "unconfigured" | "failed";

const ts = (v: unknown): number | null => {
  if (typeof v !== "string" && !(v instanceof Date)) return null;
  const t = new Date(v as string).getTime();
  return Number.isFinite(t) ? t : null;
};

export const UNMEASURED_SITE_CAP = 25;
export const UNMEASURED_WINDOW_MS = 24 * 3600_000;

export const SOURCE_DIMS: Record<"gateway" | "cpu", readonly string[]> = { gateway: ["m_requests_per_min", "m_p95_ms"], cpu: ["m_cpu_pct"] };
export function unconfiguredDims(row: Partial<Record<string, unknown>>): Set<string> {
  const u = Array.isArray(row.m_unconfigured) ? (row.m_unconfigured as unknown[]).map(String) : [];
  return new Set(u.flatMap((s) => (s === "gateway" || s === "cpu" ? [...SOURCE_DIMS[s]] : [])));
}

export const SOFT_DIMS: ReadonlySet<string> = new Set(["m_requests_per_min", "m_p95_ms", "m_cpu_pct"]);
export const DEFAULT_SOFT_MIN_RPM = 60;

export function ignoredDims(row: Partial<Record<string, unknown>>): Set<string> {
  const skip = unconfiguredDims(row);
  const minRpm = num(row.soft_min_rpm, DEFAULT_SOFT_MIN_RPM);
  if (num(row.m_requests_per_min) < minRpm) skip.add("m_p95_ms");
  return skip;
}

export const isSoftFull = (row: Partial<Record<string, unknown>>) =>
  typeof row.soft_full_at === "string" || row.soft_full_at instanceof Date;

export function staleSources(row: Partial<Record<string, unknown>>, nowMs: number): MetricSource[] {
  const maxAge = Number.isFinite(Number(row.metrics_max_age_s)) && Number(row.metrics_max_age_s) > 0 ? Number(row.metrics_max_age_s) : DEFAULT_METRICS_MAX_AGE_S;
  const col: Record<MetricSource, string> = { db: "m_db_at", gateway: "m_gateway_at", cpu: "m_cpu_at" };
  const created = ts(row.created_at);
  if (METRIC_SOURCES.every((s) => ts(row[col[s]]) === null) && num(row.site_count) < UNMEASURED_SITE_CAP && created !== null && created > nowMs - UNMEASURED_WINDOW_MS) return [];
  const unconfigured = Array.isArray(row.m_unconfigured) ? (row.m_unconfigured as unknown[]).map(String) : [];
  return METRIC_SOURCES.filter((s) => {
    if (s !== "db" && unconfigured.includes(s)) return false;
    const t = ts(row[col[s]]);
    return t === null || t <= nowMs - maxAge * 1000;
  });
}

export const metricsFresh = (row: Partial<Record<string, unknown>>, nowMs: number) => staleSources(row, nowMs).length === 0;

function num(v: unknown, d = 0): number {
  return v !== null && v !== "" && v !== undefined && Number.isFinite(Number(v)) ? Number(v) : d;
}

export function overThreshold(row: Partial<Record<string, unknown>>): Array<{ dim: string; ratio: number; soft: boolean }> {
  const fill = Math.min(Math.max(num(row.fill_ratio, 0.8), 0.01), 1);
  const out: Array<{ dim: string; ratio: number; soft: boolean }> = [];
  const maxSites = num(row.max_sites);
  const skip = ignoredDims(row);
  if (maxSites > 0 && num(row.site_count) / maxSites >= fill) out.push({ dim: "site_count", ratio: num(row.site_count) / maxSites, soft: false });
  for (const [m, lim] of LOAD_DIMS) {
    if (skip.has(m)) continue;
    const l = num(row[lim]);
    if (l > 0 && num(row[m]) / l >= fill) out.push({ dim: m.slice(2), ratio: num(row[m]) / l, soft: SOFT_DIMS.has(m) });
  }
  return out;
}

const isPlaceablePooled = (s: ShardMetricsRow) =>
  !s.dedicated_site_id && (s.purpose ?? "pool") === "pool" && /^zavi-shard-(prod|dev)-[0-9]{1,6}$/.test(s.name) && (s.state === "open" || s.state === "full") && !!s.project_ref;

function prevCpuSample(row: ShardMetricsRow): CpuSample | null {
  const s = row.m_cpu_sample as Partial<CpuSample> | null | undefined;
  if (!s || typeof s !== "object") return null;
  const ok = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
  return ok(s.idle_s) && ok(s.total_s) && ok(s.at_ms) && ok(s.ncpu) ? (s as CpuSample) : null;
}

export type SweepDeps = {
  registry: Pick<ShardRegistry, "list" | "recordMetrics"> & Partial<Pick<ShardRegistry, "alertClaim">>;
  sql: ShardSql;
  gateway?: GatewayMetricsSource | null;
  cpu?: CpuMetricsSource | null;
  unconfigured?: Partial<Record<MetricSource, string>>;
  alert?: (code: string, msg: string) => Promise<void>;
  now?: () => number;
  log?: (l: string) => void;
};

export type SweepResult = {
  measured: number;
  failed: number;
  sources: Record<MetricSource, SourceStatus>;
  stale: string[];
  over: string[];
  paused: string[];
  soft_full: string[];
};

const errText = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 200);

export async function sweepShardMetrics(deps: SweepDeps, env: ShardEnv): Promise<SweepResult> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => undefined);
  const result: SweepResult = {
    measured: 0,
    failed: 0,
    sources: { db: "ok", gateway: deps.gateway ? "ok" : "unconfigured", cpu: deps.cpu ? "ok" : "unconfigured" },
    stale: [],
    over: [],
    paused: [],
    soft_full: [],
  };
  const shards = ((await deps.registry.list(env)) as ShardMetricsRow[]).filter(
    (s) => !!s.project_ref && s.state !== "retired" && s.state !== "provisioning",
  );
  if (!shards.length) return result;
  const sweepAt = new Date(now()).toISOString();
  const unconfigured = (["gateway", "cpu"] as const).filter((s) => result.sources[s] === "unconfigured");
  const firstPooled = shards.find(isPlaceablePooled);
  if (unconfigured.length && deps.alert && firstPooled) {
    const first = firstPooled;
    const claimed = deps.registry.alertClaim ? await deps.registry.alertClaim(first.id, "unconfigured", STALE_ALERT_EVERY_S).catch(() => true) : true;
    if (claimed) {
      await deps.alert(
        "sites.shards.metrics_unconfigured",
        `shard metrics source not configured (${env}): ${unconfigured.map((s) => `${s}${deps.unconfigured?.[s] ? ` (${deps.unconfigured[s]})` : ""}`).join(", ")}. Placement judges shards on the database metrics only until it is.`,
      ).catch(() => undefined);
    }
  }

  let gw: { measured_at: string; byRef: Map<string, GatewayReading> } | null = null;
  let gwError: string | null = null;
  if (deps.gateway) {
    try {
      gw = await deps.gateway.read(shards.map((s) => s.project_ref as string));
    } catch (e) {
      result.sources.gateway = "failed";
      gwError = errText(e);
      log(`[shard-metrics] gateway read failed: ${gwError}`);
    }
  }

  for (const shard of shards) {
    const ref = shard.project_ref as string;
    const errors: Partial<Record<MetricSource, string>> = gwError ? { gateway: gwError } : {};
    const rec: ShardMetricsRecord = {};
    const at: Partial<Record<MetricSource, string>> = {};
    try {
      Object.assign(rec, await measureShardSql(deps.sql, ref));
      at.db = new Date(now()).toISOString();
    } catch (e) {
      result.sources.db = "failed";
      errors.db = errText(e);
      log(`[shard-metrics] ${shard.name} db: ${errors.db}`);
    }
    if (gw) {
      const g = gw.byRef.get(ref) ?? { requests_per_min: 0, p95_ms: 0, errors_5xx_per_min: 0 };
      rec.requests_per_min = Math.round(g.requests_per_min);
      rec.p95_ms = Math.round(g.p95_ms ?? 0);
      at.gateway = gw.measured_at;
    }
    if (deps.cpu) {
      try {
        const c = await deps.cpu.read(shard, prevCpuSample(shard));
        rec.cpu_pct = Math.round(c.cpu_pct * 10) / 10;
        rec.cpu_sample = c.sample;
        at.cpu = c.measured_at;
      } catch (e) {
        result.sources.cpu = "failed";
        errors.cpu = errText(e);
        log(`[shard-metrics] ${shard.name} cpu: ${errors.cpu}`);
      }
    }

    let row: ShardMetricsRow = shard;
    let stored = false;
    try {
      row = (await deps.registry.recordMetrics(shard.id, { ...rec, measured_at: { ...at, sweep: sweepAt }, unconfigured })) as ShardMetricsRow;
      stored = true;
    } catch (e) {
      log(`[shard-metrics] ${shard.name} record: ${errText(e)}`);
    }
    if (at.db && stored) result.measured++;
    else result.failed++;
    await judge(deps, row, errors, result, now());
  }
  return result;
}

async function judge(deps: SweepDeps, row: ShardMetricsRow, errors: Partial<Record<MetricSource, string>>, result: SweepResult, nowMs: number) {
  if (!isPlaceablePooled(row)) return;
  const claim = async (key: string, every: number) => {
    if (!deps.registry.alertClaim) return true;
    return deps.registry.alertClaim(row.id, key, every).catch(() => true);
  };
  const stale = staleSources(row, nowMs);
  if (stale.length) {
    result.stale.push(row.name);
    for (const s of stale) {
      if (!(await claim(`stale:${s}`, STALE_ALERT_EVERY_S))) continue;
      const why =
        deps.unconfigured?.[s] ?? errors[s] ?? (result.sources[s] === "unconfigured" ? "source not configured" : "no recent measurement");
      await deps.alert?.(
        "sites.shards.metrics_stale",
        `shared site database ${row.name}: ${s} metrics are stale or missing (${why}). Placement treats it as FULL until they are fresh again; if every open shard is stale, new data sites cannot be created.`,
      ).catch(() => undefined);
    }
  }
  const until = typeof row.placement_paused_until === "string" ? row.placement_paused_until : null;
  if (until && (until === "infinity" || ts(until) === null || (ts(until) as number) > nowMs)) {
    result.paused.push(row.name);
    const since = ts(row.placement_paused_at);
    const expected = String(row.placement_paused_reason ?? "").startsWith(ROLLOUT_IN_PROGRESS) && since !== null && nowMs - since < PAUSE_ALERT_AFTER_S * 1000;
    if (!expected && (await claim("paused", OVER_ALERT_EVERY_S))) {
      await deps.alert?.(
        "sites.shards.placement_paused",
        `shared site database ${row.name}: placement is PAUSED (${String(row.placement_paused_reason ?? "no reason").slice(0, 200)}). It takes no new sites until resumed (site_shard_placement_resume) once its schema is checked.`,
      ).catch(() => undefined);
    }
  }
  const over = overThreshold(row);
  if (over.length) {
    result.over.push(row.name);
    for (const o of over) {
      if (!(await claim(`over:${o.dim}`, OVER_ALERT_EVERY_S))) continue;
      await deps.alert?.(
        "sites.shards.metrics_threshold",
        o.soft
          ? `shared site database ${row.name} is at ${Math.round(o.ratio * 100)}% of its ${o.dim} limit (a performance signal: it never closes the shard; held for ${num(row.soft_close_readings, 3)} sweeps it is placed on last and a new shard is requested). State: ${row.state}.`
          : `shared site database ${row.name} is at ${Math.round(o.ratio * 100)}% of its ${o.dim} limit (stops taking sites at ${Math.round(num(row.fill_ratio, 0.8) * 100)}%). State: ${row.state}.`,
      ).catch(() => undefined);
    }
  }
  if (isSoftFull(row) && (await claim("soft_full", OVER_ALERT_EVERY_S))) {
    result.soft_full.push(row.name);
    await deps.alert?.(
      "sites.shards.soft_full",
      `shared site database ${row.name} has been under heavy load (requests, latency or CPU) for ${num(row.soft_close_readings, 3)}+ sweeps. New sites go to other open shards first; while it is the only one it keeps taking sites, and the hourly capacity check asks for another shard.`,
    ).catch(() => undefined);
  }
}

export async function runShardMetricsSweep(): Promise<SweepResult & { env: ShardEnv }> {
  const [{ shardRegistry, shardEnv }, { createShardMgmt }, gwMod, cpuMod] = await Promise.all([
    import("./registry"),
    import("./shard-mgmt"),
    import("./gateway-metrics"),
    import("./cpu-metrics"),
  ]);
  const registry = shardRegistry();
  const env = shardEnv();
  let mgmt: ReturnType<typeof createShardMgmt> | null = null;
  const gwCfg = gwMod.gatewayMetricsConfig();
  const r = await sweepShardMetrics(
    {
      registry,
      sql: { query: (ref, q) => (mgmt ??= createShardMgmt()).query(ref, q) },
      gateway: gwCfg.ok
        ? gwMod.createGatewayMetricsSource({ config: gwCfg })
        : gwCfg.invalid.length
          ? { read: async () => { throw new Error(`gateway metrics config invalid: ${gwCfg.invalid.join(", ")}`); } }
          : null,
      cpu: cpuMod.createCpuMetricsSource({ secrets: registry }),
      unconfigured: !gwCfg.ok && !gwCfg.invalid.length ? { gateway: `${gwCfg.missing.join(", ")} not set` } : {},
      alert: async (code, msg) => (await import("@/services/logging/alert")).alert({ msg, source: "site-shard-metrics", code }),
      log: (l) => console.warn(l),
    },
    env,
  );
  return { ...r, env };
}
