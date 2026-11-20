import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openPglite, type Pg } from "@/services/growth/booking-metrics/__tests__/pglite";

const m = vi.hoisted(() => ({
  db: null as unknown as { query: (q: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
  failSettle: 0,
  failClaimDelete: false,
  reserveCommitsThenErrors: false,
  reserveFailsUncommitted: false,
  failCoverageReread: false,
  lifetimeCents: 0,
  failWalletRelease: false,
  settles: [] as string[],
  posts: [] as string[],
  rpcs: [] as { fn: string; args: Record<string, unknown> }[],
  refuseFirstWrite: false,
  context: null as any,
  flag: "on" as "on" | "off" | "unreadable",
}));

vi.mock("../fx", async (original) => ({
  ...(await original<typeof import("../fx")>()),
  adsFx: async (currency: string) => ({ currency, units_per_usd: 1, as_of: null, source: "USD" }),
}));
vi.mock("../adapters/linkedin", () => ({
  linkedinCampaign: async () => structuredClone(m.context),
  linkedinLifetimeSpend: async () => ({ cents: m.lifetimeCents }),
  pauseLinkedinBoundCampaign: async () => undefined,
  unmarkLinkedinCampaignGone: async () => undefined,
}));
vi.mock("@/services/connectors/linkedin-ads/http", async (original) => {
  const real = await original<typeof import("@/services/connectors/linkedin-ads/http")>();
  const { ExpectedToolError: Refusal } = await import("@/services/tools/types");
  return {
    ...real,
    logLinkedInRefusal: async () => undefined,
    linkedinAdsGet: async (_token: string, path: string) =>
      path.endsWith("adCampaignGroups/7")
        ? { id: 7, account: m.context.campaign.account, status: "DRAFT" }
        : path.includes("creatives")
          ? { id: 8, campaign: "urn:li:sponsoredCampaign:123", intendedStatus: m.posts.some((p: string) => p.includes("creatives") && p.endsWith(":ACTIVE")) ? "ACTIVE" : "DRAFT" }
          : { elements: [{ id: "123", campaignGroup: m.context.campaign.campaignGroup }] },
    linkedinAdsPost: async (_token: string, path: string, _method: string, body: any) => {
      const set = body.patch.$set;
      if (m.refuseFirstWrite && set.totalBudget)
        throw new Refusal("linkedin_ads_write_refused", real.LINKEDIN_ADS_CHANGE_REFUSED, { status: 422, http_status: 422 });
      m.posts.push(`${path}:${set.status ?? set.intendedStatus ?? "budget"}`);
      if (path === m.context.path) Object.assign(m.context.campaign, set);
      return {};
    },
  };
});
vi.mock("@/services/agents/entitlement", () => ({ checkAgentTier: async () => ({ allowed: true, enforced: true }) }));
vi.mock("@/services/channels/lock", async (original) => ({
  ...(await original<typeof import("@/services/channels/lock")>()),
  isChannelLockedStrict: async () => false,
}));
vi.mock("@/services/tools/linkedin-ads/write/_flag-check", async (original) => ({
  ...(await original<typeof import("@/services/tools/linkedin-ads/write/_flag-check")>()),
  isLinkedInAdsWriteEnabled: async () => true,
}));
vi.mock("../wallet", () => ({ fundingEnabled: () => true }));
vi.mock("../managed-linkedin", async (original) => ({
  ...(await original<typeof import("../managed-linkedin")>()),
  managedLinkedinEnabled: () => true,
}));
vi.mock("../consent", () => ({ requireSharedWalletConsent: async () => undefined }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: async () => undefined }));
vi.mock("@/services/growth/ads-no-friction-flag", async (original) => {
  const real = await original<typeof import("@/services/growth/ads-no-friction-flag")>();
  return { ...real, adsNoFrictionEnabled: async () => (m.flag === "unreadable" ? real.adsNoFrictionEnabled() : m.flag === "on") };
});
vi.mock("@/services/decisions/ad-money-book-flag", () => ({ moneyBookShadowEnabled: () => false }));
vi.mock("@/services/auth/tenant-role", () => ({ loadTenantRoleFor: async () => "owner" }));
vi.mock("@/services/decisions/ad-budget", async (original) => ({
  ...(await original<typeof import("@/services/decisions/ad-budget")>()),
  readActiveAdBudget: async () => ({ days_left: 10 }),
}));
vi.mock("@/services/tenant-client", () => {
  const builder = (tenant: string, table: string) => {
    let op: "select" | "update" | "delete" = "select";
    let cols = "*";
    let values: Record<string, unknown> = {};
    const where: string[] = ["tenant_id = $1"];
    const params: unknown[] = [tenant];
    const run = async () => {
      if (op === "delete" && table === "ads_campaign_operations" && m.failClaimDelete)
        return { data: null, error: { message: "connection reset" } };
      if (op === "select" && table === "ads_campaign_reservations" && m.failCoverageReread && m.rpcs.some((c) => c.fn === "ads_reserve_linkedin_launch"))
        return { data: null, error: { message: "connection reset" } };
      try {
        let sql: string;
        if (op === "select") sql = `select ${cols} from ${table} where ${where.join(" and ")}`;
        else if (op === "delete") sql = `delete from ${table} where ${where.join(" and ")} returning ${cols}`;
        else {
          const sets = Object.entries(values).map(([k, v]) => {
            params.push(v);
            return `${k} = $${params.length}`;
          });
          sql = `update ${table} set ${sets.join(", ")} where ${where.join(" and ")} returning ${cols}`;
        }
        return { data: (await m.db.query(sql, params)).rows, error: null };
      } catch (e) {
        return { data: null, error: { message: (e as Error).message } };
      }
    };
    const q: any = {
      select: (c = "*") => {
        cols = c;
        return q;
      },
      eq: (c: string, v: unknown) => {
        params.push(v);
        where.push(`${c}::text = $${params.length}::text`);
        return q;
      },
      is: (c: string) => {
        where.push(`${c} is null`);
        return q;
      },
      in: (c: string, vs: unknown[]) => {
        params.push(vs);
        where.push(`${c}::text = any($${params.length}::text[])`);
        return q;
      },
      update: (v: Record<string, unknown>) => {
        op = "update";
        values = v;
        return q;
      },
      delete: () => {
        op = "delete";
        return q;
      },
      maybeSingle: async () => {
        const r = await run();
        return { ...r, data: r.data ? (r.data[0] ?? null) : null };
      },
      single: async () => {
        const r = await run();
        return { ...r, data: r.data ? (r.data[0] ?? null) : null };
      },
      then: (ok: any, bad: any) => run().then(ok, bad),
    };
    return q;
  };
  return {
    asTenantId: (v: string) => v,
    globalClient: () => ({
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: "statement timeout" } }) }) }) }),
    }),
    tenantClient: (tenant: string) => ({ from: (table: string) => builder(tenant, table) }),
    tenantRpc: async (tenant: string, fn: string, args: Record<string, unknown>) => {
      m.rpcs.push({ fn, args });
      if (fn === "settle_ad_spend") {
        m.settles.push(`${args.p_idem_key}:${args.p_outcome}`);
        if (m.failSettle > 0) {
          m.failSettle -= 1;
          return { data: null, error: { message: "connection reset" } };
        }
      }
      if (fn === "ads_release_unsent_linkedin_launch" && m.failWalletRelease)
        return { data: null, error: { message: "connection reset" } };
      if (fn === "ads_reserve_linkedin_launch" && m.reserveFailsUncommitted)
        return { data: null, error: { message: "canceling statement due to lock timeout" } };
      const names = Object.keys(args);
      const call = names.map((k, i) => `${k} => $${i + 2}`).join(", ");
      try {
        const r = await m.db.query(`select public.${fn}(p_tenant_id => $1${call ? `, ${call}` : ""}) as r`, [tenant, ...names.map((k) => args[k])]);
        if (fn === "ads_reserve_linkedin_launch" && m.reserveCommitsThenErrors)
          return { data: null, error: { message: "statement timeout" } };
        return { data: r.rows[0]?.r ?? null, error: null };
      } catch (e) {
        return { data: null, error: { message: (e as Error).message } };
      }
    },
  };
});

