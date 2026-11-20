import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { BUILD_REASONS, BuildReasonsSchema } from "@/services/sites/build-feedback-reasons";

const MIGRATIONS = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20261023100000_build_feedback_reasons.sql";
const sql = readFileSync(join(MIGRATIONS, FILE), "utf-8");
const ATOMIC_FILE = "20261023105000_atomic_build_feedback.sql";
const atomicSql = readFileSync(join(MIGRATIONS, ATOMIC_FILE), "utf-8");
const modules = process.env.SITES_SQL_TEST_MODULES;

const TA = "11111111-1111-4111-8111-111111111111";
const UA = "a1a1a1a1-0000-4000-8000-000000000001";
const RUN = "44444444-4444-4444-8444-444444444444";

describe(FILE, () => {
  it("sorts after the build feedback migration it extends", () => {
    const all = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
    expect(all.indexOf(FILE)).toBeGreaterThan(all.indexOf("20261021090000_build_feedback.sql"));
  });

  it("writes build ratings and reasons together behind the membership boundary", () => {
    const all = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
    expect(all.indexOf(ATOMIC_FILE)).toBeGreaterThan(all.indexOf(FILE));
    expect(atomicSql).toMatch(/create or replace function public\.submit_build_feedback\(/);
    expect(atomicSql).toMatch(/from public\.conductor_runs c[\s\S]*c\.kind = 'build_app'[\s\S]*public\.tenant_users tu/);
    expect(atomicSql).toMatch(/insert into public\.agent_feedback \([\s\S]*rating, comment, build_reasons, created_by/);
    expect(atomicSql).toMatch(/do update set[\s\S]*build_reasons = excluded\.build_reasons/);
    expect(atomicSql).toMatch(/security definer set search_path = public, pg_temp/);
    expect(atomicSql).toMatch(/revoke all on function public\.submit_build_feedback\(uuid, smallint, text, text\[\]\) from public, anon, authenticated/);
  });
});

type Db = { exec: (q: string) => Promise<unknown>; query: (q: string, p?: unknown[]) => Promise<{ rows: any[] }>; close: () => Promise<void> };
let db: Db;
let feedbackId: string;

const setReasons = (reasons: unknown[] | null) =>
  db.query("update public.agent_feedback set build_reasons = $1::text[] where id = $2", [reasons, feedbackId]);

describe.skipIf(!modules)(`${FILE} executed in Postgres (pglite)`, () => {
  beforeAll(async () => {
    const { PGlite } = createRequire(resolve(modules!, "../package.json"))("@electric-sql/pglite");
    db = new PGlite();
    await db.exec(`
      create table public.tenants (id uuid primary key);
      create table public.agent_feedback (
        id uuid primary key default gen_random_uuid(),
        tenant_id uuid not null references public.tenants(id) on delete cascade,
        target_type text not null,
        target_id uuid not null,
        agent_slug text not null,
        rating smallint check (rating in (-1, 1)),
        comment text,
        created_by uuid not null,
        created_at timestamptz not null default now()
      );
      insert into public.tenants values ('${TA}');
    `);
    const { rows } = await db.query(
      "insert into public.agent_feedback (tenant_id, target_type, target_id, agent_slug, rating, created_by) values ($1, 'conductor_run', $2, 'engineer', -1, $3) returning id",
      [TA, RUN, UA],
    );
    feedbackId = rows[0].id;
    await db.exec(sql);
    await db.exec(sql);
  });
  afterAll(async () => db?.close());

  it("adds a nullable column that leaves existing ratings untouched", async () => {
    const { rows } = await db.query("select rating, build_reasons from public.agent_feedback where id = $1", [feedbackId]);
    expect(rows).toEqual([{ rating: -1, build_reasons: null }]);
  });

  it("accepts every reason the route accepts, all at once, and an empty list", async () => {
    expect(BuildReasonsSchema.safeParse([...BUILD_REASONS]).success).toBe(true);
    await expect(setReasons([...BUILD_REASONS])).resolves.toBeTruthy();
    await expect(setReasons([])).resolves.toBeTruthy();
    for (const r of BUILD_REASONS) await expect(setReasons([r])).resolves.toBeTruthy();
  });

  it("refuses an id the route refuses, a null element and more than six", async () => {
    expect(BuildReasonsSchema.safeParse(["colour"]).success).toBe(false);
    await expect(setReasons(["colour"])).rejects.toThrow(/agent_feedback_build_reasons_check/);
    await expect(setReasons(["look", null])).rejects.toThrow(/agent_feedback_build_reasons_check/);
    await expect(setReasons([...BUILD_REASONS, "look"])).rejects.toThrow(/agent_feedback_build_reasons_check/);
  });

  it("re-running keeps exactly one check and the stored reasons", async () => {
    await setReasons(["look", "slow"]);
    await db.exec(sql);
    const checks = await db.query("select count(*)::int as n from pg_constraint where conname = 'agent_feedback_build_reasons_check'");
    expect(checks.rows[0].n).toBe(1);
    const { rows } = await db.query("select build_reasons from public.agent_feedback where id = $1", [feedbackId]);
    expect(rows[0].build_reasons).toEqual(["look", "slow"]);
  });
});
