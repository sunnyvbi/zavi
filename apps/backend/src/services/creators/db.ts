
import {
  asTenantId,
  creatorOrderRpc,
  fleetSweepClient,
  globalClient,
  tenantClient,
} from "@/services/tenant-client";

export type CreatorOrderPayoutStatus =
  | "not_due"
  | "awaiting_payout_account"
  | "ready"
  | "transferring"
  | "transferred"
  | "reversed"
  | "not_applicable";

export type CreatorOrderMoneyRow = {
  id: string;
  tenant_id: string;
  human_member_id: string;
  livemode: boolean;
  currency: string;
  price_cents: number;
  business_fee_cents: number;
  creator_fee_cents: number;
  business_total_cents: number;
  creator_payout_cents: number;
  payout_amount_cents: number | null;
  status: string;
  payout_status: CreatorOrderPayoutStatus;
  stripe_checkout_session_id: string | null;
  stripe_payment_intent_id: string | null;
  stripe_transfer_id: string | null;
  hold_expires_at: string | null;
};

export type CreatorChargebackStatus = "open" | "won" | "lost";

export const NO_CHARGEBACK_HOLD = "or(chargeback_status.is.null,chargeback_status.eq.won)";

export const ORDER_MONEY_COLUMNS =
  "id,tenant_id,human_member_id,livemode,currency,price_cents,business_fee_cents,creator_fee_cents,business_total_cents,creator_payout_cents,payout_amount_cents,status,payout_status,stripe_checkout_session_id,stripe_payment_intent_id,stripe_transfer_id,hold_expires_at";

export type CreatorMoneyEventKind =
  | "hold"
  | "capture"
  | "cancel"
  | "refund"
  | "transfer"
  | "transfer_reversal"
  | "fee";

export type CreatorMoneyEventCause =
  | "booking"
  | "hire"
  | "creator_accept"
  | "approval"
  | "auto_accept_buffer"
  | "decline"
  | "expiry"
  | "withdrawn"
  | "checkout_abandoned"
  | "payment_failed"
  | "no_show"
  | "cancel_agreed"
  | "cancel_no_response"
  | "mediation"
  | "creator_removed";

export type CreatorMoneyEventInsert = {
  tenant_id: string;
  order_id: string;
  kind: CreatorMoneyEventKind;
  cause: CreatorMoneyEventCause;
  amount_cents: number;
  currency: string;
  livemode: boolean;
  stripe_object_id?: string | null;
  stripe_event_id?: string | null;
  idempotency_key: string;
  actor_kind: "tenant" | "creator" | "staff" | "system";
  actor_user_id?: string | null;
};

export type CreatorPayoutAccountRow = {
  id: string;
  human_member_id: string;
  stripe_account_id: string;
  livemode: boolean;
  country: string;
  details_submitted: boolean;
  payouts_enabled: boolean;
  disabled_reason: string | null;
};

const PAYOUT_ACCOUNT_COLUMNS =
  "id,human_member_id,stripe_account_id,livemode,country,details_submitted,payouts_enabled,disabled_reason";

const UNIQUE_VIOLATION = "23505";

export async function loadOrderForMoney(
  tenant_id: string,
  order_id: string,
): Promise<CreatorOrderMoneyRow | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("creator_orders")
    .select(ORDER_MONEY_COLUMNS)
    .eq("id", order_id)
    .maybeSingle();
  if (error) throw new Error(`loadOrderForMoney failed: ${error.message}`);
  return (data as CreatorOrderMoneyRow | null) ?? null;
}

export async function insertCreatorMoneyEvent(
  row: CreatorMoneyEventInsert,
): Promise<"inserted" | "duplicate"> {
  const { tenant_id, ...rest } = row;
  const { error } = await tenantClient(asTenantId(tenant_id))
    .from("creator_money_events")
    .insert({ ...rest });
  if (!error) return "inserted";
  if (error.code === UNIQUE_VIOLATION) return "duplicate";
  throw new Error(`insertCreatorMoneyEvent failed: ${error.message}`);
}

export async function findCreatorMoneyEvent(
  tenant_id: string,
  idempotency_key: string,
): Promise<{ amount_cents: number; stripe_object_id: string | null } | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("creator_money_events")
    .select("amount_cents,stripe_object_id")
    .eq("idempotency_key", idempotency_key)
    .maybeSingle();
  if (error) throw new Error(`findCreatorMoneyEvent failed: ${error.message}`);
  if (!data) return null;
  const row = data as { amount_cents: number | string; stripe_object_id: string | null };
  return { amount_cents: Number(row.amount_cents), stripe_object_id: row.stripe_object_id ?? null };
}

export async function claimOrderTransfer(
  order_id: string,
): Promise<CreatorOrderMoneyRow | null> {
  const { data, error } = await creatorOrderRpc("creator_claim_order_transfer", {
    p_order_id: order_id,
  }).maybeSingle();
  if (error) throw new Error(`claimOrderTransfer failed: ${error.message}`);
  const row = data as (CreatorOrderMoneyRow & { id: string | null }) | null;
  if (!row || !row.id) return null;
  return row;
}

