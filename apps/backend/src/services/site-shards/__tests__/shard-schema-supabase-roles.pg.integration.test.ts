import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ShardSql } from "../contract";
import { applyPendingMigrations, applyShardMigration, latestVersion, loadShardMigrations, readLedger } from "../migrations";
import { planCollections } from "../collections-plan";
import { applyCollectionPlan, ensureShardSite, readCollections } from "../shard-ops";

const ON = process.env.SITE_SHARDS_PG === "1";
const PGBIN = process.env.PGBIN ?? "/opt/homebrew/opt/postgresql@17/bin";
const PORT = Number(process.env.SITE_SHARDS_SUPA_PG_PORT ?? 55447);
const ROOT = resolve(__dirname, "../../../../../../infra/site-shard");
const REF = "shardref";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PgClient = any;
const req = createRequire(__filename);

let dir = "";
let su: PgClient;
let pg: PgClient;
let sql: ShardSql;

async function client(user: string): Promise<PgClient> {
  const { Client } = req("pg");
  const c = new Client({ host: "localhost", port: PORT, user, database: "postgres" });
  await c.connect();
  return c;
}

function shardSqlAs(c: PgClient): ShardSql {
  return {
    async query(_ref, q) {
      let r;
      try {
        r = await c.query(q);
      } catch (e) {
        await c.query("rollback").catch(() => undefined);
        throw e;
      }
      const last = Array.isArray(r) ? r.filter((x: { rows?: unknown[]; command?: string }) => x.rows && x.command === "SELECT").pop() ?? r[r.length - 1] : r;
      return last?.rows ?? [];
    },
  };
}

const SUPABASE_SHAPE = `
  create role postgres login nosuperuser createrole createdb replication bypassrls;
  grant create, connect, temporary on database postgres to postgres;
  create role anon nologin noinherit;
  create role authenticated nologin noinherit;
  create role service_role nologin noinherit bypassrls;
  create role authenticator login noinherit;
  grant anon, authenticated, service_role to authenticator;
  grant anon, authenticated, service_role to postgres;
  create role supabase_auth_admin login noinherit createrole;
  create role supabase_storage_admin login noinherit createrole;
`;

const SUPABASE_SCHEMAS = `
  create schema auth authorization supabase_auth_admin;
  create table auth.users (id uuid primary key, email text unique, email_confirmed_at timestamptz, is_anonymous boolean default false);
  create table auth.sessions (id uuid primary key, user_id uuid, created_at timestamptz default now(), not_after timestamptz);
  alter table auth.users owner to supabase_auth_admin;
  alter table auth.sessions owner to supabase_auth_admin;
  grant usage on schema auth to postgres;
  grant all on auth.users, auth.sessions to postgres;

  create schema storage authorization supabase_storage_admin;
  create table storage.buckets (id text primary key, name text not null, public boolean not null default false,
    file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets (id),
    name text not null, owner uuid, owner_id text, metadata jsonb, created_at timestamptz default now(),
    updated_at timestamptz default now(), unique (bucket_id, name));
  alter table storage.objects enable row level security;
  alter table storage.buckets owner to supabase_storage_admin;
  alter table storage.objects owner to supabase_storage_admin;
  -- Stand-in for hosted Supabase's supautils exception that lets postgres manage
  -- policies on storage.objects without owning it (vanilla PG needs ownership).
  grant supabase_storage_admin to postgres;
  grant usage on schema storage to postgres, anon, authenticated, service_role;
  grant all on storage.objects, storage.buckets to postgres, anon, authenticated, service_role;
`;

