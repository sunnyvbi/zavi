import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openPglite, type Pg } from "@/services/growth/booking-metrics/__tests__/pglite";

const MIGRATIONS = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20261121530000_linkedin_hold_outlives_end_date.sql";
const read = (f: string) => readFileSync(join(MIGRATIONS, f), "utf-8");
function fn(file: string, name: string, create = "create or replace function"): string {
  const src = read(file);
  const at = src.indexOf(`${create} public.${name}(`);
  if (at < 0) throw new Error(`${name} not found in ${file}`);
  const open = src.indexOf("$$", at);
  const end = src.indexOf("$$;", open + 2);
  return src.slice(at, end + 3);
}

const T1 = "11111111-1111-4111-8111-111111111111";
const BUDGET = "bbbbbbbb-0000-4000-8000-000000000001";
const BOUND = "linkedin-binding-1";

let db: Pg | null = null;
const q = async (sql: string, p: unknown[] = []) => (await db!.query(sql, p)).rows;
const one = async (sql: string, p: unknown[] = []) => (await q(sql, p))[0] as Record<string, unknown>;
const today = (d: string) => q("select set_config('zavi.today', $1, false)", [d]);

async function resume(key: string, daily: number, cap: number | null, endsOn: string | null) {
  const r = await one(
    "select reserve_ad_spend($1, $2, 'linkedin', 'resume', $3, $4, null, null, false, $5::date, $6::numeric, 1, false) as r",
    [T1, key, BOUND, daily, endsOn, cap],
  );
  return r.r as Record<string, unknown>;
}
const commit = (key: string) => q("update ad_budget_reservations set status = 'committed' where idem_key = $1", [key]);
const held = async (d: string) => Number((await one("select _ad_budget_held_usd($1, $2::date, 1.0) as h", [BUDGET, d])).h);

describe.skipIf(!process.env.CI && !process.env.PGLITE_DIR)(`${FILE} in Postgres`, () => {
  beforeAll(async () => {
    db = await openPglite();
    await db!.exec(`
      do $$ begin create role anon; exception when duplicate_object then null; end $$;
      do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
      do $$ begin create role service_role; exception when duplicate_object then null; end $$;
      create table channel_actions (id uuid primary key, tenant_id uuid);
      create table decisions (id uuid primary key, tenant_id uuid);
      create table ad_budgets (
        id uuid primary key, tenant_id uuid not null, status text not null default 'active',
        monthly_usd numeric(12,2) not null, daily_limit_usd numeric(12,2), margin numeric not null default 1.0,
        started_on date not null, month_start date not null, spent_usd numeric(12,2) not null default 0,
        read_failed jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now());
      create table ad_budget_reservations (
        id uuid primary key default gen_random_uuid(), budget_id uuid not null, tenant_id uuid not null,
        idem_key text not null, platform text not null, object_id text, op text not null,
        daily_delta_usd numeric(12,2) not null default 0, amount_usd numeric(12,2) not null default 0,
        status text not null default 'reserved', reason text, released_on date, released_at timestamptz,
        pause_due boolean not null default false, paused boolean not null default false,
        channel_action_id uuid, decision_id uuid, bounded boolean not null default false, ends_on date,
        cap_usd numeric(12,2), hold_factor numeric(4,2), spend_from date, over_cap boolean not null default false,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
        unique (budget_id, idem_key));
      create table ad_spend_daily (tenant_id uuid not null, platform text not null, account_id text not null default 'acct',
        object_id text not null, spend_date date not null, amount_usd numeric(12,2) not null, source text not null default 'api');
      create function _ad_budget_today() returns date language sql stable as $f$
        select coalesce(nullif(current_setting('zavi.today', true), '')::date, (now() at time zone 'utc')::date) $f$;
      create function _creator_hire_used_usd(p_budget_id uuid, p_today date) returns numeric language sql stable as $f$ select 0::numeric $f$;
    `);
    const monthly = "20260929010000_ad_budget_monthly.sql";
    for (const name of ["_ad_budget_days_left", "_ad_budget_days_in_month", "_ad_budget_month_cap", "_ad_budget_spent_usd"])
      await db!.exec(fn(monthly, name));
    const bounded = "20261107110000_ad_holds_bounded_by_object.sql";
    await db!.exec(fn(bounded, "_ad_bounded_hold_usd"));
    await db!.exec(fn(bounded, "_ad_budget_held_usd"));
    await db!.exec(fn(bounded, "reserve_ad_spend", "create function"));
    await db!.exec(read("20261121100100_linkedin_resume_bounded_hold.sql"));
    await db!.exec(read(FILE));
    await db!.exec(read(FILE));
  }, 60_000);
  afterAll(async () => {
    await db?.close();
  });
  beforeEach(async () => {
    await db!.exec(`
      truncate ad_budgets, ad_budget_reservations, ad_spend_daily;
      insert into ad_budgets (id, tenant_id, monthly_usd, daily_limit_usd, started_on, month_start)
      values ('${BUDGET}', '${T1}', 1000, null, '2026-01-01', '2026-10-01');
    `);
  });

  async function launchEndingNov30() {
    await today("2026-11-27");
    await q("update ad_budgets set month_start = '2026-11-01'");
    expect(await resume("op-1:resume", 200, 600, "2026-11-30")).toMatchObject({ status: "held", amount_usd: 600 });
    await commit("op-1:resume");
    await q("insert into ad_spend_daily (tenant_id, platform, object_id, spend_date, amount_usd) values ($1, 'linkedin', $2, '2026-11-28', 100)", [T1, BOUND]);
  }

  it("a LinkedIn campaign extended past its end date keeps holding what it has not spent, so a second launch cannot push December past the budget", async () => {
    await launchEndingNov30();
    expect(await held("2026-12-02")).toBe(500);
    expect(await held("2026-12-20")).toBe(500);
    await q("update ad_budgets set month_start = '2026-12-01'");
    await today("2026-12-02");
    expect(await resume("op-2:resume", 0, 1000, "2026-12-20")).toMatchObject({ status: "refused", reason: "over_month" });
    expect(await resume("op-3:resume", 0, 500, "2026-12-20")).toMatchObject({ status: "held", amount_usd: 500 });
    expect(await held("2026-12-02")).toBe(1000);
  });

  it("spend after the end date still draws the hold down, and it never goes below zero", async () => {
    await launchEndingNov30();
    await q("insert into ad_spend_daily (tenant_id, platform, object_id, spend_date, amount_usd) values ($1, 'linkedin', $2, '2026-12-05', 450)", [T1, BOUND]);
    expect(await held("2026-12-06")).toBe(50);
    await q("insert into ad_spend_daily (tenant_id, platform, object_id, spend_date, amount_usd) values ($1, 'linkedin', $2, '2026-12-06', 300)", [T1, BOUND]);
    expect(await held("2026-12-07")).toBe(0);
  });

  it("once the live sync sees the campaign stopped, the hold is gone and the money is free for the next launch", async () => {
    await launchEndingNov30();
    await q("update ad_budget_reservations set status = 'released', released_on = '2026-12-02', reason = 'live_stopped' where idem_key = 'op-1:resume'");
    expect(await held("2026-12-02")).toBe(0);
    await q("update ad_budgets set month_start = '2026-12-01'");
    await today("2026-12-02");
    expect(await resume("op-2:resume", 0, 1000, "2026-12-20")).toMatchObject({ status: "held", amount_usd: 1000 });
  });
});
