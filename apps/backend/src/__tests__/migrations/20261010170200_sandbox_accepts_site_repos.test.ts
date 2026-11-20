import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dir = join(__dirname, "../../../../../supabase/migrations");
const sql = readFileSync(join(dir, "20261010170200_sandbox_accepts_site_repos.sql"), "utf-8");
const PRIOR = readFileSync(join(dir, "20260529215942_buildapp_sandbox_provisioned_repo.sql"), "utf-8");

function fnBody(src: string): string {
  const start = src.search(/create or replace function get_or_create_tenant_sandbox\(/i);
  expect(start).toBeGreaterThan(-1);
  return src.slice(start, src.indexOf("end $$;", start));
}

describe("20261010170200_sandbox_accepts_site_repos.sql (source)", () => {
  it("is a superset of the prior definition: every prior line survives except the widened accept check", () => {
    const prior = fnBody(PRIOR);
    const next = fnBody(sql);
    const dropped = prior
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 12 && !l.startsWith("--"))
      .filter((l) => !next.includes(l));
    expect(dropped).toEqual(["language plpgsql security definer set search_path = public as $$", "if not (v_connected or v_provisioned) then"]);
    expect(next).toContain("if not (v_connected or v_provisioned or v_site) then");
  });

  it("accepts a site repo only for the same tenant and only while the site is not dead (mirrors provisioned-repo-gate DEAD_SITE_STATUSES)", () => {
    const next = fnBody(sql);
    expect(next).toMatch(/from public\.sites s\s+where s\.tenant_id\s+= p_tenant_id\s+and s\.github_full_name = p_repo_full_name\s+and s\.status not in \('failed', 'fell_back_old', 'deleting', 'deleted'\)/);
  });

  it("keeps security definer, the pinned search_path, and service_role-only execute", () => {
    expect(sql).toMatch(/language plpgsql security definer set search_path = public, pg_temp as \$\$/);
    expect(sql).toContain("revoke all on function public.get_or_create_tenant_sandbox(uuid, text) from public, anon, authenticated;");
    expect(sql).toContain("grant execute on function public.get_or_create_tenant_sandbox(uuid, text) to service_role;");
    expect(sql.trimStart().startsWith("begin;")).toBe(true);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    expect(sql).not.toMatch(/drop (table|column|function)/i);
  });
});

const modules = process.env.SANDBOX_SQL_TEST_MODULES;
const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";

describe.skipIf(!modules)("get_or_create_tenant_sandbox against a real Postgres (PGlite)", () => {
  const m: { db: { query: (q: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>; exec: (q: string) => Promise<unknown>; close: () => Promise<void> } } = {} as never;

  beforeAll(async () => {
    const { PGlite } = createRequire(resolve(modules!, "../package.json"))("@electric-sql/pglite");
    m.db = new PGlite();
    await m.db.exec(`
      create role anon; create role authenticated; create role service_role;
      create table public.tenants (id uuid primary key);
      create table public.connector_metadata (tenant_id uuid, slug text, repo_full_names text[]);
      create table public.tenant_resources (tenant_id uuid, resource_kind text, mode text, external_ref jsonb);
      create table public.sites (id uuid primary key default gen_random_uuid(), tenant_id uuid, github_full_name text, status text);
      create table public.tenant_sandbox (id uuid primary key default gen_random_uuid(), tenant_id uuid, repo_full_name text, status text,
        unique (tenant_id, repo_full_name));
      insert into public.tenants values ('${T1}'), ('${T2}');
      insert into public.connector_metadata values ('${T1}', 'github', array['acme/connected']);
      insert into public.tenant_resources values ('${T1}', 'repo', 'provisioned', '{"github_full_name":"Zavi/first-site"}');
      insert into public.sites (tenant_id, github_full_name, status) values
        ('${T1}', 'Zavi/second-site', 'building'),
        ('${T1}', 'Zavi/live-site', 'live'),
        ('${T1}', 'Zavi/failed-site', 'failed'),
        ('${T1}', 'Zavi/fell-back-site', 'fell_back_old'),
        ('${T1}', 'Zavi/deleting-site', 'deleting'),
        ('${T1}', 'Zavi/deleted-site', 'deleted'),
        ('${T2}', 'Zavi/other-tenant-site', 'live');
    `);
    await m.db.exec(sql);
  });

  afterAll(async () => {
    await m.db?.close();
  });

  const call = (tenant: string, repo: string) =>
    m.db.query("select * from get_or_create_tenant_sandbox($1::uuid, $2)", [tenant, repo]);

  it.each(["Zavi/second-site", "Zavi/live-site"])("opens a sandbox for %s, a second new-flow site of the same workspace", async (repo) => {
    const r = await call(T1, repo);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ tenant_id: T1, repo_full_name: repo, status: "creating" });
  });

  it("returns the same sandbox row on a second call instead of creating another", async () => {
    const a = await call(T1, "Zavi/second-site");
    const b = await call(T1, "Zavi/second-site");
    expect(b.rows[0].id).toBe(a.rows[0].id);
    const n = await m.db.query("select count(*)::int as n from public.tenant_sandbox where repo_full_name = 'Zavi/second-site'");
    expect(n.rows[0].n).toBe(1);
  });

  it.each(["Zavi/failed-site", "Zavi/fell-back-site", "Zavi/deleting-site", "Zavi/deleted-site"])(
    "refuses %s, whose site is dead",
    async (repo) => {
      await expect(call(T1, repo)).rejects.toThrow(/not in tenant connected repos/);
    },
  );

  it("refuses another workspace's site repo, even a live one", async () => {
    await expect(call(T1, "Zavi/other-tenant-site")).rejects.toThrow(/not in tenant connected repos/);
    const n = await m.db.query(`select count(*)::int as n from public.tenant_sandbox where tenant_id = '${T1}' and repo_full_name = 'Zavi/other-tenant-site'`);
    expect(n.rows[0].n).toBe(0);
  });

  it("still accepts the old-flow provisioned repo and an OAuth-connected repo", async () => {
    expect((await call(T1, "Zavi/first-site")).rows[0].repo_full_name).toBe("Zavi/first-site");
    expect((await call(T1, "acme/connected")).rows[0].repo_full_name).toBe("acme/connected");
  });

  it("still refuses an unknown repo with the same message", async () => {
    await expect(call(T1, "Zavi/nobody")).rejects.toThrow("get_or_create_tenant_sandbox: repo Zavi/nobody not in tenant connected repos");
  });

  it("is executable by service_role only", async () => {
    const r = await m.db.query(
      "select r.rolname from pg_roles r where has_function_privilege(r.rolname, 'public.get_or_create_tenant_sandbox(uuid, text)', 'execute') and r.rolname in ('anon','authenticated','service_role') order by 1",
    );
    expect(r.rows.map((x) => x.rolname)).toEqual(["service_role"]);
  });
});
