import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const modules = process.env.ADS_SQL_TEST_MODULES;
const MIGRATIONS = resolve(__dirname, "../../../../../../supabase/migrations");
const T = "11111111-1111-1111-1111-111111111111";
const T2 = "22222222-2222-2222-2222-222222222222";

const CHAIN = [
  "20260928210000_ad_budget_core", "20260928230000_ad_budget_setup_ledger", "20260928230100_ad_budget_reconcile",
  "20260928233000_ad_budget_end_pauses", "20260929010000_ad_budget_monthly", "20260929210000_ad_budget_events",
  "20260930010000_ad_ledger", "20260930020000_ad_ledger_removed_objects", "20260930030000_ad_budget_brake",
  "20260930193700_ad_object_changes", "20261005090000_creator_hire_budget", "20261005140000_autopilot_tracking_links",
  "20261012110000_cgo_spend_pace_holds", "20261012140000_cgo_spend_holds_cbo_and_freshness",
  "20261013110000_cgo_cbo_holds_ignore_stale_children", "20261016180000_cgo_holds_removed_objects_and_cbo_budget",
  "20261017100000_cgo_unknown_ad_holds", "20261021120000_cgo_inflight_ad_holds", "20261022140000_ad_budget_raise_holds_increase",
  "20260909200000_set_channel_autorun", "20261023125328_chatgpt_growth_autopilot", "20261025120000_reddit_ads_execution",
  "20261025130000_x_ads_management_and_budget", "20261025140000_ad_ledger_all_platforms", "20261026100000_tiktok_ads_held_writes",
  "20261031190000_ad_holds_follow_live", "20261031200000_ad_holds_sync_read_fence", "20261101172000_ad_holds_sync_lineage",
  "20261101163000_linkedin_wallet_budget_gate", "20261107110000_ad_holds_bounded_by_object",
  "20261111170001_tiktok_ads_live_hold_sync",
  "20261121100100_linkedin_resume_bounded_hold", "20261121100200_linkedin_relaunch_supersedes_own_hold",
  "20261122122329_tiktok_dynamic_delivery_holds",
];

const STUBS = `
create role anon; create role authenticated; create role service_role;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
create function public.app_active_tenant() returns uuid language sql stable as $$ select null::uuid $$;
create table public.tenants (id uuid primary key);
create table public.ads_provider_accounts (id uuid primary key, platform text, provider_account_id text);
create table public.ads_campaign_bindings (id uuid primary key, tenant_id uuid, account_id uuid, provider_campaign_id text);
create table public.tenant_users (tenant_id uuid references public.tenants(id) on delete cascade, user_id uuid, role text);
create table public.agent_runs (id uuid primary key, tenant_id uuid not null references public.tenants(id) on delete cascade, payload jsonb not null default '{}');
alter table public.agent_runs add constraint agent_runs_id_tenant_uq unique (id, tenant_id);
create table public.decisions (id uuid primary key, tenant_id uuid not null references public.tenants(id) on delete cascade,
  agent_run_id uuid references public.agent_runs(id) on delete cascade, decision_class text);
create table public.channel_actions (id uuid primary key, tenant_id uuid not null references public.tenants(id) on delete cascade,
  run_id uuid not null references public.agent_runs(id) on delete cascade, unique (tenant_id, id));
create table public.creator_offers (id uuid primary key, tenant_id uuid not null references public.tenants(id) on delete cascade, unique (tenant_id, id));
create table public.creator_orders (id uuid primary key, tenant_id uuid not null references public.tenants(id) on delete cascade, unique (tenant_id, id));
create table public.autopilot_goals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  objective text not null, target_metric text not null, target_value numeric not null,
  baseline_value numeric, current_value numeric, due_date date,
  status text not null default 'active', priority int not null default 50,
  source text not null default 'founder',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  cgo_status_line text, cgo_status_at timestamptz, cgo_undo jsonb, count_rule jsonb);
create table public.staff_users (user_id uuid primary key, revoked_at timestamptz);
create function public._tenant_tier(p uuid) returns text language sql stable as $$ select 'pro'::text $$;
create table public.tenant_channels (tenant_id uuid references public.tenants(id), channel_slug text, autorun boolean default false,
  autorun_set_by text, primary key (tenant_id, channel_slug));
create table public.decision_classes (slug text primary key, description text, default_autonomy text, dispatch_handler text,
  never_auto boolean, click_allowlistable boolean, severity text);
`;

