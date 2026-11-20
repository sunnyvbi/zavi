
import type Stripe from "stripe";
import { alert } from "@/services/logging/alert";
import { logEvent } from "@/services/logging/logEvent";
import {
  attachCreatorOrderPaymentIntent,
  closeCreatorPayoutForChargeback,
  listCreatorPayoutsAwaiting,
  loadCreatorPayoutAccountByStripeId,
  markCreatorPayoutReady,
  markOrderTransferred,
  releaseOrderTransferClaim,
  resolveCreatorOrderById,
  resolveCreatorOrderByPaymentIntent,
  resolveCreatorOrderByTransfer,
  findCreatorMoneyEvent,
  updateCreatorPayoutAccountFlags,
  writeCreatorOrderChargeback,
  type CreatorMoneyEventCause,
  type CreatorOrderRef,
} from "./db";
import {
  cancelCreatorHold,
  creatorIdempotencyKey,
  releaseOrphanCreatorHold,
  recordCreatorMoneyObservation,
  transferToCreator,
} from "./orders-money";
import { fulfilCreatorCheckout } from "./checkout-fulfil";
import { refundCreatorHire, settleCreatorHire } from "@/services/decisions/creator-hire-budget";
import { SAVED_CARD_HOLD_MARKER } from "./orders-money";
import { creatorStripeClient } from "./client";
import { CREATOR_PAYOUT_DISCONNECTED, creatorTransfersActive } from "./payout-accounts";
import { payoutCauseForClose, realPayoutReleaseDeps, releaseParkedPayouts } from "./payout-release";

export const CREATOR_WEBHOOK_EVENTS = [
  "account.updated",
  "account.application.authorized",
  "account.application.deauthorized",
  "payment_intent.amount_capturable_updated",
  "payment_intent.canceled",
  "payment_intent.payment_failed",
  "payment_intent.succeeded",
  "charge.refunded",
  "charge.dispute.created",
  "charge.dispute.closed",
  "transfer.created",
  "transfer.reversed",
  "transfer.failed",
] as const;

const HANDLED = new Set<string>(CREATOR_WEBHOOK_EVENTS);

export function isCreatorWebhookEvent(type: string): boolean {
  return HANDLED.has(type);
}

export type CreatorWebhookOutcome = {
  outcome:
    | "ignored_unhandled_type"
    | "ignored_unknown_account"
    | "ignored_unknown_object"
    | "ignored_livemode_mismatch"
    | "recorded"
    | "released";
  released?: number;
  waiting?: number;
};

export type CreatorWebhookDeps = {
  resolveOrderById: typeof resolveCreatorOrderById;
  resolveOrderByPaymentIntent: typeof resolveCreatorOrderByPaymentIntent;
  resolveOrderByTransfer: typeof resolveCreatorOrderByTransfer;
  listPayoutsAwaiting: typeof listCreatorPayoutsAwaiting;
  markPayoutReady: typeof markCreatorPayoutReady;
  attachPaymentIntent: typeof attachCreatorOrderPaymentIntent;
  loadAccountByStripeId: typeof loadCreatorPayoutAccountByStripeId;
  updateAccountFlags: typeof updateCreatorPayoutAccountFlags;
  markTransferred: typeof markOrderTransferred;
  releaseTransferClaim: typeof releaseOrderTransferClaim;
  fulfil: typeof fulfilCreatorCheckout;
  cancelHold: typeof cancelCreatorHold;
  releaseOrphanHold: typeof releaseOrphanCreatorHold;
  recordObservation: typeof recordCreatorMoneyObservation;
  transfer: typeof transferToCreator;
  writeChargeback: typeof writeCreatorOrderChargeback;
  closePayoutForChargeback: typeof closeCreatorPayoutForChargeback;
  alert: typeof alert;
  log: typeof logEvent;
  settleHire?: typeof settleCreatorHire;
  refundHire?: typeof refundCreatorHire;
  listChargeRefunds?: typeof listCreatorChargeRefunds;
  findEvent?: typeof findCreatorMoneyEvent;
};

export type ObservedChargeRefund = {
  id: string;
  amount: number;
  status: string | null;
  metadata: Stripe.Metadata | null;
};

export async function listCreatorChargeRefunds(charge_id: string): Promise<ObservedChargeRefund[]> {
  const out: ObservedChargeRefund[] = [];
  let starting_after: string | undefined;
  for (;;) {
    const page = await creatorStripeClient().refunds.list({
      charge: charge_id,
      limit: 100,
      ...(starting_after ? { starting_after } : {}),
    });
    for (const r of page.data) {
      out.push({ id: r.id, amount: r.amount, status: r.status ?? null, metadata: r.metadata ?? null });
    }
    if (!page.has_more || page.data.length === 0) return out;
    starting_after = page.data[page.data.length - 1].id;
  }
}

