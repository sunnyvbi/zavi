import { describe, expect, it } from "vitest";
import type { ShardRow, ShardSql } from "../contract";
import { cpuPct, createCpuMetricsSource, parseCpu } from "../cpu-metrics";
import { createGatewayMetricsSource, gatewayMetricsConfig, gatewayQueries } from "../gateway-metrics";
import {
  isSoftFull,
  measureShardSql,
  overThreshold,
  staleSources,
  sweepShardMetrics,
  type CpuMetricsSource,
  type GatewayMetricsSource,
  type ShardMetricsRow,
} from "../metrics";
import type { ShardMetricsRecord } from "../registry";

const NOW = Date.UTC(2026, 9, 2, 12);
const iso = (ms: number) => new Date(ms).toISOString();

function shard(n: number, over: Record<string, unknown> = {}): ShardMetricsRow {
  return {
    id: `0000000${n}-0000-4000-8000-000000000000`,
    env: "prod",
    name: `zavi-shard-prod-${n}`,
    project_ref: `refrefref${n}`,
    url: `https://refrefref${n}.supabase.co`,
    region: "us-west-1",
    state: "open",
    is_canary: false,
    schema_version: null,
    provision_step: "done",
    max_sites: 2000,
    site_count: 10,
    created_at: "2026-10-01T00:00:00Z",
    fill_ratio: 0.8,
    metrics_max_age_s: 1800,
    lim_records: 20_000_000,
    lim_bytes: 6_442_450_944,
    lim_requests_per_min: 30_000,
    lim_p95_ms: 250,
    lim_cpu_pct: 70,
    lim_connections: 120,
    lim_auth_users: 2_000_000,
    lim_sessions: 4_000_000,
    lim_emails_per_hour: 20_000,
    ...over,
  } as ShardMetricsRow;
}

const dbSql = (opts: { fail?: string; mail?: boolean } = {}): ShardSql & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    async query(ref, q) {
      calls.push(`${ref}:${q.slice(0, 30)}`);
      if (opts.fail === ref) throw new Error("mgmt 502");
      if (q.includes("zsite_auth.rate_counters") && q.includes("max(n)")) return [{ emails: "42" }];
      return [{ records: "100", bytes: 2048, auth_users: 3, sessions: 4, connections: 9, has_mail: opts.mail ?? true }];
    },
  };
};

function fakeRegistry(rows: ShardMetricsRow[]) {
  const recorded: Array<[string, ShardMetricsRecord]> = [];
  const claims = new Map<string, number>();
  return {
    recorded,
    list: async () => rows,
    recordMetrics: async (id: string, m: ShardMetricsRecord) => {
      recorded.push([id, m]);
      const r = rows.find((x) => x.id === id)!;
      const at = m.measured_at ?? {};
      if (at.db) r.m_db_at = at.db;
      if (at.gateway) r.m_gateway_at = at.gateway;
      if (at.cpu) r.m_cpu_at = at.cpu;
      for (const k of ["records", "bytes", "requests_per_min", "p95_ms", "cpu_pct", "connections", "auth_users", "sessions", "emails_per_hour"] as const) {
        if (m[k] !== undefined) r[`m_${k}`] = m[k];
      }
      if (m.cpu_sample) r.m_cpu_sample = m.cpu_sample;
      if (m.unconfigured) r.m_unconfigured = m.unconfigured;
      return r as ShardRow;
    },
    alertClaim: async (id: string, key: string, every: number) => {
      const k = `${id}:${key}`;
      const last = claims.get(k);
      if (last !== undefined && NOW - last < every * 1000) return false;
      claims.set(k, NOW);
      return true;
    },
  };
}

const gateway = (byRef: Record<string, { requests_per_min: number; p95_ms: number | null }>, fail = false): GatewayMetricsSource => ({
  async read() {
    if (fail) throw new Error("analytics engine sql failed (403)");
    return { measured_at: iso(NOW), byRef: new Map(Object.entries(byRef).map(([k, v]) => [k, { ...v, errors_5xx_per_min: 0 }])) };
  },
});
const cpu = (pct = 12.34, fail = false): CpuMetricsSource => ({
  async read() {
    if (fail) throw new Error("cpu metrics: endpoint returned 401");
    return { cpu_pct: pct, sample: { idle_s: 1, total_s: 2, at_ms: NOW, ncpu: 2 }, measured_at: iso(NOW) };
  },
});

