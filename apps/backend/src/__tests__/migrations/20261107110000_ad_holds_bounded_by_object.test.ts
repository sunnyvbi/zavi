import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const MIG_DIR = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20261107110000_ad_holds_bounded_by_object.sql";
const read = (f: string) => readFileSync(join(MIG_DIR, f), "utf8");
const sql = read(FILE);

function fnIn(text: string, name: string, create = "create or replace function"): string {
  const at = text.indexOf(`${create} public.${name}(`);
  if (at < 0) throw new Error(`no function ${name}`);
  const ends = [text.indexOf("end $$;", at), text.indexOf("\n$$;", at)].filter((x) => x >= 0);
  const e = Math.min(...ends);
  return text.slice(at, e + (e === text.indexOf("end $$;", at) ? "end $$;".length : "\n$$;".length));
}
function doBlocks(text: string): string[] {
  const out: string[] = [];
  let at = text.indexOf("\ndo $$");
  while (at >= 0) {
    const end = text.indexOf("\nend $$;", at);
    out.push(text.slice(at + 1, end + "\nend $$;".length));
    at = text.indexOf("\ndo $$", end);
  }
  return out;
}

describe(FILE, () => {
  const TOUCHES = /reserve_ad_spend|_ad_budget_held_usd|rebase_ad_spend_for_object/;
  const REDEFINES = /create\s+(or\s+replace\s+)?function\s+public\.(reserve_ad_spend|_ad_budget_held_usd|rebase_ad_spend_for_object)\s*\(/i;
  const outOfOrder = (files: Array<[string, string]>) =>
    files.filter(([f, src]) => f > FILE && REDEFINES.test(src)).map(([f]) => f);

  it("sorts after every earlier migration that touched the hold functions, and no later migration redefines them", () => {
    const all = readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql")).sort();
    expect(all).toContain(FILE);
    const earlier = all.filter((x) => x < FILE && TOUCHES.test(read(x)));
    expect(earlier.length).toBeGreaterThan(0);
    for (const f of earlier) expect(FILE > f).toBe(true);
    expect(outOfOrder(all.map((f) => [f, read(f)]))).toEqual([]);
  });

  it("the later-migration check fails a real redefinition and passes a mere mention or a sibling function", () => {
    const later = "20991231000000_later.sql";
    for (const src of [
      "create or replace function public.reserve_ad_spend(p uuid) returns jsonb",
      "CREATE FUNCTION public._ad_budget_held_usd (p uuid) returns numeric",
      "create   or   replace\n function public.rebase_ad_spend_for_object(\n p uuid)",
    ])
      expect(outOfOrder([[later, src]])).toEqual([later]);
    for (const src of [
      "select reserve_ad_spend(...); perform _ad_budget_held_usd(b, d, m);",
      "create or replace function public._ad_budget_held_usd_except(p uuid) returns numeric",
      "body := pg_get_functiondef('public.reserve_ad_spend'::regproc); execute body;",
      "create or replace function public.rebase_ad_spend_for_object_v2(p uuid)",
    ])
      expect(outOfOrder([[later, src]])).toEqual([]);
    expect(outOfOrder([["20200101000000_old.sql", "create or replace function public.reserve_ad_spend(p uuid)"]])).toEqual([]);
  });

  it("the rebuilt bodies keep the five in-place patch markers", () => {
    const reserve = fnIn(sql, "reserve_ad_spend", "create function");
    const rebase = fnIn(sql, "rebase_ad_spend_for_object");
    for (const body of [reserve, rebase]) {
      expect(body).toContain("not in ('meta', 'google', 'x', 'reddit', 'chatgpt', 'tiktok', 'linkedin')");
      expect(body).toContain("p_platform in ('chatgpt', 'x') then 2");
    }
    expect(reserve).toContain("v_budget.read_failed ? p_platform");
    expect(sql).toContain("r.platform not in (''chatgpt'', ''x'', ''tiktok'', ''linkedin'')");
  });

  it("guards each live body by md5 before replacing it, and keeps one reserve_ad_spend overload", () => {
    expect(sql.match(/md5\(prosrc\)/g)?.length).toBe(3);
    expect(sql).toContain("drop function public.reserve_ad_spend(uuid, text, text, text, text, numeric, uuid, uuid, boolean);");
    expect(sql).toContain("grant execute on function public.reserve_ad_spend(uuid, text, text, text, text, numeric, uuid, uuid, boolean, date, numeric, numeric, boolean) to service_role;");
  });
});

const PG_URL = process.env.ZAVI_TEST_VANILLA_PG_URL;

const BOOTSTRAP = `
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
  end $$;
  create table tenants (id uuid primary key);
  create table channel_actions (id uuid primary key default gen_random_uuid(), tenant_id uuid not null,
    exec_class text, exec_status text, exec_result jsonb);
  create table decisions (id uuid primary key default gen_random_uuid(), tenant_id uuid not null);
  create table ad_budgets (
    id uuid primary key default gen_random_uuid(), tenant_id uuid not null, status text not null default 'active',
    monthly_usd numeric(12,2) not null, daily_limit_usd numeric(12,2), margin numeric not null default 1.0,
    started_on date not null, month_start date not null, spent_usd numeric(12,2) not null default 0,
    read_failed jsonb not null default '{}'::jsonb, actual_read_at timestamptz,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now());
  create table ad_budget_reservations (
    id uuid primary key default gen_random_uuid(),
    budget_id uuid not null references ad_budgets(id), tenant_id uuid not null,
    idem_key text not null, platform text not null constraint ad_budget_reservations_platform_check check (platform in ('meta', 'google', 'chatgpt')),
    object_id text, op text not null check (op in ('raise', 'resume', 'create', 'rebase')),
    daily_delta_usd numeric(12,2) not null default 0, amount_usd numeric(12,2) not null default 0,
    status text not null default 'reserved' check (status in ('reserved', 'committed', 'released', 'refused')),
    reason text, released_on date, pause_due boolean not null default false, paused boolean not null default false,
    channel_action_id uuid, decision_id uuid, provider_ref jsonb,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
    unique (budget_id, idem_key));
  create table ad_campaigns (tenant_id uuid not null, platform text not null constraint ad_campaigns_platform_check check (platform in ('meta', 'google', 'reddit', 'tiktok', 'chatgpt')),
    account_id text, object_id text not null, level text, campaign_id text, status text, budget_kind text, budget_usd numeric,
    campaign_budget_usd numeric, as_of timestamptz, source text);
  create table ad_spend_daily (tenant_id uuid not null, platform text not null constraint ad_spend_daily_platform_check check (platform in ('meta', 'google', 'reddit', 'tiktok', 'chatgpt')),
    account_id text not null default 'acct', object_id text not null, spend_date date not null, amount_usd numeric(12,2) not null,
    source text not null default 'api', unique (tenant_id, platform, account_id, object_id, spend_date, source));
  create table ad_budget_plan (platform text constraint ad_budget_plan_platform_check check (platform in ('meta', 'google', 'reddit', 'tiktok', 'chatgpt')));
  create table ad_object_changes (platform text constraint ad_object_changes_platform_check check (platform in ('meta', 'google', 'chatgpt')),
    level text constraint ad_object_changes_level_check check (level is null or level in ('ad_set', 'campaign')));
  create table creator_hire_spend (budget_id uuid, state text, amount_usd numeric, refunded_usd numeric, reserved_on date);
  -- The test controls "today".
  create function _ad_budget_today() returns date language sql stable as $$
    select coalesce(nullif(current_setting('zavi.today', true), '')::date, (now() at time zone 'utc')::date) $$;
`;

function history(): string {
  const monthly = read("20260929010000_ad_budget_monthly.sql");
  const parts = [
    fnIn(monthly, "_ad_budget_days_left"),
    fnIn(monthly, "_ad_budget_days_in_month"),
    fnIn(monthly, "_ad_budget_month_cap"),
    fnIn(monthly, "_ad_budget_spent_usd"),
    fnIn(monthly, "release_ad_spend_for_object"),
    fnIn(read("20261005090000_creator_hire_budget.sql"), "_creator_hire_used_usd"),
    fnIn(read("20261021120000_cgo_inflight_ad_holds.sql"), "settle_ad_spend"),
    fnIn(read("20261031130000_ad_pending_tests.sql"), "release_pending_test_hold"),
    fnIn(read("20261012110000_cgo_spend_pace_holds.sql"), "_ad_budget_held_usd"),
  ];
  const chatgpt = read("20261023125328_chatgpt_growth_autopilot.sql");
  parts.push(fnIn(chatgpt, "reserve_ad_spend"), fnIn(chatgpt, "rebase_ad_spend_for_object"), fnIn(chatgpt, "shrink_underdelivering_ad_holds"));
  const patched = (f: string) => doBlocks(read(f)).filter((b) => /reserve_ad_spend|shrink_underdelivering_ad_holds/.test(b));
  for (const f of ["20261025120000_reddit_ads_execution.sql", "20261025130000_x_ads_management_and_budget.sql", "20261025140000_ad_ledger_all_platforms.sql",
    "20261026100000_tiktok_ads_held_writes.sql", "20261101163000_linkedin_wallet_budget_gate.sql"]) {
    const blocks = patched(f);
    if (blocks.length === 0) throw new Error(`no patch block in ${f}`);
    parts.push(...blocks);
  }
  return parts.join(";\n\n");
}

describe.skipIf(!PG_URL)("20261107110000 live", () => {
  let admin: Client;
  let db: Client;
  const dbName = `zavi_holds_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const T = randomUUID();
  let budget = "";
  let card = "";
  const before: Record<string, unknown> = {};

  const one = async <R = Record<string, unknown>>(q: string, p: unknown[] = []): Promise<R> => (await db.query(q, p)).rows[0] as R;
  const reserve = async (args: Record<string, unknown>) => {
    const keys = Object.keys(args);
    const r = await one<{ r: Record<string, unknown> }>(
      `select reserve_ad_spend(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) r`, keys.map((k) => args[k]));
    return r.r;
  };
  const held = async () => Number((await one<{ h: string }>("select _ad_budget_held_usd($1, _ad_budget_today(), 1.0) h", [budget])).h);
  const resetBudget = async (monthly: number, spent = 0, daily: number | null = null) => {
    await db.query("delete from ad_spend_daily; delete from ad_budget_reservations;");
    await db.query("update ad_budgets set monthly_usd = $2, spent_usd = $3, daily_limit_usd = $4, read_failed = '{}' where id = $1", [budget, monthly, spent, daily]);
  };
  const REGRESSION: Array<[string, Record<string, unknown>]> = [];
  for (const platform of ["meta", "google", "chatgpt", "reddit", "x", "tiktok", "linkedin"]) {
    REGRESSION.push([`${platform}:create`, { p_platform: platform, p_op: "create", p_object_id: null, p_daily_delta_usd: 10 }]);
    REGRESSION.push([`${platform}:create-paused`, { p_platform: platform, p_op: "create", p_object_id: null, p_daily_delta_usd: 10, p_paused: true }]);
    REGRESSION.push([`${platform}:raise`, { p_platform: platform, p_op: "raise", p_object_id: `obj-${platform}`, p_daily_delta_usd: 7.5 }]);
    REGRESSION.push([`${platform}:resume`, { p_platform: platform, p_op: "resume", p_object_id: `obj-${platform}`, p_daily_delta_usd: 12 }]);
    REGRESSION.push([`${platform}:over`, { p_platform: platform, p_op: "create", p_object_id: null, p_daily_delta_usd: 400 }]);
  }
  const runRegression = async () => {
    const out: Record<string, unknown> = {};
    for (const [name, args] of REGRESSION) {
      await resetBudget(1000);
      const r = await reserve({ p_tenant_id: T, p_idem_key: `k:${name}`, ...args });
      const row = await one("select daily_delta_usd, amount_usd, status, reason, paused from ad_budget_reservations where idem_key = $1", [`k:${name}`]);
      out[name] = { r, row, held: await held() };
    }
    return out;
  };

  beforeAll(async () => {
    admin = new Client({ connectionString: PG_URL });
    await admin.connect();
    await admin.query(`create database ${dbName}`);
    const url = new URL(PG_URL!);
    url.pathname = `/${dbName}`;
    db = new Client({ connectionString: url.toString() });
    await db.connect();
    await db.query(BOOTSTRAP);
    await db.query(history());
    await db.query("set zavi.today = '2026-10-15'");
    await db.query("insert into tenants values ($1)", [T]);
    budget = (await one<{ id: string }>("insert into ad_budgets (tenant_id, monthly_usd, started_on, month_start) values ($1, 58, '2026-09-01', '2026-10-01') returning id", [T])).id;
    card = (await one<{ id: string }>("insert into channel_actions (tenant_id) values ($1) returning id", [T])).id;
    Object.assign(before, await runRegression());
    await db.query(sql);
  }, 60_000);

  afterAll(async () => {
    await db?.end();
    if (admin) {
      await admin.query(`drop database if exists ${dbName}`);
      await admin.end();
    }
  });

  it("every call without the new arguments answers exactly as before (each op, each platform)", async () => {
    const after = await runRegression();
    expect(after).toEqual(before);
  });

  it("aethel: a $58 ChatGPT lifetime total with $58 left holds $58.00, not $850", async () => {
    await resetBudget(58);
    const r = await reserve({ p_tenant_id: T, p_idem_key: "aethel", p_platform: "chatgpt", p_op: "create", p_object_id: null, p_daily_delta_usd: 0, p_cap_usd: 58 });
    expect(r).toMatchObject({ status: "held", amount_usd: 58 });
    expect(await one("select bounded, cap_usd::float as cap, amount_usd::float as amt from ad_budget_reservations where idem_key = 'aethel'")).toEqual({ bounded: true, cap: 58, amt: 58 });
    expect(await held()).toBe(58);
    const daily = await reserve({ p_tenant_id: T, p_idem_key: "aethel-daily", p_platform: "chatgpt", p_op: "create", p_object_id: null, p_daily_delta_usd: 25 });
    expect(daily).toMatchObject({ status: "refused", amount_usd: 850, reason: "over_month" });
  });

  it("the hold nets the object's recorded spend, keeps it 48h after a stop, then frees it", async () => {
    await resetBudget(100);
    await reserve({ p_tenant_id: T, p_idem_key: "net", p_platform: "chatgpt", p_op: "create", p_object_id: null, p_daily_delta_usd: 0, p_cap_usd: 58 });
    await one("select settle_ad_spend($1, 'net', 'committed', 'cmpn_1') r", [T]);
    await db.query("insert into ad_spend_daily (tenant_id, platform, object_id, spend_date, amount_usd, source) values ($1, 'chatgpt', 'cmpn_1', (now() at time zone 'utc')::date, 20, 'api'), ($1, 'chatgpt', 'cmpn_1', (now() at time zone 'utc')::date, 15, 'connector')", [T]);
    expect(await held()).toBe(38);
    await one("select release_ad_spend_for_object($1, 'chatgpt', 'cmpn_1') r", [T]);
    const row = await one<{ status: string; released_at: string | null }>("select status, released_at from ad_budget_reservations where idem_key = 'net'");
    expect(row.status).toBe("released");
    expect(row.released_at).not.toBeNull();
    expect(await held()).toBe(38);
    await db.query("update ad_budget_reservations set released_at = now() - interval '49 hours' where idem_key = 'net'");
    expect(await held()).toBe(0);
  });

  it("end-dated holds: TikTok 9 days at $20.01 x1 = $180.09; Meta 9 days at $10 x1.75 = $157.50", async () => {
    await resetBudget(500);
    const t = await reserve({ p_tenant_id: T, p_idem_key: "tt", p_platform: "tiktok", p_op: "create", p_object_id: null, p_daily_delta_usd: 20.01, p_ends_on: "2026-10-24", p_factor: 1 });
    expect(t).toMatchObject({ status: "held", amount_usd: 180.09 });
    const m = await reserve({ p_tenant_id: T, p_idem_key: "meta", p_platform: "meta", p_op: "create", p_object_id: null, p_daily_delta_usd: 10, p_ends_on: "2026-10-24", p_factor: 1.75 });
    expect(m).toMatchObject({ status: "held", amount_usd: 157.5 });
    expect(await held()).toBe(337.59);
    const long = await reserve({ p_tenant_id: T, p_idem_key: "long", p_platform: "meta", p_op: "create", p_object_id: null, p_daily_delta_usd: 1, p_ends_on: "2026-12-31", p_factor: 1 });
    expect(long).toMatchObject({ status: "held", amount_usd: 17 });
    const cg = await reserve({ p_tenant_id: T, p_idem_key: "cg-end", p_platform: "chatgpt", p_op: "create", p_object_id: null, p_daily_delta_usd: 25, p_ends_on: "2026-10-17" });
    expect(cg).toMatchObject({ status: "held", amount_usd: 100 });
  });

  it("an end-dated hold carried over from last month holds only the days left to its end", async () => {
    await resetBudget(500);
    await reserve({ p_tenant_id: T, p_idem_key: "carry", p_platform: "tiktok", p_op: "create", p_object_id: "ag1", p_daily_delta_usd: 25, p_ends_on: "2026-11-04", p_factor: 1 });
    await db.query("update ad_budget_reservations set status = 'committed', created_at = '2026-10-28T12:00:00Z' where idem_key = 'carry'");
    await db.query("set zavi.today = '2026-11-01'");
    try {
      expect(await held()).toBe(75);
    } finally {
      await db.query("set zavi.today = '2026-10-15'");
    }
  });

  it("a rebase keeps the bound and never raises the amount; a lifetime total is never lowered by a daily rate", async () => {
    await resetBudget(500);
    await reserve({ p_tenant_id: T, p_idem_key: "rb", p_platform: "meta", p_op: "create", p_object_id: null, p_daily_delta_usd: 20, p_ends_on: "2026-10-24", p_factor: 1.75 });
    await one("select settle_ad_spend($1, 'rb', 'committed', 'adset_1') r", [T]);
    await db.query("insert into ad_spend_daily (tenant_id, platform, object_id, spend_date, amount_usd) values ($1, 'meta', 'adset_1', (now() at time zone 'utc')::date, 30)", [T]);
    const r = await one<{ r: Record<string, unknown> }>("select rebase_ad_spend_for_object($1, 'meta', 'adset_1', 10, 'live:cut') r", [T]);
    expect(r.r).toMatchObject({ status: "rebased", daily_usd: 17.5 });
    const row = await one<Record<string, unknown>>("select bounded, ends_on::text, hold_factor::float as f, amount_usd::float as amt, spend_from::text from ad_budget_reservations where idem_key = 'live:cut'");
    expect(row).toMatchObject({ bounded: true, ends_on: "2026-10-24", f: 1.75, amt: 187.5 });
    expect(await held()).toBe(157.5);
    const up = await one<{ r: Record<string, unknown> }>("select rebase_ad_spend_for_object($1, 'meta', 'adset_1', 30, 'live:up') r", [T]);
    expect(up.r).toMatchObject({ status: "not_lower" });
    await reserve({ p_tenant_id: T, p_idem_key: "lt", p_platform: "chatgpt", p_op: "create", p_object_id: null, p_daily_delta_usd: 0, p_cap_usd: 58 });
    await one("select settle_ad_spend($1, 'lt', 'committed', 'cmpn_lt') r", [T]);
    const lt = await one<{ r: Record<string, unknown> }>("select rebase_ad_spend_for_object($1, 'chatgpt', 'cmpn_lt', 1, 'live:lt') r", [T]);
    expect(["not_lower", "no_hold"]).toContain(lt.r.status);
  });

  it("over the month cap: refused without p_over_cap_ok; recorded (over_cap) with it; never past the daily limit", async () => {
    await resetBudget(58);
    const no = await reserve({ p_tenant_id: T, p_idem_key: "oc1", p_platform: "chatgpt", p_op: "create", p_object_id: null, p_daily_delta_usd: 0, p_cap_usd: 60 });
    expect(no).toMatchObject({ status: "refused", reason: "over_month" });
    const yes = await reserve({ p_tenant_id: T, p_idem_key: "oc2", p_platform: "chatgpt", p_op: "create", p_object_id: null, p_daily_delta_usd: 0, p_cap_usd: 60, p_over_cap_ok: true });
    expect(yes).toMatchObject({ status: "held", reason: "over_cap", amount_usd: 60 });
    expect(await one("select status, over_cap from ad_budget_reservations where idem_key = 'oc2'")).toEqual({ status: "reserved", over_cap: true });
    await resetBudget(1000, 0, 10);
    const daily = await reserve({ p_tenant_id: T, p_idem_key: "oc3", p_platform: "meta", p_op: "create", p_object_id: null, p_daily_delta_usd: 20, p_ends_on: "2026-10-17", p_over_cap_ok: true });
    expect(daily).toMatchObject({ status: "refused", reason: "over_daily_limit" });
    await resetBudget(1000);
    await db.query("update ad_budgets set read_failed = '{\"meta\": \"2026-10-15T00:00:00Z\"}' where id = $1", [budget]);
    const unread = await reserve({ p_tenant_id: T, p_idem_key: "oc4", p_platform: "meta", p_op: "create", p_object_id: null, p_daily_delta_usd: 5, p_ends_on: "2026-10-17", p_over_cap_ok: true });
    expect(unread).toMatchObject({ status: "refused", reason: "platform_unread" });
  });

  it("a lifetime total counts toward the daily limit at its worst-day share (F3): $100 over 4 days at 2x = $50/day", async () => {
    await resetBudget(1000, 0, 25);
    const no = await reserve({ p_tenant_id: T, p_idem_key: "dl1", p_platform: "chatgpt", p_op: "create", p_object_id: null, p_daily_delta_usd: 50, p_cap_usd: 100, p_factor: 1 });
    expect(no).toMatchObject({ status: "refused", reason: "over_daily_limit" });
    await resetBudget(1000, 0, 60);
    const yes = await reserve({ p_tenant_id: T, p_idem_key: "dl2", p_platform: "chatgpt", p_op: "create", p_object_id: null, p_daily_delta_usd: 50, p_cap_usd: 100, p_factor: 1 });
    expect(yes).toMatchObject({ status: "held", amount_usd: 100 });
    await resetBudget(1000, 0, 60);
    expect(await reserve({ p_tenant_id: T, p_idem_key: "dl4", p_platform: "chatgpt", p_op: "create", p_object_id: null, p_daily_delta_usd: 100, p_cap_usd: 100, p_factor: 1 })).toMatchObject({ status: "refused", reason: "over_daily_limit" });
    await resetBudget(58);
    expect(await reserve({ p_tenant_id: T, p_idem_key: "dl3", p_platform: "chatgpt", p_op: "create", p_object_id: null, p_daily_delta_usd: 58, p_cap_usd: 58, p_factor: 1 })).toMatchObject({ status: "held", amount_usd: 58 });
  });

  it("only a create may be bounded; bad caps and factors raise", async () => {
    await resetBudget(1000);
    await expect(reserve({ p_tenant_id: T, p_idem_key: "b1", p_platform: "meta", p_op: "raise", p_object_id: "o", p_daily_delta_usd: 5, p_ends_on: "2026-10-20" })).rejects.toThrow(/only a create/);
    await expect(reserve({ p_tenant_id: T, p_idem_key: "b2", p_platform: "meta", p_op: "create", p_object_id: null, p_daily_delta_usd: 5, p_cap_usd: 0 })).rejects.toThrow(/lifetime cap/);
    await expect(reserve({ p_tenant_id: T, p_idem_key: "b3", p_platform: "meta", p_op: "create", p_object_id: null, p_daily_delta_usd: 5, p_ends_on: "2026-10-20", p_factor: 0.5 })).rejects.toThrow(/hold factor/);
  });

  it("per platform: a bounded create holds the bounded amount and is accepted; rebase keeps the bound", async () => {
    for (const platform of ["meta", "google", "chatgpt", "reddit", "x", "tiktok", "linkedin"]) {
      await resetBudget(1000);
      const r = await reserve({ p_tenant_id: T, p_idem_key: `pp:${platform}`, p_platform: platform, p_op: "create", p_object_id: null, p_daily_delta_usd: 10, p_ends_on: "2026-10-18", p_factor: 1 });
      expect(r).toMatchObject({ status: "held", amount_usd: 30 });
      await one("select settle_ad_spend($1, $2, 'committed', $3) r", [T, `pp:${platform}`, `o-${platform}`]);
      const rb = await one<{ r: Record<string, unknown> }>("select rebase_ad_spend_for_object($1, $2, $3, 5, $4) r", [T, platform, `o-${platform}`, `pp-rb:${platform}`]);
      expect(rb.r).toMatchObject({ status: "rebased" });
      expect(await one("select bounded, ends_on::text from ad_budget_reservations where idem_key = $1", [`pp-rb:${platform}`])).toEqual({ bounded: true, ends_on: "2026-10-18" });
      expect(await held()).toBe(15);
    }
  });

  it("released_at is set on every release path and cleared on a reopen", async () => {
    await resetBudget(1000);
    await reserve({ p_tenant_id: T, p_idem_key: "rel1", p_platform: "meta", p_op: "create", p_object_id: null, p_daily_delta_usd: 5, p_ends_on: "2026-10-20" });
    await one("select settle_ad_spend($1, 'rel1', 'released') r", [T]);
    expect((await one<{ at: string | null }>("select released_at at from ad_budget_reservations where idem_key = 'rel1'")).at).not.toBeNull();
    expect(await held()).toBe(0);
    await reserve({ p_tenant_id: T, p_idem_key: "rel1", p_platform: "meta", p_op: "create", p_object_id: null, p_daily_delta_usd: 5, p_ends_on: "2026-10-20" });
    expect(await one("select status, released_at from ad_budget_reservations where idem_key = 'rel1'")).toEqual({ status: "reserved", released_at: null });
    await reserve({ p_tenant_id: T, p_idem_key: "rel2", p_platform: "tiktok", p_op: "create", p_object_id: null, p_daily_delta_usd: 25, p_ends_on: "2026-10-20", p_channel_action_id: card });
    await one("select release_pending_test_hold($1, 'rel2', $2) r", [T, card]);
    expect((await one<{ at: string | null }>("select released_at at from ad_budget_reservations where idem_key = 'rel2'")).at).not.toBeNull();
    await reserve({ p_tenant_id: T, p_idem_key: "rel3", p_platform: "google", p_op: "create", p_object_id: null, p_daily_delta_usd: 9, p_ends_on: "2026-10-20" });
    await one("select settle_ad_spend($1, 'rel3', 'committed', 'g3') r", [T]);
    await one("select rebase_ad_spend_for_object($1, 'google', 'g3', 4, 'rel3-rb') r", [T]);
    expect(await one("select status, reason, released_at is not null as set from ad_budget_reservations where idem_key = 'rel3'")).toEqual({ status: "released", reason: "rebased", set: true });
    await one("select release_ad_spend_for_object($1, 'google', 'g3') r", [T]);
    expect((await one<{ set: boolean }>("select released_at is not null as set from ad_budget_reservations where idem_key = 'rel3-rb'")).set).toBe(true);
    await reserve({ p_tenant_id: T, p_idem_key: "rel4", p_platform: "meta", p_op: "create", p_object_id: "m4", p_daily_delta_usd: 5, p_ends_on: "2026-10-20" });
    await db.query("update ad_budget_reservations set status = 'released', reason = 'live_stopped', released_on = '2026-10-15' where idem_key = 'rel4'");
    expect((await one<{ set: boolean }>("select released_at is not null as set from ad_budget_reservations where idem_key = 'rel4'")).set).toBe(true);
  });

  it("shrink skips objects with a bounded hold", async () => {
    const def = (await one<{ d: string }>("select pg_get_functiondef('public.shrink_underdelivering_ad_holds(uuid)'::regprocedure) d")).d;
    expect(def).toContain("and not bool_or(r.pause_due) and not bool_or(r.bounded)");
  });
});
