
import {
  asTenantId,
  creatorOrderRpc,
  creatorTimerClient,
  globalClient,
  tenantClient,
} from "@/services/tenant-client";
import type {
  CreatorOrderClosedReason,
  CreatorOrderSource,
  CreatorOrderStatus,
} from "./order-state";
import type { DeadlineKind } from "./deadline-copy";

export type CreatorOrderStateRow = {
  id: string;
  tenant_id: string;
  human_member_id: string;
  source: CreatorOrderSource;
  status: CreatorOrderStatus;
  closed_reason: CreatorOrderClosedReason | null;
  created_at: string;
  due_at: string | null;
  extension_requested_due_at: string | null;
  extension_state: "requested" | "approved" | "declined" | null;
  next_deadline_at: string | null;
  next_deadline_kind: DeadlineKind | null;
  responded_at: string | null;
  accepted_at: string | null;
  cancel_requested_at: string | null;
  status_before_cancel_request: CreatorOrderStatus | null;
  closed_at: string | null;
  payout_status: string;
  payout_ready_at: string | null;
  payout_amount_cents: number | null;
  price_cents: number;
  business_fee_cents: number;
  creator_fee_cents: number;
  business_total_cents: number;
  creator_payout_cents: number;
  package_snapshot: Record<string, unknown> | null;
  livemode: boolean;
  product_needed?: boolean;
  product_received_at?: string | null;
  brief_id?: string | null;
  application_id?: string | null;
};

export const ORDER_STATE_COLUMNS =
  "id,tenant_id,human_member_id,source,status,closed_reason,created_at,due_at," +
  "extension_requested_due_at,extension_state,next_deadline_at,next_deadline_kind," +
  "responded_at,accepted_at,cancel_requested_at,status_before_cancel_request,closed_at,payout_status,payout_ready_at," +
  "payout_amount_cents,price_cents,business_fee_cents,creator_fee_cents," +
  "business_total_cents,creator_payout_cents,package_snapshot,livemode," +
  "product_needed,product_received_at,brief_id,application_id";

export async function loadOrderForState(
  tenant_id: string,
  order_id: string,
): Promise<CreatorOrderStateRow | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("creator_orders")
    .select(ORDER_STATE_COLUMNS)
    .eq("id", order_id)
    .maybeSingle();
  if (error) throw new Error(`loadOrderForState failed: ${error.message}`);
  return (data as CreatorOrderStateRow | null) ?? null;
}

export type CreatorOrderStatePatch = {
  status?: CreatorOrderStatus;
  closed_reason?: CreatorOrderClosedReason | null;
  closed_at?: string | null;
  responded_at?: string;
  accepted_at?: string;
  cancel_requested_at?: string | null;
  status_before_cancel_request?: CreatorOrderStatus | null;
  due_at?: string | null;
  extension_state?: "requested" | "approved" | "declined" | null;
  extension_requested_due_at?: string | null;
  payout_status?: string;
  payout_ready_at?: string | null;
  payout_amount_cents?: number | null;
  next_deadline_at?: string | null;
  next_deadline_kind?: DeadlineKind | null;
  product_received_at?: string;
  lease_until?: null;
};

export async function writeOrderState(args: {
  tenant_id: string;
  order_id: string;
  expected_status: CreatorOrderStatus;
  expected_payout_status?: string;
  patch: CreatorOrderStatePatch;
}): Promise<CreatorOrderStateRow | null> {
  let q = tenantClient(asTenantId(args.tenant_id))
    .from("creator_orders")
    .update({ ...args.patch, updated_at: new Date().toISOString() })
    .eq("id", args.order_id)
    .eq("status", args.expected_status);
  if (args.expected_payout_status !== undefined) q = q.eq("payout_status", args.expected_payout_status);
  const { data, error } = await q.select(ORDER_STATE_COLUMNS).maybeSingle();
  if (error) throw new Error(`writeOrderState failed: ${error.message}`);
  return (data as CreatorOrderStateRow | null) ?? null;
}

