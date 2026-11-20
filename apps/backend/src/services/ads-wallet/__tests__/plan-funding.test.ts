import { describe, expect, it, vi } from "vitest";
import { fundApprovedPlan, fundingWindow, planOrderId } from "@/services/ads-wallet/plan-funding";

const NOW = Date.parse("2026-10-15T12:00:00Z");
const A = { action_id: "act-1", actor_user_id: "u1", shortfall_cents: 5800, proposed_at_ms: NOW - 60_000 };
const deps = (over: Record<string, unknown> = {}) => ({
  fundingEnabled: () => true,
  claim: vi.fn(async () => ({ status: "claimed", order_status: "pending" })),
  charge: vi.fn(async () => ({ ok: true, card: "Visa ending 4242" })),
  link: vi.fn(async () => "https://checkout.stripe.com/c/pay_x"),
  ...over,
});

describe("fundApprovedPlan", () => {
  it("a consented saved card: charge exactly the shortfall, once per action window", async () => {
    const d = deps();
    const r = await fundApprovedPlan("t1", A, NOW, d);
    expect(r).toEqual({ kind: "charged", line: "I charged $58.00 to your saved card (Visa ending 4242) for the ChatGPT balance. The ad starts when the payment lands." });
    expect(d.claim).toHaveBeenCalledWith("t1", planOrderId("act-1", 0), 5800);
    expect(d.charge).toHaveBeenCalledWith("t1", planOrderId("act-1", 0), 5800);
    expect(d.link).not.toHaveBeenCalled();
  });
  it("no consented card (or the daily cap): a Checkout link for exactly the shortfall", async () => {
    for (const status of ["no_consented_card", "daily_cap"]) {
      const d = deps({ claim: vi.fn(async () => ({ status })) });
      expect(await fundApprovedPlan("t1", A, NOW, d)).toEqual({ kind: "link", line: "Add $58.00 to start: https://checkout.stripe.com/c/pay_x" });
      expect(d.link).toHaveBeenCalledWith("t1", "u1", 5800, planOrderId("act-1", 10));
      expect(d.charge).not.toHaveBeenCalled();
    }
  });
  it("a declined charge falls back to the link; never above the shortfall", async () => {
    const d = deps({ charge: vi.fn(async () => ({ ok: false, card: null })) });
    const r = await fundApprovedPlan("t1", A, NOW, d);
    expect(r.kind).toBe("link");
    expect(d.link).toHaveBeenCalledWith("t1", "u1", 5800, expect.any(String));
  });
  it("after 24h a fresh link (a new order id); after 48h the ad is dropped and nothing is sent", async () => {
    const d = deps({ claim: vi.fn(async () => ({ status: "no_consented_card" })) });
    await fundApprovedPlan("t1", { ...A, proposed_at_ms: NOW - 25 * 3_600_000 }, NOW, d);
    expect(d.link).toHaveBeenCalledWith("t1", "u1", 5800, planOrderId("act-1", 11));
    const late = deps();
    expect((await fundApprovedPlan("t1", { ...A, proposed_at_ms: NOW - 49 * 3_600_000 }, NOW, late)).kind).toBe("dropped");
    expect(late.claim).not.toHaveBeenCalled();
    expect(late.link).not.toHaveBeenCalled();
  });
  it("funding off -> nothing; over $1,000 -> no charge", async () => {
    const off = deps({ fundingEnabled: () => false });
    expect((await fundApprovedPlan("t1", A, NOW, off)).kind).toBe("unavailable");
    const big = deps();
    expect((await fundApprovedPlan("t1", { ...A, shortfall_cents: 150_000 }, NOW, big)).kind).toBe("unavailable");
    expect(big.claim).not.toHaveBeenCalled();
  });
  it("order ids are deterministic uuids per action and window", () => {
    expect(planOrderId("a", 0)).toBe(planOrderId("a", 0));
    expect(planOrderId("a", 0)).not.toBe(planOrderId("a", 1));
    expect(planOrderId("a", 0)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect([fundingWindow(NOW, NOW), fundingWindow(NOW - 25 * 3_600_000, NOW), fundingWindow(NOW - 48 * 3_600_000, NOW)]).toEqual([0, 1, null]);
  });
});

describe("one charge per action across the 24h window (F1)", () => {
  it("a retry in window 1 after a window-0 charge reuses the same order (the same Stripe idempotency key): no second charge", async () => {
    const orders = new Map<string, string>();
    const charged = new Set<string>();
    const d = deps({
      claim: vi.fn(async (_t: string, order: string) => {
        const prior = orders.get(order);
        orders.set(order, prior ?? "pending");
        return { status: "claimed", order_status: prior ?? "pending" };
      }),
      charge: vi.fn(async (_t: string, order: string) => (charged.add(order), { ok: true, card: null })),
    });
    await fundApprovedPlan("t1", A, NOW, d);
    await fundApprovedPlan("t1", { ...A, proposed_at_ms: NOW - 25 * 3_600_000 }, NOW, d);
    expect((d.claim.mock.calls as unknown as string[][]).map((c) => c[1])).toEqual([planOrderId("act-1", 0), planOrderId("act-1", 0)]);
    expect(orders.size).toBe(1);
    expect(charged.size).toBe(1);
  });
});

describe("a replayed order is never charged again (re-review F1)", () => {
  it("pending with a payment on file after 24h: no new charge, the payment is on its way", async () => {
    const d = deps({ claim: vi.fn(async () => ({ status: "claimed", order_status: "pending", replayed: true, payment_intent_id: "pi_1" })) });
    const r = await fundApprovedPlan("t1", { ...A, proposed_at_ms: NOW - 25 * 3_600_000 }, NOW, d);
    expect(r).toEqual({ kind: "charged", line: "The $58.00 payment for the ChatGPT balance is on its way; the ad starts when it lands." });
    expect(d.charge).not.toHaveBeenCalled();
    expect(d.link).not.toHaveBeenCalled();
  });
  it("failed: no new charge, a Checkout link", async () => {
    const d = deps({ claim: vi.fn(async () => ({ status: "claimed", order_status: "failed", replayed: true, payment_intent_id: "pi_1" })) });
    expect((await fundApprovedPlan("t1", A, NOW, d)).kind).toBe("link");
    expect(d.charge).not.toHaveBeenCalled();
  });
});
