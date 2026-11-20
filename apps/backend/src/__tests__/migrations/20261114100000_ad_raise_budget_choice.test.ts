import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openPglite, type Pg } from "@/services/growth/booking-metrics/__tests__/pglite";
import { isRunning, LIVE_ACCOUNT_MS, RUNNING_STATUS, STOPPED_STATUS } from "@/services/decisions/ad-budget-brake";
import { staleAccounts } from "@/services/decisions/ad-month-counter";

const MIGRATIONS = join(__dirname, "../../../../../supabase/migrations");
const read = (f: string) => readFileSync(join(MIGRATIONS, f), "utf-8");
function slice(file: string, name: string): string {
  const src = read(file);
  const at = src.search(new RegExp(`create (or replace )?function (public\\.)?${name}\\(`));
  if (at < 0) throw new Error(`${name} not found in ${file}`);
  const end = src.indexOf("end $$;", at);
  return src.slice(at, end + "end $$;".length);
}

const T1 = "11111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-0000-4000-8000-000000000001";
const OUTSIDER = "aaaaaaaa-0000-4000-8000-000000000003";
const BUDGET = "bbbbbbbb-0000-4000-8000-000000000001";
const DA = "dddddddd-0000-4000-8000-00000000000a";
const DB = "dddddddd-0000-4000-8000-00000000000b";

let db: Pg | null = null;
const q = async (sql: string, p: unknown[] = []) => (await db!.query(sql, p)).rows;
const one = async (sql: string, p: unknown[] = []) => (await q(sql, p))[0] as Record<string, unknown>;

const googleBody = (campaign: string, from: number, to: number) => ({ campaign_id: campaign, daily_budget_usd: to, expected_current_daily_budget_usd: from });
async function addDecision(id: string, body: unknown, cls = "google_ads.update_campaign_budget", status = "proposed") {
  await q("insert into decisions (id, tenant_id, status, decision_class, body) values ($1, $2, $3, $4, $5::jsonb)", [id, T1, status, cls, JSON.stringify(body)]);
}
const token = async () => String((await one("select ad_month_token($1) as t", [T1])).t);
async function approve(id: string, tok: string, expObject: string, expDelta: number, monthlyTo: number | null = null, dailyTo: number | null = null, actor = OWNER) {
  const r = await one("select approve_ad_raise_with_budget($1, $2, $3, $4, $5, $6, $7, $8) as r", [T1, id, actor, tok, expObject, expDelta, monthlyTo, dailyTo]);
  return r.r as Record<string, unknown>;
}
async function snapshot() {
  const b = await one("select monthly_usd::text m, daily_limit_usd::text d from ad_budgets where id = $1", [BUDGET]);
  const holds = await q("select idem_key, status, object_id, daily_delta_usd::text dd from ad_budget_reservations order by idem_key");
  const events = await q("select kind from ad_budget_events");
  const stamped = await q("select id from decisions where body ? 'budget_choice'");
  return { b, holds, events: events.length, stamped: stamped.length };
}

