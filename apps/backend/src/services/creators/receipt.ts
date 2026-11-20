
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { creatorStripeClient, platformKeyLivemode } from "./client";
import type { CreatorChargebackStatus } from "./db";

export type CreatorJobReceipt = {
  currency: string;
  price_cents: number;
  business_fee_cents: number;
  business_total_cents: number;
  refunded_cents: number;
  paid_at: string;
  receipt_url: string | null;
  chargeback_status: CreatorChargebackStatus | null;
};

type ReceiptOrderRow = {
  id: string;
  currency: string;
  price_cents: number;
  business_fee_cents: number;
  business_total_cents: number;
  livemode: boolean;
  stripe_payment_intent_id: string | null;
  chargeback_status: CreatorChargebackStatus | null;
};

export type ReceiptDeps = {
  receiptUrl: (payment_intent_id: string, livemode: boolean) => Promise<string | null>;
};

export const realReceiptDeps: ReceiptDeps = {
  receiptUrl: async (payment_intent_id, livemode) => {
    if (livemode !== platformKeyLivemode()) return null;
    const pi = await creatorStripeClient().paymentIntents.retrieve(payment_intent_id, {
      expand: ["latest_charge"],
    });
    const charge = pi.latest_charge;
    return charge && typeof charge === "object" ? charge.receipt_url ?? null : null;
  },
};

export async function loadCreatorJobReceipt(
  tenant_id: string,
  order_id: string,
  deps: ReceiptDeps = realReceiptDeps,
): Promise<CreatorJobReceipt | null> {
  const db = tenantClient(asTenantId(tenant_id));
  const { data: orderData, error: orderError } = await db
    .from("creator_orders")
    .select(
      "id,currency,price_cents,business_fee_cents,business_total_cents,livemode,stripe_payment_intent_id,chargeback_status",
    )
    .eq("id", order_id)
    .maybeSingle();
  if (orderError) throw new Error(`receipt order read failed: ${orderError.message}`);
  const order = orderData as ReceiptOrderRow | null;
  if (!order) return null;

  const { data: events, error: eventsError } = await db
    .from("creator_money_events")
    .select("kind, amount_cents, created_at")
    .eq("order_id", order_id)
    .in("kind", ["capture", "refund"])
    .order("created_at", { ascending: true });
  if (eventsError) throw new Error(`receipt ledger read failed: ${eventsError.message}`);
  const rows = (events ?? []) as { kind: string; amount_cents: number; created_at: string }[];
  const capture = rows.find((r) => r.kind === "capture");
  if (!capture) return null;
  const refunded_cents = rows.filter((r) => r.kind === "refund").reduce((sum, r) => sum + Number(r.amount_cents), 0);

  const receipt_url = order.stripe_payment_intent_id
    ? await deps.receiptUrl(order.stripe_payment_intent_id, order.livemode).catch(() => null)
    : null;

  return {
    currency: order.currency,
    price_cents: order.price_cents,
    business_fee_cents: order.business_fee_cents,
    business_total_cents: order.business_total_cents,
    refunded_cents: Math.min(refunded_cents, order.business_total_cents),
    paid_at: capture.created_at,
    receipt_url,
    chargeback_status: order.chargeback_status ?? null,
  };
}
