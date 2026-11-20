
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const changePlanFromCheckout = vi.hoisted(() =>
  vi.fn(async (_req: unknown, res: { json: (b: unknown) => void }) => {
    res.json({ ok: true, kind: "upgrade", redirect: "https://billing.stripe.test/confirm/jny" });
  }),
);
vi.mock("@/routes/billing/subscription", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/routes/billing/subscription")>()),
  changePlanFromCheckout,
}));
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

import { billingCheckout, checkoutIdempotencyKey } from "@/routes/billing/checkout";
import { buildPublicPricing } from "@/routes/public/pricing";
import { installBillingEnv, PRICE_ENV, PRICE_IDS, resetWorld, world } from "./_world";
import { callRoute, deliver, expectNoWrites, journeyWebhook, knownGap, subscribe, T1, T2 } from "./_harness";

const DAY = 86_400;
let restoreEnv: () => void;

beforeEach(() => {
  resetWorld();
  restoreEnv = installBillingEnv();
});
afterEach(() => restoreEnv());

describe("E. plan changes", () => {
  it("starter monthly → pro monthly (Portal upgrade): tier pro on the same subscription and customer", async () => {
    const b = await subscribe(T1, "starter");
    const { handler, deps } = journeyWebhook();
    const up = world.sim.updateSubscription(b.sub.id, { priceId: PRICE_IDS.pro.monthly });
    const res = await deliver(handler, up);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ plan: "team", status: "active", tier: "pro" });
    expect(deps.setTier).toHaveBeenCalledWith(T1, "pro", up.created);
    expect(world.db.row(T1)).toMatchObject({ stripe_subscription_id: b.sub.id, stripe_customer_id: b.customer, tier: "pro" });
    expect(world.db.effectiveTier(T1)).toBe("pro");
    expect(world.db.monthlyAllowance(T1)).toBe(96_000);
  });

  it("growth monthly → growth six-month: still growth, and the period end moves six months out", async () => {
    const b = await subscribe(T1, "growth");
    const { handler } = journeyWebhook();
    const toSix = world.sim.updateSubscription(b.sub.id, { priceId: PRICE_IDS.growth["6mo"] });
    expect((await deliver(handler, toSix)).statusCode).toBe(200);
    const sub = world.sim.sub(b.sub.id);
    expect(sub.periodEnd - toSix.created).toBe(180 * DAY);
    expect(world.db.row(T1)).toMatchObject({
      tier: "growth",
      current_period_end: new Date(sub.periodEnd * 1000).toISOString(),
    });
    expect(world.db.effectiveTier(T1)).toBe("growth");
    expect(world.db.monthlyAllowance(T1)).toBe(48_000);
  });

  it("pro → starter (downgrade) → tier starter, pool 8,000", async () => {
    const b = await subscribe(T1, "pro");
    const { handler, deps } = journeyWebhook();
    const down = world.sim.updateSubscription(b.sub.id, { priceId: PRICE_IDS.starter.monthly });
    expect((await deliver(handler, down)).statusCode).toBe(200);
    expect(deps.setTier).toHaveBeenCalledWith(T1, "starter", down.created);
    expect(world.db.effectiveTier(T1)).toBe("starter");
    expect(world.db.monthlyAllowance(T1)).toBe(8_000);
  });

  it("an OLDER event delivered late is acked and recorded but changes nothing", async () => {
    const b = await subscribe(T1, "starter");
    const { handler, deps } = journeyWebhook();
    const toGrowth = world.sim.updateSubscription(b.sub.id, { priceId: PRICE_IDS.growth.monthly });
    const toPro = world.sim.updateSubscription(b.sub.id, { priceId: PRICE_IDS.pro.monthly });
    expect((await deliver(handler, toPro)).statusCode).toBe(200);
    const late = await deliver(handler, toGrowth);
    expect(late.statusCode).toBe(200);
    expect(deps.applyState).toHaveBeenCalledTimes(2);
    expect(deps.setTier).toHaveBeenLastCalledWith(T1, "growth", toGrowth.created);
    expect(world.db.row(T1)).toMatchObject({ tier: "pro", stripe_event_created: toPro.created, tier_event_created: toPro.created });
    expect(world.db.effectiveTier(T1)).toBe("pro");
    expect(world.db.processed.has(toGrowth.id)).toBe(true);
  });

  it("a same-second stale event delivered after the newer one is refused too (strict watermark)", async () => {
    const b = await subscribe(T1, "starter");
    const { handler } = journeyWebhook();
    const second = world.sim.tick();
    const stale = world.sim.updateSubscription(b.sub.id, { priceId: PRICE_IDS.growth.monthly }, second);
    const fresh = world.sim.updateSubscription(b.sub.id, { priceId: PRICE_IDS.pro.monthly }, second);
    await deliver(handler, fresh);
    await deliver(handler, stale);
    expect(world.db.effectiveTier(T1)).toBe("pro");
  });
});