describe("measureShardSql", () => {
  it("reads db metrics and the busiest recent hourly auth-mail window", async () => {
    expect(await measureShardSql(dbSql(), "refrefref1")).toEqual({ records: 100, bytes: 2048, auth_users: 3, sessions: 4, connections: 9, emails_per_hour: 42 });
  });
  it("a shard without the auth schema sends no site mail (0), without querying a missing table", async () => {
    const sql = dbSql({ mail: false });
    expect((await measureShardSql(sql, "refrefref1")).emails_per_hour).toBe(0);
    expect(sql.calls).toHaveLength(1);
  });
});

describe("freshness + thresholds (mirror SQL site_shard_metrics_fresh / load)", () => {
  it("NEW SHARD (c): never measured = fresh below the 25-site allowance, stale at it; unconfigured sources not required", () => {
    const young = iso(NOW - 3600_000);
    expect(staleSources({ site_count: 0, created_at: young }, NOW)).toEqual([]);
    expect(staleSources({ site_count: 24, created_at: young }, NOW)).toEqual([]);
    expect(staleSources({ site_count: 25, created_at: young }, NOW)).toEqual(["db", "gateway", "cpu"]);
    expect(staleSources({ site_count: 0, created_at: iso(NOW - 25 * 3600_000) }, NOW)).toEqual(["db", "gateway", "cpu"]);
    expect(staleSources({ site_count: 0 }, NOW)).toEqual(["db", "gateway", "cpu"]);
    const fresh = iso(NOW - 60_000);
    expect(staleSources({ m_db_at: fresh, m_cpu_at: fresh, m_unconfigured: ["gateway"] }, NOW)).toEqual([]);
    expect(staleSources({ m_db_at: null, m_cpu_at: fresh, m_unconfigured: ["gateway", "cpu"] }, NOW)).toEqual(["db"]);
  });

  it("a source is stale when missing or older than metrics_max_age_s", () => {
    const fresh = iso(NOW - 60_000);
    expect(staleSources({ m_db_at: fresh, m_gateway_at: fresh, m_cpu_at: fresh, metrics_max_age_s: 1800 }, NOW)).toEqual([]);
    expect(staleSources({ m_db_at: fresh, m_gateway_at: null, m_cpu_at: iso(NOW - 1801_000), metrics_max_age_s: 1800 }, NOW)).toEqual(["gateway", "cpu"]);
    expect(staleSources({ site_count: 30 }, NOW)).toEqual(["db", "gateway", "cpu"]);
  });
  it("over threshold = any dimension at the fill ratio, site count included", () => {
    expect(overThreshold(shard(1))).toEqual([]);
    expect(overThreshold(shard(1, { m_p95_ms: 200 })).map((o) => o.dim)).toEqual([]);
    expect(overThreshold(shard(1, { m_p95_ms: 200, m_requests_per_min: 59 })).map((o) => o.dim)).toEqual([]);
    expect(overThreshold(shard(1, { m_p95_ms: 200, m_requests_per_min: 60 }))).toEqual([{ dim: "p95_ms", ratio: 0.8, soft: true }]);
    expect(overThreshold(shard(1, { m_p95_ms: 200, m_requests_per_min: 10, soft_min_rpm: 5 })).map((o) => o.dim)).toEqual(["p95_ms"]);
    expect(overThreshold(shard(1, { site_count: 1700, m_cpu_pct: "63" }))).toEqual([
      { dim: "site_count", ratio: 0.85, soft: false },
      { dim: "cpu_pct", ratio: 0.9, soft: true },
    ]);
  });

  it("PROD 2026-10-02: an idle shard with one slow request (p95 260 ms at 0 req/min) is not over anything", () => {
    const idle = shard(1, { m_p95_ms: 260, m_requests_per_min: 0 });
    expect(overThreshold(idle)).toEqual([]);
    expect(isSoftFull(idle)).toBe(false);
    expect(isSoftFull(shard(1, { soft_full_at: iso(NOW) }))).toBe(true);
  });
});

