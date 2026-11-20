import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PGLITE_MODULES = process.env.SITES_SQL_TEST_MODULES;
const dir = join(__dirname, "../../../../../supabase/migrations");
type Db = { exec: (q: string) => Promise<unknown>; query: <R = Record<string, any>>(q: string, p?: unknown[]) => Promise<{ rows: R[] }>; close: () => Promise<void> };

describe.skipIf(!PGLITE_MODULES)("20261111230000 cgo_missed_reviews leaves out budget-clock skips (pglite)", () => {
  let db: Db;
  const T = randomUUID();

  beforeAll(async () => {
    const { PGlite } = createRequire(resolve(PGLITE_MODULES!, "../package.json"))("@electric-sql/pglite");
    db = new PGlite() as Db;
    await db.exec(`
      do $$ begin
        if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
        if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
        if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
      end $$;
      create table tenant_app_setting (tenant_id uuid, key text, value jsonb);
      create table tenants (id uuid primary key, kind text, deleted_at timestamptz, disabled_at timestamptz);
      create table autopilot_goals (tenant_id uuid, status text, created_at timestamptz);
      create table cgo_notes (tenant_id uuid, alarm_keys text[], next_review_at timestamptz, created_at timestamptz);
      create table agent_runs (tenant_id uuid, agent_slug text, payload jsonb, status text, error jsonb, enqueued_at timestamptz, finished_at timestamptz);
      create table cgo_wake_skips (tenant_id uuid, wake_reason text, why text, created_at timestamptz default now());
    `);
    await db.exec(readFileSync(join(dir, "20261111230000_cgo_missed_reviews_skip_budget_clock.sql"), "utf8"));
    await db.query("insert into tenants (id) values ($1)", [T]);
    await db.query("insert into tenant_app_setting values ($1, 'cgo_autopilot_enabled', 'true'::jsonb)", [T]);
    await db.query("insert into autopilot_goals values ($1, 'active', now() - interval '5 days')", [T]);
    await db.query("insert into cgo_notes values ($1, null, now() - interval '2 days', now() - interval '3 days')", [T]);
  }, 120_000);
  afterAll(async () => db?.close());

  const why = async () =>
    (await db.query<{ missed: boolean; why: string | null }>("select missed, why from cgo_missed_reviews(now(), 26, null, 500)")).rows[0];

  it("names the check-in skip, not a newer budget-clock skip", async () => {
    await db.query("insert into cgo_wake_skips values ($1, 'daily_check', 'no_credits', now() - interval '20 hours')", [T]);
    await db.query("insert into cgo_wake_skips values ($1, 'ad_budget_review', 'nothing_changed', now() - interval '1 hour')", [T]);
    expect(await why()).toEqual({ missed: true, why: "daily_check: no_credits" });
  });

  it("with only budget-clock skips, the missed review has no reason rather than a wrong one", async () => {
    await db.query("delete from cgo_wake_skips where wake_reason = 'daily_check'");
    expect(await why()).toEqual({ missed: true, why: null });
  });
});