describe("F. cancel", () => {
  it("cancel at period end keeps the tier until Stripe deletes the subscription, then free", async () => {
    const b = await subscribe(T1, "growth");
    const { handler, deps } = journeyWebhook();
    const scheduled = world.sim.updateSubscription(b.sub.id, { cancelAtPeriodEnd: true });
    expect((await deliver(handler, scheduled)).statusCode).toBe(200);
    expect(world.db.row(T1)).toMatchObject({ cancel_at_period_end: true, status: "active", tier: "growth" });
    expect(world.db.effectiveTier(T1)).toBe("growth");

    const del = world.sim.deleteSubscription(b.sub.id);
    const res = await deliver(handler, del);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ plan: "free", status: "canceled", tier: null });
    expect(deps.applyState).toHaveBeenLastCalledWith(
      expect.objectContaining({ plan: "free", status: "canceled", subscription_id: b.sub.id, event_created: del.created }),
    );
    expect(deps.setTier).toHaveBeenLastCalledWith(T1, null, del.created);
    expect(deps.setMonthlyCredits).toHaveBeenLastCalledWith(T1, null, null, del.created);
    expect(world.db.row(T1)).toMatchObject({ plan: "free", status: "canceled", tier: null, monthly_credits: null });
    expect(world.db.effectiveTier(T1)).toBe("free");
    expect(world.db.monthlyAllowance(T1)).toBe(1_000);
  });

  it("an immediate cancel of a six-month plan → free straight away", async () => {
    const b = await subscribe(T1, "pro", "6mo", { apiShape: "basil" });
    const { handler } = journeyWebhook();
    expect((await deliver(handler, world.sim.deleteSubscription(b.sub.id))).statusCode).toBe(200);
    expect(world.db.effectiveTier(T1)).toBe("free");
  });

  it("after a cancel, buying again opens a NEW Checkout on the SAME Stripe customer, and the new subscription binds", async () => {
    const b = await subscribe(T1, "starter");
    const { handler } = journeyWebhook();
    await deliver(handler, world.sim.deleteSubscription(b.sub.id));

    const res = await callRoute(billingCheckout, { token: b.token, body: { tier: "pro" } });
    expect(res.statusCode).toBe(200);
    expect(res.body.url).toBeDefined();
    const s = world.stripe.lastSession();
    expect(s.params.customer).toBe(b.customer);
    expect(s.opts?.idempotencyKey).toBe(checkoutIdempotencyKey(T1, "pro", s.params));

    const again = world.sim.completeSubscriptionCheckout(s.id);
    expect(again.customer).toBe(b.customer);
    for (const ev of [again.events.sessionCompleted, again.events.subscriptionCreated]) {
      expect((await deliver(handler, ev)).statusCode).toBe(200);
    }
    expect(world.db.row(T1)).toMatchObject({ stripe_subscription_id: again.sub.id, status: "active", tier: "pro" });
  });
});

