
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/supabase", async () => {
  const w = await import("./_world");
  return { serviceClient: () => w.fakeServiceClient(w.world.db) };
});
vi.mock("@/services/logging/logEvent", async () => {
  const w = await import("./_world");
  return {
    logEvent: async (e: import("./_world").LogEntry) => {
      w.world.logs.push(e);
    },
  };
});
vi.mock("@/services/auth/middleware", async () => {
  const w = await import("./_world");
  return { requireAuth: (req: never, res: never) => w.world.requireAuth(req, res) };
});
vi.mock("@/services/billing/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/billing/client")>();
  const w = await import("./_world");
  const plans = await import("@/services/billing/plans");
  return {
    ...actual,
    billingStripe: () => (plans.billingConfigured() ? w.world.stripe.api : null),
    requireBillingStripe: () => {
      if (!plans.billingConfigured()) throw new Error("billing Stripe client not configured");
      return w.world.stripe.api;
    },
  };
});

import { billingCheckout } from "@/routes/billing/checkout";
import { billingTopup } from "@/routes/billing/topup";
import { FREE_DAILY_CREDITS_SQL_FALLBACK } from "@/services/agents/credits";
import type { PaidTier } from "@/services/billing/tiers";
import { installBillingEnv, PRICE_IDS, resetWorld, world, type ApplyArgs } from "./_world";
import { callRoute, deliver, journeyWebhook } from "./_harness";

const url = process.env.BILLING_PG_URL;

const T1 = "b1110000-0000-4000-8000-000000000001";
const T2 = "b2220000-0000-4000-8000-000000000002";
const DAY = 86_400;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;

async function q<R = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R[]> {
  return (await db.query(sql, params)).rows as R[];
}

async function setConfig(patch: Record<string, unknown>): Promise<void> {
  await q("update system_config set blob = blob || $1::jsonb where id = 1", [JSON.stringify(patch)]);
}

async function seedTenant(id: string): Promise<string> {
  await q("insert into tenants (id, slug, display_name) values ($1, $2, 'billing test')", [id, `bt-${id.slice(0, 8)}`]);
  return world.signIn(id);
}

type Wallet = {
  included_allowance: number;
  included_used: number;
  daily_allowance: number;
  daily_used: number;
  purchased_balance: number;
  reserved: number;
  window_days: number;
};

async function wallet(tenantId: string): Promise<Wallet> {
  await q("select _credit_balance_touch($1)", [tenantId]);
  const [w] = await q<Wallet>(
    `select included_allowance, included_used, daily_allowance, daily_used, purchased_balance,
            reserved, (period_end - period_start) as window_days
       from tenant_credit_balances where tenant_id = $1`,
    [tenantId],
  );
  return w;
}

async function tier(tenantId: string): Promise<string> {
  return (await q<{ t: string }>("select _tenant_tier($1) as t", [tenantId]))[0].t;
}

async function subRow(tenantId: string) {
  return (await q("select * from tenant_subscriptions where tenant_id = $1", [tenantId]))[0];
}

