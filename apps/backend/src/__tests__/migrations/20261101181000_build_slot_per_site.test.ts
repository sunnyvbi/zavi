import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

type Db = { exec: (q: string) => Promise<unknown>; query: (q: string, p?: unknown[]) => Promise<{ rows: any[] }>; close: () => Promise<void> };
let db: Db;

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      const keys = Object.keys(args);
      const call = keys.map((k, i) => `${k} => $${i + 1}`).join(", ");
      try {
        const { rows } = await db.query(`select ${name}(${call}) as id`, keys.map((k) => args[k]));
        return { data: rows[0].id, error: null };
      } catch (e) {
        const message = (e as Error).message;
        return { data: null, error: { message, ...(/function .* does not exist/.test(message) ? { code: "PGRST202" } : {}) } };
      }
    },
  }),
}));

import {
  refineProduct,
  realRefineProductDeps,
  DoubleBuildInFlight,
  type RefineProductDeps,
} from "@/services/agents/refine-product";
import type { SiteRow } from "@/services/sites/contract";

const MIGRATIONS = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20261101181000_build_slot_per_site.sql";
const sql = readFileSync(join(MIGRATIONS, FILE), "utf-8");
const bucketSql = readFileSync(join(MIGRATIONS, "20260706170000_refine_daily_bucket_discriminator.sql"), "utf-8");
const perSite = readFileSync(join(MIGRATIONS, "20261011090000_continue_build_superseded_per_site.sql"), "utf-8");
const helperSql = perSite.slice(
  perSite.indexOf("create or replace function _build_graph_site_id("),
  perSite.indexOf("create or replace function continue_paused_build("),
);
const modules = process.env.SITES_SQL_TEST_MODULES;

const TENANT = "90508030-0000-4000-8000-000000000001";
const OTHER_TENANT = "90508030-0000-4000-8000-000000000002";
const SITE_A = "0be55888-0000-4000-8000-00000000000a";
const SITE_B = "f6a69b39-0000-4000-8000-00000000000b";
const ROOT_A = "22ac9210-0000-4000-8000-00000000000a";
const ROOT_B = "5f9e2477-0000-4000-8000-00000000000b";

function site(id: string, root: string, repo: string): SiteRow {
  return { id, tenant_id: TENANT, root_conductor_run_id: root, status: "live", github_full_name: repo, hostname: `${id}.zaviagent.com` } as unknown as SiteRow;
}
const A = site(SITE_A, ROOT_A, "Praxis-build/cake-rental-additional");
const B = site(SITE_B, ROOT_B, "Praxis-build/cakey");

function deps(): RefineProductDeps & { updateConductorRunStatus: ReturnType<typeof vi.fn> } {
  const sites = [A, B];
  return {
    loadProvisionedTarget: vi.fn().mockResolvedValue(null),
    loadPriorRefines: vi.fn().mockResolvedValue([]),
    verifyConductorRunOwnership: vi.fn(async (id: string, t: string) => t === TENANT && (id === ROOT_A || id === ROOT_B)),
    loadConductorRunKind: vi.fn(async () => "build_app"),
    loadSiteForRun: vi.fn(async (t: string, id: string) => sites.find((s) => s.tenant_id === t && s.root_conductor_run_id === id) ?? null),
    listSites: vi.fn(async () => sites),
    tryAcquireBuildSlot: realRefineProductDeps.tryAcquireBuildSlot,
    updateConductorRunStatus: vi.fn(async (p: { conductor_run_id: string; status: string; goal_graph?: unknown }) => {
      await db.query("update conductor_runs set status = $1, goal_graph = coalesce($2::jsonb, goal_graph) where id = $3", [
        p.status,
        p.goal_graph === undefined ? null : JSON.stringify(p.goal_graph),
        p.conductor_run_id,
      ]);
    }),
    resolveDailyCap: vi.fn().mockResolvedValue(0),
    loadRepoHeadSha: vi.fn().mockResolvedValue("presha"),
    resolveRefineDirectMergeEnabled: vi.fn().mockResolvedValue(true),
    isFleetHalted: vi.fn().mockResolvedValue(false),
    loadAppPolicy: vi.fn().mockResolvedValue({ protected_globs: [], freeze: false, preview: "branch_preview" }),
  } as unknown as RefineProductDeps & { updateConductorRunStatus: ReturnType<typeof vi.fn> };
}

const siteGraph = (siteId: string, refine: boolean) =>
  JSON.stringify([{ id: "n0", payload: { site_id: siteId, ...(refine ? { refine_mode: true } : {}) } }]);

async function seed(id: string, status: string, graph: string, tenant = TENANT, kind = "build_app") {
  await db.query("insert into conductor_runs (id, tenant_id, objective, status, max_usd, goal_graph, kind) values ($1, $2, 'seed', $3, 5, $4::jsonb, $5)", [
    id, tenant, status, graph, kind,
  ]);
}
const runCount = async () => Number((await db.query("select count(*)::int as n from conductor_runs")).rows[0].n);
const acquire = (site_id?: string | null) =>
  realRefineProductDeps.tryAcquireBuildSlot({
    tenant_id: TENANT, objective: "[refine] x", max_usd: 5, provision_estimate: 0, max_per_day: 100, daily_cap_usd: 0, is_refine: true, site_id,
  });

