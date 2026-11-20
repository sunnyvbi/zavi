import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cleanSiteName, siteLabel } from "@/services/sites/label";

const MIGRATIONS = join(__dirname, "../../../../../supabase/migrations");
const sql = readFileSync(join(MIGRATIONS, "20261010170000_site_names.sql"), "utf-8");
const SIG = "uuid, uuid, text, uuid, text, text, text";

describe("20261010170000_site_names.sql (source)", () => {
  it("adds a nullable sites.name column", () => {
    expect(sql).toMatch(/alter table public\.sites add column if not exists name text;/);
  });

  it("keeps main's 6-arg RPC, replaces only its own 7-arg overload, and grants it to service_role only", () => {
    expect(sql).not.toMatch(/drop function if exists public\.site_get_or_create_for_run\(uuid, uuid, text, uuid, text, text\);/);
    expect(sql).toMatch(/p\.proname = 'site_get_or_create_for_run'\s+and p\.pronargs = 7/);
    expect(sql).not.toMatch(/pronargs\s*(<|>|<>|!=|>=|<=|in)/);
    expect(sql).toMatch(/p_base_domain\s+text,\s*p_site_name\s+text\s*\) returns public\.sites/);
    expect(sql).not.toMatch(/p_site_name\s+text\s+default/);
    expect(sql).toContain(`revoke all on function public.site_get_or_create_for_run(${SIG}) from public, anon, authenticated;`);
    expect(sql).toContain(`grant execute on function public.site_get_or_create_for_run(${SIG}) to service_role;`);
    expect(sql).not.toMatch(/to [^;]*\b(anon|authenticated)\b/);
    expect(sql).toMatch(/security definer\s+set search_path = pg_catalog, pg_temp/);
  });

  it("keeps the run-tenant check, generates id + label server-side and stores the name", () => {
    expect(sql).toMatch(/v_run_tenant is null or v_run_tenant <> p_tenant_id/);
    expect(sql).toMatch(/v_id := gen_random_uuid\(\)/);
    expect(sql).toMatch(/values \(v_id, p_tenant_id, p_run_id, p_started_by, v_label, v_hostname, v_name\)/);
    expect(sql).not.toMatch(/zaviagent/);
  });
});

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

async function create(tenant: string, run: string, company: string, name?: string | null) {
  const args = [tenant, run, company, null, "", "zaviagent.com"];
  const q =
    name === undefined
      ? "select * from public.site_get_or_create_for_run(p_tenant_id => $1, p_run_id => $2, p_company_name => $3, p_started_by => $4, p_hostname_suffix => $5, p_base_domain => $6)"
      : "select * from public.site_get_or_create_for_run(p_tenant_id => $1, p_run_id => $2, p_company_name => $3, p_started_by => $4, p_hostname_suffix => $5, p_base_domain => $6, p_site_name => $7)";
  return (await db.query(q, name === undefined ? args : [...args, name])).rows[0];
}

