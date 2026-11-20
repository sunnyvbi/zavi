import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claimIdemKey } from "@/services/growth/pending-test-claim";

const MIGRATION = readFileSync(join(__dirname, "../../../../../supabase/migrations/20261031130000_ad_pending_tests.sql"), "utf8")
  .replace(/^begin;$/m, "")
  .replace(/^commit;$/m, "");

const BOOTSTRAP = `
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
  end $$;
  create table tenants (id uuid primary key);
  create table ad_budgets (id uuid primary key default gen_random_uuid(), tenant_id uuid not null, status text not null default 'active', updated_at timestamptz default now());
  create table channel_actions (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null,
    status text not null default 'pending',
    exec_class text,
    exec_status text check (exec_status in ('queued','dispatching','executed','failed')),
    exec_result jsonb
  );
  create table ad_budget_reservations (
    id uuid primary key default gen_random_uuid(),
    budget_id uuid not null references ad_budgets(id),
    tenant_id uuid not null,
    idem_key text not null,
    platform text not null default 'tiktok',
    op text not null default 'create',
    object_id text,
    daily_delta_usd numeric(12,2) not null default 25,
    amount_usd numeric(12,2) not null default 525,
    status text not null default 'reserved',
    reason text,
    released_on date,
    pause_due boolean not null default false,
    channel_action_id uuid,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (budget_id, idem_key)
  );
`;

const PG_URL = process.env.ZAVI_TEST_VANILLA_PG_URL;
const T = randomUUID();
const T2 = randomUUID();

describe.skipIf(!PG_URL)("ad_pending_tests migration, live", () => {
  let db: Client;
  let budget: string;

  const one = async <R = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R> => (await db.query(sql, params)).rows[0] as R;
  const card = async (exec_status: string | null, code?: string, tenant = T, exec_class = "reddit_ads.launch_campaign") =>
    (await one<{ id: string }>("insert into channel_actions (tenant_id, exec_status, exec_result, exec_class) values ($1, $2, $3, $4) returning id", [tenant, exec_status, code ? JSON.stringify({ code }) : null, exec_class])).id;
  const claimHold = async (cardId: string, status = "reserved") => {
    const key = claimIdemKey("tiktok_ads", cardId);
    await db.query("insert into ad_budget_reservations (budget_id, tenant_id, idem_key, status, channel_action_id) values ($1, $2, $3, $4, $5)", [budget, T, key, status, cardId]);
    return key;
  };
  const release = (key: string, cardId: string, tenant = T) =>
    one<{ r: { status: string } }>("select release_pending_test_hold($1, $2, $3) r", [tenant, key, cardId]).then((x) => x.r.status);
  const holdStatus = (key: string) => one<{ status: string; reason: string | null }>("select status, reason from ad_budget_reservations where idem_key = $1", [key]);

  beforeAll(async () => {
    db = new Client({ connectionString: PG_URL });
    await db.connect();
    const exists = await one<{ t: string | null }>("select to_regclass('public.channel_actions')::text t");
    if (exists.t) throw new Error("ZAVI_TEST_VANILLA_PG_URL must be a VANILLA throwaway database (channel_actions already exists)");
    await db.query("begin");
    await db.query(BOOTSTRAP);
    await db.query("insert into tenants values ($1), ($2)", [T, T2]);
    budget = (await one<{ id: string }>("insert into ad_budgets (tenant_id) values ($1) returning id", [T])).id;
    await db.query(MIGRATION);
  });

  afterAll(async () => {
    if (!db) return;
    await db.query("rollback").catch(() => {});
    await db.end();
  });

  describe("the table", () => {
    const insert = (tenant: string, channel: string, extra = "") =>
      db.query(`insert into ad_pending_tests (tenant_id, channel_slug, daily_budget_usd, hold_usd, proposal, expires_at${extra ? ", status, action_id, hold_idem_key" : ""}) values ($1, $2, 25, 525, '{}', now() + interval '7 days'${extra})`, [tenant, channel]);

    it("one row per channel per tenant", async () => {
      await db.query("savepoint s");
      await insert(T, "tiktok_ads");
      await insert(T, "reddit_ads");
      await insert(T2, "tiktok_ads");
      await expect(insert(T, "tiktok_ads")).rejects.toThrow(/duplicate key/);
      await db.query("rollback to savepoint s");
    });

    it("a claimed row must name its card and its hold; an unknown channel is refused", async () => {
      await db.query("savepoint s");
      await expect(insert(T, "tiktok_ads", ", 'claimed', null, null")).rejects.toThrow(/check constraint/);
      await db.query("rollback to savepoint s");
      await expect(insert(T, "meta_ads")).rejects.toThrow(/check constraint/);
      await db.query("rollback to savepoint s");
    });

    it("RLS is on and nothing is granted to anon or authenticated", async () => {
      const r = await one<{ rls: boolean }>("select relrowsecurity rls from pg_class where relname = 'ad_pending_tests'");
      expect(r.rls).toBe(true);
      const g = await one<{ n: string }>("select count(*) n from information_schema.role_table_grants where table_name = 'ad_pending_tests' and grantee in ('anon','authenticated')");
      expect(Number(g.n)).toBe(0);
    });
  });

  describe("release_pending_test_hold", () => {
    it("waiting for approval, rejected, or failed cleanly: released, nothing counted for today", async () => {
      for (const [exec, code] of [[null, undefined], ["failed", "tiktok_ads_budget_refused"]] as const) {
        const c = await card(exec, code);
        const key = await claimHold(c);
        expect(await release(key, c)).toBe("released");
        expect(await holdStatus(key)).toEqual({ status: "released", reason: "pending_test_released" });
      }
    });

    it("an approval that is queued, running or done, or a failure that may have created something: kept ('busy')", async () => {
      for (const [exec, code] of [["queued"], ["dispatching"], ["executed"], ["failed", "exec_partial"], ["failed", "exec_outcome_unknown"]] as const) {
        const c = await card(exec, code);
        const key = await claimHold(c);
        expect(await release(key, c)).toBe("busy");
        expect((await holdStatus(key)).status).toBe("reserved");
      }
    });

    it("a TikTok launch that stopped with exec_partial (confirmed off) is released; its exec_outcome_unknown is kept", async () => {
      const off = await card("failed", "exec_partial", T, "tiktok_ads.create_launch");
      const offKey = await claimHold(off);
      expect(await release(offKey, off)).toBe("released");
      const unknown = await card("failed", "exec_outcome_unknown", T, "tiktok_ads.create_launch");
      const unknownKey = await claimHold(unknown);
      expect(await release(unknownKey, unknown)).toBe("busy");
    });

    it("a committed hold (the launch ran) is never released", async () => {
      const c = await card(null);
      const key = await claimHold(c, "committed");
      expect(await release(key, c)).toBe("committed");
      expect((await holdStatus(key)).status).toBe("committed");
    });

    it("only this card's own hold, only this tenant's", async () => {
      const c = await card(null);
      const other = await card(null);
      const key = await claimHold(c);
      expect(await release(key, other)).toBe("not_found");
      expect(await release(key, c, T2)).toBe("not_found");
      expect((await holdStatus(key)).status).toBe("reserved");
    });

    it("is callable by service_role only", async () => {
      const r = await one<{ anon: boolean; svc: boolean }>(
        "select has_function_privilege('anon', 'release_pending_test_hold(uuid,text,uuid)', 'execute') anon, has_function_privilege('service_role', 'release_pending_test_hold(uuid,text,uuid)', 'execute') svc",
      );
      expect(r).toEqual({ anon: false, svc: true });
    });
  });
});
