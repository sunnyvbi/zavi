
import { logEvent } from "@/services/logging/logEvent";
import { ExpectedToolError } from "@/services/tools/types";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { creatorStripeClient } from "./client";
import { readCreatorHold, recordCreatorHold } from "./orders-money";
import { applyCreatorOrderTransition } from "./order-transitions";
import { declineLateHire, realAutoNoDeps, realLateHireDeps, sendAutomaticNos } from "./brief-applications";
import { claimBriefForHire, loadBriefOwner, releaseBriefClaim } from "./briefs-db";
import {
  attachPaymentIntent,
  loadOfferExpiresAt,
  loadOrderForCheckout,
  type CreatorOrderCheckoutRow,
} from "./booking-db";

export type FulfilCreatorCheckoutResult =
  | {
      state: "fulfilled";
      order_id: string;
      status: string;
      payment_intent_id: string;
      hold_expires_at: string | null;
    }
  | { state: "already_done"; order_id: string; status: string }
  | {
      state: "pending";
      order_id: string;
      reason: "no_checkout" | "no_payment_intent" | "not_held" | "brief_held";
    }
  | { state: "cancelled"; order_id: string; status: string; message: string }
  | { state: "needs_staff"; order_id: string; message: string };

export type FulfilDeps = {
  stripe: typeof creatorStripeClient;
  loadOrder: typeof loadOrderForCheckout;
  attachPaymentIntent: typeof attachPaymentIntent;
  readHold: typeof readCreatorHold;
  recordHold: typeof recordCreatorHold;
  transition: typeof applyCreatorOrderTransition;
  briefHired: (args: {
    tenant_id: string;
    brief_id: string;
    hired_application_id: string;
  }) => Promise<unknown>;
  claimBrief: typeof claimBriefForHire;
  releaseBrief: typeof releaseBriefClaim;
  briefOwner: typeof loadBriefOwner;
  declineLate: (args: { tenant_id: string; brief_id: string; application_id: string }) => Promise<unknown>;
  offerExpiresAt?: typeof loadOfferExpiresAt;
  replacePaymentIntent?: typeof replaceDeadPaymentIntent;
  log: typeof logEvent;
};