describe.skipIf(!modules)("20261010170000_site_names.sql executed in Postgres (pglite)", () => {
  beforeAll(async () => {
    const { PGlite } = createRequire(resolve(modules!, "../package.json"))("@electric-sql/pglite");
    db = new PGlite();
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema auth;
      create function auth.uid() returns uuid language sql as 'select null::uuid';
      create table public.tenants (id uuid primary key);
      create table public.conductor_runs (id uuid primary key, tenant_id uuid not null);
      create table public.tenant_users (user_id uuid, tenant_id uuid);
      create table public.tenant_resources (tenant_id uuid, resource_kind text, external_ref jsonb);
      insert into public.tenants values ('${T1}'), ('${T2}');
    `);
    await db.exec(readFileSync(join(MIGRATIONS, "20261008090000_sites.sql"), "utf-8"));
    await db.exec(sql);
    await db.exec(sql);
  }, 60_000);
  afterAll(async () => {
    await db?.close();
  });

  it("the label the database writes equals label.ts for every name, and the name is stored cleaned", async () => {
    for (const name of [
      "Paws and Suds",
      "Paws & Suds",
      "  Still   Water\tYoga  ",
      "The Extremely Long Neighbourhood Dog Grooming Parlour",
      "Café Ünïcode",
      "!!!",
      "api",
      "a-",
      "y".repeat(80),
    ]) {
      const row = await create(T1, await newRun(T1), "Apna Tutor", name);
      expect(row.label, name).toBe(siteLabel("Apna Tutor", T1, row.id, name));
      expect(row.name, name).toBe(cleanSiteName(name));
      expect(row.hostname).toBe(`${row.label}.zaviagent.com`);
    }
  });

  it("a named site's address is named after the site, not the workspace", async () => {
    const row = await create(T1, await newRun(T1), "Apna Tutor", "Paws and Suds");
    expect(row.label).toMatch(/^paws-and-suds-[0-9a-f]{8}-[0-9a-f]{6}$/);
    expect(row.label).not.toContain("apna");
  });

  it("the 6-argument call resolves to main's function and names the site after the workspace, as before", async () => {
    const row = await create(T1, await newRun(T1), "Apna Tutor");
    expect(row.label).toBe(siteLabel("Apna Tutor", T1, row.id));
    expect(row.label).toMatch(/^apna-tutor-/);
    expect(row.name).toBeNull();
  });

  it("a positional 6-argument call, as the shard code makes it, also resolves", async () => {
    const run = await newRun(T1);
    const r = await db.query("select (public.site_get_or_create_for_run($1, $2, 'Shop', null, '-dev', 'zaviagent.com')).hostname", [T1, run]);
    expect(r.rows[0].hostname).toMatch(/^shop-[0-9a-f]{8}-[0-9a-f]{6}-dev\.zaviagent\.com$/);
  });

  it("get-or-create is keyed on the run: a retry with another name returns the first row unchanged", async () => {
    const run = await newRun(T1);
    const first = await create(T1, run, "Apna Tutor", "Paws and Suds");
    const again = await create(T1, run, "Apna Tutor", "Something Else");
    expect(again).toEqual(first);
    expect((await db.query("select count(*)::int as n from public.sites where root_conductor_run_id = $1", [run])).rows[0].n).toBe(1);
  });

  it("two sites with the same name in one workspace still get distinct labels and hostnames", async () => {
    const a = await create(T1, await newRun(T1), "Apna Tutor", "Paws and Suds");
    const b = await create(T1, await newRun(T1), "Apna Tutor", "Paws and Suds");
    expect(a.label).not.toBe(b.label);
    expect(a.hostname).not.toBe(b.hostname);
  });

  it("another tenant's run is refused whatever the name", async () => {
    const foreign = await newRun(T2);
    await expect(create(T1, foreign, "Apna Tutor", "Paws and Suds")).rejects.toThrow(/does not belong to tenant/);
  });

  it("both overloads exist and browser roles can call neither", async () => {
    const sigs = (
      await db.query(
        "select p.oid::regprocedure::text as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'site_get_or_create_for_run' order by 1",
      )
    ).rows.map((r) => r.sig);
    expect(sigs).toEqual([
      "site_get_or_create_for_run(uuid,uuid,text,uuid,text,text)",
      "site_get_or_create_for_run(uuid,uuid,text,uuid,text,text,text)",
    ]);
    const run = await newRun(T1);
    await db.exec("set role authenticated");
    try {
      await expect(create(T1, run, "Apna Tutor", "X")).rejects.toThrow(/permission denied/);
      await expect(create(T1, run, "Apna Tutor")).rejects.toThrow(/permission denied/);
    } finally {
      await db.exec("reset role");
    }
  });
});

describe.skipIf(!modules)("20261010170000_site_names.sql on the staging state (old defaulted 7-arg + restored 6-arg)", () => {
  let st: Db;
  const sitesSql = readFileSync(join(MIGRATIONS, "20261008090000_sites.sql"), "utf-8");
  const fnStart = sitesSql.indexOf("create or replace function public.site_get_or_create_for_run(");
  const grant = "grant execute on function public.site_get_or_create_for_run(uuid, uuid, text, uuid, text, text) to service_role;";
  const restore6 = sitesSql.slice(fnStart, sitesSql.indexOf(grant) + grant.length);
  const oldSiteNames = sql
    .replace(
      /do \$\$\ndeclare\n  f regprocedure;[\s\S]*?\nend\n\$\$;\n/,
      "drop function if exists public.site_get_or_create_for_run(uuid, uuid, text, uuid, text, text);\n",
    )
    .replace(/p_site_name(\s+)text\n/, "p_site_name$1text default null\n");
  const call6 =
    "select (public.site_get_or_create_for_run(p_tenant_id => $1, p_run_id => $2, p_company_name => 'Apna Tutor', p_started_by => null, p_hostname_suffix => '', p_base_domain => 'zaviagent.com')).label";

  beforeAll(async () => {
    const { PGlite } = createRequire(resolve(modules!, "../package.json"))("@electric-sql/pglite");
    st = new PGlite();
    await st.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema auth;
      create function auth.uid() returns uuid language sql as 'select null::uuid';
      create table public.tenants (id uuid primary key);
      create table public.conductor_runs (id uuid primary key, tenant_id uuid not null);
      create table public.tenant_users (user_id uuid, tenant_id uuid);
      create table public.tenant_resources (tenant_id uuid, resource_kind text, external_ref jsonb);
      insert into public.tenants values ('${T1}');
    `);
    await st.exec(sitesSql);
    expect(oldSiteNames).toContain("text default null");
    await st.exec(oldSiteNames);
    await st.exec(restore6);
  }, 60_000);
  afterAll(async () => {
    await st?.close();
  });

  it("on that state a 6-argument call is ambiguous, then the migration makes it resolve to main's function", async () => {
    await st.query("insert into public.conductor_runs (id, tenant_id) values ($1, $2)", ["bbbbbbbb-0000-4000-8000-000000000001", T1]);
    await expect(st.query(call6, [T1, "bbbbbbbb-0000-4000-8000-000000000001"])).rejects.toThrow(/not unique/);

    await st.exec(sql);

    const r = await st.query(call6, [T1, "bbbbbbbb-0000-4000-8000-000000000001"]);
    expect(r.rows[0].label).toMatch(/^apna-tutor-/);
    await st.query("insert into public.conductor_runs (id, tenant_id) values ($1, $2)", ["bbbbbbbb-0000-4000-8000-000000000002", T1]);
    const named = await st.query(
      "select (public.site_get_or_create_for_run(p_tenant_id => $1, p_run_id => $2, p_company_name => 'Apna Tutor', p_started_by => null, p_hostname_suffix => '', p_base_domain => 'zaviagent.com', p_site_name => 'Paws and Suds')).name",
      [T1, "bbbbbbbb-0000-4000-8000-000000000002"],
    );
    expect(named.rows[0].name).toBe("Paws and Suds");
  });
});