describe.skipIf(!process.env.CI && !process.env.PGLITE_DIR)("20261114100000_ad_raise_budget_choice.sql in Postgres", () => {
  beforeAll(async () => {
    db = await openPglite();
    await db!.exec(`
      do $$ begin create role anon; exception when duplicate_object then null; end $$;
      do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
      do $$ begin create role service_role; exception when duplicate_object then null; end $$;
      create table tenants (id uuid primary key, tier text not null default 'pro');
      create table tenant_users (user_id uuid, tenant_id uuid, role text);
      create table channel_actions (id uuid primary key, tenant_id uuid);
      create table decisions (
        id uuid primary key, tenant_id uuid not null, status text not null, decision_class text, body jsonb,
        approved_by uuid, approved_at timestamptz, rejected_by uuid, rejected_at timestamptz);
      create table ad_budgets (
        id uuid primary key, tenant_id uuid not null, monthly_usd numeric(12,2) not null, daily_limit_usd numeric(12,2),
        margin numeric(4,2) not null default 1.1, spent_usd numeric(12,2) not null default 0, status text not null default 'active',
        month_start date, started_on date, read_failed jsonb not null default '{}'::jsonb, actual_read_at timestamptz,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now());
      create table ad_budget_reservations (
        id uuid primary key default gen_random_uuid(), budget_id uuid not null, tenant_id uuid not null, idem_key text not null,
        platform text not null, object_id text, op text not null, daily_delta_usd numeric(12,2) not null default 0,
        amount_usd numeric(12,2) not null default 0, status text not null default 'reserved', reason text,
        released_on date, pause_due boolean not null default false, paused boolean not null default false,
        channel_action_id uuid, decision_id uuid, bounded boolean not null default false, ends_on date,
        cap_usd numeric(12,2), hold_factor numeric(4,2), spend_from date, over_cap boolean not null default false,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
        unique (budget_id, idem_key));
      create table ad_budget_events (id uuid primary key default gen_random_uuid(), tenant_id uuid, budget_id uuid, kind text,
        monthly_usd numeric(12,2), daily_limit_usd numeric(12,2), actor uuid);
      create table ad_campaigns (tenant_id uuid, platform text, account_id text, object_id text, budget_kind text,
        budget_usd numeric(12,2), status text, as_of timestamptz);
      create table ad_object_changes (id uuid primary key default gen_random_uuid(), tenant_id uuid, platform text, object_id text,
        change_kind text, after_daily_usd numeric(12,2), after_status text, occurred_at timestamptz not null default now());
      create function _ad_budget_today() returns date language sql stable as $f$ select (now() at time zone 'utc')::date $f$;
      create function _ad_budget_days_left(d date) returns int language sql immutable as
        $f$ select ((date_trunc('month', d) + interval '1 month')::date - d)::int $f$;
      create function _ad_budget_month_cap(p_monthly numeric, p_started_on date, p_today date) returns numeric language sql immutable as $f$ select p_monthly $f$;
      create function _ad_budget_spent_usd(p_spent numeric, p_month_start date, p_today date) returns numeric language sql immutable as $f$ select p_spent $f$;
      create function _ad_budget_held_usd(p_budget_id uuid, p_today date, p_margin numeric, p_exclude uuid default null) returns numeric language sql stable as $f$
        select coalesce(sum(amount_usd), 0) from ad_budget_reservations
         where budget_id = p_budget_id and status in ('reserved', 'committed') and (p_exclude is null or id <> p_exclude) $f$;
      create function _creator_hire_used_usd(p_budget_id uuid, p_today date) returns numeric language sql stable as $f$ select 0::numeric $f$;
      create function _tenant_tier(p_tenant_id uuid) returns text language sql stable as $f$ select tier from tenants where id = p_tenant_id $f$;
    `);
    await db!.exec(slice("20260928230000_ad_budget_setup_ledger.sql", "_ad_budget_assert_manager"));
    await db!.exec(slice("20261005090000_creator_hire_budget.sql", "update_ad_budget"));
    await db!.exec(slice("20261110110000_retire_stale_budget_proposals.sql", "decide_decision_as_actor"));
    await db!.exec(slice("20261107110000_ad_holds_bounded_by_object.sql", "reserve_ad_spend"));
    await db!.exec(read("20261114100000_ad_raise_budget_choice.sql"));
    await db!.exec(read("20261114100000_ad_raise_budget_choice.sql"));
  }, 60_000);
  afterAll(async () => {
    await db?.close();
  });
  beforeEach(async () => {
    await db!.exec(`
      truncate tenants, tenant_users, decisions, ad_budgets, ad_budget_reservations, ad_budget_events, ad_campaigns, ad_object_changes;
      insert into tenants values ('${T1}', 'pro');
      insert into tenant_users values ('${OWNER}', '${T1}', 'owner');
      insert into ad_budgets (id, tenant_id, monthly_usd, daily_limit_usd, spent_usd, month_start, started_on, actual_read_at)
      values ('${BUDGET}', '${T1}', 27000, null, 18000, date_trunc('month', now() at time zone 'utc')::date, '2026-01-01', now());
      insert into ad_campaigns values ('${T1}', 'google', 'g1', 'c1', 'daily', 40, 'ENABLED', now() - interval '1 hour'),
                                      ('${T1}', 'google', 'g1', 'c2', 'daily', 60, 'ENABLED', now() - interval '1 hour');
    `);
  });

  it("must-catch (Codex cheapest falsifier): two over-budget raises read the same token; the second is stale and only the first holds", async () => {
    await addDecision(DA, googleBody("c1", 40, 70));
    await addDecision(DB, googleBody("c2", 60, 90));
    const tok = await token();
    expect(await approve(DA, tok, "c1", 30, 27100)).toMatchObject({ status: "approved", changed: true });
    expect(await approve(DB, tok, "c2", 30, 27100)).toEqual({ status: "stale" });
    const s = await snapshot();
    expect(s.holds.map((h) => h.idem_key)).toEqual([`${DA}:raise`]);
    expect(s.b.m).toBe("27100.00");
    expect((await one("select status from decisions where id = $1", [DB])).status).toBe("proposed");
  });

  it("must-catch atomic: the flip refuses (not a member), so no limit, hold, stamp or event is written", async () => {
    await addDecision(DA, googleBody("c1", 40, 70));
    await q("insert into tenant_users values ($1, $2, 'admin')", [OUTSIDER, "99999999-9999-4999-8999-999999999999"]);
    await expect(approve(DA, await token(), "c1", 30, 27100, null, OUTSIDER)).rejects.toThrow();
    const s = await snapshot();
    expect(s).toMatchObject({ b: { m: "27000.00" }, holds: [], events: 0, stamped: 0 });
  });

  it("must-catch atomic: the flip itself raises after the limit edit, and everything rolls back", async () => {
    await addDecision(DA, googleBody("c1", 40, 70));
    await db!.exec(`alter function decide_decision_as_actor(uuid, uuid, uuid, text) rename to decide_decision_as_actor_real;
      create function decide_decision_as_actor(a uuid, b uuid, c uuid, d text) returns jsonb language plpgsql as
        $f$ begin raise exception 'not_member: test' using errcode = '42501'; end $f$;`);
    try {
      await expect(approve(DA, await token(), "c1", 30, 27100)).rejects.toThrow(/not_member/);
    } finally {
      await db!.exec(`drop function decide_decision_as_actor(uuid, uuid, uuid, text);
        alter function decide_decision_as_actor_real(uuid, uuid, uuid, text) rename to decide_decision_as_actor;`);
    }
    const s = await snapshot();
    expect(s).toMatchObject({ b: { m: "27000.00" }, holds: [], events: 0, stamped: 0 });
  });

  it("not Pro: update_ad_budget raises and nothing is written", async () => {
    await q("update tenants set tier = 'starter'");
    await addDecision(DA, googleBody("c1", 40, 70));
    await expect(approve(DA, await token(), "c1", 30, 27100)).rejects.toThrow(/Pro plan/);
    expect(await snapshot()).toMatchObject({ b: { m: "27000.00" }, holds: [], events: 0, stamped: 0 });
  });

  it("a target below what is already used is over_month (reserve_ad_spend's rule runs first), and nothing is written", async () => {
    await q("update ad_budgets set spent_usd = 27050");
    await addDecision(DA, googleBody("c1", 40, 70));
    expect(await approve(DA, await token(), "c1", 30, 27040)).toMatchObject({ status: "over_month", month_cap_usd: 27040 });
    expect(await snapshot()).toMatchObject({ b: { m: "27000.00" }, holds: [], stamped: 0 });

    await q("update ad_budgets set spent_usd = 18000, daily_limit_usd = 100");
    await q("insert into ad_budget_reservations (budget_id, tenant_id, idem_key, platform, object_id, op, daily_delta_usd, amount_usd, status) values ($1, $2, 'other:raise', 'google', 'c9', 'raise', 150, 10, 'committed')", [BUDGET, T1]);
    expect(await approve(DA, await token(), "c1", 30, 27100, 120)).toMatchObject({ status: "over_daily_limit" });
  });

  it("must-catch F1 (Codex): the hold must pass reserve_ad_spend's month rule; refused over_month with nothing written, approved once the budget is raised", async () => {
    const days = Number((await one("select _ad_budget_days_left(_ad_budget_today()) as d")).d);
    const held = Math.ceil(5 * days * 1.1 * 100) / 100;
    await q("update ad_budgets set monthly_usd = 1000, spent_usd = 990");
    await q("insert into ad_budget_reservations (budget_id, tenant_id, idem_key, platform, object_id, op, daily_delta_usd, amount_usd, status) values ($1, $2, 'other:raise', 'google', 'c9', 'raise', 5, $3, 'committed')", [BUDGET, T1, held]);
    await addDecision(DA, googleBody("c1", 40, 45));
    const r = await approve(DA, await token(), "c1", 5);
    expect(r).toMatchObject({ status: "over_month", month_cap_usd: 1000, hold_usd: held });
    expect(await snapshot()).toMatchObject({ b: { m: "1000.00" }, holds: [{ idem_key: "other:raise" }], events: 0, stamped: 0 });
    expect((await one("select status from decisions where id = $1", [DA])).status).toBe("proposed");
    expect(await approve(DA, await token(), "c1", 5, 2000)).toMatchObject({ status: "approved", changed: true, monthly_usd: 2000 });
  });

  it("never lowers: a target below the current budget leaves it as is (and a fit approves with no edit)", async () => {
    await addDecision(DA, googleBody("c1", 40, 70));
    expect(await approve(DA, await token(), "c1", 30, 100)).toMatchObject({ status: "approved", changed: true, monthly_usd: 27000 });
    expect(await snapshot()).toMatchObject({ b: { m: "27000.00" }, events: 0, stamped: 1 });
  });

  it("over_daily_limit without a daily target; approved with one", async () => {
    await q("update ad_budgets set daily_limit_usd = 1000");
    await q("insert into ad_budget_reservations (budget_id, tenant_id, idem_key, platform, object_id, op, daily_delta_usd, amount_usd, status) values ($1, $2, 'other:raise', 'google', 'c9', 'raise', 990, 10, 'committed')", [BUDGET, T1]);
    await addDecision(DA, googleBody("c1", 40, 70));
    expect(await approve(DA, await token(), "c1", 30)).toMatchObject({ status: "over_daily_limit", live_daily_usd: 990, daily_limit_usd: 1000 });
    expect(await approve(DA, await token(), "c1", 30, null, 1020)).toMatchObject({ status: "approved", daily_limit_usd: 1020 });
    expect((await snapshot()).b.d).toBe("1020.00");
  });

  it("daily_above_monthly when the daily target passes the monthly amount", async () => {
    await q("update ad_budgets set daily_limit_usd = 1000, monthly_usd = 1500, spent_usd = 0");
    await addDecision(DA, googleBody("c1", 40, 70));
    expect(await approve(DA, await token(), "c1", 30, null, 2000)).toMatchObject({ status: "daily_above_monthly" });
    expect((await snapshot()).holds).toEqual([]);
  });

  it("object_busy while another key is reserved on the object", async () => {
    await q("insert into ad_budget_reservations (budget_id, tenant_id, idem_key, platform, object_id, op, daily_delta_usd, amount_usd, status) values ($1, $2, 'other:raise', 'google', 'c1', 'raise', 5, 10, 'reserved')", [BUDGET, T1]);
    await addDecision(DA, googleBody("c1", 40, 70));
    expect(await approve(DA, await token(), "c1", 30)).toEqual({ status: "object_busy" });
  });

  it("a replay of the same approve answers approved, changed false; a rejected card answers decision_closed", async () => {
    await addDecision(DA, googleBody("c1", 40, 70));
    expect(await approve(DA, await token(), "c1", 30)).toMatchObject({ status: "approved", changed: true });
    expect(await approve(DA, await token(), "c1", 30)).toMatchObject({ status: "approved", changed: false });
    await addDecision(DB, googleBody("c2", 60, 90), "google_ads.update_campaign_budget", "rejected");
    expect(await approve(DB, await token(), "c2", 30)).toMatchObject({ status: "decision_closed", decision_status: "rejected" });
  });

  it("a non-USD Meta body is not_a_raise, with nothing written", async () => {
    await addDecision(DA, { ad_set_id: "a1", daily_budget_usd: 70, expected_current_daily_budget_usd: 40, currency: "inr" }, "meta_ads.update_ad_set_budget_review");
    expect(await approve(DA, await token(), "a1", 30)).toEqual({ status: "not_a_raise" });
    expect(await snapshot()).toMatchObject({ holds: [], stamped: 0 });
  });

  it("after an approve the hold is reserved at <id>:raise with the LOCKED body's object and $/day, and the dispatch reserve finds it", async () => {
    await addDecision(DA, { ad_set_id: "a1", daily_budget_usd: 70, expected_current_daily_budget_usd: 40, currency: "USD" }, "meta_ads.update_ad_set_budget");
    expect(await approve(DA, await token(), "a1", 30, 27100)).toMatchObject({ status: "approved" });
    const h = await one("select status, platform, object_id, daily_delta_usd::text dd, amount_usd::text amt, decision_id::text dec, over_cap from ad_budget_reservations where idem_key = $1", [`${DA}:raise`]);
    const days = Number((await one("select _ad_budget_days_left(_ad_budget_today()) as d")).d);
    expect(h).toMatchObject({ status: "reserved", platform: "meta", object_id: "a1", dd: "30.00", dec: DA, over_cap: false });
    expect(Number(h.amt)).toBe(Math.ceil(30 * days * 1.1 * 100) / 100);
    const body = (await one("select body from decisions where id = $1", [DA])).body as Record<string, unknown>;
    expect(body.budget_choice).toMatchObject({ hold_idem: `${DA}:raise`, monthly_usd: 27100 });
    const res = await one("select reserve_ad_spend($1, $2, 'meta', 'raise', 'a1', 30, null, $3) as r", [T1, `${DA}:raise`, DA]);
    expect((res.r as { status: string }).status).toBe("already_held");
  });

  it("must-catch R2: the body was replaced after TS judged it; the RPC with the old values answers changed and writes nothing", async () => {
    await addDecision(DA, googleBody("c2", 60, 150));
    expect(await approve(DA, await token(), "c1", 30, 27100)).toEqual({ status: "changed" });
    expect(await approve(DA, await token(), "c2", 30, 27100)).toEqual({ status: "changed" });
    expect(await snapshot()).toMatchObject({ b: { m: "27000.00" }, holds: [], events: 0, stamped: 0 });
    expect((await one("select status from decisions where id = $1", [DA])).status).toBe("proposed");
  });

  it("must-catch R1 (row content): editing a reservation that is not the newest moves the token", async () => {
    await q("insert into ad_budget_reservations (id, budget_id, tenant_id, idem_key, platform, object_id, op, daily_delta_usd, amount_usd, status, created_at, updated_at) values ('00000000-0000-4000-8000-000000000001', $1, $2, 'a:raise', 'google', 'c1', 'raise', 5, 10, 'committed', now() - interval '2 hours', now() - interval '2 hours'), ('00000000-0000-4000-8000-000000000002', $1, $2, 'b:raise', 'google', 'c2', 'raise', 5, 10, 'committed', now(), now())", [BUDGET, T1]);
    const before = await token();
    await q("update ad_budget_reservations set amount_usd = 11 where idem_key = 'a:raise'");
    expect(await token()).not.toBe(before);
  });

  it("must-catch R1 (time): an account crossing the 26-hour line moves the token and joins the stale set", async () => {
    await q("insert into ad_campaigns values ($1, 'meta', 'm1', 'a1', 'daily', 40, 'ACTIVE', clock_timestamp() - interval '26 hours' + interval '2 seconds')", [T1]);
    const before = await token();
    expect((await one("select _ad_stale_accounts($1) as s", [T1])).s ?? null).toBeNull();
    await q("select pg_sleep(3)");
    expect(await token()).not.toBe(before);
    expect((await one("select _ad_stale_accounts($1) as s", [T1])).s).toBe("meta:m1");
  });

  it("the SQL stale set equals staleAccounts (ad-month-counter.ts) on the same rows", async () => {
    const h = (n: number) => new Date(Date.now() - n * 3_600_000).toISOString();
    const monthStart = String((await one("select date_trunc('month', _ad_budget_today())::date::text as m")).m);
    const rows = [
      { platform: "google", account_id: "g2", as_of: h(30), status: "ENABLED" },
      { platform: "google", account_id: "g2", as_of: h(30), status: "PAUSED" },
      { platform: "linkedin", account_id: "l1", as_of: h(40), status: "DRAFT" },
      { platform: "tiktok", account_id: "t1", as_of: h(40), status: null },
      { platform: "meta", account_id: "m2", as_of: h(50), status: "ACTIVE" },
      { platform: "meta", account_id: "m2", as_of: h(27), status: "PAUSED" },
      { platform: "meta", account_id: "m3", as_of: h(2), status: "ACTIVE" },
    ].filter((r) => r.as_of >= monthStart);
    await q("delete from ad_campaigns");
    for (const r of rows) await q("insert into ad_campaigns values ($1, $2, $3, 'o', 'daily', 10, $4, $5::timestamptz)", [T1, r.platform, r.account_id, r.status, r.as_of]);
    const sql = (await one("select _ad_stale_accounts($1) as s", [T1])).s as string | null;
    const ts = staleAccounts(rows, monthStart, new Date())
      .map((s) => `${s.platform}:${s.account_id}`)
      .sort();
    expect((sql ?? "").split(";").filter(Boolean).sort()).toEqual(ts);
  });

  it("_ad_row_can_spend answers as isRunning (ad-budget-brake.ts) for every listed status", async () => {
    const statuses: Array<string | null> = [null, "removed", "Active", "paused", ...new Set([...Object.values(RUNNING_STATUS).flatMap((s) => [...s]), ...STOPPED_STATUS])];
    const platforms = [...Object.keys(RUNNING_STATUS), "tiktok", "linkedin", "pinterest"];
    for (const platform of platforms) {
      for (const status of statuses) {
        const r = await one("select _ad_row_can_spend($1, $2) as ok", [platform, status]);
        expect({ platform, status, ok: r.ok }).toEqual({ platform, status, ok: isRunning({ platform, status }) });
      }
    }
  });

  it("the SQL stale window equals LIVE_ACCOUNT_MS", () => {
    const sql = read("20261114100000_ad_raise_budget_choice.sql");
    const hours = [...sql.matchAll(/interval '(\d+) hours'/g)].map((m) => Number(m[1]));
    expect(hours.length).toBeGreaterThan(0);
    expect(new Set(hours)).toEqual(new Set([LIVE_ACCOUNT_MS / 3_600_000]));
  });
});