describe.skipIf(!modules)(`${FILE}: one change at a time PER SITE, executed in Postgres (pglite)`, () => {
  beforeAll(async () => {
    const { PGlite } = createRequire(resolve(modules!, "../package.json"))("@electric-sql/pglite");
    db = new PGlite();
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create table conductor_runs (
        id uuid primary key default gen_random_uuid(),
        tenant_id uuid not null,
        objective text,
        status text not null,
        max_usd numeric,
        goal_graph jsonb not null default '[]'::jsonb,
        kind text default 'build_app',
        created_at timestamptz not null default now(),
        updated_at timestamptz
      );
      create function consume_budget_or_reject(uuid, date, numeric, numeric) returns boolean language sql as $$ select true $$;
    `);
    await db.exec(helperSql);
    await db.exec(bucketSql);
    await db.exec(sql);
    await db.exec(sql);
  });
  afterAll(async () => db?.close());
  beforeEach(async () => {
    await db.exec("delete from conductor_runs");
    await seed(ROOT_A, "done", siteGraph(SITE_A, false));
    await seed(ROOT_B, "active", siteGraph(SITE_B, false));
  });

  it("a change on site A starts while site B's first build is running", async () => {
    const d = deps();
    const r = await refineProduct({ tenant_id: TENANT, message: "rename the site to Cakey", conductor_run_id: ROOT_A }, d);
    expect(r.site_id).toBe(SITE_A);
    const { rows } = await db.query("select status, goal_graph->0->'payload'->>'site_id' as site from conductor_runs where id = $1", [r.conductor_run_id]);
    expect(rows).toEqual([{ status: "active", site: SITE_A }]);
    expect(await runCount()).toBe(3);
  });

  it("a second change on site A is refused while the first is running, and starts nothing", async () => {
    await refineProduct({ tenant_id: TENANT, message: "rename the site to Cakey", conductor_run_id: ROOT_A }, deps());
    expect(await runCount()).toBe(3);
    const d = deps();
    const err = await refineProduct({ tenant_id: TENANT, message: "make the hero pink", conductor_run_id: ROOT_A }, d).catch((e) => e);
    expect(err).toBeInstanceOf(DoubleBuildInFlight);
    expect(await runCount()).toBe(3);
    expect(d.updateConductorRunStatus).not.toHaveBeenCalledWith(expect.objectContaining({ status: "active" }));
  });

  it("a change on site B still waits for site B's own build", async () => {
    const d = deps();
    const err = await refineProduct({ tenant_id: TENANT, message: "new colours", conductor_run_id: ROOT_B }, d).catch((e) => e);
    expect(err).toBeInstanceOf(DoubleBuildInFlight);
    expect(await runCount()).toBe(2);
  });

  it("a just-acquired row with no site yet blocks every site until its graph is written", async () => {
    await db.query("update conductor_runs set status = 'done' where id = $1", [ROOT_B]);
    await seed("aaaaaaaa-0000-4000-8000-0000000000ff", "provisioning", "[]");
    await expect(acquire(SITE_A)).rejects.toBeInstanceOf(DoubleBuildInFlight);
    expect(await runCount()).toBe(3);
  });

  it("an acquire with no site keeps the tenant-wide lock; another tenant and company goals never block", async () => {
    await expect(acquire(null)).rejects.toBeInstanceOf(DoubleBuildInFlight);
    await db.query("update conductor_runs set status = 'done' where id = $1", [ROOT_B]);
    await seed("bbbbbbbb-0000-4000-8000-0000000000ff", "active", siteGraph(SITE_A, true), OTHER_TENANT);
    await seed("cccccccc-0000-4000-8000-0000000000ff", "active", "[]", TENANT, "company_goal");
    await expect(acquire(SITE_A)).resolves.toMatch(/^[0-9a-f-]{36}$/);
  });

  it("a first build parked for the website pick blocks a new build until its wait expires, then a new build is accepted", async () => {
    await db.query("update conductor_runs set status = 'done' where id = $1", [ROOT_B]);
    const parked = JSON.stringify([{ id: "n0", status: "pending", payload: { site_id: SITE_B, await_look: true, await_look_parked_at: "2026-10-12T10:00:00Z" } }]);
    await seed("dddddddd-0000-4000-8000-0000000000ff", "active", parked);
    await expect(acquire(null)).rejects.toBeInstanceOf(DoubleBuildInFlight);
    await db.query("update conductor_runs set status = 'failed' where id = $1", ["dddddddd-0000-4000-8000-0000000000ff"]);
    await expect(acquire(null)).resolves.toMatch(/^[0-9a-f-]{36}$/);
  });

  it("only service_role can execute the new signature, and the old 7-arg overload is gone", async () => {
    const { rows } = await db.query(
      "select r.rolname from pg_roles r where has_function_privilege(r.rolname, 'try_acquire_build_slot(uuid, text, numeric, numeric, int, numeric, boolean, uuid)', 'execute') and r.rolname in ('anon','authenticated','service_role') order by 1",
    );
    expect(rows.map((x) => x.rolname)).toEqual(["service_role"]);
    const { rows: fns } = await db.query("select count(*)::int as n from pg_proc where proname = 'try_acquire_build_slot'");
    expect(fns[0].n).toBe(1);
  });
});