describe("sweepShardMetrics", () => {
  it("records all three sources with their measured_at; a shard with no gateway data point is measured idle", async () => {
    const rows = [shard(1), shard(2)];
    const reg = fakeRegistry(rows);
    const alerts: string[] = [];
    const r = await sweepShardMetrics(
      { registry: reg, sql: dbSql(), gateway: gateway({ refrefref1: { requests_per_min: 120.4, p95_ms: 87.6 } }), cpu: cpu(), alert: async (c) => void alerts.push(c), now: () => NOW },
      "prod",
    );
    expect(r).toMatchObject({ measured: 2, failed: 0, sources: { db: "ok", gateway: "ok", cpu: "ok" }, stale: [], over: [] });
    expect(reg.recorded[0][1]).toMatchObject({ records: 100, requests_per_min: 120, p95_ms: 88, cpu_pct: 12.3, measured_at: { db: iso(NOW), gateway: iso(NOW), cpu: iso(NOW) } });
    expect(reg.recorded[1][1]).toMatchObject({ requests_per_min: 0, p95_ms: 0 });
    expect(alerts).toEqual([]);
  });

  it("NOT CONFIGURED (a): an unconfigured gateway source is not required; the shard stays placeable on what it can see; one hourly ops alert", async () => {
    const rows = [shard(1), shard(2)];
    const reg = fakeRegistry(rows);
    const alerts: Array<[string, string]> = [];
    const deps = { registry: reg, sql: dbSql(), gateway: null, cpu: cpu(), unconfigured: { gateway: "CLOUDFLARE_ANALYTICS_API_TOKEN not set" }, alert: async (c: string, m: string) => void alerts.push([c, m]), now: () => NOW };
    const r = await sweepShardMetrics(deps, "prod");
    expect(r.sources.gateway).toBe("unconfigured");
    expect(r.stale).toEqual([]);
    expect(reg.recorded[0][1]).toMatchObject({ measured_at: { db: iso(NOW), cpu: iso(NOW), sweep: iso(NOW) }, unconfigured: ["gateway"] });
    expect(alerts).toHaveLength(1);
    expect(alerts[0][0]).toBe("sites.shards.metrics_unconfigured");
    expect(alerts[0][1]).toMatch(/not configured \(prod\): gateway \(CLOUDFLARE_ANALYTICS_API_TOKEN not set\)/);
    await sweepShardMetrics(deps, "prod");
    expect(alerts).toHaveLength(1);
    await sweepShardMetrics({ ...deps, gateway: gateway({}), unconfigured: {} }, "prod");
    expect(reg.recorded[reg.recorded.length - 1][1].unconfigured).toEqual([]);
  });

  it("CONFIGURED (b): a configured source that goes stale makes the shard stale (full) and alerts", async () => {
    const old = iso(NOW - 3600_000);
    const rows = [shard(1, { m_db_at: old, m_gateway_at: old, m_cpu_at: old })];
    const reg = fakeRegistry(rows);
    const alerts: string[] = [];
    const r = await sweepShardMetrics({ registry: reg, sql: dbSql(), gateway: gateway({}, true), cpu: cpu(), alert: async (c) => void alerts.push(c), now: () => NOW }, "prod");
    expect(r.stale).toEqual(["zavi-shard-prod-1"]);
    expect(alerts).toEqual(["sites.shards.metrics_stale"]);
  });

  it("a failing source is reported per shard; the other sources still record", async () => {
    const rows = [shard(1, { site_count: 30 }), shard(2, { site_count: 30 })];
    const reg = fakeRegistry(rows);
    const alerts: Array<[string, string]> = [];
    const r = await sweepShardMetrics(
      { registry: reg, sql: dbSql({ fail: "refrefref2" }), gateway: gateway({}, true), cpu: cpu(0, true), alert: async (c, m) => void alerts.push([c, m]), now: () => NOW },
      "prod",
    );
    expect(r.sources).toEqual({ db: "failed", gateway: "failed", cpu: "failed" });
    expect(r.measured).toBe(1);
    expect(r.failed).toBe(1);
    expect(reg.recorded.map((x) => x[0])).toEqual([rows[0].id, rows[1].id]);
    expect(reg.recorded[1][1].measured_at).toEqual({ sweep: iso(NOW) });
    expect(r.stale).toEqual(["zavi-shard-prod-1", "zavi-shard-prod-2"]);
    expect(alerts.some(([, m]) => /zavi-shard-prod-2: db metrics are stale or missing \(mgmt 502\)/.test(m))).toBe(true);
    expect(alerts.some(([, m]) => /cpu metrics are stale or missing \(cpu metrics: endpoint returned 401\)/.test(m))).toBe(true);
  });

  it("a shard over a threshold alerts (once per dimension per window)", async () => {
    const rows = [shard(1)];
    const reg = fakeRegistry(rows);
    const alerts: Array<[string, string]> = [];
    const deps = { registry: reg, sql: dbSql(), gateway: gateway({ refrefref1: { requests_per_min: 120, p95_ms: 240 } }), cpu: cpu(65), alert: async (c: string, m: string) => void alerts.push([c, m]), now: () => NOW };
    const r = await sweepShardMetrics(deps, "prod");
    expect(r.over).toEqual(["zavi-shard-prod-1"]);
    expect(alerts.map((a) => a[0])).toEqual(["sites.shards.metrics_threshold", "sites.shards.metrics_threshold"]);
    expect(alerts.map((a) => a[1]).join("\n")).toMatch(/96% of its p95_ms[\s\S]*93% of its cpu_pct/);
    expect(alerts.every((a) => /never closes the shard/.test(a[1]))).toBe(true);
    await sweepShardMetrics(deps, "prod");
    expect(alerts).toHaveLength(2);
  });

  it("p95 on a near-idle shard (below soft_min_rpm) does not page; a soft-full shard pages once per window", async () => {
    const alerts: Array<[string, string]> = [];
    const reg = fakeRegistry([shard(1)]);
    await sweepShardMetrics({ registry: reg, sql: dbSql(), gateway: gateway({ refrefref1: { requests_per_min: 1, p95_ms: 260 } }), cpu: cpu(), alert: async (c, m) => void alerts.push([c, m]), now: () => NOW }, "prod");
    expect(alerts).toEqual([]);
    const soft = fakeRegistry([shard(1, { soft_full_at: iso(NOW) })]);
    const deps = { registry: soft, sql: dbSql(), gateway: gateway({}), cpu: cpu(), alert: async (c: string, m: string) => void alerts.push([c, m]), now: () => NOW };
    const r = await sweepShardMetrics(deps, "prod");
    expect(r.soft_full).toEqual(["zavi-shard-prod-1"]);
    expect(alerts.map((a) => a[0])).toEqual(["sites.shards.soft_full"]);
    await sweepShardMetrics(deps, "prod");
    expect(alerts).toHaveLength(1);
  });

  it("kernel (one-site) shards, retired and provisioning shards: measured or skipped, never paged", async () => {
    const rows = [shard(1, { dedicated_site_id: "x", name: "zavi-shard-prod-k0123456789abcdef0123456789abcdef", state: "full" }), shard(2, { state: "retired" }), shard(3, { state: "provisioning" })];
    const reg = fakeRegistry(rows);
    const alerts: string[] = [];
    const r = await sweepShardMetrics({ registry: reg, sql: dbSql(), gateway: null, cpu: null, alert: async (c) => void alerts.push(c), now: () => NOW }, "prod");
    expect(reg.recorded.map((x) => x[0])).toEqual([rows[0].id]);
    expect(r.stale).toEqual([]);
    expect(alerts).toEqual([]);
  });

  it("a paused shard pages, except a rollout's own fresh pause; an expired lease does not count", async () => {
    const fresh = iso(NOW);
    const mk = (over: Record<string, unknown>) => shard(1, { m_db_at: fresh, m_gateway_at: fresh, m_cpu_at: fresh, ...over });
    const run = async (row: ShardMetricsRow) => {
      const alerts: Array<[string, string]> = [];
      const r = await sweepShardMetrics({ registry: fakeRegistry([row]), sql: dbSql(), gateway: gateway({}), cpu: cpu(), alert: async (c, m) => void alerts.push([c, m]), now: () => NOW }, "prod");
      return { r, codes: alerts.map((a) => a[0]), alerts };
    };
    const stopped = await run(mk({ placement_paused_until: "infinity", placement_paused_reason: "schema rollout stopped: 0011_x failed: boom", placement_paused_at: iso(NOW - 60_000) }));
    expect(stopped.r.paused).toEqual(["zavi-shard-prod-1"]);
    expect(stopped.codes).toEqual(["sites.shards.placement_paused"]);
    expect(stopped.alerts[0][1]).toMatch(/PAUSED \(schema rollout stopped: 0011_x failed: boom\)/);
    const inProgress = await run(mk({ placement_paused_until: "infinity", placement_paused_reason: "schema rollout in progress", placement_paused_at: iso(NOW - 600_000) }));
    expect(inProgress.r.paused).toEqual(["zavi-shard-prod-1"]);
    expect(inProgress.codes).toEqual([]);
    const died = await run(mk({ placement_paused_until: "infinity", placement_paused_reason: "schema rollout in progress", placement_paused_at: iso(NOW - 3 * 3600_000) }));
    expect(died.codes).toEqual(["sites.shards.placement_paused"]);
    const lapsed = await run(mk({ placement_paused_until: iso(NOW - 1000), placement_paused_reason: "x" }));
    expect(lapsed.r.paused).toEqual([]);
  });

  it("a registry write failure is a FAILED measurement, never a success", async () => {
    const reg = { ...fakeRegistry([shard(1)]), recordMetrics: async () => { throw new Error("rpc 503"); } };
    const r = await sweepShardMetrics({ registry: reg, sql: dbSql(), gateway: gateway({}), cpu: cpu(), now: () => NOW }, "prod");
    expect(r).toMatchObject({ measured: 0, failed: 1 });
  });

  it("an unreadable alert de-dupe store pages anyway (a duplicate beats a missed alert)", async () => {
    const reg = { ...fakeRegistry([shard(1)]), alertClaim: async () => { throw new Error("db down"); } };
    const alerts: string[] = [];
    await sweepShardMetrics({ registry: reg, sql: dbSql(), gateway: null, cpu: cpu(), alert: async (c) => void alerts.push(c), now: () => NOW }, "prod");
    expect(alerts).toEqual(["sites.shards.metrics_unconfigured"]);
  });
});