describe.skipIf(!modules)("20261010170000_site_names.sql on staging's current state (old defaulted 7-arg only, no 6-arg)", () => {
  let st: Db;
  const sitesSql = readFileSync(join(MIGRATIONS, "20261008090000_sites.sql"), "utf-8");
  const grant7 = "grant execute on function public.site_get_or_create_for_run(uuid, uuid, text, uuid, text, text, text) to service_role;";
  const oldSiteNames = `${sql.slice(0, sql.indexOf(grant7) + grant7.length)}\ncommit;\n`
    .replace(
      /do \$\$\ndeclare\n  f regprocedure;[\s\S]*?\nend\n\$\$;\n/,
      "drop function if exists public.site_get_or_create_for_run(uuid, uuid, text, uuid, text, text);\n",
    )
    .replace(/p_site_name(\s+)text\n/, "p_site_name$1text default null\n");
  const call6 =
    "select (public.site_get_or_create_for_run(p_tenant_id => $1, p_run_id => $2, p_company_name => 'Apna Tutor', p_started_by => null, p_hostname_suffix => '', p_base_domain => 'zaviagent.com')).label";
  const fnArgs = async () =>
    (
      await st.query(
        "select pg_get_function_identity_arguments(p.oid) as args from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'site_get_or_create_for_run' order by p.pronargs",
      )
    ).rows.map((r) => r.args as string);

  beforeAll(async () => {
    const { PGlite } = createRequire(resolve(modules!, "../package.json"))("@electric-sql/pglite");
    st = new PGlite();
    await st.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema auth;
      create function auth.uid() returns uuid language sql as 'select null::uuid';
      create table public.tenants (id uuid primary key);
      create table public.conductor_runs (id uuid primary key, tenant_id uuid not null);
      create table public.tenant_users (user_id uuid, tenant_id uuid);
      create table public.tenant_resources (tenant_id uuid, resource_kind text, external_ref jsonb);
      insert into public.tenants values ('${T1}');
    `);
    await st.exec(sitesSql);
    await st.exec(oldSiteNames);
  }, 60_000);
  afterAll(async () => {
    await st?.close();
  });

  it("6-argument calls keep working after the migration, and the named 7-argument call works too", async () => {
    expect(await fnArgs()).toHaveLength(1);
    await st.query("insert into public.conductor_runs (id, tenant_id) values ($1, $2)", ["cccccccc-0000-4000-8000-000000000001", T1]);
    expect((await st.query(call6, [T1, "cccccccc-0000-4000-8000-000000000001"])).rows[0].label).toMatch(/^apna-tutor-/);

    await st.exec(sql);

    expect(await fnArgs()).toHaveLength(2);
    await st.query("insert into public.conductor_runs (id, tenant_id) values ($1, $2)", ["cccccccc-0000-4000-8000-000000000002", T1]);
    expect((await st.query(call6, [T1, "cccccccc-0000-4000-8000-000000000002"])).rows[0].label).toMatch(/^apna-tutor-/);
    await st.query("insert into public.conductor_runs (id, tenant_id) values ($1, $2)", ["cccccccc-0000-4000-8000-000000000003", T1]);
    const named = await st.query(
      "select (public.site_get_or_create_for_run(p_tenant_id => $1, p_run_id => $2, p_company_name => 'Apna Tutor', p_started_by => null, p_hostname_suffix => '', p_base_domain => 'zaviagent.com', p_site_name => 'Paws and Suds')).name",
      [T1, "cccccccc-0000-4000-8000-000000000003"],
    );
    expect(named.rows[0].name).toBe("Paws and Suds");
  });
});

describe.skipIf(!modules)("20261010170000_site_names.sql on a database that already holds a differently typed 7-argument draft", () => {
  let pg: Db;
  beforeAll(async () => {
    const { PGlite } = createRequire(resolve(modules!, "../package.json"))("@electric-sql/pglite");
    pg = new PGlite();
    await pg.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema auth;
      create function auth.uid() returns uuid language sql as 'select null::uuid';
      create table public.tenants (id uuid primary key);
      create table public.conductor_runs (id uuid primary key, tenant_id uuid not null);
      create table public.tenant_users (user_id uuid, tenant_id uuid);
      create table public.tenant_resources (tenant_id uuid, resource_kind text, external_ref jsonb);
      insert into public.tenants values ('${T1}');
      insert into public.conductor_runs values ('aaaaaaaa-0000-4000-8000-ffffffffffff', '${T1}');
    `);
    await pg.exec(readFileSync(join(MIGRATIONS, "20261008090000_sites.sql"), "utf-8"));
    await pg.exec(`
      create function public.site_get_or_create_for_run(
        p_tenant_id uuid, p_run_id uuid, p_company_name text, p_started_by uuid,
        p_hostname_suffix text, p_base_domain text, p_site_name varchar default null
      ) returns public.sites language sql as 'select null::public.sites';
    `);
    await pg.exec(sql);
  }, 60_000);
  afterAll(async () => {
    await pg?.close();
  });

  it("leaves exactly main's 6-argument function and one 7-argument function, so a named call is never ambiguous", async () => {
    const r = await pg.query(
      "select pronargs, pg_get_function_identity_arguments(oid) as args from pg_proc where proname = 'site_get_or_create_for_run' order by pronargs",
    );
    expect(r.rows.map((x: { pronargs: number }) => x.pronargs)).toEqual([6, 7]);
    expect(r.rows[1].args).not.toMatch(/character varying/);
    const row = (
      await pg.query(
        "select * from public.site_get_or_create_for_run(p_tenant_id => $1, p_run_id => $2, p_company_name => 'Shop', p_started_by => null, p_hostname_suffix => '', p_base_domain => 'zaviagent.com', p_site_name => 'Paws and Suds')",
        [T1, "aaaaaaaa-0000-4000-8000-ffffffffffff"],
      )
    ).rows[0];
    expect(row.name).toBe("Paws and Suds");
  });
});