describe("G. payment failed", () => {
  it("invoice.payment_failed is acked with no write; subscription.updated past_due KEEPS the paid tier (dunning grace)", async () => {
    const b = await subscribe(T1, "pro");
    const { handler, deps } = journeyWebhook();

    const failed = await deliver(handler, world.sim.invoicePaymentFailed(b.sub.id));
    expect(failed.statusCode).toBe(200);
    expect(failed.body.note).toBe("dunning-via-subscription-event");
    expect(deps.applyState).not.toHaveBeenCalled();
    expect(deps.notifyPaymentFailed).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: T1, attemptCount: 1, billingReason: "subscription_cycle" }),
    );

    const pastDue = world.sim.updateSubscription(b.sub.id, { status: "past_due" });
    expect((await deliver(handler, pastDue)).statusCode).toBe(200);
    expect(deps.applyState).toHaveBeenCalledWith(expect.objectContaining({ status: "past_due", plan: "team" }));
    expect(deps.setTier).toHaveBeenCalledWith(T1, "keep", pastDue.created);
    expect(deps.setMonthlyCredits).toHaveBeenCalledWith(T1, null, null, pastDue.created);
    expect(world.db.row(T1)).toMatchObject({ status: "past_due", tier: "pro" });
    expect(world.db.effectiveTier(T1)).toBe("pro");
    expect(world.db.monthlyAllowance(T1)).toBe(96_000);

    const click = await callRoute(billingCheckout, { token: b.token, body: { tier: "growth" } });
    expect(click.body.redirect).toBeDefined();
  });

  it("the card is fixed: past_due → active keeps the tier", async () => {
    const b = await subscribe(T1, "growth");
    const { handler } = journeyWebhook();
    await deliver(handler, world.sim.updateSubscription(b.sub.id, { status: "past_due" }));
    await deliver(handler, world.sim.updateSubscription(b.sub.id, { status: "active" }));
    expect(world.db.row(T1)).toMatchObject({ status: "active", tier: "growth" });
  });

  it("retries exhausted and Stripe cancels: deleted → free", async () => {
    const b = await subscribe(T1, "growth");
    const { handler } = journeyWebhook();
    await deliver(handler, world.sim.updateSubscription(b.sub.id, { status: "past_due" }));
    await deliver(handler, world.sim.deleteSubscription(b.sub.id));
    expect(world.db.effectiveTier(T1)).toBe("free");
    expect(world.db.monthlyAllowance(T1)).toBe(1_000);
  });

  it("G-4 (fixed): Stripe status 'unpaid' drops the paid tier and pool to Free", async () => {
    const b = await subscribe(T1, "pro");
    const { handler, deps } = journeyWebhook();
    await deliver(handler, world.sim.updateSubscription(b.sub.id, { status: "past_due" }));
    expect(world.db.effectiveTier(T1)).toBe("pro");
    const unpaid = world.sim.updateSubscription(b.sub.id, { status: "unpaid" }, world.sim.tick(21 * DAY));
    expect((await deliver(handler, unpaid)).statusCode).toBe(200);
    expect(deps.applyState).toHaveBeenLastCalledWith(expect.objectContaining({ status: "incomplete" }));
    expect(world.db.monthlyAllowance(T1)).toBe(1_000);
  });
});

describe("J. unknown price on a subscription event", () => {
  it("a price not in env → 503 unknown_price, nothing written or recorded; Stripe's retry lands once env is fixed", async () => {
    const token = world.signIn(T1);
    await callRoute(billingCheckout, { token, body: { tier: "growth" } });
    const paid = world.sim.completeSubscriptionCheckout(world.stripe.lastSession().id);
    process.env[PRICE_ENV.growth.monthly] = "price_jny_growth_m_v2";
    const { handler, deps } = journeyWebhook();

    const res = await deliver(handler, paid.events.subscriptionCreated);
    expect(res.statusCode).toBe(503);
    expect(res.body.error.code).toBe("unknown_price");
    expectNoWrites(deps);
    expect(world.db.processed.has(paid.events.subscriptionCreated.id)).toBe(false);
    expect(world.logs).toContainEqual(expect.objectContaining({ level: "error", code: "unknown_price" }));

    process.env[PRICE_ENV.growth.monthly] = PRICE_IDS.growth.monthly;
    const retry = await deliver(handler, paid.events.subscriptionCreated);
    expect(retry.statusCode).toBe(200);
    expect(world.db.effectiveTier(T1)).toBe("growth");
  });

  it("FLAG J-2: unsetting a six-month env to stop selling the term 503s existing six-month subscribers' updates", async () => {
    const b = await subscribe(T1, "growth", "6mo", { apiShape: "basil" });
    delete process.env[PRICE_ENV.growth["6mo"]];
    expect(buildPublicPricing(null).six_month_available).toBe(false);
    const { handler } = journeyWebhook();

    const scheduled = await deliver(handler, world.sim.updateSubscription(b.sub.id, { cancelAtPeriodEnd: true }));
    expect(scheduled.statusCode).toBe(503);
    expect(scheduled.body.error.code).toBe("unknown_price");
    expect(world.db.row(T1)?.cancel_at_period_end).toBe(false);

    expect((await deliver(handler, world.sim.deleteSubscription(b.sub.id))).statusCode).toBe(200);
    expect(world.db.effectiveTier(T1)).toBe("free");
  });
});

