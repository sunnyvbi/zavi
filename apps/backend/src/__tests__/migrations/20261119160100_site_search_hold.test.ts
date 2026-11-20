import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { renderHostRecord } from "@/services/sites/host-record";
import { siteStatusBlock } from "@/services/sites/site-build-status";
import type { SiteRow } from "@/services/sites/contract";

const MIGRATIONS = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20261119160100_site_search_hold.sql";
const modules = process.env.SITES_SQL_TEST_MODULES;
const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const D1 = "d000000001-0a1b2c3d";
const D2 = "d000000002-0a1b2c3d";
type Db = { exec: (q: string) => Promise<unknown>; query: (q: string, p?: unknown[]) => Promise<{ rows: any[] }>; close: () => Promise<void> };
let db: Db;
let seq = 0;

async function newSite(tenant: string): Promise<string> {
  seq += 1;
  const id = `bbbbbbbb-0000-4000-8000-${String(seq).padStart(12, "0")}`;
  await db.query("insert into public.sites (id, tenant_id, label, hostname) values ($1, $2, $3, $4)", [id, tenant, `s${seq}`, `s${seq}.zaviagent.com`]);
  return id;
}
const row = async (id: string) => (await db.query("select * from public.sites where id = $1", [id])).rows[0];
const publish = (id: string, deploy: string) => db.query("update public.sites set live_deploy_id = $2, live_sha = 'abc', status = 'live' where id = $1", [id, deploy]);
const release = (tenant: string, id: string) => db.query("select * from public.site_release_search($1, $2)", [tenant, id]);

describe.skipIf(!modules)(`${FILE} executed in Postgres (pglite)`, () => {
  let existing: string;
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
    existing = await newSite(T1);
    await publish(existing, D1);
    const sql = readFileSync(join(MIGRATIONS, FILE), "utf-8");
    await db.exec(sql);
  }, 60_000);
  afterAll(async () => {
    await db?.close();
  });

  it("a site that was live before the migration stays indexable", async () => {
    const r = await row(existing);
    expect(r.search_released_at).not.toBeNull();
    expect(renderHostRecord(r as SiteRow)!.value.noindex).toBeUndefined();
  });

  it("a new site's first publish is held from search, and the host record and status say so", async () => {
    const id = await newSite(T1);
    await publish(id, D1);
    const r = await row(id);
    expect(r.search_released_at).toBeNull();
    expect(renderHostRecord(r as SiteRow)!.value.noindex).toBe(true);
    expect(siteStatusBlock(r as SiteRow).search_hidden).toBe(true);
  });

  it("re-writing the same deploy (a reconcile) keeps it held; the first real edit releases it", async () => {
    const id = await newSite(T1);
    await publish(id, D1);
    await publish(id, D1);
    expect((await row(id)).search_released_at).toBeNull();
    await publish(id, D2);
    const r = await row(id);
    expect(r.search_released_at).not.toBeNull();
    expect(renderHostRecord(r as SiteRow)!.value.noindex).toBeUndefined();
    expect(siteStatusBlock(r as SiteRow).search_hidden).toBeUndefined();
  });

  it("the first build redeploying itself (a repair pass) stays held; only a later run's deploy lifts it", async () => {
    const id = await newSite(T1);
    const root = "cccccccc-0000-4000-8000-000000000001";
    const edit = "cccccccc-0000-4000-8000-000000000002";
    await db.query("insert into public.conductor_runs (id, tenant_id) values ($1, $3), ($2, $3)", [root, edit, T1]);
    await db.query("update public.sites set root_conductor_run_id = $2, publish_run_id = $2 where id = $1", [id, root]);
    await publish(id, D1);
    await publish(id, D2);
    expect((await row(id)).search_released_at).toBeNull();
    await db.query("update public.sites set publish_run_id = $2 where id = $1", [id, edit]);
    await publish(id, "d000000003-0a1b2c3d");
    expect((await row(id)).search_released_at).not.toBeNull();
  });

  it("Looks good releases the site once and bumps host_version so KV is re-projected", async () => {
    const id = await newSite(T1);
    await publish(id, D1);
    const before = await row(id);
    const r = (await release(T1, id)).rows[0];
    expect(r.search_released_at).not.toBeNull();
    expect(Number(r.host_version)).toBe(Number(before.host_version) + 1);
    const again = (await release(T1, id)).rows[0];
    expect(again.search_released_at).toEqual(r.search_released_at);
    expect(Number(again.host_version)).toBe(Number(r.host_version));
  });

  it("another workspace can never release a site", async () => {
    const id = await newSite(T1);
    await publish(id, D1);
    await expect(release(T2, id)).rejects.toThrow(/not found/);
    expect((await row(id)).search_released_at).toBeNull();
  });

  it("running the migration again never releases a held site", async () => {
    const id = await newSite(T1);
    await publish(id, D1);
    await db.exec(readFileSync(join(MIGRATIONS, FILE), "utf-8"));
    expect((await row(id)).search_released_at).toBeNull();
  });

  it("browser roles cannot call the release RPC", async () => {
    const id = await newSite(T1);
    await db.exec("set role authenticated");
    try {
      await expect(release(T1, id)).rejects.toThrow(/permission denied/);
    } finally {
      await db.exec("reset role");
    }
  });
});
