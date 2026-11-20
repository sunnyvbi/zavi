import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NoShardCapacity } from "../contract";
import { createShardRegistry } from "../registry";

const ON = process.env.SITE_SHARDS_PG === "1";
const PGBIN = process.env.PGBIN ?? "/opt/homebrew/opt/postgresql@17/bin";
const PORT = Number(process.env.SITE_SHARDS_PG_PORT ?? 55447);
const REPO = resolve(__dirname, "../../../../../..");
const MIG = join(REPO, "supabase/migrations");
const T1 = "aaaaaaaa-0000-4000-8000-00000000000a";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PgClient = any;
const req = createRequire(__filename);
let dir = "";
let admin: PgClient;

async function client(): Promise<PgClient> {
  const { Client } = req("pg");
  const c = new Client({ host: "localhost", port: PORT, user: "postgres", database: "zavi" });
  await c.connect();
  return c;
}

function rpcVia(c: PgClient) {
  return async (name: string, args: Record<string, unknown>) => {
    const keys = Object.keys(args);
    try {
      await c.query("begin; set local role service_role");
      const r = await c.query(
        `select to_jsonb(x) as j from public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) x`,
        keys.map((k) => (args[k] !== null && typeof args[k] === "object" && !Array.isArray(args[k]) ? JSON.stringify(args[k]) : args[k])),
      );
      await c.query("commit");
      const rows = r.rows.map((x: { j: unknown }) => x.j);
      const scalar = rows.length === 1 && (rows[0] === null || typeof rows[0] !== "object") ? rows[0] : rows;
      return { data: scalar, error: null };
    } catch (e) {
      await c.query("rollback").catch(() => undefined);
      return { data: null, error: { code: (e as { code?: string }).code, message: (e as Error).message } };
    }
  };
}

const reg = () => {
  const rpc = rpcVia(admin);
  return createShardRegistry({ shardRpc: rpc, tenantRpc: (tid, name, args) => rpc(name, { p_tenant_id: tid, ...args }) });
};

let n = 0;
async function openShard(extra: Record<string, unknown> = {}) {
  n++;
  const s = await reg().register({ env: "dev", name: `zavi-shard-dev-${n}`, region: "us-west-1" });
  await reg().update(s.id, { project_ref: `shardref000${n}`, url: `https://shardref000${n}.supabase.co`, provision_step: "done", state: "open", ...extra });
  return s.id;
}

const ALL_NOW = () => {
  const t = new Date().toISOString();
  return { db: t, gateway: t, cpu: t };
};

async function newSite(): Promise<string> {
  const run = (await admin.query("insert into public.conductor_runs (id, tenant_id) values (gen_random_uuid(), $1) returning id", [T1])).rows[0].id;
  const r = await admin.query("select (public.site_get_or_create_for_run($1, $2, 'Shop', null, '-dev', 'zaviagent.com')).id", [T1, run]);
  const id = r.rows[0].id as string;
  await admin.query("select public.site_backend_init_static($1, $2)", [T1, id]);
  return id;
}

