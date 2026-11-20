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
const PORT = Number(process.env.SITE_SHARDS_PG_PORT ?? 55466);
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
  const ref = `shardref${String(n).padStart(4, "0")}`;
  await reg().update(s.id, { project_ref: ref, url: `https://${ref}.supabase.co`, provision_step: "done", state: "open", ...extra });
  return s.id as string;
}

async function newSite(): Promise<string> {
  const run = (await admin.query("insert into public.conductor_runs (id, tenant_id) values (gen_random_uuid(), $1) returning id", [T1])).rows[0].id;
  const r = await admin.query("select (public.site_get_or_create_for_run($1, $2, 'Shop', null, '-dev', 'zaviagent.com')).id", [T1, run]);
  const id = r.rows[0].id as string;
  await admin.query("select public.site_backend_init_static($1, $2)", [T1, id]);
  return id;
}

let label = 0;
const previewLabel = () => String(++label).padStart(26, "a").replace(/[0-9]/g, (d) => "abcdefghij"[Number(d)]);

const row = async (id: string) => (await admin.query("select state, m_soft_over, soft_full_at from public.site_shards where id = $1", [id])).rows[0];

let tick = Date.now() - 10 * 60_000;
async function sweep(id: string, m: { rpm?: number; p95?: number; cpu?: number; records?: number }) {
  tick += 1_000;
  const at = new Date(Math.min(tick, Date.now())).toISOString();
  await reg().recordMetrics(id, {
    records: m.records ?? 1,
    requests_per_min: m.rpm ?? 0,
    p95_ms: m.p95 ?? 0,
    cpu_pct: m.cpu ?? 1,
    measured_at: { db: at, gateway: at, cpu: at },
  });
}