export async function markOrderTransferred(args: {
  order_id: string;
  transfer_id: string;
  idempotency_key: string;
  cause: "approval" | "auto_accept_buffer" | "mediation";
}): Promise<number> {
  const { data, error } = await creatorOrderRpc("creator_mark_order_transferred", {
    p_order_id: args.order_id,
    p_transfer_id: args.transfer_id,
    p_idempotency_key: args.idempotency_key,
    p_cause: args.cause,
  });
  if (error) throw new Error(`markOrderTransferred failed: ${error.message}`);
  return Number(data);
}

export async function releaseOrderTransferClaim(order_id: string): Promise<number> {
  const { data, error } = await creatorOrderRpc("creator_release_order_transfer_claim", {
    p_order_id: order_id,
  });
  if (error) throw new Error(`releaseOrderTransferClaim failed: ${error.message}`);
  return Number(data);
}

const SWEEP_REASON = "creator stripe webhook: resolve the owning tenant of a Stripe object";

export type CreatorOrderRef = {
  id: string;
  tenant_id: string;
  human_member_id: string;
  livemode: boolean;
  source: string;
  status: string;
  closed_reason: string | null;
  payout_status: CreatorOrderPayoutStatus;
  payout_ready_at: string | null;
  stripe_payment_intent_id: string | null;
  stripe_transfer_id: string | null;
  chargeback_status?: CreatorChargebackStatus | null;
};

const ORDER_REF_COLUMNS =
  "id,tenant_id,human_member_id,livemode,source,status,closed_reason,payout_status,payout_ready_at,stripe_payment_intent_id,stripe_transfer_id,chargeback_status";

export async function resolveCreatorOrderById(order_id: string): Promise<CreatorOrderRef | null> {
  if (!/^[0-9a-f-]{36}$/i.test(order_id)) return null;
  const { data, error } = await fleetSweepClient(SWEEP_REASON)
    .from("creator_orders")
    .select(ORDER_REF_COLUMNS)
    .eq("id", order_id)
    .maybeSingle();
  if (error) throw new Error(`resolveCreatorOrderById failed: ${error.message}`);
  return (data as CreatorOrderRef | null) ?? null;
}

export async function resolveCreatorOrderByPaymentIntent(
  payment_intent_id: string,
): Promise<CreatorOrderRef | null> {
  if (!payment_intent_id) return null;
  const { data, error } = await fleetSweepClient(SWEEP_REASON)
    .from("creator_orders")
    .select(ORDER_REF_COLUMNS)
    .eq("stripe_payment_intent_id", payment_intent_id)
    .maybeSingle();
  if (error) throw new Error(`resolveCreatorOrderByPaymentIntent failed: ${error.message}`);
  return (data as CreatorOrderRef | null) ?? null;
}

export async function resolveCreatorOrderByTransfer(
  transfer_id: string,
): Promise<CreatorOrderRef | null> {
  if (!transfer_id) return null;
  const { data, error } = await fleetSweepClient(SWEEP_REASON)
    .from("creator_orders")
    .select(ORDER_REF_COLUMNS)
    .eq("stripe_transfer_id", transfer_id)
    .maybeSingle();
  if (error) throw new Error(`resolveCreatorOrderByTransfer failed: ${error.message}`);
  return (data as CreatorOrderRef | null) ?? null;
}

export async function listCreatorPayoutsAwaiting(
  human_member_id: string,
  livemode: boolean,
  limit: number,
): Promise<CreatorOrderRef[]> {
  const { data, error } = await fleetSweepClient(SWEEP_REASON)
    .from("creator_orders")
    .select(ORDER_REF_COLUMNS)
    .eq("human_member_id", human_member_id)
    .eq("livemode", livemode)
    .eq("status", "completed")
    .or(
      `and(payout_status.eq.awaiting_payout_account,${NO_CHARGEBACK_HOLD}),` +
        `and(payout_status.eq.ready,payout_ready_at.lte.${new Date().toISOString()},${NO_CHARGEBACK_HOLD})`,
    )
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(`listCreatorPayoutsAwaiting failed: ${error.message}`);
  return (data as CreatorOrderRef[] | null) ?? [];
}