export const realCreatorWebhookDeps: CreatorWebhookDeps = {
  resolveOrderById: resolveCreatorOrderById,
  resolveOrderByPaymentIntent: resolveCreatorOrderByPaymentIntent,
  resolveOrderByTransfer: resolveCreatorOrderByTransfer,
  listPayoutsAwaiting: listCreatorPayoutsAwaiting,
  markPayoutReady: markCreatorPayoutReady,
  attachPaymentIntent: attachCreatorOrderPaymentIntent,
  loadAccountByStripeId: loadCreatorPayoutAccountByStripeId,
  updateAccountFlags: updateCreatorPayoutAccountFlags,
  markTransferred: markOrderTransferred,
  releaseTransferClaim: releaseOrderTransferClaim,
  fulfil: fulfilCreatorCheckout,
  cancelHold: cancelCreatorHold,
  releaseOrphanHold: releaseOrphanCreatorHold,
  recordObservation: recordCreatorMoneyObservation,
  findEvent: findCreatorMoneyEvent,
  transfer: transferToCreator,
  writeChargeback: writeCreatorOrderChargeback,
  closePayoutForChargeback: closeCreatorPayoutForChargeback,
  alert,
  log: logEvent,
  settleHire: settleCreatorHire,
  refundHire: refundCreatorHire,
  listChargeRefunds: listCreatorChargeRefunds,
};

function stripeId(v: unknown): string | null {
  if (typeof v === "string") return v || null;
  if (v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string") {
    return (v as { id: string }).id || null;
  }
  return null;
}

function metadataOrderId(meta: Stripe.Metadata | null | undefined): string | null {
  const raw = meta?.zavi_creator_order_id;
  return typeof raw === "string" && /^[0-9a-f-]{36}$/i.test(raw) ? raw : null;
}

async function resolveOrder(
  deps: CreatorWebhookDeps,
  args: { metadata?: Stripe.Metadata | null; byPaymentIntent?: string | null; byTransfer?: string | null },
): Promise<CreatorOrderRef | null> {
  const fromMeta = metadataOrderId(args.metadata);
  if (fromMeta) {
    const ref = await deps.resolveOrderById(fromMeta);
    if (ref) return ref;
  }
  if (args.byPaymentIntent) {
    const ref = await deps.resolveOrderByPaymentIntent(args.byPaymentIntent);
    if (ref) return ref;
  }
  if (args.byTransfer) {
    const ref = await deps.resolveOrderByTransfer(args.byTransfer);
    if (ref) return ref;
  }
  return null;
}

async function note(
  deps: CreatorWebhookDeps,
  level: "info" | "warn" | "error",
  code: string,
  message: string,
  meta: { event_id: string; object_id?: string | null; creator_order_id?: string; amount?: number; currency?: string; count?: number; reject_reason?: string; fulfil_state?: string },
  tenant_id?: string,
): Promise<void> {
  await deps
    .log({ level, source: "creator-webhook", code, message, tenant_id, meta })
    .catch(() => {});
}

function holdCancelCause(
  reason: string | null | undefined,
): Extract<CreatorMoneyEventCause, "expiry" | "withdrawn" | "checkout_abandoned"> {
  switch (reason) {
    case "abandoned":
      return "checkout_abandoned";
    case "requested_by_customer":
    case "duplicate":
    case "fraudulent":
      return "withdrawn";
    default:
      return "expiry";
  }
}

