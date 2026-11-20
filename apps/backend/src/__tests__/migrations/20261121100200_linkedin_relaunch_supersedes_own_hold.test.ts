import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openPglite, type Pg } from "@/services/growth/booking-metrics/__tests__/pglite";

const MIGRATIONS = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20261121100200_linkedin_relaunch_supersedes_own_hold.sql";
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
const T2 = "22222222-2222-4222-8222-222222222222";
const BUDGET = "bbbbbbbb-0000-4000-8000-000000000001";
const BUDGET2 = "bbbbbbbb-0000-4000-8000-000000000002";
const BOUND = "linkedin-binding-1";
const OTHER = "linkedin-binding-2";

let db: Pg | null = null;
const q = async (sql: string, p: unknown[] = []) => (await db!.query(sql, p)).rows;
const one = async (sql: string, p: unknown[] = []) => (await q(sql, p))[0] as Record<string, unknown>;

async function resume(key: string, cap: number, opts: { tenant?: string; object?: string; overCapOk?: boolean; daily?: number } = {}) {
  const r = await one(
    "select reserve_ad_spend($1, $2, 'linkedin', 'resume', $3, $4, null, null, false, '2026-10-28'::date, $5::numeric, 1, $6) as r",
    [opts.tenant ?? T1, key, opts.object ?? BOUND, opts.daily ?? cap / 5, cap, opts.overCapOk ?? false],
  );
  return r.r as Record<string, unknown>;
}
const settle = async (key: string, outcome: "committed" | "released", tenant = T1) =>
  ((await one("select settle_ad_spend($1, $2, $3, null) as r", [tenant, key, outcome])).r as Record<string, unknown>).status;
const commit = (key: string, tenant = T1) => settle(key, "committed", tenant);
const pause = (key: string) => q("update ad_budget_reservations set status = 'released', reason = 'paused', released_on = '2026-10-23' where idem_key = $1", [key]);
const held = async (budget = BUDGET) => Number((await one("select _ad_budget_held_usd($1, '2026-10-23'::date, 1.0) as h", [budget])).h);
const ownHold = async (object = BOUND, tenant = T1) =>
  Number((await one("select ad_object_hold_usd($1, 'linkedin', $2) as h", [tenant, object])).h);
