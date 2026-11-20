
import type Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";
import type { CreatorOrderMoneyRow, CreatorOrderRef } from "../db";
import { cancelCreatorHold, type CreatorMoneyDeps } from "../orders-money";
import { applyCreatorStripeEvent, type CreatorWebhookDeps } from "../webhook-events";
import { CREATOR_PAYOUT_DISCONNECTED } from "../payout-accounts";

const TENANT = "11111111-1111-1111-1111-111111111111";
const ORDER = "22222222-2222-2222-2222-222222222222";
const CREATOR = "33333333-3333-3333-3333-333333333333";
const ACCOUNT = "acct_creator1";

type AnyFn = (...args: any[]) => any;

function makeRef(over: Partial<CreatorOrderRef> = {}): CreatorOrderRef {
  return {
    id: ORDER,
    tenant_id: TENANT,
    human_member_id: CREATOR,
    livemode: false,
    source: "booking",
    status: "completed",
    closed_reason: "approved",
    payout_status: "awaiting_payout_account",
    payout_ready_at: null,
    stripe_payment_intent_id: "pi_1",
    stripe_transfer_id: null,
    ...over,
  };
}

function makeAccountRow(over: Record<string, unknown> = {}) {
  return {
    id: "pa1",
    human_member_id: CREATOR,
    stripe_account_id: ACCOUNT,
    livemode: false,
    country: "US",
    details_submitted: true,
    payouts_enabled: false,
    disabled_reason: null,
    ...over,
  };
}

function harness(
  opts: {
    ref?: CreatorOrderRef | null;
    accountRow?: ReturnType<typeof makeAccountRow> | null;
    awaiting?: CreatorOrderRef[];
  } = {},
) {
  const ref = opts.ref === undefined ? makeRef() : opts.ref;
  const accountRow = opts.accountRow === undefined ? makeAccountRow() : opts.accountRow;

  const ledger = new Map<string, { kind: string; amount: number; object_id: string }>();
  const logs: Array<{ level?: string; code?: string; meta?: Record<string, unknown> }> = [];
  const payoutState = new Map<string, string>();
  if (ref) payoutState.set(ref.id, ref.payout_status);
  for (const o of opts.awaiting ?? []) payoutState.set(o.id, o.payout_status);

  const transfer = vi.fn<any[], any>(async ({ order_id }: { order_id: string }) => {
    if (payoutState.get(order_id) !== "ready") {
      return { ok: false as const, reason: "claim_lost" as const, message: "already claimed" };
    }
    payoutState.set(order_id, "transferred");
    return {
      ok: true as const,
      transfer_id: "tr_1",
      amount_cents: 12_750,
      already_transferred: false,
      recorded: true,
    };
  });

  const markPayoutReady = vi.fn<any[], any>(async ({ order_id }: { order_id: string }) => {
    if (payoutState.get(order_id) !== "awaiting_payout_account") return false;
    payoutState.set(order_id, "ready");
    return true;
  });

  const updateAccountFlags = vi.fn<any[], any>(async () => {});
  const attachPaymentIntent = vi.fn<any[], any>(async () => true);
  const markTransferred = vi.fn<any[], any>(async () => 1);
  const releaseTransferClaim = vi.fn<any[], any>(async () => 1);
  const fulfil = vi.fn<any[], any>(async () => ({
    state: "fulfilled",
    order_id: ORDER,
    status: "awaiting_creator",
    payment_intent_id: "pi_1",
    hold_expires_at: "2026-09-18T21:02:00.000Z",
  }));
  const cancelHold = vi.fn<any[], any>(async () => ({
    ok: true as const,
    payment_intent_id: "pi_1",
    already_released: true,
  }));
  const releaseOrphanHold = vi.fn<any[], any>(async () => "released");
  const recordObservation = vi.fn<any[], any>(
    async (a: { idempotency_key: string; kind: string; amount_cents: number; stripe_object_id: string }) => {
      const prior = ledger.get(a.idempotency_key);
      if (prior) {
        return {
          outcome: "duplicate" as const,
          conflicting_stripe_object_id:
            prior.object_id !== a.stripe_object_id ? prior.object_id : null,
        };
      }
      ledger.set(a.idempotency_key, {
        kind: a.kind,
        amount: a.amount_cents,
        object_id: a.stripe_object_id,
      });
      return { outcome: "inserted" as const, conflicting_stripe_object_id: null };
    },
  );

  const chargeback = { status: (ref?.chargeback_status ?? null) as string | null };
  const writeChargeback = vi.fn<any[], any>(async ({ to }: { to: string }) => {
    if (to === "open") {
      if (chargeback.status !== null) return false;
    } else if (chargeback.status !== null && chargeback.status !== "open") {
      return false;
    }
    chargeback.status = to;
    return true;
  });
  const closePayoutForChargeback = vi.fn<any[], any>(async () => true);
  const alert = vi.fn<any[], any>(async () => {});

  const deps: CreatorWebhookDeps = {
    resolveOrderById: async (id) => (ref && ref.id === id ? ref : null),
    resolveOrderByPaymentIntent: async (pi) =>
      ref && ref.stripe_payment_intent_id === pi ? ref : null,
    resolveOrderByTransfer: async (tr) => (ref && ref.stripe_transfer_id === tr ? ref : null),
    listPayoutsAwaiting: async () =>
      (opts.awaiting ?? []).filter((o) => payoutState.get(o.id) !== "transferred"),
    markPayoutReady,
    attachPaymentIntent,
    loadAccountByStripeId: async (acct) =>
      accountRow && accountRow.stripe_account_id === acct ? (accountRow as any) : null,
    updateAccountFlags,
    markTransferred,
    releaseTransferClaim,
    fulfil,
    cancelHold,
    releaseOrphanHold,
    recordObservation,
    transfer,
    writeChargeback,
    closePayoutForChargeback,
    alert,
    log: async (input) => {
      logs.push({ level: input.level, code: input.code, meta: input.meta });
    },
  };

  return {
    deps,
    fulfil,
    ledger,
    logs,
    payoutState,
    transfer,
    markPayoutReady,
    updateAccountFlags,
    attachPaymentIntent,
    markTransferred,
    releaseTransferClaim,
    cancelHold,
    releaseOrphanHold,
    recordObservation,
    chargeback,
    writeChargeback,
    closePayoutForChargeback,
    alert,
  };
}

function evt(type: string, object: Record<string, unknown>, over: Record<string, unknown> = {}) {
  return {
    id: "evt_1",
    type,
    livemode: false,
    account: undefined,
    data: { object },
    ...over,
  } as unknown as Stripe.Event;
}

const ACTIVE_ACCOUNT = {
  id: ACCOUNT,
  country: "US",
  details_submitted: true,
  payouts_enabled: true,
  capabilities: { transfers: "active", card_payments: "active" },
  requirements: { disabled_reason: null },
};