export async function replaceDeadPaymentIntent(args: {
  tenant_id: string;
  order_id: string;
  from_payment_intent_id: string;
  to_payment_intent_id: string;
}): Promise<boolean> {
  const { data, error } = await tenantClient(asTenantId(args.tenant_id))
    .from("creator_orders")
    .update({
      stripe_payment_intent_id: args.to_payment_intent_id,
      hold_expires_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", args.order_id)
    .eq("status", "checkout_pending")
    .eq("stripe_payment_intent_id", args.from_payment_intent_id)
    .select("id");
  if (error) throw new Error(`replaceDeadPaymentIntent failed: ${error.message}`);
  return ((data as { id: string }[] | null) ?? []).length === 1;
}

export const realFulfilDeps: FulfilDeps = {
  stripe: creatorStripeClient,
  loadOrder: loadOrderForCheckout,
  attachPaymentIntent,
  readHold: readCreatorHold,
  recordHold: recordCreatorHold,
  transition: applyCreatorOrderTransition,
  briefHired: (args) =>
    sendAutomaticNos(
      {
        tenant_id: args.tenant_id,
        brief_id: args.brief_id,
        cause: "hire",
        hired_application_id: args.hired_application_id,
      },
      realAutoNoDeps,
    ),
  claimBrief: claimBriefForHire,
  releaseBrief: releaseBriefClaim,
  briefOwner: loadBriefOwner,
  declineLate: (args) => declineLateHire(args, realLateHireDeps),
  offerExpiresAt: loadOfferExpiresAt,
  replacePaymentIntent: replaceDeadPaymentIntent,
  log: logEvent,
};

async function paymentIntentIdFor(
  order: CreatorOrderCheckoutRow,
  deps: FulfilDeps,
): Promise<string | null> {
  if (order.stripe_payment_intent_id) return order.stripe_payment_intent_id;
  return sessionPaymentIntentId(order, deps);
}

async function sessionPaymentIntentId(
  order: CreatorOrderCheckoutRow,
  deps: FulfilDeps,
): Promise<string | null> {
  if (!order.stripe_checkout_session_id) return null;
  const session = await deps
    .stripe()
    .checkout.sessions.retrieve(order.stripe_checkout_session_id);
  const pi = session.payment_intent;
  if (!pi) return null;
  return typeof pi === "string" ? pi : pi.id;
}

async function moveOffDeadPaymentIntent(
  order: CreatorOrderCheckoutRow,
  dead: string,
  deps: FulfilDeps,
): Promise<string | null> {
  if (!deps.replacePaymentIntent) return null;
  const fresh = await sessionPaymentIntentId(order, deps);
  if (!fresh || fresh === dead) return null;
  const moved = await deps.replacePaymentIntent({
    tenant_id: order.tenant_id,
    order_id: order.id,
    from_payment_intent_id: dead,
    to_payment_intent_id: fresh,
  });
  if (!moved) return null;
  await deps.log({
    level: "warn",
    source: "creator.checkout",
    code: "checkout_replaced_dead_payment_intent",
    tenant_id: order.tenant_id,
    meta: { creator_order_id: order.id, object_id: fresh },
  });
  return fresh;
}

async function closeBriefAfterHire(
  order: CreatorOrderCheckoutRow,
  deps: FulfilDeps,
): Promise<void> {
  if (order.source !== "applicant" || !order.brief_id || !order.application_id) return;
  try {
    await deps.briefHired({
      tenant_id: order.tenant_id,
      brief_id: order.brief_id,
      hired_application_id: order.application_id,
    });
  } catch (e) {
    await deps.log({
      level: "warn",
      source: "creator.checkout",
      code: "brief_close_after_hire_failed",
      message: (e as Error).message.slice(0, 300),
      tenant_id: order.tenant_id,
      meta: { creator_order_id: order.id },
    });
  }
}

async function resolveBriefClaim(
  order: CreatorOrderCheckoutRow,
  brief_id: string,
  deps: FulfilDeps,
): Promise<"proceed" | "wait" | "taken"> {
  const scope = { tenant_id: order.tenant_id, brief_id };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const claim = await deps.claimBrief({ ...scope, order_id: order.id });
    if (claim !== "taken") return "proceed";
    const owner = await deps.briefOwner(scope);
    if (!owner) return "taken";
    const ownerOrder = await deps.loadOrder(order.tenant_id, owner);
    if (ownerOrder?.status === "checkout_pending") return "wait";
    if (!ownerOrder || ownerOrder.status === "cancelled") {
      await deps.releaseBrief({ ...scope, order_id: owner });
      continue;
    }
    return "taken";
  }
  return "wait";
}

export async function fulfilCreatorCheckout(
  args: {
    tenant_id: string;
    order_id: string;
    hold_actor_user_id?: string | null;
  },
  deps: FulfilDeps = realFulfilDeps,
): Promise<FulfilCreatorCheckoutResult> {
  let order = await deps.loadOrder(args.tenant_id, args.order_id);
  if (!order) {
    throw new ExpectedToolError(
      "creator_order_not_found",
      "That order does not exist in this workspace.",
    );
  }

  if (order.status !== "checkout_pending") {
    if (!["awaiting_acceptance", "cancelled"].includes(order.status)) {
      await closeBriefAfterHire(order, deps);
    }
    if (order.status === "cancelled" && order.source === "applicant" && order.brief_id) {
      await deps.releaseBrief({ tenant_id: order.tenant_id, brief_id: order.brief_id, order_id: order.id });
    }
    return { state: "already_done", order_id: order.id, status: order.status };
  }

  if (!order.stripe_checkout_session_id && !order.stripe_payment_intent_id) {
    return { state: "pending", order_id: order.id, reason: "no_checkout" };
  }

  let payment_intent_id = await paymentIntentIdFor(order, deps);
  if (!payment_intent_id) {
    return { state: "pending", order_id: order.id, reason: "no_payment_intent" };
  }

  let hold = await deps.readHold(payment_intent_id);
  if (hold.released && order.stripe_payment_intent_id === payment_intent_id) {
    const fresh = await moveOffDeadPaymentIntent(order, payment_intent_id, deps);
    if (fresh) {
      order = { ...order, stripe_payment_intent_id: fresh };
      payment_intent_id = fresh;
      hold = await deps.readHold(fresh);
    }
  }

  const completesLostCapture =
    !hold.held &&
    hold.captured &&
    hold.refunded_cents === 0 &&
    (order.source === "applicant" || order.source === "offer") &&
    order.stripe_payment_intent_id === payment_intent_id;

  if (!hold.held && !completesLostCapture) {
    if (hold.captured) {
      await deps.log({
        level: "error",
        source: "creator.checkout",
        code: "checkout_captured_before_fulfil",
        tenant_id: order.tenant_id,
        meta: { creator_order_id: order.id },
      });
      return {
        state: "needs_staff",
        order_id: order.id,
        message:
          "This payment was captured before the job was created. Zavi staff have to sort it out before the job can start.",
      };
    }
    return { state: "pending", order_id: order.id, reason: "not_held" };
  }

  if (completesLostCapture) {
    await deps.log({
      level: "warn",
      source: "creator.checkout",
      code: "checkout_completing_lost_capture",
      tenant_id: order.tenant_id,
      meta: { creator_order_id: order.id },
    });
  } else {
    await deps.attachPaymentIntent({
      tenant_id: order.tenant_id,
      order_id: order.id,
      payment_intent_id,
      hold_expires_at: hold.hold_expires_at,
    });

    const cause = order.source === "booking" ? "booking" : "hire";
    await deps.recordHold({
      tenant_id: order.tenant_id,
      order_id: order.id,
      payment_intent_id,
      cause,
      ...(args.hold_actor_user_id ? { actor_user_id: args.hold_actor_user_id } : {}),
    });
  }

  if (order.source === "offer" && !completesLostCapture && deps.offerExpiresAt) {
    const expiresAt = order.offer_id
      ? await deps.offerExpiresAt(order.tenant_id, order.offer_id).catch(() => undefined)
      : null;
    const paidAt = hold.authorized_at ? new Date(hold.authorized_at).getTime() : NaN;
    if (expiresAt === undefined || (expiresAt !== null && !Number.isFinite(paidAt))) {
      return { state: "pending", order_id: order.id, reason: "not_held" };
    }
    if (expiresAt === null || new Date(expiresAt).getTime() <= paidAt) {
      const released = await deps.transition({
        tenant_id: order.tenant_id,
        order_id: order.id,
        trigger: "checkout_abandoned",
        actor: "system",
        actor_user_id: null,
      });
      if (!released.ok) {
        if (released.code === "conflict" || released.code === "illegal_transition") {
          const fresh = await deps.loadOrder(args.tenant_id, args.order_id);
          return { state: "already_done", order_id: order.id, status: fresh?.status ?? order.status };
        }
        await deps.log({
          level: "error",
          source: "creator.checkout",
          code: "expired_offer_release_failed",
          tenant_id: order.tenant_id,
          meta: { creator_order_id: order.id, reject_reason: released.code },
        });
        return { state: "needs_staff", order_id: order.id, message: released.message };
      }
      return {
        state: "cancelled",
        order_id: order.id,
        status: "cancelled",
        message:
          "This offer expired before the payment went through, so no job started. The hold on your card was released and nothing was charged.",
      };
    }
  }

  const briefHire = order.source === "applicant" && order.brief_id ? order.brief_id : null;
  if (briefHire) {
    const claim = await resolveBriefClaim(order, briefHire, deps);
    if (claim === "wait") {
      return { state: "pending", order_id: order.id, reason: "brief_held" };
    }
    if (claim === "taken") {
      const released = await deps.transition({
        tenant_id: order.tenant_id,
        order_id: order.id,
        trigger: "checkout_abandoned",
        actor: "system",
        actor_user_id: null,
      });
      if (!released.ok) {
        if (released.code === "conflict" || released.code === "illegal_transition") {
          const fresh = await deps.loadOrder(args.tenant_id, args.order_id);
          return { state: "already_done", order_id: order.id, status: fresh?.status ?? order.status };
        }
        await deps.log({
          level: "error",
          source: "creator.checkout",
          code: "late_hire_release_failed",
          tenant_id: order.tenant_id,
          meta: { creator_order_id: order.id, reject_reason: released.code },
        });
        return { state: "needs_staff", order_id: order.id, message: released.message };
      }
      if (order.application_id) {
        try {
          await deps.declineLate({ tenant_id: order.tenant_id, brief_id: briefHire, application_id: order.application_id });
        } catch (e) {
          await deps.log({
            level: "warn",
            source: "creator.checkout",
            code: "late_hire_decline_failed",
            message: (e as Error).message.slice(0, 300),
            tenant_id: order.tenant_id,
            meta: { creator_order_id: order.id },
          });
        }
      }
      return {
        state: "cancelled",
        order_id: order.id,
        status: "cancelled",
        message:
          "This brief was already filled, so this hire did not go ahead. The hold on your card was released and nothing was charged.",
      };
    }
  }

  const trigger =
    order.source === "applicant"
      ? ("hire_applicant" as const)
      : order.source === "offer"
        ? ("offer_started" as const)
        : ("checkout_completed" as const);
  const result = await deps.transition({
    tenant_id: order.tenant_id,
    order_id: order.id,
    trigger,
    actor: order.source === "applicant" ? "business" : "system",
    actor_user_id: order.booked_by_user_id,
  });

  if (!result.ok) {
    if (result.code === "conflict" || result.code === "illegal_transition") {
      const fresh = await deps.loadOrder(args.tenant_id, args.order_id);
      if (fresh && !["checkout_pending", "awaiting_acceptance", "cancelled"].includes(fresh.status)) {
        await closeBriefAfterHire(fresh, deps);
      }
      return {
        state: "already_done",
        order_id: order.id,
        status: fresh?.status ?? order.status,
      };
    }
    await deps.log({
      level: "error",
      source: "creator.checkout",
      code: "fulfil_transition_failed",
      tenant_id: order.tenant_id,
      meta: { creator_order_id: order.id, reject_reason: result.code },
    });
    return { state: "needs_staff", order_id: order.id, message: result.message };
  }

  if (result.to === "cancelled") {
    if (briefHire) {
      await deps.releaseBrief({ tenant_id: order.tenant_id, brief_id: briefHire, order_id: order.id });
    }
    return {
      state: "cancelled",
      order_id: order.id,
      status: result.to,
      message: briefHire
        ? "The card could not be charged, so nobody was hired and nothing was taken. Hire them again from the brief with a different card."
        : "The card could not be charged, so this job was cancelled and nothing was taken. Book again with a different card.",
    };
  }

  if (result.to === "in_progress") await closeBriefAfterHire(order, deps);

  return {
    state: "fulfilled",
    order_id: order.id,
    status: result.to,
    payment_intent_id,
    hold_expires_at: hold.hold_expires_at,
  };
}