async function handleAccountUpdated(
  event: Stripe.Event,
  deps: CreatorWebhookDeps,
): Promise<CreatorWebhookOutcome> {
  const account = event.data.object as Stripe.Account;
  const accountId = event.account ?? account.id ?? "";
  const row = await deps.loadAccountByStripeId(accountId);
  if (!row) {
    await note(deps, "info", "creator.webhook.ignored", "account.updated for an account outside the creator network", {
      event_id: event.id,
      object_id: accountId || null,
      reject_reason: "unknown_account",
    });
    return { outcome: "ignored_unknown_account" };
  }
  if (row.livemode !== event.livemode) {
    await note(deps, "warn", "creator.webhook.ignored", "account.updated livemode does not match the stored payout account", {
      event_id: event.id,
      object_id: accountId,
      reject_reason: "livemode_mismatch",
    });
    return { outcome: "ignored_livemode_mismatch" };
  }

  const disconnected = row.disabled_reason === CREATOR_PAYOUT_DISCONNECTED;

  await deps.updateAccountFlags({
    stripe_account_id: row.stripe_account_id,
    details_submitted: account.details_submitted === true,
    payouts_enabled: disconnected ? false : account.payouts_enabled === true,
    disabled_reason: disconnected
      ? CREATOR_PAYOUT_DISCONNECTED
      : (account.requirements?.disabled_reason ?? null),
    country: account.country ?? null,
    keepDisconnected: !disconnected,
  });

  if (disconnected) {
    await note(
      deps,
      "warn",
      "creator.webhook.account_updated_while_disconnected",
      "account.updated arrived for a creator who disconnected Zavi; the payout block stands until they reconnect",
      { event_id: event.id, object_id: row.stripe_account_id },
    );
    return { outcome: "recorded", released: 0 };
  }

  if (!creatorTransfersActive(account)) {
    await note(deps, "info", "creator.webhook.account_updated", "Creator payout account updated; transfers still not active", {
      event_id: event.id,
      object_id: row.stripe_account_id,
    });
    return { outcome: "recorded", released: 0 };
  }

  const { released, still_waiting: stillWaiting, rejected } = await releaseParkedPayouts(
    row.human_member_id,
    row.livemode,
    deps,
  );
  for (const r of rejected) {
    await note(
      deps,
      "warn",
      "creator.webhook.payout_still_waiting",
      "Creator payout could not go out even though transfers are active",
      { event_id: event.id, object_id: row.stripe_account_id, creator_order_id: r.order_id, reject_reason: r.reason },
      r.tenant_id,
    );
  }

  await note(deps, "info", "creator.webhook.payouts_released", "Creator Stripe setup completed; waiting payouts processed", {
    event_id: event.id,
    object_id: row.stripe_account_id,
    count: released,
  });
  return { outcome: "released", released, waiting: stillWaiting };
}

async function handleDeauthorized(
  event: Stripe.Event,
  deps: CreatorWebhookDeps,
): Promise<CreatorWebhookOutcome> {
  const accountId = event.account ?? "";
  const row = await deps.loadAccountByStripeId(accountId);
  if (!row) {
    await note(deps, "info", "creator.webhook.ignored", "Deauthorization for an account outside the creator network", {
      event_id: event.id,
      object_id: accountId || null,
      reject_reason: "unknown_account",
    });
    return { outcome: "ignored_unknown_account" };
  }
  if (row.livemode !== event.livemode) {
    return { outcome: "ignored_livemode_mismatch" };
  }

  await deps.updateAccountFlags({
    stripe_account_id: row.stripe_account_id,
    details_submitted: row.details_submitted,
    payouts_enabled: false,
    disabled_reason: CREATOR_PAYOUT_DISCONNECTED,
  });

  await note(
    deps,
    "error",
    "creator.webhook.account_deauthorized",
    "A creator disconnected their Stripe account from Zavi; their payouts are blocked until they reconnect",
    { event_id: event.id, object_id: row.stripe_account_id },
  );
  return { outcome: "recorded" };
}

async function handleReauthorized(
  event: Stripe.Event,
  deps: CreatorWebhookDeps,
): Promise<CreatorWebhookOutcome> {
  const accountId = event.account ?? "";
  const row = await deps.loadAccountByStripeId(accountId);
  if (!row) {
    await note(deps, "info", "creator.webhook.ignored", "Authorization for an account outside the creator network", {
      event_id: event.id,
      object_id: accountId || null,
      reject_reason: "unknown_account",
    });
    return { outcome: "ignored_unknown_account" };
  }
  if (row.livemode !== event.livemode) return { outcome: "ignored_livemode_mismatch" };
  if (row.disabled_reason !== CREATOR_PAYOUT_DISCONNECTED) return { outcome: "recorded" };

  await deps.updateAccountFlags({
    stripe_account_id: row.stripe_account_id,
    details_submitted: row.details_submitted,
    payouts_enabled: false,
    disabled_reason: null,
  });
  await note(
    deps,
    "info",
    "creator.webhook.account_reauthorized",
    "A creator reconnected their Stripe account; the payout block is lifted",
    { event_id: event.id, object_id: row.stripe_account_id },
  );
  return { outcome: "recorded" };
}