describe("account.updated", () => {
  it("releases a payout that was waiting on Stripe setup, EXACTLY once across a replay", async () => {
    const waiting = makeRef({ payout_status: "awaiting_payout_account" });
    const h = harness({ ref: waiting, awaiting: [waiting] });
    const event = evt("account.updated", ACTIVE_ACCOUNT, { account: ACCOUNT });

    const first = await applyCreatorStripeEvent(event, h.deps);
    expect(first).toMatchObject({ outcome: "released", released: 1 });
    expect(h.markPayoutReady).toHaveBeenCalledTimes(1);
    expect(h.transfer).toHaveBeenCalledTimes(1);
    expect(h.transfer.mock.calls[0][0]).toMatchObject({
      tenant_id: TENANT,
      order_id: ORDER,
      cause: "approval",
    });

    const second = await applyCreatorStripeEvent(event, h.deps);
    expect(second).toMatchObject({ outcome: "released", released: 0 });
    expect(h.transfer).toHaveBeenCalledTimes(1);
    expect(h.payoutState.get(ORDER)).toBe("transferred");
  });

  it("records payouts_enabled and country on the payout account", async () => {
    const h = harness({ ref: null, awaiting: [] });
    await applyCreatorStripeEvent(
      evt("account.updated", { ...ACTIVE_ACCOUNT, country: "GB" }, { account: ACCOUNT }),
      h.deps,
    );
    expect(h.updateAccountFlags).toHaveBeenCalledWith({
      stripe_account_id: ACCOUNT,
      details_submitted: true,
      payouts_enabled: true,
      disabled_reason: null,
      country: "GB",
      keepDisconnected: true,
    });
  });

  it("surfaces each payout Stripe setup could not release, with its reason, to staff", async () => {
    const waiting = makeRef({ payout_status: "awaiting_payout_account" });
    const h = harness({ ref: waiting, awaiting: [waiting] });
    h.transfer.mockResolvedValueOnce({ ok: false, reason: "charge_refunded", message: "refunded" });
    const out = await applyCreatorStripeEvent(
      evt("account.updated", ACTIVE_ACCOUNT, { account: ACCOUNT }),
      h.deps,
    );
    expect(out).toMatchObject({ outcome: "released", released: 0, waiting: 1 });
    expect(h.logs).toContainEqual(
      expect.objectContaining({
        level: "warn",
        code: "creator.webhook.payout_still_waiting",
        meta: expect.objectContaining({ creator_order_id: ORDER, reject_reason: "charge_refunded" }),
      }),
    );
  });

  it("caches the flags but releases nothing while transfers are still inactive", async () => {
    const waiting = makeRef();
    const h = harness({ ref: waiting, awaiting: [waiting] });
    const out = await applyCreatorStripeEvent(
      evt(
        "account.updated",
        {
          ...ACTIVE_ACCOUNT,
          payouts_enabled: false,
          capabilities: { transfers: "pending" },
          requirements: { disabled_reason: "requirements.past_due" },
        },
        { account: ACCOUNT },
      ),
      h.deps,
    );
    expect(out).toMatchObject({ outcome: "recorded", released: 0 });
    expect(h.updateAccountFlags).toHaveBeenCalledTimes(1);
    expect(h.transfer).not.toHaveBeenCalled();
  });

  it("never invents a payout cause for an order that closed owing the creator nothing", async () => {
    const cancelled = makeRef({ status: "completed", closed_reason: null });
    const h = harness({ ref: cancelled, awaiting: [cancelled] });
    const out = await applyCreatorStripeEvent(
      evt("account.updated", ACTIVE_ACCOUNT, { account: ACCOUNT }),
      h.deps,
    );
    expect(out).toMatchObject({ outcome: "released", released: 0, waiting: 1 });
    expect(h.transfer).not.toHaveBeenCalled();
    expect(h.markPayoutReady).not.toHaveBeenCalled();
  });

  it("ignores an account that is not part of the creator network, without error", async () => {
    const h = harness({ accountRow: null });
    const out = await applyCreatorStripeEvent(
      evt("account.updated", { ...ACTIVE_ACCOUNT, id: "acct_someoneelse" }, { account: "acct_someoneelse" }),
      h.deps,
    );
    expect(out).toEqual({ outcome: "ignored_unknown_account" });
    expect(h.updateAccountFlags).not.toHaveBeenCalled();
    expect(h.transfer).not.toHaveBeenCalled();
    expect(h.logs.at(-1)).toMatchObject({ meta: { reject_reason: "unknown_account" } });
  });

  it("refuses an account event whose livemode differs from the stored account", async () => {
    const h = harness();
    const out = await applyCreatorStripeEvent(
      evt("account.updated", ACTIVE_ACCOUNT, { account: ACCOUNT, livemode: true }),
      h.deps,
    );
    expect(out).toEqual({ outcome: "ignored_livemode_mismatch" });
    expect(h.updateAccountFlags).not.toHaveBeenCalled();
    expect(h.transfer).not.toHaveBeenCalled();
  });
});

describe("account.application.deauthorized", () => {
  it("blocks future payouts by stamping the account, and surfaces it to staff", async () => {
    const h = harness();
    const out = await applyCreatorStripeEvent(
      evt("account.application.deauthorized", { id: "ca_1", object: "application" }, { account: ACCOUNT }),
      h.deps,
    );
    expect(out).toEqual({ outcome: "recorded" });
    expect(h.updateAccountFlags).toHaveBeenCalledWith({
      stripe_account_id: ACCOUNT,
      details_submitted: true,
      payouts_enabled: false,
      disabled_reason: CREATOR_PAYOUT_DISCONNECTED,
    });
    expect(h.logs.at(-1)).toMatchObject({
      level: "error",
      code: "creator.webhook.account_deauthorized",
    });
  });

  it("keeps the block when a stale account.updated arrives after the disconnect", async () => {
    const waiting = makeRef();
    const h = harness({
      ref: waiting,
      awaiting: [waiting],
      accountRow: makeAccountRow({ disabled_reason: CREATOR_PAYOUT_DISCONNECTED }),
    });
    const out = await applyCreatorStripeEvent(
      evt("account.updated", ACTIVE_ACCOUNT, { account: ACCOUNT }),
      h.deps,
    );
    expect(out).toMatchObject({ outcome: "recorded", released: 0 });
    expect(h.updateAccountFlags).toHaveBeenCalledWith(
      expect.objectContaining({
        payouts_enabled: false,
        disabled_reason: CREATOR_PAYOUT_DISCONNECTED,
      }),
    );
    expect(h.transfer).not.toHaveBeenCalled();
  });

  it("lifts the block only when the creator reconnects", async () => {
    const h = harness({
      accountRow: makeAccountRow({ disabled_reason: CREATOR_PAYOUT_DISCONNECTED }),
    });
    const out = await applyCreatorStripeEvent(
      evt("account.application.authorized", { id: "ca_1" }, { account: ACCOUNT }),
      h.deps,
    );
    expect(out).toEqual({ outcome: "recorded" });
    expect(h.updateAccountFlags).toHaveBeenCalledWith(
      expect.objectContaining({ disabled_reason: null, payouts_enabled: false }),
    );
  });

  it("ignores a deauthorization for an account outside the creator network", async () => {
    const h = harness({ accountRow: null });
    const out = await applyCreatorStripeEvent(
      evt("account.application.deauthorized", { id: "ca_1" }, { account: "acct_other" }),
      h.deps,
    );
    expect(out).toEqual({ outcome: "ignored_unknown_account" });
    expect(h.updateAccountFlags).not.toHaveBeenCalled();
  });
});