describe.skipIf(!ON)("shard schema as Supabase's non-superuser postgres (throwaway Postgres 17)", () => {
  const files = ON ? loadShardMigrations(ROOT) : [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "shard-supa-roles-"));
    execFileSync(join(PGBIN, "initdb"), ["-D", join(dir, "data"), "-U", "supabase_admin", "-A", "trust"], { stdio: "ignore" });
    execFileSync(join(PGBIN, "pg_ctl"), ["-D", join(dir, "data"), "-o", `-p ${PORT} -c listen_addresses=localhost -c max_connections=20`, "-l", join(dir, "log"), "-w", "start"], { stdio: "ignore" });
    su = await client("supabase_admin");
    await su.query(SUPABASE_SHAPE);
    await su.query(SUPABASE_SCHEMAS);
    pg =await client("postgres");
    sql = shardSqlAs(pg);
  }, 60_000);

  afterAll(async () => {
    await pg?.end().catch(() => undefined);
    await su?.end().catch(() => undefined);
    if (dir) {
      try {
        execFileSync(join(PGBIN, "pg_ctl"), ["-D", join(dir, "data"), "-m", "immediate", "stop"], { stdio: "ignore" });
      } catch {
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the migration role really is a non-superuser", async () => {
    const r = await pg.query("select rolsuper from pg_roles where rolname = current_user");
    expect(r.rows[0].rolsuper).toBe(false);
  });

  it("resumes from the prod shard's state (0001 applied, the rest pending) to the latest version", async () => {
    await applyShardMigration(sql, REF, files[0]);
    expect([...(await readLedger(sql, REF))]).toEqual(["0001_core"]);

    const r = await applyPendingMigrations(sql, REF, files);
    expect(r.failed, JSON.stringify(r.failed)).toBeUndefined();
    expect(r.applied).toEqual(files.slice(1).map((f) => f.version));
    const ledger = await readLedger(sql, REF);
    expect(ledger.has(latestVersion(files)!)).toBe(true);
    expect(ledger.size).toBe(files.length);
  }, 60_000);

  it("a second run applies nothing and re-verifies every checksum", async () => {
    const r = await applyPendingMigrations(sql, REF, files);
    expect(r.failed, JSON.stringify(r.failed)).toBeUndefined();
    expect(r.pending).toEqual([]);
    expect(r.applied).toEqual([]);
  });

  it("every file re-runs cleanly after a crash between its apply and its ledger record", async () => {
    await su.query("create database shard_rerun");
    await su.query("grant create, connect, temporary on database shard_rerun to postgres");
    const { Client } = req("pg");
    const su2 = new Client({ host: "localhost", port: PORT, user: "supabase_admin", database: "shard_rerun" });
    await su2.connect();
    await su2.query(SUPABASE_SCHEMAS);
    await su2.end();
    const c2 = new Client({ host: "localhost", port: PORT, user: "postgres", database: "shard_rerun" });
    await c2.connect();
    try {
      const sql2 = shardSqlAs(c2);
      for (const f of files) {
        await sql2.query(REF, f.sql);
        await applyShardMigration(sql2, REF, f);
      }
      expect((await readLedger(sql2, REF)).size).toBe(files.length);
      const again = await applyPendingMigrations(sql2, REF, files);
      expect(again.failed, JSON.stringify(again.failed)).toBeUndefined();
      expect(again.pending).toEqual([]);
    } finally {
      await c2.end().catch(() => undefined);
    }
  }, 120_000);

  it("the facade and kernel own their functions but hold NO CREATE on api / zsite", async () => {
    const owners = await su.query(`
      select n.nspname || '.' || p.proname as fn, pg_get_userbyid(p.proowner) as owner
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where (n.nspname = 'api') or (n.nspname = 'zsite' and p.proname like 'k\\_%')`);
    const byFn = new Map<string, Set<string>>();
    for (const r of owners.rows as Array<{ fn: string; owner: string }>) {
      byFn.set(r.fn, (byFn.get(r.fn) ?? new Set()).add(r.owner));
    }
    for (const fn of ["api.list_records", "api.get_record", "api.create_record", "api.update_record", "api.delete_record", "api.transition_record", "api.run_action", "api.aggregate"]) {
      expect(byFn.get(fn), fn).toBeDefined();
    }
    for (const fn of ["zsite.k_transition", "zsite.k_run_action", "zsite.k_recipient_take", "zsite.k_ref_delete", "zsite.k_release_deleted", "zsite.k_platform_delete_record"]) {
      expect([...(byFn.get(fn) ?? [])], fn).toEqual(["zsite_kernel"]);
    }
    const facade = await su.query(`
      select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'api' and pg_get_userbyid(p.proowner) = 'zsite_facade'`);
    expect(facade.rows[0].n).toBeGreaterThanOrEqual(8);

    const privs = await su.query(`
      select r.role, s.schema, has_schema_privilege(r.role, s.schema, 'CREATE') as can_create
      from (values ('zsite_facade'), ('zsite_kernel'), ('anon'), ('authenticated')) r(role),
           (values ('api'), ('zsite')) s(schema)`);
    for (const p of privs.rows as Array<{ role: string; schema: string; can_create: boolean }>) {
      expect(p.can_create, `${p.role} has CREATE on ${p.schema}`).toBe(false);
    }
  });

  it("an anonymous request goes through the facade end to end", async () => {
    const site = "aaaaaaaa-2222-4000-8000-00000000000a";
    await ensureShardSite(sql, REF, site);
    const desired = [{
      name: "bookings", kind: "records" as const,
      rules: { list: ["anyone"], get: ["anyone"], create: ["anyone"] },
      schema: { type: "object", required: ["name"], properties: { name: { type: "string", maxLength: 80 } } },
      fields: {}, indexes: {},
    }];
    const current = await readCollections(sql, REF, site);
    await applyCollectionPlan(sql, REF, site, planCollections(current, desired), current);

    const claims = JSON.stringify({ role: "anon", site_id: site });
    await su.query("begin");
    try {
      await su.query("set local role anon");
      await su.query("select set_config('request.jwt.claims', $1, true)", [claims]);
      await su.query(`select api.create_record('bookings', '{"name":"first"}'::jsonb, 'first-booking-key')`);
      const list = await su.query(`select api.list_records('bookings', '{}'::jsonb, 10, null, null) as r`);
      expect(JSON.stringify(list.rows[0].r)).toContain("first");
      await su.query("commit");
    } catch (e) {
      await su.query("rollback").catch(() => undefined);
      throw e;
    }
  });
});
