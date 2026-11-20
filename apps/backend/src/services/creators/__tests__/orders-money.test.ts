
import type Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExpectedToolError } from "@/services/tools/types";
import type { CreatorMoneyEventInsert, CreatorOrderMoneyRow, CreatorPayoutAccountRow } from "../db";
import {
  cancelCreatorHold,
  createCreatorSavedCardHold,
  releaseOrphanCreatorHold,
  captureCreatorHold,
  createCreatorCheckoutHold,
  readCreatorHold,
  recordCreatorHold,
  recordCreatorMoneyObservation,
  refundCreatorOrder,
  transferToCreator,
  type CreatorMoneyDeps,
} from "../orders-money";

const TENANT = "11111111-1111-1111-1111-111111111111";
const ORDER = "22222222-2222-2222-2222-222222222222";
const CREATOR = "33333333-3333-3333-3333-333333333333";

function makeOrder(over: Partial<CreatorOrderMoneyRow> = {}): CreatorOrderMoneyRow {
  return {
    id: ORDER,
    tenant_id: TENANT,
    human_member_id: CREATOR,
    livemode: false,
    currency: "usd",
    price_cents: 15_000,
    business_fee_cents: 1_500,
    creator_fee_cents: 2_250,
    business_total_cents: 16_500,
    creator_payout_cents: 12_750,
    payout_amount_cents: null,
    status: "checkout_pending",
    payout_status: "not_due",
    stripe_checkout_session_id: null,
    stripe_payment_intent_id: null,
    stripe_transfer_id: null,
    hold_expires_at: null,
    ...over,
  };
}

function makeAccount(over: Partial<CreatorPayoutAccountRow> = {}): CreatorPayoutAccountRow {
  return {
    id: "pa1",
    human_member_id: CREATOR,
    stripe_account_id: "acct_creator1",
    livemode: false,
    country: "US",
    details_submitted: true,
    payouts_enabled: true,
    disabled_reason: null,
    ...over,
  };
}

type AnyFn = (...args: any[]) => any;

function harness(opts: {
  order?: CreatorOrderMoneyRow;
  account?: CreatorPayoutAccountRow | null;
  key?: string;
} = {}) {
  const order = opts.order ?? makeOrder();
  const account = opts.account === undefined ? makeAccount() : opts.account;
  const events: CreatorMoneyEventInsert[] = [];
  const logs: Array<{ code?: string; meta?: Record<string, unknown> }> = [];

  const stripe = {
    checkout: {
      sessions: { create: vi.fn<any[], any>(async () => ({ id: "cs_1", url: "https://pay" })) },
    },
    paymentIntents: {
      retrieve: vi.fn<any[], any>(),
      capture: vi.fn<any[], any>(),
      cancel: vi.fn<any[], any>(),
    },
    transfers: {
      create: vi.fn<any[], any>(async () => ({ id: "tr_1", amount: 12_750 })),
      createReversal: vi.fn<any[], any>(async () => ({ id: "trr_1", amount: 12_750 })),
      listReversals: vi.fn<any[], any>(async () => ({ data: [] })),
    },
    refunds: {
      create: vi.fn<any[], any>(async () => ({ id: "re_1", amount: 16_500 })),
      list: vi.fn<any[], any>(async () => ({ data: [] })),
    },
    disputes: {
      list: vi.fn<any[], any>(async () => ({ data: [] })),
    },
    accounts: {
      retrieve: vi.fn<any[], any>(async () => ({
        id: "acct_creator1",
        capabilities: { transfers: "active" },
      })),
    },
  } satisfies Record<string, Record<string, Record<string, AnyFn> | AnyFn>>;

  const claimTransfer = vi.fn<any[], any>(async () => order);
  const markTransferred = vi.fn<any[], any>(async () => 1);
  const releaseTransferClaim = vi.fn<any[], any>(async () => 1);

  const deps: CreatorMoneyDeps = {
    stripe: () => stripe as unknown as Stripe,
    loadOrder: async (tenant_id, order_id) =>
      tenant_id === order.tenant_id && order_id === order.id ? order : null,
    recordEvent: async (row) => {
      if (events.some((e) => e.idempotency_key === row.idempotency_key)) return "duplicate";
      events.push(row);
      return "inserted";
    },
    findEvent: async (_tenant_id, key) => {
      const hit = events.find((e) => e.idempotency_key === key);
      return hit
        ? { amount_cents: hit.amount_cents, stripe_object_id: hit.stripe_object_id ?? null }
        : null;
    },
    loadPayoutAccount: async () => account,
    claimTransfer,
    markTransferred,
    releaseTransferClaim,
    platformKey: () => opts.key ?? "sk_test_fake",
    log: async (input) => {
      logs.push({ code: input.code, meta: input.meta });
    },
  };

  return { deps, events, logs, stripe, claimTransfer, markTransferred, releaseTransferClaim };
}

function pi(status: string, over: Record<string, unknown> = {}) {
  return {
    id: "pi_1",
    status,
    amount: 16_500,
    latest_charge: {
      id: "ch_1",
      payment_method_details: { card: { capture_before: 1_800_000_000 } },
    },
    ...over,
  };
}

