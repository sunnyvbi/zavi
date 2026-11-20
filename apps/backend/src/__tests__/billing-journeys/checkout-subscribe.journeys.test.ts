
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Request, Response } from "express";

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
import { billingTopup } from "@/routes/billing/topup";
import { billingPortal } from "@/routes/billing/portal";
import { buildPublicPricing, publicPricing } from "@/routes/public/pricing";
import { billingConfigured, sixMonthPriceMismatch, sixMonthUsd } from "@/services/billing/plans";
import { DEFAULT_TIER_CREDITS, PAID_TIERS, TIER_PRICE_USD, type PaidTier } from "@/services/billing/tiers";
import { installBillingEnv, PRICE_ENV, PRICE_IDS, resetWorld, TERMS, world, type PriceLike } from "./_world";
import { callRoute, deliver, journeyWebhook, knownGap, mockRes, subscribe, T1 } from "./_harness";

const BASE = "https://www.zaviagent.com";
let restoreEnv: () => void;

beforeEach(() => {
  resetWorld();
  restoreEnv = installBillingEnv();
});
afterEach(() => restoreEnv());

describe("A. a free tenant buys each of the six prices", () => {
  const cases = PAID_TIERS.flatMap((tier) =>
    TERMS.flatMap((term) =>
      (["session-first", "subscription-first"] as const).map((order) => ({ tier, term, order })),
    ),
  );

  it.each(cases)(
    "$tier $term, events $order: Checkout sells the right price and the webhook grants $tier",
    async ({ tier, term, order }) => {
      const token = world.signIn(T1);
      expect(world.db.row(T1)).toBeUndefined();

      const res = await callRoute(billingCheckout, { token, body: { tier, term, origin: "pricing" } });
      expect(res.statusCode).toBe(200);
      const s = world.stripe.lastSession();
      expect(res.body).toEqual({ url: s.url });

      const price = PRICE_IDS[tier][term];
      const meta = { tenant_id: T1, tier, term };
      expect(s.params).toEqual({
        mode: "subscription",
        line_items: [{ price, quantity: 1 }],
        client_reference_id: T1,
        metadata: meta,
        subscription_data: { metadata: meta },
        allow_promotion_codes: true,
        success_url: `${BASE}/workspace?tab=settings&billing=success#billing`,
        cancel_url: `${BASE}/pricing?billing=cancel`,
      });
      expect(s.opts).toEqual({ idempotencyKey: checkoutIdempotencyKey(T1, tier, s.params) });
      if (term === "6mo") expect(world.stripe.api.prices.retrieve).toHaveBeenCalledWith(price);
      else expect(world.stripe.api.prices.retrieve).not.toHaveBeenCalled();

      const paid = world.sim.completeSubscriptionCheckout(s.id, { apiShape: term === "6mo" ? "basil" : "acacia" });
      expect(paid.priceId).toBe(price);
      expect(paid.sub.periodEnd - paid.sub.periodStart).toBe((term === "6mo" ? 6 : 1) * 30 * 86_400);

      const { handler, deps } = journeyWebhook();
      const ordered =
        order === "session-first"
          ? [paid.events.sessionCompleted, paid.events.subscriptionCreated]
          : [paid.events.subscriptionCreated, paid.events.sessionCompleted];
      const [r1, r2] = [await deliver(handler, ordered[0]), await deliver(handler, ordered[1])];
      expect([r1.statusCode, r2.statusCode]).toEqual([200, 200]);
      const [sessRes, subRes] = order === "session-first" ? [r1, r2] : [r2, r1];
      expect(sessRes.body).toMatchObject({ ok: true, note: "binding-via-subscription-event" });
      expect(subRes.body).toMatchObject({ ok: true, plan: "team", status: "active", tier });

      const ec = paid.events.subscriptionCreated.created;
      expect(deps.applyState).toHaveBeenCalledTimes(1);
      expect(deps.applyState).toHaveBeenCalledWith({
        tenant_id: T1,
        customer_id: paid.customer,
        subscription_id: paid.sub.id,
        plan: "team",
        status: "active",
        current_period_end: new Date(paid.sub.periodEnd * 1000).toISOString(),
        cancel_at_period_end: false,
        event_created: ec,
      });
      expect(deps.setTier).toHaveBeenCalledTimes(1);
      expect(deps.setTier).toHaveBeenCalledWith(T1, tier, ec);
      expect(deps.setMonthlyCredits).toHaveBeenCalledWith(T1, null, null, ec);
      expect(deps.applyCreditTopup).not.toHaveBeenCalled();
      expect(deps.markProcessed).toHaveBeenCalledWith(paid.events.subscriptionCreated.id, "customer.subscription.created");
      expect(deps.markProcessed).toHaveBeenCalledWith(paid.events.sessionCompleted.id, "checkout.session.completed");
      const markSub = deps.markProcessed.mock.invocationCallOrder[order === "session-first" ? 1 : 0];
      expect(deps.applyState.mock.invocationCallOrder[0]).toBeLessThan(deps.setTier.mock.invocationCallOrder[0]);
      expect(deps.setTier.mock.invocationCallOrder[0]).toBeLessThan(deps.setMonthlyCredits.mock.invocationCallOrder[0]);
      expect(deps.setMonthlyCredits.mock.invocationCallOrder[0]).toBeLessThan(markSub);

      expect(world.db.row(T1)).toMatchObject({
        stripe_customer_id: paid.customer,
        stripe_subscription_id: paid.sub.id,
        plan: "team",
        status: "active",
        tier,
        current_period_end: new Date(paid.sub.periodEnd * 1000).toISOString(),
      });
      expect(world.db.tenantByCustomer(paid.customer)).toBe(T1);
      expect(world.db.effectiveTier(T1)).toBe(tier);
      expect(world.db.monthlyAllowance(T1)).toBe(DEFAULT_TIER_CREDITS[tier]);
    },
  );

  it("a double click opens ONE Checkout session; the same tier from the workspace opens its own", async () => {
    const token = world.signIn(T1);
    const a = await callRoute(billingCheckout, { token, body: { tier: "growth" } });
    const b = await callRoute(billingCheckout, { token, body: { tier: "growth" } });
    expect(a.statusCode).toBe(200);
    expect(b.body.url).toBe(a.body.url);
    expect(world.stripe.api.checkout.sessions.create).toHaveBeenCalledTimes(2);
    expect(world.stripe.sessionCount).toBe(1);

    const c = await callRoute(billingCheckout, { token, body: { tier: "growth", origin: "workspace" } });
    expect(c.statusCode).toBe(200);
    expect(world.stripe.sessionCount).toBe(2);
    expect(world.stripe.lastSession().params.cancel_url).toBe(`${BASE}/workspace?tab=settings&billing=cancel`);
    await callRoute(billingCheckout, { token, body: { tier: "pro", origin: "constructor" } });
    expect(world.stripe.lastSession().params.cancel_url).toBe(`${BASE}/pricing?billing=cancel`);
  });

  it("the same tier retried after the session params changed opens a new session, not a Stripe idempotency error", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-23T10:00:05Z"));
    const prevBase = process.env.PRAXIS_PUBLIC_BASE;
    try {
      const token = world.signIn(T1);
      const a = await callRoute(billingCheckout, { token, body: { tier: "starter" } });
      expect(a.statusCode).toBe(200);
      process.env.PRAXIS_PUBLIC_BASE = "https://app.zaviagent.com";
      const b = await callRoute(billingCheckout, { token, body: { tier: "starter" } });
      expect(b.statusCode).toBe(200);
      expect(b.body.url).not.toBe(a.body.url);
      expect(world.stripe.sessionCount).toBe(2);
    } finally {
      if (prevBase === undefined) delete process.env.PRAXIS_PUBLIC_BASE;
      else process.env.PRAXIS_PUBLIC_BASE = prevBase;
      vi.useRealTimers();
    }
  });

  it("the same click an hour later hands back the SAME still-payable session, so it cannot be paid twice", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const token = world.signIn(T1);
      vi.setSystemTime(new Date("2026-09-23T10:00:05Z"));
      const a = await callRoute(billingCheckout, { token, body: { tier: "growth" } });
      vi.setSystemTime(new Date("2026-09-23T11:00:05Z"));
      const b = await callRoute(billingCheckout, { token, body: { tier: "growth" } });
      expect(b.statusCode).toBe(200);
      expect(b.body.url).toBe(a.body.url);
      expect(world.stripe.sessionCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("first payment still confirming: created(incomplete) → updated(active) a few seconds later → tier on the update", async () => {
    const token = world.signIn(T1);
    await callRoute(billingCheckout, { token, body: { tier: "pro" } });
    const paid = world.sim.completeSubscriptionCheckout(world.stripe.lastSession().id, { status: "incomplete" });
    const { handler, deps } = journeyWebhook();

    expect((await deliver(handler, paid.events.subscriptionCreated)).statusCode).toBe(200);
    expect(deps.applyState).toHaveBeenLastCalledWith(expect.objectContaining({ status: "incomplete", plan: "team" }));
    expect(deps.setTier).toHaveBeenLastCalledWith(T1, "keep", paid.events.subscriptionCreated.created);
    expect(world.db.effectiveTier(T1)).toBe("free");

    const activated = world.sim.updateSubscription(paid.sub.id, { status: "active" }, paid.events.subscriptionCreated.created + 3);
    expect((await deliver(handler, activated)).statusCode).toBe(200);
    expect((await deliver(handler, paid.events.sessionCompleted)).statusCode).toBe(200);
    expect(deps.setTier).toHaveBeenLastCalledWith(T1, "pro", activated.created);
    expect(world.db.row(T1)?.status).toBe("active");
    expect(world.db.effectiveTier(T1)).toBe("pro");
  });
});

describe("B. six-month price validation (read back from Stripe before it is sold)", () => {
  it.each<[string, Partial<PriceLike>]>([
    ["the monthly amount ($120)", { unit_amount: 12_000 }],
    ["the undiscounted amount ($720)", { unit_amount: 72_000 }],
    ["interval_count 1 (the half-price total billed EVERY month)", { recurring: { interval: "month", interval_count: 1 } }],
    ["interval year", { recurring: { interval: "year", interval_count: 1 } }],
    ["interval week x6", { recurring: { interval: "week", interval_count: 6 } }],
    ["currency eur", { currency: "eur" }],
    ["archived (active=false)", { active: false }],
    ["no unit amount", { unit_amount: null }],
  ])("growth six-month price with %s → 503 price_misconfigured, no session, error logged", async (_label, patch) => {
    world.stripe.setPrice(PRICE_IDS.growth["6mo"], patch);
    const token = world.signIn(T1);
    const res = await callRoute(billingCheckout, { token, body: { tier: "growth", term: "6mo" } });
    expect(res.statusCode).toBe(503);
    expect(res.body.error.code).toBe("price_misconfigured");
    expect(world.stripe.api.prices.retrieve).toHaveBeenCalledWith(PRICE_IDS.growth["6mo"]);
    expect(world.stripe.sessionCount).toBe(0);
    expect(world.logs).toContainEqual(
      expect.objectContaining({ level: "error", code: "billing.six_month_price_mismatch", tenant_id: T1 }),
    );
  });

  it.each(PAID_TIERS)("%s six-month price made exactly to the quote → a Checkout session on it", async (tier) => {
    const token = world.signIn(T1);
    const res = await callRoute(billingCheckout, { token, body: { tier, term: "6mo" } });
    expect(res.statusCode).toBe(200);
    expect(world.stripe.lastSession().params.line_items).toEqual([{ price: PRICE_IDS[tier]["6mo"], quantity: 1 }]);
    const p = world.stripe.prices.get(PRICE_IDS[tier]["6mo"]);
    expect(p?.unit_amount).toBe(sixMonthUsd(tier) * 100);
  });

  it("the six-month price id does not exist in Stripe → 502 stripe_error, no session", async () => {
    world.stripe.prices.delete(PRICE_IDS.pro["6mo"]);
    const token = world.signIn(T1);
    const res = await callRoute(billingCheckout, { token, body: { tier: "pro", term: "6mo" } });
    expect(res.statusCode).toBe(502);
    expect(res.body.error.code).toBe("stripe_error");
    expect(world.stripe.sessionCount).toBe(0);
  });
});

describe("C. checkout request validation and billing configuration", () => {
  it("no Authorization header → 401, nothing read, no Stripe call", async () => {
    const res = await callRoute(billingCheckout, { token: null, body: { tier: "starter" } });
    expect(res.statusCode).toBe(401);
    expect(res.body.error.code).toBe("unauthenticated");
    expect(world.db.reads).toHaveLength(0);
    expect(world.stripe.api.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("a token that maps to no session → 401", async () => {
    const res = await callRoute(billingCheckout, { token: "tok_forged", body: { tier: "pro" } });
    expect(res.statusCode).toBe(401);
    expect(world.stripe.api.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it.each([["free"], ["enterprise"], ["Starter"], ["team"], [""], [20], [null], [undefined]])(
    "tier=%j → 400 bad_tier, no Stripe call",
    async (tier) => {
      const token = world.signIn(T1);
      const res = await callRoute(billingCheckout, { token, body: { tier } });
      expect(res.statusCode).toBe(400);
      expect(res.body.error.code).toBe("bad_tier");
      expect(world.stripe.api.checkout.sessions.create).not.toHaveBeenCalled();
    },
  );

  it.each([["annual"], ["6MO"], ["six_month"], [6], [null], [""]])(
    "term=%j → 400 bad_term (never silently billed monthly)",
    async (term) => {
      const token = world.signIn(T1);
      const res = await callRoute(billingCheckout, { token, body: { tier: "growth", term } });
      expect(res.statusCode).toBe(400);
      expect(res.body.error.code).toBe("bad_term");
      expect(world.stripe.api.checkout.sessions.create).not.toHaveBeenCalled();
    },
  );

  it("six-month env missing for that tier → 503 price_not_configured, never the monthly price", async () => {
    delete process.env[PRICE_ENV.pro["6mo"]];
    expect(billingConfigured()).toBe(true);
    const token = world.signIn(T1);
    const res = await callRoute(billingCheckout, { token, body: { tier: "pro", term: "6mo" } });
    expect(res.statusCode).toBe(503);
    expect(res.body.error.code).toBe("price_not_configured");
    expect(world.stripe.sessionCount).toBe(0);
    const monthly = await callRoute(billingCheckout, { token, body: { tier: "pro" } });
    expect(monthly.statusCode).toBe(200);
  });

  it("a MONTHLY env missing → billing not configured at all → 503 billing_not_configured", async () => {
    delete process.env[PRICE_ENV.growth.monthly];
    const token = world.signIn(T1);
    const res = await callRoute(billingCheckout, { token, body: { tier: "starter" } });
    expect(res.statusCode).toBe(503);
    expect(res.body.error.code).toBe("billing_not_configured");
  });

  it("no platform key → 503 billing_not_configured on checkout, top-up and portal", async () => {
    delete process.env.STRIPE_PLATFORM_SECRET_KEY;
    const token = world.signIn(T1);
    for (const [handler, body] of [
      [billingCheckout, { tier: "starter" }],
      [billingTopup, { usd: 20 }],
      [billingPortal, {}],
    ] as const) {
      const res = await callRoute(handler, { token, body });
      expect(res.statusCode).toBe(503);
      expect(res.body.error.code).toBe("billing_not_configured");
    }
    expect(world.db.reads).toHaveLength(0);
  });

  it("a plain member cannot open Checkout or the Portal: 403, no Stripe session", async () => {
    world.db.seedSub(T1, { plan: "starter", stripe_customer_id: "cus_member", stripe_subscription_id: "sub_member", status: "active" });
    world.db.memberRole = "member";
    const token = world.signIn(T1);
    for (const [handler, body] of [
      [billingCheckout, { tier: "pro" }],
      [billingPortal, {}],
    ] as const) {
      const res = await callRoute(handler, { token, body });
      expect(res.statusCode).toBe(403);
      expect(res.body.error.code).toBe("forbidden");
    }
    expect(world.stripe.sessionCount).toBe(0);
  });

  it.each<[string, () => void]>([
    ["two monthly tiers share one price id", () => { process.env.STRIPE_PRICE_GROWTH_MONTHLY = PRICE_IDS.starter.monthly; }],
    ["a six-month id reuses its monthly id", () => { process.env.STRIPE_PRICE_PRO_6MO = PRICE_IDS.pro.monthly; }],
    ["two six-month tiers share one id", () => { process.env.STRIPE_PRICE_STARTER_6MO = PRICE_IDS.growth["6mo"]; }],
  ])("%s → billing treated as not configured → 503 everywhere", async (_label, misconfigure) => {
    misconfigure();
    expect(billingConfigured()).toBe(false);
    const token = world.signIn(T1);
    const res = await callRoute(billingCheckout, { token, body: { tier: "pro" } });
    expect(res.statusCode).toBe(503);
    expect(res.body.error.code).toBe("billing_not_configured");
    expect(world.stripe.sessionCount).toBe(0);
  });

  knownGap("KNOWN GAP C-9: with duplicate price ids the webhook refuses to map the billed price (today: Pro renewal lands as Starter)", async () => {
    const b = await subscribe(T1, "pro");
    process.env.STRIPE_PRICE_STARTER_MONTHLY = PRICE_IDS.pro.monthly;
    expect(billingConfigured()).toBe(false);
    const { handler, deps } = journeyWebhook();
    const res = await deliver(handler, world.sim.renew(b.sub.id));
    expect(deps.setTier).not.toHaveBeenCalledWith(T1, "starter", expect.any(Number));
    expect(res.statusCode).toBe(503);
    expect(world.db.effectiveTier(T1)).toBe("pro");
  });
});

describe("D. an existing subscriber clicks another plan", () => {
  it.each(["active", "trialing", "past_due"])(
    "%s subscriber → the /change-plan rules (never Stripe's free picker), no second Checkout",
    async (status) => {
      const b = await subscribe(T1, "starter");
      if (status !== "active") {
        const { handler } = journeyWebhook();
        expect((await deliver(handler, world.sim.updateSubscription(b.sub.id, { status }))).statusCode).toBe(200);
      }
      expect(world.db.row(T1)?.status).toBe(status);
      const sessionsBefore = world.stripe.sessionCount;
      changePlanFromCheckout.mockClear();

      const res = await callRoute(billingCheckout, { token: b.token, body: { tier: "pro", term: "6mo" } });
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatchObject({ redirect: expect.stringMatching(/^https:\/\/billing\.stripe\.test\//) });
      expect(changePlanFromCheckout).toHaveBeenCalledTimes(1);
      expect(world.stripe.api.billingPortal.sessions.create).not.toHaveBeenCalled();
      expect(world.stripe.sessionCount).toBe(sessionsBefore);
      expect(world.stripe.api.prices.retrieve).not.toHaveBeenCalled();
    },
  );

  it("the Manage button: a subscriber gets their Portal, a tenant who never bought gets 400 no_customer", async () => {
    const b = await subscribe(T1, "growth");
    const res = await callRoute(billingPortal, { token: b.token, body: {} });
    expect(res.statusCode).toBe(200);
    expect(world.stripe.api.billingPortal.sessions.create).toHaveBeenLastCalledWith({
      customer: b.customer,
      return_url: `${BASE}/workspace?tab=settings#billing`,
    });
    const other = world.signIn("33333333-cccc-4ccc-8ccc-000000000003");
    const none = await callRoute(billingPortal, { token: other, body: {} });
    expect(none.statusCode).toBe(400);
    expect(none.body.error.code).toBe("no_customer");
  });
});

describe("M. the public pricing page quotes what checkout sells", () => {
  it("six_month_available is true only when all three six-month prices are set", () => {
    expect(buildPublicPricing(null).six_month_available).toBe(true);
    for (const t of PAID_TIERS) {
      const key = PRICE_ENV[t]["6mo"];
      const saved = process.env[key];
      delete process.env[key];
      expect(buildPublicPricing(null).six_month_available).toBe(false);
      process.env[key] = "   ";
      expect(buildPublicPricing(null).six_month_available).toBe(false);
      process.env[key] = saved;
      expect(buildPublicPricing(null).six_month_available).toBe(true);
    }
    for (const t of PAID_TIERS) delete process.env[PRICE_ENV[t]["6mo"]];
    expect(buildPublicPricing(null).six_month_available).toBe(false);
  });

  it("every published amount matches plans.ts/tiers.ts and the Stripe price checkout validates against", () => {
    const b = buildPublicPricing(null);
    expect(b.tiers.map((x) => [x.slug, x.usd, x.six_month_usd, x.six_month_per_month_usd])).toEqual([
      ["free", 0, 0, 0],
      ["starter", 20, 60, 10],
      ["growth", 120, 360, 60],
      ["pro", 240, 720, 120],
    ]);
    expect(b.six_month_months).toBe(6);
    expect(b.six_month_discount_pct).toBe(50);
    for (const t of PAID_TIERS) {
      const card = b.tiers.find((x) => x.slug === t);
      expect(card?.usd).toBe(TIER_PRICE_USD[t]);
      expect(card?.six_month_usd).toBe(sixMonthUsd(t));
      const monthly = world.stripe.prices.get(PRICE_IDS[t].monthly) as PriceLike;
      const six = world.stripe.prices.get(PRICE_IDS[t]["6mo"]) as PriceLike;
      expect(monthly.unit_amount).toBe((card?.usd ?? 0) * 100);
      expect(six.unit_amount).toBe((card?.six_month_usd ?? 0) * 100);
      expect(sixMonthPriceMismatch(t, six)).toBeNull();
    }
  });

  it("credits come from tier_credits (defaults when absent); packs are the same pools; daily grant from config", () => {
    const d = buildPublicPricing(null);
    expect(d.tiers.map((x) => x.monthly_credits)).toEqual([0, 8_000, 48_000, 96_000]);
    expect(d.free_daily_credits).toBe(1_000);
    expect(d.topup_packs).toEqual([
      { usd: 20, credits: 8_000 },
      { usd: 120, credits: 48_000 },
      { usd: 240, credits: 96_000 },
    ]);
    const tuned = buildPublicPricing({ tier_credits: { growth: 60_000, pro: "bad" }, free_daily_credits: 1_500 });
    expect(tuned.tiers.map((x) => x.monthly_credits)).toEqual([0, 8_000, 60_000, 96_000]);
    expect(tuned.topup_packs.map((p) => p.credits)).toEqual([8_000, 60_000, 96_000]);
    expect(tuned.tiers.every((x) => x.daily_credits === 1_500)).toBe(true);
    for (const t of PAID_TIERS) {
      const card = tuned.tiers.find((x) => x.slug === t);
      expect(card?.monthly_credits).toBe({ starter: 8_000, growth: 60_000, pro: 96_000 }[t]);
      expect(card?.includes.join(" ")).not.toMatch(/credits a month/);
    }
  });

  it("GET /api/public/pricing reads the live system_config row and is edge-cacheable", async () => {
    world.db.config = { tier_credits: { starter: 9_000, growth: 48_000, pro: 96_000 }, free_daily_credits: 1_000 };
    const res = mockRes();
    await publicPricing({} as Request, res as unknown as Response);
    expect(res.body.tiers[1]).toMatchObject({ slug: "starter", usd: 20, monthly_credits: 9_000 });
    expect(res.body.topup_packs[0]).toEqual({ usd: 20, credits: 9_000 });
    expect(res.headers["Cache-Control"]).toMatch(/max-age=60/);
  });

  it("FLAG M-5: the page offers six-month while checkout refuses the misconfigured price", async () => {
    world.stripe.setPrice(PRICE_IDS.growth["6mo"], { recurring: { interval: "month", interval_count: 1 } });
    expect(buildPublicPricing(null).six_month_available).toBe(true);
    const token = world.signIn(T1);
    const res = await callRoute(billingCheckout, { token, body: { tier: "growth" as PaidTier, term: "6mo" } });
    expect(res.statusCode).toBe(503);
    expect(res.body.error.code).toBe("price_misconfigured");
  });
});