export async function latestSubmissionAt(
  tenant_id: string,
  order_id: string,
): Promise<string | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("creator_submissions")
    .select("created_at")
    .eq("order_id", order_id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`latestSubmissionAt failed: ${error.message}`);
  return (data as { created_at: string } | null)?.created_at ?? null;
}

export async function submissionRounds(tenant_id: string, order_id: string): Promise<number> {
  const PAGE = 1000;
  const versions = new Set<number | undefined>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await tenantClient(asTenantId(tenant_id))
      .from("creator_submissions")
      .select("version")
      .eq("order_id", order_id)
      .order("version", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`submissionRounds failed: ${error.message}`);
    const rows = (data as { version?: number }[] | null) ?? [];
    for (const r of rows) versions.add(r.version);
    if (rows.length < PAGE) break;
  }
  return versions.size;
}

export type CreatorDisputeOpen = {
  kind: "step_in" | "cancel_dispute";
  opened_by: "tenant" | "creator";
  opened_by_user_id?: string | null;
  reason: string;
};

export async function openCreatorDispute(args: {
  tenant_id: string;
  order_id: string;
  dispute: CreatorDisputeOpen;
}): Promise<"opened" | "already_open"> {
  const { error } = await tenantClient(asTenantId(args.tenant_id))
    .from("creator_disputes")
    .insert({
      order_id: args.order_id,
      kind: args.dispute.kind,
      opened_by: args.dispute.opened_by,
      opened_by_user_id: args.dispute.opened_by_user_id ?? null,
      reason: args.dispute.reason,
    });
  if (!error) return "opened";
  if (error.code === "23505") return "already_open";
  throw new Error(`openCreatorDispute failed: ${error.message}`);
}

export async function resolveCreatorDispute(args: {
  tenant_id: string;
  order_id: string;
  outcome: "pay_full" | "pay_part" | "refund";
  creator_amount_cents?: number | null;
  refund_amount_cents?: number | null;
  resolved_by_staff_id?: string | null;
  resolution_note?: string | null;
}): Promise<number> {
  const { data, error } = await tenantClient(asTenantId(args.tenant_id))
    .from("creator_disputes")
    .update({
      status: "resolved",
      outcome: args.outcome,
      creator_amount_cents: args.creator_amount_cents ?? null,
      refund_amount_cents: args.refund_amount_cents ?? null,
      resolved_at: new Date().toISOString(),
      resolved_by_staff_id: args.resolved_by_staff_id ?? null,
      resolution_note: args.resolution_note ?? null,
    })
    .eq("order_id", args.order_id)
    .eq("status", "open")
    .select("id");
  if (error) throw new Error(`resolveCreatorDispute failed: ${error.message}`);
  return (data as unknown[] | null)?.length ?? 0;
}

export async function openCreatorHelpRequest(
  tenant_id: string,
  order_id: string,
): Promise<{ reason: string; opened_at: string } | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("creator_disputes")
    .select("reason, created_at, opened_by")
    .eq("order_id", order_id)
    .eq("status", "open")
    .eq("kind", "step_in")
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`openCreatorHelpRequest failed: ${error.message}`);
  const row = ((data ?? []) as Array<{ reason: string; created_at: string; opened_by: string }>)[0];
  return row && row.opened_by === "creator" ? { reason: row.reason, opened_at: row.created_at } : null;
}

export async function discardOpenCreatorDispute(args: { tenant_id: string; order_id: string }): Promise<number> {
  const { data, error } = await tenantClient(asTenantId(args.tenant_id))
    .from("creator_disputes")
    .delete()
    .eq("order_id", args.order_id)
    .eq("status", "open")
    .select("id");
  if (error) throw new Error(`discardOpenCreatorDispute failed: ${error.message}`);
  return (data as unknown[] | null)?.length ?? 0;
}

