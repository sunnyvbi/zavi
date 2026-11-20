
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
import type { PaidTier } from "@/services/billing/tiers";
import { installBillingEnv, resetWorld, world } from "./_world";
import { callRoute, deliver, expectNoWrites, journeyWebhook, subscribe, T1 } from "./_harness";

const BASE = "https://www.zaviagent.com";
let restoreEnv: () => void;

beforeEach(() => {
  resetWorld();
  restoreEnv = installBillingEnv();
});
afterEach(() => restoreEnv());

async function openPack(usd: number, planTier: PaidTier = "starter") {
  const b = await subscribe(T1, planTier);
  const res = await callRoute(billingTopup, { token: b.token, body: { usd } });
  expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
  return { b, session: world.stripe.lastSession() };
}

async function buyPack(usd: number) {
  const { b, session } = await openPack(usd);
  const paid = world.sim.completeTopupCheckout(session.id);
  const { handler } = journeyWebhook();
  const res = await deliver(handler, paid.event);
  expect(res.body.note).toBe("topup-granted");
  return { b, ...paid, credits: world.db.topupGrants.get(paid.piId)?.credits ?? 0 };
}

describe("H. top-up packs", () => {
  it("a free tenant (no subscription row) buys a pack and the credits land", async () => {
    const token = world.signIn(T1);
    const res = await callRoute(billingTopup, { token, body: { usd: 20 } });
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    const paid = world.sim.completeTopupCheckout(world.stripe.lastSession().id);
    const { handler } = journeyWebhook();
    const hook = await deliver(handler, paid.event);
    expect(hook.body.note).toBe("topup-granted");
    expect(world.db.topupGrants.get(paid.piId)?.credits).toBe(8_000);
  });

  it("a tenant whose plan was canceled can still buy a pack", async () => {
    const b = await subscribe(T1, "growth");
    const { handler } = journeyWebhook();
    await deliver(handler, world.sim.deleteSubscription(b.sub.id));
    const before = world.stripe.sessionCount;
    const res = await callRoute(billingTopup, { token: b.token, body: { usd: 120 } });
    expect(res.statusCode).toBe(200);
    expect(world.stripe.sessionCount).toBe(before + 1);
  });

  it.each([[50], [0], ["20"], [20.5], [undefined]])("usd=%j → 400 bad_amount, no session", async (usd) => {
    const b = await subscribe(T1, "starter");
    const before = world.stripe.sessionCount;
    const res = await callRoute(billingTopup, { token: b.token, body: { usd } });
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe("bad_amount");
    expect(world.stripe.sessionCount).toBe(before);
  });

  it.each<[number, PaidTier, number]>([
    [20, "starter", 8_000],
    [120, "growth", 48_000],
    [240, "pro", 96_000],
  ])("$%i pack: card-only payment session with PI metadata; the paid webhook grants the %s pool (%i)", async (usd, packTier, credits) => {
    const { b, session: s } = await openPack(usd);
    const meta = {
      kind: "credit_topup",
      tenant_id: T1,
      credits: String(credits),
      usd_cents: String(usd * 100),
      pack_tier: packTier,
    };
    expect(s.params).toEqual({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: usd * 100,
            product_data: { name: `${credits.toLocaleString("en-US")} Zavi credits (one-time pack)` },
          },
        },
      ],
      customer: b.customer,
      client_reference_id: T1,
      metadata: meta,
      payment_intent_data: { metadata: meta },
      success_url: `${BASE}/workspace?topup=success`,
      cancel_url: `${BASE}/workspace?topup=cancel`,
    });
    expect(s.opts?.idempotencyKey).toMatch(new RegExp(`^topup_${T1}_${usd}usd_c${credits}_\\d+$`));

    const paid = world.sim.completeTopupCheckout(s.id);
    const { handler, deps } = journeyWebhook();
    const res = await deliver(handler, paid.event);
    expect(res.statusCode).toBe(200);
    expect(res.body.note).toBe("topup-granted");
    expect(deps.resolveTenantByCustomer).toHaveBeenCalledWith(b.customer);
    expect(deps.applyCreditTopup).toHaveBeenCalledWith(T1, credits, paid.piId, paid.event.id);
    expect(deps.applyState).not.toHaveBeenCalled();
    expect(deps.setTier).not.toHaveBeenCalled();
    expect(deps.markProcessed).toHaveBeenCalledWith(paid.event.id, "checkout.session.completed");
    expect(world.db.purchased.get(T1)).toBe(credits);
    expect(world.db.effectiveTier(T1)).toBe("starter");
  });

  it.each<[string, { amountTotal?: number; paymentStatus?: string; currency?: string }]>([
    ["amount_total tampered to 100 cents", { amountTotal: 100 }],
    ["amount_total off by a dollar ($121)", { amountTotal: 12_100 }],
    ["payment_status unpaid", { paymentStatus: "unpaid" }],
    ["currency eur", { currency: "eur" }],
  ])("%s → no grant; acked 200 and recorded (Stripe will not retry)", async (_label, over) => {
    const { session } = await openPack(120);
    const paid = world.sim.completeTopupCheckout(session.id, over);
    const { handler, deps } = journeyWebhook();
    const res = await deliver(handler, paid.event);
    expect(res.statusCode).toBe(200);
    expect(res.body.note).toBe("topup-validation-rejected");
    expect(deps.applyCreditTopup).not.toHaveBeenCalled();
    expect(world.db.processed.has(paid.event.id)).toBe(true);
    expect(world.db.purchased.get(T1) ?? 0).toBe(0);
    expect(world.logs).toContainEqual(expect.objectContaining({ level: "warn", code: "billing.topup.rejected" }));
  });

  it("a replay of the same event is a duplicate no-op; a SECOND event for the same payment intent grants nothing more", async () => {
    const { session } = await openPack(20);
    const paid = world.sim.completeTopupCheckout(session.id);
    const { handler, deps } = journeyWebhook();
    expect((await deliver(handler, paid.event)).body.note).toBe("topup-granted");
    const replay = await deliver(handler, paid.event);
    expect(replay.body).toEqual({ ok: true, duplicate: paid.event.id });
    const again = world.sim.event("checkout.session.completed", paid.event.data.object);
    expect((await deliver(handler, again)).statusCode).toBe(200);
    expect(deps.applyCreditTopup).toHaveBeenCalledTimes(2);
    expect(world.db.purchased.get(T1)).toBe(8_000);
  });

  it("config store down at settlement → 503, nothing granted or recorded; Stripe's retry grants", async () => {
    const { session } = await openPack(120);
    const paid = world.sim.completeTopupCheckout(session.id);
    const { handler, deps } = journeyWebhook();
    world.db.configReadError = "connection reset";
    const res = await deliver(handler, paid.event);
    expect(res.statusCode).toBe(503);
    expect(res.body.error.code).toBe("credit_rate_unavailable");
    expectNoWrites(deps);
    world.db.configReadError = null;
    expect((await deliver(handler, paid.event)).body.note).toBe("topup-granted");
    expect(world.db.purchased.get(T1)).toBe(48_000);
  });

  it("the route refuses to quote when the config store is down (503, no session)", async () => {
    const b = await subscribe(T1, "starter");
    world.db.configReadError = "connection reset";
    const before = world.stripe.sessionCount;
    const res = await callRoute(billingTopup, { token: b.token, body: { usd: 20 } });
    expect(res.statusCode).toBe(503);
    expect(world.stripe.sessionCount).toBe(before);
  });

  it("FLAG H-9: tier_credits retuned between checkout and payment → the grant differs from the receipt", async () => {
    const { session } = await openPack(120);
    expect(session.params.line_items[0].price_data?.product_data.name).toBe("48,000 Zavi credits (one-time pack)");
    world.db.config = { ...world.db.config, tier_credits: { starter: 8_000, growth: 30_000, pro: 96_000 } };
    const paid = world.sim.completeTopupCheckout(session.id);
    const { handler, deps } = journeyWebhook();
    await deliver(handler, paid.event);
    expect(deps.applyCreditTopup).toHaveBeenCalledWith(T1, 30_000, paid.piId, paid.event.id);
    expect(world.db.purchased.get(T1)).toBe(30_000);
  });
});