describe.skipIf(!ON)("20261016100000 soft signals on a throwaway Postgres 17", () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "soft-signals-pg-"));
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
    await admin.query("alter table public.site_shards drop constraint if exists site_shards_name_check");
    await admin.query("alter table public.sites add column if not exists kernel_shard_id uuid");
    await admin.query(readFileSync(join(MIG, "20261010130000_site_auth_directory_rpc.sql"), "utf8"));
    await admin.query(readFileSync(join(MIG, "20261010160000_site_shard_autoprovision.sql"), "utf8"));
    await admin.query(readFileSync(join(MIG, "20261012050000_site_validation_shards_test_sites.sql"), "utf8"));
    await admin.query("create table if not exists public.site_kernel_provisions (site_id uuid primary key, tenant_id uuid)");
    await admin.query(readFileSync(join(MIG, "20261012090000_site_shard_metrics_freshness.sql"), "utf8"));
    await admin.query(readFileSync(join(MIG, "20261012105000_site_shard_placeable.sql"), "utf8"));
    await admin.query(readFileSync(join(MIG, "20261015010000_site_shard_pause_unless_held.sql"), "utf8"));
    await admin.query(readFileSync(join(MIG, "20261016100000_site_shard_soft_signals.sql"), "utf8"));
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
    await admin.query("update public.site_shards set state = 'draining' where state in ('open', 'full') and purpose = 'pool'");
  });

  it("anon / authenticated can call none of the new functions", async () => {
    for (const role of ["anon", "authenticated"]) {
      for (const q of [
        "select public.site_shard_hard_load(s) from public.site_shards s limit 1",
        "select public.site_shard_soft_load(s) from public.site_shards s limit 1",
      ]) {
        await admin.query(`begin; set local role ${role}`);
        await expect(admin.query(q)).rejects.toThrow(/permission denied/);
        await admin.query("rollback");
      }
    }
  });

  it("PROD 2026-10-02: p95 260 ms at 0 req/min neither closes the only pool shard nor stops placement", async () => {
    const s = await openShard();
    await sweep(s, { rpm: 0, p95: 260 });
    expect(await row(s)).toMatchObject({ state: "open", m_soft_over: 0, soft_full_at: null });
    expect((await reg().place(T1, await newSite(), "dev")).shard.id).toBe(s);
    for (let i = 0; i < 5; i++) await sweep(s, { rpm: 3, p95: 900 });
    expect(await row(s)).toMatchObject({ state: "open", m_soft_over: 0, soft_full_at: null });
  });

  it("a real, sustained overload marks the shard soft-full after 3 readings; it stays open and placeable; clears under 0.9 x fill", async () => {
    const s = await openShard();
    await sweep(s, { rpm: 600, p95: 240 });
    await sweep(s, { rpm: 600, p95: 240 });
    expect(await row(s)).toMatchObject({ state: "open", m_soft_over: 2, soft_full_at: null });
    await sweep(s, { rpm: 600, p95: 190 });
    expect((await row(s)).m_soft_over).toBe(0);
    for (let i = 0; i < 3; i++) await sweep(s, { rpm: 600, cpu: 66 });
    const marked = await row(s);
    expect(marked).toMatchObject({ state: "open", m_soft_over: 3 });
    expect(marked.soft_full_at).not.toBeNull();
    expect((await reg().place(T1, await newSite(), "dev")).shard.id).toBe(s);
    await sweep(s, { rpm: 600, cpu: 52 });
    expect((await row(s)).soft_full_at).not.toBeNull();
    await sweep(s, { rpm: 600, cpu: 20 });
    expect(await row(s)).toMatchObject({ m_soft_over: 0, soft_full_at: null });
  });

  it("placement prefers a healthy shard over a soft-full one, and readiness counts both as placeable", async () => {
    const busy = await openShard();
    for (let i = 0; i < 3; i++) await sweep(busy, { rpm: 600, cpu: 69 });
    const calm = await openShard();
    await sweep(calm, { rpm: 0, cpu: 50 });
    expect((await row(busy)).soft_full_at).not.toBeNull();
    expect((await reg().place(T1, await newSite(), "dev")).shard.id).toBe(calm);
    expect((await reg().place(T1, await newSite(), "dev")).shard.id).toBe(calm);
    const p = await reg().placementReadiness("dev");
    expect(p).toMatchObject({ open: 2, placeable: 2 });
  });

  it("an older (out-of-order) soft reading does not count toward the overload", async () => {
    const s = await openShard();
    await sweep(s, { rpm: 600, cpu: 66 });
    const old = new Date(tick - 5_000).toISOString();
    await reg().recordMetrics(s, { requests_per_min: 600, cpu_pct: 69, measured_at: { gateway: old, cpu: old } });
    expect((await row(s)).m_soft_over).toBe(1);
  });

  it("a replayed (equal-time) reading and a fresh healthy source over a cached bad one never count", async () => {
    const s = await openShard();
    tick += 1_000;
    const at = new Date(tick).toISOString();
    const bad = { records: 1, requests_per_min: 600, p95_ms: 240, cpu_pct: 1, measured_at: { db: at, gateway: at, cpu: at } };
    for (let i = 0; i < 4; i++) await reg().recordMetrics(s, bad);
    expect(await row(s)).toMatchObject({ m_soft_over: 1, soft_full_at: null });
    for (let i = 0; i < 3; i++) {
      tick += 1_000;
      await reg().recordMetrics(s, { cpu_pct: 1, measured_at: { cpu: new Date(tick).toISOString() } });
    }
    expect(await row(s)).toMatchObject({ m_soft_over: 0, soft_full_at: null });
  });

  it("the migration reopens a pool shard the OLD rule closed on soft load alone (not a hard-full one, never validation)", async () => {
    const soft = await openShard();
    const hard = await openShard();
    await admin.query("update public.site_shards set state = 'full', m_p95_ms = 400, m_requests_per_min = 0 where id = $1", [soft]);
    await admin.query("update public.site_shards set state = 'full', m_records = 17000000 where id = $1", [hard]);
    await admin.query(readFileSync(join(MIG, "20261016100000_site_shard_soft_signals.sql"), "utf8"));
    expect((await row(soft)).state).toBe("open");
    expect((await row(hard)).state).toBe("full");
  });

  it("HARD quotas still close a pool shard (and reopen it below 0.9 x fill); a full shard takes nothing", async () => {
    const s = await openShard();
    await sweep(s, { records: 17_000_000 });
    expect((await row(s)).state).toBe("full");
    await expect(reg().place(T1, await newSite(), "dev")).rejects.toBeInstanceOf(NoShardCapacity);
    await sweep(s, { records: 15_000_000 });
    expect((await row(s)).state).toBe("full");
    await sweep(s, { records: 1_000 });
    expect((await row(s)).state).toBe("open");
    await admin.query("update public.site_shards set state = 'full' where id = $1", [s]);
    await sweep(s, { rpm: 0, p95: 400, cpu: 66 });
    expect((await row(s)).state).toBe("open");
  });

  it("test-site placement: an idle validation shard with one slow request still takes test sites; only hard load skips it", async () => {
    const live = await newSite();
    const v = (await admin.query(
      `insert into public.site_shards (env, name, region, project_ref, url, state, provision_step, purpose, max_sites, m_p95_ms, m_requests_per_min, m_db_at, m_gateway_at, m_cpu_at)
       values ('dev', 'zavi-shard-dev-900', 'us-west-1', 'valref000000000000900', 'https://valref000000000000900.supabase.co', 'full', 'done', 'validation', 20, 260, 0, now(), now(), now()) returning id`,
    )).rows[0].id as string;
    const create = async () => {
      await admin.query("begin; set local role service_role");
      try {
        const r = await admin.query("select * from public.site_test_site_create($1, $2, 'dev', 'us-west-1', $3, 'd012345678-0a1b2c3d', 900)", [T1, live, `${previewLabel()}.zavi-preview.dev`]);
        await admin.query("commit");
        return r.rows[0];
      } catch (e) {
        await admin.query("rollback");
        throw e;
      }
    };
    expect((await create()).shard_id).toBe(v);
    await admin.query("update public.site_shards set m_requests_per_min = 600, m_cpu_pct = 69 where id = $1", [v]);
    expect((await create()).shard_id).toBe(v);
    await admin.query("update public.site_shards set m_records = 19000000 where id = $1", [v]);
    await expect(create()).rejects.toMatchObject({ code: "53400" });
  });
});
