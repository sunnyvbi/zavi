
import type Stripe from "stripe";
import { ExpectedToolError } from "@/services/tools/types";
import {
  isAmbiguousTransferError,
  wrapPlatformStripeError,
} from "@/services/tools/stripe/_platform-client";
import { logEvent } from "@/services/logging/logEvent";
import { assertLivemodeMatchesKey, creatorStripeClient } from "./client";
import { adsStripe } from "@/services/channels/chatgpt-ads/stripe-client";
import { assertOrderFeesConsistent } from "./order-fees";
import { assertCreatorPayoutCountry } from "./payout-countries";
import { CREATOR_PAYOUT_DISCONNECTED, creatorTransfersActive } from "./payout-accounts";
import {
  claimOrderTransfer,
  findCreatorMoneyEvent,
  insertCreatorMoneyEvent,
  loadCreatorPayoutAccount,
  loadOrderForMoney,
  markOrderTransferred,
  releaseOrderTransferClaim,
  type CreatorMoneyEventCause,
  type CreatorMoneyEventInsert,
  type CreatorMoneyEventKind,
  type CreatorOrderMoneyRow,
} from "./db";

export type CreatorMoneyDeps = {
  stripe: () => Stripe;
  loadOrder: typeof loadOrderForMoney;
  recordEvent: typeof insertCreatorMoneyEvent;
  findEvent: typeof findCreatorMoneyEvent;
  loadPayoutAccount: typeof loadCreatorPayoutAccount;
  claimTransfer: typeof claimOrderTransfer;
  markTransferred: typeof markOrderTransferred;
  releaseTransferClaim: typeof releaseOrderTransferClaim;
  platformKey: () => string | null;
  log: typeof logEvent;
  adsStripe?: () => Stripe | null;
};

export const realCreatorMoneyDeps: CreatorMoneyDeps = {
  stripe: creatorStripeClient,
  loadOrder: loadOrderForMoney,
  recordEvent: insertCreatorMoneyEvent,
  findEvent: findCreatorMoneyEvent,
  loadPayoutAccount: loadCreatorPayoutAccount,
  claimTransfer: claimOrderTransfer,
  markTransferred: markOrderTransferred,
  releaseTransferClaim: releaseOrderTransferClaim,
  platformKey: () => process.env.STRIPE_PLATFORM_SECRET_KEY ?? null,
  log: logEvent,
  adsStripe,
};

export function creatorTransferGroup(order_id: string): string {
  return `creator_order_${order_id}`;
}

export const creatorIdempotencyKey = {
  hold: (order_id: string) => `cr-hold-${order_id}`,
  checkout: (order_id: string) => `cr-checkout-${order_id}`,
  savedHold: (order_id: string) => `cr-saved-hold-${order_id}`,
  capture: (order_id: string) => `cr-capture-${order_id}`,
  cancel: (order_id: string) => `cr-cancel-${order_id}`,
  orphan: (payment_intent_id: string) => `cr-orphan-${payment_intent_id}`,
  transfer: (order_id: string) => `cr-transfer-${order_id}`,
  refund: (order_id: string, amount_cents: number) => `cr-refund-${order_id}-${amount_cents}`,
  reversal: (order_id: string, amount_cents: number) => `cr-reversal-${order_id}-${amount_cents}`,
};

async function loadGuardedOrder(
  tenant_id: string,
  order_id: string,
  deps: CreatorMoneyDeps,
): Promise<CreatorOrderMoneyRow> {
  const order = await deps.loadOrder(tenant_id, order_id);
  if (!order) {
    throw new ExpectedToolError(
      "creator_order_not_found",
      "That creator order does not exist in this workspace.",
    );
  }
  assertLivemodeMatchesKey(order.livemode, deps.platformKey());
  assertOrderFeesConsistent(order);
  return order;
}

async function writeEvent(
  deps: CreatorMoneyDeps,
  order: CreatorOrderMoneyRow,
  event: {
    kind: CreatorMoneyEventKind;
    cause: CreatorMoneyEventCause;
    amount_cents: number;
    idempotency_key: string;
    stripe_object_id?: string | null;
    stripe_event_id?: string | null;
    actor_kind?: CreatorMoneyEventInsert["actor_kind"];
    actor_user_id?: string | null;
  },
): Promise<"inserted" | "duplicate"> {
  assertLivemodeMatchesKey(order.livemode, deps.platformKey());
  return deps.recordEvent({
    tenant_id: order.tenant_id,
    order_id: order.id,
    kind: event.kind,
    cause: event.cause,
    amount_cents: event.amount_cents,
    currency: order.currency,
    livemode: order.livemode,
    stripe_object_id: event.stripe_object_id ?? null,
    stripe_event_id: event.stripe_event_id ?? null,
    idempotency_key: event.idempotency_key,
    actor_kind: event.actor_kind ?? "system",
    actor_user_id: event.actor_user_id ?? null,
  });
}

export type CreatorCheckoutHold = {
  checkout_session_id: string;
  url: string | null;
  amount_cents: number;
};

