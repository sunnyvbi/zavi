import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { MORE_PER_BUILD, MORE_PER_TENANT_PER_DAY } from "@/services/agents/build-chips-generate";

const MIGRATIONS = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20261025100000_build_chip_more_claims.sql";
const sql = readFileSync(join(MIGRATIONS, FILE), "utf-8");
const modules = process.env.SITES_SQL_TEST_MODULES;

const TA = "11111111-1111-4111-8111-111111111111";
const TB = "22222222-2222-4222-8222-222222222222";
const UA = "a1a1a1a1-0000-4000-8000-000000000001";
const UB = "b2b2b2b2-0000-4000-8000-000000000002";
const BUILD_A1 = "aaaaaaaa-0000-4000-8000-0000000000a1";
const BUILD_A2 = "aaaaaaaa-0000-4000-8000-0000000000a2";
const BUILD_B1 = "bbbbbbbb-0000-4000-8000-0000000000b1";

describe(FILE, () => {
  it("sorts after the migrations it builds on", () => {
    const all = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
    expect(all.indexOf(FILE)).toBeGreaterThan(all.indexOf("20261024140000_meta_ads_lead_form_class.sql"));
  });
});

type Db = { exec: (q: string) => Promise<unknown>; query: (q: string, p?: unknown[]) => Promise<{ rows: any[] }>; close: () => Promise<void> };
let db: Db;

const as = (user: string | null) => db.exec(`select set_config('test.uid', '${user ?? ""}', false)`);
const claim = async (tenant: string, build: string, perBuild = MORE_PER_BUILD, perDay = MORE_PER_TENANT_PER_DAY): Promise<boolean> =>
  (await db.query("select public.claim_build_chip_more($1, $2, $3, $4) as ok", [tenant, build, perBuild, perDay])).rows[0].ok;
const count = async (tenant: string) => Number((await db.query("select count(*)::int as n from public.build_chip_more_claims where tenant_id = $1", [tenant])).rows[0].n);

describe.skipIf(!modules)(`${FILE} executed in Postgres (pglite)`, () => {
  beforeAll(async () => {
    const { PGlite } = createRequire(resolve(modules!, "../package.json"))("@electric-sql/pglite");
    db = new PGlite();
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
      create table public.tenants (id uuid primary key);
      create table public.tenant_users (tenant_id uuid not null, user_id uuid not null);
      create table public.conductor_runs (id uuid primary key, tenant_id uuid not null, kind text not null);
      insert into public.tenants values ('${TA}'), ('${TB}');
      insert into public.tenant_users values ('${TA}', '${UA}'), ('${TB}', '${UB}');
      insert into public.conductor_runs values ('${BUILD_A1}', '${TA}', 'build_app'), ('${BUILD_A2}', '${TA}', 'build_app'), ('${BUILD_B1}', '${TB}', 'build_app');
    `);
    await db.exec(sql);
    await db.exec(sql);
    await as(UA);
  });
  afterAll(async () => db?.close());

  it("keeps the table and the RPC away from anon, and the table away from members", async () => {
    const priv = async (q: string) => Object.values((await db.query(q)).rows[0])[0];
    expect(await priv("select has_table_privilege('authenticated', 'public.build_chip_more_claims', 'select')")).toBe(false);
    expect(await priv("select has_table_privilege('anon', 'public.build_chip_more_claims', 'insert')")).toBe(false);
    expect(await priv("select has_function_privilege('anon', 'public.claim_build_chip_more(uuid, uuid, integer, integer)', 'execute')")).toBe(false);
    expect(await priv("select has_function_privilege('authenticated', 'public.claim_build_chip_more(uuid, uuid, integer, integer)', 'execute')")).toBe(true);
    expect(await priv("select relrowsecurity from pg_class where relname = 'build_chip_more_claims'")).toBe(true);
    expect(await priv("select count(*)::int from pg_policies where tablename = 'build_chip_more_claims'")).toBe(0);
  });

  it("grants exactly the per-build cap, even when every claim fires at once", async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => claim(TA, BUILD_A1)));
    expect(results.filter(Boolean)).toHaveLength(MORE_PER_BUILD);
    expect(await count(TA)).toBe(MORE_PER_BUILD);
    expect(await claim(TA, BUILD_A1)).toBe(false);
  });

  it("caps the tenant per day across builds, and only claims from the last 24 hours count", async () => {
    await db.exec(`insert into public.build_chip_more_claims (tenant_id, build_id) select '${TA}', gen_random_uuid() from generate_series(1, 24)`);
    expect(await claim(TA, BUILD_A2)).toBe(true);
    expect(await claim(TA, BUILD_A2)).toBe(false);
    await db.exec(`update public.build_chip_more_claims set created_at = now() - interval '25 hours' where tenant_id = '${TA}' and build_id not in ('${BUILD_A1}', '${BUILD_A2}')`);
    expect(await claim(TA, BUILD_A2)).toBe(true);
  });

  it("never claims for another tenant or another tenant's build", async () => {
    expect(await claim(TB, BUILD_B1)).toBe(false);
    expect(await count(TB)).toBe(0);
    expect(await claim(TA, BUILD_B1)).toBe(false);
    await as(UB);
    expect(await claim(TB, BUILD_B1)).toBe(true);
    await as(null);
    expect(await claim(TB, BUILD_B1)).toBe(true);
    expect(await count(TB)).toBe(2);
    await as(UA);
  });

  it("a caller cannot raise the caps past the hard maxima (the backend's own caps)", async () => {
    await as(null);
    const b = "cccccccc-0000-4000-8000-0000000000c1";
    await db.exec(`insert into public.conductor_runs values ('${b}', '${TB}', 'build_app')`);
    const results = [];
    for (let i = 0; i < MORE_PER_BUILD + 3; i++) results.push(await claim(TB, b, 1000, 1000));
    expect(results.filter(Boolean)).toHaveLength(MORE_PER_BUILD);
    await as(UA);
  });

  it("refuses nonsense caps and missing ids", async () => {
    expect(await claim(TA, BUILD_A2, 0, 30)).toBe(false);
    expect((await db.query("select public.claim_build_chip_more(null, $1, 5, 30) as ok", [BUILD_A2])).rows[0].ok).toBe(false);
  });
});
