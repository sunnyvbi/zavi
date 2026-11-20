import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createShardRegistry } from "../registry";
import { NoShardCapacity, type ShardSql } from "../contract";
import { loadShardMigrations, applyPendingMigrations } from "../migrations";
import { planCollections } from "../collections-plan";
import { REINDEX_BATCH, applyCollectionPlan, ensureShardSite, pendingReindexes, readCollections, reindexCollection, shardSiteLeftovers } from "../shard-ops";
import { deleteSiteBackend, exportSiteBackend, type PooledSiteDeps } from "../pooled-site";
import { createShardStorage } from "../shard-storage";
import { measureShardSql } from "../metrics";
import type { KvStore } from "../gateway-kv";
import type { SiteRow } from "@/services/sites/contract";

const ON = process.env.SITE_SHARDS_PG === "1";
const PGBIN = process.env.PGBIN ?? "/opt/homebrew/opt/postgresql@17/bin";
const PORT = Number(process.env.SITE_SHARDS_PG_PORT ?? 55445);
const SHARD_SQL = process.env.SITE_SHARD_SQL_DIR ?? "";
const REPO = resolve(__dirname, "../../../../../..");
const MIG = join(REPO, "supabase/migrations");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PgClient = any;
const req = createRequire(__filename);

let dir = "";
let admin: PgClient;
let shardDb: PgClient;
const T1 = "aaaaaaaa-0000-4000-8000-00000000000a";
const T2 = "bbbbbbbb-0000-4000-8000-00000000000b";