export async function createCreatorCheckoutHold(
  args: {
    tenant_id: string;
    order_id: string;
    creator_country: string;
    success_url: string;
    cancel_url: string;
    product_name?: string;
    customer_email?: string | null;
    idempotency_suffix?: string;
  },
  deps: CreatorMoneyDeps = realCreatorMoneyDeps,
): Promise<CreatorCheckoutHold> {
  const order = await loadGuardedOrder(args.tenant_id, args.order_id, deps);
  assertCreatorPayoutCountry(args.creator_country);
  if (order.status !== "checkout_pending") {
    throw new ExpectedToolError(
      "creator_order_not_awaiting_checkout",
      `This order is '${order.status}', so a new card hold would be a second charge. No checkout was opened.`,
    );
  }

  const stripe = deps.stripe();
  try {
    const session = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        success_url: args.success_url,
        cancel_url: args.cancel_url,
        client_reference_id: order.id,
        ...(args.customer_email ? { customer_email: args.customer_email } : {}),
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: order.currency,
              unit_amount: order.business_total_cents,
              product_data: { name: args.product_name ?? "Creator job" },
            },
          },
        ],
        payment_intent_data: {
          capture_method: "manual",
          transfer_group: creatorTransferGroup(order.id),
          metadata: {
            zavi_creator_order_id: order.id,
            zavi_tenant_id: order.tenant_id,
            zavi_human_member_id: order.human_member_id,
          },
        },
        metadata: { zavi_creator_order_id: order.id, zavi_tenant_id: order.tenant_id },
      },
      {
        idempotencyKey: args.idempotency_suffix
          ? `${creatorIdempotencyKey.checkout(order.id)}:${args.idempotency_suffix}`
          : creatorIdempotencyKey.checkout(order.id),
      },
    );
    return {
      checkout_session_id: session.id,
      url: session.url ?? null,
      amount_cents: order.business_total_cents,
    };
  } catch (e) {
    throw wrapPlatformStripeError(e);
  }
}