function strangerSubscriptionEvent(metadata: Record<string, string>) {
  return world.sim.event("customer.subscription.created", {
    id: "sub_manual",
    object: "subscription",
    customer: "cus_stranger",
    status: "active",
    cancel_at_period_end: false,
    metadata,
    items: {
      object: "list",
      data: [{ price: { id: PRICE_IDS.pro.monthly }, quantity: 1, current_period_end: world.sim.clock + 30 * DAY }],
    },
  });
}

describe("K. tenant resolution", () => {
  it("no stored binding and no metadata → 503 tenant_unresolved, nothing written or recorded", async () => {
    const { handler, deps } = journeyWebhook();
    const res = await deliver(handler, strangerSubscriptionEvent({}));
    expect(res.statusCode).toBe(503);
    expect(res.body.error.code).toBe("tenant_unresolved");
    expect(deps.resolveTenantByCustomer).toHaveBeenCalledWith("cus_stranger");
    expectNoWrites(deps);
    expect(world.logs).toContainEqual(expect.objectContaining({ code: "tenant_unresolved" }));
  });

  it.each([
    ["a tenant that does not exist", { tenant_id: "99999999-9999-4999-8999-999999999999" }],
    ["a non-uuid", { tenant_id: "acme" }],
  ])("metadata naming %s → 503, nothing written", async (_label, metadata) => {
    const { handler, deps } = journeyWebhook();
    const res = await deliver(handler, strangerSubscriptionEvent(metadata));
    expect(res.statusCode).toBe(503);
    expectNoWrites(deps);
  });

  it("no binding yet → tenant from metadata (checked to exist), and the customer gets bound", async () => {
    world.db.tenants.add(T1);
    const { handler, deps } = journeyWebhook();
    const res = await deliver(handler, strangerSubscriptionEvent({ tenant_id: T1 }));
    expect(res.statusCode).toBe(200);
    expect(deps.tenantExists).toHaveBeenCalledWith(T1);
    expect(world.db.tenantByCustomer("cus_stranger")).toBe(T1);
    expect(world.db.effectiveTier(T1)).toBe("pro");
  });

  it("the stored binding wins over metadata that names another tenant", async () => {
    const b = await subscribe(T1, "starter");
    world.db.tenants.add(T2);
    world.sim.sub(b.sub.id).metadata = { tenant_id: T2 };
    const { handler, deps } = journeyWebhook();
    const res = await deliver(handler, world.sim.updateSubscription(b.sub.id, { priceId: PRICE_IDS.pro.monthly }));
    expect(res.statusCode).toBe(200);
    expect(deps.applyState).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: T1 }));
    expect(deps.tenantExists).not.toHaveBeenCalled();
    expect(world.db.row(T2)).toBeUndefined();
    expect(world.db.effectiveTier(T1)).toBe("pro");
  });
});

describe("L. duplicate delivery", () => {
  it("the same event id delivered twice → the second is a 200 no-op", async () => {
    const token = world.signIn(T1);
    await callRoute(billingCheckout, { token, body: { tier: "growth" } });
    const paid = world.sim.completeSubscriptionCheckout(world.stripe.lastSession().id);
    const { handler, deps } = journeyWebhook();

    const first = await deliver(handler, paid.events.subscriptionCreated);
    const second = await deliver(handler, paid.events.subscriptionCreated);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.body).toEqual({ ok: true, duplicate: paid.events.subscriptionCreated.id });
    expect(deps.applyState).toHaveBeenCalledTimes(1);
    expect(deps.setTier).toHaveBeenCalledTimes(1);
    expect(deps.setMonthlyCredits).toHaveBeenCalledTimes(1);
    expect(deps.markProcessed).toHaveBeenCalledTimes(1);
  });
});

