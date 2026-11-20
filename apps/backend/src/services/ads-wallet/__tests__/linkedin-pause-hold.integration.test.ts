import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type Db = { exec: (q: string) => Promise<unknown>; query: (q: string, p?: unknown[]) => Promise<{ rows: any[] }>; close: () => Promise<void> };

const m = vi.hoisted(() => ({
  db: null as unknown as Db,
  status: "ACTIVE",
  post: null as unknown as (...a: unknown[]) => Promise<unknown>,
  lifecycle: new Map<string, { stop_requested_at: string | null; stop_confirmed_at: string | null }>(),
  rpcs: [] as Array<{ tenant: string; fn: string; args: Record<string, unknown> }>,
  writes: [] as Array<{ tenant: string; table: string; op: string }>,
  end: null as number | null,
  afterReceipt: null as null | (() => Promise<void>),
  onResolve: null as null | (() => Promise<void>),
}));

vi.mock("../bindings", () => ({
  getCampaignBinding: async (tenant: string, id: string) => ({
    id,
    tenant_id: tenant,
    platform: "linkedin",
    provider_campaign_id: "123",
    account_binding_id: "account",
    funding_source: "wallet",
  }),
  getAccountBinding: async () => ({ id: "account", provider_account_id: "42" }),
  findCampaignBinding: async (tenant: string, _platform: string, raw: string) =>
    raw === "123" ? { id: BINDING, tenant_id: tenant, platform: "linkedin", provider_campaign_id: "123", account_binding_id: "account" } : null,
}));
vi.mock("../adapters/linkedin-account", () => ({
  resolveLinkedinAccount: async () => {
    if (m.onResolve) await m.onResolve();
    return { token: "fixture-token", account: { id: "42", currency: "USD" } };
  },
}));
vi.mock("../wallet", () => ({ readWallet: async () => ({ available_cents: 10000 }) }));
vi.mock("@/services/connectors/linkedin-ads/http", () => ({
  linkedinAdsGet: async () => ({
    id: 123,
    account: "urn:li:sponsoredAccount:42",
    name: "Live campaign",
    status: m.status,
    campaignGroup: "urn:li:sponsoredCampaignGroup:7",
    totalBudget: { amount: "100.00", currencyCode: "USD" },
    runSchedule: { start: 1, end: m.end ?? Date.now() + 10 * 86400_000 },
    changeAuditStamps: { created: { time: 1 }, lastModified: { time: 1 } },
  }),
  linkedinAdsPost: (...a: unknown[]) => m.post(...a),
}));
vi.mock("@/services/connectors/linkedin-ads/client", () => ({ listLinkedInCampaigns: async () => [] }));
vi.mock("@/services/connectors/linkedin-ads/write", () => ({ pauseLinkedInCampaign: async () => undefined }));
vi.mock("@/services/tools/linkedin-ads/write/_flag-check", () => ({ isLinkedInAdsWriteEnabled: async () => true }));
vi.mock("@/services/tenant-client", () => {
  const key = (tenant: string, binding: unknown) => `${tenant}:${String(binding)}`;
  const builder = (tenant: string, table: string) => {
    const filters: Record<string, unknown> = {};
    let op = "select";
    let values: Record<string, unknown> = {};
    const run = async () => {
      if (table === "ad_budget_reservations") {
        const r = await m.db.query(
          "select id::text from ad_budget_reservations where tenant_id = $1 and platform = $2 and object_id = $3 and status = $4",
          [tenant, filters.platform, filters.object_id, filters.status],
        );
        return { data: r.rows, error: null };
      }
      if (table !== "ads_campaign_lifecycle") return { data: null, error: null };
      const k = key(tenant, filters.campaign_binding_id ?? values.campaign_binding_id);
      if (op === "upsert") {
        const prior = m.lifecycle.get(k) ?? { stop_requested_at: null, stop_confirmed_at: null };
        m.lifecycle.set(k, { ...prior, stop_requested_at: values.stop_requested_at as string });
        return { data: null, error: null };
      }
      const row = m.lifecycle.get(k);
      if (op === "update") {
        if (!row || ("stop_requested_at" in filters && row.stop_requested_at !== filters.stop_requested_at)) return { data: [], error: null };
        Object.assign(row, values);
        if ("stop_confirmed_at" in values && m.afterReceipt) await m.afterReceipt();
        return { data: [{ campaign_binding_id: filters.campaign_binding_id }], error: null };
      }
      return { data: row ?? null, error: null };
    };
    const q: any = {
      select: () => q,
      eq: (col: string, v: unknown) => {
        filters[col] = v;
        return q;
      },
      in: () => q,
      update: (v: Record<string, unknown>) => {
        op = "update";
        values = v;
        m.writes.push({ tenant, table, op });
        return q;
      },
      upsert: (v: Record<string, unknown>) => {
        op = "upsert";
        values = v;
        m.writes.push({ tenant, table, op });
        return q;
      },
      maybeSingle: run,
      limit: run,
      then: (ok: any, bad: any) => run().then(ok, bad),
    };
    return q;
  };
  return {
    asTenantId: (s: string) => s,
    tenantClient: (tenant: string) => ({ from: (table: string) => builder(tenant, table) }),
    tenantRpc: async (tenant: string, fn: string, args: Record<string, unknown>) => {
      m.rpcs.push({ tenant, fn, args });
      if (fn !== "release_ad_spend_holds") return { data: null, error: { message: `unexpected rpc ${fn}` } };
      try {
        const r = await m.db.query("select release_ad_spend_holds($1, $2, $3, $4::uuid[]) r", [tenant, args.p_platform, args.p_object_id, args.p_reservation_ids]);
        return { data: r.rows[0].r, error: null };
      } catch (e) {
        return { data: null, error: { message: (e as Error).message } };
      }
    },
  };
});