export async function hasOpenCreatorDispute(
  tenant_id: string,
  order_id: string,
): Promise<boolean> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("creator_disputes")
    .select("id")
    .eq("order_id", order_id)
    .eq("status", "open")
    .limit(1);
  if (error) throw new Error(`hasOpenCreatorDispute failed: ${error.message}`);
  return ((data as unknown[] | null)?.length ?? 0) > 0;
}

export async function markMissedDeadline(human_member_id: string): Promise<number> {
  const sb = globalClient();
  const { data, error } = await sb
    .from("human_members")
    .select("missed_deadline_count")
    .eq("id", human_member_id)
    .maybeSingle();
  if (error) throw new Error(`markMissedDeadline read failed: ${error.message}`);
  const next = Number((data as { missed_deadline_count: number | null } | null)?.missed_deadline_count ?? 0) + 1;
  const { error: upErr } = await sb
    .from("human_members")
    .update({ missed_deadline_count: next })
    .eq("id", human_member_id);
  if (upErr) throw new Error(`markMissedDeadline write failed: ${upErr.message}`);
  return next;
}

export async function claimDueOrderDeadlines(limit: number): Promise<CreatorOrderStateRow[]> {
  const { data, error } = await creatorOrderRpc("creator_claim_due_order_deadlines", {
    p_limit: limit,
  });
  if (error) throw new Error(`claimDueOrderDeadlines failed: ${error.message}`);
  return (data ?? []) as CreatorOrderStateRow[];
}

export async function claimOrderDeadline(order_id: string): Promise<CreatorOrderStateRow | null> {
  const { data, error } = await creatorOrderRpc("creator_claim_order_deadline", {
    p_order_id: order_id,
  });
  if (error) throw new Error(`claimOrderDeadline failed: ${error.message}`);
  return ((data ?? []) as CreatorOrderStateRow[])[0] ?? null;
}

export async function releaseOrderDeadlineLease(order_id: string): Promise<number> {
  const { data, error } = await creatorOrderRpc("creator_release_order_deadline_lease", {
    p_order_id: order_id,
  });
  if (error) throw new Error(`releaseOrderDeadlineLease failed: ${error.message}`);
  return Number(data);
}

export async function resolveCreatorOrderTenant(order_id: string): Promise<string | null> {
  const sb = creatorTimerClient("creator deadline timer re-derives the tenant from the order row");
  const { data, error } = await sb
    .from("creator_orders")
    .select("tenant_id")
    .eq("id", order_id)
    .maybeSingle();
  if (error) throw new Error(`resolveCreatorOrderTenant failed: ${error.message}`);
  return (data as { tenant_id: string } | null)?.tenant_id ?? null;
}

export async function listDuePayoutOrders(limit: number): Promise<
  { id: string; tenant_id: string; human_member_id: string }[]
> {
  const sb = creatorTimerClient("creator payout buffer sweep reads due payouts across tenants");
  const { data: open, error: openError } = await sb
    .from("creator_disputes")
    .select("order_id")
    .eq("status", "open");
  if (openError) throw new Error(`listDuePayoutOrders failed: ${openError.message}`);
  const disputed = new Set(((open ?? []) as { order_id: string }[]).map((d) => d.order_id));
  const { data, error } = await sb
    .from("creator_orders")
    .select("id,tenant_id,human_member_id")
    .eq("status", "completed")
    .eq("payout_status", "ready")
    .lte("payout_ready_at", new Date().toISOString())
    .or("chargeback_status.is.null,chargeback_status.eq.won")
    .order("payout_ready_at", { ascending: true })
    .limit(limit + disputed.size);
  if (error) throw new Error(`listDuePayoutOrders failed: ${error.message}`);
  return ((data ?? []) as { id: string; tenant_id: string; human_member_id: string }[])
    .filter((o) => !disputed.has(o.id))
    .slice(0, limit);
}