describe("S. signature verification (real HMAC, constructEvent not injected)", () => {
  it("tampered payload (Starter price swapped for Pro after signing) → 400 bad_signature, nothing read or written", async () => {
    const b = await subscribe(T1, "starter");
    const { handler, deps } = journeyWebhook();
    const res = await deliver(handler, world.sim.renew(b.sub.id), {
      tamper: (raw) => raw.split(PRICE_IDS.starter.monthly).join(PRICE_IDS.pro.monthly),
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe("bad_signature");
    expect(deps.eventProcessed).not.toHaveBeenCalled();
    expectNoWrites(deps);
    expect(world.db.effectiveTier(T1)).toBe("starter");
  });

  it("signed with the wrong secret → 400 bad_signature", async () => {
    const b = await subscribe(T1, "starter");
    const { handler, deps } = journeyWebhook();
    const res = await deliver(handler, world.sim.renew(b.sub.id), { secret: "whsec_attacker" });
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe("bad_signature");
    expectNoWrites(deps);
  });

  it("no stripe-signature header → 400 no_signature", async () => {
    const b = await subscribe(T1, "starter");
    const { handler, deps } = journeyWebhook();
    const res = await deliver(handler, world.sim.renew(b.sub.id), { omitSignature: true });
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe("no_signature");
    expectNoWrites(deps);
  });

  it("a captured request replayed after the 5-minute tolerance → 400", async () => {
    const b = await subscribe(T1, "starter");
    const { handler, deps } = journeyWebhook();
    const res = await deliver(handler, world.sim.renew(b.sub.id), { timestamp: Math.floor(Date.now() / 1000) - 600 });
    expect(res.statusCode).toBe(400);
    expectNoWrites(deps);
  });

  it("webhook secret unset → 503 so Stripe keeps the event until it is configured", async () => {
    const { handler, deps } = journeyWebhook({ webhookSecret: () => null });
    const res = await deliver(handler, strangerSubscriptionEvent({ tenant_id: T1 }));
    expect(res.statusCode).toBe(503);
    expect(res.body.error.code).toBe("billing_webhook_disabled");
    expectNoWrites(deps);
  });
});

describe("Known gaps (the journey a paying customer needs; it.fails until fixed)", () => {
  knownGap("GAP-1: created(incomplete) + updated(active) in the SAME second, in order → the paying customer gets the tier", async () => {
    const token = world.signIn(T1);
    await callRoute(billingCheckout, { token, body: { tier: "pro" } });
    const paid = world.sim.completeSubscriptionCheckout(world.stripe.lastSession().id, { status: "incomplete" });
    const activated = world.sim.updateSubscription(paid.sub.id, { status: "active" }, paid.events.subscriptionCreated.created);
    const { handler } = journeyWebhook();
    for (const ev of [paid.events.subscriptionCreated, activated, paid.events.sessionCompleted]) {
      expect((await deliver(handler, ev)).statusCode).toBe(200);
    }
    expect(world.sim.sub(paid.sub.id).status).toBe("active");
    expect(world.db.row(T1)?.status).toBe("active");
    expect(world.db.effectiveTier(T1)).toBe("pro");
  });

  knownGap("GAP-2: canceling a stale second subscription does not downgrade the tenant's live one", async () => {
    const token = world.signIn(T1);
    await callRoute(billingCheckout, { token, body: { tier: "starter" } });
    const first = world.stripe.lastSession();
    const click2 = await callRoute(billingCheckout, { token, body: { tier: "pro" } });
    expect(click2.body.url).toBeDefined();
    const second = world.stripe.lastSession();
    expect(second.id).not.toBe(first.id);

    const a = world.sim.completeSubscriptionCheckout(first.id);
    const b = world.sim.completeSubscriptionCheckout(second.id);
    const { handler } = journeyWebhook();
    for (const ev of [a.events.sessionCompleted, a.events.subscriptionCreated, b.events.sessionCompleted, b.events.subscriptionCreated]) {
      expect((await deliver(handler, ev)).statusCode).toBe(200);
    }
    expect(world.db.effectiveTier(T1)).toBe("pro");

    expect((await deliver(handler, world.sim.deleteSubscription(a.sub.id))).statusCode).toBe(200);
    expect(world.sim.sub(b.sub.id).status).toBe("active");
    expect(world.db.effectiveTier(T1)).toBe("pro");
  });

  it("GAP-3 (fixed): a tier subscription stuck in 'incomplete' (unpaid) gets no paid credit pool", async () => {
    const token = world.signIn(T1);
    await callRoute(billingCheckout, { token, body: { tier: "starter" } });
    const paid = world.sim.completeSubscriptionCheckout(world.stripe.lastSession().id, { status: "incomplete" });
    const { handler } = journeyWebhook();
    expect((await deliver(handler, paid.events.subscriptionCreated)).statusCode).toBe(200);
    expect(world.db.effectiveTier(T1)).toBe("free");
    expect(world.db.monthlyAllowance(T1)).toBeLessThanOrEqual(1_000);
  });
});