describe("createCreatorCheckoutHold", () => {
  it("opens a MANUAL-capture checkout for the fee-inclusive total", async () => {
    const h = harness();
    const out = await createCreatorCheckoutHold(
      {
        tenant_id: TENANT,
        order_id: ORDER,
        creator_country: "US",
        success_url: "https://app/ok",
        cancel_url: "https://app/no",
      },
      h.deps,
    );

    expect(out).toEqual({ checkout_session_id: "cs_1", url: "https://pay", amount_cents: 16_500 });
    const [params, options] = h.stripe.checkout.sessions.create.mock.calls[0];
    expect(params.payment_intent_data.capture_method).toBe("manual");
    expect(params.payment_intent_data.transfer_group).toBe(`creator_order_${ORDER}`);
    expect(params.line_items[0].price_data.unit_amount).toBe(16_500);
    expect(params.client_reference_id).toBe(ORDER);
    expect(options).toEqual({ idempotencyKey: `cr-checkout-${ORDER}` });
    expect(h.events).toHaveLength(0);
  });

  it("refuses a creator outside Stripe payout reach, before any Stripe call (invariant 7)", async () => {
    const h = harness();
    await expect(
      createCreatorCheckoutHold(
        {
          tenant_id: TENANT,
          order_id: ORDER,
          creator_country: "IN",
          success_url: "https://app/ok",
          cancel_url: "https://app/no",
        },
        h.deps,
      ),
    ).rejects.toThrowError(/outside Stripe's payout reach/);
    expect(h.stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("refuses an order that is not awaiting checkout (no second hold)", async () => {
    const h = harness({ order: makeOrder({ status: "in_progress" }) });
    await expect(
      createCreatorCheckoutHold(
        {
          tenant_id: TENANT,
          order_id: ORDER,
          creator_country: "US",
          success_url: "https://app/ok",
          cancel_url: "https://app/no",
        },
        h.deps,
      ),
    ).rejects.toThrowError(/second charge/);
    expect(h.stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("refuses a live-mode order under a test key, before any Stripe call", async () => {
    const h = harness({ order: makeOrder({ livemode: true }) });
    await expect(
      createCreatorCheckoutHold(
        {
          tenant_id: TENANT,
          order_id: ORDER,
          creator_country: "US",
          success_url: "https://app/ok",
          cancel_url: "https://app/no",
        },
        h.deps,
      ),
    ).rejects.toThrowError(/No money operation runs across that boundary/);
    expect(h.stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("refuses a test-mode order under a live key", async () => {
    const h = harness({ order: makeOrder({ livemode: false }), key: "sk_live_fake" });
    await expect(
      createCreatorCheckoutHold(
        {
          tenant_id: TENANT,
          order_id: ORDER,
          creator_country: "US",
          success_url: "https://app/ok",
          cancel_url: "https://app/no",
        },
        h.deps,
      ),
    ).rejects.toThrowError(/livemode|boundary/i);
  });

  it("refuses an order whose stored fees drifted from the fee rule (invariant 8)", async () => {
    const h = harness({ order: makeOrder({ business_fee_cents: 10, business_total_cents: 15_010 }) });
    await expect(
      createCreatorCheckoutHold(
        {
          tenant_id: TENANT,
          order_id: ORDER,
          creator_country: "US",
          success_url: "https://app/ok",
          cancel_url: "https://app/no",
        },
        h.deps,
      ),
    ).rejects.toThrowError(/do not match the fee rule/);
    expect(h.stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("refuses an order that belongs to another workspace", async () => {
    const h = harness();
    await expect(
      createCreatorCheckoutHold(
        {
          tenant_id: "99999999-9999-9999-9999-999999999999",
          order_id: ORDER,
          creator_country: "US",
          success_url: "https://app/ok",
          cancel_url: "https://app/no",
        },
        h.deps,
      ),
    ).rejects.toThrowError(ExpectedToolError);
  });
});

describe("readCreatorHold / recordCreatorHold", () => {
  it("reads the hold from the PaymentIntent, including a released one (S0 learning 5)", async () => {
    const h = harness();
    h.stripe.paymentIntents.retrieve.mockResolvedValueOnce(pi("canceled"));
    const state = await readCreatorHold("pi_1", h.deps);
    expect(state.released).toBe(true);
    expect(state.held).toBe(false);
    expect(state.captured).toBe(false);
    expect(h.stripe.paymentIntents.retrieve).toHaveBeenCalledWith("pi_1", {
      expand: ["latest_charge"],
    });
  });

  it("writes one hold event with the hold key when the PI is requires_capture", async () => {
    const h = harness({ order: makeOrder({ stripe_payment_intent_id: "pi_1" }) });
    h.stripe.paymentIntents.retrieve.mockResolvedValue(pi("requires_capture"));
    const state = await recordCreatorHold(
      { tenant_id: TENANT, order_id: ORDER, payment_intent_id: "pi_1", cause: "booking" },
      h.deps,
    );
    expect(state.hold_expires_at).toBe(new Date(1_800_000_000 * 1000).toISOString());
    expect(h.events).toEqual([
      expect.objectContaining({
        kind: "hold",
        cause: "booking",
        amount_cents: 16_500,
        livemode: false,
        idempotency_key: `cr-hold-${ORDER}`,
        stripe_object_id: "pi_1",
      }),
    ]);

    await recordCreatorHold(
      { tenant_id: TENANT, order_id: ORDER, payment_intent_id: "pi_1", cause: "booking" },
      h.deps,
    );
    expect(h.events).toHaveLength(1);
  });

  it("names the approver as the hold's actor when a person approved it (autopilot tracking T1)", async () => {
    const h = harness({ order: makeOrder({ stripe_payment_intent_id: "pi_1" }) });
    h.stripe.paymentIntents.retrieve.mockResolvedValue(pi("requires_capture"));
    const approver = "55555555-5555-5555-5555-555555555555";
    await recordCreatorHold(
      { tenant_id: TENANT, order_id: ORDER, payment_intent_id: "pi_1", cause: "hire", actor_user_id: approver },
      h.deps,
    );
    expect(h.events).toEqual([expect.objectContaining({ kind: "hold", actor_kind: "tenant", actor_user_id: approver })]);
  });

  it("refuses to record a hold whose amount is not what the order quoted", async () => {
    const h = harness();
    h.stripe.paymentIntents.retrieve.mockResolvedValue(pi("requires_capture", { amount: 9_900 }));
    await expect(
      recordCreatorHold(
        { tenant_id: TENANT, order_id: ORDER, payment_intent_id: "pi_1", cause: "booking" },
        h.deps,
      ),
    ).rejects.toThrowError(/quoted/);
    expect(h.events).toHaveLength(0);
  });
});

describe("captureCreatorHold", () => {
  const held = () => makeOrder({ status: "awaiting_acceptance", stripe_payment_intent_id: "pi_1" });

  it("captures the full quoted total and records one capture event", async () => {
    const h = harness({ order: held() });
    h.stripe.paymentIntents.retrieve.mockResolvedValue(pi("requires_capture"));
    h.stripe.paymentIntents.capture.mockResolvedValue(pi("succeeded"));

    const out = await captureCreatorHold(
      { tenant_id: TENANT, order_id: ORDER, creator_country: "US", cause: "creator_accept" },
      h.deps,
    );

    expect(out).toMatchObject({ ok: true, amount_cents: 16_500, charge_id: "ch_1" });
    expect(h.stripe.paymentIntents.capture).toHaveBeenCalledWith(
      "pi_1",
      { amount_to_capture: 16_500 },
      { idempotencyKey: `cr-capture-${ORDER}` },
    );
    expect(h.events).toEqual([
      expect.objectContaining({ kind: "capture", cause: "creator_accept", amount_cents: 16_500 }),
    ]);
  });

  it("charge-at-hire captures with the hire cause (spec item 34)", async () => {
    const h = harness({ order: held() });
    h.stripe.paymentIntents.retrieve.mockResolvedValue(pi("requires_capture"));
    h.stripe.paymentIntents.capture.mockResolvedValue(pi("succeeded"));
    await captureCreatorHold(
      { tenant_id: TENANT, order_id: ORDER, creator_country: "US", cause: "hire" },
      h.deps,
    );
    expect(h.events[0].cause).toBe("hire");
  });

  it("T1: a declined card returns cancel_immediately and NEVER retries", async () => {
    const h = harness({ order: held() });
    h.stripe.paymentIntents.retrieve.mockResolvedValue(pi("requires_capture"));
    h.stripe.paymentIntents.capture.mockRejectedValue(
      Object.assign(new Error("card declined"), { type: "StripeCardError", code: "card_declined" }),
    );

    const out = await captureCreatorHold(
      { tenant_id: TENANT, order_id: ORDER, creator_country: "US", cause: "creator_accept" },
      h.deps,
    );

    expect(out).toEqual({
      ok: false,
      action: "cancel_immediately",
      reason: expect.stringContaining("could not be charged"),
      failure_code: "card_declined",
      funds_uncertain: false,
    });
    expect(h.stripe.paymentIntents.capture).toHaveBeenCalledTimes(1);
    expect(h.events).toHaveLength(0);
  });

  it("T1: a lapsed/released hold returns cancel_immediately without calling capture", async () => {
    const h = harness({ order: held() });
    h.stripe.paymentIntents.retrieve.mockResolvedValue(pi("canceled"));
    const out = await captureCreatorHold(
      { tenant_id: TENANT, order_id: ORDER, creator_country: "US", cause: "creator_accept" },
      h.deps,
    );
    expect(out).toMatchObject({ ok: false, action: "cancel_immediately", failure_code: "hold_released" });
    expect(h.stripe.paymentIntents.capture).not.toHaveBeenCalled();
  });

  it("flags funds_uncertain on an ambiguous capture failure so the cancel path can refund", async () => {
    const h = harness({ order: held() });
    h.stripe.paymentIntents.retrieve.mockResolvedValue(pi("requires_capture"));
    h.stripe.paymentIntents.capture.mockRejectedValue(
      Object.assign(new Error("connection dropped"), { type: "StripeConnectionError" }),
    );
    const out = await captureCreatorHold(
      { tenant_id: TENANT, order_id: ORDER, creator_country: "US", cause: "creator_accept" },
      h.deps,
    );
    expect(out).toMatchObject({ ok: false, action: "cancel_immediately", funds_uncertain: true });
  });

  it("is a no-op on an already-captured PaymentIntent (replay)", async () => {
    const h = harness({ order: held() });
    h.stripe.paymentIntents.retrieve.mockResolvedValue(pi("succeeded"));
    const out = await captureCreatorHold(
      { tenant_id: TENANT, order_id: ORDER, creator_country: "US", cause: "creator_accept" },
      h.deps,
    );
    expect(out).toMatchObject({ ok: true, already_captured: true });
    expect(h.stripe.paymentIntents.capture).not.toHaveBeenCalled();
    expect(h.events).toHaveLength(1);
  });

  it("S6: a captured charge that was refunded, or whose refund state is unknown, is never a replay", async () => {
    for (const latest_charge of [
      { id: "ch_1", amount_refunded: 16_500 },
      { id: "ch_1", amount_refunded: 100 },
      "ch_1",
    ]) {
      const h = harness({ order: held() });
      h.stripe.paymentIntents.retrieve.mockResolvedValue(pi("succeeded", { latest_charge }));
      const out = await captureCreatorHold(
        { tenant_id: TENANT, order_id: ORDER, creator_country: "US", cause: "hire" },
        h.deps,
      );
      expect(out).toMatchObject({ ok: false, failure_code: "charge_refunded" });
      expect(h.stripe.paymentIntents.capture).not.toHaveBeenCalled();
      expect(h.events).toHaveLength(0);
    }
  });

  it("refuses to charge for a creator outside payout reach (invariant 7)", async () => {
    const h = harness({ order: held() });
    await expect(
      captureCreatorHold(
        { tenant_id: TENANT, order_id: ORDER, creator_country: "BR", cause: "creator_accept" },
        h.deps,
      ),
    ).rejects.toThrowError(/outside Stripe's payout reach/);
    expect(h.stripe.paymentIntents.capture).not.toHaveBeenCalled();
  });
});

describe("cancelCreatorHold", () => {
  const held = () => makeOrder({ status: "awaiting_acceptance", stripe_payment_intent_id: "pi_1" });

  it("cancels the PaymentIntent and records one cancel event", async () => {
    const h = harness({ order: held() });
    h.stripe.paymentIntents.retrieve.mockResolvedValue(pi("requires_capture"));
    h.stripe.paymentIntents.cancel.mockResolvedValue(pi("canceled"));

    const out = await cancelCreatorHold({ tenant_id: TENANT, order_id: ORDER, cause: "expiry" }, h.deps);

    expect(out).toEqual({ ok: true, payment_intent_id: "pi_1", already_released: false });
    expect(h.stripe.paymentIntents.cancel).toHaveBeenCalledWith(
      "pi_1",
      {},
      { idempotencyKey: `cr-cancel-${ORDER}` },
    );
    expect(h.events).toEqual([expect.objectContaining({ kind: "cancel", cause: "expiry" })]);
  });

  it("records an already-released hold without calling cancel again", async () => {
    const h = harness({ order: held() });
    h.stripe.paymentIntents.retrieve.mockResolvedValue(pi("canceled"));
    const out = await cancelCreatorHold({ tenant_id: TENANT, order_id: ORDER, cause: "decline" }, h.deps);
    expect(out).toMatchObject({ ok: true, already_released: true });
    expect(h.stripe.paymentIntents.cancel).not.toHaveBeenCalled();
    expect(h.events).toHaveLength(1);
  });

  it("an unpaid checkout with no PaymentIntent closes as a no-op: no Stripe call, no ledger row", async () => {
    const h = harness({ order: makeOrder({ status: "checkout_pending" }), key: "sk_live_fake" });
    const out = await cancelCreatorHold({ tenant_id: TENANT, order_id: ORDER, cause: "checkout_abandoned" }, h.deps);
    expect(out).toEqual({ ok: true, payment_intent_id: null, already_released: true });
    expect(h.stripe.paymentIntents.retrieve).not.toHaveBeenCalled();
    expect(h.stripe.paymentIntents.cancel).not.toHaveBeenCalled();
    expect(h.events).toHaveLength(0);
  });

  it("an order PAST checkout with no PaymentIntent still refuses (the no-op is checkout-only)", async () => {
    const h = harness({ order: makeOrder({ status: "awaiting_acceptance" }) });
    await expect(
      cancelCreatorHold({ tenant_id: TENANT, order_id: ORDER, cause: "expiry" }, h.deps),
    ).rejects.toThrow(/no card hold/);
  });

  it("a cancellation meant for an older PaymentIntent never touches the one the order now holds", async () => {
    const h = harness({ order: makeOrder({ status: "awaiting_creator", stripe_payment_intent_id: "pi_B" }) });
    h.stripe.paymentIntents.retrieve.mockResolvedValue(pi("requires_capture", { id: "pi_B" }));
    const out = await cancelCreatorHold(
      { tenant_id: TENANT, order_id: ORDER, cause: "expiry", expected_payment_intent_id: "pi_A" },
      h.deps,
    );
    expect(out).toEqual({ ok: false, action: "superseded", payment_intent_id: "pi_B" });
    expect(h.stripe.paymentIntents.retrieve).not.toHaveBeenCalled();
    expect(h.stripe.paymentIntents.cancel).not.toHaveBeenCalled();
    expect(h.events).toHaveLength(0);
  });

  const priorCancelOnA = (h: ReturnType<typeof harness>) =>
    h.events.push({
      tenant_id: TENANT,
      order_id: ORDER,
      kind: "cancel",
      cause: "checkout_abandoned",
      amount_cents: 16_500,
      currency: "usd",
      livemode: false,
      stripe_object_id: "pi_A",
      idempotency_key: `cr-cancel-${ORDER}`,
      actor_kind: "system",
    });

  it("releasing pi_B after pi_A's cancel row exists gets its own key at Stripe and its own ledger row", async () => {
    const h = harness({ order: makeOrder({ status: "awaiting_creator", stripe_payment_intent_id: "pi_B" }) });
    priorCancelOnA(h);
    h.stripe.paymentIntents.retrieve.mockResolvedValue(pi("requires_capture", { id: "pi_B" }));
    h.stripe.paymentIntents.cancel.mockResolvedValue(pi("canceled", { id: "pi_B" }));

    await cancelCreatorHold({ tenant_id: TENANT, order_id: ORDER, cause: "decline" }, h.deps);

    expect(h.stripe.paymentIntents.cancel).toHaveBeenCalledWith("pi_B", {}, { idempotencyKey: `cr-cancel-${ORDER}-pi_B` });
    expect(h.events.map((e) => [e.idempotency_key, e.stripe_object_id, e.cause])).toEqual([
      [`cr-cancel-${ORDER}`, "pi_A", "checkout_abandoned"],
      [`cr-cancel-${ORDER}-pi_B`, "pi_B", "decline"],
    ]);

    h.stripe.paymentIntents.retrieve.mockResolvedValue(pi("canceled", { id: "pi_B" }));
    await cancelCreatorHold({ tenant_id: TENANT, order_id: ORDER, cause: "decline" }, h.deps);
    expect(h.events).toHaveLength(2);
  });

  it("an already-released pi_B after pi_A's cancel row still gets its own ledger row", async () => {
    const h = harness({ order: makeOrder({ status: "awaiting_creator", stripe_payment_intent_id: "pi_B" }) });
    priorCancelOnA(h);
    h.stripe.paymentIntents.retrieve.mockResolvedValue(pi("canceled", { id: "pi_B" }));
    await cancelCreatorHold({ tenant_id: TENANT, order_id: ORDER, cause: "expiry" }, h.deps);
    expect(h.stripe.paymentIntents.cancel).not.toHaveBeenCalled();
    expect(h.events.map((e) => [e.idempotency_key, e.stripe_object_id])).toEqual([
      [`cr-cancel-${ORDER}`, "pi_A"],
      [`cr-cancel-${ORDER}-pi_B`, "pi_B"],
    ]);
  });

  it("refuses to cancel captured money and tells the caller to refund instead", async () => {
    const h = harness({ order: held() });
    h.stripe.paymentIntents.retrieve.mockResolvedValue(pi("succeeded"));
    const out = await cancelCreatorHold({ tenant_id: TENANT, order_id: ORDER, cause: "decline" }, h.deps);
    expect(out).toEqual({ ok: false, action: "refund_required", payment_intent_id: "pi_1" });
    expect(h.stripe.paymentIntents.cancel).not.toHaveBeenCalled();
    expect(h.events).toHaveLength(0);
  });
});

describe("releaseOrphanCreatorHold", () => {
  it("cancels a hold that is still requires_capture, once, with its own key", async () => {
    const h = harness();
    h.stripe.paymentIntents.retrieve.mockResolvedValue(pi("requires_capture"));
    expect(await releaseOrphanCreatorHold({ payment_intent_id: "pi_1", order_livemode: false }, h.deps)).toBe("released");
    expect(h.stripe.paymentIntents.cancel).toHaveBeenCalledWith("pi_1", {}, { idempotencyKey: "cr-orphan-pi_1" });
    expect(h.events).toHaveLength(0);
  });

  it("leaves a PaymentIntent that is not a live hold alone (released, captured, never paid)", async () => {
    for (const status of ["canceled", "requires_payment_method"]) {
      const h = harness();
      h.stripe.paymentIntents.retrieve.mockResolvedValue(pi(status));
      expect(await releaseOrphanCreatorHold({ payment_intent_id: "pi_1", order_livemode: false }, h.deps)).toBe("not_held");
      expect(h.stripe.paymentIntents.cancel).not.toHaveBeenCalled();
    }
  });

  it("never refunds a captured PaymentIntent, only reports it", async () => {
    const h = harness();
    h.stripe.paymentIntents.retrieve.mockResolvedValue(pi("succeeded"));
    expect(await releaseOrphanCreatorHold({ payment_intent_id: "pi_1", order_livemode: false }, h.deps)).toBe("captured");
    expect(h.stripe.paymentIntents.cancel).not.toHaveBeenCalled();
    expect(h.stripe.refunds.create).not.toHaveBeenCalled();
  });

  it("refuses across the livemode boundary", async () => {
    const h = harness({ key: "sk_live_fake" });
    await expect(releaseOrphanCreatorHold({ payment_intent_id: "pi_1", order_livemode: false }, h.deps)).rejects.toThrow(/test mode/);
    expect(h.stripe.paymentIntents.retrieve).not.toHaveBeenCalled();
  });
});

describe("transferToCreator", () => {
  const payable = (over: Partial<CreatorOrderMoneyRow> = {}) =>
    makeOrder({
      status: "completed",
      payout_status: "ready",
      stripe_payment_intent_id: "pi_1",
      ...over,
    });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("transfers the creator's payout with source_transaction and the order idempotency key", async () => {
    const h = harness({ order: payable() });
    h.stripe.paymentIntents.retrieve.mockResolvedValue(pi("succeeded"));

    const out = await transferToCreator(
      { tenant_id: TENANT, order_id: ORDER, cause: "approval" },
      h.deps,
    );

    expect(out).toEqual({
      ok: true,
      transfer_id: "tr_1",
      amount_cents: 12_750,
      already_transferred: false,
      recorded: true,
    });
    const [params, options] = h.stripe.transfers.create.mock.calls[0];
    expect(params).toMatchObject({
      amount: 12_750,
      currency: "usd",
      destination: "acct_creator1",
      source_transaction: "ch_1",
      transfer_group: `creator_order_${ORDER}`,
    });
    expect(options).toEqual({ idempotencyKey: `cr-transfer-${ORDER}` });
    expect(h.markTransferred).toHaveBeenCalledWith({
      order_id: ORDER,
      transfer_id: "tr_1",
      idempotency_key: `cr-transfer-${ORDER}`,
      cause: "approval",
    });
  });

  it("pays the mediated part-amount when one is set, never the full payout", async () => {
    const order = payable({ payout_amount_cents: 5_000 });
    const h = harness({ order });
    h.claimTransfer.mockResolvedValue(order);
    h.stripe.paymentIntents.retrieve.mockResolvedValue(pi("succeeded"));
    const out = await transferToCreator(
      { tenant_id: TENANT, order_id: ORDER, cause: "mediation" },
      h.deps,
    );
    expect(out).toMatchObject({ ok: true, amount_cents: 5_000 });
    expect(h.stripe.transfers.create.mock.calls[0][0].amount).toBe(5_000);
  });

  const refundedPi = (amount_refunded: number) =>
    pi("succeeded", { latest_charge: { id: "ch_1", amount_refunded } });

  it.each(["approval", "auto_accept_buffer"] as const)(
    "refuses a %s payout on a partially refunded charge, before the claim",
    async (cause) => {
      const h = harness({ order: payable() });
      h.stripe.paymentIntents.retrieve.mockResolvedValue(refundedPi(4_000));
      const out = await transferToCreator({ tenant_id: TENANT, order_id: ORDER, cause }, h.deps);
      expect(out).toEqual({ ok: false, reason: "charge_refunded", message: expect.any(String) });
      expect(h.claimTransfer).not.toHaveBeenCalled();
      expect(h.stripe.transfers.create).not.toHaveBeenCalled();
    },
  );

  it("refuses an approval payout when the refund state is unknown (charge not expanded)", async () => {
    const h = harness({ order: payable() });
    h.stripe.paymentIntents.retrieve.mockResolvedValue(pi("succeeded", { latest_charge: "ch_1" }));
    const out = await transferToCreator(
      { tenant_id: TENANT, order_id: ORDER, cause: "approval" },
      h.deps,
    );
    expect(out).toMatchObject({ ok: false, reason: "charge_refunded" });
    expect(h.claimTransfer).not.toHaveBeenCalled();
  });

  it("pays an approval payout when the charge has refunded exactly zero", async () => {
    const h = harness({ order: payable() });
    h.stripe.paymentIntents.retrieve.mockResolvedValue(refundedPi(0));
    const out = await transferToCreator(
      { tenant_id: TENANT, order_id: ORDER, cause: "approval" },
      h.deps,
    );
    expect(out).toMatchObject({ ok: true, transfer_id: "tr_1" });
  });

  it("still pays a mediation part-amount after the paired remainder refund", async () => {
    const order = payable({ payout_amount_cents: 5_000 });
    const h = harness({ order });
    h.claimTransfer.mockResolvedValue(order);
    h.stripe.paymentIntents.retrieve.mockResolvedValue(refundedPi(11_500));
    const out = await transferToCreator(
      { tenant_id: TENANT, order_id: ORDER, cause: "mediation" },
      h.deps,
    );
    expect(out).toMatchObject({ ok: true, amount_cents: 5_000 });
  });

  it("refuses a mediation pay-full after an out-of-band refund (no paired refund there)", async () => {
    const h = harness({ order: payable() });
    h.stripe.paymentIntents.retrieve.mockResolvedValue(refundedPi(4_000));
    const out = await transferToCreator(
      { tenant_id: TENANT, order_id: ORDER, cause: "mediation" },
      h.deps,
    );
    expect(out).toMatchObject({ ok: false, reason: "charge_refunded" });
    expect(h.claimTransfer).not.toHaveBeenCalled();
  });

  it("a buffer-sweep retry of a failed split transfer still pays the part", async () => {
    const order = payable({ payout_amount_cents: 5_000 });
    const h = harness({ order });
    h.claimTransfer.mockResolvedValue(order);
    h.stripe.paymentIntents.retrieve.mockResolvedValue(refundedPi(11_500));
    const out = await transferToCreator(
      { tenant_id: TENANT, order_id: ORDER, cause: "auto_accept_buffer" },
      h.deps,
    );
    expect(out).toMatchObject({ ok: true, amount_cents: 5_000 });
  });

  it("refuses a mediation part-amount when the refunds plus the part exceed the charge", async () => {
    const h = harness({ order: payable({ payout_amount_cents: 5_000 }) });
    h.stripe.paymentIntents.retrieve.mockResolvedValue(refundedPi(12_000));
    const out = await transferToCreator(
      { tenant_id: TENANT, order_id: ORDER, cause: "mediation" },
      h.deps,
    );
    expect(out).toMatchObject({ ok: false, reason: "charge_refunded" });
    expect(h.claimTransfer).not.toHaveBeenCalled();
  });

  it("refuses when the creator's transfers capability is not active (S0 learning 1)", async () => {
    const h = harness({ order: payable() });
    h.stripe.accounts.retrieve.mockResolvedValue({
      id: "acct_creator1",
      capabilities: { transfers: "inactive" },
    });
    const out = await transferToCreator(
      { tenant_id: TENANT, order_id: ORDER, cause: "approval" },
      h.deps,
    );
    expect(out).toEqual({
      ok: false,
      reason: "transfers_capability_inactive",
      message: expect.any(String),
    });
    expect(h.stripe.transfers.create).not.toHaveBeenCalled();
    expect(h.claimTransfer).not.toHaveBeenCalled();
  });

  it("waits when the creator has no payout account yet", async () => {
    const h = harness({ order: payable(), account: null });
    const out = await transferToCreator(
      { tenant_id: TENANT, order_id: ORDER, cause: "approval" },
      h.deps,
    );
    expect(out).toMatchObject({ ok: false, reason: "awaiting_payout_account" });
    expect(h.stripe.transfers.create).not.toHaveBeenCalled();
  });

  it("refuses to pay a creator who disconnected Zavi from their Stripe account (S4)", async () => {
    const h = harness({
      order: payable(),
      account: makeAccount({ disabled_reason: "deauthorized" }),
    });
    const out = await transferToCreator(
      { tenant_id: TENANT, order_id: ORDER, cause: "approval" },
      h.deps,
    );
    expect(out).toMatchObject({ ok: false, reason: "payout_account_disconnected" });
    expect(h.stripe.accounts.retrieve).not.toHaveBeenCalled();
    expect(h.stripe.transfers.create).not.toHaveBeenCalled();
    expect(h.claimTransfer).not.toHaveBeenCalled();
  });

  it("refuses a creator account in an unsupported payout country (invariant 7)", async () => {
    const h = harness({ order: payable(), account: makeAccount({ country: "IN" }) });
    await expect(
      transferToCreator({ tenant_id: TENANT, order_id: ORDER, cause: "approval" }, h.deps),
    ).rejects.toThrowError(/outside Stripe's payout reach/);
    expect(h.stripe.transfers.create).not.toHaveBeenCalled();
  });

  it("does not transfer when the claim was lost (the durable double-transfer guard)", async () => {
    const h = harness({ order: payable() });
    h.claimTransfer.mockResolvedValue(null);
    h.stripe.paymentIntents.retrieve.mockResolvedValue(pi("succeeded"));
    const out = await transferToCreator(
      { tenant_id: TENANT, order_id: ORDER, cause: "approval" },
      h.deps,
    );
    expect(out).toMatchObject({ ok: false, reason: "claim_lost" });
    expect(h.stripe.transfers.create).not.toHaveBeenCalled();
  });

  it("short-circuits an order that already has a transfer", async () => {
    const h = harness({
      order: payable({ payout_status: "transferred", stripe_transfer_id: "tr_old" }),
    });
    const out = await transferToCreator(
      { tenant_id: TENANT, order_id: ORDER, cause: "approval" },
      h.deps,
    );
    expect(out).toEqual({
      ok: true,
      transfer_id: "tr_old",
      amount_cents: 12_750,
      already_transferred: true,
      recorded: true,
    });
    expect(h.stripe.transfers.create).not.toHaveBeenCalled();
    expect(h.claimTransfer).not.toHaveBeenCalled();
  });

  it("refuses to pay out before the business's payment is captured", async () => {
    const h = harness({ order: payable() });
    h.stripe.paymentIntents.retrieve.mockResolvedValue(pi("requires_capture"));
    const out = await transferToCreator(
      { tenant_id: TENANT, order_id: ORDER, cause: "approval" },
      h.deps,
    );
    expect(out).toMatchObject({ ok: false, reason: "charge_not_captured" });
    expect(h.claimTransfer).not.toHaveBeenCalled();
  });

  it("an AMBIGUOUS transfer failure keeps the claim (never retried, never released)", async () => {
    const h = harness({ order: payable() });
    h.stripe.paymentIntents.retrieve.mockResolvedValue(pi("succeeded"));
    h.stripe.transfers.create.mockRejectedValue(
      Object.assign(new Error("gateway timeout"), { type: "StripeAPIError" }),
    );

    await expect(
      transferToCreator({ tenant_id: TENANT, order_id: ORDER, cause: "approval" }, h.deps),
    ).rejects.toThrow();

    expect(h.releaseTransferClaim).not.toHaveBeenCalled();
    expect(h.markTransferred).not.toHaveBeenCalled();
    expect(h.stripe.transfers.create).toHaveBeenCalledTimes(1);
    expect(h.logs.map((l) => l.code)).toContain("creator.transfer.ambiguous");
  });

  it("an unrecognisable (non-Stripe) failure is treated as ambiguous too", async () => {
    const h = harness({ order: payable() });
    h.stripe.paymentIntents.retrieve.mockResolvedValue(pi("succeeded"));
    h.stripe.transfers.create.mockRejectedValue(new Error("socket hang up"));
    await expect(
      transferToCreator({ tenant_id: TENANT, order_id: ORDER, cause: "approval" }, h.deps),
    ).rejects.toThrow();
    expect(h.releaseTransferClaim).not.toHaveBeenCalled();
  });

  it("a DEFINITIVE transfer failure releases the claim so it can retry later", async () => {
    const h = harness({ order: payable() });
    h.stripe.paymentIntents.retrieve.mockResolvedValue(pi("succeeded"));
    h.stripe.transfers.create.mockRejectedValue(
      Object.assign(new Error("no such destination"), { type: "StripeInvalidRequestError" }),
    );
    await expect(
      transferToCreator({ tenant_id: TENANT, order_id: ORDER, cause: "approval" }, h.deps),
    ).rejects.toThrow();
    expect(h.releaseTransferClaim).toHaveBeenCalledWith(ORDER);
    expect(h.markTransferred).not.toHaveBeenCalled();
  });

  it("reports recorded=false and flags staff when the order could not be marked transferred", async () => {
    const h = harness({ order: payable() });
    h.stripe.paymentIntents.retrieve.mockResolvedValue(pi("succeeded"));
    h.markTransferred.mockResolvedValue(0);

    const out = await transferToCreator(
      { tenant_id: TENANT, order_id: ORDER, cause: "approval" },
      h.deps,
    );

    expect(out).toMatchObject({ ok: true, transfer_id: "tr_1", recorded: false });
    expect(h.logs.map((l) => l.code)).toContain("creator.transfer.not_recorded");
    expect(h.stripe.transfers.create).toHaveBeenCalledTimes(1);
  });

  it("refuses a live order under a test key before touching Stripe", async () => {
    const h = harness({ order: payable({ livemode: true }) });
    await expect(
      transferToCreator({ tenant_id: TENANT, order_id: ORDER, cause: "approval" }, h.deps),
    ).rejects.toThrowError(/boundary/);
    expect(h.stripe.accounts.retrieve).not.toHaveBeenCalled();
  });
});

describe("refundCreatorOrder", () => {
  const paid = (over: Partial<CreatorOrderMoneyRow> = {}) =>
    makeOrder({
      status: "in_progress",
      stripe_payment_intent_id: "pi_1",
      ...over,
    });

  it("refunds the full fee-inclusive total when no transfer went out", async () => {
    const h = harness({ order: paid() });
    const out = await refundCreatorOrder(
      { tenant_id: TENANT, order_id: ORDER, cause: "cancel_agreed" },
      h.deps,
    );
    expect(out).toMatchObject({ refunded_cents: 16_500, reversed_cents: 0, needs_staff_review: false });
    expect(h.stripe.refunds.create).toHaveBeenCalledWith(
      { payment_intent: "pi_1", amount: 16_500, metadata: expect.any(Object) },
      { idempotencyKey: `cr-refund-${ORDER}-16500` },
    );
    expect(h.stripe.transfers.createReversal).not.toHaveBeenCalled();
    expect(h.events).toEqual([expect.objectContaining({ kind: "refund", amount_cents: 16_500 })]);
  });

  it("PAIRS the refund with a transfer reversal when the creator was already paid (S0 learning 3)", async () => {
    const h = harness({
      order: paid({ payout_status: "transferred", stripe_transfer_id: "tr_1" }),
    });

    const out = await refundCreatorOrder(
      { tenant_id: TENANT, order_id: ORDER, cause: "mediation" },
      h.deps,
    );

    expect(out).toMatchObject({ refunded_cents: 16_500, reversed_cents: 12_750, needs_staff_review: false });
    const reversalOrder = h.stripe.transfers.createReversal.mock.invocationCallOrder[0];
    const refundOrder = h.stripe.refunds.create.mock.invocationCallOrder[0];
    expect(reversalOrder).toBeLessThan(refundOrder);
    expect(h.stripe.transfers.createReversal).toHaveBeenCalledWith(
      "tr_1",
      { amount: 12_750, metadata: expect.any(Object) },
      { idempotencyKey: `cr-reversal-${ORDER}-12750` },
    );
    expect(h.events.map((e) => e.kind)).toEqual(["transfer_reversal", "refund"]);
  });

  it("never reverses more than the refund being issued", async () => {
    const h = harness({
      order: paid({ payout_status: "transferred", stripe_transfer_id: "tr_1" }),
    });
    h.stripe.transfers.createReversal.mockResolvedValue({ id: "trr_1", amount: 5_000 });
    const out = await refundCreatorOrder(
      { tenant_id: TENANT, order_id: ORDER, cause: "mediation", amount_cents: 5_000 },
      h.deps,
    );
    expect(h.stripe.transfers.createReversal.mock.calls[0][1].amount).toBe(5_000);
    expect(out.reversed_cents).toBe(5_000);
    expect(out.needs_staff_review).toBe(false);
  });

  it("PARTIAL reversal: refunds anyway, records what came back, flags staff (S0 learning 4)", async () => {
    const h = harness({
      order: paid({ payout_status: "transferred", stripe_transfer_id: "tr_1" }),
    });
    h.stripe.transfers.createReversal.mockResolvedValue({ id: "trr_1", amount: 9_000 });

    const out = await refundCreatorOrder(
      { tenant_id: TENANT, order_id: ORDER, cause: "no_show" },
      h.deps,
    );

    expect(out).toMatchObject({
      refunded_cents: 16_500,
      reversed_cents: 9_000,
      reversal_shortfall_cents: 3_750,
      needs_staff_review: true,
    });
    expect(h.events.map((e) => e.kind)).toEqual(["transfer_reversal", "refund"]);
    expect(h.events[0].amount_cents).toBe(9_000);
    expect(h.logs.map((l) => l.code)).toContain("creator.refund.reversal_shortfall");
  });

  it("FAILED reversal: still refunds the business, writes no reversal row, flags staff", async () => {
    const h = harness({
      order: paid({ payout_status: "transferred", stripe_transfer_id: "tr_1" }),
    });
    h.stripe.transfers.createReversal.mockRejectedValue(
      Object.assign(new Error("insufficient funds"), { type: "StripeInvalidRequestError" }),
    );

    const out = await refundCreatorOrder(
      { tenant_id: TENANT, order_id: ORDER, cause: "no_show" },
      h.deps,
    );

    expect(out).toMatchObject({
      refunded_cents: 16_500,
      reversed_cents: 0,
      reversal_shortfall_cents: 12_750,
      needs_staff_review: true,
    });
    expect(h.stripe.transfers.createReversal).toHaveBeenCalledTimes(1);
    expect(h.stripe.refunds.create).toHaveBeenCalledTimes(1);
    expect(h.events.map((e) => e.kind)).toEqual(["refund"]);
    expect(h.logs.map((l) => l.code)).toEqual(
      expect.arrayContaining(["creator.refund.reversal_failed", "creator.refund.reversal_shortfall"]),
    );
  });

  it("REFUSES to refund while a payout is unreconciled (an ambiguous transfer keeps its claim)", async () => {
    const h = harness({
      order: paid({ payout_status: "transferring", stripe_transfer_id: null }),
    });
    await expect(
      refundCreatorOrder({ tenant_id: TENANT, order_id: ORDER, cause: "no_show" }, h.deps),
    ).rejects.toThrowError(/still in flight or unreconciled/);
    expect(h.stripe.refunds.create).not.toHaveBeenCalled();
    expect(h.stripe.transfers.createReversal).not.toHaveBeenCalled();
    expect(h.logs.map((l) => l.code)).toContain("creator.refund.blocked_unreconciled_payout");
  });

  it("does not refund twice: the ledger key is checked BEFORE Stripe (beats the 24h window)", async () => {
    const h = harness({ order: paid() });
    await refundCreatorOrder({ tenant_id: TENANT, order_id: ORDER, cause: "cancel_agreed" }, h.deps);
    expect(h.stripe.refunds.create).toHaveBeenCalledTimes(1);

    const again = await refundCreatorOrder(
      { tenant_id: TENANT, order_id: ORDER, cause: "cancel_agreed" },
      h.deps,
    );
    expect(again).toMatchObject({ already_refunded: true, refunded_cents: 16_500, refund_id: "re_1" });
    expect(h.stripe.refunds.create).toHaveBeenCalledTimes(1);
    expect(h.events.filter((e) => e.kind === "refund")).toHaveLength(1);
  });

  it("does not reverse twice either, and still reports a prior shortfall", async () => {
    const h = harness({
      order: paid({ payout_status: "transferred", stripe_transfer_id: "tr_1" }),
    });
    h.stripe.transfers.createReversal.mockResolvedValue({ id: "trr_1", amount: 9_000 });
    await refundCreatorOrder({ tenant_id: TENANT, order_id: ORDER, cause: "no_show" }, h.deps);
    expect(h.stripe.transfers.createReversal).toHaveBeenCalledTimes(1);

    const again = await refundCreatorOrder(
      { tenant_id: TENANT, order_id: ORDER, cause: "no_show" },
      h.deps,
    );
    expect(h.stripe.transfers.createReversal).toHaveBeenCalledTimes(1);
    expect(again).toMatchObject({
      already_refunded: true,
      reversed_cents: 9_000,
      reversal_shortfall_cents: 3_750,
      needs_staff_review: true,
    });
  });

  it.each([0, -1, 1.5, 12_751])(
    "refuses an explicit reverse_cents of %s instead of silently clamping it",
    async (bad) => {
      const h = harness({
        order: paid({ payout_status: "transferred", stripe_transfer_id: "tr_1" }),
      });
      await expect(
        refundCreatorOrder(
          { tenant_id: TENANT, order_id: ORDER, cause: "mediation", reverse_cents: bad },
          h.deps,
        ),
      ).rejects.toThrowError(/transfer reversal must be/);
      expect(h.stripe.transfers.createReversal).not.toHaveBeenCalled();
      expect(h.stripe.refunds.create).not.toHaveBeenCalled();
    },
  );

  it("refuses a reversal larger than the refund being issued", async () => {
    const h = harness({
      order: paid({ payout_status: "transferred", stripe_transfer_id: "tr_1" }),
    });
    await expect(
      refundCreatorOrder(
        {
          tenant_id: TENANT,
          order_id: ORDER,
          cause: "mediation",
          amount_cents: 4_000,
          reverse_cents: 6_000,
        },
        h.deps,
      ),
    ).rejects.toThrowError(/between 1 and 4000/);
    expect(h.stripe.refunds.create).not.toHaveBeenCalled();
  });

  it("finds a refund that committed at Stripe but left no ledger row, and does not refund again", async () => {
    const h = harness({ order: paid() });
    h.stripe.refunds.list.mockResolvedValue({
      data: [
        {
          id: "re_prior",
          amount: 16_500,
          metadata: { zavi_idempotency_key: `cr-refund-${ORDER}-16500` },
        },
      ],
    });

    const out = await refundCreatorOrder(
      { tenant_id: TENANT, order_id: ORDER, cause: "cancel_agreed" },
      h.deps,
    );

    expect(out).toMatchObject({ already_refunded: true, refund_id: "re_prior", refunded_cents: 16_500 });
    expect(h.stripe.refunds.create).not.toHaveBeenCalled();
    expect(h.events).toEqual([
      expect.objectContaining({ kind: "refund", stripe_object_id: "re_prior" }),
    ]);
  });

  it("finds a reversal that committed at Stripe but left no ledger row, and does not reverse again", async () => {
    const h = harness({
      order: paid({ payout_status: "transferred", stripe_transfer_id: "tr_1" }),
    });
    h.stripe.transfers.listReversals.mockResolvedValue({
      data: [
        {
          id: "trr_prior",
          amount: 12_750,
          metadata: { zavi_idempotency_key: `cr-reversal-${ORDER}-12750` },
        },
      ],
    });

    const out = await refundCreatorOrder(
      { tenant_id: TENANT, order_id: ORDER, cause: "mediation" },
      h.deps,
    );

    expect(h.stripe.transfers.createReversal).not.toHaveBeenCalled();
    expect(out).toMatchObject({ reversed_cents: 12_750, needs_staff_review: false });
    expect(h.events.map((e) => e.kind)).toEqual(["transfer_reversal", "refund"]);
  });

  it("ignores another key's refund on the same payment intent", async () => {
    const h = harness({ order: paid() });
    h.stripe.refunds.list.mockResolvedValue({
      data: [{ id: "re_other", amount: 500, metadata: { zavi_idempotency_key: "cr-refund-other-500" } }],
    });
    const out = await refundCreatorOrder(
      { tenant_id: TENANT, order_id: ORDER, cause: "cancel_agreed" },
      h.deps,
    );
    expect(out).toMatchObject({ already_refunded: false, refund_id: "re_1" });
    expect(h.stripe.refunds.create).toHaveBeenCalledTimes(1);
  });

  it("refuses an amount above the business total or below one cent", async () => {
    const h = harness({ order: paid() });
    await expect(
      refundCreatorOrder(
        { tenant_id: TENANT, order_id: ORDER, cause: "mediation", amount_cents: 16_501 },
        h.deps,
      ),
    ).rejects.toThrowError(/whole number of cents/);
    await expect(
      refundCreatorOrder(
        { tenant_id: TENANT, order_id: ORDER, cause: "mediation", amount_cents: 0 },
        h.deps,
      ),
    ).rejects.toThrowError(/whole number of cents/);
    expect(h.stripe.refunds.create).not.toHaveBeenCalled();
  });

  it("refuses a live order under a test key before touching Stripe", async () => {
    const h = harness({ order: paid({ livemode: true }) });
    await expect(
      refundCreatorOrder({ tenant_id: TENANT, order_id: ORDER, cause: "mediation" }, h.deps),
    ).rejects.toThrowError(/boundary/);
    expect(h.stripe.refunds.create).not.toHaveBeenCalled();
  });
});

describe("refundCreatorOrder against what the charge can still give back", () => {
  const paid = (over: Partial<CreatorOrderMoneyRow> = {}) =>
    makeOrder({ status: "in_progress", stripe_payment_intent_id: "pi_1", ...over });

  type FakeDispute = string | { id: string; status: string } | null;

  function stripeCharge(
    h: ReturnType<typeof harness>,
    opts: { refunded?: number; dispute?: FakeDispute; received?: number } = {},
  ) {
    const state = {
      received: opts.received ?? 16_500,
      refunded: opts.refunded ?? 0,
      dispute: opts.dispute ?? null,
      refunds: [] as Array<{ id: string; amount: number; status: string; metadata: Record<string, string> }>,
      failNextCreate: false,
    };
    h.stripe.paymentIntents.retrieve.mockImplementation(async (_id: string, params: { expand?: string[] }) => {
      const bad = params?.expand?.find((p) => p !== "latest_charge");
      if (bad) {
        throw Object.assign(new Error(`This property cannot be expanded (${bad}).`), { type: "StripeInvalidRequestError" });
      }
      return {
        id: "pi_1",
        status: "succeeded",
        amount: 16_500,
        amount_received: state.received,
        latest_charge: {
          id: "ch_1",
          amount_captured: state.received,
          amount_refunded: state.refunded,
          disputed: state.dispute !== null,
        },
      };
    });
    h.stripe.disputes.list.mockImplementation(async (params: { charge?: string }) => ({
      data:
        params?.charge === "ch_1" && state.dispute && typeof state.dispute === "object"
          ? [{ id: state.dispute.id, status: state.dispute.status }]
          : [],
    }));
    h.stripe.refunds.list.mockImplementation(async () => ({ data: [...state.refunds] }));
    h.stripe.refunds.create.mockImplementation(
      async (body: { amount: number; metadata: Record<string, string> }) => {
        const open = state.dispute !== null && (typeof state.dispute === "string" || !["won", "warning_closed", "warning_needs_response", "warning_under_review"].includes(state.dispute.status));
        if (open) throw Object.assign(new Error("Charge ch_1 has been charged back; cannot issue a refund."), { type: "StripeInvalidRequestError", code: "charge_disputed" });
        if (body.amount > state.received - state.refunded) {
          throw Object.assign(new Error(`Refund amount ($${body.amount / 100}) is greater than unrefunded amount on charge`), { type: "StripeInvalidRequestError", code: "amount_too_large" });
        }
        const refund = { id: `re_${state.refunds.length + 1}`, amount: body.amount, status: "succeeded", metadata: body.metadata };
        state.refunds.push(refund);
        state.refunded += body.amount;
        if (state.failNextCreate) {
          state.failNextCreate = false;
          throw Object.assign(new Error("socket hang up"), { type: "StripeConnectionError" });
        }
        return refund;
      },
    );
    return state;
  }

  it("refunds only what is left after a dashboard partial refund, not the full total", async () => {
    const h = harness({ order: paid() });
    stripeCharge(h, { refunded: 4_000 });
    const out = await refundCreatorOrder({ tenant_id: TENANT, order_id: ORDER, cause: "no_show" }, h.deps);
    expect(h.stripe.refunds.create).toHaveBeenCalledTimes(1);
    expect(h.stripe.refunds.create).toHaveBeenCalledWith(
      { payment_intent: "pi_1", amount: 12_500, metadata: expect.objectContaining({ zavi_creator_order_id: ORDER, zavi_cause: "no_show" }) },
      { idempotencyKey: `cr-refund-${ORDER}-12500` },
    );
    expect(out).toMatchObject({ refund_id: "re_1", refunded_cents: 12_500, already_refunded: false, needs_staff_review: false });
    expect(h.events).toEqual([expect.objectContaining({ kind: "refund", amount_cents: 12_500, idempotency_key: `cr-refund-${ORDER}-12500` })]);
    expect(h.logs.map((l) => l.code)).toContain("creator.refund.capped_to_refundable");
  });

  it.each([
    ["the dashboard refund id", "re_dash"],
    ["the charge id", "ch_1"],
  ])("a legacy dashboard row under the capped amount key (named by %s) does not stand in for the cancellation refund", async (_label, legacyObject) => {
    const h = harness({ order: paid() });
    const state = stripeCharge(h, { refunded: 8_250 });
    state.refunds.push({ id: "re_dash", amount: 8_250, status: "succeeded", metadata: {} });
    h.events.push({
      tenant_id: TENANT,
      order_id: ORDER,
      kind: "refund",
      cause: "mediation",
      amount_cents: 8_250,
      currency: "usd",
      livemode: false,
      stripe_object_id: legacyObject,
      idempotency_key: `cr-refund-${ORDER}-8250`,
      actor_kind: "staff",
    });

    const out = await refundCreatorOrder({ tenant_id: TENANT, order_id: ORDER, cause: "cancel_agreed" }, h.deps);

    expect(h.stripe.refunds.create).toHaveBeenCalledTimes(1);
    expect(h.stripe.refunds.create).toHaveBeenCalledWith(
      { payment_intent: "pi_1", amount: 8_250, metadata: expect.objectContaining({ zavi_cause: "cancel_agreed", zavi_idempotency_key: `cr-refund-${ORDER}-8250-cancel_agreed` }) },
      { idempotencyKey: `cr-refund-${ORDER}-8250-cancel_agreed` },
    );
    expect(state.refunded).toBe(16_500);
    expect(out).toMatchObject({ refunded_cents: 8_250, already_refunded: false });

    const again = await refundCreatorOrder({ tenant_id: TENANT, order_id: ORDER, cause: "cancel_agreed" }, h.deps);
    expect(h.stripe.refunds.create).toHaveBeenCalledTimes(1);
    expect(again).toMatchObject({ refunded_cents: 8_250, already_refunded: true });
    expect(h.events.filter((e) => e.kind === "refund").map((e) => e.idempotency_key)).toEqual([
      `cr-refund-${ORDER}-8250`,
      `cr-refund-${ORDER}-8250-cancel_agreed`,
    ]);
  });

  it("an earlier mediation refund of the same amount through the rail does not stand in for the cancellation refund", async () => {
    const h = harness({ order: paid() });
    const state = stripeCharge(h);
    await refundCreatorOrder({ tenant_id: TENANT, order_id: ORDER, cause: "mediation", amount_cents: 8_250 }, h.deps);
    await refundCreatorOrder({ tenant_id: TENANT, order_id: ORDER, cause: "cancel_agreed" }, h.deps);
    expect(h.stripe.refunds.create).toHaveBeenCalledTimes(2);
    expect(state.refunded).toBe(16_500);
    expect(h.stripe.refunds.create.mock.calls[1][1]).toEqual({ idempotencyKey: `cr-refund-${ORDER}-8250-cancel_agreed` });
  });

  it("a deadline retry after the capped refund committed and the ledger write was lost refunds nothing twice", async () => {
    const h = harness({ order: paid() });
    const state = stripeCharge(h, { refunded: 4_000 });
    const realRecord = h.deps.recordEvent;
    let dropped = false;
    h.deps.recordEvent = async (row) => {
      if (!dropped && row.kind === "refund") {
        dropped = true;
        throw new Error("db connection reset");
      }
      return realRecord(row);
    };
    await expect(
      refundCreatorOrder({ tenant_id: TENANT, order_id: ORDER, cause: "no_show" }, h.deps),
    ).rejects.toThrow(/db connection reset/);
    expect(state.refunded).toBe(16_500);

    const again = await refundCreatorOrder({ tenant_id: TENANT, order_id: ORDER, cause: "no_show" }, h.deps);
    expect(h.stripe.refunds.create).toHaveBeenCalledTimes(1);
    expect(again).toMatchObject({ refund_id: "re_1", refunded_cents: 12_500, already_refunded: true });
    expect(h.events).toEqual([expect.objectContaining({ kind: "refund", amount_cents: 12_500, idempotency_key: `cr-refund-${ORDER}-12500` })]);
  });

  it("a retry after an uncapped full refund committed still dedupes on the full-amount key", async () => {
    const h = harness({ order: paid() });
    const state = stripeCharge(h);
    state.failNextCreate = true;
    await expect(
      refundCreatorOrder({ tenant_id: TENANT, order_id: ORDER, cause: "cancel_no_response" }, h.deps),
    ).rejects.toThrow();
    expect(state.refunded).toBe(16_500);
    const again = await refundCreatorOrder({ tenant_id: TENANT, order_id: ORDER, cause: "cancel_no_response" }, h.deps);
    expect(h.stripe.refunds.create).toHaveBeenCalledTimes(1);
    expect(again).toMatchObject({ refund_id: "re_1", refunded_cents: 16_500, already_refunded: true });
    expect(h.events).toEqual([expect.objectContaining({ kind: "refund", amount_cents: 16_500, idempotency_key: `cr-refund-${ORDER}-16500` })]);
  });

  it("a retry after the reversal committed but the capped refund failed reverses once and refunds the remainder", async () => {
    const h = harness({ order: paid({ payout_status: "transferred", stripe_transfer_id: "tr_1" }) });
    stripeCharge(h, { refunded: 4_000 });
    h.stripe.transfers.createReversal.mockImplementation(async (_tr: string, body: { amount: number }) => ({ id: "trr_1", amount: body.amount }));
    h.stripe.refunds.create.mockImplementationOnce(async () => {
      throw Object.assign(new Error("rate limited"), { type: "StripeRateLimitError" });
    });
    await expect(
      refundCreatorOrder({ tenant_id: TENANT, order_id: ORDER, cause: "no_show" }, h.deps),
    ).rejects.toThrow();
    const out = await refundCreatorOrder({ tenant_id: TENANT, order_id: ORDER, cause: "no_show" }, h.deps);
    expect(h.stripe.transfers.createReversal).toHaveBeenCalledTimes(1);
    expect(h.stripe.transfers.createReversal.mock.calls[0][1].amount).toBe(12_500);
    expect(out).toMatchObject({ refunded_cents: 12_500, reversed_cents: 12_500, needs_staff_review: false });
    expect(h.stripe.refunds.create.mock.calls[1][0].amount).toBe(12_500);
  });

  it.each([
    ["open chargeback", { id: "dp_1", status: "needs_response" }],
    ["chargeback under review", { id: "dp_1", status: "under_review" }],
    ["lost chargeback", { id: "dp_1", status: "lost" }],
    ["dispute the read could not expand", "dp_1"],
  ] as const)("%s: no refund call, no reversal, no throw, staff flagged", async (_label, dispute) => {
    const h = harness({ order: paid({ payout_status: "transferred", stripe_transfer_id: "tr_1" }) });
    stripeCharge(h, { dispute });
    const out = await refundCreatorOrder({ tenant_id: TENANT, order_id: ORDER, cause: "no_show" }, h.deps);
    expect(h.stripe.refunds.create).not.toHaveBeenCalled();
    expect(h.stripe.transfers.createReversal).not.toHaveBeenCalled();
    expect(out).toEqual({
      refund_id: null,
      refunded_cents: 0,
      already_refunded: false,
      reversed_cents: 0,
      reversal_shortfall_cents: 0,
      needs_staff_review: true,
      blocked_reason: "charge_disputed",
    });
    expect(h.events).toEqual([]);
    expect(h.logs.map((l) => l.code)).toContain("creator.refund.blocked_disputed_charge");
  });

  it("an explicit amount on a disputed charge is refused the same way", async () => {
    const h = harness({ order: paid() });
    stripeCharge(h, { dispute: { id: "dp_1", status: "needs_response" } });
    const out = await refundCreatorOrder(
      { tenant_id: TENANT, order_id: ORDER, cause: "mediation", amount_cents: 5_000 },
      h.deps,
    );
    expect(h.stripe.refunds.create).not.toHaveBeenCalled();
    expect(out).toMatchObject({ needs_staff_review: true, blocked_reason: "charge_disputed" });
  });

  it.each([
    ["won", 0],
    ["warning_needs_response", 0],
    ["warning_closed", 3_000],
  ])("a %s dispute does not block: refunds what is left", async (status, refunded) => {
    const h = harness({ order: paid() });
    stripeCharge(h, { dispute: { id: "dp_1", status }, refunded });
    const out = await refundCreatorOrder({ tenant_id: TENANT, order_id: ORDER, cause: "no_show" }, h.deps);
    expect(out).toMatchObject({ refunded_cents: 16_500 - refunded, needs_staff_review: false });
    expect(out.blocked_reason).toBeUndefined();
  });

  it("caps at a partial capture, not the order total", async () => {
    const h = harness({ order: paid() });
    stripeCharge(h, { received: 10_000 });
    const out = await refundCreatorOrder({ tenant_id: TENANT, order_id: ORDER, cause: "creator_removed" }, h.deps);
    expect(out).toMatchObject({ refunded_cents: 10_000 });
    expect(h.stripe.refunds.create.mock.calls[0][0].amount).toBe(10_000);
  });

  it("a charge refunded in full outside the rail: nothing to refund, no Stripe call, no throw", async () => {
    const h = harness({ order: paid() });
    stripeCharge(h, { refunded: 16_500 });
    const out = await refundCreatorOrder({ tenant_id: TENANT, order_id: ORDER, cause: "no_show" }, h.deps);
    expect(h.stripe.refunds.create).not.toHaveBeenCalled();
    expect(out).toMatchObject({ refund_id: null, refunded_cents: 0, already_refunded: true, needs_staff_review: false });
    expect(h.events).toEqual([]);
  });

  it("the same with the creator already paid flags staff and moves no money", async () => {
    const h = harness({ order: paid({ payout_status: "transferred", stripe_transfer_id: "tr_1" }) });
    stripeCharge(h, { refunded: 16_500 });
    const out = await refundCreatorOrder({ tenant_id: TENANT, order_id: ORDER, cause: "no_show" }, h.deps);
    expect(h.stripe.refunds.create).not.toHaveBeenCalled();
    expect(h.stripe.transfers.createReversal).not.toHaveBeenCalled();
    expect(out).toMatchObject({ refunded_cents: 0, needs_staff_review: true });
  });

  it("an explicit amount is never silently shrunk", async () => {
    const h = harness({ order: paid() });
    stripeCharge(h, { refunded: 4_000 });
    await refundCreatorOrder({ tenant_id: TENANT, order_id: ORDER, cause: "mediation", amount_cents: 6_000 }, h.deps);
    expect(h.stripe.refunds.create.mock.calls[0][0].amount).toBe(6_000);
  });
});

describe("recordCreatorMoneyObservation", () => {
  const observed = {
    tenant_id: TENANT,
    order_id: ORDER,
    kind: "refund" as const,
    cause: "mediation" as const,
    amount_cents: 16_500,
    idempotency_key: `cr-refund-${ORDER}-16500`,
    stripe_object_id: "re_dashboard",
    stripe_event_id: "evt_9",
  };

  it("writes one ledger row, stamped with the Stripe event that reported it", async () => {
    const h = harness({ order: makeOrder({ status: "completed" }) });
    const out = await recordCreatorMoneyObservation(observed, h.deps);
    expect(out).toEqual({ outcome: "inserted", conflicting_stripe_object_id: null });
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({
      kind: "refund",
      cause: "mediation",
      amount_cents: 16_500,
      stripe_object_id: "re_dashboard",
      stripe_event_id: "evt_9",
      livemode: false,
    });
    expect(h.stripe.refunds.create).not.toHaveBeenCalled();
    expect(h.stripe.transfers.create).not.toHaveBeenCalled();
  });

  it("is a no-op on a redelivery of the same event", async () => {
    const h = harness({ order: makeOrder({ status: "completed" }) });
    await recordCreatorMoneyObservation(observed, h.deps);
    const replay = await recordCreatorMoneyObservation(observed, h.deps);
    expect(replay).toEqual({ outcome: "duplicate", conflicting_stripe_object_id: null });
    expect(h.events).toHaveLength(1);
  });

  it("surfaces two different movements that collapsed onto one ledger key", async () => {
    const h = harness({ order: makeOrder({ status: "completed" }) });
    await recordCreatorMoneyObservation(observed, h.deps);
    const clash = await recordCreatorMoneyObservation(
      { ...observed, stripe_object_id: "re_second", stripe_event_id: "evt_10" },
      h.deps,
    );
    expect(clash).toEqual({
      outcome: "duplicate",
      conflicting_stripe_object_id: "re_dashboard",
    });
    expect(h.events).toHaveLength(1);
    expect(h.logs.at(-1)).toMatchObject({ code: "creator.ledger.observation_key_conflict" });
  });

  it("refuses a live order under a test key", async () => {
    const h = harness({ order: makeOrder({ livemode: true }) });
    await expect(recordCreatorMoneyObservation(observed, h.deps)).rejects.toThrowError(/boundary/);
    expect(h.events).toHaveLength(0);
  });

  it("refuses a negative or fractional amount", async () => {
    const h = harness({ order: makeOrder({ status: "completed" }) });
    await expect(
      recordCreatorMoneyObservation({ ...observed, amount_cents: -1 }, h.deps),
    ).rejects.toThrowError(/non-negative/);
    await expect(
      recordCreatorMoneyObservation({ ...observed, amount_cents: 10.5 }, h.deps),
    ).rejects.toThrowError(/non-negative/);
    expect(h.events).toHaveLength(0);
  });

  it("refuses an order from another workspace", async () => {
    const h = harness({ order: makeOrder({ status: "completed" }) });
    await expect(
      recordCreatorMoneyObservation(
        { ...observed, tenant_id: "99999999-9999-9999-9999-999999999999" },
        h.deps,
      ),
    ).rejects.toThrowError(ExpectedToolError);
    expect(h.events).toHaveLength(0);
  });
});

describe("createCreatorSavedCardHold", () => {
  const WALLET = { stripe_customer_id: "cus_w", payment_method_id: "pm_w", creator_consent_at: "2026-09-29T00:00:00Z" };
  const ARGS = { tenant_id: TENANT, order_id: ORDER, creator_country: "US" };

  function saved(opts: { adsAccount?: string; create?: AnyFn; ads?: boolean } = {}) {
    const h = harness();
    const create = vi.fn<any[], any>(opts.create ?? (async () => ({ id: "pi_saved", status: "requires_capture", amount: 16_500, latest_charge: null })));
    (h.stripe.paymentIntents as Record<string, unknown>).create = create;
    h.stripe.accounts.retrieve.mockImplementation(async () => ({ id: "acct_platform" }));
    h.stripe.paymentIntents.cancel.mockImplementation(async (id: string) => ({ id, status: "canceled" }));
    const adsRetrieve = vi.fn<any[], any>(async () => ({ id: opts.adsAccount ?? "acct_platform" }));
    h.deps.adsStripe = opts.ads === false ? () => null : () => ({ accounts: { retrieve: adsRetrieve } }) as unknown as Stripe;
    return { ...h, create, adsRetrieve };
  }

  it("holds the order total off-session with manual capture, the order's metadata and a per-order key", async () => {
    const h = saved();
    const r = await createCreatorSavedCardHold(ARGS, WALLET, h.deps);
    expect(r).toEqual({ kind: "held", payment_intent_id: "pi_saved", hold_expires_at: null });
    expect(h.create).toHaveBeenCalledTimes(1);
    const [params, opts] = h.create.mock.calls[0];
    expect(params).toMatchObject({
      amount: 16_500,
      currency: "usd",
      customer: "cus_w",
      payment_method: "pm_w",
      off_session: true,
      confirm: true,
      capture_method: "manual",
      transfer_group: `creator_order_${ORDER}`,
      metadata: { zavi_creator_order_id: ORDER, zavi_tenant_id: TENANT, zavi_human_member_id: CREATOR, zavi_hold: "saved_card" },
    });
    expect(opts).toEqual({ idempotencyKey: `cr-saved-hold-${ORDER}` });
  });

  it.each([
    ["no card", { ...WALLET, payment_method_id: null }],
    ["no customer", { ...WALLET, stripe_customer_id: null }],
    ["a card saved before the creator-hire consent (test 18)", { ...WALLET, creator_consent_at: null }],
  ])("refuses with no Stripe call: %s", async (_label, wallet) => {
    const h = saved();
    expect(await createCreatorSavedCardHold(ARGS, wallet, h.deps)).toEqual({ kind: "needs_founder", reason: "no_saved_card" });
    expect(h.create).not.toHaveBeenCalled();
  });

  it("refuses when the ads Stripe account is not the creator account (test 12)", async () => {
    const h = saved({ adsAccount: "acct_other" });
    expect(await createCreatorSavedCardHold(ARGS, WALLET, h.deps)).toEqual({ kind: "needs_founder", reason: "stripe_account_mismatch" });
    expect(h.create).not.toHaveBeenCalled();
  });

  it("refuses when the account check cannot be made", async () => {
    const h = saved({ ads: false });
    expect(await createCreatorSavedCardHold(ARGS, WALLET, h.deps)).toEqual({ kind: "needs_founder", reason: "stripe_account_mismatch" });
    const h2 = saved();
    h2.adsRetrieve.mockRejectedValue(new Error("network"));
    expect(await createCreatorSavedCardHold(ARGS, WALLET, h2.deps)).toEqual({ kind: "needs_founder", reason: "stripe_account_mismatch" });
    expect(h.create).not.toHaveBeenCalled();
    expect(h2.create).not.toHaveBeenCalled();
  });

  it("confirm throws with the PaymentIntent in the error: cancels it, nothing held (test 17)", async () => {
    const h = saved({
      create: async () => {
        throw Object.assign(new Error("Your card was declined."), {
          type: "StripeCardError",
          payment_intent: { id: "pi_failed", status: "requires_payment_method" },
        });
      },
    });
    expect(await createCreatorSavedCardHold(ARGS, WALLET, h.deps)).toEqual({ kind: "needs_founder", reason: "card_declined" });
    expect(h.stripe.paymentIntents.cancel).toHaveBeenCalledWith("pi_failed", {}, { idempotencyKey: "cr-orphan-pi_failed" });
  });

  it("3DS required: cancels the PaymentIntent and hands the founder Checkout (test 6)", async () => {
    const h = saved({ create: async () => ({ id: "pi_3ds", status: "requires_action", amount: 16_500 }) });
    expect(await createCreatorSavedCardHold(ARGS, WALLET, h.deps)).toEqual({ kind: "needs_founder", reason: "requires_action" });
    expect(h.stripe.paymentIntents.cancel).toHaveBeenCalledWith("pi_3ds", {}, { idempotencyKey: "cr-orphan-pi_3ds" });
  });

  it.each([
    ["the cancel throws", async () => { throw new Error("network"); }],
    ["the cancel is not confirmed", async (id: string) => ({ id, status: "requires_action" })],
  ])("a PaymentIntent whose cancel is unconfirmed is unknown, never a fallback: %s", async (_label, cancelImpl) => {
    const h = saved({ create: async () => ({ id: "pi_3ds", status: "requires_action", amount: 16_500 }) });
    h.stripe.paymentIntents.cancel.mockImplementation(cancelImpl as AnyFn);
    expect(await createCreatorSavedCardHold(ARGS, WALLET, h.deps)).toEqual({ kind: "unknown" });
  });

  it("an ambiguous failure with no PaymentIntent is unknown, never a fallback", async () => {
    const h = saved({ create: async () => { throw Object.assign(new Error("socket hang up"), { type: "StripeConnectionError" }); } });
    expect(await createCreatorSavedCardHold(ARGS, WALLET, h.deps)).toEqual({ kind: "unknown" });
    expect(h.stripe.paymentIntents.cancel).not.toHaveBeenCalled();
  });

  it("never holds for an order that is not awaiting payment", async () => {
    const h = saved();
    const order = makeOrder({ status: "in_progress" });
    h.deps.loadOrder = async () => order;
    await expect(createCreatorSavedCardHold(ARGS, WALLET, h.deps)).rejects.toMatchObject({ code: "creator_order_not_awaiting_checkout" });
    expect(h.create).not.toHaveBeenCalled();
  });

  it("never holds another tenant's order (test 9)", async () => {
    const h = saved();
    await expect(
      createCreatorSavedCardHold({ ...ARGS, tenant_id: "99999999-9999-9999-9999-999999999999" }, WALLET, h.deps),
    ).rejects.toMatchObject({ code: "creator_order_not_found" });
    expect(h.create).not.toHaveBeenCalled();
  });
});