async function handleHoldPlaced(
  event: Stripe.Event,
  deps: CreatorWebhookDeps,
): Promise<CreatorWebhookOutcome> {
  const pi = event.data.object as Stripe.PaymentIntent;
  const ref = await resolveOrder(deps, { metadata: pi.metadata, byPaymentIntent: pi.id });
  if (!ref) return ignoredObject(deps, event, pi.id);
  if (ref.livemode !== event.livemode) return ignoredLivemode(deps, event, pi.id, ref);

  let r = await deps.fulfil({ tenant_id: ref.tenant_id, order_id: ref.id });

  if (
    r.state === "pending" &&
    r.reason === "no_checkout" &&
    !ref.stripe_payment_intent_id &&
    pi.metadata?.zavi_hold === SAVED_CARD_HOLD_MARKER &&
    metadataOrderId(pi.metadata) === ref.id
  ) {
    const bound = await deps.attachPaymentIntent({ tenant_id: ref.tenant_id, order_id: ref.id, payment_intent_id: pi.id, hold_expires_at: null });
    if (!bound) {
      const fresh = await deps.resolveOrderById(ref.id);
      if (!fresh || fresh.tenant_id !== ref.tenant_id) throw new Error(`creator order ${ref.id} could not be re-read; retry`);
      if (fresh.stripe_payment_intent_id !== pi.id) {
        await deps.releaseOrphanHold({ payment_intent_id: pi.id, order_livemode: ref.livemode });
      }
    }
    r = await deps.fulfil({ tenant_id: ref.tenant_id, order_id: ref.id });
  }

  if (r.state === "pending" && r.reason === "brief_held") {
    throw new Error(`creator order ${ref.id} is waiting on another hire for its brief; retry`);
  }

  if (r.state === "already_done" && r.status === "cancelled") {
    const released = await deps.releaseOrphanHold({ payment_intent_id: pi.id, order_livemode: ref.livemode });
    if (released === "released" || released === "not_held") await settleHireQuietly(deps, event, ref, "released");
    const strayCapture = released === "captured" && ref.stripe_payment_intent_id !== pi.id;
    await note(
      deps,
      strayCapture ? "error" : "warn",
      "creator.webhook.orphan_hold",
      `Card hold on an already-cancelled order: ${released}`,
      { event_id: event.id, object_id: pi.id, creator_order_id: ref.id },
      ref.tenant_id,
    );
    return { outcome: "recorded" };
  }

  await note(
    deps,
    r.state === "needs_staff" ? "error" : "info",
    "creator.webhook.hold_placed",
    `Card hold event fulfilled through S7: ${r.state}`,
    {
      event_id: event.id,
      object_id: pi.id,
      creator_order_id: ref.id,
      fulfil_state: r.state,
    },
    ref.tenant_id,
  );
  return { outcome: "recorded" };
}

async function handleHoldReleased(
  event: Stripe.Event,
  deps: CreatorWebhookDeps,
): Promise<CreatorWebhookOutcome> {
  const pi = event.data.object as Stripe.PaymentIntent;
  const ref = await resolveOrder(deps, { metadata: pi.metadata, byPaymentIntent: pi.id });
  if (!ref) return ignoredObject(deps, event, pi.id);
  if (ref.livemode !== event.livemode) return ignoredLivemode(deps, event, pi.id, ref);

  if (ref.stripe_payment_intent_id && ref.stripe_payment_intent_id !== pi.id) {
    await note(
      deps,
      "info",
      "creator.webhook.ignored",
      "Cancellation is for an older PaymentIntent than the one this order is on; the live hold was left alone",
      {
        event_id: event.id,
        object_id: pi.id,
        creator_order_id: ref.id,
        reject_reason: "superseded_payment_intent",
      },
      ref.tenant_id,
    );
    return { outcome: "ignored_unknown_object" };
  }

  if (!ref.stripe_payment_intent_id && pi.metadata?.zavi_hold === SAVED_CARD_HOLD_MARKER) {
    await note(deps, "info", "creator.webhook.ignored", "Cancelled saved-card hold that was never this order's payment", {
      event_id: event.id,
      object_id: pi.id,
      creator_order_id: ref.id,
      reject_reason: "saved_card_never_attached",
    }, ref.tenant_id);
    return { outcome: "ignored_unknown_object" };
  }

  if (!ref.stripe_payment_intent_id && pi.cancellation_reason === "abandoned") {
    await note(deps, "info", "creator.webhook.ignored", "Abandoned Checkout PaymentIntent never held money for this order; not bound", {
      event_id: event.id,
      object_id: pi.id,
      creator_order_id: ref.id,
      reject_reason: "abandoned_never_held",
    }, ref.tenant_id);
    return { outcome: "ignored_unknown_object" };
  }

  if (!ref.stripe_payment_intent_id) {
    await deps.attachPaymentIntent({
      tenant_id: ref.tenant_id,
      order_id: ref.id,
      payment_intent_id: pi.id,
      hold_expires_at: null,
    });
  }

  const cause = holdCancelCause(pi.cancellation_reason);
  const result = await deps.cancelHold({
    tenant_id: ref.tenant_id,
    order_id: ref.id,
    cause,
    expected_payment_intent_id: pi.id,
  });
  if (!result.ok && result.action === "superseded") {
    await note(
      deps,
      "info",
      "creator.webhook.ignored",
      "Cancellation is for an older PaymentIntent than the one this order is on; the live hold was left alone",
      {
        event_id: event.id,
        object_id: pi.id,
        creator_order_id: ref.id,
        reject_reason: "superseded_payment_intent",
      },
      ref.tenant_id,
    );
    return { outcome: "ignored_unknown_object" };
  }
  if (!result.ok) {
    await note(
      deps,
      "error",
      "creator.webhook.hold_release_conflict",
      "Stripe reported a released hold on a payment S2 reads as captured; this order needs a refund, not a release",
      { event_id: event.id, object_id: pi.id, creator_order_id: ref.id },
      ref.tenant_id,
    );
    return { outcome: "recorded" };
  }

  await settleHireQuietly(deps, event, ref, "released");

  await note(deps, "info", "creator.webhook.hold_released", "Card hold released; nothing was charged", {
    event_id: event.id,
    object_id: pi.id,
    creator_order_id: ref.id,
    reject_reason: cause,
  }, ref.tenant_id);
  return { outcome: "recorded" };
}