const row = (key: string) => one("select status, reason, amount_usd::float8 amt from ad_budget_reservations where idem_key = $1", [key]);
const unbounded = (key: string, object: string, daily: number) =>
  q(`insert into ad_budget_reservations (budget_id, tenant_id, idem_key, platform, object_id, op, daily_delta_usd, amount_usd, status)
     values ($1, $2, $3, 'linkedin', $4, 'resume', $5, 0, 'committed')`, [BUDGET, T1, key, object, daily]);

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
      create table ads_campaign_operations (id uuid primary key, status text not null);
    `);
    const monthly = "20260929010000_ad_budget_monthly.sql";
    for (const name of ["_ad_budget_days_left", "_ad_budget_days_in_month", "_ad_budget_month_cap", "_ad_budget_spent_usd"])
      await db!.exec(fn(monthly, name));
    const bounded = "20261107110000_ad_holds_bounded_by_object.sql";
    await db!.exec(fn(bounded, "_ad_budget_reservation_released_at"));
    await db!.exec(`create trigger ad_budget_reservations_released_at before update on ad_budget_reservations
      for each row execute function _ad_budget_reservation_released_at()`);
    await db!.exec(fn(bounded, "_ad_bounded_hold_usd"));
    await db!.exec(fn(bounded, "_ad_budget_held_usd"));
    await db!.exec(fn(bounded, "reserve_ad_spend", "create function"));
    const inflight = "20261021120000_cgo_inflight_ad_holds.sql";
    await db!.exec(fn(inflight, "resolve_inflight_ad_hold"));
    await db!.exec(fn(inflight, "settle_ad_spend"));
    await db!.exec(read("20261121100100_linkedin_resume_bounded_hold.sql"));
    await db!.exec(read(FILE));
    await db!.exec(read(FILE));
  }, 60_000);
  afterAll(async () => {
    await db?.close();
  });
  beforeEach(async () => {
    await db!.exec(`
      select set_config('zavi.today', '2026-10-23', false);
      truncate ad_budgets, ad_budget_reservations, ad_spend_daily;
      insert into ad_budgets (id, tenant_id, monthly_usd, daily_limit_usd, started_on, month_start)
      values ('${BUDGET}', '${T1}', 10, null, '2026-01-01', '2026-10-01'),
             ('${BUDGET2}', '${T2}', 10, null, '2026-01-01', '2026-10-01');
    `);
  });

  describe("a same-day relaunch: the amount passed already has observed spend taken off", () => {
    const UTC_TODAY = "(now() at time zone 'utc')::date";
    const relaunch = async (key: string, remaining: number, observed: number | null, object = BOUND) =>
      (await one(
        "select reserve_ad_spend($1, $2, 'linkedin', 'resume', $3, $4, null, null, false, '2026-12-20'::date, $5::numeric, 1, false, $6::numeric) as r",
        [T1, key, object, remaining / 5, remaining, observed],
      )).r as Record<string, unknown>;
    const spendOn = (sql: string, amount: number) =>
      q(`insert into ad_spend_daily (tenant_id, platform, object_id, spend_date, amount_usd) values ($1, 'linkedin', $2, ${sql}, $3)`, [T1, BOUND, amount]);
    const recordToday = async (amount: number) => {
      await q(`delete from ad_spend_daily where object_id = $1 and spend_date = ${UTC_TODAY}`, [BOUND]);
      await spendOn(UTC_TODAY, amount);
    };
    const spent = (usd: number) => q("update ad_budgets set spent_usd = $1 where id = $2", [usd, BUDGET]);
    const pausedAfter = async (total: number) => {
      await q("update ad_budgets set monthly_usd = $1 where id = $2", [total, BUDGET]);
      expect(await resume("op-1:resume", total)).toMatchObject({ status: "held", amount_usd: total });
      await commit("op-1:resume");
    };

    it("must catch: total $100, $40 spent today, paused, relaunched today: $60 stays held and a second campaign cannot reserve the missing $40", async () => {
      await pausedAfter(100);
      await spendOn(UTC_TODAY, 40);
      await spent(40);
      await pause("op-1:resume");
      expect(await relaunch("op-2:resume", 60, 40)).toMatchObject({ status: "held", amount_usd: 60 });
      expect(await commit("op-2:resume")).toBe("committed");
      expect(await relaunch("gap:resume", 40, 0, OTHER)).toMatchObject({ status: "refused", reason: "over_month" });
      expect(await relaunch("cent:resume", 0.01, 0, OTHER)).toMatchObject({ status: "refused", reason: "over_month" });
      expect(await q("select 1 from ad_budget_reservations where idem_key in ('gap:resume', 'cent:resume') and status <> 'refused'")).toEqual([]);
      expect(await row("op-1:resume")).toMatchObject({ status: "released", reason: "rebased" });
      expect(await held()).toBe(60);
    });

    it("never holds more than what is left: spend after the relaunch lowers the hold dollar for dollar, and exposure stays at the total", async () => {
      await pausedAfter(100);
      await spendOn(UTC_TODAY, 40);
      await spent(40);
      await pause("op-1:resume");
      await relaunch("op-2:resume", 60, 40);
      await commit("op-2:resume");
      for (const [recorded, hold] of [[50, 50], [99.99, 0.01], [100, 0], [130, 0]]) {
        await recordToday(recorded);
        await spent(recorded);
        expect(await held()).toBe(hold);
      }
    });

    it("spend from earlier days is not taken off either, and neither is the part of today already deducted", async () => {
      await pausedAfter(100);
      await spendOn(`${UTC_TODAY} - 2`, 15);
      await spendOn(UTC_TODAY, 25);
      await spent(40);
      await pause("op-1:resume");
      await relaunch("op-2:resume", 60, 40);
      await commit("op-2:resume");
      expect(await held()).toBe(60);
      await recordToday(35);
      expect(await held()).toBe(50);
    });

    it("must catch: LinkedIn already counted $40 but the ledger has only recorded $30: catching up is not new spend", async () => {
      await pausedAfter(100);
      await spendOn(UTC_TODAY, 30);
      await spent(30);
      await pause("op-1:resume");
      await relaunch("op-2:resume", 60, 40);
      await commit("op-2:resume");
      expect(await held()).toBe(60);
      await recordToday(40);
      await spent(40);
      expect(await held()).toBe(60);
      await recordToday(45);
      expect(await held()).toBe(55);
    });

    it("spend LinkedIn had not yet reported at the launch is taken off when it lands, because it was never deducted", async () => {
      await pausedAfter(100);
      await spendOn(UTC_TODAY, 30);
      await spent(30);
      await pause("op-1:resume");
      await relaunch("op-2:resume", 70, 30);
      await commit("op-2:resume");
      expect(await held()).toBe(70);
      await recordToday(40);
      expect(await held()).toBe(60);
    });

    it("a ledger above LinkedIn's figure never shrinks the hold below what was asked", async () => {
      await pausedAfter(100);
      await spendOn(UTC_TODAY, 50);
      await spent(50);
      await pause("op-1:resume");
      await q("update ad_budgets set monthly_usd = 200 where id = $1", [BUDGET]);
      expect(await relaunch("op-2:resume", 60, 40)).toMatchObject({ status: "held", amount_usd: 60 });
      await commit("op-2:resume");
      expect(await held()).toBe(60);
      await recordToday(55);
      expect(await held()).toBe(55);
    });

    it("the hold survives the month turning over and a later pause's 48-hour window, netting only spend after the launch", async () => {
      await pausedAfter(100);
      await spendOn(UTC_TODAY, 40);
      await spent(40);
      await pause("op-1:resume");
      await relaunch("op-2:resume", 60, 40);
      await commit("op-2:resume");
      await q("update ad_budgets set month_start = '2026-11-01', spent_usd = 0");
      await q("select set_config('zavi.today', '2026-11-01', false)");
      expect(await one("select _ad_budget_held_usd($1, '2026-11-01'::date, 1.0) as h", [BUDGET])).toMatchObject({ h: "60.00" });
      await q("select set_config('zavi.today', '2026-10-23', false)");
      await q("update ad_budgets set month_start = '2026-10-01', spent_usd = 40");
      await recordToday(50);
      await pause("op-2:resume");
      expect(await held()).toBe(50);
    });

    it("a retry keeps its stored baseline; a fresh attempt on a released row takes a new one", async () => {
      await pausedAfter(100);
      await spendOn(UTC_TODAY, 40);
      await spent(40);
      await relaunch("op-2:resume", 60, 40);
      await recordToday(45);
      expect(await relaunch("op-2:resume", 55, 45)).toMatchObject({ status: "already_held", amount_usd: 60 });
      expect(await one("select spend_baseline_usd::float8 b from ad_budget_reservations where idem_key = 'op-2:resume'")).toEqual({ b: 40 });
      await settle("op-2:resume", "released");
      await q("update ad_budget_reservations set reason = 'rejected' where idem_key = 'op-2:resume'");
      await relaunch("op-2:resume", 55, 45);
      expect(await one("select spend_baseline_usd::float8 b, amount_usd::float8 a from ad_budget_reservations where idem_key = 'op-2:resume'")).toEqual({ b: 45, a: 55 });
    });

    it("with no figure from the caller the ledger's lifetime spend is the baseline, and a create still nets from its own day", async () => {
      await pausedAfter(100);
      await spendOn(UTC_TODAY, 40);
      await spent(40);
      await pause("op-1:resume");
      await relaunch("op-2:resume", 60, null);
      await commit("op-2:resume");
      expect(await held()).toBe(60);
      expect(await one("select spend_baseline_usd::float8 b from ad_budget_reservations where idem_key = 'op-2:resume'")).toEqual({ b: 40 });
      await q("update ad_budgets set monthly_usd = 200 where id = $1", [BUDGET]);
      expect((await one("select reserve_ad_spend($1, 'cr:create', 'linkedin', 'create', $2, 2, null, null, false, null, 10::numeric, 1, false) as r", [T1, OTHER])).r).toMatchObject({ status: "held", amount_usd: 10 });
      await q(`insert into ad_spend_daily (tenant_id, platform, object_id, spend_date, amount_usd) values ($1, 'linkedin', $2, ${UTC_TODAY}, 3), ($1, 'linkedin', $2, ${UTC_TODAY} - 5, 4)`, [T1, OTHER]);
      expect(await one("select spend_baseline_usd b from ad_budget_reservations where idem_key = 'cr:create'")).toEqual({ b: null });
      expect(await held()).toBe(67);
    });

    it("the old thirteen-argument signature is gone, so one name resolves and PostgREST finds one function", async () => {
      expect(await q("select oid from pg_proc where proname = 'reserve_ad_spend'")).toHaveLength(1);
    });
  });

  it("a relaunch whose own $10 hold fills a $10 month is held without touching that hold, and replaces it only when it commits", async () => {
    expect(await resume("op-1:resume", 10)).toMatchObject({ status: "held", amount_usd: 10 });
    expect(await commit("op-1:resume")).toBe("committed");
    await pause("op-1:resume");
    expect(await held()).toBe(10);
    expect(await ownHold()).toBe(10);
    expect(await resume("op-2:resume", 10)).toMatchObject({ status: "held", amount_usd: 10 });
    expect(await row("op-1:resume")).toMatchObject({ status: "released", reason: "paused", amt: 10 });
    expect(await held()).toBe(20);
    expect(await commit("op-2:resume")).toBe("committed");
    expect(await row("op-1:resume")).toMatchObject({ status: "released", reason: "rebased" });
    expect(await held()).toBe(10);
    expect(await ownHold()).toBe(10);
  });

  it("a relaunch that is dropped before anything reaches LinkedIn leaves the campaign's old hold counting, so the month cannot be spent twice", async () => {
    await resume("op-1:resume", 10);
    await commit("op-1:resume");
    await pause("op-1:resume");
    expect(await resume("op-2:resume", 10)).toMatchObject({ status: "held" });
    expect(await settle("op-2:resume", "released")).toBe("released");
    expect(await row("op-2:resume")).toMatchObject({ status: "released", reason: "rejected" });
    expect(await row("op-1:resume")).toMatchObject({ status: "released", reason: "paused", amt: 10 });
    expect(await held()).toBe(10);
    expect(await ownHold()).toBe(10);
    expect(await resume("other:resume", 1, { object: OTHER })).toMatchObject({ status: "refused", reason: "over_month" });
  });

  it("a still-committed own hold is replaced on commit, and the relaunch's daily share fits a daily limit the old hold alone fills", async () => {
    await q("update ad_budgets set daily_limit_usd = 2 where id = $1", [BUDGET]);
    expect(await resume("op-1:resume", 10, { daily: 2 })).toMatchObject({ status: "held" });
    await commit("op-1:resume");
    expect(await resume("op-2:resume", 10, { daily: 2 })).toMatchObject({ status: "held", amount_usd: 10 });
    expect(await row("op-1:resume")).toMatchObject({ status: "committed", reason: null });
    expect(Number((await one("select daily_delta_usd from ad_budget_reservations where idem_key = 'op-2:resume'")).daily_delta_usd)).toBe(2);
    await commit("op-2:resume");
    expect(await row("op-1:resume")).toMatchObject({ status: "released", reason: "rebased" });
    expect(await held()).toBe(10);
    expect(await resume("other:resume", 1, { object: OTHER, daily: 1 })).toMatchObject({ status: "refused", reason: "over_daily_limit" });
  });

  it("a relaunch that does not fit even with its own hold credited is refused and leaves the own hold exactly as it was", async () => {
    await resume("op-1:resume", 10);
    await commit("op-1:resume");
    await pause("op-1:resume");
    expect(await resume("op-2:resume", 15)).toMatchObject({ status: "refused", reason: "over_month" });
    expect(await row("op-1:resume")).toMatchObject({ status: "released", reason: "paused", amt: 10 });
    expect(await row("op-2:resume")).toMatchObject({ status: "refused", reason: "over_month" });
    expect(await held()).toBe(10);
    expect(await commit("op-2:resume")).toBe("refused");
    expect(await row("op-1:resume")).toMatchObject({ status: "released", reason: "paused", amt: 10 });
  });

  it("an owner's over-cap relaunch is recorded over the cap and replaces the own hold when it commits, so the month counts it once", async () => {
    await resume("op-1:resume", 10);
    await commit("op-1:resume");
    expect(await resume("op-2:resume", 15, { overCapOk: true })).toMatchObject({ status: "held", reason: "over_cap", amount_usd: 15 });
    expect(await row("op-1:resume")).toMatchObject({ status: "committed", reason: null });
    await commit("op-2:resume");
    expect(await row("op-1:resume")).toMatchObject({ status: "released", reason: "rebased" });
    expect(await held()).toBe(15);
  });

  it("a relaunch that lands late (settled after not_landed, or resolved landed) replaces the own hold too", async () => {
    await resume("op-1:resume", 10);
    await commit("op-1:resume");
    await resume("op-2:resume", 10);
    await q("update ad_budget_reservations set status = 'released', reason = 'not_landed' where idem_key = 'op-2:resume'");
    expect(await row("op-1:resume")).toMatchObject({ status: "committed" });
    expect(await commit("op-2:resume")).toBe("committed");
    expect(await row("op-1:resume")).toMatchObject({ status: "released", reason: "rebased" });
    expect(await held()).toBe(10);
    await resume("op-3:resume", 10);
    const r = await one("select id, updated_at from ad_budget_reservations where idem_key = 'op-3:resume'");
    await q("update ad_budget_reservations set updated_at = now() - interval '3 hours' where id = $1", [r.id]);
    const seen = (await one("select updated_at from ad_budget_reservations where id = $1", [r.id])).updated_at;
    expect(((await one("select resolve_inflight_ad_hold($1, $2, 'landed', $3) as r", [T1, r.id, seen])).r as { status: string }).status).toBe("committed");
    expect(await row("op-2:resume")).toMatchObject({ status: "released", reason: "rebased" });
    expect(await held()).toBe(10);
  });

  it("another campaign's hold and another tenant's hold on the same id are never credited or replaced", async () => {
    await resume("other:resume", 10, { object: OTHER });
    await commit("other:resume");
    await resume("t2:resume", 10, { tenant: T2 });
    await commit("t2:resume", T2);
    expect(await ownHold(BOUND, T1)).toBe(0);
    expect(await ownHold(OTHER, T1)).toBe(10);
    expect(await ownHold(BOUND, T2)).toBe(10);
    expect(await resume("op-1:resume", 10)).toMatchObject({ status: "refused", reason: "over_month" });
    await q("update ad_budgets set monthly_usd = 30 where id = $1", [BUDGET]);
    expect(await resume("op-2:resume", 10)).toMatchObject({ status: "held" });
    expect(await commit("op-2:resume")).toBe("committed");
    expect(await row("other:resume")).toMatchObject({ status: "committed", reason: null });
    expect(await row("t2:resume")).toMatchObject({ status: "committed", reason: null });
    expect(await held(BUDGET2)).toBe(10);
    expect(await held()).toBe(20);
  });

  it("a meta resume on an object id is untouched: it still nets its own live hold and supersedes nothing", async () => {
    await one("select reserve_ad_spend($1, 'meta-1', 'meta', 'resume', $2, 1) as r", [T1, BOUND]);
    await commit("meta-1");
    expect(await one("select reserve_ad_spend($1, 'meta-2', 'meta', 'resume', $2, 1) as r", [T1, BOUND])).toMatchObject({ r: { status: "held", amount_usd: 0 } });
    await commit("meta-2");
    expect(await row("meta-1")).toMatchObject({ status: "committed", reason: null });
  });

  it("the hold the page credits is exactly what the server frees, even when per-row cents would round higher", async () => {
    await q("update ad_budgets set margin = 1.15 where id = $1", [BUDGET]);
    await unbounded("u-own", BOUND, 0.01);
    await unbounded("u-other", OTHER, 0.01);
    const total = Number((await one("select _ad_budget_held_usd($1, '2026-10-23'::date, 1.15) as h", [BUDGET])).h);
    const rest = Number((await one("select _ad_budget_held_usd_except($1, '2026-10-23'::date, 1.15, null, 'linkedin', $2) as h", [BUDGET, BOUND])).h);
    expect(total).toBe(0.21);
    expect(rest).toBe(0.11);
    expect(await ownHold()).toBe(0.1);
    expect(Number((await one("select _ad_budget_held_usd_except($1, '2026-10-23'::date, 1.15, null, 'linkedin', null) as h", [BUDGET])).h)).toBe(total);
    expect(await resume("op-big:resume", 8.608)).toMatchObject({ status: "refused", amount_usd: 9.9 });
    expect(await resume("op-fit:resume", 8.6)).toMatchObject({ status: "held", amount_usd: 9.89 });
  });

  it("a hold already given back (rejected, or released past its 48 hours) is not credited to the relaunch", async () => {
    await resume("op-1:resume", 10);
    await q("update ad_budget_reservations set status = 'released', reason = 'rejected' where idem_key = 'op-1:resume'");
    expect(await ownHold()).toBe(0);
    await resume("op-2:resume", 10);
    await commit("op-2:resume");
    await q("update ad_budget_reservations set status = 'released', reason = 'paused' where idem_key = 'op-2:resume'");
    await q("update ad_budget_reservations set released_at = now() - interval '49 hours' where idem_key = 'op-2:resume'");
    expect(await ownHold()).toBe(0);
    expect(await held()).toBe(0);
  });
});
