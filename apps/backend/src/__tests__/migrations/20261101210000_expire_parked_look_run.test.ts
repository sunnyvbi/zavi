import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

type Db = { exec: (q: string) => Promise<unknown>; query: (q: string, p?: unknown[]) => Promise<{ rows: any[] }>; close: () => Promise<void> };
let db: Db;

const FILE = "20261101210000_expire_parked_look_run.sql";
const sql = readFileSync(join(__dirname, "../../../../../supabase/migrations", FILE), "utf-8");
const modules = process.env.SITES_SQL_TEST_MODULES;

const TENANT = "90508030-0000-4000-8000-000000000001";
const OTHER = "90508030-0000-4000-8000-000000000002";
const RUN = "aaaaaaaa-0000-4000-8000-000000000001";
const SITE = "0be55888-0000-4000-8000-00000000000a";

const graph = (parkedAt?: string) =>
  JSON.stringify([
    { id: "n0", status: "done", payload: { stage: "provision", site_id: SITE } },
    { id: "n1", status: "pending", payload: { stage: "build", site_id: SITE, await_look: true, ...(parkedAt ? { await_look_parked_at: parkedAt } : {}) } },
  ]);
const check = async (tenant = TENANT) =>
  (await db.query("select expire_parked_look_run($1, $2, 1800) as r", [tenant, RUN])).rows[0].r as { state: string; parked_at?: string };
const run = async () => (await db.query("select status, failure_reason, goal_graph from conductor_runs where id = $1", [RUN])).rows[0];