async function handlePaymentFailed(
  event: Stripe.Event,
  deps: CreatorWebhookDeps,
): Promise<CreatorWebhookOutcome> {
  const pi = event.data.object as Stripe.PaymentIntent;
  const ref = await resolveOrder(deps, { metadata: pi.metadata, byPaymentIntent: pi.id });
  if (!ref) return ignoredObject(deps, event, pi.id);
  if (ref.livemode !== event.livemode) return ignoredLivemode(deps, event, pi.id, ref);

  await note(
    deps,
    "warn",
    "creator.webhook.payment_failed",
    "The business's card was declined for a creator order; no hold exists",
    {
      event_id: event.id,
      object_id: pi.id,
      creator_order_id: ref.id,
      reject_reason: pi.last_payment_error?.code ?? "unknown",
    },
    ref.tenant_id,
  );
  return { outcome: "recorded" };
}

async function handleCaptured(
  event: Stripe.Event,
  deps: CreatorWebhookDeps,
): Promise<CreatorWebhookOutcome> {
  const pi = event.data.object as Stripe.PaymentIntent;
  if (!metadataOrderId(pi.metadata)) return { outcome: "ignored_unknown_object" };
  const ref = await resolveOrder(deps, { metadata: pi.metadata, byPaymentIntent: pi.id });
  if (!ref) return ignoredObject(deps, event, pi.id);
  if (ref.livemode !== event.livemode) return ignoredLivemode(deps, event, pi.id, ref);
  if (ref.stripe_payment_intent_id !== pi.id) return { outcome: "ignored_unknown_object" };
  if (deps.settleHire) {
    const res = await deps.settleHire(ref.tenant_id, ref.id, "spent");
    if (res.status === "unavailable") throw new Error(`creator hire settle failed for order ${ref.id}; retry`);
  }
  return { outcome: "recorded" };
}

async function settleHireQuietly(
  deps: CreatorWebhookDeps,
  event: Stripe.Event,
  ref: CreatorOrderRef,
  outcome: "spent" | "released",
): Promise<void> {
  if (!deps.settleHire) return;
  const res = await deps.settleHire(ref.tenant_id, ref.id, outcome);
  if (res.status === "unavailable") {
    await note(deps, "error", "creator.webhook.hire_settle_failed", `Creator hire reservation could not be settled ${outcome}`, {
      event_id: event.id,
      creator_order_id: ref.id,
    }, ref.tenant_id);
    throw new Error(`creator hire settle (${outcome}) failed for order ${ref.id}; retry`);
  }
}