describe("payment_intent.*", () => {
  const PI = {
    id: "pi_1",
    amount: 16_500,
    metadata: { zavi_creator_order_id: ORDER },
  };

  it("fulfils through S7 rather than recording the hold itself", async () => {
    const h = harness({ ref: makeRef({ stripe_payment_intent_id: null }) });
    const out = await applyCreatorStripeEvent(
      evt("payment_intent.amount_capturable_updated", PI),
      h.deps,
    );
    expect(out).toEqual({ outcome: "recorded" });
    expect(h.fulfil).toHaveBeenCalledWith({ tenant_id: TENANT, order_id: ORDER });
    expect(h.attachPaymentIntent).not.toHaveBeenCalled();
  });

  it("a pending fulfilment is still recorded, not an error", async () => {
    const h = harness({ ref: makeRef({ stripe_payment_intent_id: null }) });
    h.fulfil.mockResolvedValueOnce({ state: "pending", order_id: ORDER, reason: "no_checkout" });
    const out = await applyCreatorStripeEvent(
      evt("payment_intent.amount_capturable_updated", PI),
      h.deps,
    );
    expect(out).toEqual({ outcome: "recorded" });
  });

  it("S6: a hold waiting on another hire for its brief fails the delivery so Stripe redelivers", async () => {
    const h = harness({ ref: makeRef({ stripe_payment_intent_id: null }) });
    h.fulfil.mockResolvedValueOnce({ state: "pending", order_id: ORDER, reason: "brief_held" });
    await expect(
      applyCreatorStripeEvent(evt("payment_intent.amount_capturable_updated", PI), h.deps),
    ).rejects.toThrow(/waiting on another hire/);
  });

  it("a hold that lands on an already-CANCELLED order (closed unpaid, page still open) is released", async () => {
    const h = harness({ ref: makeRef({ stripe_payment_intent_id: null }) });
    h.fulfil.mockResolvedValueOnce({ state: "already_done", order_id: ORDER, status: "cancelled" });
    const out = await applyCreatorStripeEvent(evt("payment_intent.amount_capturable_updated", PI), h.deps);
    expect(out).toEqual({ outcome: "recorded" });
    expect(h.releaseOrphanHold).toHaveBeenCalledWith({ payment_intent_id: "pi_1", order_livemode: false });
  });

  it("a stray CAPTURE on a cancelled order is logged at error for staff, never refunded here", async () => {
    const h = harness({ ref: makeRef({ stripe_payment_intent_id: null }) });
    h.fulfil.mockResolvedValueOnce({ state: "already_done", order_id: ORDER, status: "cancelled" });
    h.releaseOrphanHold.mockResolvedValueOnce("captured");
    await applyCreatorStripeEvent(evt("payment_intent.amount_capturable_updated", PI), h.deps);
    expect(h.logs.find((l) => l.code === "creator.webhook.orphan_hold")?.level).toBe("error");
  });

  it("an already-fulfilled order is a no-op, so webhook and browser can race", async () => {
    const h = harness({ ref: makeRef({ stripe_payment_intent_id: null }) });
    h.fulfil.mockResolvedValueOnce({
      state: "already_done",
      order_id: ORDER,
      status: "in_progress",
    });
    const out = await applyCreatorStripeEvent(
      evt("payment_intent.amount_capturable_updated", PI),
      h.deps,
    );
    expect(out).toEqual({ outcome: "recorded" });
  });

  it("releases a lapsed hold with the honest cause and blames nobody", async () => {
    const h = harness();
    const out = await applyCreatorStripeEvent(
      evt("payment_intent.canceled", { ...PI, cancellation_reason: "automatic" }),
      h.deps,
    );
    expect(out).toEqual({ outcome: "recorded" });
    expect(h.cancelHold).toHaveBeenCalledWith({
      tenant_id: TENANT,
      order_id: ORDER,
      cause: "expiry",
      expected_payment_intent_id: "pi_1",
    });
  });

  it("ignores a cancellation for a PaymentIntent the order has already moved off", async () => {
    const h = harness({ ref: makeRef({ stripe_payment_intent_id: "pi_2" }) });
    const out = await applyCreatorStripeEvent(
      evt("payment_intent.canceled", { ...PI, id: "pi_1", cancellation_reason: "abandoned" }),
      h.deps,
    );
    expect(out).toEqual({ outcome: "ignored_unknown_object" });
    expect(h.cancelHold).not.toHaveBeenCalled();
    expect(h.attachPaymentIntent).not.toHaveBeenCalled();
    expect(h.logs.at(-1)).toMatchObject({
      meta: { reject_reason: "superseded_payment_intent", object_id: "pi_1" },
    });
  });

  it("a cancellation for pi_A that passed the check before fulfilment moved the order to held pi_B leaves pi_B alone", async () => {
    const h = harness({ ref: makeRef({ status: "checkout_pending", stripe_payment_intent_id: "pi_A" }) });
    const order: CreatorOrderMoneyRow = {
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
      status: "awaiting_creator",
      payout_status: "not_due",
      stripe_checkout_session_id: "cs_1",
      stripe_payment_intent_id: "pi_A",
      stripe_transfer_id: null,
      hold_expires_at: null,
    };
    const stripe = {
      paymentIntents: {
        retrieve: vi.fn<any[], any>(async (id: string) => ({
          id,
          status: id === "pi_B" ? "requires_capture" : "canceled",
          amount: 16_500,
          latest_charge: id === "pi_B" ? { id: "ch_B", payment_method_details: { card: { capture_before: 1_800_000_000 } } } : null,
        })),
        cancel: vi.fn<any[], any>(async (id: string) => ({ id, status: "canceled" })),
      },
    };
    const rows: string[] = [];
    const moneyDeps = {
      stripe: () => stripe as unknown as Stripe,
      loadOrder: async () => order,
      recordEvent: async (row: { idempotency_key: string }) => {
        rows.push(row.idempotency_key);
        return "inserted" as const;
      },
      findEvent: async () => null,
      platformKey: () => "sk_test_fake",
      log: async () => {},
    } as unknown as CreatorMoneyDeps;
    h.deps.resolveOrderById = async () => {
      const snapshot = makeRef({ status: "checkout_pending", stripe_payment_intent_id: "pi_A" });
      order.stripe_payment_intent_id = "pi_B";
      return snapshot;
    };
    h.deps.cancelHold = ((args: Parameters<typeof cancelCreatorHold>[0]) => cancelCreatorHold(args, moneyDeps)) as never;
    const settleHire = vi.fn<any[], any>(async () => ({ status: "ok" }));
    h.deps.settleHire = settleHire as never;

    const out = await applyCreatorStripeEvent(
      evt("payment_intent.canceled", { ...PI, id: "pi_A", metadata: { zavi_creator_order_id: ORDER }, cancellation_reason: "automatic" }),
      h.deps,
    );

    expect(stripe.paymentIntents.cancel).not.toHaveBeenCalled();
    expect(stripe.paymentIntents.retrieve.mock.calls.map((c) => c[0])).not.toContain("pi_B");
    expect(rows).toEqual([]);
    expect(settleHire).not.toHaveBeenCalled();
    expect(out).toEqual({ outcome: "ignored_unknown_object" });
    expect(h.logs.at(-1)).toMatchObject({ meta: { reject_reason: "superseded_payment_intent", object_id: "pi_A" } });
  });

  it("still releases the hold the order is actually bound to", async () => {
    const h = harness({ ref: makeRef({ stripe_payment_intent_id: "pi_1" }) });
    const out = await applyCreatorStripeEvent(
      evt("payment_intent.canceled", { ...PI, id: "pi_1", cancellation_reason: "abandoned" }),
      h.deps,
    );
    expect(out).toEqual({ outcome: "recorded" });
    expect(h.cancelHold).toHaveBeenCalledTimes(1);
  });

  it("an abandoned Checkout PaymentIntent on an order with no payment is NOT bound and releases nothing", async () => {
    const h = harness({ ref: makeRef({ status: "checkout_pending", stripe_payment_intent_id: null }) });
    const out = await applyCreatorStripeEvent(
      evt("payment_intent.canceled", { ...PI, id: "pi_A", cancellation_reason: "abandoned" }),
      h.deps,
    );
    expect(out).toEqual({ outcome: "ignored_unknown_object" });
    expect(h.attachPaymentIntent).not.toHaveBeenCalled();
    expect(h.cancelHold).not.toHaveBeenCalled();
    expect(h.logs.at(-1)).toMatchObject({ meta: { reject_reason: "abandoned_never_held", object_id: "pi_A" } });
  });

  it("a hold that lapsed before its hold-placed delivery landed is still bound and released", async () => {
    const h = harness({ ref: makeRef({ status: "checkout_pending", stripe_payment_intent_id: null }) });
    const out = await applyCreatorStripeEvent(
      evt("payment_intent.canceled", { ...PI, id: "pi_held", cancellation_reason: "automatic" }),
      h.deps,
    );
    expect(out).toEqual({ outcome: "recorded" });
    expect(h.attachPaymentIntent).toHaveBeenCalledWith({ tenant_id: TENANT, order_id: ORDER, payment_intent_id: "pi_held", hold_expires_at: null });
    expect(h.cancelHold).toHaveBeenCalledWith({ tenant_id: TENANT, order_id: ORDER, cause: "expiry", expected_payment_intent_id: "pi_held" });
  });

  it("maps an abandoned checkout to checkout_abandoned", async () => {
    const h = harness();
    await applyCreatorStripeEvent(
      evt("payment_intent.canceled", { ...PI, cancellation_reason: "abandoned" }),
      h.deps,
    );
    expect(h.cancelHold.mock.calls[0][0]).toMatchObject({ cause: "checkout_abandoned" });
  });

  it("writes NO ledger row for a declined card, because no money moved", async () => {
    const h = harness();
    const out = await applyCreatorStripeEvent(
      evt("payment_intent.payment_failed", { ...PI, last_payment_error: { code: "card_declined" } }),
      h.deps,
    );
    expect(out).toEqual({ outcome: "recorded" });
    expect(h.recordObservation).not.toHaveBeenCalled();
    expect(h.logs.at(-1)).toMatchObject({
      level: "warn",
      meta: { reject_reason: "card_declined" },
    });
  });

  it("ignores a PaymentIntent that belongs to no creator order", async () => {
    const h = harness({ ref: null });
    const out = await applyCreatorStripeEvent(
      evt("payment_intent.amount_capturable_updated", { id: "pi_other", amount: 500, metadata: {} }),
      h.deps,
    );
    expect(out).toEqual({ outcome: "ignored_unknown_object" });
    expect(h.fulfil).not.toHaveBeenCalled();
    expect(h.attachPaymentIntent).not.toHaveBeenCalled();
  });

  it("refuses an event whose livemode differs from the order it points at", async () => {
    const h = harness();
    const out = await applyCreatorStripeEvent(
      evt("payment_intent.amount_capturable_updated", PI, { livemode: true }),
      h.deps,
    );
    expect(out).toEqual({ outcome: "ignored_livemode_mismatch" });
    expect(h.fulfil).not.toHaveBeenCalled();
  });
});

