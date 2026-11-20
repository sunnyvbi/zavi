import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { renderHostRecord } from "@/services/sites/host-record";
import type { SiteRow } from "@/services/sites/contract";

const MIGRATIONS = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20261119160500_site_search_hold_first_site_only.sql";
const modules = process.env.SITES_SQL_TEST_MODULES;
const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
type Db = { exec: (q: string) => Promise<unknown>; query: (q: string, p?: unknown[]) => Promise<{ rows: any[] }>; close: () => Promise<void> };
let db: Db;
let seq = 0;

async function newSite(tenant = T1): Promise<string> {
  seq += 1;
  const id = `bbbbbbbb-0000-4000-8000-${String(seq).padStart(12, "0")}`;
  await db.query("insert into public.sites (id, tenant_id, label, hostname) values ($1, $2, $3, $4)", [id, tenant, `s${seq}`, `s${seq}.zaviagent.com`]);
  return id;
}
const row = async (id: string) => (await db.query("select * from public.sites where id = $1", [id])).rows[0];
const hold = (tenant: string, id: string) => db.query("select public.site_hold_search($1, $2)", [tenant, id]);
const publish = (id: string, deploy: string) => db.query("update public.sites set live_deploy_id = $2, live_sha = 'abc', status = 'live' where id = $1", [id, deploy]);

describe.skipIf(!modules)(`${FILE} executed in Postgres (pglite)`, () => {
  beforeAll(async () => {
    const { PGlite } = createRequire(resolve(modules!, "../package.json"))("@electric-sql/pglite");
    db = new PGlite();
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema auth;
      create function auth.uid() returns uuid language sql as 'select null::uuid';
      create table public.tenants (id uuid primary key);
      create table public.conductor_runs (id uuid primary key, tenant_id uuid not null);
      create table public.tenant_users (user_id uuid, tenant_id uuid, role text);
      create table public.tenant_resources (tenant_id uuid, resource_kind text, external_ref jsonb);
      insert into public.tenants values ('${T1}'), ('${T2}');
    `);
    await db.exec(readFileSync(join(MIGRATIONS, "20261008090000_sites.sql"), "utf-8"));
    await db.exec("alter table public.sites add column if not exists host_version bigint not null default 0");
    await db.exec("alter table public.sites add column if not exists publish_run_id uuid");
    await db.exec(readFileSync(join(MIGRATIONS, "20261119160100_site_search_hold.sql"), "utf-8"));
    const sql = readFileSync(join(MIGRATIONS, FILE), "utf-8");
    await db.exec(sql);
    await db.exec(sql);
  }, 60_000);
  afterAll(async () => {
    await db?.close();
  });

  it("a site made by any path that does not ask for the hold can be found by search", async () => {
    const id = await newSite();
    await publish(id, "d000000001-0a1b2c3d");
    const site = await row(id);
    expect(site.search_released_at).not.toBeNull();
    expect(renderHostRecord(site as SiteRow)!.value.deploy_id).toBe("d000000001-0a1b2c3d");
    expect(renderHostRecord(site as SiteRow)!.value.noindex).toBeUndefined();
  });

  it("a held first site stays out of search through its own deploy", async () => {
    const id = await newSite();
    await hold(T1, id);
    await publish(id, "d000000002-0a1b2c3d");
    const site = await row(id);
    expect(site.search_released_at).toBeNull();
    expect(renderHostRecord(site as SiteRow)!.value.noindex).toBe(true);
  });

  it("a site already live is never pulled back out of search, and another tenant's site is never touched", async () => {
    const live = await newSite();
    await publish(live, "d000000003-0a1b2c3d");
    await hold(T1, live);
    expect((await row(live)).search_released_at).not.toBeNull();
    const other = await newSite(T2);
    await hold(T1, other);
    expect((await row(other)).search_released_at).not.toBeNull();
  });

  it("the browser roles cannot call the hold", async () => {
    const rows = (await db.query(`
      select r.rolname, has_function_privilege(r.rolname, 'public.site_hold_search(uuid, uuid)', 'execute') as h
        from pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role')`)).rows;
    expect(Object.fromEntries(rows.map((r) => [r.rolname, r.h]))).toEqual({ anon: false, authenticated: false, service_role: true });
  });
});
