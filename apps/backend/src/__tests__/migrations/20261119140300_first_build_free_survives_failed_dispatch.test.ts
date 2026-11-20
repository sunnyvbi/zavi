import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

const MODULES = process.env.SITES_SQL_TEST_MODULES;
const DIR = join(__dirname, "../../../../../supabase/migrations");
const read = (f: string) => readFileSync(join(DIR, f), "utf8");
const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const RUN = "33333333-3333-4333-8333-333333333333";
const RUN2 = "44444444-4444-4444-8444-444444444444";

type Db = {
  exec: (q: string) => Promise<unknown>;
  query: <R = Record<string, unknown>>(q: string, p?: unknown[]) => Promise<{ rows: R[] }>;
  close: () => Promise<void>;
};

describe.skipIf(!MODULES)("first build free survives a failed dispatch (20261119140300)", () => {
  let db: Db;
  const addRun = (id: string, tenant = TENANT, spend = 0, kind = "build_app") =>
    db.query("insert into conductor_runs (id, tenant_id, kind, spend_usd) values ($1, $2, $3, $4)", [id, tenant, kind, spend]);
  const addStage = (run: string, status: string | null, tenant = TENANT, progressed = false) =>
    db.query("insert into agent_runs (tenant_id, status, payload, last_progress_at) values ($1, $2, $3, $4)", [tenant, status, JSON.stringify({ build_conductor_run_id: run }), progressed ? new Date().toISOString() : null]);
  const free = async (exclude: string | null = null) =>
    (await db.query<{ ok: boolean }>("select _first_build_free_eligible($1, $2) as ok", [TENANT, exclude])).rows[0].ok;

  beforeAll(async () => {
    const { PGlite } = createRequire(resolve(MODULES!, "../package.json"))("@electric-sql/pglite");
    db = new PGlite() as Db;
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create table conductor_runs (id uuid primary key, tenant_id uuid, kind text, spend_usd numeric, credits_waived boolean default false, status text default 'failed');
      create table agent_runs (tenant_id uuid, status text, payload jsonb, last_progress_at timestamptz);
    `);
    const file = "20261119140300_first_build_free_survives_failed_dispatch.sql";
    await db.exec(read(file));
  });
  afterAll(() => db?.close());
  beforeEach(async () => {
    await db.exec("truncate conductor_runs; truncate agent_runs;");
  });

  it("the BikeMarket case: a failed run whose only stage hit dispatch_error at $0 leaves the build free", async () => {
    await addRun(RUN);
    await addStage(RUN, "dispatch_error");
    expect(await free()).toBe(true);
  });

  it("a stage that really ran uses the free build, whatever its outcome", async () => {
    for (const status of ["success", "failed", "parse_failed", "running", null]) {
      await db.exec("truncate conductor_runs; truncate agent_runs;");
      await addRun(RUN);
      await addStage(RUN, status);
      expect(await free()).toBe(false);
    }
  });

  it("a dispatch_error next to a stage that ran still uses it", async () => {
    await addRun(RUN);
    await addStage(RUN, "dispatch_error");
    await addStage(RUN, "success");
    expect(await free()).toBe(false);
  });

  it("a dispatch_error after a tool call finished uses it, even when its charge was refunded", async () => {
    await addRun(RUN);
    await addStage(RUN, "dispatch_error", TENANT, true);
    expect(await free()).toBe(false);
  });

  it("any spend uses it, even when every stage ended in dispatch_error", async () => {
    await addRun(RUN, TENANT, 0.01);
    await addStage(RUN, "dispatch_error");
    expect(await free()).toBe(false);
  });

  it("the claiming run itself, other tenants and other run kinds do not count", async () => {
    await addRun(RUN);
    await addStage(RUN, "success");
    expect(await free(RUN)).toBe(true);
    await addRun(RUN2, OTHER);
    await addStage(RUN2, "success", OTHER);
    expect(await free(RUN)).toBe(true);
  });

  it("a tenant with no runs is free", async () => {
    expect(await free()).toBe(true);
  });
});