describe("charge.refunded", () => {
  const CHARGE = {
    id: "ch_1",
    payment_intent: "pi_1",
    amount_refunded: 16_500,
    metadata: { zavi_creator_order_id: ORDER },
    refunds: { data: [{ id: "re_1", amount: 16_500 }] },
  };

  it("records an out-of-band refund once, and says loudly that no reversal was paired with it", async () => {
    const h = harness();
    const first = await applyCreatorStripeEvent(evt("charge.refunded", CHARGE), h.deps);
    expect(first).toEqual({ outcome: "recorded" });
    expect(h.ledger.size).toBe(1);
    expect(h.logs.at(-1)).toMatchObject({
      level: "error",
      code: "creator.webhook.refund_out_of_band",
    });

    const second = await applyCreatorStripeEvent(evt("charge.refunded", CHARGE), h.deps);
    expect(second).toEqual({ outcome: "recorded" });
    expect(h.ledger.size).toBe(1);
    expect(h.logs.filter((l) => l.code === "creator.webhook.refund_out_of_band")).toHaveLength(1);
  });

  it("keys a refund Zavi issued by the key S2 stamped on it, so it is not double counted", async () => {
    const h = harness();
    h.ledger.set(`cr-refund-${ORDER}-16500`, { kind: "refund", amount: 16_500, object_id: "re_1" });
    const charge = {
      ...CHARGE,
      refunds: { data: [{ id: "re_1", amount: 16_500, metadata: { zavi_idempotency_key: `cr-refund-${ORDER}-16500` } }] },
    };
    await applyCreatorStripeEvent(evt("charge.refunded", charge), h.deps);
    expect([...h.ledger.keys()]).toEqual([`cr-refund-${ORDER}-16500`]);
    expect(h.logs.some((l) => l.code === "creator.webhook.refund_out_of_band")).toBe(false);
  });

  it("keys a refund issued outside Zavi by its own refund id", async () => {
    const h = harness();
    await applyCreatorStripeEvent(evt("charge.refunded", CHARGE), h.deps);
    expect([...h.ledger.keys()]).toEqual([`cr-refund-${ORDER}-re_1`]);
  });
});