async function handleChargeRefunded(
  event: Stripe.Event,
  deps: CreatorWebhookDeps,
): Promise<CreatorWebhookOutcome> {
  const charge = event.data.object as Stripe.Charge;
  const piId = stripeId(charge.payment_intent);
  const ref = await resolveOrder(deps, { metadata: charge.metadata, byPaymentIntent: piId });
  if (!ref) return ignoredObject(deps, event, charge.id);
  if (ref.livemode !== event.livemode) return ignoredLivemode(deps, event, charge.id, ref);

  const refunds: ObservedChargeRefund[] = deps.listChargeRefunds
    ? await deps.listChargeRefunds(charge.id)
    : (charge.refunds?.data ?? []).map((r) => ({
        id: r.id,
        amount: r.amount,
        status: r.status ?? null,
        metadata: r.metadata ?? null,
      }));
  const zaviKeyPrefix = creatorIdempotencyKey.refund(ref.id, 0).replace(/0$/, "");
  const observed = refunds
    .filter((r) => r.status !== "failed" && r.status !== "canceled")
    .map((r) => {
      const zaviKey = r.metadata?.zavi_idempotency_key;
      const ours = typeof zaviKey === "string" && zaviKey.startsWith(zaviKeyPrefix);
      return { id: r.id, amount: r.amount, key: ours ? zaviKey : `${zaviKeyPrefix}${r.id}`, ours };
    });

  let outOfBand = 0;
  const consumedLegacy = new Set<string>();
  for (const r of observed) {
    if (!r.ours && deps.findEvent && !(await deps.findEvent(ref.tenant_id, r.key))) {
      const legacyKey = creatorIdempotencyKey.refund(ref.id, r.amount);
      const legacy = await deps.findEvent(ref.tenant_id, legacyKey);
      if (legacy?.stripe_object_id === r.id) continue;
      if (
        legacy &&
        legacy.stripe_object_id === charge.id &&
        legacy.amount_cents === r.amount &&
        !consumedLegacy.has(legacyKey)
      ) {
        consumedLegacy.add(legacyKey);
        continue;
      }
    }
    const res = await deps.recordObservation({
      tenant_id: ref.tenant_id,
      order_id: ref.id,
      kind: "refund",
      cause: "mediation",
      amount_cents: r.amount,
      idempotency_key: r.key,
      stripe_object_id: r.id,
      stripe_event_id: event.id,
      actor_kind: "staff",
    });
    if (res.outcome === "inserted" && !r.ours) outOfBand += 1;
  }

  if (outOfBand > 0) {
    await note(
      deps,
      "error",
      "creator.webhook.refund_out_of_band",
      "A refund on a creator order was issued outside Zavi's money rail, so no transfer reversal was paired with it",
      { event_id: event.id, object_id: charge.id, creator_order_id: ref.id, count: outOfBand },
      ref.tenant_id,
    );
  }

  if (piId && piId === ref.stripe_payment_intent_id && charge.amount_refunded > 0) {
    await settleHireQuietly(deps, event, ref, "spent");
    if (deps.refundHire) {
      const res = await deps.refundHire(ref.tenant_id, ref.id, charge.amount_refunded / 100);
      if (res.status === "unavailable") throw new Error(`creator hire refund could not be recorded for order ${ref.id}; retry`);
    }
  }
  return { outcome: "recorded" };
}

async function handleChargeDispute(
  event: Stripe.Event,
  deps: CreatorWebhookDeps,
): Promise<CreatorWebhookOutcome> {
  const dispute = event.data.object as Stripe.Dispute;
  const piId = stripeId(dispute.payment_intent);
  const ref = await resolveOrder(deps, { metadata: dispute.metadata, byPaymentIntent: piId });
  if (!ref) return ignoredObject(deps, event, dispute.id);
  if (ref.livemode !== event.livemode) return ignoredLivemode(deps, event, dispute.id, ref);

  const to: "open" | "won" | "lost" =
    event.type === "charge.dispute.created"
      ? "open"
      : dispute.status === "lost"
        ? "lost"
        : "won";

  const changed = await deps.writeChargeback({
    tenant_id: ref.tenant_id,
    order_id: ref.id,
    stripe_dispute_id: dispute.id,
    to,
  });

  if (to === "lost") {
    await deps.closePayoutForChargeback({ tenant_id: ref.tenant_id, order_id: ref.id });
    const fresh = (await deps.resolveOrderById(ref.id)) ?? ref;
    const paidOut = fresh.payout_status === "transferring" || fresh.payout_status === "transferred";
    if (paidOut) {
      await deps.alert({
        source: "creator-webhook",
        code: "creator_chargeback_lost_after_payout",
        tenant_id: ref.tenant_id,
        msg:
          `Creator order ${ref.id}: chargeback ${dispute.id} was lost after the creator payout ` +
          `(${fresh.payout_status}${fresh.stripe_transfer_id ? `, transfer ${fresh.stripe_transfer_id}` : ""}). ` +
          "Nothing was reversed automatically; staff decide whether to recover it.",
        email: {
          dedupeKey: `creator_chargeback_lost_after_payout:${dispute.id}`,
          required: true,
        },
      });
    }
    await note(
      deps,
      paidOut ? "error" : "warn",
      "creator.webhook.chargeback_lost",
      paidOut
        ? "A chargeback on a creator order was lost after the payout left; staff are paged, nothing was reversed"
        : "A chargeback on a creator order was lost; the creator payout is closed",
      { event_id: event.id, object_id: dispute.id, creator_order_id: ref.id, amount: dispute.amount },
      ref.tenant_id,
    );
    return { outcome: "recorded" };
  }

  await note(
    deps,
    changed && to === "open" ? "warn" : "info",
    to === "open" ? "creator.webhook.chargeback_opened" : "creator.webhook.chargeback_won",
    changed
      ? to === "open"
        ? "A business disputed the card charge on a creator order; the payout is on hold"
        : "A chargeback on a creator order was decided for Zavi; the payout hold is lifted"
      : "Chargeback event already applied; nothing changed",
    { event_id: event.id, object_id: dispute.id, creator_order_id: ref.id, amount: dispute.amount },
    ref.tenant_id,
  );
  return { outcome: "recorded" };
}

