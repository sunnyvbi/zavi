
import { describe, expect, it, vi } from "vitest";
import { settleUnpaidCheckout, type SettleUnpaidCheckoutDeps } from "../checkout-expiry";
import type { FulfilCreatorCheckoutResult } from "../checkout-fulfil";

const TENANT = "11111111-1111-1111-1111-111111111111";
const ORDER = "22222222-2222-2222-2222-222222222222";
const NOW = "2026-09-27T12:00:00.000Z";
const H = 3_600_000;
const plus = (ms: number) => new Date(new Date(NOW).getTime() + ms).toISOString();

type Row = Parameters<typeof settleUnpaidCheckout>[0];
const row = (over: Partial<Row> = {}): Row => ({
  id: ORDER,
  tenant_id: TENANT,
  source: "booking",
  status: "checkout_pending",
  livemode: true,
  ...over,
});

function deps(opts: {
  fulfil?: FulfilCreatorCheckoutResult;
  session?: { id: string; status: string; expires_at?: number } | null;
  sessionId?: string | null;
  keyLive?: boolean;
  expireFails?: boolean;
} = {}) {
  const retrieve = vi.fn(async (id: string) => ({ ...(opts.session ?? { status: "expired" }), id }));
  const expire = vi.fn(async (id: string) => {
    if (opts.expireFails) throw new Error("This Checkout Session is not open");
    return { id, status: "expired" };
  });
  const fulfil = vi.fn(async () => opts.fulfil ?? ({ state: "pending", order_id: ORDER, reason: "no_payment_intent" } as const));
  const d: SettleUnpaidCheckoutDeps = {
    fulfil: fulfil as unknown as SettleUnpaidCheckoutDeps["fulfil"],
    loadOrder: (async () => ({
      id: ORDER,
      tenant_id: TENANT,
      status: "checkout_pending",
      stripe_checkout_session_id: opts.sessionId === undefined ? "cs_1" : opts.sessionId,
    })) as unknown as SettleUnpaidCheckoutDeps["loadOrder"],
    stripe: (() => ({ checkout: { sessions: { retrieve, expire } } })) as unknown as SettleUnpaidCheckoutDeps["stripe"],
    keyLivemode: () => opts.keyLive ?? true,
    now: () => new Date(NOW),
    log: (async () => {}) as unknown as SettleUnpaidCheckoutDeps["log"],
  };
  return { d, retrieve, expire, fulfil };
}

describe("settleUnpaidCheckout", () => {
  it("a payment that actually went through is fulfilled, never closed", async () => {
    const { d, retrieve } = deps({
      fulfil: { state: "fulfilled", order_id: ORDER, status: "awaiting_acceptance", payment_intent_id: "pi_1", hold_expires_at: null },
    });
    expect(await settleUnpaidCheckout(row(), d)).toEqual({ action: "settled", state: "fulfilled" });
    expect(retrieve).not.toHaveBeenCalled();
  });

  it("money in a shape only staff can sort out is never closed, and is looked at daily", async () => {
    const { d } = deps({ fulfil: { state: "needs_staff", order_id: ORDER, message: "x" } });
    expect(await settleUnpaidCheckout(row(), d)).toEqual({ action: "wait", until: plus(24 * H), reason: "needs_staff" });
  });

  it("a hire waiting on another hire for the same brief keeps its hold", async () => {
    const { d } = deps({ fulfil: { state: "pending", order_id: ORDER, reason: "brief_held" } });
    expect(await settleUnpaidCheckout(row({ source: "applicant" }), d)).toEqual({ action: "wait", until: plus(H), reason: "brief_held" });
  });

  it("closes once Stripe says the page expired", async () => {
    const { d } = deps({ session: { id: "cs_1", status: "expired" } });
    expect(await settleUnpaidCheckout(row(), d)).toEqual({ action: "close" });
  });

  it("closes an order that never had a payment page attached", async () => {
    const { d, retrieve } = deps({ sessionId: null });
    expect(await settleUnpaidCheckout(row(), d)).toEqual({ action: "close" });
    expect(retrieve).not.toHaveBeenCalled();
  });

  it("a completed page whose hold is not visible yet is never closed", async () => {
    const { d } = deps({ session: { id: "cs_1", status: "complete" } });
    expect(await settleUnpaidCheckout(row(), d)).toEqual({ action: "wait", until: plus(H), reason: "complete_not_held" });
  });

  it("an open page for a booking or hire gets its full Stripe window", async () => {
    const expiresAt = new Date(plus(5 * H)).getTime() / 1000;
    for (const source of ["booking", "applicant"] as const) {
      const { d, expire } = deps({ session: { id: "cs_1", status: "open", expires_at: expiresAt } });
      expect(await settleUnpaidCheckout(row({ source }), d)).toEqual({ action: "wait", until: plus(6 * H), reason: "session_open" });
      expect(expire).not.toHaveBeenCalled();
    }
  });

  it("an expired offer's open page is expired at Stripe FIRST, then the order closes", async () => {
    const { d, expire } = deps({ session: { id: "cs_1", status: "open", expires_at: 0 } });
    expect(await settleUnpaidCheckout(row({ source: "offer" }), d)).toEqual({ action: "close" });
    expect(expire).toHaveBeenCalledWith("cs_1");
  });

  it("if Stripe refuses the expire (the payment just landed) nothing closes", async () => {
    const { d } = deps({ session: { id: "cs_1", status: "open", expires_at: 0 }, expireFails: true });
    await expect(settleUnpaidCheckout(row({ source: "offer" }), d)).rejects.toThrow(/not open/);
  });

  it("a TEST order in a live process closes without asking Stripe; a LIVE order in a test process is never closed blind", async () => {
    const live = deps({ keyLive: true });
    expect(await settleUnpaidCheckout(row({ livemode: false }), live.d)).toEqual({ action: "close" });
    expect(live.fulfil).not.toHaveBeenCalled();

    const test = deps({ keyLive: false });
    expect(await settleUnpaidCheckout(row({ livemode: true }), test.d)).toEqual({ action: "skip", reason: "live_order_test_key" });
    expect(test.fulfil).not.toHaveBeenCalled();
  });
});
