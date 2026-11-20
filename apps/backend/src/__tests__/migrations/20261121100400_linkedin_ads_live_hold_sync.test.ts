import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type Db = { exec: (q: string) => Promise<unknown>; query: (q: string, p?: unknown[]) => Promise<{ rows: any[] }>; close: () => Promise<void> };

const m = vi.hoisted(() => ({ db: null as unknown as Db, rpcs: [] as Array<{ tenant: string; fn: string; args: Record<string, unknown> }> }));

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  tenantClient: () => {
    throw new Error("no table access expected");
  },
  tenantRpc: async (tenant: string, fn: string, args: Record<string, unknown>) => {
    m.rpcs.push({ tenant, fn, args });
    if (fn !== "sync_ad_holds_to_live") return { data: null, error: { message: `unexpected rpc ${fn}` } };
    try {
      const r = await m.db.query("select sync_ad_holds_to_live($1, $2::text[], $3::timestamptz) r", [tenant, args.p_platforms, args.p_read_started_at]);
      return { data: r.rows[0].r, error: null };
    } catch (e) {
      return { data: null, error: { message: (e as Error).message } };
    }
  },
}));

import { syncAdHoldsToLive } from "@/services/decisions/ad-budget";

const modules = process.env.ADS_SQL_TEST_MODULES;
const MIGRATIONS = resolve(__dirname, "../../../../../supabase/migrations");
const FILE = "20261121100400_linkedin_ads_live_hold_sync";
const T = "11111111-1111-1111-1111-111111111111";
const T2 = "22222222-2222-2222-2222-222222222222";
const PAUSED_OUTSIDE = "33333333-3333-3333-3333-333333333333";
const STILL_LIVE = "44444444-4444-4444-4444-444444444444";

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
  "20261031190000_ad_holds_follow_live", "20261031200000_ad_holds_sync_read_fence", "20261101163000_linkedin_wallet_budget_gate",
  "20261101172000_ad_holds_sync_lineage", "20261107110000_ad_holds_bounded_by_object", "20261111170001_tiktok_ads_live_hold_sync",
  "20261121100100_linkedin_resume_bounded_hold",
];

const STUBS = `
create role anon; create role authenticated; create role service_role;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
create function public.app_active_tenant() returns uuid language sql stable as $$ select null::uuid $$;
create table public.tenants (id uuid primary key);
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
create table public.ads_provider_accounts (id uuid primary key, platform text, provider_account_id text);
create table public.ads_campaign_bindings (id uuid primary key, tenant_id uuid, account_id uuid);
`;

const one = async (q: string, p: unknown[] = []) => (await m.db.query(q, p)).rows[0];

async function ownBillingHold(tenant: string, object: string, key: string, usd = 10) {
  await m.db.query(
    `insert into ad_budget_reservations (budget_id, tenant_id, idem_key, platform, object_id, op, daily_delta_usd, amount_usd, status,
       bounded, cap_usd, ends_on, hold_factor, created_at, updated_at)
     values ((select id from ad_budgets where tenant_id = $1 and status = 'active'), $1, $2, 'linkedin', $3, 'resume', 1.00, $4::numeric, 'committed',
       true, $4::numeric, date '2026-10-30', 1, now() - interval '2 days', now() - interval '2 days')`,
    [tenant, key, object, usd],
  );
}

async function ledger(tenant: string, object: string, status: string) {
  await m.db.query(
    `insert into ad_campaigns (tenant_id, platform, account_id, object_id, level, campaign_id, budget_kind, budget_usd, status, currency, source, as_of)
     values ($1, 'linkedin', '508000001', $2, 'campaign', $2, 'lifetime', 10, $3, 'USD', 'api', now() - interval '5 minutes')
     on conflict (tenant_id, platform, account_id, object_id) do update set status = excluded.status, as_of = excluded.as_of`,
    [tenant, object, status],
  );
}

const committed = async (tenant: string, object: string) =>
  Number((await one("select coalesce(sum(amount_usd), 0) v from ad_budget_reservations where tenant_id = $1 and object_id = $2 and status = 'committed'", [tenant, object])).v);
const heldUsd = async (tenant: string) =>
  Number((await one("select _ad_budget_held_usd(b.id, _ad_budget_today(), b.margin) v from ad_budgets b where b.tenant_id = $1 and b.status = 'active'", [tenant])).v);
const releaseTailEnds = (tenant: string) =>
  m.db.query("update ad_budget_reservations set released_at = now() - interval '49 hours' where tenant_id = $1 and status = 'released'", [tenant]);

let base = 0;
const hourlyRead = (tenant: string, minutesAgo: number, platforms: string[] = ["meta", "google", "linkedin"]) =>
  syncAdHoldsToLive(tenant, platforms, new Date(base - minutesAgo * 60_000));
const twoReads = async (tenant: string) => {
  const first = await hourlyRead(tenant, 66);
  const second = await hourlyRead(tenant, 6);
  return { first, second };
};