describe("charge.refunded on the pinned API version, where the charge carries no refunds list", () => {
  const BARE = (amount_refunded: number) => ({
    id: "ch_1",
    payment_intent: "pi_1",
    amount_refunded,
    metadata: { zavi_creator_order_id: ORDER },
  });
  const zavi = (id: string, amount: number) => ({
    id,
    amount,
    status: "succeeded",
    metadata: { zavi_creator_order_id: ORDER, zavi_idempotency_key: `cr-refund-${ORDER}-${amount}` },
  });
  const dashboard = (id: string, amount: number) => ({ id, amount, status: "succeeded", metadata: {} });

  function withRefunds(h: ReturnType<typeof harness>, pages: Array<Array<Record<string, unknown>>>) {
    const asked: string[] = [];
    let call = 0;
    h.deps.listChargeRefunds = (async (charge_id: string) => {
      asked.push(charge_id);
      return pages[Math.min(call++, pages.length - 1)];
    }) as never;
    return asked;
  }

  it("a refund Zavi issued and already recorded raises no key conflict, no new row and no out-of-band alarm", async () => {
    const h = harness();
    h.ledger.set(`cr-refund-${ORDER}-5000`, { kind: "refund", amount: 5_000, object_id: "re_1" });
    const asked = withRefunds(h, [[zavi("re_1", 5_000)]]);
    await applyCreatorStripeEvent(evt("charge.refunded", BARE(5_000)), h.deps);
    expect(asked).toEqual(["ch_1"]);
    expect(h.ledger.size).toBe(1);
    const results = await Promise.all(h.recordObservation.mock.results.map((r) => r.value));
    expect(results).toEqual([{ outcome: "duplicate", conflicting_stripe_object_id: null }]);
    expect(h.recordObservation.mock.calls[0][0]).toMatchObject({ stripe_object_id: "re_1", amount_cents: 5_000 });
    expect(h.logs.some((l) => l.code === "creator.webhook.refund_out_of_band")).toBe(false);
  });

  it("two partial refunds from the dashboard land as 3000 and 2000, never as the 5000 running total", async () => {
    const h = harness();
    withRefunds(h, [[dashboard("re_1", 3_000)], [dashboard("re_2", 2_000), dashboard("re_1", 3_000)]]);
    await applyCreatorStripeEvent(evt("charge.refunded", BARE(3_000), { id: "evt_r1" }), h.deps);
    await applyCreatorStripeEvent(evt("charge.refunded", BARE(5_000), { id: "evt_r2" }), h.deps);
    const amounts = [...h.ledger.values()].map((r) => r.amount).sort((a, b) => a - b);
    expect(amounts).toEqual([2_000, 3_000]);
    expect([...h.ledger.values()].map((r) => r.object_id).sort()).toEqual(["re_1", "re_2"]);
    expect(h.logs.filter((l) => l.code === "creator.webhook.refund_out_of_band")).toHaveLength(2);
  });

  it("two partial refunds Zavi issued add nothing to the two rows it already wrote", async () => {
    const h = harness();
    h.ledger.set(`cr-refund-${ORDER}-3000`, { kind: "refund", amount: 3_000, object_id: "re_1" });
    h.ledger.set(`cr-refund-${ORDER}-2000`, { kind: "refund", amount: 2_000, object_id: "re_2" });
    withRefunds(h, [[zavi("re_1", 3_000)], [zavi("re_2", 2_000), zavi("re_1", 3_000)]]);
    await applyCreatorStripeEvent(evt("charge.refunded", BARE(3_000), { id: "evt_r1" }), h.deps);
    await applyCreatorStripeEvent(evt("charge.refunded", BARE(5_000), { id: "evt_r2" }), h.deps);
    expect(h.ledger.size).toBe(2);
    expect([...h.ledger.values()].reduce((n, r) => n + r.amount, 0)).toBe(5_000);
    expect(h.logs.some((l) => l.code === "creator.webhook.refund_out_of_band")).toBe(false);
  });

  it("a dashboard refund recorded under the old amount key before deploy is not recorded again", async () => {
    const h = harness();
    h.ledger.set(`cr-refund-${ORDER}-3000`, { kind: "refund", amount: 3_000, object_id: "re_1" });
    h.deps.findEvent = (async (_t: string, key: string) => {
      const row = h.ledger.get(key);
      return row ? { amount_cents: row.amount, stripe_object_id: row.object_id } : null;
    }) as never;
    withRefunds(h, [[dashboard("re_2", 2_000), dashboard("re_1", 3_000)]]);
    await applyCreatorStripeEvent(evt("charge.refunded", BARE(5_000), { id: "evt_r2" }), h.deps);
    expect([...h.ledger.values()].map((r) => r.object_id).sort()).toEqual(["re_1", "re_2"]);
    expect([...h.ledger.values()].reduce((n, r) => n + r.amount, 0)).toBe(5_000);
    expect(h.logs.filter((l) => l.code === "creator.webhook.refund_out_of_band")).toHaveLength(1);
  });

  it("a dashboard refund the old handler recorded under the charge id is not recorded again", async () => {
    const h = harness();
    h.ledger.set(`cr-refund-${ORDER}-3000`, { kind: "refund", amount: 3_000, object_id: "ch_1" });
    h.deps.findEvent = (async (_t: string, key: string) => {
      const row = h.ledger.get(key);
      return row ? { amount_cents: row.amount, stripe_object_id: row.object_id } : null;
    }) as never;
    withRefunds(h, [[dashboard("re_1", 3_000)]]);
    await applyCreatorStripeEvent(evt("charge.refunded", BARE(3_000), { id: "evt_r1b" }), h.deps);
    expect([...h.ledger.keys()]).toEqual([`cr-refund-${ORDER}-3000`]);
    expect([...h.ledger.values()].reduce((n, r) => n + r.amount, 0)).toBe(3_000);
    expect(h.logs.some((l) => l.code === "creator.webhook.refund_out_of_band")).toBe(false);
  });

  for (const order of [["re_2", "re_1"], ["re_1", "re_2"]]) {
    it(`a second same-size dashboard refund after a charge-id legacy row is recorded once (${order.join(",")})`, async () => {
      const h = harness();
      h.ledger.set(`cr-refund-${ORDER}-3000`, { kind: "refund", amount: 3_000, object_id: "ch_1" });
      h.deps.findEvent = (async (_t: string, key: string) => {
        const row = h.ledger.get(key);
        return row ? { amount_cents: row.amount, stripe_object_id: row.object_id } : null;
      }) as never;
      const page = order.map((id) => dashboard(id, 3_000));
      withRefunds(h, [page, [...page].reverse()]);
      await applyCreatorStripeEvent(evt("charge.refunded", BARE(6_000), { id: "evt_r2c" }), h.deps);
      await applyCreatorStripeEvent(evt("charge.refunded", BARE(6_000), { id: "evt_r2c" }), h.deps);
      expect(h.ledger.size).toBe(2);
      expect([...h.ledger.values()].reduce((n, r) => n + r.amount, 0)).toBe(6_000);
      expect(h.logs.filter((l) => l.code === "creator.webhook.refund_out_of_band")).toHaveLength(1);
    });
  }

  it("two same-size dashboard refunds are two rows, not one collision", async () => {
    const h = harness();
    withRefunds(h, [[dashboard("re_2", 2_500), dashboard("re_1", 2_500)]]);
    await applyCreatorStripeEvent(evt("charge.refunded", BARE(5_000)), h.deps);
    expect(h.ledger.size).toBe(2);
    expect([...h.ledger.values()].reduce((n, r) => n + r.amount, 0)).toBe(5_000);
  });

  it("a failed or canceled refund is not money back and is not recorded", async () => {
    const h = harness();
    withRefunds(h, [[{ ...dashboard("re_f", 4_000), status: "failed" }, { ...dashboard("re_c", 1_000), status: "canceled" }]]);
    await applyCreatorStripeEvent(evt("charge.refunded", BARE(0)), h.deps);
    expect(h.ledger.size).toBe(0);
  });

  it("a key in metadata that names another order is not trusted", async () => {
    const h = harness();
    withRefunds(h, [[{ ...dashboard("re_x", 1_000), metadata: { zavi_idempotency_key: "cr-refund-other-order-1000" } }]]);
    await applyCreatorStripeEvent(evt("charge.refunded", BARE(1_000)), h.deps);
    expect([...h.ledger.keys()]).toEqual([`cr-refund-${ORDER}-re_x`]);
    expect(h.logs.some((l) => l.code === "creator.webhook.refund_out_of_band")).toBe(true);
  });

  it("a Stripe listing failure fails the delivery so Stripe redelivers", async () => {
    const h = harness();
    h.deps.listChargeRefunds = (async () => {
      throw new Error("stripe down");
    }) as never;
    await expect(applyCreatorStripeEvent(evt("charge.refunded", BARE(5_000)), h.deps)).rejects.toThrow(/stripe down/);
    expect(h.ledger.size).toBe(0);
  });
});

