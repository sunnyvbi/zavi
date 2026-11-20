
import { logEvent } from "@/services/logging/logEvent";
import { creatorStripeClient, platformKeyLivemode } from "./client";
import { fulfilCreatorCheckout } from "./checkout-fulfil";
import { loadOrderForCheckout } from "./booking-db";
import type { CreatorOrderStateRow } from "./orders-db";

const RECHECK_MS = 3600_000;
const AFTER_SESSION_EXPIRY_MS = 3600_000;

export type SettleUnpaidCheckoutResult =
  | { action: "close" }
  | { action: "settled"; state: string }
  | { action: "wait"; until: string; reason: string }
  | { action: "skip"; reason: string };

export type SettleUnpaidCheckoutDeps = {
  fulfil: typeof fulfilCreatorCheckout;
  loadOrder: typeof loadOrderForCheckout;
  stripe: typeof creatorStripeClient;
  keyLivemode: () => boolean;
  now: () => Date;
  log: typeof logEvent;
};

export const realSettleUnpaidCheckoutDeps: SettleUnpaidCheckoutDeps = {
  fulfil: fulfilCreatorCheckout,
  loadOrder: loadOrderForCheckout,
  stripe: creatorStripeClient,
  keyLivemode: () => platformKeyLivemode(),
  now: () => new Date(),
  log: logEvent,
};

export async function settleUnpaidCheckout(
  row: Pick<CreatorOrderStateRow, "id" | "tenant_id" | "source" | "status" | "livemode">,
  deps: SettleUnpaidCheckoutDeps = realSettleUnpaidCheckoutDeps,
  opts: { expireOpen?: boolean } = {},
): Promise<SettleUnpaidCheckoutResult> {
  const now = deps.now().getTime();

  const keyLive = deps.keyLivemode();
  if (row.livemode !== keyLive) {
    return row.livemode ? { action: "skip", reason: "live_order_test_key" } : { action: "close" };
  }

  const fulfilled = await deps.fulfil({ tenant_id: row.tenant_id, order_id: row.id });
  if (fulfilled.state === "needs_staff") {
    return { action: "wait", until: new Date(now + 24 * RECHECK_MS).toISOString(), reason: "needs_staff" };
  }
  if (fulfilled.state !== "pending") return { action: "settled", state: fulfilled.state };
  if (fulfilled.reason === "brief_held") {
    return { action: "wait", until: new Date(now + RECHECK_MS).toISOString(), reason: "brief_held" };
  }

  const order = await deps.loadOrder(row.tenant_id, row.id);
  if (!order || order.status !== "checkout_pending") {
    return { action: "settled", state: order?.status ?? "gone" };
  }
  if (!order.stripe_checkout_session_id) return { action: "close" };

  const stripe = deps.stripe();
  const session = await stripe.checkout.sessions.retrieve(order.stripe_checkout_session_id);

  if (session.status === "expired") return { action: "close" };

  if (session.status === "complete") {
    await deps.log({
      level: "warn",
      source: "creator.checkout",
      code: "checkout_expiry_paid_not_held",
      tenant_id: row.tenant_id,
      meta: { creator_order_id: row.id },
    });
    return { action: "wait", until: new Date(now + RECHECK_MS).toISOString(), reason: "complete_not_held" };
  }

  if (row.source !== "offer" && opts.expireOpen !== true) {
    const expiresAt = typeof session.expires_at === "number" ? session.expires_at * 1000 : now;
    return {
      action: "wait",
      until: new Date(Math.max(expiresAt, now) + AFTER_SESSION_EXPIRY_MS).toISOString(),
      reason: "session_open",
    };
  }

  await stripe.checkout.sessions.expire(session.id);
  return { action: "close" };
}
