
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";

export type CreatorHireRefusal = "no_budget" | "no_caps" | "over_hire_cap" | "over_week_cap" | "over_budget";

export type CreatorHireReserve =
  | { status: "reserved"; amount_usd: number; left_usd: number }
  | { status: "already_held"; amount_usd: number; state: "held" | "spent" | "refunded" }
  | { status: CreatorHireRefusal; amount_usd: number }
  | { status: "unavailable"; error: string };

export type CreatorHireSettle =
  | { status: "spent" | "released" | "refunded"; changed: boolean }
  | { status: "not_found" }
  | { status: "unavailable"; error: string };

export type CreatorHireRefund =
  | { status: "refunded" | "partially_refunded"; refunded_usd: number }
  | { status: "not_found" }
  | { status: "unavailable"; error: string };

export type CreatorCapsRecord = { status: "recorded"; id: string } | { status: "unavailable"; error: string };

export function creatorHireIdemKey(order_id: string): string {
  return `creator-hire:${order_id}`;
}

const REFUSALS: ReadonlySet<string> = new Set(["no_budget", "no_caps", "over_hire_cap", "over_week_cap", "over_budget"]);

const num = (v: unknown): number => (v === null || v === undefined ? NaN : Number(v));

async function call(tenant_id: string, name: string, args: Record<string, unknown>): Promise<{ data: unknown } | { error: string }> {
  try {
    const r = await tenantRpc(asTenantId(tenant_id), name, args);
    if (r.error) throw new Error(r.error.message);
    return { data: r.data };
  } catch (e) {
    console.error(`[creator-hire-budget] ${name} failed for tenant ${tenant_id}: ${(e as Error).message}`);
    return { error: `${name} failed: ${(e as Error).message}` };
  }
}

export async function reserveCreatorHire(
  tenant_id: string,
  a: {
    order_id: string;
    amount_usd: number;
    caps_id: string;
    channel_action_id?: string | null;
    approved_by_user_id?: string | null;
  },
): Promise<CreatorHireReserve> {
  if (!Number.isFinite(a.amount_usd) || a.amount_usd <= 0) {
    return { status: "unavailable", error: "invalid_amount" };
  }
  const r = await call(tenant_id, "reserve_creator_hire", {
    p_idem_key: creatorHireIdemKey(a.order_id),
    p_order_id: a.order_id,
    p_amount_usd: a.amount_usd,
    p_caps_id: a.caps_id,
    ...(a.channel_action_id ? { p_channel_action_id: a.channel_action_id } : {}),
    ...(a.approved_by_user_id ? { p_approved_by_user_id: a.approved_by_user_id } : {}),
  });
  if ("error" in r) return { status: "unavailable", error: r.error };
  const ans = (r.data ?? {}) as { status?: string; amount_usd?: unknown; left_usd?: unknown; state?: unknown };
  const amount = num(ans.amount_usd);
  if (ans.status === "reserved" && Number.isFinite(amount) && Number.isFinite(num(ans.left_usd))) {
    return { status: "reserved", amount_usd: amount, left_usd: num(ans.left_usd) };
  }
  if (
    ans.status === "already_held" &&
    Number.isFinite(amount) &&
    (ans.state === "held" || ans.state === "spent" || ans.state === "refunded")
  ) {
    return { status: "already_held", amount_usd: amount, state: ans.state };
  }
  if (typeof ans.status === "string" && REFUSALS.has(ans.status)) {
    return { status: ans.status as CreatorHireRefusal, amount_usd: Number.isFinite(amount) ? amount : 0 };
  }
  console.error(`[creator-hire-budget] reserve_creator_hire returned an unknown answer for order ${a.order_id}; refusing`);
  return { status: "unavailable", error: "reserve_creator_hire: answer not understood" };
}

export async function settleCreatorHire(
  tenant_id: string,
  order_id: string,
  outcome: "spent" | "released",
): Promise<CreatorHireSettle> {
  const r = await call(tenant_id, "settle_creator_hire", { p_idem_key: creatorHireIdemKey(order_id), p_outcome: outcome });
  if ("error" in r) return { status: "unavailable", error: r.error };
  const ans = (r.data ?? {}) as { status?: string; changed?: unknown };
  if (ans.status === "not_found") return { status: "not_found" };
  if ((ans.status === "spent" || ans.status === "released" || ans.status === "refunded") && typeof ans.changed === "boolean") {
    return { status: ans.status, changed: ans.changed };
  }
  return { status: "unavailable", error: "settle_creator_hire: answer not understood" };
}

export async function refundCreatorHire(tenant_id: string, order_id: string, refunded_usd: number): Promise<CreatorHireRefund> {
  if (!Number.isFinite(refunded_usd) || refunded_usd <= 0) return { status: "unavailable", error: "invalid_amount" };
  const r = await call(tenant_id, "refund_creator_hire", { p_order_id: order_id, p_amount_usd: refunded_usd });
  if ("error" in r) return { status: "unavailable", error: r.error };
  const ans = (r.data ?? {}) as { status?: string; refunded_usd?: unknown };
  if (ans.status === "not_found") return { status: "not_found" };
  if ((ans.status === "refunded" || ans.status === "partially_refunded") && Number.isFinite(num(ans.refunded_usd))) {
    return { status: ans.status, refunded_usd: num(ans.refunded_usd) };
  }
  return { status: "unavailable", error: "refund_creator_hire: answer not understood" };
}

export async function recordCreatorCaps(
  tenant_id: string,
  caps: { per_hire_usd: number; per_week_usd: number; why: string; run_id: string | null },
): Promise<CreatorCapsRecord> {
  const r = await call(tenant_id, "record_cgo_creator_caps", {
    p_per_hire_usd: caps.per_hire_usd,
    p_per_week_usd: caps.per_week_usd,
    p_why: caps.why,
    p_run_id: caps.run_id,
  });
  if ("error" in r) return { status: "unavailable", error: r.error };
  const ans = (r.data ?? {}) as { status?: string; id?: unknown };
  if (ans.status === "recorded" && typeof ans.id === "string") return { status: "recorded", id: ans.id };
  return { status: "unavailable", error: "record_cgo_creator_caps: answer not understood" };
}

export async function latestCreatorCaps(tenant_id: string): Promise<{ id: string; per_hire_usd: number; per_week_usd: number } | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("cgo_creator_caps")
    .select("id, per_hire_usd, per_week_usd, created_at")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`cgo_creator_caps read failed: ${error.message}`);
  const row = data as { id?: unknown; per_hire_usd?: unknown; per_week_usd?: unknown } | null;
  if (!row || typeof row.id !== "string") return null;
  const per_hire_usd = num(row.per_hire_usd);
  const per_week_usd = num(row.per_week_usd);
  if (!Number.isFinite(per_hire_usd) || per_hire_usd <= 0 || !Number.isFinite(per_week_usd) || per_week_usd <= 0) return null;
  return { id: row.id, per_hire_usd, per_week_usd };
}