describe.skipIf(!ON)("S7 metrics freshness SQL on a throwaway Postgres 17", () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "metrics-fresh-pg-"));
    execFileSync(join(PGBIN, "initdb"), ["-D", join(dir, "data"), "-U", "postgres", "-A", "trust"], { stdio: "ignore" });
    execFileSync(join(PGBIN, "pg_ctl"), ["-D", join(dir, "data"), "-o", `-p ${PORT} -c listen_addresses=localhost`, "-l", join(dir, "log"), "-w", "start"], { stdio: "ignore" });
    const { Client } = req("pg");
    const root = new Client({ host: "localhost", port: PORT, user: "postgres", database: "postgres" });
    await root.connect();
    await root.query("create database zavi");
    await root.end();
    admin = await client();
    await admin.query(readFileSync(join(__dirname, "sql/zavi-db-stubs.sql"), "utf8"));
    await admin.query(readFileSync(join(MIG, "20261008090000_sites.sql"), "utf8"));
    await admin.query(readFileSync(join(MIG, "20261010090000_site_shards.sql"), "utf8"));
    await admin.query("alter table public.site_shards add column if not exists dedicated_site_id uuid");
    await admin.query("alter table public.site_shards add column if not exists purpose text not null default 'pool'");
    await admin.query(readFileSync(join(MIG, "20261010160000_site_shard_autoprovision.sql"), "utf8"));
    await admin.query("create table if not exists public.site_kernel_provisions (site_id uuid primary key, tenant_id uuid)");
    await admin.query(readFileSync(join(MIG, "20261012090000_site_shard_metrics_freshness.sql"), "utf8"));
    await admin.query(readFileSync(join(MIG, "20261012090000_site_shard_metrics_freshness.sql"), "utf8"));
    await admin.query(readFileSync(join(MIG, "20261012105000_site_shard_placeable.sql"), "utf8"));
    await admin.query(readFileSync(join(MIG, "20261015010000_site_shard_pause_unless_held.sql"), "utf8"));
    await admin.query("alter table public.site_shards add column if not exists purpose text not null default 'pool'");
    await admin.query("create table if not exists public.site_test_sites (id uuid primary key, tenant_id uuid, live_site_id uuid, env text, shard_id uuid, preview_host text, deploy_id text, expires_at timestamptz, state text not null default 'creating')");
    await admin.query(readFileSync(join(MIG, "20261016100000_site_shard_soft_signals.sql"), "utf8"));
    await admin.query("insert into public.tenants values ($1)", [T1]);
  }, 60_000);

  afterAll(async () => {
    await admin?.end().catch(() => undefined);
    if (dir) {
      try {
        execFileSync(join(PGBIN, "pg_ctl"), ["-D", join(dir, "data"), "-m", "immediate", "stop"], { stdio: "ignore" });
      } catch {
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  beforeEach(async () => {
    await admin.query("update public.site_shards set state = 'draining' where state in ('open', 'full')");
  });

  it("anon / authenticated can call none of the new functions", async () => {
    for (const role of ["anon", "authenticated"]) {
      for (const q of [
        "select public.site_shard_placement_pause(gen_random_uuid(), 'x', 10)",
        "select public.site_shard_capacity_inputs('dev')",
        "select * from public.site_shard_placements",
      ]) {
        await admin.query(`begin; set local role ${role}`);
        await expect(admin.query(q)).rejects.toThrow(/permission denied/);
        await admin.query("rollback");
      }
    }
  });

  it("NEW SHARD (c): a never-measured shard takes sites only below the 25-site allowance", async () => {
    const s = await openShard();
    expect((await reg().place(T1, await newSite(), "dev")).shard.id).toBe(s);
    await admin.query("update public.site_shards set site_count = 25 where id = $1", [s]);
    await expect(reg().place(T1, await newSite(), "dev")).rejects.toBeInstanceOf(NoShardCapacity);
    await admin.query("update public.site_shards set site_count = 1, created_at = now() - interval '25 hours' where id = $1", [s]);
    await expect(reg().place(T1, await newSite(), "dev")).rejects.toBeInstanceOf(NoShardCapacity);
    await admin.query("update public.site_shards set state = 'draining' where id = $1", [s]);
  });

  it("CONFIGURED (b): once measured, every configured source must be fresh; two of three = full", async () => {
    const s = await openShard();
    const site = await newSite();
    await reg().recordMetrics(s, { records: 1, measured_at: { db: new Date().toISOString(), gateway: new Date().toISOString() } });
    await expect(reg().place(T1, site, "dev")).rejects.toBeInstanceOf(NoShardCapacity);
    await reg().recordMetrics(s, { cpu_pct: 3, measured_at: { cpu: new Date().toISOString() } });
    expect((await reg().place(T1, site, "dev")).shard.id).toBe(s);
  });

  it("NOT CONFIGURED (a): an unconfigured gateway is not required; configuring it again makes it required", async () => {
    const s = await openShard();
    const now = new Date().toISOString();
    await reg().recordMetrics(s, { records: 1, measured_at: { db: now, cpu: now }, unconfigured: ["gateway"] });
    await expect(reg().place(T1, await newSite(), "dev")).rejects.toBeInstanceOf(NoShardCapacity);
    await reg().recordMetrics(s, { records: 1, measured_at: { db: now, cpu: now, sweep: now }, unconfigured: ["gateway"] });
    expect((await reg().place(T1, await newSite(), "dev")).shard.id).toBe(s);
    await admin.query("update public.site_shards set m_requests_per_min = 1000000 where id = $1", [s]);
    expect((await reg().place(T1, await newSite(), "dev")).shard.id).toBe(s);
    const before = ((await reg().get(s)) as unknown as Record<string, unknown>).metrics_at;
    await reg().recordMetrics(s, { measured_at: { sweep: new Date().toISOString() }, unconfigured: ["gateway"] });
    expect(((await reg().get(s)) as unknown as Record<string, unknown>).metrics_at).toBe(before);
    await reg().recordMetrics(s, { measured_at: { sweep: new Date(Date.now() - 60_000).toISOString() }, unconfigured: [] });
    expect(((await reg().get(s)) as unknown as Record<string, unknown>).m_unconfigured).toEqual(["gateway"]);
    await reg().recordMetrics(s, { records: 1, measured_at: { db: now, cpu: now, sweep: new Date().toISOString() }, unconfigured: [] });
    await expect(reg().place(T1, await newSite(), "dev")).rejects.toBeInstanceOf(NoShardCapacity);
    await expect(reg().recordMetrics(s, { unconfigured: ["db"] } as never)).rejects.toThrow(/unconfigured/);
  });

  it("stale metrics (older than metrics_max_age_s) stop placement; the error counts them", async () => {
    const s = await openShard();
    const old = new Date(Date.now() - 3600_000).toISOString();
    await reg().recordMetrics(s, { measured_at: { db: old, gateway: old, cpu: old } });
    const site = await newSite();
    const e = await reg().place(T1, site, "dev").catch((x) => x);
    expect(e).toBeInstanceOf(NoShardCapacity);
    const raw = await rpcVia(admin)("site_backend_place", { p_tenant_id: T1, p_site_id: site, p_env: "dev" });
    expect(raw.error?.code).toBe("53400");
    expect(raw.error?.message).toMatch(/stale metrics: 1, placement paused: 0/);
  });

  it("measured_at: a future time is clamped to now(), an older one never moves a source back, an absent source keeps its time", async () => {
    const s = await openShard();
    const future = new Date(Date.now() + 10 * 86400_000).toISOString();
    const row1 = (await reg().recordMetrics(s, { measured_at: { db: future, gateway: future, cpu: future } })) as unknown as Record<string, string>;
    expect(new Date(row1.m_db_at).getTime()).toBeLessThanOrEqual(Date.now() + 5000);
    const old = new Date(Date.now() - 86400_000).toISOString();
    const row2 = (await reg().recordMetrics(s, { measured_at: { db: old } })) as unknown as Record<string, string>;
    expect(row2.m_db_at).toBe(row1.m_db_at);
    const row3 = (await reg().recordMetrics(s, { records: 5 })) as unknown as Record<string, string>;
    expect(row3.m_gateway_at).toBe(row1.m_gateway_at);
    await expect(reg().recordMetrics(s, { measured_at: { evil: "x" } as never })).rejects.toThrow(/measured_at/);
    await expect(reg().recordMetrics(s, { measured_at: { db: "not a time" } })).rejects.toThrow(/timestamp/);
  });

  it("OUT OF ORDER: an older read landing last never puts its values under the newer stamp", async () => {
    const s = await openShard();
    const t2 = new Date(Date.now() - 60_000).toISOString();
    const t1 = new Date(Date.now() - 120_000).toISOString();
    await reg().recordMetrics(s, { requests_per_min: 5000, p95_ms: 200, records: 900, cpu_pct: 60, cpu_sample: { idle_s: 2, total_s: 4, at_ms: 2, ncpu: 1 }, measured_at: { db: t2, gateway: t2, cpu: t2 } });
    const row = (await reg().recordMetrics(s, { requests_per_min: 1, p95_ms: 1, records: 1, cpu_pct: 1, cpu_sample: { idle_s: 1, total_s: 1, at_ms: 1, ncpu: 1 }, measured_at: { db: t1, gateway: t1, cpu: t1 } })) as unknown as Record<string, unknown>;
    expect(row).toMatchObject({ m_requests_per_min: 5000, m_p95_ms: 200, m_records: 900, m_cpu_sample: { at_ms: 2 } });
    expect(Number(row.m_cpu_pct)).toBe(60);
    expect(((await reg().recordMetrics(s, { records: 7 })) as unknown as Record<string, unknown>).m_records).toBe(900);
    const s2 = await openShard();
    expect(((await reg().recordMetrics(s2, { records: 7 })) as unknown as Record<string, unknown>).m_records).toBe(7);
  });

  it("resume is compare-and-clear; one rollout lock per env (lease, same holder renews, expired one is taken over)", async () => {
    const s = await openShard();
    await reg().pausePlacement(s, "schema rollout in progress (rollout:b)", null);
    const kept = (await reg().resumePlacement(s, "schema rollout in progress (rollout:a)")) as unknown as Record<string, string | null>;
    expect(kept.placement_paused_reason).toBe("schema rollout in progress (rollout:b)");
    const cleared = (await reg().resumePlacement(s, "schema rollout in progress (rollout:b)")) as unknown as Record<string, string | null>;
    expect(cleared.placement_paused_reason).toBeNull();
    expect(await reg().rolloutClaim("dev", "rollout:a", 3600)).toBe(true);
    expect(await reg().rolloutClaim("dev", "rollout:b", 3600)).toBe(false);
    expect(await reg().rolloutClaim("dev", "rollout:a", 3600)).toBe(true);
    await admin.query("update public.site_shard_rollout_locks set until = now() - interval '1 second' where env = 'dev'");
    expect(await reg().rolloutClaim("dev", "rollout:b", 3600)).toBe(true);
    await reg().rolloutRelease("dev", "rollout:a");
    expect(await reg().rolloutClaim("dev", "rollout:c", 3600)).toBe(false);
    await reg().rolloutRelease("dev", "rollout:b");
    expect(await reg().rolloutClaim("dev", "rollout:c", 3600)).toBe(true);
    await reg().rolloutRelease("dev", "rollout:c");
  });

  it("pause-unless-held: never takes over a pause someone else set; adopts a rollout's own; paused_at restarts on adoption", async () => {
    const ADOPT = ["schema rollout in progress", "schema rollout stopped"];
    const s = await openShard();
    expect(await reg().pausePlacementUnlessHeld(s, "schema rollout in progress (rollout:a)", ADOPT)).toEqual({ taken: true, held_reason: null });
    const a = (await reg().get(s)) as unknown as Record<string, string>;
    expect([a.placement_paused_until, a.placement_paused_reason]).toEqual(["infinity", "schema rollout in progress (rollout:a)"]);
    await reg().pausePlacementUnlessHeld(s, "schema rollout in progress (rollout:a)", ADOPT);
    expect(((await reg().get(s)) as unknown as Record<string, string>).placement_paused_at).toBe(a.placement_paused_at);
    await admin.query("update public.site_shards set placement_paused_reason = 'schema rollout stopped: x', placement_paused_at = now() - interval '5 hours' where id = $1", [s]);
    expect((await reg().pausePlacementUnlessHeld(s, "schema rollout in progress (rollout:b)", ADOPT)).taken).toBe(true);
    const b = (await reg().get(s)) as unknown as Record<string, string>;
    expect(b.placement_paused_reason).toBe("schema rollout in progress (rollout:b)");
    expect(Date.now() - new Date(b.placement_paused_at).getTime()).toBeLessThan(60_000);
    await reg().pausePlacement(s, "staff hold: incident 42", null);
    expect(await reg().pausePlacementUnlessHeld(s, "schema rollout in progress (rollout:c)", ADOPT)).toEqual({ taken: false, held_reason: "staff hold: incident 42" });
    expect(((await reg().get(s)) as unknown as Record<string, string>).placement_paused_reason).toBe("staff hold: incident 42");
    await admin.query("update public.site_shards set placement_paused_until = now() - interval '1 second' where id = $1", [s]);
    expect((await reg().pausePlacementUnlessHeld(s, "schema rollout in progress (rollout:c)", ADOPT)).taken).toBe(true);
    expect((await reg().pausePlacementUnlessHeld(s, "other", [])).taken).toBe(false);
    for (const role of ["anon", "authenticated"]) {
      await admin.query(`begin; set local role ${role}`);
      await expect(admin.query("select * from public.site_shard_placement_pause_unless_held(gen_random_uuid(), 'x', array['y'])")).rejects.toThrow(/permission denied/);
      await admin.query("rollback");
    }
    await reg().resumePlacement(s);
  });

  it("pause bookkeeping: paused_at is kept across a re-pause and cleared on resume", async () => {
    const s = await openShard();
    const a = (await reg().pausePlacement(s, "schema rollout in progress", null)) as unknown as Record<string, string>;
    const b = (await reg().pausePlacement(s, "schema rollout stopped: x", null)) as unknown as Record<string, string>;
    expect(b.placement_paused_at).toBe(a.placement_paused_at);
    expect(b.placement_paused_reason).toBe("schema rollout stopped: x");
    const c = (await reg().resumePlacement(s)) as unknown as Record<string, string | null>;
    expect([c.placement_paused_at, c.placement_paused_until, c.placement_paused_reason]).toEqual([null, null, null]);
  });

  it("a paused shard takes no site until resumed; a lapsed lease places again", async () => {
    const s = await openShard();
    await reg().recordMetrics(s, { measured_at: ALL_NOW() });
    await reg().pausePlacement(s, "schema rollout in progress", 3600);
    const site = await newSite();
    await expect(reg().place(T1, site, "dev")).rejects.toBeInstanceOf(NoShardCapacity);
    await reg().resumePlacement(s);
    expect((await reg().place(T1, site, "dev")).shard.id).toBe(s);
    await reg().pausePlacement(s, "x", null);
    expect(((await reg().get(s)) as unknown as Record<string, string>).placement_paused_until).toBe("infinity");
    await admin.query("update public.site_shards set placement_paused_until = now() - interval '1 second' where id = $1", [s]);
    expect((await reg().place(T1, await newSite(), "dev")).shard.id).toBe(s);
  });

  it("capacity inputs: placements in the last hour / day and the median provisioning lead time", async () => {
    const before = await reg().capacityInputs("dev");
    const s = await openShard();
    await reg().recordMetrics(s, { measured_at: ALL_NOW() });
    await reg().place(T1, await newSite(), "dev");
    await reg().place(T1, await newSite(), "dev");
    await admin.query("insert into public.site_shard_placements (env, shard_id, placed_at) values ('dev', $1, now() - interval '3 hours'), ('dev', $1, now() - interval '8 days')", [s]);
    await admin.query(
      `insert into public.site_shard_autoprov_ledger (env, day, seq, kind, source, shard_name, status, created_at, finished_at) values
       ('dev', current_date, 900, 'create', 'auto', 'zavi-shard-dev-900', 'open', now() - interval '40 minutes', now() - interval '20 minutes'),
       ('dev', current_date, 901, 'create', 'auto', 'zavi-shard-dev-901', 'failed', now() - interval '30 minutes', now())`,
    );
    const after = await reg().capacityInputs("dev");
    expect(after.placements_1h - before.placements_1h).toBe(2);
    expect(after.placements_24h - before.placements_24h).toBe(3);
    expect(after.lead_time_s).toBeCloseTo(1200, -1);
    expect((await admin.query("select count(*)::int as n from public.site_shard_placements where placed_at < now() - interval '7 days'")).rows[0].n).toBe(0);
  });

  it("a site being set up on its own kernel is never placed (20261012020000's refusal kept)", async () => {
    const s = await openShard();
    await reg().recordMetrics(s, { measured_at: ALL_NOW() });
    const site = await newSite();
    await admin.query("insert into public.site_kernel_provisions (site_id, tenant_id) values ($1, $2)", [site, T1]);
    await expect(reg().place(T1, site, "dev")).rejects.toThrow(/its own database/);
  });

  it("a validation shard never takes a customer site, even fresh and open", async () => {
    await admin.query("update public.site_shards set state = 'draining' where state in ('open', 'full')");
    const s = await openShard();
    await reg().recordMetrics(s, { measured_at: ALL_NOW() });
    await admin.query("update public.site_shards set purpose = 'validation' where id = $1", [s]);
    await expect(reg().place(T1, await newSite(), "dev")).rejects.toBeInstanceOf(NoShardCapacity);
  });

  it("S10: build readiness (placementReadiness) agrees with site_backend_place in every state", async () => {
    async function agree(expectPlaceable: boolean, expectCounts: Partial<Record<"open" | "stale" | "paused", number>> = {}) {
      const r = await reg().placementReadiness("dev");
      expect(r.placeable > 0).toBe(expectPlaceable);
      for (const [k, n] of Object.entries(expectCounts)) expect(r[k as "open"]).toBe(n);
      const site = await newSite();
      if (expectPlaceable) expect((await reg().place(T1, site, "dev")).placed).toBe(true);
      else await expect(reg().place(T1, site, "dev")).rejects.toBeInstanceOf(NoShardCapacity);
    }
    await admin.query("update public.site_shards set state = 'draining' where state in ('open', 'full')");
    await agree(false, { open: 0 });
    const s = await openShard();
    await admin.query("update public.site_shards set created_at = now() - interval '25 hours' where id = $1", [s]);
    await agree(false, { open: 1, stale: 1 });
    await reg().recordMetrics(s, { measured_at: ALL_NOW() });
    await agree(true, { open: 1, stale: 0 });
    await reg().pausePlacement(s, "s10 test", null);
    await agree(false, { open: 1, paused: 1 });
    await reg().resumePlacement(s);
    await admin.query("update public.site_shards set m_records = lim_records where id = $1", [s]);
    await agree(false, { open: 1, stale: 0, paused: 0 });
    await admin.query("update public.site_shards set state = 'draining' where id = $1", [s]);
    await agree(false, { open: 0 });
  });

  it("alert claim: once per window per (shard, key)", async () => {
    const s = await openShard();
    expect(await reg().alertClaim(s, "stale:gateway", 3600)).toBe(true);
    expect(await reg().alertClaim(s, "stale:gateway", 3600)).toBe(false);
    expect(await reg().alertClaim(s, "over:p95_ms", 3600)).toBe(true);
    await admin.query("update public.site_shards set m_alerted = jsonb_build_object('stale:gateway', now() - interval '2 hours') where id = $1", [s]);
    expect(await reg().alertClaim(s, "stale:gateway", 3600)).toBe(true);
    await expect(reg().alertClaim(s, "bad key!", 3600)).rejects.toThrow();
  });
});