type Db = { exec: (q: string) => Promise<unknown>; query: (q: string, p?: unknown[]) => Promise<{ rows: any[] }>; close: () => Promise<void> };
let db: Db;

const one = async (q: string, p: unknown[] = []) => (await db.query(q, p)).rows[0];

async function hold(key: string, op: string, object: string, daily: number, o: { status?: string; age?: string; tenant?: string } = {}) {
  const tenant = o.tenant ?? T;
  if (op === "raise") await db.query("insert into decisions (id, tenant_id) values (md5($1)::uuid, $2) on conflict do nothing", [key, tenant]);
  await db.query(
    `insert into ad_budget_reservations (budget_id, tenant_id, idem_key, platform, object_id, op, daily_delta_usd, amount_usd, status, decision_id, created_at, updated_at)
     values ((select id from ad_budgets where tenant_id = $1 and status = 'active'), $1, $2, 'meta', $3, $4, $5::numeric, $5::numeric * 20, $6,
             case when $4::text = 'raise' then md5($2)::uuid end, now() - $7::interval, now() - $7::interval)`,
    [tenant, key, object, op, daily, o.status ?? "committed", o.age ?? "100 hours"],
  );
}

async function zaviChange(object: string, kind: "status" | "budget", before: number | null, after: number | null, fromKey?: string) {
  await db.query(
    `insert into ad_object_changes (tenant_id, platform, object_id, level, source, action_table, action_id, change_kind, before_daily_usd, after_daily_usd, occurred_at)
     values ($1, 'meta', $2, 'ad_set', 'zavi', $3, case when $4::text is null then gen_random_uuid() else md5($4::text)::uuid end, $5, $6::numeric, $7::numeric, now() - interval '100 hours')`,
    [T, object, fromKey ? "decisions" : "channel_actions", fromKey ?? null, kind, before, after],
  );
}

async function ledger(object: string, status: string, budget: number | null, age = "5 minutes", cbo?: { campaign: string; budget: number }) {
  await db.query(
    `insert into ad_campaigns (tenant_id, platform, account_id, object_id, level, campaign_id, budget_kind, budget_usd, campaign_budget_usd, status, currency, source, as_of)
     values ($1, 'meta', 'acct', $2, 'ad_set', $3, $4, $5::numeric, $6::numeric, $7, 'USD', 'api', now() - $8::interval)
     on conflict (tenant_id, platform, account_id, object_id) do update
       set status = excluded.status, budget_kind = excluded.budget_kind, budget_usd = excluded.budget_usd,
           campaign_budget_usd = excluded.campaign_budget_usd, as_of = excluded.as_of`,
    [T, object, cbo?.campaign ?? null, cbo ? "campaign_level" : "daily", budget, cbo?.budget ?? null, status, age],
  );
}

const held = async (object: string) =>
  Number((await one("select coalesce(sum(daily_delta_usd), 0) v from ad_budget_reservations where tenant_id = $1 and object_id = $2 and status = 'committed'", [T, object])).v);

let base = "";
type SyncOut = { lowered: number; released: number };
const syncAt = async (ago: string) =>
  (await one("select sync_ad_holds_to_live($1, array['meta'], $2::timestamptz - $3::interval) r", [T, base, ago])).r as SyncOut;
const sync = async (ago?: string) => {
  if (ago) return syncAt(ago);
  await syncAt("66 minutes");
  return syncAt("6 minutes");
};

