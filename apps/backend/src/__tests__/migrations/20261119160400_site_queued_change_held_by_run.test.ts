import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { drainQueuedSiteChange, type QueuedChangeStore } from "@/services/sites/queued-change";

const MIGRATIONS = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20261119160400_site_queued_change_held_by_run.sql";
const modules = process.env.SITES_SQL_TEST_MODULES;
const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const ROOT = "aaaaaaaa-0000-4000-8000-000000000001";
type Db = { exec: (q: string) => Promise<unknown>; query: (q: string, p?: unknown[]) => Promise<{ rows: any[] }>; close: () => Promise<void> };
let db: Db;
let seq = 0;

const uuid = (prefix: string) => `${prefix}-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

async function newSite(tenant = T1): Promise<string> {
  const id = uuid("bbbbbbbb");
  await db.query("insert into public.sites (id, tenant_id, label, hostname) values ($1, $2, $3, $4)", [id, tenant, `s${seq}`, `s${seq}.zaviagent.com`]);
  return id;
}
async function newRun(site: string | null, status: string, tenant = T1, kind = "build_app"): Promise<string> {
  const id = uuid("cccccccc");
  const graph = site ? [{ payload: { site_id: site } }] : [];
  await db.query("insert into public.conductor_runs (id, tenant_id, status, kind, goal_graph) values ($1, $2, $3, $4, $5)", [id, tenant, status, kind, JSON.stringify(graph)]);
  return id;
}
const queue = async (tenant: string, site: string, message: string, run = ROOT) =>
  (await db.query("select public.site_queue_change($1, $2, $3, $4, null) as r", [tenant, site, run, message])).rows[0].r as string;
const claim = async (tenant: string) => (await db.query("select * from public.site_claim_queued_change($1)", [tenant])).rows;
const held = async (site: string) => (await db.query("select * from public.site_queued_change where site_id = $1", [site])).rows[0];
const setStatus = (run: string, status: string) => db.query("update public.conductor_runs set status = $2 where id = $1", [run, status]);
const discard = async (tenant: string, run: string) =>
  (await db.query("select public.site_discard_queued_change($1, $2) as root", [tenant, run])).rows.map((r) => r.root as string);

const sqlStore: QueuedChangeStore = {
  queue: async (i) => queue(i.tenant_id, i.site_id, i.message, i.conductor_run_id) as Promise<"queued">,
  claim: async (t) => (await claim(t))[0] ?? null,
  settle: async (t, s, r) => void (await db.query("select public.site_settle_queued_change($1, $2, $3)", [t, s, r])),
  dropStopped: async () => [],
};

async function drain(tenant = T1) {
  const refined: string[] = [];
  const out = await drainQueuedSiteChange(tenant, {
    store: sqlStore,
    refine: async (i) => {
      refined.push(i.message);
      return { conductor_run_id: uuid("dddddddd") };
    },
    tick: async () => undefined,
    isBusy: () => false,
    notify: async () => undefined,
  });
  return { out, refined };
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
      create table public.conductor_runs (id uuid primary key, tenant_id uuid not null, status text default 'active', kind text, goal_graph jsonb default '[]'::jsonb, created_at timestamptz default clock_timestamp());
      create table public.tenant_users (user_id uuid, tenant_id uuid, role text);
      create table public.tenant_resources (tenant_id uuid, resource_kind text, external_ref jsonb);
      create function public._build_graph_site_id(p_graph jsonb) returns text language sql immutable as $$ select lower(p_graph->0->'payload'->>'site_id') $$;
      insert into public.tenants values ('${T1}'), ('${T2}');
      insert into public.conductor_runs (id, tenant_id, status) values ('${ROOT}', '${T1}', 'done');
    `);
    await db.exec(readFileSync(join(MIGRATIONS, "20261008090000_sites.sql"), "utf-8"));
    await db.exec(readFileSync(join(MIGRATIONS, "20261119160200_site_queued_change.sql"), "utf-8"));
    const sql = readFileSync(join(MIGRATIONS, FILE), "utf-8");
    await db.exec(sql);
    await db.exec(sql);
  }, 60_000);
  afterAll(async () => {
    await db?.close();
  });

  it("a change held on a refine is never charged after that refine is stopped, though its root run is done", async () => {
    const site = await newSite();
    const refine = await newRun(site, "active");
    await queue(T1, site, "edit 2");
    expect((await held(site)).held_by_run_id).toBe(refine);
    await setStatus(refine, "failed");
    const { out, refined } = await drain();
    expect(refined).toEqual([]);
    expect(out).toEqual({ kind: "empty" });
    expect(await held(site)).toBeUndefined();
  });

  it("a change held on a refine runs once that refine finishes", async () => {
    const site = await newSite();
    const refine = await newRun(site, "active");
    await queue(T1, site, "edit 3");
    await setStatus(refine, "done");
    const { refined } = await drain();
    expect(refined).toEqual(["edit 3"]);
  });

  it("the change is not even claimed while the run it waits on is live", async () => {
    const site = await newSite();
    const refine = await newRun(site, "provisioning");
    await queue(T1, site, "edit 4");
    expect(await claim(T1)).toEqual([]);
    expect((await held(site)).status).toBe("queued");
    await setStatus(refine, "failed");
    expect(await claim(T1)).toEqual([]);
    expect(await held(site)).toBeUndefined();
  });

  it("a run with no site blocks every site, so the change is held on it", async () => {
    const site = await newSite();
    const unbound = await newRun(null, "provisioning");
    await queue(T1, site, "edit 5");
    expect((await held(site)).held_by_run_id).toBe(unbound);
    await setStatus(unbound, "failed");
    await claim(T1);
  });

  it("the site's own run wins over a newer run with no site", async () => {
    const site = await newSite();
    const own = await newRun(site, "active");
    const unbound = await newRun(null, "provisioning");
    await queue(T1, site, "edit 6");
    expect((await held(site)).held_by_run_id).toBe(own);
    await setStatus(own, "failed");
    await setStatus(unbound, "done");
    await claim(T1);
  });

  it("another site's run, another tenant's run and a company goal do not hold the change", async () => {
    const site = await newSite();
    const other = await newSite();
    const otherRun = await newRun(other, "active");
    const foreign = await newRun(site, "active", T2);
    const goal = await newRun(site, "active", T1, "company_goal");
    await queue(T1, site, "edit 7");
    expect((await held(site)).held_by_run_id).toBeNull();
    await setStatus(otherRun, "done");
    await setStatus(foreign, "done");
    await setStatus(goal, "done");
    expect((await drain()).refined).toEqual(["edit 7"]);
  });

  it("a replacing change waits on the run live now, not the one the old change waited on", async () => {
    const site = await newSite();
    const first = await newRun(site, "active");
    await queue(T1, site, "old");
    await setStatus(first, "done");
    const second = await newRun(site, "active");
    expect(await queue(T1, site, "new")).toBe("replaced");
    expect((await held(site)).held_by_run_id).toBe(second);
    await setStatus(second, "failed");
    expect((await drain()).refined).toEqual([]);
  });

  it("discard by the blocking run hands back the root session, so the note lands in the owner's chat", async () => {
    const site = await newSite();
    const refine = await newRun(site, "active");
    await queue(T1, site, "edit 8");
    expect(await discard(T2, refine)).toEqual([]);
    expect(await discard(T1, refine)).toEqual([ROOT]);
    expect(await discard(T1, refine)).toEqual([]);
    expect(await held(site)).toBeUndefined();
  });

  it("a claimed change is not discarded out from under its run", async () => {
    const site = await newSite();
    await queue(T1, site, "edit 9");
    expect(await claim(T1)).toHaveLength(1);
    expect(await discard(T1, ROOT)).toEqual([]);
    expect((await held(site)).status).toBe("running");
    await db.query("delete from public.site_queued_change where site_id = $1", [site]);
  });

  it("the browser roles cannot call discard", async () => {
    const rows = (await db.query(`
      select r.rolname, has_function_privilege(r.rolname, 'public.site_discard_queued_change(uuid, uuid)', 'execute') as d
        from pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role')`)).rows;
    expect(Object.fromEntries(rows.map((r) => [r.rolname, r.d]))).toEqual({ anon: false, authenticated: false, service_role: true });
  });
});