export async function markCreatorPayoutReady(args: {
  tenant_id: string;
  order_id: string;
  payout_ready_at: string | null;
}): Promise<boolean> {
  const { data, error } = await tenantClient(asTenantId(args.tenant_id))
    .from("creator_orders")
    .update({
      payout_status: "ready",
      payout_ready_at: args.payout_ready_at ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", args.order_id)
    .eq("payout_status", "awaiting_payout_account")
    .select("id");
  if (error) throw new Error(`markCreatorPayoutReady failed: ${error.message}`);
  return ((data as { id: string }[] | null) ?? []).length === 1;
}

export async function writeCreatorOrderChargeback(args: {
  tenant_id: string;
  order_id: string;
  stripe_dispute_id: string;
  to: CreatorChargebackStatus;
}): Promise<boolean> {
  let q = tenantClient(asTenantId(args.tenant_id))
    .from("creator_orders")
    .update({
      chargeback_status: args.to,
      stripe_dispute_id: args.stripe_dispute_id,
      updated_at: new Date().toISOString(),
    })
    .eq("id", args.order_id);
  q = args.to === "open"
    ? q.is("chargeback_status", null)
    : q.or("chargeback_status.is.null,chargeback_status.eq.open");
  const { data, error } = await q.select("id");
  if (error) throw new Error(`writeCreatorOrderChargeback failed: ${error.message}`);
  return ((data as { id: string }[] | null) ?? []).length === 1;
}

export async function closeCreatorPayoutForChargeback(args: {
  tenant_id: string;
  order_id: string;
}): Promise<boolean> {
  const { data, error } = await tenantClient(asTenantId(args.tenant_id))
    .from("creator_orders")
    .update({ payout_status: "not_applicable", updated_at: new Date().toISOString() })
    .eq("id", args.order_id)
    .eq("chargeback_status", "lost")
    .in("payout_status", ["awaiting_payout_account", "ready"])
    .select("id");
  if (error) throw new Error(`closeCreatorPayoutForChargeback failed: ${error.message}`);
  return ((data as { id: string }[] | null) ?? []).length === 1;
}

export async function attachCreatorOrderPaymentIntent(args: {
  tenant_id: string;
  order_id: string;
  payment_intent_id: string;
  hold_expires_at: string | null;
}): Promise<boolean> {
  const { data, error } = await tenantClient(asTenantId(args.tenant_id))
    .from("creator_orders")
    .update({
      stripe_payment_intent_id: args.payment_intent_id,
      hold_expires_at: args.hold_expires_at,
      updated_at: new Date().toISOString(),
    })
    .eq("id", args.order_id)
    .is("stripe_payment_intent_id", null)
    .select("id");
  if (error) {
    if (error.code === UNIQUE_VIOLATION) return false;
    throw new Error(`attachCreatorOrderPaymentIntent failed: ${error.message}`);
  }
  return ((data as { id: string }[] | null) ?? []).length === 1;
}

export async function loadCreatorPayoutAccount(
  human_member_id: string,
  livemode: boolean,
): Promise<CreatorPayoutAccountRow | null> {
  const { data, error } = await globalClient()
    .from("creator_payout_accounts")
    .select(PAYOUT_ACCOUNT_COLUMNS)
    .eq("human_member_id", human_member_id)
    .eq("livemode", livemode)
    .maybeSingle();
  if (error) throw new Error(`loadCreatorPayoutAccount failed: ${error.message}`);
  return (data as CreatorPayoutAccountRow | null) ?? null;
}

export async function loadCreatorPayoutAccountByStripeId(
  stripe_account_id: string,
): Promise<CreatorPayoutAccountRow | null> {
  if (!/^acct_[A-Za-z0-9]+$/.test(stripe_account_id)) return null;
  const { data, error } = await globalClient()
    .from("creator_payout_accounts")
    .select(PAYOUT_ACCOUNT_COLUMNS)
    .eq("stripe_account_id", stripe_account_id)
    .maybeSingle();
  if (error) throw new Error(`loadCreatorPayoutAccountByStripeId failed: ${error.message}`);
  return (data as CreatorPayoutAccountRow | null) ?? null;
}

export async function insertCreatorPayoutAccount(row: {
  human_member_id: string;
  stripe_account_id: string;
  livemode: boolean;
  country: string;
  details_submitted: boolean;
  payouts_enabled: boolean;
}): Promise<"inserted" | "duplicate"> {
  const { error } = await globalClient().from("creator_payout_accounts").insert(row);
  if (!error) return "inserted";
  if (error.code === UNIQUE_VIOLATION) return "duplicate";
  throw new Error(`insertCreatorPayoutAccount failed: ${error.message}`);
}

export async function updateCreatorPayoutAccountFlags(args: {
  stripe_account_id: string;
  details_submitted: boolean;
  payouts_enabled: boolean;
  disabled_reason: string | null;
  country?: string | null;
  keepDisconnected?: boolean;
}): Promise<void> {
  const country =
    typeof args.country === "string" && /^[A-Za-z]{2}$/.test(args.country.trim())
      ? args.country.trim().toUpperCase()
      : null;
  let q = globalClient()
    .from("creator_payout_accounts")
    .update({
      details_submitted: args.details_submitted,
      payouts_enabled: args.payouts_enabled,
      disabled_reason: args.disabled_reason,
      ...(country ? { country } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("stripe_account_id", args.stripe_account_id);
  if (args.keepDisconnected) q = q.or("disabled_reason.is.null,disabled_reason.neq.deauthorized");
  const { error } = await q;
  if (error) throw new Error(`updateCreatorPayoutAccountFlags failed: ${error.message}`);
}
