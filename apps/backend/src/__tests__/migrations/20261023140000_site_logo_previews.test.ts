import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const MIGRATIONS = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20261023140000_site_logo_previews.sql";
const sql = readFileSync(join(MIGRATIONS, FILE), "utf-8");
const modules = process.env.SITES_SQL_TEST_MODULES;

const TA = "11111111-1111-4111-8111-111111111111";
const TB = "22222222-2222-4222-8222-222222222222";
const SA = "aaaaaaaa-0000-4000-8000-00000000000a";
const SA2 = "aaaaaaaa-0000-4000-8000-0000000000a2";
const UA = "a1a1a1a1-0000-4000-8000-000000000001";

describe(FILE, () => {
  it("sorts after the migration that adds the sites (id, tenant_id) key it references", () => {
    const all = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
    expect(all.indexOf(FILE)).toBeGreaterThan(all.indexOf("20261023090000_site_preview_comments.sql"));
  });

  it("allows one free preview per site, keeps RLS on and gives the browser no access", () => {
    expect(sql).toMatch(/create unique index if not exists site_logo_previews_one_free_per_site\s+on public\.site_logo_previews \(site_id\) where free;/);
    expect(sql).toMatch(/alter table public\.site_logo_previews enable row level security;/);
    expect(sql).toMatch(/revoke all on table public\.site_logo_previews from public, anon, authenticated;/);
    expect(sql).not.toMatch(/\bgrant\b/i);
    expect(sql).toMatch(/foreign key \(site_id, tenant_id\) references public\.sites \(id, tenant_id\) on delete cascade/);
  });
});

type Db = { exec: (q: string) => Promise<unknown>; query: (q: string, p?: unknown[]) => Promise<{ rows: any[] }>; close: () => Promise<void> };
let db: Db;

const claim = (tenant: string, site: string, free: boolean) =>
  db.query("insert into public.site_logo_previews (tenant_id, site_id, description, free) values ($1, $2, 'a fox', $3) returning id", [tenant, site, free]);

describe.skipIf(!modules)(`${FILE} executed in Postgres (pglite)`, () => {
  beforeAll(async () => {
    const { PGlite } = createRequire(resolve(modules!, "../package.json"))("@electric-sql/pglite");
    db = new PGlite();
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
      grant usage on schema public to authenticated, anon;
      create table public.tenants (id uuid primary key);
      create table public.sites (id uuid primary key, tenant_id uuid not null references public.tenants(id) on delete cascade);
      create unique index sites_id_tenant_uq on public.sites (id, tenant_id);
      insert into public.tenants values ('${TA}'), ('${TB}');
      insert into public.sites values ('${SA}', '${TA}'), ('${SA2}', '${TA}');
      grant all on all tables in schema public to anon, authenticated;
      alter default privileges in schema public grant all on tables to anon, authenticated;
    `);
    await db.exec(sql);
    await db.exec(sql);
  });
  afterAll(async () => db?.close());

  it("lets a site have one free preview and any number of paid ones", async () => {
    await expect(claim(TA, SA, true)).resolves.toBeTruthy();
    await expect(claim(TA, SA, true)).rejects.toThrow(/site_logo_previews_one_free_per_site/);
    await expect(claim(TA, SA, false)).resolves.toBeTruthy();
    await expect(claim(TA, SA, false)).resolves.toBeTruthy();
    await expect(claim(TA, SA2, true)).resolves.toBeTruthy();
  });

  it("refuses a preview whose tenant is not the site's tenant", async () => {
    await expect(claim(TB, SA, false)).rejects.toThrow(/site_logo_previews_site_tenant_fk/);
  });

  it("gives a signed-in client no read or write", async () => {
    await db.exec(`set test.uid = '${UA}'; set role authenticated;`);
    try {
      await expect(db.query("select id from public.site_logo_previews")).rejects.toThrow(/permission denied/);
      await expect(claim(TA, SA, false)).rejects.toThrow(/permission denied/);
    } finally {
      await db.exec("reset role; reset test.uid;");
    }
  });
});