import { judgeInterruptedLinkedinLaunch, launchLinkedinCampaign, linkedinLaunchSummary } from "../linkedin-launch";
import { executeLinkedinGrowthLaunch, LINKEDIN_LAUNCH_NOT_REOPENED } from "../linkedin-growth";
import { ExpectedToolError } from "@/services/tools/types";
import { reserveAdSpend } from "@/services/decisions/ad-budget";

const MIGRATIONS = join(__dirname, "../../../../../../supabase/migrations");
const read = (f: string) => readFileSync(join(MIGRATIONS, f), "utf-8");
function fn(file: string, name: string, create = "create or replace function"): string {
  const src = read(file);
  const at = src.indexOf(`${create} public.${name}(`);
  if (at < 0) throw new Error(`${name} not found in ${file}`);
  const open = src.indexOf("$$", at);
  const end = src.indexOf("$$;", open + 2);
  return src.slice(at, end + 3);
}

const T = "11111111-1111-4111-8111-111111111111";
const BUDGET = "bbbbbbbb-0000-4000-8000-000000000001";
const BINDING = "33333333-3333-4333-8333-333333333333";
const FIRST = "a0000000-0000-4000-8000-000000000001";
const FRESH = "a0000000-0000-4000-8000-000000000002";
const SECOND_ID = "a0000000-0000-4000-8000-000000000005";

let db: Pg | null = null;
const rows = async (sql: string, p: unknown[] = []) => (await db!.query(sql, p)).rows;
const holds = () =>
  rows("select idem_key, status, reason, amount_usd::float8 amt from ad_budget_reservations where object_id = $1 order by created_at, idem_key", [BINDING]);
const heldUsd = async () => Number((await rows("select _ad_budget_held_usd($1, '2026-10-23'::date, 1.0) h", [BUDGET]))[0].h);
const ops = () => rows("select id::text, status from ads_campaign_operations order by created_at, id");

function freshContext() {
  return {
    binding: { id: BINDING, account_id: "account", funding_source: "provider" },
    account: { id: "42", currency: "USD", status: "ACTIVE", servingStatuses: ["RUNNABLE"] },
    campaign: {
      id: "123",
      name: "Pilot",
      status: "PAUSED",
      account: "urn:li:sponsoredAccount:42",
      campaignGroup: "urn:li:sponsoredCampaignGroup:7",
      runSchedule: { start: Date.now() - 1000 },
    },
    token: "secret",
    path: "adAccounts/42/adCampaigns/123",
  };
}
async function ask(request_id: string, total_budget_cents = 10000) {
  return {
    request_id,
    snapshot: (await linkedinLaunchSummary(T, BINDING)).snapshot,
    total_budget_cents,
    end_time: Date.parse("2026-10-27T12:00:00Z"),
  };
}
const approval = { approved_by: "owner-1", approved_by_source: "email" };