import { pauseLinkedinBoundCampaign } from "../adapters/linkedin";
import { executeLinkedInPause } from "@/services/connectors/linkedin-ads/execute-pause";

const modules = process.env.ADS_SQL_TEST_MODULES;
const MIGRATIONS = resolve(__dirname, "../../../../../../supabase/migrations");
const T = "11111111-1111-1111-1111-111111111111";
const T2 = "22222222-2222-2222-2222-222222222222";
const BINDING = "33333333-3333-3333-3333-333333333333";
const OTHER = "44444444-4444-4444-4444-444444444444";

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
  "20261112190000_release_ad_spend_holds_by_id",
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

async function hold(tenant: string, object: string, daily: number, key: string) {
  await m.db.query(
    `insert into ad_budget_reservations (budget_id, tenant_id, idem_key, platform, object_id, op, daily_delta_usd, amount_usd, status, created_at, updated_at)
     values ((select id from ad_budgets where tenant_id = $1 and status = 'active'), $1, $2, 'linkedin', $3, 'resume', $4::numeric, $4::numeric * 20, 'committed',
             now() - interval '2 days', now() - interval '2 days')`,
    [tenant, key, object, daily],
  );
}

const committed = async (tenant: string, object: string) =>
  Number((await one("select coalesce(sum(daily_delta_usd), 0) v from ad_budget_reservations where tenant_id = $1 and object_id = $2 and status = 'committed'", [tenant, object])).v);
const heldUsd = async (tenant: string) =>
  Number((await one("select _ad_budget_held_usd(b.id, _ad_budget_today(), b.margin) v from ad_budgets b where b.tenant_id = $1 and b.status = 'active'", [tenant])).v);
const releasedRows = async (tenant: string, object: string) =>
  (await m.db.query("select status, reason, released_on::text, updated_at::text from ad_budget_reservations where tenant_id = $1 and object_id = $2 and status = 'released' order by idem_key", [tenant, object])).rows;
const spent = async (tenant: string) => Number((await one("select spent_usd v from ad_budgets where tenant_id = $1", [tenant])).v);