describe.skipIf(!modules)(`${FILE}: the website-pick wait, on the database clock (pglite)`, () => {
  beforeAll(async () => {
    const { PGlite } = createRequire(resolve(modules!, "../package.json"))("@electric-sql/pglite");
    db = new PGlite();
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create table conductor_runs (id uuid primary key, tenant_id uuid not null, status text not null, goal_graph jsonb not null default '[]', failure_reason text, updated_at timestamptz default now());
      create table site_design_briefs (site_id uuid primary key, tenant_id uuid not null, chosen_direction text not null default 'brand', chosen_by uuid, chosen_at timestamptz, sealed_at timestamptz, updated_at timestamptz);
      create table sites (id uuid primary key, tenant_id uuid not null, root_conductor_run_id uuid, status text, last_error text);
      create table cancels (run uuid, reason text);
      -- Stand-in for the real cancel (tested in its own migration): flips the run once.
      create function cancel_conductor_run(p_tenant_id uuid, p_conductor_run_id uuid, p_reason text default 'user_cancel', p_require_updated_before timestamptz default null)
      returns jsonb language plpgsql as $$
      declare v uuid;
      begin
        update conductor_runs set status = 'failed', failure_reason = 'Terminated: ' || p_reason
         where id = p_conductor_run_id and tenant_id = p_tenant_id and status in ('provisioning','active') returning id into v;
        if v is null then return jsonb_build_object('ok', true, 'cancelled', false); end if;
        update sites set status = 'failed', last_error = 'Terminated' where tenant_id = p_tenant_id and root_conductor_run_id = p_conductor_run_id;
        insert into cancels values (p_conductor_run_id, p_reason);
        return jsonb_build_object('ok', true, 'cancelled', true);
      end $$;
    `);
    await db.exec(sql);
    await db.exec(sql);
  });
  afterAll(async () => db?.close());
  beforeEach(async () => {
    await db.exec("delete from conductor_runs; delete from site_design_briefs; delete from sites; delete from cancels;");
    await db.query("insert into sites values ($1, $2, $3, 'building', null)", [SITE, TENANT, RUN]);
    await db.query("insert into site_design_briefs (site_id, tenant_id) values ($1, $2)", [SITE, TENANT]);
  });
  const seed = async (g: string, status = "active") =>
    db.query("insert into conductor_runs (id, tenant_id, status, goal_graph) values ($1, $2, $3, $4::jsonb)", [RUN, TENANT, status, g]);

  it("the first check stamps the wait with the database clock and keeps waiting", async () => {
    await seed(graph());
    const r = await check();
    expect(r.state).toBe("waiting");
    expect(typeof r.parked_at).toBe("string");
    expect((await run()).goal_graph[1].payload.await_look_parked_at).toBeTruthy();
    expect((await run()).status).toBe("active");
  });

  it("29 minutes in it waits; past 30 it ends the run once, labelled, and frees the slot", async () => {
    await seed(graph(new Date(Date.now() - 29 * 60_000).toISOString()));
    expect((await check()).state).toBe("waiting");
    await db.query("update conductor_runs set goal_graph = $1::jsonb where id = $2", [graph(new Date(Date.now() - 31 * 60_000).toISOString()), RUN]);
    expect((await check()).state).toBe("expired");
    expect(await run()).toMatchObject({ status: "failed", failure_reason: "Waiting for your pick timed out. Start the build again and pick a website." });
    expect((await db.query("select last_error from sites where id = $1", [SITE])).rows[0].last_error).toMatch(/timed out/);
    expect((await check()).state).toBe("ended");
    expect((await db.query("select count(*)::int as n from cancels")).rows[0].n).toBe(1);
  });

  it("a saved pick always wins, however late", async () => {
    await seed(graph(new Date(Date.now() - 5 * 60 * 60_000).toISOString()));
    await db.query("update site_design_briefs set chosen_at = now() where site_id = $1", [SITE]);
    expect((await check()).state).toBe("picked");
    expect((await run()).status).toBe("active");
  });

  it("another tenant's id finds nothing; a run that is not parked is left alone; only service_role may call it", async () => {
    await seed(graph(new Date(Date.now() - 60 * 60_000).toISOString()));
    expect((await check(OTHER)).state).toBe("not_found");
    expect((await run()).status).toBe("active");
    await db.query("update conductor_runs set goal_graph = $1::jsonb where id = $2", [JSON.stringify([{ id: "n1", status: "pending", payload: { stage: "build", site_id: SITE } }]), RUN]);
    expect((await check()).state).toBe("not_parked");
    const { rows } = await db.query(
      "select r.rolname from pg_roles r where has_function_privilege(r.rolname, 'expire_parked_look_run(uuid, uuid, int)', 'execute') and r.rolname in ('anon','authenticated','service_role') order by 1",
    );
    expect(rows.map((x) => x.rolname)).toEqual(["service_role"]);
  });

  it("a parked pick is saved and the run bumped in one step while the wait is open; a pick that lands after it is refused and ends the run", async () => {
    await seed(graph(new Date(Date.now() - 29 * 60_000).toISOString()));
    const ok = (await db.query("select pick_parked_look($1, $2, 'luxe', null, 1800) as r", [TENANT, RUN])).rows[0].r;
    expect(ok.state).toBe("picked");
    expect((await db.query("select chosen_direction from site_design_briefs where site_id = $1", [SITE])).rows[0].chosen_direction).toBe("luxe");
    await db.exec("delete from conductor_runs; update site_design_briefs set chosen_at = null, chosen_direction = 'brand';");
    await seed(graph(new Date(Date.now() - 31 * 60_000).toISOString()));
    const late = (await db.query("select pick_parked_look($1, $2, 'luxe', null, 1800) as r", [TENANT, RUN])).rows[0].r;
    expect(late.state).toBe("expired");
    expect((await db.query("select chosen_at from site_design_briefs where site_id = $1", [SITE])).rows[0].chosen_at).toBeNull();
    expect((await run()).status).toBe("failed");
  });

  it("the sweep handles only expired (or never-stamped) parked runs, oldest first, so 240 waiting runs never crowd out 10 expired ones", async () => {
    const insert = async (id: string, minutesAgo: number) =>
      db.query("insert into conductor_runs (id, tenant_id, status, goal_graph) values ($1, $2, 'active', $3::jsonb)", [
        id,
        TENANT,
        graph(new Date(Date.now() - minutesAgo * 60_000).toISOString()),
      ]);
    const pad = (n: number) => n.toString(16).padStart(12, "0");
    for (let i = 0; i < 240; i++) await insert(`bbbbbbbb-0000-4000-8000-${pad(i)}`, 5);
    for (let i = 0; i < 10; i++) await insert(`cccccccc-0000-4000-8000-${pad(i)}`, 40 + i);
    expect((await db.query("select expire_parked_look_runs(1800, 5) as n")).rows[0].n).toBe(5);
    expect((await db.query("select expire_parked_look_runs(1800, 200) as n")).rows[0].n).toBe(5);
    expect((await db.query("select count(*)::int as n from conductor_runs where status = 'failed'")).rows[0].n).toBe(10);
    expect((await db.query("select count(*)::int as n from conductor_runs where status = 'active'")).rows[0].n).toBe(240);
  });
});
