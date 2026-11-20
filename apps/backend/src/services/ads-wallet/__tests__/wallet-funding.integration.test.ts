import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type Stripe from "stripe";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

const T = "00000000-0000-4000-8000-0000000000a1";
const ORDER = "00000000-0000-4000-8000-0000000000b1";
const s = vi.hoisted(() => ({ db: null as unknown as PGlite, retrieve: vi.fn(), sessionsList: vi.fn(), sessionsCreate: vi.fn(), refunds: vi.fn(), disputes: vi.fn(), resume: vi.fn(), piCreate: vi.fn(), piCancel: vi.fn(), piList: vi.fn(), consent: vi.fn(), tier: vi.fn(), lock: vi.fn() }));
vi.mock("@/services/ads-wallet/consent", () => ({ sharedWalletConsent: s.consent }));
vi.mock("@/services/agents/entitlement", () => ({ checkAgentTier: s.tier }));
vi.mock("@/services/channels/lock", () => ({ isChannelLockedStrict: s.lock }));

vi.mock("@/services/ads-wallet/stripe-client", () => {
  const stripe = { checkout: { sessions: { list: s.sessionsList, create: s.sessionsCreate } }, paymentIntents: { retrieve: s.retrieve, create: s.piCreate, cancel: s.piCancel, list: s.piList }, refunds: { list: s.refunds }, disputes: { list: s.disputes }, customers: { create: vi.fn() } };
  return { adsStripe: () => stripe, requireAdsStripe: () => stripe };
});
vi.mock("@/services/ads-wallet/plan-funding", () => ({ resumeFundedPlans: s.resume }));
vi.mock("@/services/tenant-client", () => {
  const from = (table: string) => {
    const where: Array<[string, unknown, boolean?]> = [];
    let patch: Record<string, unknown> | null = null;
    let insertRow: Record<string, unknown> | null = null;
    let upsertRow: Record<string, unknown> | null = null;
    const run = async (one: boolean) => {
      const params: unknown[] = [];
      const cond = where.map(([k, v, any]) => { params.push(v); return any ? `${k}=any($${params.length})` : `${k}=$${params.length}`; }).join(" and ");
      try {
        if (upsertRow) { await s.db.query(`insert into ${table}(tenant_id) values ($1) on conflict do nothing`, [upsertRow.tenant_id]); return { data: null, error: null }; }
        if (insertRow) { const keys = Object.keys(insertRow); await s.db.query(`insert into ${table}(${keys.join(",")}) values (${keys.map((_, i) => `$${i + 1}`).join(",")})`, Object.values(insertRow)); return { data: null, error: null }; }
        if (patch) { const keys = Object.keys(patch); const base = params.length; const r = await s.db.query(`update ${table} set ${keys.map((k, i) => `${k}=$${base + i + 1}`).join(",")} where ${cond} returning *`, [...params, ...Object.values(patch)]); return { data: r.rows, error: null }; }
        const r = await s.db.query<Record<string, unknown>>(`select * from ${table}${cond ? ` where ${cond}` : ""}`, params);
        return { data: one ? r.rows[0] ?? null : r.rows, error: null };
      } catch (error) { return { data: null, error }; }
    };
    const chain: Record<string, unknown> = {
      select: () => chain, eq: (k: string, v: unknown) => { where.push([k, v]); return chain; },
      in: (k: string, v: unknown[]) => { where.push([k, v, true]); return chain; },
      is: () => chain, update: (v: Record<string, unknown>) => { patch = v; return chain; },
      insert: (v: Record<string, unknown>) => { insertRow = v; return chain; }, upsert: (v: Record<string, unknown>) => { upsertRow = v; return chain; },
      single: () => run(true), maybeSingle: () => run(true),
      then: (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => run(false).then(ok, bad),
    };
    return chain;
  };
  return {
    asTenantId: (t: string) => t,
    tenantClient: () => ({ from }),
    tenantRpc: vi.fn(),
    resolveAdsWalletOrderTenant: async (id: string) => (await s.db.query<{ tenant_id: string }>("select tenant_id from ads_wallet_orders where id=$1", [id])).rows[0].tenant_id,
    applyAdsWalletPayment: async (_t: string, a: { p_order_id: string; p_payment_intent_id: string; p_net_cents: number; p_event_created: number }) => {
      try { await s.db.query("select ads_wallet_apply_payment($1,$2,$3,$4)", [a.p_order_id, a.p_payment_intent_id, a.p_net_cents, a.p_event_created]); return { data: null, error: null }; }
      catch (error) { return { data: null, error }; }
    },
  };
});

import { applyWalletEvent, ensureRefillEntitlement, REFILL_APPROVAL_MESSAGE, REFILL_DECLINED_MESSAGE, REFILL_PAUSED_MESSAGE, REFILL_PLAN_MESSAGE, REFILL_UNFINISHED_MESSAGE, refillWallet, startFunding } from "../wallet";
import { tenantRpc } from "@/services/tenant-client";
import { refillEligibility } from "../providers";

const migration = (f: string) => readFileSync(resolve("../../supabase/migrations", f), "utf8");
const event = (type: string, object: unknown, created = 100) => ({ type, data: { object }, created }) as Stripe.Event;
const balance = async () => Number((await s.db.query<{ b: string }>("select balance_cents as b from ads_wallets where tenant_id=$1", [T])).rows[0].b);
const eurIntent = { id: "pi_eur", customer: "cus1", status: "succeeded", currency: "eur", amount: 9260, amount_received: 9260, metadata: { kind: "chatgpt_ads_wallet", order_id: ORDER }, latest_charge: { id: "ch1", disputed: false, amount_refunded: 0 } };
const eurSession = { id: "cs1", mode: "payment", payment_intent: "pi_eur", currency: "eur", amount_total: 9260, metadata: { kind: "chatgpt_ads_wallet", order_id: ORDER }, currency_conversion: { source_currency: "usd", amount_total: 10000, amount_subtotal: 10000, fx_rate: "0.926" } };

beforeAll(async () => {
  s.db = new PGlite();
  await s.db.exec("create role anon; create role authenticated; create role service_role; create table tenants(id uuid primary key);");
  for (const f of ["20260924183000_chatgpt_ads_wallet.sql", "20260925083000_chatgpt_ads_wallet_controls.sql"]) await s.db.exec(migration(f));
}, 20_000);
afterAll(async () => { await s.db?.close(); });
beforeEach(async () => {
  vi.resetAllMocks();
  vi.stubEnv("CHATGPT_ADS_FUNDING_ENABLED", "true"); vi.stubEnv("STRIPE_ADS_WEBHOOK_SECRET", "whsec_test");
  await s.db.exec("delete from ads_wallet_orders; delete from ads_wallets; delete from tenants;");
  await s.db.query("insert into tenants values ($1)", [T]);
  await s.db.query("insert into ads_wallets(tenant_id, stripe_customer_id) values ($1,'cus1')", [T]);
  await s.db.query("insert into ads_wallet_orders(id, tenant_id, kind, amount_cents) values ($1,$2,'topup',10000)", [ORDER, T]);
  s.retrieve.mockResolvedValue(structuredClone(eurIntent));
  s.sessionsList.mockResolvedValue({ data: [structuredClone(eurSession)], has_more: false });
  s.refunds.mockResolvedValue({ data: [], has_more: false });
  s.disputes.mockResolvedValue({ data: [], has_more: false });
});

it("credits exactly the intended $100 once when Adaptive Pricing charged the card in EUR, and a replayed webhook adds nothing", async () => {
  await applyWalletEvent(event("payment_intent.succeeded", { id: "pi_eur" }));
  expect(await balance()).toBe(10000);
  await applyWalletEvent(event("payment_intent.succeeded", { id: "pi_eur" }));
  await applyWalletEvent(event("payment_intent.succeeded", { id: "pi_eur" }, 101));
  expect(await balance()).toBe(10000);
  const o = (await s.db.query<Record<string, unknown>>("select status, credited_cents, payment_intent_id from ads_wallet_orders where id=$1", [ORDER])).rows[0];
  expect(o).toEqual({ status: "paid", credited_cents: 10000, payment_intent_id: "pi_eur" });
  expect(s.sessionsList).toHaveBeenCalledWith({ payment_intent: "pi_eur", limit: 10 });
  expect(s.resume).toHaveBeenCalledWith(T, ORDER);
});

it("takes a EUR partial refund off in proportion, in USD, never over-crediting", async () => {
  await applyWalletEvent(event("payment_intent.succeeded", { id: "pi_eur" }));
  s.retrieve.mockResolvedValue({ ...structuredClone(eurIntent), latest_charge: { id: "ch1", disputed: false, amount_refunded: 2315 } });
  s.refunds.mockResolvedValue({ data: [{ id: "re1", amount: 2315, currency: "eur", status: "succeeded" }], has_more: false });
  await applyWalletEvent(event("charge.refunded", { payment_intent: "pi_eur" }, 200));
  expect(await balance()).toBe(7500);
});

it("refuses a non-USD payment whose Checkout session did not convert this order's exact USD amount", async () => {
  s.sessionsList.mockResolvedValue({ data: [{ ...structuredClone(eurSession), currency_conversion: { ...eurSession.currency_conversion, amount_total: 1000 } }], has_more: false });
  await expect(applyWalletEvent(event("payment_intent.succeeded", { id: "pi_eur" }))).rejects.toThrow("does not match");
  s.sessionsList.mockResolvedValue({ data: [{ ...structuredClone(eurSession), metadata: { kind: "chatgpt_ads_wallet", order_id: "00000000-0000-4000-8000-0000000000ff" } }], has_more: false });
  await expect(applyWalletEvent(event("payment_intent.succeeded", { id: "pi_eur" }))).rejects.toThrow("does not match");
  s.sessionsList.mockResolvedValue({ data: [], has_more: false });
  await expect(applyWalletEvent(event("payment_intent.succeeded", { id: "pi_eur" }))).rejects.toThrow("does not match");
  expect(await balance()).toBe(0);
});

it("opens new top-up Checkout sessions in USD with Adaptive Pricing off", async () => {
  await s.db.exec("delete from ads_wallet_orders");
  s.sessionsCreate.mockResolvedValue({ url: "https://checkout.example/s" });
  await startFunding(T, "00000000-0000-4000-8000-0000000000c1", 10000, "topup", ORDER);
  expect(s.sessionsCreate.mock.calls[0][0]).toMatchObject({ mode: "payment", adaptive_pricing: { enabled: false } });
});

const walletState = async () => (await s.db.query<Record<string, unknown>>("select auto_refill_enabled, setup_request_id, last_error from ads_wallets where tenant_id=$1", [T])).rows[0];
const linkedinOnly = (lockedSlugs: string[]) => {
  s.tier.mockImplementation(async (_t: string, channel: string) => ({ allowed: channel === "linkedin_ads", enforced: true }));
  s.lock.mockImplementation(async (slug: string) => lockedSlugs.includes(slug));
};

it("pauses a LinkedIn-only tenant's auto-refill during a global LinkedIn lock, tells the founder, and resumes it untouched once the lock lifts", async () => {
  vi.stubEnv("ADS_LINKEDIN_MANAGED_ENABLED", "true"); vi.stubEnv("ADS_LINKEDIN_ROLLOUT_ACK", "campaign-bindings-forward-only");
  s.consent.mockResolvedValue(true);
  await s.db.query("update ads_wallets set auto_refill_enabled=true, setup_request_id=$2, payment_method_id='pm1' where tenant_id=$1", [T, ORDER]);
  linkedinOnly(["linkedin_ads"]);
  expect(await refillEligibility(T)).toBe("paused");
  expect(await ensureRefillEntitlement(T)).toBe(false);
  expect(await ensureRefillEntitlement(T)).toBe(false);
  expect(await walletState()).toEqual({ auto_refill_enabled: true, setup_request_id: ORDER, last_error: REFILL_PAUSED_MESSAGE });
  linkedinOnly([]);
  expect(await ensureRefillEntitlement(T)).toBe(true);
  expect(await walletState()).toEqual({ auto_refill_enabled: true, setup_request_id: ORDER, last_error: null });
});

it("pauses rather than disables auto-refill while the managed LinkedIn rollout flag is off, and resumes when it is back", async () => {
  s.consent.mockResolvedValue(true);
  await s.db.query("update ads_wallets set auto_refill_enabled=true, payment_method_id='pm1' where tenant_id=$1", [T]);
  linkedinOnly([]);
  vi.stubEnv("ADS_LINKEDIN_MANAGED_ENABLED", "false");
  expect(await ensureRefillEntitlement(T)).toBe(false);
  expect(await walletState()).toMatchObject({ auto_refill_enabled: true, last_error: REFILL_PAUSED_MESSAGE });
  vi.stubEnv("ADS_LINKEDIN_MANAGED_ENABLED", "true"); vi.stubEnv("ADS_LINKEDIN_ROLLOUT_ACK", "campaign-bindings-forward-only");
  expect(await ensureRefillEntitlement(T)).toBe(true);
  expect(await walletState()).toMatchObject({ auto_refill_enabled: true, last_error: null });
});

it("still switches auto-refill off for good when the tenant itself withdrew the shared-wallet permission, and never overwrites another wallet error with the pause notice", async () => {
  vi.stubEnv("ADS_LINKEDIN_MANAGED_ENABLED", "true"); vi.stubEnv("ADS_LINKEDIN_ROLLOUT_ACK", "campaign-bindings-forward-only");
  await s.db.query("update ads_wallets set auto_refill_enabled=true, setup_request_id=$2, last_error='Auto-refill was declined by your card.' where tenant_id=$1", [T, ORDER]);
  linkedinOnly([]);
  s.consent.mockResolvedValue(false);
  expect(await ensureRefillEntitlement(T)).toBe(false);
  expect(await walletState()).toEqual({ auto_refill_enabled: false, setup_request_id: null, last_error: "Auto-refill was declined by your card." });
  s.consent.mockResolvedValue(true);
  linkedinOnly(["linkedin_ads"]);
  expect(await ensureRefillEntitlement(T)).toBe(false);
  expect(await walletState()).toMatchObject({ auto_refill_enabled: false, last_error: "Auto-refill was declined by your card." });
});

const belowPro = () => {
  s.tier.mockResolvedValue({ allowed: false, enforced: true, tier: "growth", required_tier: "pro" });
  s.lock.mockResolvedValue(false);
};
const backOnPro = () => {
  s.tier.mockResolvedValue({ allowed: true, enforced: true, tier: "pro", required_tier: "pro" });
  s.lock.mockResolvedValue(false);
};

it("a LinkedIn wallet tenant that drops below Pro has auto-refill paused, not switched off: the founder is told, the card is not charged, and refill resumes on the upgrade", async () => {
  vi.stubEnv("ADS_LINKEDIN_MANAGED_ENABLED", "true"); vi.stubEnv("ADS_LINKEDIN_ROLLOUT_ACK", "campaign-bindings-forward-only");
  s.consent.mockResolvedValue(true);
  await s.db.query("update ads_wallets set auto_refill_enabled=true, setup_request_id=$2, payment_method_id='pm1' where tenant_id=$1", [T, ORDER]);
  belowPro();
  expect(await refillEligibility(T)).toBe("below_plan");
  expect(await ensureRefillEntitlement(T)).toBe(false);
  expect(await walletState()).toEqual({ auto_refill_enabled: true, setup_request_id: ORDER, last_error: REFILL_PLAN_MESSAGE });
  await refillWallet(T);
  expect(s.piCreate).not.toHaveBeenCalled();
  expect((await s.db.query("select count(*)::int as n from ads_wallet_orders where kind='refill'")).rows[0]).toEqual({ n: 0 });
  expect(await walletState()).toMatchObject({ auto_refill_enabled: true, last_error: REFILL_PLAN_MESSAGE });
  backOnPro();
  expect(await ensureRefillEntitlement(T)).toBe(true);
  expect(await walletState()).toEqual({ auto_refill_enabled: true, setup_request_id: ORDER, last_error: null });
});

it("below Pro never writes the plan notice over a refill the founder or a declined card already switched off", async () => {
  vi.stubEnv("ADS_LINKEDIN_MANAGED_ENABLED", "true"); vi.stubEnv("ADS_LINKEDIN_ROLLOUT_ACK", "campaign-bindings-forward-only");
  s.consent.mockResolvedValue(true);
  await s.db.query("update ads_wallets set auto_refill_enabled=false, last_error=$2 where tenant_id=$1", [T, REFILL_DECLINED_MESSAGE]);
  belowPro();
  expect(await ensureRefillEntitlement(T)).toBe(false);
  expect(await walletState()).toMatchObject({ auto_refill_enabled: false, last_error: REFILL_DECLINED_MESSAGE });
  backOnPro();
  expect(await ensureRefillEntitlement(T)).toBe(true);
  expect(await walletState()).toMatchObject({ auto_refill_enabled: false, last_error: REFILL_DECLINED_MESSAGE });
});

it("a ChatGPT-only wallet without the shared LinkedIn wallet still has auto-refill switched off below Pro, as before", async () => {
  s.consent.mockResolvedValue(false);
  await s.db.query("update ads_wallets set auto_refill_enabled=true, setup_request_id=$2, payment_method_id='pm1' where tenant_id=$1", [T, ORDER]);
  belowPro();
  expect(await refillEligibility(T)).toBe("denied");
  expect(await ensureRefillEntitlement(T)).toBe(false);
  expect(await walletState()).toEqual({ auto_refill_enabled: false, setup_request_id: null, last_error: null });
});

const lastError = async () => (await s.db.query<{ e: string | null }>("select last_error as e from ads_wallets where tenant_id=$1", [T])).rows[0].e;
it.each([REFILL_DECLINED_MESSAGE, REFILL_UNFINISHED_MESSAGE])("a credited manual top-up clears the auto-refill error the founder already acted on: %s", async (message) => {
  await s.db.query("update ads_wallets set last_error=$2 where tenant_id=$1", [T, message]);
  await applyWalletEvent(event("payment_intent.succeeded", { id: "pi_eur" }));
  expect(await balance()).toBe(10000);
  expect(await lastError()).toBeNull();
});
it("a manual top-up leaves the payment-review and daily-limit messages, and a refill's own payment leaves a decline", async () => {
  const review = "A refill needs payment review. No further automatic charges will be attempted.";
  await s.db.query("update ads_wallets set last_error=$2 where tenant_id=$1", [T, review]);
  await applyWalletEvent(event("payment_intent.succeeded", { id: "pi_eur" }));
  expect(await lastError()).toBe(review);
  await s.db.exec("delete from ads_wallet_orders");
  await s.db.query("insert into ads_wallet_orders(id, tenant_id, kind, amount_cents) values ($1,$2,'refill',10000)", [ORDER, T]);
  await s.db.query("update ads_wallets set last_error=$2 where tenant_id=$1", [T, REFILL_DECLINED_MESSAGE]);
  s.retrieve.mockResolvedValue({ ...structuredClone(eurIntent), currency: "usd", amount: 10000, amount_received: 10000 });
  await applyWalletEvent(event("payment_intent.succeeded", { id: "pi_eur" }, 300));
  expect(await lastError()).toBe(REFILL_DECLINED_MESSAGE);
});

const OLD = "00000000-0000-4000-8000-0000000000d1";
const stuckWallet = async (balanceCents: number) => {
  vi.stubEnv("ADS_LINKEDIN_MANAGED_ENABLED", "true"); vi.stubEnv("ADS_LINKEDIN_ROLLOUT_ACK", "campaign-bindings-forward-only");
  s.consent.mockResolvedValue(true);
  linkedinOnly([]);
  vi.mocked(tenantRpc).mockImplementation((async (_t: string, name: string, args: Record<string, unknown>) => {
    if (name !== "ads_wallet_claim_refill") return { data: null, error: null };
    const r = await s.db.query<{ id: string | null }>("select ads_wallet_claim_refill($1) as id", [args.p_tenant_id]);
    return { data: r.rows[0].id, error: null };
  }) as never);
  await s.db.exec("delete from ads_wallet_orders");
  await s.db.query("insert into ads_wallet_orders(id, tenant_id, kind, amount_cents, refill_day, payment_intent_id) values ($1,$2,'refill',10000,(now() at time zone 'UTC')::date,'pi_old')", [OLD, T]);
  await s.db.query("update ads_wallets set auto_refill_enabled=true, payment_method_id='pm_new', balance_cents=$2, pending_refill_id=$3, last_error=null where tenant_id=$1", [T, balanceCents, OLD]);
  s.retrieve.mockImplementation(async (id: string) => ({ id, status: id === "pi_old" ? "requires_action" : "processing", metadata: { kind: "chatgpt_ads_wallet", order_id: OLD } }));
  s.piCancel.mockResolvedValue({ id: "pi_old", status: "canceled" });
  s.piCreate.mockResolvedValue({ id: "pi_new", status: "processing" });
};
const walletRefill = async () => (await s.db.query<Record<string, unknown>>("select pending_refill_id, auto_refill_enabled from ads_wallets where tenant_id=$1", [T])).rows[0];
it("re-enabled with a new card while the balance is well above the threshold: the stuck 3-D Secure refill is cancelled and released, and the card is not charged", async () => {
  await stuckWallet(50000);
  await refillWallet(T);
  expect(s.piCancel).toHaveBeenCalledWith("pi_old");
  expect(s.piCreate).not.toHaveBeenCalled();
  expect(await walletRefill()).toEqual({ pending_refill_id: null, auto_refill_enabled: true });
  expect((await s.db.query("select status from ads_wallet_orders where id=$1", [OLD])).rows[0]).toEqual({ status: "failed" });
});
it("re-enabled with a new card and a low balance: one fresh refill on the new card, never a replay of the stuck order", async () => {
  await stuckWallet(1000);
  await refillWallet(T);
  expect(s.piCreate).toHaveBeenCalledTimes(1);
  const [params, opts] = s.piCreate.mock.calls[0];
  expect(params).toMatchObject({ payment_method: "pm_new", amount: 10000 });
  expect(opts.idempotencyKey).not.toBe(`ads_refill_${OLD}`);
  const state = await walletRefill();
  expect(state.auto_refill_enabled).toBe(true);
  expect(state.pending_refill_id).not.toBe(OLD);
  await refillWallet(T);
  expect(s.piCreate).toHaveBeenCalledTimes(1);
});
it("a stuck refill whose charge is still processing at Stripe is never released or re-charged, so a later success still credits it", async () => {
  await stuckWallet(1000);
  s.retrieve.mockImplementation(async (id: string) => ({ id, status: "processing", metadata: { kind: "chatgpt_ads_wallet", order_id: OLD } }));
  await refillWallet(T);
  expect(s.piCreate).not.toHaveBeenCalled(); expect(s.piCancel).not.toHaveBeenCalled();
  expect(await walletRefill()).toEqual({ pending_refill_id: OLD, auto_refill_enabled: true });
  s.retrieve.mockResolvedValue({ id: "pi_old", customer: "cus1", status: "succeeded", currency: "usd", amount: 10000, amount_received: 10000, metadata: { kind: "chatgpt_ads_wallet", order_id: OLD }, latest_charge: { id: "ch_old", disputed: false, amount_refunded: 0 } });
  await applyWalletEvent(event("payment_intent.succeeded", { id: "pi_old" }, 400));
  expect(await balance()).toBe(11000);
  expect(await walletRefill()).toEqual({ pending_refill_id: null, auto_refill_enabled: true });
});

const freshRefill = async () => {
  await stuckWallet(1000);
  await s.db.exec("delete from ads_wallet_orders");
  await s.db.query("update ads_wallets set pending_refill_id=null where tenant_id=$1", [T]);
};
const orders = async () => (await s.db.query<{ status: string; payment_intent_id: string | null }>("select status, payment_intent_id from ads_wallet_orders where kind='refill'")).rows;
const fullWallet = async () => (await s.db.query<Record<string, unknown>>("select auto_refill_enabled, pending_refill_id, last_error, balance_cents from ads_wallets where tenant_id=$1", [T])).rows[0];
it("a storage error after the refill charge went through keeps auto-refill on, never charges again, and the webhook still credits it", async () => {
  await freshRefill();
  s.piCreate.mockResolvedValue({ id: "pi_ok", status: "succeeded" });
  await s.db.exec(`create or replace function fail_pi_write() returns trigger language plpgsql as $$ begin if new.payment_intent_id='pi_ok' and old.payment_intent_id is null then raise exception 'storage down'; end if; return new; end $$;
    create trigger fail_pi_write before update on ads_wallet_orders for each row execute function fail_pi_write();`);
  try {
    await expect(refillWallet(T)).rejects.toThrow("Ads wallet storage is unavailable");
    expect(s.piCreate).toHaveBeenCalledTimes(1);
    const w = await fullWallet();
    expect(w).toMatchObject({ auto_refill_enabled: true, last_error: null });
    expect(w.pending_refill_id).toBeTruthy();
    expect(await orders()).toEqual([{ status: "pending", payment_intent_id: null }]);
    await refillWallet(T);
    expect(s.piCreate).toHaveBeenCalledTimes(1);
    expect(s.piCancel).not.toHaveBeenCalled();
    expect(await fullWallet()).toMatchObject({ auto_refill_enabled: true, pending_refill_id: w.pending_refill_id });
  } finally { await s.db.exec("drop trigger fail_pi_write on ads_wallet_orders"); }
  const orderId = (await fullWallet()).pending_refill_id as string;
  s.retrieve.mockResolvedValue({ id: "pi_ok", customer: "cus1", status: "succeeded", currency: "usd", amount: 10000, amount_received: 10000, metadata: { kind: "chatgpt_ads_wallet", order_id: orderId }, latest_charge: { id: "ch_ok", disputed: false, amount_refunded: 0 } });
  await applyWalletEvent(event("payment_intent.succeeded", { id: "pi_ok" }, 500));
  expect(await fullWallet()).toMatchObject({ auto_refill_enabled: true, pending_refill_id: null, last_error: null, balance_cents: 11000 });
});
it("a storage error before any charge keeps auto-refill on and leaves the refill to be settled, not reviewed", async () => {
  await freshRefill();
  const spy = vi.spyOn(await import("../providers"), "refillEligibility");
  spy.mockResolvedValueOnce("allowed").mockRejectedValueOnce(new Error("Ads wallet storage is unavailable"));
  try { await expect(refillWallet(T)).rejects.toThrow("Ads wallet storage is unavailable"); } finally { spy.mockRestore(); }
  expect(s.piCreate).not.toHaveBeenCalled();
  expect(await fullWallet()).toMatchObject({ auto_refill_enabled: true, last_error: null });
  expect(await orders()).toEqual([{ status: "pending", payment_intent_id: null }]);
});
it.each([
  ["Stripe's authentication_required decline", () => s.piCreate.mockRejectedValue(Object.assign(new Error("This payment requires authentication."), { type: "StripeCardError", code: "authentication_required", decline_code: "authentication_required", payment_intent: { id: "pi_auth", status: "requires_payment_method" } }))],
  ["a refill left waiting for the bank (requires_action)", () => s.piCreate.mockResolvedValue({ id: "pi_auth", status: "requires_action" })],
])("%s asks the founder to approve with the bank, never says the card was declined, and charges nothing", async (_name, arrange) => {
  await freshRefill();
  arrange();
  s.piCancel.mockResolvedValue({ id: "pi_auth", status: "canceled" });
  await refillWallet(T);
  const w = await fullWallet();
  expect(w).toMatchObject({ auto_refill_enabled: false, pending_refill_id: null, last_error: REFILL_APPROVAL_MESSAGE, balance_cents: 1000 });
  expect(String(w.last_error)).not.toMatch(/declined/);
  expect(REFILL_APPROVAL_MESSAGE).toMatch(/approve/);
  expect(REFILL_APPROVAL_MESSAGE).toMatch(/Add balance/);
  expect((await orders()).map(o => o.status)).toEqual(["failed"]);
  if (s.piCreate.mock.results[0]?.type === "return" && (await s.piCreate.mock.results[0].value).status === "requires_action") expect(s.piCancel).toHaveBeenCalledWith("pi_auth");
  await refillWallet(T);
  expect(s.piCreate).toHaveBeenCalledTimes(1);
});
it("a real card decline still turns auto-refill off with the decline message", async () => {
  await freshRefill();
  s.piCreate.mockRejectedValue(Object.assign(new Error("Your card was declined."), { type: "StripeCardError", code: "card_declined", decline_code: "insufficient_funds", payment_intent: { id: "pi_dec", status: "requires_payment_method" } }));
  await refillWallet(T);
  expect(await fullWallet()).toMatchObject({ auto_refill_enabled: false, pending_refill_id: null, last_error: REFILL_DECLINED_MESSAGE });
  expect((await orders()).map(o => o.status)).toEqual(["failed"]);
});