const pgDeps = {
  eventProcessed: async (id: string) =>
    (await q("select 1 from stripe_billing_events where event_id = $1", [id])).length > 0,
  markProcessed: async (id: string, type: string) => {
    await q("insert into stripe_billing_events (event_id, type) values ($1, $2) on conflict do nothing", [id, type]);
  },
  resolveTenantByCustomer: async (customerId: string) =>
    (await q<{ tenant_id: string }>("select tenant_id from tenant_subscriptions where stripe_customer_id = $1", [customerId]))[0]
      ?.tenant_id ?? null,
  tenantExists: async (id: string) => (await q("select 1 from tenants where id = $1", [id])).length > 0,
  applyState: async (a: ApplyArgs) => {
    const [r] = await q<{ outcome: string }>(
      "select apply_subscription_state($1,$2,$3,$4,$5,$6,$7,$8) as outcome",
      [a.tenant_id, a.customer_id, a.subscription_id, a.plan, a.status, a.current_period_end, a.cancel_at_period_end, a.event_created],
    );
    return { error: null, outcome: r.outcome };
  },
  setTier: async (tenantId: string, t: PaidTier | null | "keep", ec: number) => {
    const sets = t === "keep" ? "" : "tier = $3,";
    const refundGuard = t !== null && t !== "keep" ? "and credits_revoked_at is null" : "";
    await q(
      `update tenant_subscriptions set ${sets} comp_expires_at = null, tier_event_created = $2, updated_at = now()
        where tenant_id = $1 and stripe_event_created = $2 and tier_event_created < $2 and grandfathered = false ${refundGuard}`,
      t === "keep" ? [tenantId, ec] : [tenantId, ec, t],
    );
    return { error: null };
  },
  setMonthlyCredits: async (tenantId: string, c: number | null, usd: number | null, ec: number) => {
    await q("select set_tenant_monthly_credits($1, $2::int, $3::int, $4::bigint)", [tenantId, c, usd, ec]);
    return { error: null };
  },
  clearTierForSubscription: async (tenantId: string, subId: string) => {
    await q(
      `update tenant_subscriptions set tier = null, comp_expires_at = null, updated_at = now()
        where tenant_id = $1 and stripe_subscription_id = $2 and grandfathered = false`,
      [tenantId, subId],
    );
    return { error: null };
  },
  revokeCredits: async (tenantId: string, ec: number, subId: string) => {
    const [r] = await q<{ ok: boolean }>("select revoke_tenant_credits($1, $2, $3) as ok", [tenantId, ec, subId]);
    return { error: null, applied: r.ok === true };
  },
  applyCreditTopup: async (tenantId: string, credits: number, pi: string, evt: string) => {
    await q("select apply_credit_topup($1, $2, $3, $4)", [tenantId, credits, pi, evt]);
    return { error: null };
  },
  revokeCreditTopup: async (pi: string, evt: string, hint: string | null) => {
    const [r] = await q<{ o: string }>("select revoke_credit_topup($1, $2, $3) as o", [pi, evt, hint]);
    return { error: null, outcome: r.o ?? "not_a_topup" };
  },
  readIncludedUsed: async () => null,
};

function realWebhook() {
  return journeyWebhook(pgDeps).handler;
}

async function subscribe(tenantId: string, t: PaidTier, token: string, opts: { status?: string } = {}) {
  const res = await callRoute(billingCheckout, { token, body: { tier: t, term: "monthly" } });
  expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
  const paid = world.sim.completeSubscriptionCheckout(world.stripe.lastSession().id, opts);
  const handler = realWebhook();
  for (const ev of [paid.events.sessionCompleted, paid.events.subscriptionCreated]) {
    const r = await deliver(handler, ev);
    expect(r.statusCode, JSON.stringify(r.body)).toBe(200);
  }
  return paid;
}

async function startRun(tenantId: string, slug: string): Promise<string> {
  const [r] = await q<{ id: string }>(
    "insert into agent_runs (tenant_id, agent_slug, agent_definition_hash, trigger) values ($1, $2, 'h', 'manual') returning id",
    [tenantId, slug],
  );
  return r.id;
}

async function finishRun(runId: string, status: string, costUsd: number): Promise<void> {
  await q("update agent_runs set status = 'running' where id = $1", [runId]);
  await q("update agent_runs set status = $2, cost_usd = $3 where id = $1", [runId, status, costUsd]);
}

async function pgError(fn: () => Promise<unknown>): Promise<string | null> {
  await q("savepoint probe");
  try {
    await fn();
    await q("release savepoint probe");
    return null;
  } catch (e) {
    await q("rollback to savepoint probe");
    return (e as Error).message;
  }
}