async function nextHour(object: string) {
  await db.query("update ad_budget_reservations set created_at = created_at - interval '1 hour', updated_at = updated_at - interval '1 hour' where object_id = $1", [object]);
  await db.query("update ad_hold_live_reads set cur_read_at = cur_read_at - interval '1 hour', prev_read_at = prev_read_at - interval '1 hour' where object_id = $1", [object]);
  await db.query("update ad_campaigns set as_of = now() - interval '5 minutes' where object_id = $1 or campaign_id = $1 and status <> 'REMOVED'", [object]);
}

describe("sync_ad_holds_to_live on real Postgres: the next hour and a read under way", () => {
  beforeAll(async () => {
    const { PGlite } = createRequire(modules ? resolve(modules, "../package.json") : resolve("package.json"))("@electric-sql/pglite");
    db = new PGlite();
    await db.exec(STUBS);
    for (const m of CHAIN) await db.exec(readFileSync(resolve(MIGRATIONS, `${m}.sql`), "utf8"));
    await db.exec("create or replace function _ad_budget_today() returns date language sql stable as $$ select date '2026-10-12' $$;");
  }, 120_000);
  afterAll(async () => {
    await db?.close();
  });
  beforeEach(async () => {
    await db.exec("truncate tenants cascade");
    await db.query("insert into tenants values ($1), ($2)", [T, T2]);
    await db.query(
      "insert into ad_budgets (tenant_id, monthly_usd, started_on, month_start, spent_usd, margin, actual_read_at) values ($1, 50000, '2026-09-28', '2026-10-01', 0, 1.0, now()), ($2, 50000, '2026-09-28', '2026-10-01', 0, 1.0, now())",
      [T, T2],
    );
    base = (await one("select now()::text v")).v;
  });

  it("holds dynamic TikTok exposure at 125%, preserves it across cuts and live sync, and leaves DAY at 1x", async () => {
    for (const [id, factor] of [["dynamic", 1.25], ["ordinary", null]] as const) {
      const result = (await one("select reserve_ad_spend($1, $2, 'tiktok', 'resume', $2, 100, p_factor => $3::numeric) r", [T, id, factor])).r;
      expect(result.status).toBe("held");
      await db.query("update ad_budget_reservations set status = 'committed', created_at = now() - interval '100 hours', updated_at = now() - interval '100 hours' where object_id = $1", [id]);
      expect(await held(id)).toBe(id === "dynamic" ? 125 : 100);
    }
    await db.query("update ad_budgets set monthly_usd = 1 where tenant_id = $1", [T]);
    const again = (await one("select reserve_ad_spend($1, 'another-ad:resume:dynamic', 'tiktok', 'resume', 'dynamic', 100, p_factor => 1.25) r", [T])).r;
    expect(again.status).toBe("held");
    expect(Number(again.amount_usd)).toBe(0);
    await db.query("update ad_budget_reservations set status = 'committed' where idem_key = 'another-ad:resume:dynamic'");
    expect(await held("dynamic")).toBe(125);
    expect((await one("select rebase_ad_spend_for_object($1, 'tiktok', 'dynamic', 80, 'cut1', 20) r", [T])).r.status).toBe("rebased");
    expect(await held("dynamic")).toBe(100);
    expect(Number((await one("select hold_factor f from ad_budget_reservations where object_id = 'dynamic' and status = 'committed'")).f)).toBe(1.25);
    await db.query("select rebase_ad_spend_for_object($1, 'tiktok', 'dynamic', 60, 'cut2', 20)", [T]);
    expect(await held("dynamic")).toBe(75);
    await db.query("update ad_budget_reservations set created_at = now() - interval '100 hours', updated_at = now() - interval '100 hours' where object_id = 'dynamic'");
    await ledger("dynamic", "ACTIVE", 60);
    await db.query("update ad_campaigns set platform = 'tiktok', level = 'ad_group' where object_id = 'dynamic'");
    for (const ago of ["66 minutes", "6 minutes"]) await db.query("select sync_ad_holds_to_live($1, array['tiktok'], $2::timestamptz - $3::interval)", [T, base, ago]);
    expect(await held("dynamic")).toBe(75);
    expect(await held("ordinary")).toBe(100);
  });

  it("releases a TikTok launch hold only after two fresh ENDED reads agree", async () => {
    await hold("ended:create", "create", "ended", 20.01);
    await ledger("ended", "ENDED", 20.01);
    await db.query("update ad_budget_reservations set platform = 'tiktok' where tenant_id = $1 and object_id = 'ended'", [T]);
    await db.query("update ad_campaigns set platform = 'tiktok', level = 'campaign' where tenant_id = $1 and object_id = 'ended'", [T]);
    const read = async (ago: string) => (await one("select sync_ad_holds_to_live($1, array['tiktok'], $2::timestamptz - $3::interval) r", [T, base, ago])).r;
    expect((await read("66 minutes")).released).toBe(0);
    expect(await held("ended")).toBe(20.01);
    expect((await read("6 minutes")).released).toBe(1);
    expect(await held("ended")).toBe(0);
  });
  it.each(["ACTIVE", "UNKNOWN"])("keeps a TikTok hold when the second read is %s", async (status) => {
    await hold("mixed:create", "create", "mixed", 20.01);
    await ledger("mixed", "ENDED", 20.01);
    await db.query("update ad_budget_reservations set platform = 'tiktok' where tenant_id = $1 and object_id = 'mixed'", [T]);
    await db.query("update ad_campaigns set platform = 'tiktok', level = 'campaign' where tenant_id = $1 and object_id = 'mixed'", [T]);
    await one("select sync_ad_holds_to_live($1, array['tiktok'], $2::timestamptz - interval '66 minutes') r", [T, base]);
    await db.query("update ad_campaigns set status = $2 where tenant_id = $1 and object_id = 'mixed'", [T, status]);
    expect((await one("select sync_ad_holds_to_live($1, array['tiktok'], $2::timestamptz - interval '6 minutes') r", [T, base])).r.released).toBe(0);
    expect(await held("mixed")).toBe(20.01);
  });
  it("corrects an over-reserved TikTok daily rate only after two agreeing live reads", async () => {
    await hold("rate:create", "create", "rate", 20.02);
    await ledger("rate", "ACTIVE", 20.01);
    await db.query("update ad_budget_reservations set platform = 'tiktok' where tenant_id = $1 and object_id = 'rate'", [T]);
    await db.query("update ad_campaigns set platform = 'tiktok', level = 'ad_group' where tenant_id = $1 and object_id = 'rate'", [T]);
    const read = async (ago: string) => (await one("select sync_ad_holds_to_live($1, array['tiktok'], $2::timestamptz - $3::interval) r", [T, base, ago])).r;
    expect((await read("66 minutes")).lowered).toBe(0);
    expect(await held("rate")).toBe(20.02);
    expect((await read("6 minutes")).lowered).toBe(1);
    expect(await held("rate")).toBe(20.01);
  });

  it("F1: a created-then-raised object cut outside Zavi keeps its live rate held on the next hour", async () => {
    await hold("n3:create", "create", "n3", 100);
    await hold("n3:raise", "raise", "n3", 100);
    await zaviChange("n3", "budget", 100, 200, "n3:raise");
    await ledger("n3", "ACTIVE", 80);
    expect((await sync()).lowered).toBe(1);
    expect(await held("n3")).toBe(80);
    await nextHour("n3");
    await sync("5 minutes 30 seconds");
    expect(await held("n3")).toBe(80);
  });

  it("F1: a shrink-set hold cut outside Zavi stays at the live budget on the next hour", async () => {
    await hold("shrink:meta:n2:2026-10-11", "rebase", "n2", 50);
    await zaviChange("n2", "budget", 40, 60);
    await ledger("n2", "ACTIVE", 30);
    await sync();
    expect(await held("n2")).toBe(30);
    await nextHour("n2");
    await sync("5 minutes 30 seconds");
    expect(await held("n2")).toBe(30);
  });

  it("D3: a raise whose change record was lost counts from 0, never the next raise's higher base", async () => {
    await hold("n5:raise1", "raise", "n5", 20);
    await hold("n5:raise2", "raise", "n5", 20);
    await zaviChange("n5", "budget", 60, 80, "n5:raise2");
    await ledger("n5", "ACTIVE", 80);
    await sync();
    expect(await held("n5")).toBe(40);
  });

  it("F3: an old Zavi pause does not stop an outside cut from lowering a later raise's hold", async () => {
    await hold("n6:create", "create", "n6", 40, { status: "released" });
    await zaviChange("n6", "status", 40, 40);
    await hold("n6:raise", "raise", "n6", 20);
    await zaviChange("n6", "budget", 40, 60, "n6:raise");
    await ledger("n6", "ACTIVE", 45);
    await sync();
    expect(await held("n6")).toBe(5);
    await nextHour("n6");
    await sync("5 minutes 30 seconds");
    expect(await held("n6")).toBe(5);
  });

  it("a Zavi cut keeps the base: the lineage runs back through it", async () => {
    await hold("n9:raise", "raise", "n9", 20);
    await zaviChange("n9", "budget", 40, 60, "n9:raise");
    await db.query("select rebase_ad_spend_for_object($1, 'meta', 'n9', 50, 'n9:cut', 10)", [T]);
    await db.query("update ad_budget_reservations set created_at = created_at - interval '50 hours', updated_at = updated_at - interval '50 hours' where object_id = 'n9'");
    expect(await held("n9")).toBe(10);
    await ledger("n9", "ACTIVE", 45);
    await sync();
    expect(await held("n9")).toBe(5);
  });

  it("F4: a second cut to the same value on the same day lowers again", async () => {
    await hold("n7:raise1", "raise", "n7", 20);
    await zaviChange("n7", "budget", 40, 60, "n7:raise1");
    await ledger("n7", "ACTIVE", 45);
    await sync();
    expect(await held("n7")).toBe(5);
    await nextHour("n7");
    await hold("n7:raise2", "raise", "n7", 15, { age: "30 minutes" });
    await zaviChange("n7", "budget", 45, 60, "n7:raise2");
    await ledger("n7", "ACTIVE", 45);
    expect((await sync("5 minutes 30 seconds")).lowered).toBe(1);
    expect(await held("n7")).toBe(5);
    expect((await sync("5 minutes 30 seconds")).lowered).toBe(0);
  });

  it("D4: a campaign budget follows only the ad sets this read wrote, not an old removed one", async () => {
    await hold("n8:create", "create", "n8", 100, { age: "10 hours" });
    await ledger("n8-a", "REMOVED", null, "50 hours", { campaign: "n8", budget: 100 });
    await ledger("n8-b", "ACTIVE", null, "5 minutes", { campaign: "n8", budget: 60 });
    await sync();
    expect(await held("n8")).toBe(60);
  });

  it("F2: a raise committed while the read was under way is left for the next hour", async () => {
    await hold("n4:raise", "raise", "n4", 50, { age: "3 minutes" });
    await zaviChange("n4", "budget", 50, 100, "n4:raise");
    await ledger("n4", "ACTIVE", 50, "1 minute");
    await sync();
    expect(await held("n4")).toBe(50);
  });

  it("a row the previous read wrote is not this read's: nothing is judged on it", async () => {
    await hold("s8:resume", "resume", "s8", 100, { age: "60 minutes" });
    await ledger("s8", "PAUSED", 10, "70 minutes");
    await sync();
    expect(await held("s8")).toBe(100);
  });

  it("C-F1: a read that saw a cut the founder already undid lowers nothing; two reads that agree do", async () => {
    await hold("m1:create", "create", "m1", 100);
    await ledger("m1", "ACTIVE", 100);
    await syncAt("66 minutes");
    await ledger("m1", "ACTIVE", 50);
    await hold("m2:create", "create", "m2", 100);
    await ledger("m2", "ACTIVE", 100);
    await syncAt("66 minutes");
    await ledger("m2", "PAUSED", 100);
    await syncAt("6 minutes");
    expect(await held("m1")).toBe(100);
    expect(await held("m2")).toBe(100);
    await nextHour("m1");
    await nextHour("m2");
    await ledger("m1", "ACTIVE", 50);
    await ledger("m2", "PAUSED", 100);
    await sync("5 minutes 30 seconds");
    expect(await held("m1")).toBe(50);
    expect(await held("m2")).toBe(0);
  });

  it("C-F2: a legacy campaign row just marked removed gives way to the ad sets this read wrote", async () => {
    await hold("c5:create", "create", "c5", 100);
    await db.query(
      "insert into ad_campaigns (tenant_id, platform, account_id, object_id, level, budget_kind, budget_usd, status, currency, source, as_of) values ($1, 'meta', 'acct', 'c5', 'campaign', 'daily', 100, 'REMOVED', 'USD', 'api', now())",
      [T],
    );
    await ledger("c5-a", "ACTIVE", null, "5 minutes", { campaign: "c5", budget: 60 });
    await sync();
    expect(await held("c5")).toBe(60);
  });

  it("G-F2: an ad set removed this hour does not carry the campaign's old budget", async () => {
    await hold("c6:create", "create", "c6", 100);
    await ledger("c6-a", "REMOVED", null, "5 minutes", { campaign: "c6", budget: 100 });
    await ledger("c6-b", "ACTIVE", null, "5 minutes", { campaign: "c6", budget: 60 });
    await sync();
    expect(await held("c6")).toBe(60);
  });

  it("G-F1: a replayed reserve of a rebased key that is refused does not drop its 0 from the lineage", async () => {
    await hold("gx:create", "create", "gx", 100);
    await hold("gx:raise", "raise", "gx", 100);
    await zaviChange("gx", "budget", 100, 200, "gx:raise");
    await ledger("gx", "ACTIVE", 80);
    await sync();
    expect(await held("gx")).toBe(80);
    const r = (await one("select reserve_ad_spend($1, 'gx:create', 'meta', 'create', 'gx', 99999) r", [T])).r;
    expect(r.status).toBe("refused");
    await nextHour("gx");
    await sync("5 minutes 30 seconds");
    expect(await held("gx")).toBe(80);
  });

  it("C-F5: the 2-argument form an old container calls changes nothing", async () => {
    await hold("w1:create", "create", "w1", 100);
    await ledger("w1", "PAUSED", 10);
    await syncAt("66 minutes");
    const r = (await one("select sync_ad_holds_to_live($1, array['meta']) r", [T])).r;
    expect(r).toMatchObject({ status: "skipped", lowered: 0, released: 0 });
    expect(await held("w1")).toBe(100);
    expect(Number((await one("select count(*) n from ad_hold_live_reads where object_id = 'w1'")).n)).toBe(1);
  });

  it("N3: a stopped read from before Zavi resumed the object never pairs with one after", async () => {
    await hold("gn:create", "create", "gn", 100);
    await ledger("gn", "PAUSED", 100);
    await syncAt("66 minutes");
    await hold("gn:resume", "resume", "gn", 100, { age: "56 minutes" });
    await syncAt("6 minutes");
    expect(await held("gn")).toBe(200);
  });

  it("only the tenant asked for; only service_role may run it", async () => {
    await hold("x1:create", "create", "x1", 100, { tenant: T2 });
    await db.query(
      "insert into ad_campaigns (tenant_id, platform, account_id, object_id, level, budget_kind, budget_usd, status, currency, source, as_of) values ($1, 'meta', 'acct', 'x1', 'ad_set', 'daily', 10, 'PAUSED', 'USD', 'api', now())",
      [T2],
    );
    await sync();
    expect(Number((await one("select sum(daily_delta_usd) v from ad_budget_reservations where tenant_id = $1 and status = 'committed'", [T2])).v)).toBe(100);
    const can = async (role: string) =>
      (await one(`select has_function_privilege('${role}', 'public.sync_ad_holds_to_live(uuid, text[], timestamptz)', 'execute') v`)).v;
    expect(await can("authenticated")).toBe(false);
    expect(await can("anon")).toBe(false);
    expect(await can("service_role")).toBe(true);
  });
});