export async function resumeCreatorCheckout(
  args: {
    tenant_id: string;
    order_id: string;
    creator_country: string;
    success_url: string;
    cancel_url: string;
    product_name?: string;
    customer_email?: string | null;
    alternate_urls?: Array<{ success_url: string; cancel_url: string }>;
  },
  deps: CreatorMoneyDeps = realCreatorMoneyDeps,
): Promise<CreatorCheckoutHold & { reused_session: boolean }> {
  const order = await loadGuardedOrder(args.tenant_id, args.order_id, deps);
  if (order.status !== "checkout_pending") {
    throw new ExpectedToolError(
      "creator_order_not_awaiting_checkout",
      "This job is already paid for, so there is nothing to pay again.",
    );
  }
  const previous = order.stripe_checkout_session_id;
  if (previous) {
    let session: { status?: string | null; url?: string | null; id: string };
    try {
      session = await deps.stripe().checkout.sessions.retrieve(previous);
    } catch (e) {
      throw wrapPlatformStripeError(e);
    }
    if (session.status === "complete") {
      throw new ExpectedToolError(
        "checkout_already_paid",
        "This payment already went through. Zavi is confirming it. Do not pay again.",
      );
    }
    if (session.status === "open" && session.url) {
      return { checkout_session_id: session.id, url: session.url, amount_cents: order.business_total_cents, reused_session: true };
    }
  }
  const { alternate_urls, ...base } = args;
  if (previous) {
    const hold = await createCreatorCheckoutHold({ ...base, idempotency_suffix: `after-${previous}` }, deps);
    return { ...hold, reused_session: false };
  }
  let lastError: unknown;
  for (const urls of [{ success_url: base.success_url, cancel_url: base.cancel_url }, ...(alternate_urls ?? [])]) {
    try {
      const hold = await createCreatorCheckoutHold({ ...base, ...urls }, deps);
      return { ...hold, reused_session: false };
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

export const SAVED_CARD_HOLD_MARKER = "saved_card";

export type CreatorSavedCardWallet = {
  stripe_customer_id: string | null;
  payment_method_id: string | null;
  creator_consent_at: string | null;
};

export type CreatorSavedCardHoldResult =
  | { kind: "held"; payment_intent_id: string; hold_expires_at: string | null }
  | {
      kind: "needs_founder";
      reason: "no_saved_card" | "stripe_account_mismatch" | "requires_action" | "card_declined";
    }
  | { kind: "unknown" };

export async function createCreatorSavedCardHold(
  args: {
    tenant_id: string;
    order_id: string;
    creator_country: string;
    action_id?: string;
  },
  wallet: CreatorSavedCardWallet,
  deps: CreatorMoneyDeps = realCreatorMoneyDeps,
): Promise<CreatorSavedCardHoldResult> {
  const order = await loadGuardedOrder(args.tenant_id, args.order_id, deps);
  assertCreatorPayoutCountry(args.creator_country);
  if (order.status !== "checkout_pending") {
    throw new ExpectedToolError(
      "creator_order_not_awaiting_checkout",
      `This order is '${order.status}', so a new card hold would be a second charge. Nothing was charged.`,
    );
  }
  if (!wallet.stripe_customer_id || !wallet.payment_method_id || !wallet.creator_consent_at) {
    return { kind: "needs_founder", reason: "no_saved_card" };
  }

  const stripe = deps.stripe();
  const ads = deps.adsStripe?.() ?? null;
  if (!ads) return { kind: "needs_founder", reason: "stripe_account_mismatch" };
  try {
    const [adsAccount, creatorAccount] = await Promise.all([ads.accounts.retrieve(), stripe.accounts.retrieve()]);
    if (!adsAccount?.id || adsAccount.id !== creatorAccount?.id) {
      return { kind: "needs_founder", reason: "stripe_account_mismatch" };
    }
  } catch {
    return { kind: "needs_founder", reason: "stripe_account_mismatch" };
  }

  let pi: Stripe.PaymentIntent;
  try {
    pi = await stripe.paymentIntents.create(
      {
        amount: order.business_total_cents,
        currency: order.currency,
        customer: wallet.stripe_customer_id,
        payment_method: wallet.payment_method_id,
        payment_method_types: ["card"],
        off_session: true,
        confirm: true,
        capture_method: "manual",
        transfer_group: creatorTransferGroup(order.id),
        metadata: {
          zavi_creator_order_id: order.id,
          zavi_tenant_id: order.tenant_id,
          zavi_human_member_id: order.human_member_id,
          zavi_hold: SAVED_CARD_HOLD_MARKER,
          ...(args.action_id ? { zavi_action_id: args.action_id } : {}),
        },
      },
      { idempotencyKey: creatorIdempotencyKey.savedHold(order.id) },
    );
  } catch (e) {
    const failed = (e as { payment_intent?: Stripe.PaymentIntent | null }).payment_intent ?? null;
    if (failed?.id) {
      if (!(await cancelUnusedSavedCardIntent(stripe, failed))) return { kind: "unknown" };
      return {
        kind: "needs_founder",
        reason: failed.status === "requires_action" ? "requires_action" : "card_declined",
      };
    }
    if (isAmbiguousTransferError(e)) return { kind: "unknown" };
    return { kind: "needs_founder", reason: "card_declined" };
  }

  if (pi.status === "requires_capture") {
    const held = describeHold(pi);
    return { kind: "held", payment_intent_id: pi.id, hold_expires_at: held.hold_expires_at };
  }
  if (!(await cancelUnusedSavedCardIntent(stripe, pi))) return { kind: "unknown" };
  return { kind: "needs_founder", reason: pi.status === "requires_action" ? "requires_action" : "card_declined" };
}

async function cancelUnusedSavedCardIntent(stripe: Stripe, pi: Pick<Stripe.PaymentIntent, "id" | "status">): Promise<boolean> {
  if (pi.status === "canceled") return true;
  if (pi.status === "succeeded") return false;
  try {
    const out = await stripe.paymentIntents.cancel(pi.id, {}, { idempotencyKey: creatorIdempotencyKey.orphan(pi.id) });
    return out?.status === "canceled";
  } catch (e) {
    console.error(`[creator-money] could not cancel unused saved-card PaymentIntent ${pi.id}: ${(e as Error).message}`);
    return false;
  }
}

export type CreatorHoldState = {
  payment_intent_id: string;
  status: string;
  amount_cents: number;
  charge_id: string | null;
  hold_expires_at: string | null;
  held: boolean;
  captured: boolean;
  released: boolean;
  refunded_cents?: number | null;
  authorized_at?: string | null;
};

export async function readCreatorHold(
  payment_intent_id: string,
  deps: CreatorMoneyDeps = realCreatorMoneyDeps,
): Promise<CreatorHoldState> {
  let pi: Stripe.PaymentIntent;
  try {
    pi = await deps.stripe().paymentIntents.retrieve(payment_intent_id, {
      expand: ["latest_charge"],
    });
  } catch (e) {
    throw wrapPlatformStripeError(e);
  }
  return describeHold(pi);
}

function describeHold(pi: Stripe.PaymentIntent): CreatorHoldState {
  const charge =
    pi.latest_charge && typeof pi.latest_charge === "object"
      ? (pi.latest_charge as Stripe.Charge)
      : null;
  const chargeId = charge ? charge.id : typeof pi.latest_charge === "string" ? pi.latest_charge : null;
  const cardDetails = (charge as unknown as {
    payment_method_details?: { card?: { capture_before?: number | null } | null } | null;
  } | null)?.payment_method_details?.card;
  const captureBefore = charge
    ? cardDetails?.capture_before ??
      ((charge as unknown as { capture_before?: number | null }).capture_before ?? null)
    : null;
  return {
    payment_intent_id: pi.id,
    status: pi.status,
    amount_cents: pi.amount,
    charge_id: chargeId,
    hold_expires_at: captureBefore ? new Date(captureBefore * 1000).toISOString() : null,
    held: pi.status === "requires_capture",
    captured: pi.status === "succeeded",
    released: pi.status === "canceled",
    refunded_cents: charge ? (charge.amount_refunded ?? 0) : null,
    authorized_at: charge && typeof charge.created === "number" ? new Date(charge.created * 1000).toISOString() : null,
  };
}

export async function recordCreatorHold(
  args: {
    tenant_id: string;
    order_id: string;
    payment_intent_id: string;
    cause: Extract<CreatorMoneyEventCause, "booking" | "hire">;
    actor_user_id?: string | null;
  },
  deps: CreatorMoneyDeps = realCreatorMoneyDeps,
): Promise<CreatorHoldState> {
  const order = await loadGuardedOrder(args.tenant_id, args.order_id, deps);
  const hold = await readCreatorHold(args.payment_intent_id, deps);
  if (!hold.held) {
    throw new ExpectedToolError(
      "creator_hold_not_held",
      `The payment is '${hold.status}', not an uncaptured hold. Nothing was recorded.`,
    );
  }
  if (hold.amount_cents !== order.business_total_cents) {
    throw new ExpectedToolError(
      "creator_hold_amount_mismatch",
      `The card hold is ${hold.amount_cents} but this order quoted ${order.business_total_cents}. Nothing was recorded.`,
    );
  }
  await writeEvent(deps, order, {
    kind: "hold",
    cause: args.cause,
    amount_cents: hold.amount_cents,
    idempotency_key: creatorIdempotencyKey.hold(order.id),
    stripe_object_id: hold.payment_intent_id,
    ...(args.actor_user_id ? { actor_kind: "tenant" as const, actor_user_id: args.actor_user_id } : {}),
  });
  return hold;
}

export type CreatorCaptureResult =
  | {
      ok: true;
      payment_intent_id: string;
      charge_id: string | null;
      amount_cents: number;
      already_captured: boolean;
    }
  | {
      ok: false;
      action: "cancel_immediately";
      reason: string;
      failure_code: string | null;
      funds_uncertain: boolean;
    };

export async function captureCreatorHold(
  args: {
    tenant_id: string;
    order_id: string;
    creator_country: string;
    cause: Extract<CreatorMoneyEventCause, "creator_accept" | "hire">;
  },
  deps: CreatorMoneyDeps = realCreatorMoneyDeps,
): Promise<CreatorCaptureResult> {
  const order = await loadGuardedOrder(args.tenant_id, args.order_id, deps);
  assertCreatorPayoutCountry(args.creator_country);
  if (!order.stripe_payment_intent_id) {
    throw new ExpectedToolError(
      "creator_order_has_no_payment",
      "This order has no card hold to capture.",
    );
  }

  const hold = await readCreatorHold(order.stripe_payment_intent_id, deps);
  if (hold.released) {
    return {
      ok: false,
      action: "cancel_immediately",
      reason: "The card hold was released or lapsed before the creator accepted.",
      failure_code: "hold_released",
      funds_uncertain: false,
    };
  }
  if (hold.captured && hold.refunded_cents !== 0) {
    return {
      ok: false,
      action: "cancel_immediately",
      reason: "This payment was refunded, so the job cannot start.",
      failure_code: "charge_refunded",
      funds_uncertain: false,
    };
  }
  if (hold.captured) {
    await writeEvent(deps, order, {
      kind: "capture",
      cause: args.cause,
      amount_cents: hold.amount_cents,
      idempotency_key: creatorIdempotencyKey.capture(order.id),
      stripe_object_id: hold.payment_intent_id,
    });
    return {
      ok: true,
      payment_intent_id: hold.payment_intent_id,
      charge_id: hold.charge_id,
      amount_cents: hold.amount_cents,
      already_captured: true,
    };
  }

  let captured: Stripe.PaymentIntent;
  try {
    captured = await deps.stripe().paymentIntents.capture(
      order.stripe_payment_intent_id,
      { amount_to_capture: order.business_total_cents },
      { idempotencyKey: creatorIdempotencyKey.capture(order.id) },
    );
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return {
      ok: false,
      action: "cancel_immediately",
      reason:
        "The card could not be charged when the creator accepted, so the job cannot start.",
      failure_code: err.code ?? null,
      funds_uncertain: isAmbiguousTransferError(e),
    };
  }

  const state = describeHold(captured);
  await writeEvent(deps, order, {
    kind: "capture",
    cause: args.cause,
    amount_cents: state.amount_cents,
    idempotency_key: creatorIdempotencyKey.capture(order.id),
    stripe_object_id: state.payment_intent_id,
  });
  return {
    ok: true,
    payment_intent_id: state.payment_intent_id,
    charge_id: state.charge_id,
    amount_cents: state.amount_cents,
    already_captured: false,
  };
}

export type CreatorCancelHoldResult =
  | { ok: true; payment_intent_id: string | null; already_released: boolean }
  | {
      ok: false;
      action: "refund_required";
      payment_intent_id: string;
    }
  | { ok: false; action: "superseded"; payment_intent_id: string };

async function cancelKeyFor(
  deps: CreatorMoneyDeps,
  order: CreatorOrderMoneyRow,
  payment_intent_id: string,
): Promise<string> {
  const base = creatorIdempotencyKey.cancel(order.id);
  const prior = await deps.findEvent(order.tenant_id, base);
  return prior && prior.stripe_object_id !== payment_intent_id ? `${base}-${payment_intent_id}` : base;
}

export async function cancelCreatorHold(
  args: {
    tenant_id: string;
    order_id: string;
    cause: Extract<
      CreatorMoneyEventCause,
      "decline" | "expiry" | "withdrawn" | "checkout_abandoned" | "payment_failed" | "creator_removed"
    >;
    expected_payment_intent_id?: string;
  },
  deps: CreatorMoneyDeps = realCreatorMoneyDeps,
): Promise<CreatorCancelHoldResult> {
  const unguarded = await deps.loadOrder(args.tenant_id, args.order_id);
  if (unguarded && unguarded.status === "checkout_pending" && !unguarded.stripe_payment_intent_id) {
    return { ok: true, payment_intent_id: null, already_released: true };
  }
  const order = await loadGuardedOrder(args.tenant_id, args.order_id, deps);
  if (!order.stripe_payment_intent_id) {
    throw new ExpectedToolError(
      "creator_order_has_no_payment",
      "This order has no card hold to release.",
    );
  }
  if (
    args.expected_payment_intent_id !== undefined &&
    args.expected_payment_intent_id !== order.stripe_payment_intent_id
  ) {
    return { ok: false, action: "superseded", payment_intent_id: order.stripe_payment_intent_id };
  }

  const hold = await readCreatorHold(order.stripe_payment_intent_id, deps);
  const cancelKey = await cancelKeyFor(deps, order, hold.payment_intent_id);
  if (hold.captured) {
    return {
      ok: false,
      action: "refund_required",
      payment_intent_id: hold.payment_intent_id,
    };
  }
  if (hold.released) {
    await writeEvent(deps, order, {
      kind: "cancel",
      cause: args.cause,
      amount_cents: hold.amount_cents,
      idempotency_key: cancelKey,
      stripe_object_id: hold.payment_intent_id,
    });
    return { ok: true, payment_intent_id: hold.payment_intent_id, already_released: true };
  }

  try {
    await deps
      .stripe()
      .paymentIntents.cancel(
        order.stripe_payment_intent_id,
        {},
        { idempotencyKey: cancelKey },
      );
  } catch (e) {
    throw wrapPlatformStripeError(e);
  }
  await writeEvent(deps, order, {
    kind: "cancel",
    cause: args.cause,
    amount_cents: hold.amount_cents,
    idempotency_key: cancelKey,
    stripe_object_id: hold.payment_intent_id,
  });
  return { ok: true, payment_intent_id: hold.payment_intent_id, already_released: false };
}

export async function releaseOrphanCreatorHold(
  args: { payment_intent_id: string; order_livemode: boolean },
  deps: CreatorMoneyDeps = realCreatorMoneyDeps,
): Promise<"released" | "not_held" | "captured"> {
  assertLivemodeMatchesKey(args.order_livemode, deps.platformKey());
  const stripe = deps.stripe();
  try {
    const pi = await stripe.paymentIntents.retrieve(args.payment_intent_id);
    if (pi.status === "succeeded") return "captured";
    if (pi.status !== "requires_capture") return "not_held";
    await stripe.paymentIntents.cancel(
      args.payment_intent_id,
      {},
      { idempotencyKey: creatorIdempotencyKey.orphan(args.payment_intent_id) },
    );
    return "released";
  } catch (e) {
    throw wrapPlatformStripeError(e);
  }
}

export type CreatorTransferResult =
  | {
      ok: true;
      transfer_id: string;
      amount_cents: number;
      already_transferred: boolean;
      recorded: boolean;
    }
  | {
      ok: false;
      reason:
        | "awaiting_payout_account"
        | "payout_account_disconnected"
        | "transfers_capability_inactive"
        | "claim_lost"
        | "charge_not_captured"
        | "charge_refunded";
      message: string;
    };

export async function transferToCreator(
  args: {
    tenant_id: string;
    order_id: string;
    cause: Extract<CreatorMoneyEventCause, "approval" | "auto_accept_buffer" | "mediation">;
  },
  deps: CreatorMoneyDeps = realCreatorMoneyDeps,
): Promise<CreatorTransferResult> {
  const order = await loadGuardedOrder(args.tenant_id, args.order_id, deps);
  if (order.payout_status === "transferred" && order.stripe_transfer_id) {
    return {
      ok: true,
      transfer_id: order.stripe_transfer_id,
      amount_cents: order.payout_amount_cents ?? order.creator_payout_cents,
      already_transferred: true,
      recorded: true,
    };
  }
  if (!order.stripe_payment_intent_id) {
    return {
      ok: false,
      reason: "charge_not_captured",
      message: "This order has no captured payment, so there is nothing to pay out.",
    };
  }

  const account = await deps.loadPayoutAccount(order.human_member_id, order.livemode);
  if (!account) {
    return {
      ok: false,
      reason: "awaiting_payout_account",
      message: "The creator has not finished Stripe payout setup yet, so the money waits.",
    };
  }
  if (account.disabled_reason === CREATOR_PAYOUT_DISCONNECTED) {
    return {
      ok: false,
      reason: "payout_account_disconnected",
      message:
        "The creator disconnected their Stripe account from Zavi, so no payout can be sent. They need to reconnect it before this money can move.",
    };
  }
  assertCreatorPayoutCountry(account.country);

  let stripeAccount: Stripe.Account;
  try {
    stripeAccount = await deps.stripe().accounts.retrieve(account.stripe_account_id);
  } catch (e) {
    throw wrapPlatformStripeError(e);
  }
  if (!creatorTransfersActive(stripeAccount)) {
    return {
      ok: false,
      reason: "transfers_capability_inactive",
      message:
        "The creator's Stripe account cannot receive transfers yet (onboarding is not complete). The payout waits.",
    };
  }

  const hold = await readCreatorHold(order.stripe_payment_intent_id, deps);
  if (!hold.captured || !hold.charge_id) {
    return {
      ok: false,
      reason: "charge_not_captured",
      message: "The business's payment is not captured, so no payout can be sent.",
    };
  }
  const refunded = hold.refunded_cents;
  const splitPayout = order.payout_amount_cents;
  const refundOk =
    refunded === 0 ||
    (splitPayout != null && refunded != null && refunded + splitPayout <= hold.amount_cents);
  if (!refundOk) {
    return {
      ok: false,
      reason: "charge_refunded",
      message:
        "The business's payment was refunded, or its refund state could not be read, so no payout was sent. Staff must resolve this order before the creator is paid.",
    };
  }

  const claimed = await deps.claimTransfer(order.id);
  if (!claimed) {
    return {
      ok: false,
      reason: "claim_lost",
      message:
        "This payout is already being sent, was already sent, or is held by an open dispute. No transfer was made.",
    };
  }

  const amount_cents = claimed.payout_amount_cents ?? claimed.creator_payout_cents;
  const idempotencyKey = creatorIdempotencyKey.transfer(order.id);
  let transfer: Stripe.Transfer;
  try {
    transfer = await deps.stripe().transfers.create(
      {
        amount: amount_cents,
        currency: order.currency,
        destination: account.stripe_account_id,
        source_transaction: hold.charge_id,
        transfer_group: creatorTransferGroup(order.id),
        metadata: {
          zavi_creator_order_id: order.id,
          zavi_tenant_id: order.tenant_id,
          zavi_human_member_id: order.human_member_id,
          zavi_cause: args.cause,
        },
      },
      { idempotencyKey },
    );
  } catch (e) {
    if (isAmbiguousTransferError(e)) {
      await deps
        .log({
          level: "error",
          source: "creator-money",
          code: "creator.transfer.ambiguous",
          message: "Creator transfer failed ambiguously; claim held for reconcile (NOT released)",
          tenant_id: order.tenant_id,
          meta: {
            creator_order_id: order.id,
            object_id: account.stripe_account_id,
            amount: amount_cents,
            currency: order.currency,
          },
        })
        .catch(() => {});
      throw wrapPlatformStripeError(e);
    }
    await deps.releaseTransferClaim(order.id).catch(() => {});
    throw wrapPlatformStripeError(e);
  }

  let recorded = false;
  try {
    recorded = (await deps.markTransferred({
      order_id: order.id,
      transfer_id: transfer.id,
      idempotency_key: idempotencyKey,
      cause: args.cause,
    })) === 1;
  } catch {
    recorded = false;
  }
  if (!recorded) {
    await deps
      .log({
        level: "error",
        source: "creator-money",
        code: "creator.transfer.not_recorded",
        message:
          "Creator transfer sent but the order could not be marked transferred; reconcile before any refund (a refund would otherwise skip its reversal)",
        tenant_id: order.tenant_id,
        meta: {
          creator_order_id: order.id,
          object_id: transfer.id,
          amount: amount_cents,
          currency: order.currency,
        },
      })
      .catch(() => {});
  }
  return {
    ok: true,
    transfer_id: transfer.id,
    amount_cents,
    already_transferred: false,
    recorded,
  };
}

const RECONCILE_PAGE = 100;

async function findReversalAtStripe(
  deps: CreatorMoneyDeps,
  transfer_id: string,
  idempotency_key: string,
): Promise<{ id: string; amount?: number } | null> {
  try {
    const page = await deps
      .stripe()
      .transfers.listReversals(transfer_id, { limit: RECONCILE_PAGE });
    return (
      page.data.find((r) => r.metadata?.zavi_idempotency_key === idempotency_key) ?? null
    );
  } catch (e) {
    throw wrapPlatformStripeError(e);
  }
}

async function findRefundAtStripe(
  deps: CreatorMoneyDeps,
  payment_intent_id: string,
  idempotency_key: string,
): Promise<{ id: string; amount?: number } | null> {
  try {
    const page = await deps
      .stripe()
      .refunds.list({ payment_intent: payment_intent_id, limit: RECONCILE_PAGE });
    return (
      page.data.find((r) => r.metadata?.zavi_idempotency_key === idempotency_key) ?? null
    );
  } catch (e) {
    throw wrapPlatformStripeError(e);
  }
}

export type CreatorRefundResult = {
  refund_id: string | null;
  refunded_cents: number;
  already_refunded: boolean;
  reversed_cents: number;
  reversal_shortfall_cents: number;
  needs_staff_review: boolean;
  blocked_reason?: "charge_disputed";
};

const REFUNDABLE_DISPUTE_STATUSES = new Set([
  "won",
  "warning_closed",
  "warning_needs_response",
  "warning_under_review",
]);

type CreatorChargeRefundState = {
  disputed: boolean;
  refundable_cents: number;
};

async function readChargeRefundState(
  deps: CreatorMoneyDeps,
  payment_intent_id: string,
): Promise<CreatorChargeRefundState | null> {
  let pi: Stripe.PaymentIntent | undefined;
  try {
    pi = await deps.stripe().paymentIntents.retrieve(payment_intent_id, {
      expand: ["latest_charge"],
    });
  } catch (e) {
    throw wrapPlatformStripeError(e);
  }
  if (!pi || pi.status !== "succeeded") return null;
  const charge =
    pi.latest_charge && typeof pi.latest_charge === "object" ? (pi.latest_charge as Stripe.Charge) : null;
  if (!charge) return null;
  let disputed = false;
  if (charge.disputed === true) {
    let disputes: Stripe.Dispute[];
    try {
      disputes = (await deps.stripe().disputes.list({ charge: charge.id, limit: 100 })).data;
    } catch (e) {
      throw wrapPlatformStripeError(e);
    }
    disputed = disputes.length === 0 || disputes.some((d) => !REFUNDABLE_DISPUTE_STATUSES.has(d.status));
  }
  const received = typeof pi.amount_received === "number" ? pi.amount_received : charge.amount_captured;
  const refunded = charge.amount_refunded ?? 0;
  return { disputed, refundable_cents: Math.max(0, (received ?? 0) - refunded) };
}

async function findOwnRefundAtStripe(
  deps: CreatorMoneyDeps,
  payment_intent_id: string,
  order_id: string,
  cause: string,
): Promise<{ id: string; amount?: number; key: string } | null> {
  const prefix = `cr-refund-${order_id}-`;
  try {
    const page = await deps.stripe().refunds.list({ payment_intent: payment_intent_id, limit: RECONCILE_PAGE });
    const hit = page.data.find(
      (r) =>
        r.metadata?.zavi_creator_order_id === order_id &&
        r.metadata?.zavi_cause === cause &&
        typeof r.metadata?.zavi_idempotency_key === "string" &&
        r.metadata.zavi_idempotency_key.startsWith(prefix) &&
        r.status !== "failed" &&
        r.status !== "canceled",
    );
    return hit ? { id: hit.id, amount: hit.amount, key: hit.metadata!.zavi_idempotency_key as string } : null;
  } catch (e) {
    throw wrapPlatformStripeError(e);
  }
}

async function isForeignRefundRow(
  deps: CreatorMoneyDeps,
  payment_intent_id: string,
  stripe_object_id: string | null,
  key: string,
  cause: string,
): Promise<boolean> {
  if (!stripe_object_id || stripe_object_id.startsWith("ch_") || stripe_object_id.startsWith("py_")) return true;
  let refunds: Stripe.Refund[];
  try {
    refunds = (await deps.stripe().refunds.list({ payment_intent: payment_intent_id, limit: RECONCILE_PAGE })).data;
  } catch (e) {
    throw wrapPlatformStripeError(e);
  }
  const named = refunds.find((r) => r.id === stripe_object_id);
  if (!named) return false;
  return named.metadata?.zavi_idempotency_key !== key || named.metadata?.zavi_cause !== cause;
}

export async function refundCreatorOrder(
  args: {
    tenant_id: string;
    order_id: string;
    cause: Extract<
      CreatorMoneyEventCause,
      "no_show" | "cancel_agreed" | "cancel_no_response" | "mediation" | "creator_removed"
    >;
    amount_cents?: number;
    reverse_cents?: number;
    actor_kind?: CreatorMoneyEventInsert["actor_kind"];
    actor_user_id?: string | null;
  },
  deps: CreatorMoneyDeps = realCreatorMoneyDeps,
): Promise<CreatorRefundResult> {
  const order = await loadGuardedOrder(args.tenant_id, args.order_id, deps);
  if (!order.stripe_payment_intent_id) {
    throw new ExpectedToolError(
      "creator_order_has_no_payment",
      "This order has no captured payment to refund.",
    );
  }
  let refundAmount = args.amount_cents ?? order.business_total_cents;
  if (
    !Number.isInteger(refundAmount) ||
    refundAmount <= 0 ||
    refundAmount > order.business_total_cents
  ) {
    throw new ExpectedToolError(
      "creator_refund_amount_invalid",
      `A refund must be a whole number of cents between 1 and ${order.business_total_cents}.`,
    );
  }

  if (order.payout_status === "transferring") {
    await deps
      .log({
        level: "error",
        source: "creator-money",
        code: "creator.refund.blocked_unreconciled_payout",
        message:
          "Refund refused: this order's payout is mid-transfer or unreconciled, so a refund could go out without its paired reversal",
        tenant_id: order.tenant_id,
        meta: { creator_order_id: order.id, amount: refundAmount, currency: order.currency },
      })
      .catch(() => {});
    throw new ExpectedToolError(
      "creator_payout_unreconciled",
      "This order's creator payout is still in flight or unreconciled, so it cannot be refunded yet. Staff must confirm at Stripe whether the transfer went out first.",
    );
  }

  const transferred = order.payout_amount_cents ?? order.creator_payout_cents;
  let reversed_cents = 0;
  let reversal_shortfall_cents = 0;
  let needs_staff_review = false;

  const hasTransfer = !!order.stripe_transfer_id && order.payout_status === "transferred";

  const chargeState = await readChargeRefundState(deps, order.stripe_payment_intent_id);
  if (chargeState?.disputed) {
    await deps
      .log({
        level: "error",
        source: "creator-money",
        code: "creator.refund.blocked_disputed_charge",
        message:
          "Refund not attempted: the business's charge has an open or lost chargeback, so Stripe would refuse it. Staff must settle this order by hand",
        tenant_id: order.tenant_id,
        meta: { creator_order_id: order.id, amount: refundAmount, currency: order.currency, cause: args.cause },
      })
      .catch(() => {});
    return {
      refund_id: null,
      refunded_cents: 0,
      already_refunded: false,
      reversed_cents: 0,
      reversal_shortfall_cents: 0,
      needs_staff_review: true,
      blocked_reason: "charge_disputed",
    };
  }

  if (
    args.amount_cents === undefined &&
    chargeState &&
    chargeState.refundable_cents < refundAmount
  ) {
    const ownPrior = await findOwnRefundAtStripe(
      deps,
      order.stripe_payment_intent_id,
      order.id,
      args.cause,
    );
    const priorAmount = ownPrior ? Number.parseInt(ownPrior.key.slice(`cr-refund-${order.id}-`.length), 10) : NaN;
    if (Number.isInteger(priorAmount) && priorAmount > 0 && priorAmount <= refundAmount) {
      refundAmount = priorAmount;
    } else {
      await deps
        .log({
          level: "warn",
          source: "creator-money",
          code: "creator.refund.capped_to_refundable",
          message: "Part of this charge was already refunded or charged back, so only the remainder is refunded",
          tenant_id: order.tenant_id,
          meta: {
            creator_order_id: order.id,
            amount: refundAmount,
            refundable_cents: chargeState.refundable_cents,
            currency: order.currency,
          },
        })
        .catch(() => {});
      if (chargeState.refundable_cents <= 0) {
        return {
          refund_id: null,
          refunded_cents: 0,
          already_refunded: true,
          reversed_cents: 0,
          reversal_shortfall_cents: 0,
          needs_staff_review: hasTransfer,
        };
      }
      refundAmount = chargeState.refundable_cents;
    }
  }

  if (args.reverse_cents !== undefined && hasTransfer) {
    const ceiling = Math.min(transferred, refundAmount);
    if (
      !Number.isInteger(args.reverse_cents) ||
      args.reverse_cents <= 0 ||
      args.reverse_cents > ceiling
    ) {
      throw new ExpectedToolError(
        "creator_reversal_amount_invalid",
        `A transfer reversal must be a whole number of cents between 1 and ${ceiling} (the creator's payout, capped by the refund). Refusing to refund with an unpaired reversal.`,
      );
    }
  }

  if (hasTransfer && order.stripe_transfer_id) {
    const want = Math.min(args.reverse_cents ?? refundAmount, transferred);
    const reversalKey = creatorIdempotencyKey.reversal(order.id, want);
    const priorReversal = want > 0 ? await deps.findEvent(order.tenant_id, reversalKey) : null;
    const priorAtStripe =
      !priorReversal && want > 0
        ? await findReversalAtStripe(deps, order.stripe_transfer_id, reversalKey)
        : null;
    if (priorReversal) {
      reversed_cents = priorReversal.amount_cents;
    } else if (priorAtStripe) {
      reversed_cents = priorAtStripe.amount ?? 0;
      if (reversed_cents > 0) {
        await writeEvent(deps, order, {
          kind: "transfer_reversal",
          cause: args.cause,
          amount_cents: reversed_cents,
          idempotency_key: reversalKey,
          stripe_object_id: order.stripe_transfer_id,
          actor_kind: args.actor_kind,
          actor_user_id: args.actor_user_id,
        });
      }
    } else if (want > 0) {
      try {
        const reversal = await deps.stripe().transfers.createReversal(
          order.stripe_transfer_id,
          {
            amount: want,
            metadata: {
              zavi_creator_order_id: order.id,
              zavi_cause: args.cause,
              zavi_idempotency_key: reversalKey,
            },
          },
          { idempotencyKey: reversalKey },
        );
        reversed_cents = reversal.amount ?? 0;
      } catch (e) {
        reversed_cents = 0;
        await deps
          .log({
            level: "error",
            source: "creator-money",
            code: "creator.refund.reversal_failed",
            error: e,
            tenant_id: order.tenant_id,
            meta: {
              creator_order_id: order.id,
              object_id: order.stripe_transfer_id,
              amount: want,
              currency: order.currency,
            },
          })
          .catch(() => {});
      }

      if (reversed_cents > 0) {
        await writeEvent(deps, order, {
          kind: "transfer_reversal",
          cause: args.cause,
          amount_cents: reversed_cents,
          idempotency_key: reversalKey,
          stripe_object_id: order.stripe_transfer_id,
          actor_kind: args.actor_kind,
          actor_user_id: args.actor_user_id,
        });
      }
    }

    if (want > 0 && reversed_cents < want) {
      reversal_shortfall_cents = want - reversed_cents;
      needs_staff_review = true;
      await deps
        .log({
          level: "error",
          source: "creator-money",
          code: "creator.refund.reversal_shortfall",
          message:
            "Creator transfer reversal did not return the full amount; refunding anyway, Zavi carries the shortfall until staff resolve it",
          tenant_id: order.tenant_id,
          meta: {
            creator_order_id: order.id,
            object_id: order.stripe_transfer_id,
            amount: want,
            reversal_shortfall_cents,
            currency: order.currency,
          },
        })
        .catch(() => {});
    }
  }

  let refundKey = creatorIdempotencyKey.refund(order.id, refundAmount);
  let priorRefund = await deps.findEvent(order.tenant_id, refundKey);
  if (
    priorRefund &&
    (await isForeignRefundRow(deps, order.stripe_payment_intent_id, priorRefund.stripe_object_id, refundKey, args.cause))
  ) {
    refundKey = `${refundKey}-${args.cause}`;
    priorRefund = await deps.findEvent(order.tenant_id, refundKey);
  }
  if (priorRefund) {
    return {
      refund_id: priorRefund.stripe_object_id,
      refunded_cents: priorRefund.amount_cents,
      already_refunded: true,
      reversed_cents,
      reversal_shortfall_cents,
      needs_staff_review,
    };
  }
  const refundAtStripe = await findRefundAtStripe(
    deps,
    order.stripe_payment_intent_id,
    refundKey,
  );
  if (refundAtStripe) {
    await writeEvent(deps, order, {
      kind: "refund",
      cause: args.cause,
      amount_cents: refundAtStripe.amount ?? refundAmount,
      idempotency_key: refundKey,
      stripe_object_id: refundAtStripe.id,
      actor_kind: args.actor_kind,
      actor_user_id: args.actor_user_id,
    });
    return {
      refund_id: refundAtStripe.id,
      refunded_cents: refundAtStripe.amount ?? refundAmount,
      already_refunded: true,
      reversed_cents,
      reversal_shortfall_cents,
      needs_staff_review,
    };
  }

  let refund: Stripe.Refund;
  try {
    refund = await deps.stripe().refunds.create(
      {
        payment_intent: order.stripe_payment_intent_id,
        amount: refundAmount,
        metadata: {
          zavi_creator_order_id: order.id,
          zavi_cause: args.cause,
          zavi_idempotency_key: refundKey,
        },
      },
      { idempotencyKey: refundKey },
    );
  } catch (e) {
    throw wrapPlatformStripeError(e);
  }

  await writeEvent(deps, order, {
    kind: "refund",
    cause: args.cause,
    amount_cents: refundAmount,
    idempotency_key: refundKey,
    stripe_object_id: refund.id,
    actor_kind: args.actor_kind,
    actor_user_id: args.actor_user_id,
  });

  return {
    refund_id: refund.id,
    refunded_cents: refundAmount,
    already_refunded: false,
    reversed_cents,
    reversal_shortfall_cents,
    needs_staff_review,
  };
}

export type CreatorMoneyObservationResult = {
  outcome: "inserted" | "duplicate";
  conflicting_stripe_object_id: string | null;
};

export async function recordCreatorMoneyObservation(
  args: {
    tenant_id: string;
    order_id: string;
    kind: CreatorMoneyEventKind;
    cause: CreatorMoneyEventCause;
    amount_cents: number;
    idempotency_key: string;
    stripe_object_id: string;
    stripe_event_id: string;
    actor_kind?: CreatorMoneyEventInsert["actor_kind"];
  },
  deps: CreatorMoneyDeps = realCreatorMoneyDeps,
): Promise<CreatorMoneyObservationResult> {
  if (!Number.isInteger(args.amount_cents) || args.amount_cents < 0) {
    throw new ExpectedToolError(
      "creator_observation_amount_invalid",
      "An observed money movement must carry a whole, non-negative number of cents.",
    );
  }
  const order = await loadGuardedOrder(args.tenant_id, args.order_id, deps);

  const prior = await deps.findEvent(order.tenant_id, args.idempotency_key);
  if (prior) {
    const conflict =
      prior.stripe_object_id && prior.stripe_object_id !== args.stripe_object_id
        ? prior.stripe_object_id
        : null;
    if (conflict) {
      await deps
        .log({
          level: "error",
          source: "creator-money",
          code: "creator.ledger.observation_key_conflict",
          message:
            "A Stripe-observed money movement collided with a different movement on the same ledger key; the ledger is short one row until staff reconcile",
          tenant_id: order.tenant_id,
          meta: {
            creator_order_id: order.id,
            object_id: args.stripe_object_id,
            amount: args.amount_cents,
            currency: order.currency,
            event_id: args.stripe_event_id,
          },
        })
        .catch(() => {});
    }
    return { outcome: "duplicate", conflicting_stripe_object_id: conflict };
  }

  const outcome = await writeEvent(deps, order, {
    kind: args.kind,
    cause: args.cause,
    amount_cents: args.amount_cents,
    idempotency_key: args.idempotency_key,
    stripe_object_id: args.stripe_object_id,
    stripe_event_id: args.stripe_event_id,
    actor_kind: args.actor_kind ?? "system",
  });
  return { outcome, conflicting_stripe_object_id: null };
}