async function client(db: string): Promise<PgClient> {
  const { Client } = req("pg");
  const c = new Client({ host: "localhost", port: PORT, user: "postgres", database: db });
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
        keys.map((k) => (args[k] !== null && typeof args[k] === "object" ? JSON.stringify(args[k]) : args[k])),
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

function registryOn(c: PgClient) {
  const rpc = rpcVia(c);
  return createShardRegistry({ shardRpc: rpc, tenantRpc: (tid, name, args) => rpc(name, { p_tenant_id: tid, ...args }) });
}

async function newSite(tenant: string): Promise<string> {
  const run = (await admin.query("insert into public.conductor_runs (id, tenant_id) values (gen_random_uuid(), $1) returning id", [tenant])).rows[0].id;
  const r = await admin.query("select (public.site_get_or_create_for_run($1, $2, 'Shop', null, '-dev', 'zaviagent.com')).id", [tenant, run]);
  const id = r.rows[0].id as string;
  await admin.query("select public.site_backend_init_static($1, $2)", [tenant, id]);
  return id;
}

async function openShard(n: number, extra: Record<string, unknown> = {}) {
  const reg = registryOn(admin);
  const s = await reg.register({ env: "dev", name: `zavi-shard-dev-${n}`, region: "us-west-1" });
  await reg.update(s.id, { project_ref: `shardref000${n}`, url: `https://shardref000${n}.supabase.co`, provision_step: "done", state: "open", ...extra });
  return s.id;
}

describe.skipIf(!ON)("site shards on a throwaway Postgres 17", () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "site-shards-pg-"));
    execFileSync(join(PGBIN, "initdb"), ["-D", join(dir, "data"), "-U", "postgres", "-A", "trust"], { stdio: "ignore" });
    execFileSync(join(PGBIN, "pg_ctl"), ["-D", join(dir, "data"), "-o", `-p ${PORT} -c listen_addresses=localhost -c max_connections=80`, "-l", join(dir, "log"), "-w", "start"], { stdio: "ignore" });
    const root = await client("postgres");
    await root.query("create database zavi");
    await root.query("create database shard");
    await root.end();
    admin = await client("zavi");
    await admin.query(readFileSync(join(__dirname, "sql/zavi-db-stubs.sql"), "utf8"));
    await admin.query(readFileSync(join(MIG, "20261008090000_sites.sql"), "utf8"));
    await admin.query(readFileSync(join(MIG, "20261010090000_site_shards.sql"), "utf8"));
    await admin.query(readFileSync(join(MIG, "20261010090000_site_shards.sql"), "utf8"));
    await admin.query("insert into public.tenants values ($1), ($2)", [T1, T2]);
  }, 60_000);

  afterAll(async () => {
    await admin?.end().catch(() => undefined);
    await shardDb?.end().catch(() => undefined);
    if (dir) {
      try {
        execFileSync(join(PGBIN, "pg_ctl"), ["-D", join(dir, "data"), "-m", "immediate", "stop"], { stdio: "ignore" });
      } catch {
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("Zavi DB: registry + placement", () => {
    it("anon / authenticated cannot call any registry or placement RPC", async () => {
      for (const role of ["anon", "authenticated"]) {
        for (const call of [
          "select public.site_shard_list('dev')",
          `select public.site_backend_place('${T1}', gen_random_uuid(), 'dev')`,
          `select public.site_shard_register('dev', 'zavi-shard-dev-99', 'us-west-1', false)`,
        ]) {
          await admin.query(`begin; set local role ${role}`);
          await expect(admin.query(call)).rejects.toThrow(/permission denied/);
          await admin.query("rollback");
        }
        await admin.query(`begin; set local role ${role}`);
        await expect(admin.query("select * from public.site_shards")).rejects.toThrow(/permission denied/);
        await admin.query("rollback");
      }
    });

    it("tenant check: another tenant's id cannot place, release or init a site (and changes nothing)", async () => {
      await openShard(1);
      const site = await newSite(T1);
      const reg = registryOn(admin);
      await expect(reg.place(T2, site, "dev")).rejects.toThrow(/P0002|not found/);
      await expect(reg.release(T2, site, "static")).rejects.toThrow(/P0002|not found/);
      await expect(reg.initStatic(T2, site)).rejects.toThrow(/P0002|not found/);
      const r = (await admin.query("select shard_id, backend_mode from public.sites where id = $1", [site])).rows[0];
      expect(r).toEqual({ shard_id: null, backend_mode: "static" });
    });

    it("a dedicated site is never placed; a site with a project never becomes static", async () => {
      const run = (await admin.query("insert into public.conductor_runs (id, tenant_id) values (gen_random_uuid(), $1) returning id", [T1])).rows[0].id;
      const id = (await admin.query("select (public.site_get_or_create_for_run($1, $2, 'Ded', null, '-dev', 'zaviagent.com')).id", [T1, run])).rows[0].id;
      await admin.query("select public.site_provider_claim($1, $2, 'supabase_project', '{}'::jsonb)", [T1, id]);
      const reg = registryOn(admin);
      await expect(reg.initStatic(T1, id)).rejects.toThrow(/dedicated/);
      await expect(reg.place(T1, id, "dev")).rejects.toThrow(/dedicated/);
    });

    it("RACE: 14 concurrent placements on 2 shards of capacity 5 place exactly 10, never past a cap", async () => {
      await admin.query("update public.site_shards set state = 'retired' where state <> 'retired' and site_count = 0");
      await admin.query("update public.site_shards set state = 'draining' where state = 'open'");
      const a = await openShard(11, { max_sites: 5, fill_ratio: 1 });
      const b = await openShard(12, { max_sites: 5, fill_ratio: 1 });
      const sites = await Promise.all(Array.from({ length: 14 }, () => newSite(T1)));
      const clients = await Promise.all(sites.map(() => client("zavi")));
      const results = await Promise.allSettled(sites.map((s, i) => registryOn(clients[i]).place(T1, s, "dev")));
      await Promise.all(clients.map((c) => c.end()));
      const ok = results.filter((r) => r.status === "fulfilled");
      const odd = results.filter((r) => r.status === "rejected" && !((r as PromiseRejectedResult).reason instanceof NoShardCapacity));
      expect(odd.map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);
      const full = results.filter((r) => r.status === "rejected" && (r as PromiseRejectedResult).reason instanceof NoShardCapacity);
      expect(ok).toHaveLength(10);
      expect(full).toHaveLength(4);
      const counts = (await admin.query("select id, site_count, (select count(*)::int from public.sites s where s.shard_id = sh.id) as bound from public.site_shards sh where id in ($1, $2)", [a, b])).rows;
      for (const c of counts) {
        expect(c.site_count).toBe(5);
        expect(c.bound).toBe(5);
      }
      const prov = (await admin.query("select count(*)::int as n from public.site_providers where kind = 'pooled_backend' and site_id = any($1)", [sites])).rows[0].n;
      expect(prov).toBe(10);
    });

    it("RACE: 8 concurrent placements of ONE site take one slot", async () => {
      await admin.query("update public.site_shards set state = 'draining' where state = 'open'");
      const s = await openShard(21, { max_sites: 50 });
      const site = await newSite(T1);
      const clients = await Promise.all(Array.from({ length: 8 }, () => client("zavi")));
      const rs = await Promise.all(clients.map((c) => registryOn(c).place(T1, site, "dev")));
      await Promise.all(clients.map((c) => c.end()));
      expect(rs.filter((r) => r.placed)).toHaveLength(1);
      expect(new Set(rs.map((r) => r.shard.id))).toEqual(new Set([s]));
      expect((await admin.query("select site_count from public.site_shards where id = $1", [s])).rows[0].site_count).toBe(1);
    });

    it("placement is least-loaded by MEASURED metrics, not site count; full / draining shards are skipped", async () => {
      await admin.query("update public.site_shards set state = 'draining' where state = 'open'");
      const busy = await openShard(31);
      const roomy = await openShard(32);
      const reg = registryOn(admin);
      await reg.recordMetrics(busy, { records: 14_000_000, auth_users: 10 });
      await admin.query("update public.site_shards set site_count = 300 where id = $1", [roomy]);
      const site1 = await newSite(T1);
      expect((await reg.place(T1, site1, "dev")).shard.id).toBe(roomy);
      const after = await reg.recordMetrics(roomy, { emails_per_hour: 19_000 });
      expect(after.state).toBe("full");
      const site2 = await newSite(T1);
      expect((await reg.place(T1, site2, "dev")).shard.id).toBe(busy);
      expect((await reg.recordMetrics(roomy, { emails_per_hour: 0 })).state).toBe("open");
      await expect(reg.recordMetrics(roomy, { records: -1 })).rejects.toThrow(/bad metric/);
      await expect(reg.recordMetrics(roomy, { evil: 1 } as never)).rejects.toThrow(/bad metric/);
    });

    it("state machine + write-once project ref; release frees the slot", async () => {
      const reg = registryOn(admin);
      const id = await openShard(41);
      await expect(reg.update(id, { project_ref: "otherprojectref" })).rejects.toThrow(/write-once/);
      await expect(reg.update(id, { state: "provisioning" })).rejects.toThrow(/not allowed/);
      const half = await reg.register({ env: "dev", name: "zavi-shard-dev-42", region: "us-west-1" });
      await reg.update(half.id, { project_ref: "halfprovisioned1", url: "https://halfprovisioned1.supabase.co", provision_step: "auth_config" });
      await expect(reg.update(half.id, { state: "open" })).rejects.toThrow(/not fully provisioned/);
      await admin.query("update public.site_shards set state = 'draining' where state = 'open' and id <> $1", [id]);
      const site = await newSite(T1);
      await reg.place(T1, site, "dev");
      await reg.update(id, { state: "draining" });
      await expect(reg.update(id, { state: "retired" })).rejects.toThrow(/still holds/);
      expect(await reg.release(T1, site, "static")).toBe(true);
      expect(await reg.release(T1, site, "static")).toBe(false);
      expect((await reg.update(id, { state: "retired" })).state).toBe("retired");
      const row = (await admin.query("select shard_id, backend_mode from public.sites where id = $1", [site])).rows[0];
      expect(row).toEqual({ shard_id: null, backend_mode: "static" });
    });

    it("shard secrets live in Vault (no plaintext column), service-role only; checksum ledger is first-write-wins", async () => {
      const reg = registryOn(admin);
      const id = await openShard(51);
      await reg.setSecret(id, "broker_db_url", "postgresql://zsite_broker:pw1@db.x.supabase.co:5432/postgres");
      await reg.setSecret(id, "broker_db_url", "postgresql://zsite_broker:pw2@db.x.supabase.co:5432/postgres");
      expect(await reg.getSecret(id, "broker_db_url")).toMatch(/pw2/);
      expect(await reg.getSecret(id, "hook_secret")).toBeNull();
      const cols = (await admin.query("select column_name from information_schema.columns where table_name = 'site_shard_secrets'")).rows.map((r: { column_name: string }) => r.column_name).sort();
      expect(cols).toEqual(["name", "shard_id", "updated_at", "vault_secret_id"]);
      expect((await admin.query("select count(*)::int as n from vault.secrets where secret like '%pw1%'")).rows[0].n).toBe(0);
      await expect(reg.setSecret(id, "evil" as never, "x")).rejects.toThrow(/unknown secret/);
      for (const role of ["anon", "authenticated"]) {
        await admin.query(`begin; set local role ${role}`);
        await expect(admin.query(`select public.site_shard_secret_get('${id}', 'broker_db_url')`)).rejects.toThrow(/permission denied/);
        await admin.query("rollback");
      }
      const a = "a".repeat(64);
      expect(await reg.record(id, "0001_core", a)).toBe(a);
      expect(await reg.record(id, "0001_core", "b".repeat(64))).toBe(a);
    });

    it("site_host_bump: monotonic version, tenant-checked, binding shape enforced, tombstone never revived", async () => {
      const site = await newSite(T1);
      const rpc = rpcVia(admin);
      const b = { shard_id: "abcdefghijklmnopqrst", shard_url: "https://abcdefghijklmnopqrst.supabase.co", status: "active", manifest_hash: "m" };
      const r1 = await rpc("site_host_bump", { p_tenant_id: T1, p_site_id: site, p_set_binding: false, p_binding: null });
      const r2 = await rpc("site_host_bump", { p_tenant_id: T1, p_site_id: site, p_set_binding: true, p_binding: b });
      expect([(r1.data as SiteRow[])[0].host_version, (r2.data as SiteRow[])[0].host_version]).toEqual([1, 2]);
      expect((await rpc("site_host_bump", { p_tenant_id: T2, p_site_id: site, p_set_binding: false, p_binding: null })).error?.code).toBe("P0002");
      for (const bad of [{ ...b, shard_url: "https://evil.example.com" }, { ...b, extra: 1 }, { ...b, status: "open" }]) {
        expect((await rpc("site_host_bump", { p_tenant_id: T1, p_site_id: site, p_set_binding: true, p_binding: bad })).error?.message).toMatch(/sites_gateway_binding_shape/);
      }
      await rpc("site_host_bump", { p_tenant_id: T1, p_site_id: site, p_set_binding: true, p_binding: { ...b, status: "tombstoned" } });
      expect((await rpc("site_host_bump", { p_tenant_id: T1, p_site_id: site, p_set_binding: true, p_binding: b })).error?.message).toMatch(/tombstoned/);
      const clients = await Promise.all(Array.from({ length: 6 }, () => client("zavi")));
      const vs = await Promise.all(clients.map(async (c) => ((await rpcVia(c)("site_host_bump", { p_tenant_id: T1, p_site_id: site, p_set_binding: false, p_binding: null })).data as SiteRow[])[0].host_version));
      await Promise.all(clients.map((c) => c.end()));
      expect(new Set(vs).size).toBe(6);
    });

    it("existing rows default to dedicated, and the mode/shard pairing is enforced", async () => {
      const site = await newSite(T1);
      await expect(admin.query("update public.sites set backend_mode = 'pooled' where id = $1", [site])).rejects.toThrow(/sites_shard_matches_mode/);
      expect((await admin.query("select column_default from information_schema.columns where table_name = 'sites' and column_name = 'backend_mode'")).rows[0].column_default).toMatch(/dedicated/);
    });
  });

  describe.skipIf(!SHARD_SQL || !existsSync(join(SHARD_SQL, "migrations")))("shard side (S1 schema)", () => {
    const A = "aaaaaaaa-1111-4000-8000-00000000000a";
    const B = "bbbbbbbb-1111-4000-8000-00000000000b";
    let sql: ShardSql;
    let v2Shard = false;

    beforeAll(async () => {
      shardDb = await client("shard");
      await shardDb.query(`
        create role authenticator login noinherit;
        grant anon, authenticated, service_role to authenticator;
        create schema storage;
        create table storage.buckets (id text primary key, name text not null, public boolean not null default false,
          file_size_limit bigint, allowed_mime_types text[]);
        create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets (id),
          name text not null, owner uuid, owner_id text, metadata jsonb, created_at timestamptz default now(),
          updated_at timestamptz default now(), unique (bucket_id, name));
        alter table storage.objects enable row level security;
        grant usage on schema storage to anon, authenticated, service_role;
        grant all on storage.objects, storage.buckets to anon, authenticated, service_role;
        create role supabase_auth_admin nologin noinherit;
        create schema auth;
        create table auth.users (id uuid primary key, email text unique, email_confirmed_at timestamptz, is_anonymous boolean default false);
        grant usage on schema auth to supabase_auth_admin;
        grant all on auth.users to supabase_auth_admin;
        create table auth.sessions (id uuid primary key, user_id uuid, not_after timestamptz);`);
      sql = {
        async query(_ref, q) {
          let r;
          try {
            r = await shardDb.query(q);
          } catch (e) {
            await shardDb.query("rollback").catch(() => undefined);
            throw e;
          }
          const last = Array.isArray(r) ? r.filter((x: { rows?: unknown[]; command?: string }) => x.rows && x.command === "SELECT").pop() ?? r[r.length - 1] : r;
          return last?.rows ?? [];
        },
      };
      const applied = await applyPendingMigrations(sql, "shardref", loadShardMigrations(SHARD_SQL));
      expect(applied.failed, JSON.stringify(applied.failed)).toBeUndefined();
      expect((await applyPendingMigrations(sql, "shardref", loadShardMigrations(SHARD_SQL))).pending).toEqual([]);
      v2Shard = (await shardDb.query("select to_regclass('zsite.site_contracts') is not null as p")).rows[0].p === true;
    }, 60_000);

    const def = (name: string, over: Record<string, unknown> = {}) => ({
      name,
      kind: "records" as const,
      rules: { list: ["admin"], get: ["admin"], create: ["anyone"] },
      schema: { type: "object", required: ["name"], properties: { name: { type: "string", maxLength: 80 }, day: { type: "string", maxLength: 10 } } },
      fields: {},
      indexes: {},
      ...over,
    });

    async function apply(site: string, desired: ReturnType<typeof def>[]) {
      const current = await readCollections(sql, "shardref", site);
      const plan = planCollections(current, desired);
      await applyCollectionPlan(sql, "shardref", site, plan, current);
      return plan;
    }

    it("manifest apply: add, change, archive (data kept), refuse an invalid definition", async () => {
      await ensureShardSite(sql, "shardref", A);
      await ensureShardSite(sql, "shardref", B);
      expect((await apply(A, [def("bookings"), def("reviews")])).add).toHaveLength(2);
      await shardDb.query(`insert into zsite.records (site_id, collection, id, data) values ('${A}', 'reviews', gen_random_uuid(), '{"name":"great"}')`);
      const p = await apply(A, [def("bookings", { rules: { list: ["anyone"], get: ["anyone"], create: ["anyone"] } })]);
      expect(p.change.map((c) => c.name)).toEqual(["bookings"]);
      expect(p.archive).toEqual(["reviews"]);
      const cols = await readCollections(sql, "shardref", A);
      expect(cols.find((c) => c.name === "reviews")?.archived).toBe(true);
      expect((await shardDb.query(`select count(*)::int as n from zsite.records where site_id = '${A}' and collection = 'reviews'`)).rows[0].n).toBe(1);
      await expect(apply(A, [def("bookings", { rules: { delete: ["anyone"] } })])).rejects.toThrow(/collections_valid|check constraint/);
      expect(await readCollections(sql, "shardref", B)).toEqual([]);
    });

    it("refuses a stale plan; an index change on a collection WITH records is applied and reindexed (S1 0005)", async () => {
      const stale = await readCollections(sql, "shardref", A);
      await apply(A, [def("bookings"), def("extra")]);
      const plan = planCollections(stale, [def("bookings")]);
      await expect(applyCollectionPlan(sql, "shardref", A, plan, stale)).rejects.toThrow(/collections_changed/);
      await shardDb.query(`insert into zsite.records (site_id, collection, id, data) values ('${A}', 'bookings', gen_random_uuid(), '{"name":"x","day":"mon"}')`);
      const p2 = await apply(A, [def("bookings", { indexes: { day: { type: "text", ops: ["eq"], sort: false } } }), def("extra")]);
      expect(p2.reindex).toEqual(["bookings"]);
      const pending = await pendingReindexes(sql, "shardref", A);
      expect(pending.map((x) => x.name)).toEqual(["bookings"]);
      expect(await reindexCollection(sql, "shardref", A, "bookings")).toBe(true);
      expect(await pendingReindexes(sql, "shardref", A)).toEqual([]);
    });

    it("reindex contract: reindex_batch is a FUNCTION the backend SELECTs, reindex_collection a PROCEDURE; multi-batch rebuild fills the slots", async () => {
      const kinds = (await shardDb.query(
        `select p.proname, p.prokind, pg_get_function_identity_arguments(p.oid) as args
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'zsite' and p.proname in ('reindex_batch', 'reindex_collection') order by 1`,
      )).rows;
      expect(kinds).toEqual([
        { proname: "reindex_batch", prokind: "f", args: "p_site uuid, p_collection text, p_after uuid, p_gen integer, p_batch integer" },
        { proname: "reindex_collection", prokind: "p", args: "IN p_site uuid, IN p_collection text, IN p_batch integer" },
      ]);
      const C = "cccccccc-1111-4000-8000-00000000000c";
      await ensureShardSite(sql, "shardref", C);
      await apply(C, [def("slots")]);
      const n = REINDEX_BATCH * 2 + 123;
      await shardDb.query(`insert into zsite.records (site_id, collection, id, data)
        select '${C}', 'slots', gen_random_uuid(), jsonb_build_object('name', 'r' || g, 'day', 'd' || (g % 7)) from generate_series(1, ${n}) g`);
      const p = await apply(C, [def("slots", { indexes: { day: { type: "text", ops: ["eq"], sort: false } } })]);
      expect(p.reindex).toEqual(["slots"]);
      expect(await reindexCollection(sql, "shardref", C, "slots", 2)).toBe(false);
      expect((await pendingReindexes(sql, "shardref", C)).map((x) => x.name)).toEqual(["slots"]);
      expect(await reindexCollection(sql, "shardref", C, "slots")).toBe(true);
      expect(await pendingReindexes(sql, "shardref", C)).toEqual([]);
      const filled = (await shardDb.query(
        `select count(*)::int as n from zsite.records where site_id = '${C}' and collection = 'slots' and t1 is not distinct from (data->>'day')`,
      )).rows[0].n;
      expect(filled).toBe(n);
      await shardDb.query(`call zsite.reindex_collection('${C}', 'slots', 1000)`);
    });

    it("archive sets archived_at and keeps the rules; re-declaring clears it", async () => {
      const before = (await readCollections(sql, "shardref", A)).find((c) => c.name === "extra")!;
      await apply(A, [def("bookings", { indexes: { day: { type: "text", ops: ["eq"], sort: false } } })]);
      const archived = (await readCollections(sql, "shardref", A)).find((c) => c.name === "extra")!;
      expect(archived.archived).toBe(true);
      expect(archived.rules).toEqual(before.rules);
      await apply(A, [def("bookings", { indexes: { day: { type: "text", ops: ["eq"], sort: false } } }), def("extra")]);
      expect((await readCollections(sql, "shardref", A)).find((c) => c.name === "extra")!.archived).toBe(false);
    });

    it("export (v2 NDJSON stream): this site's data only", async (ctx) => {
      if (!v2Shard) return ctx.skip();
      await apply(B, [def("bookings")]);
      await shardDb.query(`insert into zsite.records (site_id, collection, id, data) values ('${B}', 'bookings', gen_random_uuid(), '{"name":"b-only"}')`);
      const reg = { get: async () => ({ id: "s", name: "zavi-shard-dev-1", project_ref: "shardref", url: "https://shardref.supabase.co" }) };
      const storage = createShardStorage({ sql, serviceKey: async () => "k" });
      let out = "";
      const r = await exportSiteBackend({ registry: reg as never, sql, storage }, { tenant_id: T1, site: { id: A, tenant_id: T1, shard_id: "s" } as SiteRow }, async (c) => {
        out += c;
      });
      const lines = out.trim().split("\n").map((l) => JSON.parse(l));
      expect(lines[0]).toMatchObject({ t: "head", format: "zavi-site-export", v: 2 });
      expect(r.records).toBe(lines.filter((l) => l.t === "record").length);
      expect(r.records).toBeGreaterThan(0);
      expect(out).not.toContain("b-only");
    });

    it("delete is complete for A (rows, files, members, identities, auth users) and never touches B", async () => {
      const ua = "aaaaaaaa-2222-4000-8000-00000000000a";
      const ub = "bbbbbbbb-2222-4000-8000-00000000000b";
      await shardDb.query(`
        insert into auth.users values ('${ua}'), ('${ub}');
        insert into zsite.identities (site_id, email_norm, auth_user_id, alias) values ('${A}', 'a@x.com', '${ua}', 'alias-a'), ('${B}', 'b@x.com', '${ub}', 'alias-b');
        insert into zsite.members (site_id, user_id, role) values ('${A}', '${ua}', 'admin'), ('${B}', '${ub}', 'admin');
        insert into storage.objects (bucket_id, name) select 'site-files', '${A}/photos/1.png' where exists (select 1 from storage.buckets where id = 'site-files');
        insert into storage.objects (bucket_id, name) select 'site-files', '${B}/photos/1.png' where exists (select 1 from storage.buckets where id = 'site-files');`);
      const metrics = await measureShardSql(sql, "shardref");
      expect(metrics.auth_users).toBe(2);
      const deletedUsers: string[] = [];
      const kvMap = new Map<string, string>();
      const kv: KvStore = { get: async (k) => kvMap.get(k) ?? null, put: async (k, v) => void kvMap.set(k, v) };
      const released: string[] = [];
      const routesRemoved: number[] = [];
      let hv = 0;
      const tomb = { shard_id: "shardref", shard_url: "https://shardref0.supabase.co", status: "tombstoned" as const, manifest_hash: "" };
      const deps: PooledSiteDeps = {
        registry: {
          get: async () => ({ id: "33333333-3333-4333-8333-333333333333", name: "zavi-shard-dev-1", project_ref: "shardref", url: "https://shardref.supabase.co" }),
          release: async (_t: string, s: string) => (released.push(s), true),
        } as never,
        sql,
        storage: createShardStorage({
          sql,
          serviceKey: async () => "service-key",
          fetchFn: async (_url, init) => {
            const names = JSON.parse(init.body as string).prefixes as string[];
            await shardDb.query("delete from storage.objects where bucket_id = 'site-files' and name = any($1)", [names]);
            return { status: 200 };
          },
        }),
        kv,
        bumpHost: async () => ({ id: A, tenant_id: T1, hostname: "shop-a.zaviagent.com", status: "deleting", host_version: ++hv, gateway_binding: tomb } as SiteRow),
        getSite: async () => ({ id: A, tenant_id: T1, hostname: "shop-a.zaviagent.com", status: "deleting", host_version: hv, gateway_binding: tomb } as SiteRow),
        routes: { ensure: async () => undefined, remove: async () => void routesRemoved.push(1) },
        manifest: null,
        auth: {
          ensureFounderAdmin: async () => ({ user_id: ua }),
          ownerMagicLink: async () => "",
          deleteAuthUser: async ({ auth_user_id }) => {
            deletedUsers.push(auth_user_id);
            await shardDb.query("delete from auth.users where id = $1", [auth_user_id]);
          },
        },
        env: () => "dev",
        deleteGuard: { tick: async () => true, maxPerHour: 5, alert: async () => undefined, error: () => undefined },
      };
      const siteA = { id: A, tenant_id: T1, shard_id: "33333333-3333-4333-8333-333333333333", hostname: "shop-a.zaviagent.com", backend_mode: "pooled" } as SiteRow;
      const before = await shardSiteLeftovers(sql, "shardref", B);
      expect(await deleteSiteBackend(deps, { tenant_id: T1, site: siteA })).toBe("deleted");
      expect(Object.values(await shardSiteLeftovers(sql, "shardref", A)).every((n) => n === 0)).toBe(true);
      expect((await shardDb.query(`select count(*)::int as n from storage.objects where name like '${A}/%'`)).rows[0].n).toBe(0);
      expect(deletedUsers).toEqual([ua]);
      expect(released).toEqual([A]);
      expect(routesRemoved.length).toBeGreaterThan(0);
      expect(JSON.parse(kvMap.get("host:shop-a.zaviagent.com") as string).status).toBe("tombstoned");
      expect(await shardSiteLeftovers(sql, "shardref", B)).toEqual(before);
      expect((await shardDb.query(`select count(*)::int as n from auth.users where id = '${ub}'`)).rows[0].n).toBe(1);
      await shardDb.query(`insert into zsite.sites (site_id) values ('${A}')`);
      expect(await deleteSiteBackend(deps, { tenant_id: T1, site: siteA })).toBe("deleted");
    });
  });
});
