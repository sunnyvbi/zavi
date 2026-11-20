import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openPglite, type Pg } from "@/services/growth/booking-metrics/__tests__/pglite";
import { dailyHoldEndsOn } from "@/services/growth/ad-plan-shape";

const MIGRATIONS = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20261121100100_linkedin_resume_bounded_hold.sql";
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

  it("a $600 launch over 30 days approved Oct 30 holds $600, and still $600 (less its spend) on Nov 1, never $300 a day for the month", async () => {
    await today("2026-10-30");
    const endsOn = dailyHoldEndsOn(Math.ceil(Date.parse("2026-11-29T12:00:00Z") / 1000));
    expect(await resume("op-1:resume", 20, 600, endsOn)).toMatchObject({ status: "held", amount_usd: 600 });
    await commit("op-1:resume");
    expect(await held("2026-10-30")).toBe(600);
    await q("update ad_budgets set month_start = '2026-11-01'");
    await today("2026-11-01");
    expect(await held("2026-11-01")).toBe(600);
    await q("insert into ad_spend_daily (tenant_id, platform, object_id, spend_date, amount_usd) values ($1, 'linkedin', $2, '2026-10-31', 150)", [T1, BOUND]);
    expect(await held("2026-11-01")).toBe(450);
    expect(await resume("op-2:resume", 0, 600, endsOn)).toMatchObject({ status: "refused", reason: "over_month" });
  });

  it("a short flight holds its whole remaining total and its daily share still meets the daily limit", async () => {
    await today("2026-10-10");
    await q("update ad_budgets set daily_limit_usd = 150");
    expect(await resume("op-1:resume", 200, 600, "2026-10-14")).toMatchObject({ status: "refused", reason: "over_daily_limit" });
    await q("update ad_budgets set daily_limit_usd = null, monthly_usd = 500");
    expect(await resume("op-2:resume", 200, 600, "2026-10-14")).toMatchObject({ status: "refused", reason: "over_month", amount_usd: 600 });
    await q("update ad_budgets set monthly_usd = 1000");
    expect(await resume("op-3:resume", 200, 600, "2026-10-14")).toMatchObject({ status: "held", amount_usd: 600 });
    const row = await one("select bounded, cap_usd::text cap, ends_on::text ends, spend_from::text sf from ad_budget_reservations where idem_key = 'op-3:resume'");
    expect(row).toMatchObject({ bounded: true, cap: "600.00", ends: "2026-10-14" });
  });

  it("only a resume with both a lifetime total and an end date may be bounded; a raise or a half-bounded resume still raises", async () => {
    await today("2026-10-10");
    await expect(resume("a:resume", 20, 600, null)).rejects.toThrow(/only a create/);
    await expect(resume("b:resume", 20, null, "2026-11-01")).rejects.toThrow(/only a create/);
    await expect(
      q("select reserve_ad_spend($1, 'c:raise', 'linkedin', 'raise', $2, 20, null, null, false, '2026-11-01'::date, 600, 1, false)", [T1, BOUND]),
    ).rejects.toThrow(/only a create/);
    expect(await q("select 1 from ad_budget_reservations")).toEqual([]);
  });

  it.each(["meta", "google", "tiktok", "reddit", "x", "chatgpt"])("a %s hold with a total and an end date keeps its hold past that date, because nothing refreshes its end date when a flight is extended", async (platform) => {
    await today("2026-11-27");
    await q("update ad_budgets set month_start = '2026-11-01'");
    const r = await one(
      "select reserve_ad_spend($1, 'other:create', $2, 'create', null, 200, null, null, false, '2026-11-30'::date, 600, 1, false) as r",
      [T1, platform],
    );
    expect(r.r).toMatchObject({ status: "held", amount_usd: 600 });
    await commit("other:create");
    expect(await held("2026-12-02")).toBe(600);
    expect(await held("2026-12-20")).toBe(600);
  });

  it("an end-dated create without a lifetime total keeps its old hold after its end date", async () => {
    await today("2026-10-10");
    const r = await one(
      "select reserve_ad_spend($1, 'cr:create', 'meta', 'create', null, 10, null, null, false, '2026-10-15'::date, null, 1, false) as r",
      [T1],
    );
    expect(r.r).toMatchObject({ status: "held", amount_usd: 50 });
    expect(await held("2026-10-20")).toBe(50);
  });
});
