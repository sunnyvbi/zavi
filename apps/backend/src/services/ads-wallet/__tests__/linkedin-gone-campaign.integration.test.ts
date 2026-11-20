import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ExpectedToolError } from "@/services/tools/types";

type Db = { exec: (q: string) => Promise<unknown>; query: (q: string, p?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>; close: () => Promise<void> };

const m = vi.hoisted(() => ({
  db: null as unknown as Db,
  calls: 0,
  posts: 0,
  campaign: [] as Array<"404" | "500" | "ok">,
  fallback: "404" as "404" | "500" | "ok",
  status: "ACTIVE",
  rpcs: [] as string[],
  funding: "wallet",
  available: 10000,
  analytics: { elements: [] } as unknown,
  analyticsReads: 0,
  failActivateRead: false,
  logged: [] as string[],
  alerts: [] as Array<{ id: string; what: string; usd_at_stake: number | null }>,
  alertFails: false,
}));
vi.mock("@/services/growth/cgo-blockers", () => ({
  alertFounderSafely: async (_tenant: string, _why: string, extra: Array<{ id: string; what: string; usd_at_stake: number | null }>) => {
    m.alerts.push(...extra);
    return m.alertFails ? null : { sent: 1, urgent_ids: [] };
  },
}));
vi.mock("@/services/logging/logEvent", () => ({
  logEvent: async (e: { code: string }) => {
    m.logged.push(e.code);
  },
}));

vi.mock("../bindings", () => ({
  getCampaignBinding: async (tenant: string, id: string) => ({
    id,
    tenant_id: tenant,
    platform: "linkedin",
    provider_campaign_id: "123",
    account_binding_id: "account",
    funding_source: m.funding,
  }),
  getAccountBinding: async () => ({ id: "account" }),
}));
vi.mock("../adapters/linkedin-account", () => ({
  resolveLinkedinAccount: async () => {
    m.calls++;
    return { token: "fixture-token", account: { id: "42", currency: "USD" } };
  },
}));
vi.mock("../wallet", () => ({ readWallet: async () => ({ available_cents: m.available }) }));
vi.mock("@/services/connectors/linkedin-ads/http", () => ({
  linkedinAdsGet: async (_token: string, path: string) => {
    m.calls++;
    if (path === "adAnalytics") {
      m.analyticsReads++;
      if (m.analytics instanceof Error) throw m.analytics;
      return m.analytics;
    }
    const next = m.campaign.shift() ?? m.fallback;
    if (next === "404") throw new ExpectedToolError("linkedin_ads_http_error", "LinkedIn Ads could not answer that request.", { status: 404, http_status: 404 });
    if (next === "500") throw new ExpectedToolError("linkedin_ads_http_error", "LinkedIn Ads could not answer that request.", { status: 500, http_status: 500 });
    return {
      id: 123,
      account: "urn:li:sponsoredAccount:42",
      name: "Live campaign",
      status: m.status,
      campaignGroup: "urn:li:sponsoredCampaignGroup:7",
      totalBudget: { amount: "100.00", currencyCode: "USD" },
      runSchedule: { start: 1, end: Date.now() + 10 * 86400_000 },
      changeAuditStamps: { created: { time: Date.now() - 1000 }, lastModified: { time: Date.now() - 1000 } },
    };
  },
  linkedinAdsPost: async () => {
    await new Promise((done) => setTimeout(done, 3));
    m.calls++;
    m.posts++;
    m.status = "PAUSED";
    return { id: null };
  },
}));
vi.mock("@/services/tenant-client", () => {
  const iso = (row: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v]));
  const builder = (tenant: string, table: string) => {
    const where: Array<[string, unknown]> = [["tenant_id", tenant]];
    const inList: Array<[string, unknown[]]> = [];
    let write: null | "update" | "insert" | "upsert" | "delete" = null;
    let values: Record<string, unknown> = {};
    const run = async (one: boolean) => {
      if (m.failActivateRead && table === "ads_campaign_operations" && where.some(([k, v]) => k === "kind" && v === "activate")) return { data: null, error: { message: "boom" } };
      const params: unknown[] = [];
      const cond = [
        ...where.map(([k, v]) => {
          params.push(v);
          const column = k.includes("->>") ? k.replace("->>", "->>'") + "'" : k;
          return `${column}=$${params.length}`;
        }),
        ...inList.map(([k, v]) => {
          params.push(v);
          return `${k}=any($${params.length})`;
        }),
      ].join(" and ");
      try {
        if (write === "insert" || write === "upsert") {
          const row = { tenant_id: tenant, ...values };
          const keys = Object.keys(row);
          const conflict = write === "upsert" ? ` on conflict(campaign_binding_id) do update set ${keys.filter((k) => k !== "tenant_id" && k !== "campaign_binding_id").map((k) => `${k}=excluded.${k}`).join(",")}` : "";
          await m.db.query(`insert into ${table}(${keys.join(",")}) values (${keys.map((_, i) => `$${i + 1}`).join(",")})${conflict}`, Object.values(row));
          return { data: null, error: null };
        }
        if (write === "delete") {
          await m.db.query(`delete from ${table} where ${cond}`, params);
          return { data: null, error: null };
        }
        if (write === "update") {
          const keys = Object.keys(values);
          const r = await m.db.query(`update ${table} set ${keys.map((k, i) => `${k}=$${params.length + i + 1}`).join(",")} where ${cond} returning *`, [...params, ...Object.values(values)]);
          return { data: r.rows.map(iso), error: null };
        }
        const r = await m.db.query(`select * from ${table} where ${cond}`, params);
        const rows = r.rows.map(iso);
        return { data: one ? (rows[0] ?? null) : rows, error: null };
      } catch (error) {
        return { data: null, error };
      }
    };
    const q: any = {
      select: () => q,
      eq: (k: string, v: unknown) => (where.push([k, v]), q),
      in: (k: string, v: unknown[]) => (inList.push([k, v]), q),
      order: () => q,
      range: () => run(false),
      update: (v: Record<string, unknown>) => ((write = "update"), (values = v), q),
      insert: (v: Record<string, unknown>) => ((write = "insert"), (values = v), q),
      upsert: (v: Record<string, unknown>) => ((write = "upsert"), (values = v), q),
      delete: () => ((write = "delete"), q),
      maybeSingle: () => run(true),
      then: (ok: any, bad: any) => run(false).then(ok, bad),
    };
    return q;
  };
  const ARGS: Record<string, string[]> = {
    ads_wallet_settle_bound: ["p_campaign_binding_id", "p_spend_cents"],
    ads_observe_linkedin_spend: ["p_campaign_binding_id", "p_spend_cents", "p_ended"],
    release_ad_spend_holds: ["p_platform", "p_object_id", "p_reservation_ids"],
  };
  return {
    asTenantId: (s: string) => s,
    tenantClient: (tenant: string) => ({ from: (table: string) => builder(tenant, table) }),
    tenantRpc: async (tenant: string, fn: string, args: Record<string, unknown>) => {
      m.rpcs.push(fn);
      const names = ARGS[fn];
      if (!names) return { data: null, error: { message: `unexpected rpc ${fn}` } };
      const cast = fn === "release_ad_spend_holds" ? ["", "", "::uuid[]"] : ["", "", ""];
      try {
        const r = await m.db.query(
          `select ${fn}($1, ${names.map((_, i) => `$${i + 2}${cast[i]}`).join(", ")}) r`,
          [tenant, ...names.map((n) => args[n])],
        );
        return { data: r.rows[0].r, error: null };
      } catch (e) {
        return { data: null, error: { message: (e as Error).message } };
      }
    },
  };
});