describe("I. refunds and disputes through the real charge lookups", () => {
  it("a top-up refunded → the pack is clawed back; the plan is untouched", async () => {
    const { piId, chargeId, credits } = await buyPack(120);
    expect(credits).toBe(48_000);
    const { handler, deps } = journeyWebhook();
    const ev = world.sim.refund(chargeId);
    const res = await deliver(handler, ev);
    expect(res.statusCode).toBe(200);
    expect(res.body.note).toBe("topup-revoked");
    expect(world.stripe.api.charges.retrieve).toHaveBeenCalledWith(chargeId);
    expect(world.stripe.api.paymentIntents.retrieve).toHaveBeenCalledWith(piId);
    expect(deps.revokeCreditTopup).toHaveBeenCalledWith(piId, ev.id, T1);
    expect(deps.revokeCredits).not.toHaveBeenCalled();
    expect(world.db.purchased.get(T1)).toBe(0);
    expect(world.db.effectiveTier(T1)).toBe("starter");
  });

  it("a top-up refunded BEFORE its grant event lands → tombstoned; the late grant is refused", async () => {
    const { session } = await openPack(240);
    const paid = world.sim.completeTopupCheckout(session.id);
    const { handler, deps } = journeyWebhook();
    const refund = await deliver(handler, world.sim.refund(paid.chargeId));
    expect(refund.body.note).toBe("topup-tombstoned");
    expect((await deliver(handler, paid.event)).statusCode).toBe(200);
    expect(deps.applyCreditTopup).toHaveBeenCalledTimes(1);
    expect(world.db.purchased.get(T1) ?? 0).toBe(0);
  });

  it("a dispute on a top-up → the pack is clawed back", async () => {
    const { piId, chargeId } = await buyPack(20);
    const { handler, deps } = journeyWebhook();
    const ev = world.sim.dispute(chargeId, "charge.dispute.created");
    const res = await deliver(handler, ev);
    expect(res.body.note).toBe("topup-revoked");
    expect(deps.revokeCreditTopup).toHaveBeenCalledWith(piId, ev.id, T1);
    expect(world.db.purchased.get(T1)).toBe(0);
  });

  it("a FULL refund of a subscription invoice → credits revoked, tier cleared, refund block set", async () => {
    const b = await subscribe(T1, "pro");
    const { handler, deps } = journeyWebhook();
    const ev = world.sim.refund(b.chargeId);
    const res = await deliver(handler, ev);
    expect(res.statusCode).toBe(200);
    expect(res.body.note).toBe("credits-revoked");
    expect(world.stripe.api.invoices.retrieve).toHaveBeenCalledWith(b.invoiceId);
    expect(deps.revokeCredits).toHaveBeenCalledWith(T1, ev.created, b.sub.id);
    expect(deps.clearTierForSubscription).toHaveBeenCalledWith(T1, b.sub.id);
    expect(deps.revokeCreditTopup).not.toHaveBeenCalled();
    expect(world.db.row(T1)).toMatchObject({ tier: null, monthly_credits: 0 });
    expect(world.db.row(T1)?.credits_revoked_at).not.toBeNull();
    expect(world.db.effectiveTier(T1)).toBe("free");
    expect(world.db.monthlyAllowance(T1)).toBe(0);
  });

  it("a PARTIAL refund of a subscription invoice → nothing revoked", async () => {
    const b = await subscribe(T1, "growth");
    const { handler, deps } = journeyWebhook();
    const ev = world.sim.refund(b.chargeId, 2_000);
    expect(ev.data.object.refunded).toBe(false);
    const res = await deliver(handler, ev);
    expect(res.body.note).toBe("partial-refund-skipped");
    expect(deps.revokeCredits).not.toHaveBeenCalled();
    expect(world.db.effectiveTier(T1)).toBe("growth");
  });

  it("a dispute on a subscription charge (no customer on the event) → customer read off the charge, revoked; funds_withdrawn after it is idempotent", async () => {
    const b = await subscribe(T1, "growth");
    const { handler, deps } = journeyWebhook();
    const created = world.sim.dispute(b.chargeId, "charge.dispute.created");
    expect(created.data.object).not.toHaveProperty("customer");
    const r1 = await deliver(handler, created);
    expect(r1.body.note).toBe("credits-revoked");
    expect(deps.resolveTenantByCustomer).toHaveBeenCalledWith(b.customer);
    expect(deps.revokeCredits).toHaveBeenCalledWith(T1, created.created, b.sub.id);

    const withdrawn = world.sim.dispute(b.chargeId, "charge.dispute.funds_withdrawn");
    const r2 = await deliver(handler, withdrawn);
    expect(r2.statusCode).toBe(200);
    expect(world.db.effectiveTier(T1)).toBe("free");
    expect(world.db.monthlyAllowance(T1)).toBe(0);
  });

  it("a refund of an unrelated one-off charge → skipped, nothing revoked", async () => {
    const b = await subscribe(T1, "pro");
    const chargeId = world.sim.oneOffCharge(b.customer);
    const { handler, deps } = journeyWebhook();
    const res = await deliver(handler, world.sim.refund(chargeId));
    expect(res.body.note).toBe("unrelated-charge-skipped");
    expect(deps.revokeCredits).not.toHaveBeenCalled();
    expect(deps.revokeCreditTopup).not.toHaveBeenCalled();
    expect(world.db.effectiveTier(T1)).toBe("pro");
  });

  it("a refund of the PREVIOUS subscription's charge → subscription mismatch, the live plan is untouched", async () => {
    const old = await subscribe(T1, "starter");
    const { handler, deps } = journeyWebhook();
    await deliver(handler, world.sim.deleteSubscription(old.sub.id));
    await callRoute(billingCheckout, { token: old.token, body: { tier: "pro" } });
    const cur = world.sim.completeSubscriptionCheckout(world.stripe.lastSession().id);
    await deliver(handler, cur.events.subscriptionCreated);
    expect(world.db.effectiveTier(T1)).toBe("pro");

    const res = await deliver(handler, world.sim.refund(old.chargeId));
    expect(res.body.note).toBe("subscription-mismatch-skipped");
    expect(deps.revokeCredits).toHaveBeenCalledWith(T1, expect.any(Number), old.sub.id);
    expect(deps.clearTierForSubscription).not.toHaveBeenCalled();
    expect(world.db.effectiveTier(T1)).toBe("pro");
  });

  it("the billing key is missing when a refund arrives → 500 so Stripe retries; nothing revoked or recorded", async () => {
    const { chargeId } = await buyPack(20);
    delete process.env.STRIPE_PLATFORM_SECRET_KEY;
    const { handler, deps } = journeyWebhook();
    const res = await deliver(handler, world.sim.refund(chargeId));
    expect(res.statusCode).toBe(500);
    expectNoWrites(deps);
    expect(world.db.purchased.get(T1)).toBe(8_000);
  });

  it("FLAG I-10: a $1 partial refund of a $240 pack claws back all 96,000 credits", async () => {
    const { chargeId } = await buyPack(240);
    const { handler } = journeyWebhook();
    const ev = world.sim.refund(chargeId, 100);
    expect(ev.data.object.refunded).toBe(false);
    const res = await deliver(handler, ev);
    expect(res.body.note).toBe("topup-revoked");
    expect(world.db.purchased.get(T1)).toBe(0);
  });

  it("FLAG I-11: after a goodwill refund of one invoice, later PAID renewals grant nothing", async () => {
    const b = await subscribe(T1, "growth");
    const { handler } = journeyWebhook();
    await deliver(handler, world.sim.refund(b.chargeId));
    const logsBefore = world.logs.length;
    const renewal = world.sim.renew(b.sub.id);
    const res = await deliver(handler, renewal);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ status: "active", tier: "growth" });
    const sub = world.sim.sub(b.sub.id);
    expect(world.stripe.charges.get(sub.charges[sub.charges.length - 1])?.paid).toBe(true);
    expect(world.db.row(T1)?.status).toBe("active");
    expect(world.db.effectiveTier(T1)).toBe("free");
    expect(world.db.monthlyAllowance(T1)).toBe(0);
    expect(world.logs.slice(logsBefore).filter((l) => l.level !== "info")).toEqual([]);
  });

  it("I-12 (fixed): a refund-blocked tenant who buys a NEW plan gets it; the block is lifted", async () => {
    const b = await subscribe(T1, "starter");
    const { handler } = journeyWebhook();
    await deliver(handler, world.sim.refund(b.chargeId));
    await deliver(handler, world.sim.deleteSubscription(b.sub.id));
    expect(world.db.row(T1)?.credits_revoked_at).not.toBeNull();

    const res = await callRoute(billingCheckout, { token: b.token, body: { tier: "pro" } });
    expect(res.statusCode).toBe(200);
    const again = world.sim.completeSubscriptionCheckout(world.stripe.lastSession().id);
    const r = await deliver(handler, again.events.subscriptionCreated);
    expect(r.statusCode).toBe(200);
    expect(world.db.row(T1)).toMatchObject({
      status: "active",
      stripe_subscription_id: again.sub.id,
      tier: "pro",
      credits_revoked_at: null,
    });
    expect(world.db.effectiveTier(T1)).toBe("pro");
    expect(world.db.monthlyAllowance(T1)).toBe(96_000);
  });

  it("the refunded subscription's own later events never lift the block", async () => {
    const b = await subscribe(T1, "starter");
    const { handler } = journeyWebhook();
    await deliver(handler, world.sim.refund(b.chargeId));
    const r = await deliver(handler, world.sim.updateSubscription(b.sub.id, { cancelAtPeriodEnd: false }, world.sim.tick(60)));
    expect(r.statusCode).toBe(200);
    expect(world.db.row(T1)?.credits_revoked_at).not.toBeNull();
    expect(world.db.monthlyAllowance(T1)).toBe(0);
  });
});