describe("transfer.*", () => {
  const TR = {
    id: "tr_1",
    amount: 12_750,
    amount_reversed: 0,
    metadata: { zavi_creator_order_id: ORDER, zavi_cause: "approval" },
  };

  it("recovers a transfer S2 sent but could not record, and finalizes the order once", async () => {
    const h = harness({ ref: makeRef({ payout_status: "transferring", stripe_transfer_id: null }) });
    const out = await applyCreatorStripeEvent(evt("transfer.created", TR), h.deps);
    expect(out).toEqual({ outcome: "recorded" });
    expect(h.markTransferred).toHaveBeenCalledWith({
      order_id: ORDER,
      transfer_id: "tr_1",
      idempotency_key: `cr-transfer-${ORDER}`,
      cause: "approval",
    });
  });

  it("confirms an already-recorded transfer without writing a second ledger row", async () => {
    const h = harness({ ref: makeRef({ payout_status: "transferred", stripe_transfer_id: "tr_1" }) });
    await applyCreatorStripeEvent(evt("transfer.created", TR), h.deps);
    expect(h.markTransferred).not.toHaveBeenCalled();
    expect(h.recordObservation).toHaveBeenCalledTimes(1);
    expect([...h.ledger.keys()]).toEqual([`cr-transfer-${ORDER}`]);
  });

  it("releases the payout claim when a transfer fails, so it stays retryable", async () => {
    const h = harness({ ref: makeRef({ payout_status: "transferring", stripe_transfer_id: "tr_1" }) });
    const out = await applyCreatorStripeEvent(evt("transfer.failed", TR), h.deps);
    expect(out).toEqual({ outcome: "recorded" });
    expect(h.releaseTransferClaim).toHaveBeenCalledWith(ORDER);
    expect(h.logs.at(-1)).toMatchObject({ level: "error", code: "creator.webhook.transfer_failed" });
  });

  it("never releases a claim for a payout the order already records as sent", async () => {
    const h = harness({ ref: makeRef({ payout_status: "transferred", stripe_transfer_id: "tr_1" }) });
    await applyCreatorStripeEvent(evt("transfer.failed", TR), h.deps);
    expect(h.releaseTransferClaim).not.toHaveBeenCalled();
    expect(h.logs.at(-1)).toMatchObject({
      level: "error",
      code: "creator.webhook.transfer_failed_after_record",
    });
  });

  it("records an out-of-band reversal once and flags that the order still reads as paid", async () => {
    const h = harness({ ref: makeRef({ payout_status: "transferred", stripe_transfer_id: "tr_1" }) });
    const reversed = {
      ...TR,
      amount_reversed: 12_750,
      reversals: { data: [{ id: "trr_1", amount: 12_750 }] },
    };
    await applyCreatorStripeEvent(evt("transfer.reversed", reversed), h.deps);
    expect([...h.ledger.keys()]).toEqual([`cr-reversal-${ORDER}-12750`]);
    expect(h.logs.at(-1)).toMatchObject({ level: "error" });

    await applyCreatorStripeEvent(evt("transfer.reversed", reversed), h.deps);
    expect(h.ledger.size).toBe(1);
    expect(h.logs.at(-1)).toMatchObject({ level: "info" });
  });

  it("ignores a transfer that belongs to no creator order", async () => {
    const h = harness({ ref: null });
    const out = await applyCreatorStripeEvent(
      evt("transfer.created", { id: "tr_other", amount: 100, metadata: {} }),
      h.deps,
    );
    expect(out).toEqual({ outcome: "ignored_unknown_object" });
    expect(h.markTransferred).not.toHaveBeenCalled();
    expect(h.recordObservation).not.toHaveBeenCalled();
  });
});

describe("charge.dispute.*", () => {
  const DISPUTE = { id: "dp_1", payment_intent: "pi_1", amount: 16_500, metadata: {} };

  it("opens a chargeback on the order, which freezes the payout", async () => {
    const h = harness({ ref: makeRef({ payout_status: "ready" }) });
    const out = await applyCreatorStripeEvent(evt("charge.dispute.created", { ...DISPUTE, status: "needs_response" }), h.deps);
    expect(out).toEqual({ outcome: "recorded" });
    expect(h.chargeback.status).toBe("open");
    expect(h.writeChargeback).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: TENANT, order_id: ORDER, stripe_dispute_id: "dp_1", to: "open" }),
    );
    expect(h.alert).not.toHaveBeenCalled();
    expect(h.logs.at(-1)).toMatchObject({ level: "warn", code: "creator.webhook.chargeback_opened" });
  });

  it("is a no-op on replay of created", async () => {
    const h = harness();
    await applyCreatorStripeEvent(evt("charge.dispute.created", DISPUTE), h.deps);
    await applyCreatorStripeEvent(evt("charge.dispute.created", DISPUTE), h.deps);
    expect(h.chargeback.status).toBe("open");
    expect(h.logs.at(-1)).toMatchObject({ level: "info" });
  });

  it("won lifts the freeze and pages no one", async () => {
    const h = harness();
    await applyCreatorStripeEvent(evt("charge.dispute.created", DISPUTE), h.deps);
    await applyCreatorStripeEvent(evt("charge.dispute.closed", { ...DISPUTE, status: "won" }), h.deps);
    expect(h.chargeback.status).toBe("won");
    expect(h.alert).not.toHaveBeenCalled();
    expect(h.closePayoutForChargeback).not.toHaveBeenCalled();
  });

  it("lost closes a waiting payout and pages no one", async () => {
    const h = harness();
    await applyCreatorStripeEvent(evt("charge.dispute.created", DISPUTE), h.deps);
    await applyCreatorStripeEvent(evt("charge.dispute.closed", { ...DISPUTE, status: "lost" }), h.deps);
    expect(h.chargeback.status).toBe("lost");
    expect(h.closePayoutForChargeback).toHaveBeenCalledWith({ tenant_id: TENANT, order_id: ORDER });
    expect(h.alert).not.toHaveBeenCalled();
    expect(h.logs.at(-1)).toMatchObject({ level: "warn", code: "creator.webhook.chargeback_lost" });
  });

  it("lost AFTER the payout left pages staff and moves no money", async () => {
    const h = harness({ ref: makeRef({ payout_status: "transferred", stripe_transfer_id: "tr_1" }) });
    const out = await applyCreatorStripeEvent(evt("charge.dispute.closed", { ...DISPUTE, status: "lost" }), h.deps);
    expect(out).toEqual({ outcome: "recorded" });
    expect(h.chargeback.status).toBe("lost");
    expect(h.alert).toHaveBeenCalledTimes(1);
    expect(h.alert).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "creator_chargeback_lost_after_payout",
        tenant_id: TENANT,
        email: { dedupeKey: "creator_chargeback_lost_after_payout:dp_1", required: true },
      }),
    );
    expect(h.transfer).not.toHaveBeenCalled();
    expect(h.cancelHold).not.toHaveBeenCalled();
    expect(h.recordObservation).not.toHaveBeenCalled();
    expect(h.logs.at(-1)).toMatchObject({ level: "error", code: "creator.webhook.chargeback_lost" });
  });

  it("lost AFTER the payout: a failed page throws so the webhook 500s and Stripe redelivers", async () => {
    const h = harness({ ref: makeRef({ payout_status: "transferred", stripe_transfer_id: "tr_1" }) });
    h.alert.mockImplementationOnce(async () => {
      throw new Error("sendgrid 503");
    });
    const lost = evt("charge.dispute.closed", { ...DISPUTE, status: "lost" });
    await expect(applyCreatorStripeEvent(lost, h.deps)).rejects.toThrow("sendgrid 503");
    expect(h.chargeback.status).toBe("lost");
    await expect(applyCreatorStripeEvent(lost, h.deps)).resolves.toEqual({ outcome: "recorded" });
    expect(h.alert).toHaveBeenCalledTimes(2);
    expect(h.transfer).not.toHaveBeenCalled();
  });

  it("a closed that beats its created still lands, and the late created cannot reopen it", async () => {
    const h = harness();
    await applyCreatorStripeEvent(evt("charge.dispute.closed", { ...DISPUTE, status: "lost" }), h.deps);
    await applyCreatorStripeEvent(evt("charge.dispute.created", DISPUTE), h.deps);
    expect(h.chargeback.status).toBe("lost");
  });

  it("a replayed lost re-runs the (idempotent) close so a crash mid-way still finishes", async () => {
    const h = harness();
    await applyCreatorStripeEvent(evt("charge.dispute.closed", { ...DISPUTE, status: "lost" }), h.deps);
    await applyCreatorStripeEvent(evt("charge.dispute.closed", { ...DISPUTE, status: "lost" }), h.deps);
    expect(h.closePayoutForChargeback).toHaveBeenCalledTimes(2);
    expect(h.chargeback.status).toBe("lost");
  });

  it("ignores a dispute on a charge that is not a creator order", async () => {
    const h = harness({ ref: null });
    const out = await applyCreatorStripeEvent(evt("charge.dispute.created", { ...DISPUTE, payment_intent: "pi_other" }), h.deps);
    expect(out).toEqual({ outcome: "ignored_unknown_object" });
    expect(h.writeChargeback).not.toHaveBeenCalled();
  });

  it("refuses a dispute whose livemode does not match the order", async () => {
    const h = harness({ ref: makeRef({ livemode: true }) });
    await applyCreatorStripeEvent(evt("charge.dispute.created", DISPUTE), h.deps);
    expect(h.writeChargeback).not.toHaveBeenCalled();
  });
});

