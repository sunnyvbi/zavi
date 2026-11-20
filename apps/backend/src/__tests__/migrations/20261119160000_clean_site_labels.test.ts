import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cleanSiteLabel, siteShownName } from "@/services/sites/label";

const MIGRATIONS = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20261119160000_clean_site_labels.sql";
const modules = process.env.SITES_SQL_TEST_MODULES;
const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
type Db = { exec: (q: string) => Promise<unknown>; query: (q: string, p?: unknown[]) => Promise<{ rows: any[] }>; close: () => Promise<void> };
let db: Db;
let runSeq = 0;

async function newRun(tenant: string): Promise<string> {
  runSeq += 1;
  const id = `aaaaaaaa-0000-4000-8000-${String(runSeq).padStart(12, "0")}`;
  await db.query("insert into public.conductor_runs (id, tenant_id) values ($1, $2)", [id, tenant]);
  return id;
}

async function create(tenant: string, company: string, name?: string | null, suffix = "") {
  const run = await newRun(tenant);
  const args = [tenant, run, company, null, suffix, "zaviagent.com"];
  const q =
    name === undefined
      ? "select * from public.site_get_or_create_for_run(p_tenant_id => $1, p_run_id => $2, p_company_name => $3, p_started_by => $4, p_hostname_suffix => $5, p_base_domain => $6)"
      : "select * from public.site_get_or_create_for_run(p_tenant_id => $1, p_run_id => $2, p_company_name => $3, p_started_by => $4, p_hostname_suffix => $5, p_base_domain => $6, p_site_name => $7)";
  return (await db.query(q, name === undefined ? args : [...args, name])).rows[0];
}

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
    for (const f of ["20261008090000_sites.sql", "20261010170000_site_names.sql", "20261012130000_reserve_platform_host_labels.sql"]) {
      await db.exec(readFileSync(join(MIGRATIONS, f), "utf-8"));
    }
    const legacy = await create(T1, "Apna Tutor", "Legacy Bakery");
    expect(legacy.label).toMatch(/^legacy-bakery-[0-9a-f]{8}-[0-9a-f]{6}$/);
    const sql = readFileSync(join(MIGRATIONS, FILE), "utf-8");
    await db.exec(sql);
    await db.exec(sql);
  }, 60_000);
  afterAll(async () => {
    await db?.close();
  });

  it("a new site's address is its plain name, with no tenant hash or id", async () => {
    const row = await create(T1, "Apna Tutor", "Home Cleaning San Jose");
    expect(row.label).toBe("home-cleaning-san-jose");
    expect(row.hostname).toBe("home-cleaning-san-jose.zaviagent.com");
    expect(row.label).toBe(cleanSiteLabel("Apna Tutor", row.id, "Home Cleaning San Jose"));
    expect(siteShownName(row)).toBe("Home Cleaning San Jose");
  });

  it("staging keeps its -dev suffix on the plain name", async () => {
    const row = await create(T1, "Apna Tutor", "Staging Florist", "-dev");
    expect(row.label).toBe("staging-florist");
    expect(row.hostname).toBe("staging-florist-dev.zaviagent.com");
  });

  it("the same name from another workspace gets a short suffix and never takes the first site's address", async () => {
    const first = await create(T1, "Apna Tutor", "Paws and Suds");
    const second = await create(T2, "Other Co", "Paws and Suds");
    expect(first.label).toBe("paws-and-suds");
    expect(second.label).toBe(cleanSiteLabel("Other Co", second.id, "Paws and Suds", false));
    expect(second.label).toMatch(/^paws-and-suds-[0-9a-f]{6}$/);
    expect(second.hostname).not.toBe(first.hostname);
    expect(second.tenant_id).toBe(T2);
  });

  it("a reserved platform name is never claimed bare", async () => {
    for (const name of ["api", "Sites Auth", "www", "Jobs"]) {
      const row = await create(T1, "Apna Tutor", name);
      expect(row.label, name).toMatch(/-[0-9a-f]{6}$/);
      expect(row.label, name).toBe(cleanSiteLabel("Apna Tutor", row.id, name, false));
    }
  });

  it("a workspace's built-in address is never taken by a site", async () => {
    await db.query("insert into public.tenant_resources values ($1, 'domain', $2)", [T2, JSON.stringify({ hostname: "river-yoga.zaviagent.com" })]);
    const row = await create(T1, "Apna Tutor", "River Yoga");
    expect(row.label).toMatch(/^river-yoga-[0-9a-f]{6}$/);
  });

  it("a name too short for a DNS label is suffixed instead of failing", async () => {
    const row = await create(T1, "Apna Tutor", "Jo");
    expect(row.label).toMatch(/^jo-[0-9a-f]{6}$/);
    const none = await create(T1, "!!!", "@@@");
    expect(none.label).toMatch(/^site-[0-9a-f]{6}$/);
  });

  it("a long name keeps 40 characters and stays one DNS label with the staging suffix", async () => {
    const name = "The Extremely Long Neighbourhood Dog Grooming Parlour And Spa";
    const row = await create(T1, "Apna Tutor", name, "-dev");
    expect(row.label).toBe(cleanSiteLabel("Apna Tutor", row.id, name));
    expect(row.label.length).toBeLessThanOrEqual(40);
    const again = await create(T2, "Other", name, "-dev");
    expect(`${again.label}-dev`.length).toBeLessThanOrEqual(63);
  });

  it("the 6-argument overload names the site after the company, plain", async () => {
    const row = await create(T1, "Mile High Coffee");
    expect(row.label).toBe("mile-high-coffee");
    expect(row.name).toBeNull();
  });

  it("existing sites keep their old address", async () => {
    const r = await db.query("select label from public.sites where name = 'Legacy Bakery'");
    expect(r.rows[0].label).toMatch(/^legacy-bakery-[0-9a-f]{8}-[0-9a-f]{6}$/);
  });

  it("a retry on the same run returns the first row unchanged", async () => {
    const run = await newRun(T1);
    const call = "select * from public.site_get_or_create_for_run($1, $2, 'Co', null, '', 'zaviagent.com', $3)";
    const a = (await db.query(call, [T1, run, "Retry Cafe"])).rows[0];
    const b = (await db.query(call, [T1, run, "Something Else"])).rows[0];
    expect(b).toEqual(a);
    expect(a.label).toBe("retry-cafe");
  });

  it("browser roles still cannot call either overload", async () => {
    const run = await newRun(T1);
    await db.exec("set role authenticated");
    try {
      await expect(db.query("select * from public.site_get_or_create_for_run($1, $2, 'Co', null, '', 'zaviagent.com', 'X')", [T1, run])).rejects.toThrow(/permission denied/);
      await expect(db.query("select * from public.site_get_or_create_for_run($1, $2, 'Co', null, '', 'zaviagent.com')", [T1, run])).rejects.toThrow(/permission denied/);
    } finally {
      await db.exec("reset role");
    }
  });
});