function transferCause(
  meta: Stripe.Metadata | null | undefined,
): "approval" | "auto_accept_buffer" | "mediation" {
  const raw = meta?.zavi_cause;
  return raw === "auto_accept_buffer" || raw === "mediation" ? raw : "approval";
}

async function handleTransferCreated(
  event: Stripe.Event,
  deps: CreatorWebhookDeps,
): Promise<CreatorWebhookOutcome> {
  const tr = event.data.object as Stripe.Transfer;
  const ref = await resolveOrder(deps, { metadata: tr.metadata, byTransfer: tr.id });
  if (!ref) return ignoredObject(deps, event, tr.id);
  if (ref.livemode !== event.livemode) return ignoredLivemode(deps, event, tr.id, ref);

  const key = creatorIdempotencyKey.transfer(ref.id);
  if (ref.payout_status === "transferring" && !ref.stripe_transfer_id) {
    const marked = await deps.markTransferred({
      order_id: ref.id,
      transfer_id: tr.id,
      idempotency_key: key,
      cause: transferCause(tr.metadata),
    });
    await note(
      deps,
      marked === 1 ? "info" : "warn",
      "creator.webhook.transfer_reconciled",
      marked === 1
        ? "Recovered an unrecorded creator transfer from Stripe and finalized the order"
        : "Transfer event arrived for an order that was no longer claimed; nothing finalized",
      { event_id: event.id, object_id: tr.id, creator_order_id: ref.id, amount: tr.amount },
      ref.tenant_id,
    );
    return { outcome: "recorded" };
  }

  const res = await deps.recordObservation({
    tenant_id: ref.tenant_id,
    order_id: ref.id,
    kind: "transfer",
    cause: transferCause(tr.metadata),
    amount_cents: tr.amount,
    idempotency_key: key,
    stripe_object_id: tr.id,
    stripe_event_id: event.id,
  });
  await note(
    deps,
    res.outcome === "inserted" ? "warn" : "info",
    "creator.webhook.transfer_created",
    res.outcome === "inserted"
      ? "A creator transfer appeared on Stripe that this rail had no ledger row for"
      : "Creator transfer confirmed by Stripe",
    { event_id: event.id, object_id: tr.id, creator_order_id: ref.id, amount: tr.amount },
    ref.tenant_id,
  );
  return { outcome: "recorded" };
}