import {
  isLinkedinPauseChecking,
  LINKEDIN_PAUSE_CHECKING,
  pauseLinkedinBoundCampaign,
  recheckGoneLinkedinCampaign,
  requestLinkedinPause,
  settleLinkedinBoundCampaign,
  unmarkLinkedinCampaignGone,
} from "../adapters/linkedin";

const MIGRATIONS = resolve(__dirname, "../../../../../../supabase/migrations");
const read = (name: string) => readFileSync(resolve(MIGRATIONS, name), "utf8");
function fn(file: string, name: string, head = "create or replace function"): string {
  const sql = read(file);
  const at = sql.indexOf(`${head} public.${name}(`);
  if (at < 0) throw new Error(`${name} not found in ${file}`);
  const end = sql.indexOf("end $$;", at);
  return `${sql.slice(at, end + "end $$;".length)}`;
}

const T = "11111111-1111-4111-8111-111111111111";
const B = "33333333-3333-4333-8333-333333333333";
const BUDGET = "44444444-4444-4444-8444-444444444444";
const ACCOUNT = "55555555-5555-4555-8555-555555555555";
const PROVIDER = "66666666-6666-4666-8666-666666666666";

describe.skipIf(!process.env.CI && !process.env.PGLITE_DIR)("a wallet campaign LinkedIn no longer has", () => {
  beforeAll(async () => {
    const req = createRequire(resolve("package.json"));
    const { PGlite } = req("@electric-sql/pglite") as { PGlite: new () => Db };
    m.db = new PGlite();
    await m.db.exec(`
      do $$ begin create role anon; exception when duplicate_object then null; end $$;
      do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
      do $$ begin create role service_role; exception when duplicate_object then null; end $$;
      create table ads_provider_accounts (id uuid primary key, platform text not null);
      create table ads_account_bindings (id uuid primary key, tenant_id uuid not null, funding_source text not null);
      create table ads_campaign_bindings (id uuid primary key, tenant_id uuid not null, account_binding_id uuid not null, account_id uuid not null);
      create table ads_campaign_binding_details (id uuid primary key, tenant_id uuid not null, platform text not null, funding_source text not null);
      create table ads_wallets (tenant_id uuid primary key, balance_cents bigint not null, updated_at timestamptz not null default now());
      create table ads_campaign_reservations (campaign_binding_id uuid primary key, tenant_id uuid not null,
        reserved_cents bigint not null default 0, spent_cents bigint not null default 0, updated_at timestamptz not null default now());
      create table ads_campaign_spend_stability (tenant_id uuid not null, campaign_binding_id uuid primary key, observed_cents bigint not null,
        stable_since timestamptz not null, ended_since timestamptz, last_observed_at timestamptz not null, unique(tenant_id, campaign_binding_id));
      create table ads_campaign_lifecycle (tenant_id uuid not null, campaign_binding_id uuid primary key,
        stop_requested_at timestamptz, stop_confirmed_at timestamptz, unique(tenant_id, campaign_binding_id));
      create table ads_campaign_operations (id uuid primary key, tenant_id uuid not null, campaign_binding_id uuid not null,
        kind text not null check(kind in ('activate','pause','finalize')), payload jsonb not null,
        status text not null default 'pending' check(status in ('pending','succeeded','uncertain','refused')),
        created_at timestamptz not null default now(), updated_at timestamptz not null default now());
      create table ad_budgets (id uuid primary key, tenant_id uuid not null, status text not null, margin numeric not null default 1);
      create table ad_budget_reservations (id uuid primary key default gen_random_uuid(), budget_id uuid not null, tenant_id uuid not null,
        platform text not null, object_id text, status text not null, reason text, released_on date, pause_due boolean not null default false,
        daily_delta_usd numeric(12,2) not null default 0, updated_at timestamptz not null default now());
      create function _ad_budget_today() returns date language sql stable as $f$ select date '2026-10-23' $f$;
      create function _ad_budget_days_left(d date) returns int language sql stable as $f$ select 9 $f$;
      create view ads_campaign_pending_stops as
        select l.tenant_id, l.campaign_binding_id, l.stop_requested_at, c.funding_source from ads_campaign_lifecycle l
        join ads_campaign_binding_details c on c.id = l.campaign_binding_id and c.tenant_id = l.tenant_id
        where c.platform = 'linkedin' and l.stop_requested_at is not null
        and (l.stop_confirmed_at is null or l.stop_confirmed_at < l.stop_requested_at);
    `);
    await m.db.exec(fn("20261101161000_shared_ads_wallet_bindings.sql", "ads_wallet_settle_bound", "create function"));
    await m.db.exec(fn("20261101161000_shared_ads_wallet_bindings.sql", "ads_wallet_finalize_bound", "create function"));
    await m.db.exec(fn("20261102141800_ads_wallet_review_fixes.sql", "ads_observe_linkedin_spend", "create function"));
    await m.db.exec(fn("20261112190000_release_ad_spend_holds_by_id.sql", "release_ad_spend_holds"));
  }, 60_000);
  afterAll(async () => {
    await m.db?.close();
  });
  beforeEach(async () => {
    m.calls = 0;
    m.posts = 0;
    m.campaign = [];
    m.fallback = "404";
    m.status = "ACTIVE";
    m.rpcs = [];
    m.funding = "wallet";
    m.available = 10000;
    m.analytics = { elements: [] };
    m.analyticsReads = 0;
    m.failActivateRead = false;
    m.logged = [];
    m.alerts = [];
    m.alertFails = false;
    await m.db.exec(`
      truncate ads_provider_accounts, ads_account_bindings, ads_campaign_bindings, ads_campaign_binding_details, ads_wallets,
        ads_campaign_reservations, ads_campaign_spend_stability, ads_campaign_lifecycle, ads_campaign_operations, ad_budgets, ad_budget_reservations;
      insert into ads_provider_accounts values ('${PROVIDER}', 'linkedin');
      insert into ads_account_bindings values ('${ACCOUNT}', '${T}', 'wallet');
      insert into ads_campaign_bindings values ('${B}', '${T}', '${ACCOUNT}', '${PROVIDER}');
      insert into ads_campaign_binding_details values ('${B}', '${T}', 'linkedin', 'wallet');
      insert into ads_wallets (tenant_id, balance_cents) values ('${T}', 5000);
      insert into ads_campaign_reservations (campaign_binding_id, tenant_id, reserved_cents, spent_cents) values ('${B}', '${T}', 2000, 500);
      insert into ad_budgets (id, tenant_id, status) values ('${BUDGET}', '${T}', 'active');
      insert into ad_budget_reservations (budget_id, tenant_id, platform, object_id, status, daily_delta_usd)
        values ('${BUDGET}', '${T}', 'linkedin', '${B}', 'committed', 20);
    `);
  });
  const stopPending = () =>
    m.db.exec(`insert into ads_campaign_lifecycle (tenant_id, campaign_binding_id, stop_requested_at) values ('${T}', '${B}', now() - interval '1 minute')`);
  const pendingStops = async () => (await m.db.query("select campaign_binding_id from ads_campaign_pending_stops")).rows;
  const holds = async () => (await m.db.query("select status, reason from ad_budget_reservations")).rows;
  const wallet = async () => {
    const [w] = (await m.db.query("select balance_cents from ads_wallets")).rows;
    const [r] = (await m.db.query("select reserved_cents, spent_cents from ads_campaign_reservations")).rows;
    return { balance: Number(w.balance_cents), reserved: Number(r.reserved_cents), spent: Number(r.spent_cents) };
  };
  const markers = async () => (await m.db.query("select status from ads_campaign_operations where kind = 'finalize'")).rows.map((r) => r.status);
  const age72h = () =>
    m.db.exec(`
      update ads_campaign_spend_stability set stable_since = now() - interval '73 hours', ended_since = now() - interval '73 hours';
      update ads_campaign_operations set created_at = now() - interval '73 hours';
    `);
  const pauseTick = async () => {
    for (const row of await pendingStops())
      await pauseLinkedinBoundCampaign(T, row.campaign_binding_id as string, false).catch((e) => {
        if (!isLinkedinPauseChecking(e)) throw e;
      });
  };
  const seen404 = async () => (await m.db.query("select id from ads_campaign_operations where kind = 'pause'")).rows;
  const age404 = (interval = "6 minutes") => m.db.exec(`update ads_campaign_operations set created_at = now() - interval '${interval}' where kind = 'pause'`);
  const ownBilling = () => {
    m.funding = "provider";
    return m.db.exec(`update ads_campaign_binding_details set funding_source = 'provider'; update ads_account_bindings set funding_source = 'provider'; delete from ads_campaign_reservations`);
  };
  const stopConfirmedAt = async () => (await m.db.query("select stop_confirmed_at from ads_campaign_lifecycle")).rows[0]?.stop_confirmed_at ?? null;
  const expectStillChecking = async () => {
    expect(await pendingStops()).toHaveLength(1);
    expect(await stopConfirmedAt()).toBeNull();
    expect(await markers()).toEqual([]);
    expect(await holds()).toEqual([{ status: "committed", reason: null }]);
    expect(m.posts).toBe(0);
  };

  it("the confirmed 404 writes the receipt and clears the pending stop, the holds stay, and the next pause tick asks LinkedIn nothing", async () => {
    await stopPending();
    expect(await pendingStops()).toHaveLength(1);
    await pauseTick();
    await expectStillChecking();
    await age404();
    await pauseTick();
    const [life] = (await m.db.query("select stop_confirmed_at from ads_campaign_lifecycle")).rows;
    expect(life.stop_confirmed_at).not.toBeNull();
    expect(await pendingStops()).toEqual([]);
    expect(await markers()).toEqual(["succeeded"]);
    expect(await holds()).toEqual([{ status: "committed", reason: null }]);
    expect(m.posts).toBe(0);
    m.calls = 0;
    await pauseTick();
    expect(m.calls).toBe(0);
  });

  it("settle ticks after the 404 keep re-reading LinkedIn, never charge the wallet, and finalize once after 72 hours, then ask nothing", async () => {
    await stopPending();
    await settleLinkedinBoundCampaign(T, B);
    await expectStillChecking();
    expect(m.rpcs).toEqual([]);
    await age404();
    await settleLinkedinBoundCampaign(T, B);
    expect(await pendingStops()).toEqual([]);
    expect(m.rpcs).toContain("ads_observe_linkedin_spend");
    expect(await wallet()).toEqual({ balance: 5000, reserved: 2000, spent: 500 });
    m.analyticsReads = 0;
    m.rpcs = [];
    await settleLinkedinBoundCampaign(T, B);
    expect(m.analyticsReads).toBe(1);
    expect(m.rpcs).toEqual(["ads_observe_linkedin_spend"]);
    expect(await wallet()).toEqual({ balance: 5000, reserved: 2000, spent: 500 });
    expect(await holds()).toEqual([{ status: "committed", reason: null }]);
    await age72h();
    await settleLinkedinBoundCampaign(T, B);
    expect(await wallet()).toEqual({ balance: 5000, reserved: 0, spent: 500 });
    expect(await holds()).toEqual([{ status: "released", reason: "paused" }]);
    m.calls = 0;
    m.rpcs = [];
    await settleLinkedinBoundCampaign(T, B);
    await settleLinkedinBoundCampaign(T, B);
    expect(m.calls).toBe(0);
    expect(m.rpcs).toEqual([]);
    expect(await wallet()).toEqual({ balance: 5000, reserved: 0, spent: 500 });
  });

  it("a campaign deleted with no stop requested is settled the same way, from the spend read's 404", async () => {
    await settleLinkedinBoundCampaign(T, B);
    expect(await markers()).toEqual([]);
    expect((await m.db.query("select * from ads_campaign_lifecycle")).rows).toEqual([]);
    expect(await holds()).toEqual([{ status: "committed", reason: null }]);
    await age404();
    await settleLinkedinBoundCampaign(T, B);
    expect(await markers()).toEqual(["succeeded"]);
    expect(await pendingStops()).toEqual([]);
    expect(await holds()).toEqual([{ status: "committed", reason: null }]);
    expect(await wallet()).toEqual({ balance: 5000, reserved: 2000, spent: 500 });
    await age72h();
    await settleLinkedinBoundCampaign(T, B);
    expect(await holds()).toEqual([{ status: "released", reason: "paused" }]);
    expect(await wallet()).toEqual({ balance: 5000, reserved: 0, spent: 500 });
  });

  describe("a wrong 404 that lasted long enough to be recorded", () => {
    const row = (cost: string) => ({ elements: [{ pivotValues: ["urn:li:sponsoredCampaign:123"], costInLocalCurrency: cost }] });
    const recordGone = async () => {
      await settleLinkedinBoundCampaign(T, B);
      await age404();
      await settleLinkedinBoundCampaign(T, B);
      expect(await markers()).toEqual(["succeeded"]);
    };

    it("is caught on the very next tick: the record clears, the spend it ran up is charged and the campaign really pauses", async () => {
      await recordGone();
      expect(await holds()).toEqual([{ status: "committed", reason: null }]);
      m.fallback = "ok";
      m.analytics = row("9.00");
      await settleLinkedinBoundCampaign(T, B);
      expect(await markers()).toEqual(["refused"]);
      expect(await wallet()).toEqual({ balance: 4600, reserved: 1600, spent: 900 });
      expect(m.posts).toBe(1);
    });

    it("a spend history already 72 hours quiet cannot finalize or release: the clock restarts at the record", async () => {
      await m.db.exec(`insert into ads_campaign_spend_stability values ('${T}', '${B}', 500, now() - interval '100 hours', now() - interval '100 hours', now())`);
      await recordGone();
      await settleLinkedinBoundCampaign(T, B);
      await settleLinkedinBoundCampaign(T, B);
      expect(await wallet()).toEqual({ balance: 5000, reserved: 2000, spent: 500 });
      expect(await holds()).toEqual([{ status: "committed", reason: null }]);
    });
  });

  it("a transient 404 then 200 on the pause writes no gone record: the campaign is really paused", async () => {
    await stopPending();
    m.campaign = ["404"];
    m.fallback = "ok";
    await pauseTick();
    expect(m.posts).toBe(1);
    expect(await markers()).toEqual([]);
    expect(await pendingStops()).toEqual([]);
  });

  it("a transient 404 then 200 on the spend read writes no receipt, requests no stop and changes no money", async () => {
    m.campaign = ["404"];
    m.fallback = "ok";
    await expect(settleLinkedinBoundCampaign(T, B)).rejects.toMatchObject({ meta: { status: 404 } });
    expect((await m.db.query("select * from ads_campaign_lifecycle")).rows).toEqual([]);
    expect(await markers()).toEqual([]);
    expect(m.posts).toBe(0);
    expect(await holds()).toEqual([{ status: "committed", reason: null }]);
    expect(await wallet()).toEqual({ balance: 5000, reserved: 2000, spent: 500 });
  });

  it("a campaign that answers again at the 72 hour check is not finalized: the record is cleared and it is paused", async () => {
    await stopPending();
    await settleLinkedinBoundCampaign(T, B);
    await age404();
    await settleLinkedinBoundCampaign(T, B);
    await age72h();
    m.fallback = "ok";
    await settleLinkedinBoundCampaign(T, B);
    expect(await markers()).toEqual(["refused"]);
    expect(m.posts).toBe(1);
    expect((await wallet()).reserved).toBeGreaterThan(0);
  });

  it("a relaunch that cleared the stop clears the record, so spend is read from LinkedIn again", async () => {
    await stopPending();
    await settleLinkedinBoundCampaign(T, B);
    await age404();
    await settleLinkedinBoundCampaign(T, B);
    await m.db.exec("update ads_campaign_lifecycle set stop_requested_at = null, stop_confirmed_at = null");
    m.fallback = "ok";
    m.calls = 0;
    await settleLinkedinBoundCampaign(T, B).catch(() => undefined);
    expect(await markers()).toEqual(["refused"]);
    expect(m.calls).toBeGreaterThan(0);
  });

  it("two 404s inside five minutes never confirm gone, at any tick, and the founder hears Zavi is checking, not ended", async () => {
    await stopPending();
    await expect(requestLinkedinPause(T, B)).rejects.toMatchObject({ code: "ads_pause_queued", message: LINKEDIN_PAUSE_CHECKING });
    await expectStillChecking();
    expect(LINKEDIN_PAUSE_CHECKING.toLowerCase()).not.toContain("ended");
    await age404("4 minutes 50 seconds");
    await pauseTick();
    await expectStillChecking();
    await settleLinkedinBoundCampaign(T, B);
    await expectStillChecking();
    await expect(pauseLinkedinBoundCampaign(T, B, false)).rejects.toMatchObject({ meta: { checking: true } });
    expect(await seen404()).toHaveLength(1);
    expect(m.rpcs).toEqual([]);
    expect(await wallet()).toEqual({ balance: 5000, reserved: 2000, spent: 500 });
  });

  it("the clock starts at the first 404: pressing Pause again neither restarts it nor shortcuts it", async () => {
    await expect(requestLinkedinPause(T, B)).rejects.toMatchObject({ code: "ads_pause_queued" });
    await age404("3 minutes");
    await expect(requestLinkedinPause(T, B)).rejects.toMatchObject({ code: "ads_pause_queued" });
    expect(await seen404()).toHaveLength(1);
    await age404();
    expect(await requestLinkedinPause(T, B)).toBe("ended");
    expect(await markers()).toEqual(["succeeded"]);
    expect(await seen404()).toEqual([]);
    expect(await requestLinkedinPause(T, B)).toBe("ended");
    expect(await markers()).toEqual(["succeeded"]);
  });

  it("404 then 200 five minutes later sends the real PAUSE and the holds stay until LinkedIn confirms it", async () => {
    await stopPending();
    await pauseTick();
    await expectStillChecking();
    await age404();
    m.fallback = "ok";
    await pauseTick();
    expect(m.posts).toBe(1);
    expect(m.status).toBe("PAUSED");
    expect(await markers()).toEqual([]);
    expect(await seen404()).toEqual([]);
    expect(await pendingStops()).toEqual([]);
    expect(await holds()).toEqual([{ status: "released", reason: "paused" }]);
  });

  it("a 200 wipes the earlier 404: a later 404 starts a new five minutes instead of confirming at once", async () => {
    await stopPending();
    await pauseTick();
    await age404();
    m.fallback = "ok";
    m.status = "PAUSED";
    await pauseTick();
    expect(await seen404()).toEqual([]);
    await m.db.exec(`update ads_campaign_lifecycle set stop_requested_at = now(), stop_confirmed_at = null`);
    await m.db.exec(`update ad_budget_reservations set status = 'committed', reason = null`);
    m.fallback = "404";
    await pauseTick();
    await expectStillChecking();
  });

  it("no stop asked: 404 then 200 five minutes later keeps the hold, the coverage and the campaign running", async () => {
    await m.db.exec("update ads_campaign_reservations set reserved_cents = 9500");
    await settleLinkedinBoundCampaign(T, B);
    expect(await seen404()).toHaveLength(1);
    expect(m.rpcs).toEqual([]);
    await age404();
    m.fallback = "ok";
    await settleLinkedinBoundCampaign(T, B);
    expect(await seen404()).toEqual([]);
    expect(await markers()).toEqual([]);
    expect(m.posts).toBe(0);
    expect(await holds()).toEqual([{ status: "committed", reason: null }]);
    expect(await wallet()).toEqual({ balance: 5000, reserved: 9500, spent: 500 });
    expect((await m.db.query("select * from ads_campaign_lifecycle")).rows).toEqual([]);
    expect(m.rpcs).toEqual(["ads_wallet_settle_bound", "ads_observe_linkedin_spend"]);
  });

  it("an overdrawn wallet on the first 404 saves a stop without confirming anything", async () => {
    m.available = -1;
    await settleLinkedinBoundCampaign(T, B);
    await expectStillChecking();
  });

  describe("a customer's own-billing campaign, which settle never runs for", () => {
    beforeEach(async () => {
      await ownBilling();
    });

    it("a first 404 changes nothing and tells the founder Zavi is checking", async () => {
      await expect(requestLinkedinPause(T, B)).rejects.toMatchObject({ code: "ads_pause_queued", message: LINKEDIN_PAUSE_CHECKING });
      await expectStillChecking();
      await age404("4 minutes");
      await pauseTick();
      await expectStillChecking();
    });

    it("404 then 200 five minutes later stops the customer's card spending", async () => {
      await stopPending();
      await pauseTick();
      await age404();
      m.fallback = "ok";
      await pauseTick();
      expect(m.posts).toBe(1);
      expect(await markers()).toEqual([]);
      expect(await pendingStops()).toEqual([]);
    });

    it("confirmed gone costs zero calls on later ticks, one bounded re-read at 72 hours that releases the hold, then nothing", async () => {
      await stopPending();
      await pauseTick();
      await age404();
      await pauseTick();
      expect(await markers()).toEqual(["succeeded"]);
      expect(await holds()).toEqual([{ status: "committed", reason: null }]);
      const [marker] = (await m.db.query("select payload from ads_campaign_operations where kind = 'finalize'")).rows;
      expect(marker.payload).toEqual({ reason: "provider_gone", recheck: "due" });
      m.calls = 0;
      await pauseTick();
      await pauseTick();
      expect(m.calls).toBe(0);
      expect(await recheckGoneLinkedinCampaign(T, B)).toBe("gone");
      const [after] = (await m.db.query("select payload from ads_campaign_operations where kind = 'finalize'")).rows;
      expect(after.payload).toEqual({ reason: "provider_gone", recheck: "done" });
      expect(await markers()).toEqual(["succeeded"]);
      expect(await holds()).toEqual([{ status: "released", reason: "paused" }]);
      expect(m.posts).toBe(0);
    });

    it("a campaign that answers at the 72 hour re-read loses its record and gets a real PAUSE", async () => {
      await stopPending();
      await pauseTick();
      await age404();
      await pauseTick();
      m.fallback = "ok";
      expect(await recheckGoneLinkedinCampaign(T, B)).toBe("answered");
      expect(await markers()).toEqual(["refused"]);
      expect(m.posts).toBe(1);
      expect(m.status).toBe("PAUSED");
      expect(await pendingStops()).toEqual([]);
    });

    describe("the founder relaunched while the record of its deletion stayed behind", () => {
      const goneThenAnswers = async () => {
        await stopPending();
        await pauseTick();
        await age404();
        await pauseTick();
        await m.db.exec(`update ads_campaign_operations set created_at = now() - interval '73 hours' where kind = 'finalize'; update ads_campaign_lifecycle set stop_requested_at = null, stop_confirmed_at = null`);
        m.fallback = "ok";
        m.posts = 0;
      };
      const activate = (status: string, age: string, updatedAge = age) =>
        m.db.exec(`insert into ads_campaign_operations (id, tenant_id, campaign_binding_id, kind, status, payload, created_at, updated_at) values (gen_random_uuid(), '${T}', '${B}', 'activate', '${status}', '{}', now() - interval '${age}', now() - interval '${updatedAge}')`);

      it("a succeeded launch after the record clears it and sends no pause: the approved campaign keeps running", async () => {
        await goneThenAnswers();
        await activate("succeeded", "2 hours");
        expect(await recheckGoneLinkedinCampaign(T, B)).toBe("answered");
        expect(await markers()).toEqual(["refused"]);
        expect(m.posts).toBe(0);
        expect(m.status).toBe("ACTIVE");
        expect(await pendingStops()).toEqual([]);
        expect(await stopConfirmedAt()).toBeNull();
      });

      it("a launch asked for before the record but confirmed after it counts too: that launch went through", async () => {
        await goneThenAnswers();
        await activate("succeeded", "80 hours", "2 hours");
        expect(await recheckGoneLinkedinCampaign(T, B)).toBe("answered");
        expect(m.posts).toBe(0);
        expect(m.status).toBe("ACTIVE");
      });

      it("an older launch still gets the pause: the campaign came back with nobody having relaunched it", async () => {
        await goneThenAnswers();
        await activate("succeeded", "80 hours");
        expect(await recheckGoneLinkedinCampaign(T, B)).toBe("answered");
        expect(m.posts).toBe(1);
        expect(m.status).toBe("PAUSED");
      });

      it.each(["refused", "pending", "uncertain"])("a %s launch after the record is no approval to keep running, so the pause goes out", async (status) => {
        await goneThenAnswers();
        await activate(status, "2 hours");
        expect(await recheckGoneLinkedinCampaign(T, B)).toBe("answered");
        expect(m.posts).toBe(1);
        expect(m.status).toBe("PAUSED");
      });

      it("a record another path already cleared sends no pause", async () => {
        await goneThenAnswers();
        await unmarkLinkedinCampaignGone(T, B);
        expect(await recheckGoneLinkedinCampaign(T, B)).toBe("answered");
        expect(m.posts).toBe(0);
        expect(m.status).toBe("ACTIVE");
      });

      it("the record stays and no pause goes out when the launch history cannot be read", async () => {
        await goneThenAnswers();
        m.failActivateRead = true;
        await expect(recheckGoneLinkedinCampaign(T, B)).rejects.toThrow("Campaign operation state is unavailable");
        expect(await markers()).toEqual(["succeeded"]);
        expect(m.posts).toBe(0);
      });
    });
  });

  it("the deleted wallet campaign reaches zero LinkedIn calls once it is finalized, and each tick before that costs one campaign read and one spend read", async () => {
    await stopPending();
    await pauseTick();
    await age404();
    await pauseTick();
    m.calls = 0;
    await settleLinkedinBoundCampaign(T, B);
    expect(m.analyticsReads).toBe(1);
    expect(m.calls).toBe(6);
    await settleLinkedinBoundCampaign(T, B);
    expect(m.analyticsReads).toBe(2);
    await age72h();
    await settleLinkedinBoundCampaign(T, B);
    expect(await wallet()).toEqual({ balance: 5000, reserved: 0, spent: 500 });
    m.calls = 0;
    await settleLinkedinBoundCampaign(T, B);
    await pauseTick();
    expect(m.calls).toBe(0);
  });

  describe("the final spend read at confirmation", () => {
    const confirm = async () => {
      await stopPending();
      await settleLinkedinBoundCampaign(T, B);
      await age404();
    };
    const holdStillCommitted = () => m.db.exec(`update ad_budget_reservations set status = 'committed', reason = null`);
    const row = (cost: string, urn = "urn:li:sponsoredCampaign:123") => ({ elements: [{ pivotValues: [urn], costInLocalCurrency: cost }] });

    it("charges spend LinkedIn reports past the last settle tick, and each later report on every tick until it settles", async () => {
      await confirm();
      m.analytics = row("12.34");
      await settleLinkedinBoundCampaign(T, B);
      expect(await wallet()).toEqual({ balance: 4266, reserved: 1266, spent: 1234 });
      m.analytics = row("19.00");
      await settleLinkedinBoundCampaign(T, B);
      expect(m.analyticsReads).toBe(2);
      expect(await wallet()).toEqual({ balance: 3600, reserved: 600, spent: 1900 });
      const [stability] = (await m.db.query("select observed_cents from ads_campaign_spend_stability")).rows;
      expect(Number(stability.observed_cents)).toBe(1900);
    });

    it("spend reported on day three restarts the 72 hours: nothing finalizes on the older figure", async () => {
      await confirm();
      m.analytics = row("12.34");
      await settleLinkedinBoundCampaign(T, B);
      await settleLinkedinBoundCampaign(T, B);
      await age72h();
      m.analytics = row("15.00");
      await settleLinkedinBoundCampaign(T, B);
      expect(await wallet()).toEqual({ balance: 4000, reserved: 1000, spent: 1500 });
      expect(await holds()).toEqual([{ status: "committed", reason: null }]);
      await age72h();
      await settleLinkedinBoundCampaign(T, B);
      expect(await wallet()).toEqual({ balance: 4000, reserved: 0, spent: 1500 });
      expect(await holds()).toEqual([{ status: "released", reason: "paused" }]);
    });

    it("a campaign whose reservation is already used up still gets its late spend charged", async () => {
      await m.db.exec(`update ads_campaign_reservations set reserved_cents = 0; update ad_budget_reservations set status = 'released', reason = 'paused'`);
      await confirm();
      m.analytics = row("30.00");
      await settleLinkedinBoundCampaign(T, B);
      expect(await wallet()).toEqual({ balance: 2500, reserved: 0, spent: 3000 });
    });

    it.each([
      ["no row", () => ({ elements: [] })],
      ["a figure below what is recorded", () => row("1.00")],
    ])("%s is LinkedIn's answer: it stays at the recorded spend and clears no later report", async (_label, answer) => {
      await confirm();
      m.analytics = answer();
      await settleLinkedinBoundCampaign(T, B);
      expect(await wallet()).toEqual({ balance: 5000, reserved: 2000, spent: 500 });
      m.analytics = row("6.00");
      await settleLinkedinBoundCampaign(T, B);
      expect(await wallet()).toEqual({ balance: 4900, reserved: 1900, spent: 600 });
    });

    const unanswered: Array<[string, () => unknown]> = [
      ["a failed read", () => new Error("LinkedIn 500")],
      ["an answer with no elements array", () => ({})],
      ["another campaign's row", () => row("50.00", "urn:li:sponsoredCampaign:999")],
      ["two rows for one campaign", () => ({ elements: [row("5.00").elements[0], row("6.00").elements[0]] })],
      ["a garbled amount", () => row("not money")],
    ];
    const payload = async () => (await m.db.query("select payload from ads_campaign_operations where kind = 'finalize'")).rows[0].payload as Record<string, unknown>;
    const ageUnread = () =>
      m.db.exec(`update ads_campaign_operations set payload = jsonb_set(payload, '{unread_since}', to_jsonb(to_char((now() at time zone 'utc') - interval '73 hours', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))) where kind = 'finalize'`);

    it.each(unanswered)("%s is not recorded as done: the tick fails, the money and its coverage stay, and the next tick charges what LinkedIn then reports", async (_label, answer) => {
      await confirm();
      m.analytics = answer();
      m.rpcs = [];
      await expect(settleLinkedinBoundCampaign(T, B)).rejects.toThrow("final LinkedIn spend read");
      expect(await markers()).toEqual(["succeeded"]);
      expect(await wallet()).toEqual({ balance: 5000, reserved: 2000, spent: 500 });
      expect(m.rpcs).not.toContain("ads_wallet_settle_bound");
      expect(m.rpcs).not.toContain("ads_observe_linkedin_spend");
      expect(m.analyticsReads).toBe(1);
      expect(m.logged).toEqual(["ads_wallet.gone_final_spend_unread"]);
      expect(m.alerts).toEqual([]);

      m.analytics = row("12.34");
      await settleLinkedinBoundCampaign(T, B);
      expect(m.analyticsReads).toBe(2);
      expect(await wallet()).toEqual({ balance: 4266, reserved: 1266, spent: 1234 });
      expect((await payload()).unread_since).toBeUndefined();
    });

    it("a read still failing at 72 hours never releases the hold or finalizes the coverage on the unread spend", async () => {
      await confirm();
      m.analytics = new Error("LinkedIn 500");
      await expect(settleLinkedinBoundCampaign(T, B)).rejects.toThrow("final LinkedIn spend read");
      await holdStillCommitted();
      await age72h();
      await expect(settleLinkedinBoundCampaign(T, B)).rejects.toThrow("final LinkedIn spend read");
      expect(await holds()).toEqual([{ status: "committed", reason: null }]);
      expect(await wallet()).toEqual({ balance: 5000, reserved: 2000, spent: 500 });
      m.analytics = row("7.00");
      await settleLinkedinBoundCampaign(T, B);
      expect(await wallet()).toEqual({ balance: 4800, reserved: 1800, spent: 700 });
    });

    describe("a read that stays unanswered past three days", () => {
      const stuck = async () => {
        await confirm();
        m.analytics = new Error("LinkedIn 500");
        await expect(settleLinkedinBoundCampaign(T, B)).rejects.toThrow("final LinkedIn spend read");
        await ageUnread();
        await m.db.exec(`update ads_campaign_operations set created_at = now() - interval '200 hours' where kind = 'finalize'`);
        m.logged = [];
      };

      it("tells the founder once with the amount, logs an error, keeps every cent held and stops failing the wallet clock", async () => {
        await stuck();
        await settleLinkedinBoundCampaign(T, B);
        expect(m.alerts).toHaveLength(1);
        expect(m.alerts[0].what).toContain("$20.00 stays reserved");
        expect(m.alerts[0].usd_at_stake).toBe(20);
        expect(m.logged).toEqual(["ads_wallet.gone_final_spend_stuck"]);
        expect(await wallet()).toEqual({ balance: 5000, reserved: 2000, spent: 500 });
        expect(await holds()).toEqual([{ status: "committed", reason: null }]);
        await settleLinkedinBoundCampaign(T, B);
        await settleLinkedinBoundCampaign(T, B);
        expect(m.alerts).toHaveLength(1);
        expect(m.logged).toEqual(["ads_wallet.gone_final_spend_stuck"]);
        expect(await wallet()).toEqual({ balance: 5000, reserved: 2000, spent: 500 });
      });

      it("keeps reading after the alert, so a late answer is charged and settles the normal way", async () => {
        await stuck();
        await settleLinkedinBoundCampaign(T, B);
        const reads = m.analyticsReads;
        m.analytics = row("12.34");
        await settleLinkedinBoundCampaign(T, B);
        expect(m.analyticsReads).toBe(reads + 1);
        expect(await wallet()).toEqual({ balance: 4266, reserved: 1266, spent: 1234 });
        expect((await payload()).unread_alerted_at).toBeUndefined();
        await age72h();
        await settleLinkedinBoundCampaign(T, B);
        expect(await wallet()).toEqual({ balance: 4266, reserved: 0, spent: 1234 });
      });

      it("a failed alert keeps the tick failing and tries again next tick", async () => {
        await stuck();
        m.alertFails = true;
        await expect(settleLinkedinBoundCampaign(T, B)).rejects.toThrow("could not be reported");
        m.alertFails = false;
        await settleLinkedinBoundCampaign(T, B);
        expect(m.alerts).toHaveLength(2);
        expect((await payload()).unread_alerted_at).toBeTruthy();
      });

      it("the campaign read failing counts as unanswered too: no spend read, no release, and the same alert", async () => {
        await confirm();
        m.analytics = row("12.34");
        await settleLinkedinBoundCampaign(T, B);
        m.fallback = "500";
        m.analyticsReads = 0;
        await expect(settleLinkedinBoundCampaign(T, B)).rejects.toThrow("final LinkedIn spend read");
        expect(m.analyticsReads).toBe(0);
        await ageUnread();
        await settleLinkedinBoundCampaign(T, B);
        expect(m.alerts).toHaveLength(1);
        expect(await wallet()).toEqual({ balance: 4266, reserved: 1266, spent: 1234 });
        expect(await holds()).toEqual([{ status: "committed", reason: null }]);
      });

      it("with nothing held there is nobody to tell: it logs the unread spend as an error and stops reading", async () => {
        await m.db.exec(`update ads_campaign_reservations set reserved_cents = 0; update ad_budget_reservations set status = 'released', reason = 'paused'`);
        await stuck();
        await settleLinkedinBoundCampaign(T, B);
        expect(m.alerts).toEqual([]);
        expect(m.logged).toEqual(["ads_wallet.gone_final_spend_stuck"]);
        expect(await payload()).toMatchObject({ settled: true, final_spend_unread: true });
        m.calls = 0;
        await settleLinkedinBoundCampaign(T, B);
        expect(m.calls).toBe(0);
      });
    });
  });

  it("clearing the gone record also clears a stale first 404, and the campaign reads from LinkedIn again", async () => {
    await stopPending();
    await pauseTick();
    await age404();
    await pauseTick();
    await m.db.exec(`insert into ads_campaign_operations (id, tenant_id, campaign_binding_id, kind, status, payload) values (gen_random_uuid(), '${T}', '${B}', 'pause', 'refused', '{"reason":"provider_404_seen"}')`);
    await unmarkLinkedinCampaignGone(T, B);
    expect(await markers()).toEqual(["refused"]);
    expect(await seen404()).toEqual([]);
  });
});