describe("dispatch", () => {
  it("ignores an event type this rail does not handle", async () => {
    const h = harness();
    const out = await applyCreatorStripeEvent(evt("invoice.paid", { id: "in_1" }), h.deps);
    expect(out).toEqual({ outcome: "ignored_unhandled_type" });
  });
});

describe("creator hire reservation settlement", () => {
  const PIO = { id: "pi_1", metadata: { zavi_creator_order_id: ORDER, zavi_tenant_id: TENANT } };

  function withLedger(h: ReturnType<typeof harness>, initial: "held" | "spent" | null = "held") {
    const row = { state: initial as string | null, refunded: 0, changes: 0 };
    h.deps.settleHire = (async (_t: string, _o: string, outcome: "spent" | "released") => {
      if (!row.state) return { status: "not_found" };
      if (row.state === outcome || row.state === "refunded" || (row.state === "spent" && outcome === "released")) return { status: row.state, changed: false };
      row.state = outcome;
      row.changes += 1;
      return { status: outcome, changed: true };
    }) as never;
    const refundHire = vi.fn(async (_t: string, _o: string, usd: number) => {
      if (row.state !== "spent" && row.state !== "refunded") return { status: "not_found" };
      row.refunded = Math.max(row.refunded, usd);
      return { status: "partially_refunded", refunded_usd: row.refunded };
    });
    h.deps.refundHire = refundHire as never;
    return { row, refundHire };
  }

  it("capture then a crash before settle: payment_intent.succeeded settles it spent, exactly once (test 19)", async () => {
    const h = harness({ ref: makeRef({ status: "in_progress" }) });
    const { row } = withLedger(h, "held");
    const e = evt("payment_intent.succeeded", { ...PIO, status: "succeeded" });
    expect(await applyCreatorStripeEvent(e, h.deps)).toEqual({ outcome: "recorded" });
    expect(await applyCreatorStripeEvent(e, h.deps)).toEqual({ outcome: "recorded" });
    expect(row.state).toBe("spent");
    expect(row.changes).toBe(1);
  });

  it("payment_intent.succeeded for anything that is not this order's own payment moves nothing", async () => {
    const h = harness({ ref: makeRef({ status: "in_progress" }) });
    const { row } = withLedger(h, "held");
    await applyCreatorStripeEvent(evt("payment_intent.succeeded", { id: "pi_sub", metadata: {} }), h.deps);
    await applyCreatorStripeEvent(evt("payment_intent.succeeded", { ...PIO, id: "pi_stray" }), h.deps);
    expect(row.state).toBe("held");
    expect(h.logs).toEqual([]);
  });

  it("a released hold settles the reservation released (test 8)", async () => {
    const h = harness({ ref: makeRef({ status: "awaiting_acceptance" }) });
    const { row } = withLedger(h, "held");
    await applyCreatorStripeEvent(evt("payment_intent.canceled", { ...PIO, cancellation_reason: "abandoned" }), h.deps);
    expect(row.state).toBe("released");
  });

  it("codex F3: a released hold whose settle fails throws so Stripe redelivers; the redelivery settles it", async () => {
    const h = harness({ ref: makeRef({ status: "awaiting_acceptance" }) });
    const { row } = withLedger(h, "held");
    const real = h.deps.settleHire!;
    h.deps.settleHire = (async () => ({ status: "unavailable", error: "db down" })) as never;
    const e = evt("payment_intent.canceled", { ...PIO, cancellation_reason: "abandoned" });
    await expect(applyCreatorStripeEvent(e, h.deps)).rejects.toThrow(/settle \(released\) failed/);
    expect(row.state).toBe("held");
    expect(h.logs.some((l) => l.code === "creator.webhook.hire_settle_failed")).toBe(true);
    h.deps.settleHire = real;
    expect(await applyCreatorStripeEvent(e, h.deps)).toEqual({ outcome: "recorded" });
    expect(row.state).toBe("released");
  });

  it("codex F3: a hold on a cancelled order whose settle failed is repaired when the redelivery finds it already released", async () => {
    const h = harness({ ref: makeRef({ stripe_payment_intent_id: null }) });
    const { row } = withLedger(h, "held");
    const real = h.deps.settleHire!;
    h.deps.settleHire = (async () => ({ status: "unavailable", error: "db down" })) as never;
    h.fulfil.mockResolvedValue({ state: "already_done", order_id: ORDER, status: "cancelled" });
    const e = evt("payment_intent.amount_capturable_updated", { ...PIO });
    await expect(applyCreatorStripeEvent(e, h.deps)).rejects.toThrow(/settle \(released\) failed/);
    expect(row.state).toBe("held");
    h.deps.settleHire = real;
    h.releaseOrphanHold.mockResolvedValueOnce("not_held");
    expect(await applyCreatorStripeEvent(e, h.deps)).toEqual({ outcome: "recorded" });
    expect(row.state).toBe("released");
  });

  it("codex F3: a refund whose spent-settle fails throws so Stripe redelivers", async () => {
    const h = harness({ ref: makeRef() });
    withLedger(h, "held");
    h.deps.settleHire = (async () => ({ status: "unavailable", error: "db down" })) as never;
    const charge = { id: "ch_1", payment_intent: "pi_1", amount_refunded: 5_000, metadata: {}, refunds: { data: [{ id: "re_1", amount: 5_000 }] } };
    await expect(applyCreatorStripeEvent(evt("charge.refunded", charge), h.deps)).rejects.toThrow(/settle \(spent\) failed/);
    expect(h.logs.some((l) => l.code === "creator.webhook.refund_out_of_band")).toBe(true);
  });

  it("a refund: spent first, then the cumulative refunded amount; a replay changes nothing (test 8)", async () => {
    const h = harness({ ref: makeRef() });
    const { row, refundHire } = withLedger(h, "held");
    const charge = { id: "ch_1", payment_intent: "pi_1", amount_refunded: 5_000, metadata: {}, refunds: { data: [{ id: "re_1", amount: 5_000 }] } };
    await applyCreatorStripeEvent(evt("charge.refunded", charge), h.deps);
    await applyCreatorStripeEvent(evt("charge.refunded", charge), h.deps);
    expect(row.state).toBe("spent");
    expect(refundHire).toHaveBeenCalledWith(TENANT, ORDER, 50);
    expect(row.refunded).toBe(50);
  });

  it("a refund on a charge that is not the order's own payment never touches the budget", async () => {
    const h = harness({ ref: makeRef() });
    const { row, refundHire } = withLedger(h, "held");
    await applyCreatorStripeEvent(
      evt("charge.refunded", { id: "ch_2", payment_intent: "pi_stray", amount_refunded: 5_000, metadata: { zavi_creator_order_id: ORDER }, refunds: { data: [] } }),
      h.deps,
    );
    expect(row.state).toBe("held");
    expect(refundHire).not.toHaveBeenCalled();
  });

  it("an order no agent hired: every hook answers not_found and the webhook behaves as before", async () => {
    const plain = harness({ ref: makeRef() });
    const hooked = harness({ ref: makeRef() });
    withLedger(hooked, null);
    const charge = { id: "ch_1", payment_intent: "pi_1", amount_refunded: 5_000, metadata: {}, refunds: { data: [{ id: "re_1", amount: 5_000 }] } };
    const a = await applyCreatorStripeEvent(evt("charge.refunded", charge), plain.deps);
    const b = await applyCreatorStripeEvent(evt("charge.refunded", charge), hooked.deps);
    expect(b).toEqual(a);
    expect([...hooked.ledger.entries()]).toEqual([...plain.ledger.entries()]);
  });

  it("a cancelled saved-card hold that never became the order's payment is not bound to the order", async () => {
    const h = harness({ ref: makeRef({ status: "checkout_pending", stripe_payment_intent_id: null }) });
    const { row } = withLedger(h, null);
    const out = await applyCreatorStripeEvent(
      evt("payment_intent.canceled", { id: "pi_3ds", metadata: { zavi_creator_order_id: ORDER, zavi_hold: "saved_card" }, cancellation_reason: "requested_by_customer" }),
      h.deps,
    );
    expect(out).toEqual({ outcome: "ignored_unknown_object" });
    expect(h.attachPaymentIntent).not.toHaveBeenCalled();
    expect(h.cancelHold).not.toHaveBeenCalled();
    expect(row.state).toBeNull();
  });

  it("a saved-card hold whose reply was lost is bound through the guarded attach and fulfilled", async () => {
    const h = harness({ ref: makeRef({ status: "checkout_pending", stripe_payment_intent_id: null }) });
    h.fulfil.mockResolvedValueOnce({ state: "pending", order_id: ORDER, reason: "no_checkout" });
    await applyCreatorStripeEvent(
      evt("payment_intent.amount_capturable_updated", { id: "pi_saved", metadata: { zavi_creator_order_id: ORDER, zavi_hold: "saved_card" } }),
      h.deps,
    );
    expect(h.attachPaymentIntent).toHaveBeenCalledWith({ tenant_id: TENANT, order_id: ORDER, payment_intent_id: "pi_saved", hold_expires_at: null });
    expect(h.fulfil).toHaveBeenCalledTimes(2);
  });

  it("a lost-reply saved-card hold that loses the attach race is released, never left held", async () => {
    const h = harness({ ref: makeRef({ status: "checkout_pending", stripe_payment_intent_id: null }) });
    h.fulfil.mockResolvedValueOnce({ state: "pending", order_id: ORDER, reason: "no_checkout" });
    h.attachPaymentIntent.mockResolvedValueOnce(false);
    await applyCreatorStripeEvent(
      evt("payment_intent.amount_capturable_updated", { id: "pi_saved", metadata: { zavi_creator_order_id: ORDER, zavi_hold: "saved_card" } }),
      h.deps,
    );
    expect(h.releaseOrphanHold).toHaveBeenCalledWith({ payment_intent_id: "pi_saved", order_livemode: false });
  });

  it("a lost-reply hold the approve handler attached concurrently is NOT released (F1)", async () => {
    const h = harness({ ref: makeRef({ status: "checkout_pending", stripe_payment_intent_id: null }) });
    h.fulfil.mockResolvedValueOnce({ state: "pending", order_id: ORDER, reason: "no_checkout" });
    h.attachPaymentIntent.mockResolvedValueOnce(false);
    h.deps.resolveOrderById = vi
      .fn()
      .mockResolvedValueOnce(makeRef({ status: "checkout_pending", stripe_payment_intent_id: null }))
      .mockResolvedValueOnce(makeRef({ status: "checkout_pending", stripe_payment_intent_id: "pi_saved" }));
    await applyCreatorStripeEvent(
      evt("payment_intent.amount_capturable_updated", { id: "pi_saved", metadata: { zavi_creator_order_id: ORDER, zavi_hold: "saved_card" } }),
      h.deps,
    );
    expect(h.releaseOrphanHold).not.toHaveBeenCalled();
    expect(h.fulfil).toHaveBeenCalledTimes(2);
  });

  it("a Checkout hold with no session on the order is NOT bound this way (unchanged)", async () => {
    const h = harness({ ref: makeRef({ status: "checkout_pending", stripe_payment_intent_id: null }) });
    h.fulfil.mockResolvedValueOnce({ state: "pending", order_id: ORDER, reason: "no_checkout" });
    await applyCreatorStripeEvent(
      evt("payment_intent.amount_capturable_updated", { id: "pi_co", metadata: { zavi_creator_order_id: ORDER } }),
      h.deps,
    );
    expect(h.attachPaymentIntent).not.toHaveBeenCalled();
    expect(h.fulfil).toHaveBeenCalledTimes(1);
  });

  it("an orphan hold released on a cancelled order releases the reservation", async () => {
    const h = harness({ ref: makeRef({ status: "cancelled", stripe_payment_intent_id: null }) });
    const { row } = withLedger(h, "held");
    h.fulfil.mockResolvedValueOnce({ state: "already_done", order_id: ORDER, status: "cancelled" });
    await applyCreatorStripeEvent(evt("payment_intent.amount_capturable_updated", { id: "pi_late", metadata: { zavi_creator_order_id: ORDER } }), h.deps);
    expect(h.releaseOrphanHold).toHaveBeenCalled();
    expect(row.state).toBe("released");
  });
});