async function handleTransferReversed(
  event: Stripe.Event,
  deps: CreatorWebhookDeps,
): Promise<CreatorWebhookOutcome> {
  const tr = event.data.object as Stripe.Transfer;
  const ref = await resolveOrder(deps, { metadata: tr.metadata, byTransfer: tr.id });
  if (!ref) return ignoredObject(deps, event, tr.id);
  if (ref.livemode !== event.livemode) return ignoredLivemode(deps, event, tr.id, ref);

  const reversals = tr.reversals?.data ?? [];
  const observed = reversals.length
    ? reversals.map((r) => ({ id: r.id, amount: r.amount }))
    : tr.amount_reversed > 0
      ? [{ id: tr.id, amount: tr.amount_reversed }]
      : [];

  let outOfBand = 0;
  for (const r of observed) {
    const res = await deps.recordObservation({
      tenant_id: ref.tenant_id,
      order_id: ref.id,
      kind: "transfer_reversal",
      cause: "mediation",
      amount_cents: r.amount,
      idempotency_key: creatorIdempotencyKey.reversal(ref.id, r.amount),
      stripe_object_id: tr.id,
      stripe_event_id: event.id,
      actor_kind: "staff",
    });
    if (res.outcome === "inserted") outOfBand += 1;
  }

  await note(
    deps,
    outOfBand > 0 ? "error" : "info",
    "creator.webhook.transfer_reversed",
    outOfBand > 0
      ? "A creator payout was reversed outside Zavi's money rail; the order still reads as paid out and needs staff reconciliation"
      : "Creator transfer reversal confirmed by Stripe",
    { event_id: event.id, object_id: tr.id, creator_order_id: ref.id, amount: tr.amount_reversed },
    ref.tenant_id,
  );
  return { outcome: "recorded" };
}

async function handleTransferFailed(
  event: Stripe.Event,
  deps: CreatorWebhookDeps,
): Promise<CreatorWebhookOutcome> {
  const tr = event.data.object as Stripe.Transfer;
  const ref = await resolveOrder(deps, { metadata: tr.metadata, byTransfer: tr.id });
  if (!ref) return ignoredObject(deps, event, tr.id);
  if (ref.livemode !== event.livemode) return ignoredLivemode(deps, event, tr.id, ref);

  if (ref.payout_status === "transferring") {
    const released = await deps.releaseTransferClaim(ref.id);
    await note(
      deps,
      "error",
      "creator.webhook.transfer_failed",
      released === 1
        ? "Creator transfer failed at Stripe; the payout claim was released so it can be retried"
        : "Creator transfer failed at Stripe; the payout was no longer claimed",
      { event_id: event.id, object_id: tr.id, creator_order_id: ref.id, amount: tr.amount },
      ref.tenant_id,
    );
    return { outcome: "recorded" };
  }

  await note(
    deps,
    "error",
    "creator.webhook.transfer_failed_after_record",
    "Stripe reported a failed transfer for a payout this order already records as sent; staff must reconcile",
    { event_id: event.id, object_id: tr.id, creator_order_id: ref.id, amount: tr.amount },
    ref.tenant_id,
  );
  return { outcome: "recorded" };
}

async function ignoredObject(
  deps: CreatorWebhookDeps,
  event: Stripe.Event,
  objectId: string | null,
): Promise<CreatorWebhookOutcome> {
  await note(deps, "info", "creator.webhook.ignored", "Stripe event for an object outside the creator network", {
    event_id: event.id,
    object_id: objectId,
    reject_reason: "unknown_object",
  });
  return { outcome: "ignored_unknown_object" };
}

async function ignoredLivemode(
  deps: CreatorWebhookDeps,
  event: Stripe.Event,
  objectId: string | null,
  ref: CreatorOrderRef,
): Promise<CreatorWebhookOutcome> {
  await note(
    deps,
    "warn",
    "creator.webhook.ignored",
    "Stripe event livemode does not match the order it points at; refusing to act across that boundary",
    { event_id: event.id, object_id: objectId, creator_order_id: ref.id, reject_reason: "livemode_mismatch" },
  );
  return { outcome: "ignored_livemode_mismatch" };
}

export async function applyCreatorStripeEvent(
  event: Stripe.Event,
  deps: CreatorWebhookDeps = realCreatorWebhookDeps,
): Promise<CreatorWebhookOutcome> {
  switch (event.type as string) {
    case "account.updated":
      return handleAccountUpdated(event, deps);
    case "account.application.authorized":
      return handleReauthorized(event, deps);
    case "account.application.deauthorized":
      return handleDeauthorized(event, deps);
    case "payment_intent.amount_capturable_updated":
      return handleHoldPlaced(event, deps);
    case "payment_intent.canceled":
      return handleHoldReleased(event, deps);
    case "payment_intent.payment_failed":
      return handlePaymentFailed(event, deps);
    case "payment_intent.succeeded":
      return handleCaptured(event, deps);
    case "charge.refunded":
      return handleChargeRefunded(event, deps);
    case "charge.dispute.created":
    case "charge.dispute.closed":
      return handleChargeDispute(event, deps);
    case "transfer.created":
      return handleTransferCreated(event, deps);
    case "transfer.reversed":
      return handleTransferReversed(event, deps);
    case "transfer.failed":
      return handleTransferFailed(event, deps);
    default:
      return { outcome: "ignored_unhandled_type" };
  }
}