describe(`${FILE}: an own-billing LinkedIn campaign stopped outside Zavi gives its hold back on the hourly reconcile, Autopilot or not`, () => {
  beforeAll(async () => {
    const { PGlite } = createRequire(modules ? resolve(modules, "../package.json") : resolve("package.json"))("@electric-sql/pglite");
    m.db = new PGlite();
    await m.db.exec(STUBS);
    for (const f of CHAIN) await m.db.exec(readFileSync(resolve(MIGRATIONS, `${f}.sql`), "utf8"));
    await m.db.exec(readFileSync(resolve(MIGRATIONS, `${FILE}.sql`), "utf8"));
    await m.db.exec(readFileSync(resolve(MIGRATIONS, `${FILE}.sql`), "utf8"));
    await m.db.exec("create or replace function _ad_budget_today() returns date language sql stable as $$ select date '2026-10-12' $$;");
  }, 120_000);
  afterAll(async () => {
    await m.db?.close();
  });
  beforeEach(async () => {
    await m.db.exec("truncate tenants cascade");
    await m.db.query("insert into tenants values ($1), ($2)", [T, T2]);
    await m.db.query(
      "insert into ad_budgets (tenant_id, monthly_usd, started_on, month_start, spent_usd, margin, actual_read_at) values ($1, 10, '2026-09-28', '2026-10-01', 0, 1.0, now()), ($2, 10, '2026-09-28', '2026-10-01', 0, 1.0, now())",
      [T, T2],
    );
    base = Date.parse((await one("select now()::text v")).v);
    m.rpcs = [];
  });

  it("a $10 campaign paused in Campaign Manager frees the whole $10 monthly budget; the same campaign id on another tenant and another live campaign keep theirs", async () => {
    await ownBillingHold(T, PAUSED_OUTSIDE, "launch:resume");
    await ownBillingHold(T, STILL_LIVE, "other:resume", 4);
    await ownBillingHold(T2, PAUSED_OUTSIDE, "foreign:resume");
    await ledger(T, PAUSED_OUTSIDE, "PAUSED");
    await ledger(T, STILL_LIVE, "ACTIVE");
    await ledger(T2, PAUSED_OUTSIDE, "ACTIVE");
    expect(await heldUsd(T)).toBe(14);

    const t = await twoReads(T);
    const t2 = await twoReads(T2);

    expect(m.rpcs.map((r) => [r.tenant, r.fn, r.args.p_platforms])).toEqual([
      [T, "sync_ad_holds_to_live", ["meta", "google", "linkedin"]],
      [T, "sync_ad_holds_to_live", ["meta", "google", "linkedin"]],
      [T2, "sync_ad_holds_to_live", ["meta", "google", "linkedin"]],
      [T2, "sync_ad_holds_to_live", ["meta", "google", "linkedin"]],
    ]);
    expect(t.first).toMatchObject({ status: "done", released: 0 });
    expect(t.second).toMatchObject({ status: "done", released: 1, released_daily_usd: 1 });
    expect(t2.second).toMatchObject({ status: "done", released: 0 });

    expect(await committed(T, PAUSED_OUTSIDE)).toBe(0);
    expect(await one("select status, reason from ad_budget_reservations where tenant_id = $1 and object_id = $2", [T, PAUSED_OUTSIDE])).toEqual({ status: "released", reason: "live_stopped" });
    expect(await committed(T, STILL_LIVE)).toBe(4);
    expect(await committed(T2, PAUSED_OUTSIDE)).toBe(10);

    await releaseTailEnds(T);
    await releaseTailEnds(T2);
    expect(await heldUsd(T)).toBe(4);
    expect(await heldUsd(T2)).toBe(10);
  });

  it.each(["COMPLETED", "CANCELED", "ARCHIVED", "PENDING_DELETION", "REMOVED"])("a campaign LinkedIn reports %s twice is released", async (status) => {
    await ownBillingHold(T, PAUSED_OUTSIDE, "launch:resume");
    await ledger(T, PAUSED_OUTSIDE, status);
    expect((await twoReads(T)).second).toMatchObject({ released: 1 });
    expect(await committed(T, PAUSED_OUTSIDE)).toBe(0);
  });

  it("one paused read is not enough: paused then resumed keeps the hold, and a single read releases nothing", async () => {
    await ownBillingHold(T, PAUSED_OUTSIDE, "launch:resume");
    await ledger(T, PAUSED_OUTSIDE, "PAUSED");
    expect((await hourlyRead(T, 66)).released).toBe(0);
    await ledger(T, PAUSED_OUTSIDE, "ACTIVE");
    expect((await hourlyRead(T, 6)).released).toBe(0);
    expect(await committed(T, PAUSED_OUTSIDE)).toBe(10);
  });

  it("a LinkedIn read that failed (platform not passed) leaves the hold as it was", async () => {
    await ownBillingHold(T, PAUSED_OUTSIDE, "launch:resume");
    await ledger(T, PAUSED_OUTSIDE, "PAUSED");
    await hourlyRead(T, 66, ["meta", "google"]);
    await hourlyRead(T, 6, ["meta", "google"]);
    expect(await committed(T, PAUSED_OUTSIDE)).toBe(10);
  });

  it("an ACTIVE lifetime campaign is never lowered by the sync: its $10 total stays held", async () => {
    await ownBillingHold(T, STILL_LIVE, "launch:resume");
    await ledger(T, STILL_LIVE, "ACTIVE");
    expect((await twoReads(T)).second).toMatchObject({ released: 0, lowered: 0 });
    expect(await heldUsd(T)).toBe(10);
  });
});