async function endDailyWindow(tenantId: string) {
  await q("update tenant_credit_balances set daily_period_end = current_date where tenant_id = $1", [tenantId]);
}
async function endFreeDay(tenantId: string) {
  await q(
    "update tenant_credit_balances set period_start = current_date - 1, period_end = current_date where tenant_id = $1",
    [tenantId],
  );
}
async function endMonthlyWindow(tenantId: string) {
  await q(
    `update tenant_credit_balances set period_start = current_date - 31, period_end = current_date - 1 where tenant_id = $1`,
    [tenantId],
  );
}

let restoreEnv: () => void;

describe.skipIf(!url)("billing journeys on real Postgres", () => {
  beforeAll(async () => {
    const { Client } = await import("pg");
    db = new Client({ connectionString: url });
    await db.connect();
  });
  afterAll(async () => {
    await db?.end();
  });

  beforeEach(async () => {
    resetWorld();
    restoreEnv = installBillingEnv();
    await q("begin");
    await setConfig({
      credits_enforced: true,
      credits_enforced_allowlist: [],
      tier_gate_enforced: false,
      free_daily_credits: 1000,
      tier_credits: { starter: 8000, growth: 48000, pro: 96000 },
      tier_pro_tenants: [],
    });
  });
  afterEach(async () => {
    await q("rollback");
    restoreEnv();
  });

  describe("P. plans + upgrade: plan and credits land once", () => {
    it("P-1 a tenant with no subscription is Free: 1,000 credits on a one-day window, no second daily pool", async () => {
      await seedTenant(T1);
      expect(await tier(T1)).toBe("free");
      expect(await wallet(T1)).toMatchObject({ included_allowance: 1000, window_days: 1, daily_allowance: 0 });
    });

    it.each([
      ["starter", 8000],
      ["growth", 48000],
      ["pro", 96000],
    ] as const)("P-2 checkout %s → tier %s, monthly pool %i plus the 1,000 daily grant", async (t, pool) => {
      const tok = await seedTenant(T1);
      await subscribe(T1, t, tok);
      expect(await tier(T1)).toBe(t);
      const w = await wallet(T1);
      expect(w).toMatchObject({ included_allowance: pool, included_used: 0, daily_allowance: 1000 });
      expect(w.window_days).toBeGreaterThanOrEqual(28);
    });

    it("P-3 Stripe redelivers every checkout event: the plan and pool land once, nothing doubles", async () => {
      const tok = await seedTenant(T1);
      const paid = await subscribe(T1, "starter", tok);
      const before = await wallet(T1);
      const handler = realWebhook();
      for (let i = 0; i < 3; i++) {
        for (const ev of [paid.events.sessionCompleted, paid.events.subscriptionCreated]) {
          expect((await deliver(handler, ev)).statusCode).toBe(200);
        }
      }
      expect(await wallet(T1)).toEqual(before);
      const events = await q("select event_id from stripe_billing_events where event_id = any($1)", [
        [paid.events.sessionCompleted.id, paid.events.subscriptionCreated.id],
      ]);
      expect(events).toHaveLength(2);
    });

    it("P-4 Starter with 5,000 used upgrades to Pro: pool becomes 96,000, the 5,000 stays spent (not reset, not added twice)", async () => {
      const tok = await seedTenant(T1);
      const paid = await subscribe(T1, "starter", tok);
      await wallet(T1);
      await q("update tenant_credit_balances set included_used = 5000 where tenant_id = $1", [T1]);
      const handler = realWebhook();
      const up = world.sim.updateSubscription(paid.sub.id, { priceId: PRICE_IDS.pro.monthly });
      expect((await deliver(handler, up)).statusCode).toBe(200);
      expect(await tier(T1)).toBe("pro");
      expect(await wallet(T1)).toMatchObject({ included_allowance: 96000, included_used: 5000 });
      expect((await deliver(handler, up)).statusCode).toBe(200);
      for (let i = 0; i < 3; i++) await wallet(T1);
      expect(await wallet(T1)).toMatchObject({ included_allowance: 96000, included_used: 5000 });
    });

    it("P-5 an older plan-change event delivered late cannot undo the upgrade", async () => {
      const tok = await seedTenant(T1);
      const paid = await subscribe(T1, "starter", tok);
      const handler = realWebhook();
      const toGrowth = world.sim.updateSubscription(paid.sub.id, { priceId: PRICE_IDS.growth.monthly });
      const toPro = world.sim.updateSubscription(paid.sub.id, { priceId: PRICE_IDS.pro.monthly });
      expect((await deliver(handler, toPro)).statusCode).toBe(200);
      expect((await deliver(handler, toGrowth)).statusCode).toBe(200);
      expect(await tier(T1)).toBe("pro");
      expect((await wallet(T1)).included_allowance).toBe(96000);
    });

    it("P-6 a Free user who spent 900 today upgrades: full 8,000 pool, plus a fresh 1,000 daily grant", async () => {
      const tok = await seedTenant(T1);
      await wallet(T1);
      await q("update tenant_credit_balances set included_used = 900 where tenant_id = $1", [T1]);
      await subscribe(T1, "starter", tok);
      expect(await wallet(T1)).toMatchObject({
        included_allowance: 8000, included_used: 0, daily_allowance: 1000, daily_used: 0,
      });
    });

    it("P-7 Pro downgrades to Starter: pool drops to 8,000", async () => {
      const tok = await seedTenant(T1);
      const paid = await subscribe(T1, "pro", tok);
      const down = world.sim.updateSubscription(paid.sub.id, { priceId: PRICE_IDS.starter.monthly });
      expect((await deliver(realWebhook(), down)).statusCode).toBe(200);
      expect(await tier(T1)).toBe("starter");
      expect((await wallet(T1)).included_allowance).toBe(8000);
    });

    it("P-8 staff retune tier_credits in config: the pool follows on the next read, no deploy, no Stripe event", async () => {
      const tok = await seedTenant(T1);
      await subscribe(T1, "starter", tok);
      await setConfig({ tier_credits: { starter: 9000, growth: 48000, pro: 96000 } });
      expect((await wallet(T1)).included_allowance).toBe(9000);
    });
  });

  describe("Q. failed card", () => {
    it("Q-1a the first payment fails (subscription incomplete): no paid tier, so paid agents stay locked", async () => {
      const tok = await seedTenant(T1);
      await subscribe(T1, "pro", tok, { status: "incomplete" });
      expect(await tier(T1)).toBe("free");
    });

    it("Q-1b a failed first payment leaves the tenant on the Free daily pool, not 80,000/month", async () => {
      const tok = await seedTenant(T1);
      await subscribe(T1, "pro", tok, { status: "incomplete" });
      expect(await wallet(T1)).toMatchObject({ included_allowance: 1000, window_days: 1, daily_allowance: 0 });
    });

    it("Q-1c the same checkout, once the card goes through, gets the full paid pool", async () => {
      const tok = await seedTenant(T1);
      const paid = await subscribe(T1, "pro", tok, { status: "incomplete" });
      await deliver(realWebhook(), world.sim.updateSubscription(paid.sub.id, { status: "active" }));
      expect(await tier(T1)).toBe("pro");
      expect(await wallet(T1)).toMatchObject({ included_allowance: 96000, included_used: 0, daily_allowance: 1000 });
    });

    it("Q-2 a renewal payment fails: invoice.payment_failed writes nothing; subscription.updated→past_due keeps tier and pool (dunning grace)", async () => {
      const tok = await seedTenant(T1);
      const paid = await subscribe(T1, "growth", tok);
      const before = await wallet(T1);
      const handler = realWebhook();
      const failed = await deliver(handler, world.sim.invoicePaymentFailed(paid.sub.id));
      expect(failed.body.note).toBe("dunning-via-subscription-event");
      expect(await wallet(T1)).toEqual(before);
      const pastDue = world.sim.updateSubscription(paid.sub.id, { status: "past_due" });
      expect((await deliver(handler, pastDue)).statusCode).toBe(200);
      expect((await subRow(T1)).status).toBe("past_due");
      expect(await tier(T1)).toBe("growth");
      expect((await wallet(T1)).included_allowance).toBe(48000);
    });

    it("Q-3 the card is fixed (past_due → active): same tier, same pool, used credits kept", async () => {
      const tok = await seedTenant(T1);
      const paid = await subscribe(T1, "growth", tok);
      await wallet(T1);
      await q("update tenant_credit_balances set included_used = 1234 where tenant_id = $1", [T1]);
      const handler = realWebhook();
      await deliver(handler, world.sim.updateSubscription(paid.sub.id, { status: "past_due" }));
      await deliver(handler, world.sim.updateSubscription(paid.sub.id, { status: "active" }));
      expect(await tier(T1)).toBe("growth");
      expect(await wallet(T1)).toMatchObject({ included_allowance: 48000, included_used: 1234 });
    });

    it("Q-4 retries run out and Stripe cancels: the tenant drops to Free", async () => {
      const tok = await seedTenant(T1);
      const paid = await subscribe(T1, "pro", tok);
      const handler = realWebhook();
      await deliver(handler, world.sim.updateSubscription(paid.sub.id, { status: "past_due" }));
      await deliver(handler, world.sim.deleteSubscription(paid.sub.id, world.sim.tick(21 * DAY)));
      expect(await tier(T1)).toBe("free");
      expect(await wallet(T1)).toMatchObject({ included_allowance: 1000, window_days: 1, daily_allowance: 0 });
    });
  });

  describe("R. cancel / resume", () => {
    it("R-1 cancel at period end: still paid until the period actually ends", async () => {
      const tok = await seedTenant(T1);
      const paid = await subscribe(T1, "starter", tok);
      await deliver(realWebhook(), world.sim.updateSubscription(paid.sub.id, { cancelAtPeriodEnd: true }));
      expect((await subRow(T1)).cancel_at_period_end).toBe(true);
      expect(await tier(T1)).toBe("starter");
      expect((await wallet(T1)).included_allowance).toBe(8000);
    });

    it("R-2 resume before the period ends: the pending cancel clears, used credits kept", async () => {
      const tok = await seedTenant(T1);
      const paid = await subscribe(T1, "starter", tok);
      await wallet(T1);
      await q("update tenant_credit_balances set included_used = 2000 where tenant_id = $1", [T1]);
      const handler = realWebhook();
      await deliver(handler, world.sim.updateSubscription(paid.sub.id, { cancelAtPeriodEnd: true }));
      await deliver(handler, world.sim.updateSubscription(paid.sub.id, { cancelAtPeriodEnd: false }));
      expect((await subRow(T1)).cancel_at_period_end).toBe(false);
      expect(await tier(T1)).toBe("starter");
      expect(await wallet(T1)).toMatchObject({ included_allowance: 8000, included_used: 2000 });
    });

    it("R-3 the subscription ends: Free, one-day window, monthly usage does not follow them down", async () => {
      const tok = await seedTenant(T1);
      const paid = await subscribe(T1, "growth", tok);
      await wallet(T1);
      await q("update tenant_credit_balances set included_used = 40000 where tenant_id = $1", [T1]);
      await deliver(realWebhook(), world.sim.deleteSubscription(paid.sub.id));
      expect(await tier(T1)).toBe("free");
      expect(await wallet(T1)).toMatchObject({ included_allowance: 1000, included_used: 0, window_days: 1 });
    });

    it("R-4 resubscribe after canceling: paid again with a full pool", async () => {
      const tok = await seedTenant(T1);
      const first = await subscribe(T1, "starter", tok);
      await deliver(realWebhook(), world.sim.deleteSubscription(first.sub.id));
      expect(await tier(T1)).toBe("free");
      await subscribe(T1, "growth", tok);
      expect(await tier(T1)).toBe("growth");
      expect(await wallet(T1)).toMatchObject({ included_allowance: 48000, included_used: 0, daily_allowance: 1000 });
    });
  });

  describe("S. daily grant from config, no rollover", () => {
    it("S-1 the daily grant is read from system_config for Free AND paid, on the next read", async () => {
      const tok = await seedTenant(T1);
      await seedTenant(T2);
      await subscribe(T1, "starter", tok);
      await setConfig({ free_daily_credits: 1500 });
      expect((await wallet(T1)).daily_allowance).toBe(1500);
      expect((await wallet(T2)).included_allowance).toBe(1500);
    });

    it("S-2 with the key absent the SQL falls back to 2,000, and the TS mirror agrees", async () => {
      await seedTenant(T1);
      await q("update system_config set blob = blob - 'free_daily_credits' where id = 1");
      expect((await wallet(T1)).included_allowance).toBe(2000);
      expect(FREE_DAILY_CREDITS_SQL_FALLBACK).toBe(2000);
    });

    it("S-3 Free: 300 unused today does not roll into tomorrow (1,000, not 1,300)", async () => {
      await seedTenant(T1);
      await wallet(T1);
      await q("update tenant_credit_balances set included_used = 700 where tenant_id = $1", [T1]);
      await endFreeDay(T1);
      expect(await wallet(T1)).toMatchObject({ included_allowance: 1000, included_used: 0, window_days: 1 });
    });

    it("S-4 paid: unused daily credits reset on their own clock; the monthly pool's usage is untouched", async () => {
      const tok = await seedTenant(T1);
      await subscribe(T1, "starter", tok);
      await wallet(T1);
      await q("update tenant_credit_balances set daily_used = 400, included_used = 3000 where tenant_id = $1", [T1]);
      await endDailyWindow(T1);
      expect(await wallet(T1)).toMatchObject({ daily_allowance: 1000, daily_used: 0, included_used: 3000 });
    });

    it("S-5 paid: 5,000 unused monthly credits do not roll into the next period (8,000, not 13,000)", async () => {
      const tok = await seedTenant(T1);
      await subscribe(T1, "starter", tok);
      await wallet(T1);
      await q("update tenant_credit_balances set included_used = 3000 where tenant_id = $1", [T1]);
      await endMonthlyWindow(T1);
      expect(await wallet(T1)).toMatchObject({ included_allowance: 8000, included_used: 0 });
    });

    it("S-6 bought top-up credits DO survive both the daily and the monthly reset", async () => {
      const tok = await seedTenant(T1);
      await subscribe(T1, "starter", tok);
      await wallet(T1);
      await q("update tenant_credit_balances set purchased_balance = 4000 where tenant_id = $1", [T1]);
      await endDailyWindow(T1);
      await endMonthlyWindow(T1);
      expect((await wallet(T1)).purchased_balance).toBe(4000);
    });
  });

  describe("U. one-time credits", () => {
    async function buyPack(token: string, usd: number) {
      const res = await callRoute(billingTopup, { token, body: { usd } });
      expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
      return world.sim.completeTopupCheckout(world.stripe.lastSession().id);
    }

    it("U-1 a Free tenant buys a $20 pack: credits land once, however often Stripe redelivers", async () => {
      const tok = await seedTenant(T1);
      const paid = await buyPack(tok, 20);
      const handler = realWebhook();
      for (let i = 0; i < 3; i++) expect((await deliver(handler, paid.event)).statusCode).toBe(200);
      const granted = (await wallet(T1)).purchased_balance;
      expect(granted).toBeGreaterThan(0);
      const ledger = await q("select amount from tenant_credit_ledger where tenant_id = $1 and kind = 'topup'", [T1]);
      expect(ledger).toHaveLength(1);
      expect(Number(ledger[0].amount)).toBe(granted);
    });

    it("U-2 the grant RPC refuses zero or negative credits", async () => {
      await seedTenant(T1);
      for (const n of [0, -5]) {
        const err = await pgError(() => q("select apply_credit_topup($1, $2, 'pi_bad', 'evt_bad')", [T1, n]));
        expect(err).toMatch(/positive credits/);
      }
    });

    it("U-3 refunded before the grant lands: tombstoned, and the late grant is refused", async () => {
      const tok = await seedTenant(T1);
      const paid = await buyPack(tok, 20);
      const handler = realWebhook();
      expect((await deliver(handler, world.sim.refund(paid.chargeId))).body.note).toBe("topup-tombstoned");
      await deliver(handler, paid.event);
      expect((await wallet(T1)).purchased_balance).toBe(0);
    });

    it("U-4 refunded after some were spent: the full pack is clawed back and the balance goes negative (debt, not free credits)", async () => {
      const tok = await seedTenant(T1);
      const paid = await buyPack(tok, 20);
      const handler = realWebhook();
      await deliver(handler, paid.event);
      const granted = (await wallet(T1)).purchased_balance;
      await q("update tenant_credit_balances set purchased_balance = purchased_balance - 3000 where tenant_id = $1", [T1]);
      expect((await deliver(handler, world.sim.refund(paid.chargeId))).body.note).toBe("topup-revoked");
      expect((await wallet(T1)).purchased_balance).toBe(granted - 3000 - granted);
    });
  });

  describe("V. spending", () => {
    it("V-1 a successful run draws daily first, then monthly, then top-up, and never below zero", async () => {
      const tok = await seedTenant(T1);
      await subscribe(T1, "starter", tok);
      await wallet(T1);
      await q(
        "update tenant_credit_balances set daily_used = 900, included_used = 7800, purchased_balance = 500 where tenant_id = $1",
        [T1],
      );
      const run = await startRun(T1, "operator");
      await finishRun(run, "success", 3.0);
      const w = await wallet(T1);
      expect(w).toMatchObject({ daily_used: 1000, included_used: 8000, purchased_balance: 0, reserved: 0 });
      const [settle] = await q("select amount, debited, source from tenant_credit_ledger where run_id = $1 and kind = 'settle'", [run]);
      expect(settle).toMatchObject({ amount: 1200, debited: 800, source: "mixed" });
    });

    it.each(["error", "failed", "cancelled", "parse_failed", "dispatch_error"])(
      "V-2 a run that ends %s charges nothing and releases its hold",
      async (status) => {
        const tok = await seedTenant(T1);
        await subscribe(T1, "starter", tok);
        const run = await startRun(T1, "operator");
        expect((await wallet(T1)).reserved).toBeGreaterThan(0);
        await finishRun(run, status, 2.5);
        expect(await wallet(T1)).toMatchObject({ reserved: 0, included_used: 0, daily_used: 0 });
      },
    );

    it("V-3 a Free tenant with nothing left cannot start a run (insufficient_credits)", async () => {
      await seedTenant(T1);
      await wallet(T1);
      await q("update tenant_credit_balances set included_used = 1000 where tenant_id = $1", [T1]);
      expect(await pgError(() => startRun(T1, "operator"))).toMatch(/insufficient_credits/);
    });

    it("V-4 finishing the same run twice charges once", async () => {
      const tok = await seedTenant(T1);
      await subscribe(T1, "starter", tok);
      const run = await startRun(T1, "operator");
      await finishRun(run, "success", 1.0);
      const [r] = await q<{ o: string }>("select finalize_run_credits($1, 1.0, 'success') as o", [run]);
      expect(r.o).toBe("noop");
      expect((await wallet(T1)).daily_used).toBe(400);
    });
  });

  describe("W. tier gates", () => {
    it("W-1 gate ON: Free runs chat agents only; Starter adds channels; Pro unlocks the rest; an unmapped agent needs Pro", async () => {
      await setConfig({ tier_gate_enforced: true });
      const tok = await seedTenant(T1);
      const allowed = async (slug: string) => (await pgError(() => startRun(T1, slug))) === null;
      const blocked = async (slug: string) => (await pgError(() => startRun(T1, slug))) ?? "";

      expect(await allowed("operator")).toBe(true);
      expect(await blocked("ugc")).toMatch(/plan_upgrade_required/);
      expect(await blocked("engineer")).toMatch(/plan_upgrade_required/);
      expect((await q<{ t: string }>("select _tier_required('an-agent-nobody-mapped') as t"))[0].t).toBe("pro");

      const paid = await subscribe(T1, "starter", tok);
      expect(await allowed("ugc")).toBe(true);
      expect(await blocked("engineer")).toMatch(/plan_upgrade_required/);

      await deliver(realWebhook(), world.sim.updateSubscription(paid.sub.id, { priceId: PRICE_IDS.pro.monthly }));
      expect(await allowed("engineer")).toBe(true);
    });

    it("W-2 gate OFF: channels and always-Pro agents are still gated for Free; chat agents are open", async () => {
      await seedTenant(T1);
      expect(await pgError(() => startRun(T1, "instagram_organic"))).toMatch(/plan_upgrade_required/);
      expect(await pgError(() => startRun(T1, "engineer"))).toMatch(/plan_upgrade_required/);
      expect(await pgError(() => startRun(T1, "operator"))).toBeNull();
    });

    it("W-3 past_due keeps the gate open at the paid tier; canceling closes it", async () => {
      await setConfig({ tier_gate_enforced: true });
      const tok = await seedTenant(T1);
      const paid = await subscribe(T1, "starter", tok);
      const handler = realWebhook();
      await deliver(handler, world.sim.updateSubscription(paid.sub.id, { status: "past_due" }));
      expect(await pgError(() => startRun(T1, "ugc"))).toBeNull();
      await deliver(handler, world.sim.deleteSubscription(paid.sub.id));
      expect(await pgError(() => startRun(T1, "ugc"))).toMatch(/plan_upgrade_required/);
    });
  });

  describe("X. fixed gaps", () => {
    it("X-1 after a downgrade below what was already used, bought credits and the daily grant still work, and the monthly pool is not overdrawn further", async () => {
      const tok = await seedTenant(T1);
      const paid = await subscribe(T1, "growth", tok);
      await wallet(T1);
      await q("update tenant_credit_balances set included_used = 40000, purchased_balance = 5000 where tenant_id = $1", [T1]);
      await deliver(realWebhook(), world.sim.updateSubscription(paid.sub.id, { priceId: PRICE_IDS.starter.monthly }));
      const run = await startRun(T1, "operator");
      await finishRun(run, "success", 3.0);
      expect(await wallet(T1)).toMatchObject({
        included_allowance: 8000, included_used: 40000, daily_used: 1000, purchased_balance: 4800, reserved: 0,
      });
    });

    it("X-2 the same tenant with nothing but an overdrawn monthly pool is still refused", async () => {
      const tok = await seedTenant(T1);
      const paid = await subscribe(T1, "growth", tok);
      await wallet(T1);
      await q("update tenant_credit_balances set included_used = 40000, daily_used = 1000 where tenant_id = $1", [T1]);
      await deliver(realWebhook(), world.sim.updateSubscription(paid.sub.id, { priceId: PRICE_IDS.starter.monthly }));
      expect(await pgError(() => startRun(T1, "operator"))).toMatch(/insufficient_credits/);
    });

    it.each([["1,000"], [1000.5], ["abc"], [-5], [0], [99999999999], [null]])(
      "X-3 free_daily_credits = %j cannot break a Free wallet: it falls back to 2,000",
      async (bad) => {
        await seedTenant(T1);
        await setConfig({ free_daily_credits: bad });
        expect(await pgError(() => wallet(T1))).toBeNull();
        expect((await wallet(T1)).included_allowance).toBe(2000);
        expect(await pgError(() => startRun(T1, "operator"))).toBeNull();
      },
    );

    it("X-4 a digit string is still read, as Postgres ->> returns it", async () => {
      await seedTenant(T1);
      await setConfig({ free_daily_credits: "2500" });
      expect((await wallet(T1)).included_allowance).toBe(2500);
    });
  });
});