describe.skipIf(!process.env.CI && !process.env.PGLITE_DIR)("an unsent LinkedIn launch whose monthly hold could not be given back", () => {
  beforeAll(async () => {
    db = await openPglite();
    m.db = db!;
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
        created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default now(),
        unique (budget_id, idem_key));
      create table ad_spend_daily (tenant_id uuid not null, platform text not null, account_id text not null default 'acct',
        object_id text not null, spend_date date not null, amount_usd numeric(12,2) not null, source text not null default 'api');
      create function _ad_budget_today() returns date language sql stable as $f$ select date '2026-10-23' $f$;
      create function _creator_hire_used_usd(p_budget_id uuid, p_today date) returns numeric language sql stable as $f$ select 0::numeric $f$;
      create table ads_account_bindings (id uuid primary key, tenant_id uuid not null, funding_source text not null);
      create table ads_account_binding_status (tenant_id uuid not null, account_binding_id uuid primary key, disabled_at timestamptz);
      create table ads_campaign_bindings (id uuid primary key, tenant_id uuid not null, account_binding_id uuid);
      create table ads_campaign_binding_details (id uuid primary key, tenant_id uuid not null, platform text not null, funding_source text not null);
      create table ads_managed_account_grants (tenant_id uuid not null, account_id text not null, disabled_at timestamptz);
      create table ads_wallets (tenant_id uuid primary key, balance_cents bigint not null, updated_at timestamptz not null default now());
      create table ads_campaign_reservations (campaign_binding_id uuid primary key, tenant_id uuid not null,
        reserved_cents bigint not null default 0, spent_cents bigint not null default 0, baseline_cents bigint not null default 0, updated_at timestamptz not null default now());
      create table ads_campaign_spend_stability (tenant_id uuid not null, campaign_binding_id uuid primary key);
      create table ads_campaign_operations (
        id uuid primary key, tenant_id uuid not null, campaign_binding_id uuid not null,
        kind text not null check(kind in ('activate','pause','finalize')), payload jsonb not null,
        status text not null default 'pending' check(status in ('pending','succeeded','uncertain','refused')),
        created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default now());
      create unique index ads_campaign_one_unresolved_operation on ads_campaign_operations(campaign_binding_id)
        where status in ('pending','uncertain');
      create table ads_campaign_lifecycle (
        tenant_id uuid not null, campaign_binding_id uuid primary key, provider_group_id text not null,
        provider_creative_ids text[] not null, stop_requested_at text, activation_attempted_at timestamptz);
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
    await db!.exec(read("20261121100100_linkedin_resume_bounded_hold.sql"));
    await db!.exec(fn("20261021120000_cgo_inflight_ad_holds.sql", "resolve_inflight_ad_hold"));
    await db!.exec(fn("20261021120000_cgo_inflight_ad_holds.sql", "settle_ad_spend"));
    await db!.exec(read("20261121100200_linkedin_relaunch_supersedes_own_hold.sql"));
    await db!.exec(fn("20261101162000_shared_ads_wallet_accounts.sql", "ads_claim_campaign_operation", "create function"));
    await db!.exec(fn("20261101161000_shared_ads_wallet_bindings.sql", "ads_wallet_reserve_bound", "create function"));
    await db!.exec(fn("20261112190100_linkedin_launch_reserve_binding_lock.sql", "ads_reserve_linkedin_launch"));
    await db!.exec(fn("20261102141800_ads_wallet_review_fixes.sql", "ads_release_unsent_linkedin_launch", "create function"));
  }, 60_000);
  afterAll(async () => {
    await db?.close();
  });
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-23T12:00:00Z"));
    await db!.exec(`
      truncate ad_budgets, ad_budget_reservations, ads_campaign_operations, ads_campaign_lifecycle, ads_campaign_bindings, ads_account_bindings, ads_campaign_binding_details, ads_managed_account_grants, ads_wallets, ads_campaign_reservations, ads_campaign_spend_stability;
      insert into ad_budgets (id, tenant_id, monthly_usd, started_on, month_start)
        values ('${BUDGET}', '${T}', 150, '2026-01-01', '2026-10-01');
      insert into ads_campaign_bindings values ('${BINDING}', '${T}');
      insert into ads_campaign_lifecycle (tenant_id, campaign_binding_id, provider_group_id, provider_creative_ids)
        values ('${T}', '${BINDING}', '7', array['8']);
    `);
    m.context = freshContext();
    m.failSettle = 0;
    m.failClaimDelete = false;
    m.reserveCommitsThenErrors = false;
    m.reserveFailsUncommitted = false;
    m.failCoverageReread = false;
    m.lifetimeCents = 0;
    m.failWalletRelease = false;
    m.settles = [];
    m.posts = [];
    m.rpcs = [];
    m.refuseFirstWrite = false;
    m.flag = "on";
  });

  async function unsentLaunchWithStuckHold(request_id: string, total_budget_cents = 10000) {
    m.refuseFirstWrite = true;
    m.failSettle = 1;
    const err = await launchLinkedinCampaign(T, BINDING, await ask(request_id, total_budget_cents), undefined, approval).catch((e) => e);
    m.refuseFirstWrite = false;
    expect(m.posts).toEqual([]);
    expect(await holds()).toEqual([{ idem_key: `${request_id}:resume`, status: "reserved", reason: null, amt: total_budget_cents / 100 }]);
    return err as ExpectedToolError;
  }

  describe("an interrupted launch, judged from what the database really holds", () => {
    const op = (status: string, at = "2026-10-23 11:00:00+00") =>
      db!.query(`insert into ads_campaign_operations (id, tenant_id, campaign_binding_id, kind, payload, status, created_at) values ($1, $2, $3, 'activate', '{}', $4, $5)`, [FIRST, T, BINDING, status, at]);
    const hold = (status: string, reason: string | null = null) =>
      db!.query(`insert into ad_budget_reservations (budget_id, tenant_id, idem_key, platform, object_id, op, amount_usd, status, reason) values ($1, $2, $3, 'linkedin', $4, 'resume', 100, $5, $6)`, [BUDGET, T, `${FIRST}:resume`, BINDING, status, reason]);
    const attempted = (at: string) => db!.query(`update ads_campaign_lifecycle set activation_attempted_at = $1 where campaign_binding_id = $2`, [at, BINDING]);
    const judge = () => judgeInterruptedLinkedinLaunch(T, FIRST);

    it("must catch: no operation row and no hold means nothing reached LinkedIn", async () => {
      expect(await judge()).toBe("not_sent");
    });
    it("must catch: no operation row with a stuck reserved hold gives the money back", async () => {
      await unsentLaunchWithStuckHold(FIRST);
      expect(await ops()).toEqual([]);
      expect(await heldUsd()).toBe(100);
      expect(await judge()).toBe("not_sent");
      expect(await holds()).toEqual([expect.objectContaining({ status: "released", reason: "rejected" })]);
      expect(await heldUsd()).toBe(0);
    });
    it("must catch: a refused launch that never reached the send gives its hold back and removes the row, so Try again can claim the same request", async () => {
      m.failClaimDelete = true;
      await unsentLaunchWithStuckHold(FIRST);
      m.failClaimDelete = false;
      expect(await ops()).toEqual([{ id: FIRST, status: "refused" }]);
      expect(await heldUsd()).toBe(100);
      await db!.query(`update ads_campaign_lifecycle set activation_attempted_at = null where campaign_binding_id = $1`, [BINDING]);
      expect(await judge()).toBe("not_sent");
      expect(await ops()).toEqual([]);
      expect(await heldUsd()).toBe(0);
      m.context = freshContext();
      expect(await launchLinkedinCampaign(T, BINDING, await ask(FIRST), undefined, approval)).toEqual({ status: "active" });
      expect(await ops()).toEqual([{ id: FIRST, status: "succeeded" }]);
    });
    it("must not catch: a refused launch that had stamped its send is not proven unsent, so nothing is released or reopened", async () => {
      m.failClaimDelete = true;
      await unsentLaunchWithStuckHold(FIRST);
      m.failClaimDelete = false;
      expect(await judge()).toBe("reconciled");
      expect(await heldUsd()).toBe(100);
      expect(await ops()).toEqual([{ id: FIRST, status: "refused" }]);
    });
    it("must catch: a refused launch whose hold was already rejected is reopened too", async () => {
      await op("refused");
      await hold("released", "rejected");
      expect(await judge()).toBe("not_sent");
      expect(await ops()).toEqual([]);
    });
    it("must catch: when the refused row cannot be removed the card is closed, not offered a Try again that would do nothing", async () => {
      await op("refused");
      m.failClaimDelete = true;
      expect(await judge()).toBe("not_reopened");
      expect(await ops()).toEqual([{ id: FIRST, status: "refused" }]);
    });
    it("must not catch: a hold it cannot give back still answers not_sent, and the same request reuses that hold rather than double counting", async () => {
      await unsentLaunchWithStuckHold(FIRST);
      m.failSettle = 1;
      expect(await judge()).toBe("not_sent");
      expect(await heldUsd()).toBe(100);
      m.context = freshContext();
      expect(await launchLinkedinCampaign(T, BINDING, await ask(FIRST), undefined, approval)).toEqual({ status: "active" });
      expect(await holds()).toEqual([expect.objectContaining({ idem_key: `${FIRST}:resume`, status: "committed" })]);
      expect(await heldUsd()).toBe(100);
    });
    it.each([
      ["committed", "committed", null],
      ["released by a confirmed stop", "released", "stopped"],
    ])("must not catch: a launch the protective pause closed, with its hold %s, may have reached LinkedIn: nothing is reopened", async (_label, status, reason) => {
      await op("refused");
      await hold(status, reason);
      expect(await judge()).toBe("reconciled");
      expect(await ops()).toEqual([{ id: FIRST, status: "refused" }]);
    });
    it("must not catch: the protective pause's commit failed quietly, so the hold still reads reserved, but the launch had stamped its send: unknown is kept and the hold stays", async () => {
      await op("refused");
      await hold("reserved");
      await attempted("2026-10-23 11:00:30+00");
      expect(await judge()).toBe("reconciled");
      expect(await ops()).toEqual([{ id: FIRST, status: "refused" }]);
      expect(await holds()).toEqual([expect.objectContaining({ status: "reserved" })]);
    });
    it("must catch: a send stamp from an older launch of this campaign says nothing about this one", async () => {
      await op("refused");
      await hold("reserved");
      await attempted("2026-10-22 09:00:00+00");
      expect(await judge()).toBe("not_sent");
    });
    it("must not catch: a stamp just before the row's own time could be the app clock running behind the database, so it counts as an attempt", async () => {
      await op("refused");
      await hold("reserved");
      await attempted("2026-10-23 10:59:00+00");
      expect(await judge()).toBe("reconciled");
    });
    it.each(["pending", "uncertain"])("must not catch: an operation still %s is truly unknown and nothing is touched", async (status) => {
      await op(status);
      await hold("reserved");
      expect(await judge()).toBe("unknown");
      expect(await holds()).toEqual([expect.objectContaining({ status: "reserved" })]);
      expect(await ops()).toEqual([{ id: FIRST, status }]);
    });
    it("must not catch: a succeeded operation is live and untouched", async () => {
      await op("succeeded");
      await hold("committed");
      expect(await judge()).toBe("succeeded");
      expect(await holds()).toEqual([expect.objectContaining({ status: "committed" })]);
    });
    it("must not catch: no row but a committed hold is a contradiction, so it stays unknown", async () => {
      await hold("committed");
      expect(await judge()).toBe("unknown");
    });
  });

  it("a fresh review launches after the first launch's hold was stuck, releases the stuck hold and counts the month once", async () => {
    const first = await unsentLaunchWithStuckHold(FIRST);
    expect(await heldUsd()).toBe(100);
    const fresh = await launchLinkedinCampaign(T, BINDING, await ask(FRESH), undefined, approval).catch((e: Error) => e.message);
    expect(fresh).toEqual({ status: "active" });
    expect(first).toBeInstanceOf(ExpectedToolError);
    expect(first.code).toBe("ads_launch_not_sent");
    expect(m.posts).toContain("adAccounts/42/adCampaigns/123:ACTIVE");
    expect(await holds()).toEqual([
      { idem_key: `${FIRST}:resume`, status: "released", reason: "rejected", amt: 100 },
      { idem_key: `${FRESH}:resume`, status: "committed", reason: null, amt: 100 },
    ]);
    expect(await heldUsd()).toBe(100);
    expect(await ops()).toEqual([{ id: FRESH, status: "succeeded" }]);
  });

  it("approving the same card again reuses its own stuck hold instead of being told the request was already used", async () => {
    await unsentLaunchWithStuckHold(FIRST);
    expect(await launchLinkedinCampaign(T, BINDING, await ask(FIRST), undefined, approval)).toEqual({ status: "active" });
    expect(await holds()).toEqual([{ idem_key: `${FIRST}:resume`, status: "committed", reason: null, amt: 100 }]);
    expect(await heldUsd()).toBe(100);
    expect(await ops()).toEqual([{ id: FIRST, status: "succeeded" }]);
  });

  it("when the claim cannot be deleted either, the card gives plain words with no Try again, and a fresh review still launches and frees the stuck hold", async () => {
    m.failClaimDelete = true;
    m.refuseFirstWrite = true;
    m.failSettle = 1;
    const decision = {
      id: FIRST,
      tenant_id: T,
      approved_by: "owner-1",
      approved_by_source: "email",
      body: {
        campaign_binding_id: BINDING,
        name: "Pilot",
        rationale: "Test the verified campaign",
        snapshot: (await ask(FIRST)).snapshot,
        total_budget_cents: 10000,
        total_budget_usd: 100,
        currency: "USD",
        end_time: Date.parse("2026-10-27T12:00:00Z"),
        origin: "agent",
      },
    };
    const card = await executeLinkedinGrowthLaunch(decision as never);
    expect(card).toEqual({
      ok: false,
      code: "linkedin_ads_launch_not_reopened",
      error: `LinkedIn did not accept this total budget or end date. Nothing changed in LinkedIn and nothing was held. Check both, then try again. ${LINKEDIN_LAUNCH_NOT_REOPENED}`,
    });
    expect(await ops()).toEqual([{ id: FIRST, status: "refused" }]);
    expect(await holds()).toEqual([{ idem_key: `${FIRST}:resume`, status: "reserved", reason: null, amt: 100 }]);
    m.failClaimDelete = false;
    m.refuseFirstWrite = false;
    expect(await launchLinkedinCampaign(T, BINDING, await ask(FRESH), undefined, approval)).toEqual({ status: "active" });
    expect(await holds()).toEqual([
      { idem_key: `${FIRST}:resume`, status: "released", reason: "rejected", amt: 100 },
      { idem_key: `${FRESH}:resume`, status: "committed", reason: null, amt: 100 },
    ]);
    expect(await heldUsd()).toBe(100);
  });

  it("a relaunch LinkedIn refuses on its first write leaves the campaign's earlier hold counting, and a later relaunch replaces it once", async () => {
    expect(await launchLinkedinCampaign(T, BINDING, await ask(FIRST), undefined, approval)).toEqual({ status: "active" });
    await db!.exec(`update ad_budget_reservations set status = 'released', reason = 'paused', released_on = '2026-10-23' where idem_key = '${FIRST}:resume'`);
    m.context = freshContext();
    m.posts = [];
    m.refuseFirstWrite = true;
    const refused = await launchLinkedinCampaign(T, BINDING, await ask(FRESH), undefined, approval).catch((e) => e);
    expect(refused).toBeInstanceOf(ExpectedToolError);
    expect(m.posts).toEqual([]);
    expect(await holds()).toEqual([
      { idem_key: `${FIRST}:resume`, status: "released", reason: "paused", amt: 100 },
      { idem_key: `${FRESH}:resume`, status: "released", reason: "rejected", amt: 100 },
    ]);
    expect(await heldUsd()).toBe(100);
    m.refuseFirstWrite = false;
    const THIRD = "a0000000-0000-4000-8000-000000000003";
    expect(await launchLinkedinCampaign(T, BINDING, await ask(THIRD), undefined, approval)).toEqual({ status: "active" });
    expect(await holds()).toEqual([
      { idem_key: `${FIRST}:resume`, status: "released", reason: "rebased", amt: 100 },
      { idem_key: `${FRESH}:resume`, status: "released", reason: "rejected", amt: 100 },
      { idem_key: `${THIRD}:resume`, status: "committed", reason: null, amt: 100 },
    ]);
    expect(await heldUsd()).toBe(100);
  });

  it("never releases another campaign's in-flight hold", async () => {
    await db!.exec(`
      insert into ad_budget_reservations (budget_id, tenant_id, idem_key, platform, object_id, op, daily_delta_usd, amount_usd, status)
      values ('${BUDGET}', '${T}', 'b0000000-0000-4000-8000-000000000009:resume', 'linkedin', 'other-binding', 'resume', 5, 20, 'reserved');
    `);
    expect(await launchLinkedinCampaign(T, BINDING, await ask(FRESH), undefined, approval)).toEqual({ status: "active" });
    expect(m.settles).toEqual([`${FRESH}:resume:committed`]);
    expect((await rows("select status from ad_budget_reservations where object_id = 'other-binding'"))[0].status).toBe("reserved");
  });

  const boundedRows = () =>
    rows("select idem_key, status, reason, amount_usd::float8 amt, bounded, cap_usd::float8 cap from ad_budget_reservations where object_id = $1 order by created_at, idem_key", [BINDING]);
  const ownHold = async () => Number((await rows("select ad_object_hold_usd($1, 'linkedin', $2) h", [T, BINDING]))[0].h);

  it.each(["off", "unreadable", "on"] as const)("with the no-friction switch %s, a $100 launch over 4 days holds the $100 it can spend, not a month of its worst day", async (flag) => {
    m.flag = flag;
    expect(await launchLinkedinCampaign(T, BINDING, await ask(FIRST), undefined, approval)).toEqual({ status: "active" });
    expect(await boundedRows()).toEqual([{ idem_key: `${FIRST}:resume`, status: "committed", reason: null, amt: 100, bounded: true, cap: 100 }]);
    expect(await heldUsd()).toBe(100);
  });

  it.each(["off", "unreadable"] as const)("with the no-friction switch %s, a relaunch replaces the campaign's own hold, so the form's credit of that hold is what the server counts", async (flag) => {
    m.flag = flag;
    await db!.exec(`update ad_budgets set monthly_usd = 400`);
    expect(await launchLinkedinCampaign(T, BINDING, await ask(FIRST), undefined, approval)).toEqual({ status: "active" });
    await db!.exec(`update ad_budget_reservations set status = 'released', reason = 'paused', released_on = '2026-10-23' where idem_key = '${FIRST}:resume'`);
    expect(await ownHold()).toBe(100);
    expect(await heldUsd()).toBe(100);
    m.context = freshContext();
    expect(await launchLinkedinCampaign(T, BINDING, await ask(FRESH), undefined, approval)).toEqual({ status: "active" });
    expect(await boundedRows()).toEqual([
      { idem_key: `${FIRST}:resume`, status: "released", reason: "rebased", amt: 100, bounded: true, cap: 100 },
      { idem_key: `${FRESH}:resume`, status: "committed", reason: null, amt: 100, bounded: true, cap: 100 },
    ]);
    expect(await heldUsd()).toBe(100);
  });

  it("a $10-a-day campaign launched with a $100 total over 4 days holds the whole $100 LinkedIn enforces, not the $50 its daily budget paces to", async () => {
    m.context.campaign.dailyBudget = { amount: "10.00", currencyCode: "USD" };
    expect(await launchLinkedinCampaign(T, BINDING, await ask(FIRST), undefined, approval)).toEqual({ status: "active" });
    expect(await boundedRows()).toEqual([{ idem_key: `${FIRST}:resume`, status: "committed", reason: null, amt: 100, bounded: true, cap: 100 }]);
    expect(await heldUsd()).toBe(100);
    expect(m.context.campaign.totalBudget).toEqual({ amount: "100.00", currencyCode: "USD" });
    expect(m.context.campaign.dailyBudget).toEqual({ amount: "10.00", currencyCode: "USD" });
  });

  it.each([
    [110, false],
    [999.99, false],
    [1000, true],
  ])("a $1000 total at $10 a day for 10 days with $%s left in the month launches = %s, and holds the whole $1000 when it does", async (monthly, launches) => {
    await db!.exec(`update ad_budgets set monthly_usd = ${monthly}`);
    m.context.campaign.dailyBudget = { amount: "10.00", currencyCode: "USD" };
    const a = { ...(await ask(FIRST, 100000)), end_time: Date.parse("2026-11-02T12:00:00Z") };
    const r = await launchLinkedinCampaign(T, BINDING, a, undefined, approval).catch((e) => e);
    if (launches) {
      expect(r).toEqual({ status: "active" });
      expect(await boundedRows()).toEqual([{ idem_key: `${FIRST}:resume`, status: "committed", reason: null, amt: 1000, bounded: true, cap: 1000 }]);
      expect(await heldUsd()).toBe(1000);
    } else {
      expect(r).toBeInstanceOf(ExpectedToolError);
      expect((r as ExpectedToolError).meta?.budget_refusal).toBe("cap_refuse: ad_budget_over_month");
      expect(m.posts).toEqual([]);
      expect(m.context.campaign.status).toBe("PAUSED");
      expect(await heldUsd()).toBe(0);
    }
  });

  describe("a wallet-funded launch that never reached LinkedIn", () => {
    const ACCT = "44444444-4444-4444-8444-444444444444";
    const covered = async () => Number((await rows("select reserved_cents from ads_campaign_reservations where campaign_binding_id = $1", [BINDING]))[0]?.reserved_cents ?? 0);
    async function walletCampaign(priorCents = 0) {
      m.context.binding.funding_source = "wallet";
      await db!.exec(`
        insert into ads_account_bindings values ('${ACCT}', '${T}', 'wallet');
        update ads_campaign_bindings set account_binding_id = '${ACCT}';
        insert into ads_campaign_binding_details values ('${BINDING}', '${T}', 'linkedin', 'wallet');
        insert into ads_wallets (tenant_id, balance_cents) values ('${T}', 15000);
        insert into ads_managed_account_grants (tenant_id, account_id) values ('${T}', 'account');
      `);
      if (priorCents) await db!.exec(`insert into ads_campaign_reservations (campaign_binding_id, tenant_id, reserved_cents) values ('${BINDING}', '${T}', ${priorCents})`);
    }

    it("a reserve that committed but answered with an error goes back to the coverage held before, and never says nothing was held", async () => {
      await walletCampaign(3000);
      m.reserveCommitsThenErrors = true;
      const err = await launchLinkedinCampaign(T, BINDING, await ask(FIRST), undefined, approval).catch((e) => e);
      expect(err).toBeInstanceOf(ExpectedToolError);
      expect(err.message).toBe("Zavi could not confirm the shared-wallet funds for this launch just now. Nothing was sent to LinkedIn. Try again in a minute.");
      expect(err.message).not.toMatch(/nothing was held/i);
      expect(m.rpcs.map((c) => c.fn)).toContain("ads_release_unsent_linkedin_launch");
      expect(await covered()).toBe(3000);
      expect(m.posts).toEqual([]);
      expect(await ops()).toEqual([]);
      expect(await holds()).toEqual([{ idem_key: `${FIRST}:resume`, status: "released", reason: "rejected", amt: 100 }]);
    });

    it("a first-ever reserve that committed but answered with an error goes back to zero", async () => {
      await walletCampaign();
      m.reserveCommitsThenErrors = true;
      await launchLinkedinCampaign(T, BINDING, await ask(FIRST), undefined, approval).catch((e) => e);
      expect(await covered()).toBe(0);
    });

    describe("coverage 10000, 2000 recorded spent, LinkedIn now reports 5000", () => {
      const wallet = async () => (await rows("select reserved_cents::int8 r, spent_cents::int8 s, (select balance_cents::int8 from ads_wallets) b from ads_campaign_reservations where campaign_binding_id = $1", [BINDING])).map((x) => ({ r: Number(x.r), s: Number(x.s), b: Number(x.b) }))[0];
      const releaseCalls = () => m.rpcs.filter((c) => c.fn === "ads_release_unsent_linkedin_launch");
      async function settledOnly(balance: number) {
        await walletCampaign(10000);
        await db!.exec(`update ads_campaign_reservations set spent_cents = 2000; update ads_wallets set balance_cents = ${balance}; update ad_budgets set monthly_usd = 5000`);
        m.lifetimeCents = 5000;
      }

      it("a balance refusal rolled the reserve back, so the coverage, the wallet and the recorded spend stay exactly where they were", async () => {
        await settledOnly(15000);
        const err = await launchLinkedinCampaign(T, BINDING, await ask(FIRST, 50000), undefined, approval).catch((e) => e);
        expect(err).toBeInstanceOf(ExpectedToolError);
        expect(err.message).toContain("nothing was held");
        expect(await wallet()).toEqual({ r: 10000, s: 2000, b: 15000 });
        expect(releaseCalls()).toEqual([]);
        expect(m.posts).toEqual([]);
      });

      it("a reserve that failed without committing leaves the coverage alone too", async () => {
        await settledOnly(50000);
        m.reserveFailsUncommitted = true;
        const err = await launchLinkedinCampaign(T, BINDING, await ask(FIRST, 20000), undefined, approval).catch((e) => e);
        expect(err.message).toBe("Zavi could not confirm the shared-wallet funds for this launch just now. Nothing was sent to LinkedIn. Try again in a minute.");
        expect(await wallet()).toEqual({ r: 10000, s: 2000, b: 50000 });
        expect(releaseCalls()).toEqual([]);
      });

      it("a reserve that committed and then errored settles the spend and goes back to the coverage left after it", async () => {
        await settledOnly(50000);
        m.reserveCommitsThenErrors = true;
        await launchLinkedinCampaign(T, BINDING, await ask(FIRST, 20000), undefined, approval).catch((e) => e);
        expect(await wallet()).toEqual({ r: 7000, s: 5000, b: 47000 });
        expect(releaseCalls()).toHaveLength(1);
      });

      it("when the failed reserve cannot be told from a committed one, the coverage stays held and is never lowered", async () => {
        await settledOnly(50000);
        m.reserveCommitsThenErrors = true;
        m.failCoverageReread = true;
        const err = await launchLinkedinCampaign(T, BINDING, await ask(FIRST, 20000), undefined, approval).catch((e) => e);
        expect(err.message).not.toMatch(/nothing was held/i);
        expect(await wallet()).toEqual({ r: 15000, s: 5000, b: 47000 });
        expect(releaseCalls()).toEqual([]);
      });
    });

    it("when the release itself fails, the founder is told the funds are reserved, and the next launch reserves only its own budget", async () => {
      await walletCampaign();
      m.refuseFirstWrite = true;
      m.failWalletRelease = true;
      const err = await launchLinkedinCampaign(T, BINDING, await ask(FIRST), undefined, approval).catch((e) => e);
      expect(err.code).toBe("ads_launch_not_sent");
      expect(err.message).toBe("Nothing was sent to LinkedIn, but Zavi could not give back the shared-wallet funds it set aside for this launch yet. They are reserved, not spent, and Zavi gives them back before this campaign's next launch.");
      expect(await covered()).toBe(10000);
      expect(await ops()).toEqual([{ id: FIRST, status: "refused" }]);
      m.refuseFirstWrite = false;
      m.failWalletRelease = false;
      expect(await launchLinkedinCampaign(T, BINDING, await ask(FRESH, 5000), undefined, approval)).toEqual({ status: "active" });
      expect(await covered()).toBe(5000);
    });

    it("an earlier launch closed by a protective pause may have spent, so its coverage is not given back", async () => {
      await walletCampaign(10000);
      await db!.exec(`
        insert into ads_campaign_operations (id, tenant_id, campaign_binding_id, kind, payload, status)
          values ('${FIRST}', '${T}', '${BINDING}', 'activate', '{}'::jsonb, 'refused');
        insert into ad_budget_reservations (budget_id, tenant_id, idem_key, platform, object_id, op, daily_delta_usd, amount_usd, status, reason, released_on, bounded, cap_usd)
          values ('${BUDGET}', '${T}', '${FIRST}:resume', 'linkedin', '${BINDING}', 'resume', 25, 100, 'released', 'paused', '2026-10-23', true, 100);
      `);
      expect(await launchLinkedinCampaign(T, BINDING, await ask(FRESH, 5000), undefined, approval)).toEqual({ status: "active" });
      expect(await covered()).toBe(10000);
    });
  });

  describe("the launch form's money left agrees with what the server lets the launch reserve", () => {
    const monthLeft = async () => {
      const b = (await rows("select * from ad_budgets where id = $1", [BUDGET]))[0];
      const cap = Number((await rows("select _ad_budget_month_cap($1, $2, '2026-10-23'::date) c", [b.monthly_usd, b.started_on]))[0].c);
      return Math.max(Math.round((cap - Number(b.spent_usd) - (await heldUsd())) * 100) / 100, 0);
    };
    const formLeft = async () => Math.round(((await monthLeft()) + (await ownHold())) * 100) / 100;

    it("a stuck unsent $10 hold that fills a $10 month is credited to this campaign, so a $10 launch is allowed, succeeds, and the stuck hold is gone", async () => {
      await db!.exec(`update ad_budgets set monthly_usd = 10`);
      await unsentLaunchWithStuckHold(FIRST, 1000);
      expect(await heldUsd()).toBe(10);
      expect(await monthLeft()).toBe(0);
      expect(await ownHold()).toBe(10);
      expect(await formLeft()).toBe(10);
      expect(await launchLinkedinCampaign(T, BINDING, await ask(FRESH, 1000), undefined, approval)).toEqual({ status: "active" });
      expect(m.posts).toContain("adAccounts/42/adCampaigns/123:ACTIVE");
      expect(await holds()).toEqual([
        { idem_key: `${FIRST}:resume`, status: "released", reason: "rejected", amt: 10 },
        { idem_key: `${FRESH}:resume`, status: "committed", reason: null, amt: 10 },
      ]);
      expect(await heldUsd()).toBe(10);
    });

    it("a stuck hold whose claim row is still pending is a launch in flight, not unsent, and is not credited", async () => {
      await db!.exec(`update ad_budgets set monthly_usd = 10`);
      await unsentLaunchWithStuckHold(FIRST, 1000);
      await db!.exec(`insert into ads_campaign_operations (id, tenant_id, campaign_binding_id, kind, payload, status)
        values ('${FIRST}', '${T}', '${BINDING}', 'activate', '{}'::jsonb, 'pending')`);
      expect(await ownHold()).toBe(0);
      expect(await formLeft()).toBe(0);
      await db!.exec(`update ads_campaign_operations set status = 'refused' where id = '${FIRST}'`);
      expect(await ownHold()).toBe(10);
    });

    it.each([
      [85, 5, 15],
      [95, 0, 5],
      [105, 0, 0],
    ])("with another campaign holding $%s of a $100 month and this campaign's own paused $10 hold, the month shows $%s left and the form $%s, the most the server lets this launch take", async (other, left, room) => {
      await db!.exec(`update ad_budgets set monthly_usd = 100`);
      expect(await launchLinkedinCampaign(T, BINDING, await ask(FIRST, 1000), undefined, approval)).toEqual({ status: "active" });
      await db!.exec(`update ad_budget_reservations set status = 'released', reason = 'paused', released_on = '2026-10-23' where idem_key = '${FIRST}:resume'`);
      await db!.exec(`insert into ad_budget_reservations (budget_id, tenant_id, idem_key, platform, object_id, op, daily_delta_usd, amount_usd, status, bounded, cap_usd, ends_on, over_cap)
        values ('${BUDGET}', '${T}', 'meta-big:raise', 'meta', 'adset-9', 'raise', 1, ${other}, 'committed', true, ${other}, '2026-10-31', ${other > 90})`);
      expect(await monthLeft()).toBe(left);
      expect(await formLeft()).toBe(room);
      m.context = freshContext();
      m.posts = [];
      const over = await launchLinkedinCampaign(T, BINDING, await ask(SECOND_ID, Math.max(1000, room * 100 + 1)), undefined, approval).catch((e) => e);
      expect(over).toBeInstanceOf(ExpectedToolError);
      expect((over as ExpectedToolError).meta?.budget_refusal).toBe("cap_refuse: ad_budget_over_month");
      expect(m.posts).toEqual([]);
      if (room >= 10) {
        m.context = freshContext();
        expect(await launchLinkedinCampaign(T, BINDING, await ask(FRESH, room * 100), undefined, approval)).toEqual({ status: "active" });
        expect(await monthLeft()).toBe(0);
        expect(await formLeft()).toBe(room);
      }
    });
  });

  describe("an owner's launch that does not fit the month's money left", () => {
    const SECOND = "a0000000-0000-4000-8000-000000000004";
    const allRows = () =>
      rows("select idem_key, platform, status, reason, amount_usd::float8 amt, over_cap from ad_budget_reservations order by created_at, idem_key");
    async function pausedWithOwnTenDollarHold() {
      await db!.exec(`update ad_budgets set monthly_usd = 155`);
      expect(await launchLinkedinCampaign(T, BINDING, await ask(FIRST, 1000), undefined, approval)).toEqual({ status: "active" });
      await db!.exec(`update ad_budget_reservations set status = 'released', reason = 'paused', released_on = '2026-10-23' where idem_key = '${FIRST}:resume'`);
      await db!.exec(`update ad_budgets set spent_usd = 145`);
      m.context = freshContext();
      m.posts = [];
      m.rpcs = [];
      m.settles = [];
      expect(await ownHold()).toBe(10);
      expect(await heldUsd()).toBe(10);
    }

    it("a $50 launch with $10 left (its own $10 hold counted) is refused with no LinkedIn write and no over-cap hold, and its own hold stays", async () => {
      await pausedWithOwnTenDollarHold();
      const before = await allRows();
      const err = await launchLinkedinCampaign(T, BINDING, await ask(SECOND, 5000), undefined, approval).catch((e) => e);
      expect(err).toBeInstanceOf(ExpectedToolError);
      expect((err as ExpectedToolError).code).toBe("ads_launch_not_sent");
      expect((err as ExpectedToolError).message).toBe(
        "This launch would go over your monthly ad budget. Nothing was sent to LinkedIn. Lower the total budget or raise your monthly ad budget, then try again.",
      );
      expect((err as ExpectedToolError).meta?.budget_refusal).toBe("cap_refuse: ad_budget_over_month");
      expect(m.posts).toEqual([]);
      expect(m.context.campaign.status).toBe("PAUSED");
      expect(m.context.campaign.totalBudget).toBeUndefined();
      const reserve = m.rpcs.filter((c) => c.fn === "reserve_ad_spend");
      expect(reserve).toHaveLength(1);
      expect(reserve[0].args).not.toHaveProperty("p_over_cap_ok");
      expect(reserve[0].args).toMatchObject({ p_cap_usd: 50, p_factor: 1, p_op: "resume", p_platform: "linkedin" });
      expect(m.rpcs.map((c) => c.fn)).not.toContain("ads_reserve_linkedin_launch");
      const after = await allRows();
      expect(after.filter((r) => r.over_cap)).toEqual([]);
      expect(after.filter((r) => r.status === "reserved" || r.status === "committed")).toEqual([]);
      expect(after).toEqual([...before, { idem_key: `${SECOND}:resume`, platform: "linkedin", status: "refused", reason: "over_month", amt: 50, over_cap: false }]);
      expect(before).toEqual([{ idem_key: `${FIRST}:resume`, platform: "linkedin", status: "released", reason: "paused", amt: 10, over_cap: false }]);
      expect(await ownHold()).toBe(10);
      expect(await heldUsd()).toBe(10);
      expect(await ops()).toEqual([{ id: FIRST, status: "succeeded" }]);
    });

    it("an agent card for the same $50 launch is refused the same way, nothing reaches LinkedIn", async () => {
      await pausedWithOwnTenDollarHold();
      const card = await executeLinkedinGrowthLaunch({
        id: SECOND,
        tenant_id: T,
        approved_by: "owner-1",
        approved_by_source: "email",
        body: {
          campaign_binding_id: BINDING,
          name: "Pilot",
          rationale: "Test the verified campaign",
          snapshot: (await ask(SECOND)).snapshot,
          total_budget_cents: 5000,
          total_budget_usd: 50,
          currency: "USD",
          end_time: Date.parse("2026-10-27T12:00:00Z"),
          origin: "agent",
        },
      } as never);
      expect(card).toEqual({ ok: false, error: "cap_refuse: ad_budget_over_month" });
      expect(m.posts).toEqual([]);
      expect((await allRows()).filter((r) => r.over_cap)).toEqual([]);
      expect(await ownHold()).toBe(10);
      expect(await heldUsd()).toBe(10);
    });

    it("a launch of exactly the $10 left replaces its own hold and goes live", async () => {
      await pausedWithOwnTenDollarHold();
      expect(await launchLinkedinCampaign(T, BINDING, await ask(SECOND, 1000), undefined, approval)).toEqual({ status: "active" });
      expect(m.posts).toContain("adAccounts/42/adCampaigns/123:ACTIVE");
      expect(await allRows()).toEqual([
        { idem_key: `${FIRST}:resume`, platform: "linkedin", status: "released", reason: "rebased", amt: 10, over_cap: false },
        { idem_key: `${SECOND}:resume`, platform: "linkedin", status: "committed", reason: null, amt: 10, over_cap: false },
      ]);
      expect(await heldUsd()).toBe(10);
    });

    it("another platform's owner approval over the month is still recorded over the cap", async () => {
      await pausedWithOwnTenDollarHold();
      const hold = await reserveAdSpend(
        { id: "c0000000-0000-4000-8000-000000000001", tenant_id: T, exec_source: "workspace", approved_by: "owner-1", approved_by_source: "email", body: {} },
        { platform: "meta", op: "raise", object_id: "adset-9", daily_delta_usd: 20, currency: "USD" },
      );
      expect(hold).toMatchObject({ status: "held", over_cap: true, fresh: true });
      expect(m.rpcs.find((c) => c.fn === "reserve_ad_spend")?.args).toMatchObject({ p_over_cap_ok: true });
      expect((await allRows()).filter((r) => r.over_cap)).toEqual([
        expect.objectContaining({ idem_key: "c0000000-0000-4000-8000-000000000001:raise", platform: "meta", status: "reserved", over_cap: true }),
      ]);
    });
  });
});