describe("pausing a live LinkedIn wallet campaign gives back its monthly launch hold", () => {
  beforeAll(async () => {
    const { PGlite } = createRequire(modules ? resolve(modules, "../package.json") : resolve("package.json"))("@electric-sql/pglite");
    m.db = new PGlite();
    await m.db.exec(STUBS);
    for (const f of CHAIN) await m.db.exec(readFileSync(resolve(MIGRATIONS, `${f}.sql`), "utf8"));
    await m.db.exec("create or replace function _ad_budget_today() returns date language sql stable as $$ select date '2026-10-12' $$;");
  }, 120_000);
  afterAll(async () => {
    await m.db?.close();
  });
  beforeEach(async () => {
    await m.db.exec("truncate tenants cascade");
    await m.db.query("insert into tenants values ($1), ($2)", [T, T2]);
    await m.db.query(
      "insert into ad_budgets (tenant_id, monthly_usd, started_on, month_start, spent_usd, margin, actual_read_at) values ($1, 50000, '2026-09-28', '2026-10-01', 37.5, 1.0, now()), ($2, 50000, '2026-09-28', '2026-10-01', 0, 1.0, now())",
      [T, T2],
    );
    await hold(T, BINDING, 5, "launch-1:resume");
    await hold(T, OTHER, 3, "launch-2:resume");
    await hold(T2, BINDING, 7, "foreign:resume");
    m.status = "ACTIVE";
    m.end = null;
    m.afterReceipt = null;
    m.onResolve = null;
    m.lifecycle.clear();
    m.rpcs = [];
    m.writes = [];
    m.post = async () => {
      m.status = "PAUSED";
      return {};
    };
  });

  it("releases only this campaign's unspent days, keeps today's spend held and leaves other campaigns and tenants alone", async () => {
    expect(await heldUsd(T)).toBe(160);
    await pauseLinkedinBoundCampaign(T, BINDING);
    expect(m.status).toBe("PAUSED");
    expect(await committed(T, BINDING)).toBe(0);
    expect(await releasedRows(T, BINDING)).toEqual([expect.objectContaining({ status: "released", reason: "paused", released_on: "2026-10-12" })]);
    expect(await heldUsd(T)).toBe(5 + 60);
    expect(await committed(T, OTHER)).toBe(3);
    expect(await committed(T2, BINDING)).toBe(7);
    expect(await heldUsd(T2)).toBe(140);
    expect(await spent(T)).toBe(37.5);
    expect(m.rpcs).toEqual([{ tenant: T, fn: "release_ad_spend_holds", args: { p_platform: "linkedin", p_object_id: BINDING, p_reservation_ids: [expect.any(String)] } }]);
    expect(m.writes.filter((w) => w.table === "ads_campaign_reservations")).toEqual([]);
  });

  it("releases exactly once when the founder presses Pause twice", async () => {
    await pauseLinkedinBoundCampaign(T, BINDING);
    const first = await releasedRows(T, BINDING);
    const heldAfterFirst = await heldUsd(T);
    let posts = 0;
    m.post = async () => {
      posts++;
      return {};
    };
    await pauseLinkedinBoundCampaign(T, BINDING);
    expect(posts).toBe(0);
    expect(await releasedRows(T, BINDING)).toEqual(first);
    expect(await heldUsd(T)).toBe(heldAfterFirst);
    expect(await committed(T, OTHER)).toBe(3);
    expect(await spent(T)).toBe(37.5);
  });

  it("keeps the whole hold when LinkedIn refuses the pause", async () => {
    m.post = async () => {
      throw new Error("LinkedIn 500");
    };
    await expect(pauseLinkedinBoundCampaign(T, BINDING)).rejects.toThrow("LinkedIn 500");
    expect(m.status).toBe("ACTIVE");
    expect(await committed(T, BINDING)).toBe(5);
    expect(await heldUsd(T)).toBe(160);
    expect(m.rpcs).toEqual([]);
  });

  it("keeps the whole hold when LinkedIn accepts the write but the campaign is still running", async () => {
    m.post = async () => ({});
    await expect(pauseLinkedinBoundCampaign(T, BINDING)).rejects.toThrow("could not be confirmed");
    expect(await committed(T, BINDING)).toBe(5);
    expect(m.rpcs).toEqual([]);
  });

  it("keeps the hold when a relaunch replaced the stop request before the pause receipt landed", async () => {
    m.post = async () => {
      m.status = "PAUSED";
      for (const row of m.lifecycle.values()) row.stop_requested_at = null;
      return {};
    };
    await pauseLinkedinBoundCampaign(T, BINDING);
    expect(await committed(T, BINDING)).toBe(5);
    expect(m.rpcs).toEqual([]);
  });

  it("leaves a relaunched campaign's new hold in place when the stop worker retries after the relaunch", async () => {
    await pauseLinkedinBoundCampaign(T, BINDING);
    for (const row of m.lifecycle.values()) row.stop_requested_at = null;
    m.status = "ACTIVE";
    await hold(T, BINDING, 4, "launch-3:resume");
    await pauseLinkedinBoundCampaign(T, BINDING, false);
    expect(m.status).toBe("ACTIVE");
    expect(await committed(T, BINDING)).toBe(4);
  });

  it("does not re-pause a campaign the founder relaunched while the stop worker was resolving its account", async () => {
    const R = "2026-10-12T00:00:00.000Z";
    m.lifecycle.set(`${T}:${BINDING}`, { stop_requested_at: R, stop_confirmed_at: null });
    m.status = "PAUSED";
    let posts = 0;
    m.post = async () => {
      posts++;
      m.status = "PAUSED";
      return {};
    };
    m.onResolve = async () => {
      m.onResolve = null;
      m.status = "ACTIVE";
      const row = m.lifecycle.get(`${T}:${BINDING}`)!;
      if (row.stop_requested_at === R) row.stop_requested_at = null;
      await hold(T, BINDING, 4, "relaunch:resume");
    };
    expect(await pauseLinkedinBoundCampaign(T, BINDING, false)).toBeNull();
    expect(posts).toBe(0);
    expect(m.status).toBe("ACTIVE");
    expect(m.lifecycle.get(`${T}:${BINDING}`)).toEqual({ stop_requested_at: null, stop_confirmed_at: null });
    expect(await committed(T, BINDING)).toBe(9);
    expect(m.rpcs).toEqual([]);
  });

  it("claims the stop before writing PAUSED, so a relaunch that clears it afterwards is told the stop changed", async () => {
    const R = "2026-10-12T00:00:00.000Z";
    m.lifecycle.set(`${T}:${BINDING}`, { stop_requested_at: R, stop_confirmed_at: null });
    let relaunchCleared: boolean | null = null;
    m.post = async () => {
      const row = m.lifecycle.get(`${T}:${BINDING}`)!;
      relaunchCleared = row.stop_requested_at === R;
      if (relaunchCleared) row.stop_requested_at = null;
      m.status = "PAUSED";
      return {};
    };
    expect(await pauseLinkedinBoundCampaign(T, BINDING, false)).toBe("paused");
    expect(relaunchCleared).toBe(false);
    const row = m.lifecycle.get(`${T}:${BINDING}`)!;
    expect(row.stop_requested_at).not.toBeNull();
    expect(Date.parse(row.stop_requested_at!)).toBeGreaterThan(Date.parse(R));
    expect(row.stop_confirmed_at).not.toBeNull();
    expect(m.status).toBe("PAUSED");
    expect(await committed(T, BINDING)).toBe(0);
  });

  it("tells the founder an approved pause card did nothing when a relaunch cleared the stop first", async () => {
    m.onResolve = async () => {
      m.onResolve = null;
      for (const row of m.lifecycle.values()) row.stop_requested_at = null;
    };
    let posts = 0;
    m.post = async () => {
      posts++;
      return {};
    };
    const r = await executeLinkedInPause({ tenant_id: T, body: { campaign_id: "123", account_id: "42", status: "PAUSED", name: "Live campaign" } });
    expect(r).toMatchObject({ ok: false, code: "ads_pause_superseded" });
    expect(posts).toBe(0);
    expect(m.status).toBe("ACTIVE");
    expect(await committed(T, BINDING)).toBe(5);
  });

  it("releases the hold when the founder asks Zavi in chat to pause and approves the card", async () => {
    const r = await executeLinkedInPause({ tenant_id: T, body: { campaign_id: "123", account_id: "42", status: "PAUSED", name: "Live campaign" } });
    expect(r).toEqual({ ok: true, notice: 'Paused "Live campaign" in LinkedIn Ads.' });
    expect(await committed(T, BINDING)).toBe(0);
    expect(await heldUsd(T)).toBe(65);
    expect(await committed(T2, BINDING)).toBe(7);
  });

  it("leaves a relaunch's new hold counted when the relaunch commits between the stop worker's receipt and its release", async () => {
    await pauseLinkedinBoundCampaign(T, BINDING);
    m.status = "PAUSED";
    for (const row of m.lifecycle.values()) row.stop_requested_at = "2026-10-12T00:00:00.000Z";
    await hold(T, BINDING, 6, "launch-0:resume");
    m.afterReceipt = async () => {
      m.afterReceipt = null;
      for (const row of m.lifecycle.values()) row.stop_requested_at = null;
      m.status = "ACTIVE";
      await hold(T, BINDING, 4, "relaunch:resume");
    };
    await pauseLinkedinBoundCampaign(T, BINDING, false);
    expect(m.status).toBe("ACTIVE");
    expect(await committed(T, BINDING)).toBe(4);
    expect((await releasedRows(T, BINDING)).length).toBe(2);
  });

  it("says a campaign that already ended was not paused now", async () => {
    m.status = "COMPLETED";
    let posts = 0;
    m.post = async () => {
      posts++;
      return {};
    };
    expect(await pauseLinkedinBoundCampaign(T, BINDING)).toBe("ended");
    expect(posts).toBe(0);
    m.status = "ACTIVE";
    m.end = Date.now() - 1000;
    m.post = async () => {
      m.status = "PAUSED";
      return {};
    };
    expect(await pauseLinkedinBoundCampaign(T, BINDING)).toBe("ended");
    expect(await pauseLinkedinBoundCampaign(T, BINDING)).toBe("ended");
    m.end = null;
    expect(await pauseLinkedinBoundCampaign(T, BINDING)).toBe("already_paused");
    const r = await executeLinkedInPause({ tenant_id: T, body: { campaign_id: "123", account_id: "42", status: "PAUSED", name: "Live campaign" } });
    expect(r).toEqual({ ok: true, notice: '"Live campaign" was already paused in LinkedIn Ads.' });
    m.status = "COMPLETED";
    const ended = await executeLinkedInPause({ tenant_id: T, body: { campaign_id: "123", account_id: "42", status: "PAUSED", name: "Live campaign" } });
    expect(ended).toEqual({ ok: true, notice: 'LinkedIn shows "Live campaign" already ended, so there was nothing to pause.' });
  });
});