describe("gateway metrics (Workers Analytics Engine SQL)", () => {
  const CFG = { ok: true as const, accountId: "0123456789abcdef0123456789abcdef", token: "tok", dataset: "zavi_site_gateway_shards" };

  it("config: account + analytics token required; dataset defaults", () => {
    expect(gatewayMetricsConfig({})).toEqual({ ok: false, missing: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_ANALYTICS_API_TOKEN"], invalid: [] });
    expect(gatewayMetricsConfig({ CLOUDFLARE_ACCOUNT_ID: "nope", CLOUDFLARE_ANALYTICS_API_TOKEN: "t" })).toMatchObject({ ok: false, missing: [], invalid: ["CLOUDFLARE_ACCOUNT_ID (invalid)"] });
    expect(gatewayMetricsConfig({ CLOUDFLARE_ACCOUNT_ID: CFG.accountId, CLOUDFLARE_ANALYTICS_API_TOKEN: "t" })).toMatchObject({ ok: true, dataset: "zavi_site_gateway_shards" });
    expect(gatewayMetricsConfig({ CLOUDFLARE_ACCOUNT_ID: CFG.accountId, CLOUDFLARE_ANALYTICS_API_TOKEN: "t", SITE_GATEWAY_METRICS_DATASET: "x; drop" })).toMatchObject({ ok: false });
  });

  it("queries undo sampling with _sample_interval, p95 only over requests that reached the shard; refs are validated", () => {
    const q = gatewayQueries("ds", ["refrefref1", "refrefref2"]);
    expect(q.counts).toBe("SELECT index1 AS ref, SUM(_sample_interval) AS n FROM ds WHERE timestamp > NOW() - INTERVAL '5' MINUTE AND index1 IN ('refrefref1', 'refrefref2') GROUP BY index1 FORMAT JSON");
    expect(q.errors).toContain("AND blob2 = '5xx'");
    expect(q.p95).toContain("quantileWeighted(0.95, double2, _sample_interval)");
    expect(q.p95).toContain("AND double3 > 0");
    expect(() => gatewayQueries("ds", ["x' OR 1=1 --"])).toThrow(/invalid shard ref/);
  });

  it("reads per-shard rate (per minute), 5xx rate and p95; numbers may arrive as strings", async () => {
    const seen: string[] = [];
    const src = createGatewayMetricsSource({
      config: CFG,
      now: () => NOW,
      fetchFn: async (url, init) => {
        seen.push(init.body);
        expect(url).toBe(`https://api.cloudflare.com/client/v4/accounts/${CFG.accountId}/analytics_engine/sql`);
        expect(init.headers.Authorization).toBe("Bearer tok");
        const data = init.body.includes("quantileWeighted") ? [{ ref: "refrefref1", p95: 120.5 }]
          : init.body.includes("'5xx'") ? [{ ref: "refrefref1", n: "10" }]
          : [{ ref: "refrefref1", n: "1500" }, { ref: "evilref999", n: "9" }];
        return { status: 200, text: async () => JSON.stringify({ data, rows: data.length }) };
      },
    });
    const r = await src.read(["refrefref1", "refrefref2", "bad ref"]);
    expect(r.measured_at).toBe(iso(NOW));
    expect(r.byRef.get("refrefref1")).toEqual({ requests_per_min: 300, p95_ms: 120.5, errors_5xx_per_min: 2 });
    expect(r.byRef.get("refrefref2")).toEqual({ requests_per_min: 0, p95_ms: null, errors_5xx_per_min: 0 });
    expect(r.byRef.has("evilref999")).toBe(false);
    expect(seen).toHaveLength(3);
  });

  it("a non-2xx or non-JSON answer throws (the source then counts as failed: stale, never zero)", async () => {
    const bad = createGatewayMetricsSource({ config: CFG, fetchFn: async () => ({ status: 403, text: async () => "forbidden" }) });
    await expect(bad.read(["refrefref1"])).rejects.toThrow(/403/);
    const junk = createGatewayMetricsSource({ config: CFG, fetchFn: async () => ({ status: 200, text: async () => "<html>" }) });
    await expect(junk.read(["refrefref1"])).rejects.toThrow(/not JSON/);
  });
});

describe("cpu metrics (Supabase metrics endpoint)", () => {
  const PROM = [
    "# HELP node_cpu_seconds_total Seconds the CPUs spent in each mode.",
    'node_cpu_seconds_total{cpu="0",mode="idle",service_type="db"} 900',
    'node_cpu_seconds_total{cpu="0",mode="user",service_type="db"} 80',
    'node_cpu_seconds_total{cpu="1",mode="idle",service_type="db"} 900',
    'node_cpu_seconds_total{cpu="1",mode="system",service_type="db"} 120',
    'node_cpu_seconds_total{cpu="0",mode="idle",service_type="postgrest"} 5',
    'node_load1{service_type="db"} 0.5',
  ].join("\n");

  it("parses the db host's CPU counters only", () => {
    expect(parseCpu(PROM)).toEqual({ idle_s: 1800, total_s: 2000, ncpu: 2, load1: 0.5 });
    expect(() => parseCpu("up 1")).toThrow(/node_cpu_seconds_total/);
  });

  it("CPU% is the rate between two samples; load average per CPU only without a usable previous sample", () => {
    const prev = { idle_s: 1700, total_s: 1800, at_ms: NOW - 600_000, ncpu: 2 };
    const cur = { idle_s: 1800, total_s: 2000, at_ms: NOW, ncpu: 2 };
    expect(cpuPct(cur, prev, 0.5)).toBeCloseTo(50);
    expect(cpuPct(cur, null, 0.5)).toBeCloseTo(25);
    expect(cpuPct(cur, { ...prev, total_s: 2100 }, 1.5)).toBeCloseTo(75);
    expect(cpuPct(cur, { ...prev, at_ms: NOW - 2 * 3600_000 }, 0.5)).toBeCloseTo(25);
    expect(() => cpuPct(cur, null, null)).toThrow();
  });

  it("reads with Basic service_role:<vault key>; refuses without a key", async () => {
    let auth = "";
    const src = createCpuMetricsSource({
      secrets: { getSecret: async (_id, name) => (name === "service_key" ? "sk-test" : null) },
      now: () => NOW,
      fetchFn: async (url, init) => {
        expect(url).toBe("https://refrefref1.supabase.co/customer/v1/privileged/metrics");
        auth = init.headers.Authorization;
        return { status: 200, text: async () => PROM };
      },
    });
    const r = await src.read(shard(1) as ShardRow, null);
    expect(auth).toBe(`Basic ${Buffer.from("service_role:sk-test").toString("base64")}`);
    expect(r).toMatchObject({ cpu_pct: 25, sample: { idle_s: 1800, total_s: 2000, ncpu: 2, at_ms: NOW }, measured_at: iso(NOW) });
    const nokey = createCpuMetricsSource({ secrets: { getSecret: async () => null } });
    await expect(nokey.read(shard(1) as ShardRow, null)).rejects.toThrow(/service key/);
  });
});
