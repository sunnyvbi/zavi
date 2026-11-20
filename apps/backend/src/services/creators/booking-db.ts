
import { asTenantId, globalClient, tenantClient } from "@/services/tenant-client";
import { ORDER_STATE_COLUMNS, type CreatorOrderStateRow } from "./orders-db";
import { offerPayableUntil, type CreatorOrderDeadline } from "./deadlines";
import { PAID_ORDER_FILTER } from "./order-state";

export type BookableCreator = {
  id: string;
  display_name: string;
  slug: string | null;
  city: string | null;
  country_code: string | null;
  vetting_state: string;
};

const CREATOR_COLUMNS = "id,display_name,slug,city,country_code,vetting_state";

export async function loadBookableCreator(
  human_member_id: string,
): Promise<BookableCreator | null> {
  const { data, error } = await globalClient()
    .from("human_members")
    .select(CREATOR_COLUMNS)
    .eq("id", human_member_id)
    .maybeSingle();
  if (error) throw new Error(`loadBookableCreator failed: ${error.message}`);
  return (data as BookableCreator | null) ?? null;
}

export type BookablePackage = {
  id: string;
  human_member_id: string;
  kind: string;
  title: string;
  description: string | null;
  price_cents: number;
  currency: string;
  delivery_days: number;
  video_count: number | null;
  video_length_seconds: number | null;
  ad_rights_days: number | null;
  addons: unknown;
  active: boolean;
};

const PACKAGE_COLUMNS =
  "id,human_member_id,kind,title,description,price_cents,currency,delivery_days," +
  "video_count,video_length_seconds,ad_rights_days,addons,active";

export async function loadBookablePackage(package_id: string): Promise<BookablePackage | null> {
  const { data, error } = await globalClient()
    .from("creator_packages")
    .select(PACKAGE_COLUMNS)
    .eq("id", package_id)
    .maybeSingle();
  if (error) throw new Error(`loadBookablePackage failed: ${error.message}`);
  return (data as BookablePackage | null) ?? null;
}

export type BookableOffer = {
  id: string;
  tenant_id: string;
  human_member_id: string;
  thread_id: string | null;
  proposed_by: "tenant" | "creator";
  kind: string;
  terms: Record<string, unknown>;
  price_cents: number;
  currency: string;
  delivery_days: number;
  note: string | null;
  status: "open" | "accepted" | "declined" | "expired" | "withdrawn";
  expires_at: string;
  product_needed?: boolean;
  agent_run_id?: string | null;
};

const OFFER_COLUMNS =
  "id,tenant_id,human_member_id,thread_id,proposed_by,kind,terms,price_cents," +
  "currency,delivery_days,note,status,expires_at,product_needed,agent_run_id";

export function offerTitle(offer: Pick<BookableOffer, "terms">): string {
  const t = offer.terms?.["title"];
  if (typeof t === "string" && t.trim()) return t.trim();
  return "Custom video";
}

export async function loadBookableOffer(
  tenant_id: string,
  offer_id: string,
): Promise<BookableOffer | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("creator_offers")
    .select(OFFER_COLUMNS)
    .eq("id", offer_id)
    .maybeSingle();
  if (error) throw new Error(`loadBookableOffer failed: ${error.message}`);
  return (data as BookableOffer | null) ?? null;
}

export async function markOfferAccepted(tenant_id: string, offer_id: string): Promise<boolean> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("creator_offers")
    .update({ status: "accepted", responded_at: new Date().toISOString() })
    .eq("id", offer_id)
    .eq("status", "open")
    .select("id")
    .maybeSingle();
  if (error) throw new Error(`markOfferAccepted failed: ${error.message}`);
  return data != null;
}

export type HireableApplication = {
  id: string;
  tenant_id: string;
  brief_id: string;
  human_member_id: string;
  status: string;
  quoted_rate_usd: number | null;
  pitch: string | null;
};

export async function loadHireableApplication(
  tenant_id: string,
  application_id: string,
): Promise<HireableApplication | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("brief_applications")
    .select("id,tenant_id,brief_id,human_member_id,status,quoted_rate_usd,pitch")
    .eq("id", application_id)
    .maybeSingle();
  if (error) throw new Error(`loadHireableApplication failed: ${error.message}`);
  return (data as HireableApplication | null) ?? null;
}

export type HireableBrief = {
  id: string;
  title: string;
  angle: string | null;
  hook: string | null;
  format: string | null;
  lane: string | null;
  delivery_days: number | null;
  deliverables: number | null;
  utm_campaign: string | null;
  answer_by: string | null;
  product_needed?: boolean;
  ad_rights_days?: number | null;
};

export async function loadBriefForHire(
  tenant_id: string,
  brief_id: string,
): Promise<HireableBrief | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("creator_briefs")
    .select("id,title,angle,hook,format,lane,delivery_days,deliverables,utm_campaign,answer_by,product_needed,ad_rights_days")
    .eq("id", brief_id)
    .maybeSingle();
  if (error) throw new Error(`loadBriefForHire failed: ${error.message}`);
  return (data as HireableBrief | null) ?? null;
}

export type CreatorOrderInsert = {
  tenant_id: string;
  human_member_id: string;
  source: "booking" | "offer" | "applicant";
  package_id?: string | null;
  offer_id?: string | null;
  application_id?: string | null;
  brief_id?: string | null;
  thread_id?: string | null;
  booked_by_user_id: string | null;
  package_snapshot: Record<string, unknown>;
  brief_snapshot?: Record<string, unknown> | null;
  price_cents: number;
  business_fee_cents: number;
  creator_fee_cents: number;
  due_at: string | null;
  product_needed?: boolean;
  livemode: boolean;
  checkout_deadline?: CreatorOrderDeadline;
  agent_run_id?: string | null;
};

export type InsertOrderResult =
  | { ok: true; order: CreatorOrderStateRow }
  | { ok: false; code: "duplicate"; existing: CreatorOrderStateRow | null };

export async function insertCreatorOrder(row: CreatorOrderInsert): Promise<InsertOrderResult> {
  const { data, error } = await tenantClient(asTenantId(row.tenant_id))
    .from("creator_orders")
    .insert({
      human_member_id: row.human_member_id,
      source: row.source,
      package_id: row.package_id ?? null,
      offer_id: row.offer_id ?? null,
      application_id: row.application_id ?? null,
      brief_id: row.brief_id ?? null,
      thread_id: row.thread_id ?? null,
      booked_by_user_id: row.booked_by_user_id,
      package_snapshot: row.package_snapshot,
      brief_snapshot: row.brief_snapshot ?? null,
      price_cents: row.price_cents,
      business_fee_cents: row.business_fee_cents,
      creator_fee_cents: row.creator_fee_cents,
      due_at: row.due_at,
      product_needed: row.product_needed === true,
      livemode: row.livemode,
      next_deadline_at: row.checkout_deadline?.deadline_at ?? null,
      next_deadline_kind: row.checkout_deadline?.kind ?? null,
      agent_run_id: row.agent_run_id ?? null,
    })
    .select(ORDER_STATE_COLUMNS)
    .maybeSingle();

  if (error) {
    if (error.code === "23505") {
      const existing = row.application_id
        ? await findOrderByApplication(row.tenant_id, row.application_id)
        : row.offer_id
          ? await findOrderByOffer(row.tenant_id, row.offer_id)
          : row.source === "booking" && row.package_id
            ? await findPendingBooking({
                tenant_id: row.tenant_id,
                human_member_id: row.human_member_id,
                package_id: row.package_id,
                booked_by_user_id: row.booked_by_user_id,
              })
            : null;
      return { ok: false, code: "duplicate", existing };
    }
    throw new Error(`insertCreatorOrder failed: ${error.message}`);
  }
  return { ok: true, order: data as unknown as CreatorOrderStateRow };
}

export async function findOrderByApplication(
  tenant_id: string,
  application_id: string,
): Promise<CreatorOrderStateRow | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("creator_orders")
    .select(ORDER_STATE_COLUMNS)
    .eq("application_id", application_id)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`findOrderByApplication failed: ${error.message}`);
  const rows = (data ?? []) as unknown as CreatorOrderStateRow[];
  return rows.find((r) => r.status !== "cancelled") ?? rows[0] ?? null;
}

export async function listOrdersByApplication(
  tenant_id: string,
  application_ids: string[],
): Promise<Map<string, { status: string; closed_reason: string | null }>> {
  const out = new Map<string, { status: string; closed_reason: string | null }>();
  if (application_ids.length === 0) return out;
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("creator_orders")
    .select("application_id, status, closed_reason")
    .in("application_id", application_ids)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`listOrdersByApplication failed: ${error.message}`);
  for (const r of (data ?? []) as { application_id: string; status: string; closed_reason: string | null }[]) {
    const prior = out.get(r.application_id);
    if (prior && prior.status !== "cancelled" && r.status === "cancelled") continue;
    out.set(r.application_id, { status: r.status, closed_reason: r.closed_reason });
  }
  return out;
}

export async function findPendingBooking(args: {
  tenant_id: string;
  human_member_id: string;
  package_id: string;
  booked_by_user_id: string | null;
}): Promise<(CreatorOrderStateRow & { brief_id: string | null }) | null> {
  const base = tenantClient(asTenantId(args.tenant_id))
    .from("creator_orders")
    .select(ORDER_STATE_COLUMNS)
    .eq("source", "booking")
    .eq("status", "checkout_pending")
    .eq("human_member_id", args.human_member_id)
    .eq("package_id", args.package_id);
  const { data, error } = await (args.booked_by_user_id
    ? base.eq("booked_by_user_id", args.booked_by_user_id)
    : base.is("booked_by_user_id", null)
  )
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`findPendingBooking failed: ${error.message}`);
  return (data as unknown as (CreatorOrderStateRow & { brief_id: string | null }) | null) ?? null;
}

export async function refreshPendingBooking(args: {
  tenant_id: string;
  order_id: string;
  brief_snapshot: unknown;
  due_at: string | null;
}): Promise<CreatorOrderStateRow | null> {
  const { data, error } = await tenantClient(asTenantId(args.tenant_id))
    .from("creator_orders")
    .update({ brief_snapshot: args.brief_snapshot ?? null, due_at: args.due_at, updated_at: new Date().toISOString() })
    .eq("id", args.order_id)
    .eq("status", "checkout_pending")
    .select(ORDER_STATE_COLUMNS)
    .maybeSingle();
  if (error) throw new Error(`refreshPendingBooking failed: ${error.message}`);
  return (data as unknown as CreatorOrderStateRow | null) ?? null;
}

export async function findOrderByOffer(
  tenant_id: string,
  offer_id: string,
): Promise<CreatorOrderStateRow | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("creator_orders")
    .select(ORDER_STATE_COLUMNS)
    .eq("offer_id", offer_id)
    .maybeSingle();
  if (error) throw new Error(`findOrderByOffer failed: ${error.message}`);
  return (data as unknown as CreatorOrderStateRow | null) ?? null;
}

export type CreatorOrderCheckoutRow = {
  id: string;
  tenant_id: string;
  human_member_id: string;
  source: "booking" | "offer" | "applicant";
  status: string;
  booked_by_user_id: string | null;
  business_total_cents: number;
  currency: string;
  livemode: boolean;
  stripe_checkout_session_id: string | null;
  stripe_payment_intent_id: string | null;
  hold_expires_at: string | null;
  package_snapshot: Record<string, unknown> | null;
  brief_id?: string | null;
  application_id?: string | null;
  offer_id?: string | null;
  agent_run_id?: string | null;
  next_deadline_at?: string | null;
};

const CHECKOUT_COLUMNS =
  "id,tenant_id,human_member_id,source,status,booked_by_user_id,business_total_cents," +
  "currency,livemode,stripe_checkout_session_id,stripe_payment_intent_id,hold_expires_at," +
  "package_snapshot,brief_id,application_id,offer_id,agent_run_id,next_deadline_at";

export async function loadOfferExpiresAt(tenant_id: string, offer_id: string): Promise<string | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("creator_offers")
    .select("expires_at, terms")
    .eq("id", offer_id)
    .maybeSingle();
  if (error) throw new Error(`loadOfferExpiresAt failed: ${error.message}`);
  const row = data as { expires_at?: string; terms?: unknown } | null;
  return row?.expires_at ? offerPayableUntil(row.expires_at, row.terms) : null;
}

export async function loadOrderForCheckout(
  tenant_id: string,
  order_id: string,
): Promise<CreatorOrderCheckoutRow | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("creator_orders")
    .select(CHECKOUT_COLUMNS)
    .eq("id", order_id)
    .maybeSingle();
  if (error) throw new Error(`loadOrderForCheckout failed: ${error.message}`);
  return (data as CreatorOrderCheckoutRow | null) ?? null;
}

export async function attachCheckoutSession(args: {
  tenant_id: string;
  order_id: string;
  checkout_session_id: string;
}): Promise<void> {
  const { error } = await tenantClient(asTenantId(args.tenant_id))
    .from("creator_orders")
    .update({
      stripe_checkout_session_id: args.checkout_session_id,
      updated_at: new Date().toISOString(),
    })
    .eq("id", args.order_id)
    .eq("status", "checkout_pending");
  if (error) throw new Error(`attachCheckoutSession failed: ${error.message}`);
}

export async function attachPaymentIntent(args: {
  tenant_id: string;
  order_id: string;
  payment_intent_id: string;
  hold_expires_at: string | null;
}): Promise<void> {
  const { error } = await tenantClient(asTenantId(args.tenant_id))
    .from("creator_orders")
    .update({
      stripe_payment_intent_id: args.payment_intent_id,
      hold_expires_at: args.hold_expires_at,
      updated_at: new Date().toISOString(),
    })
    .eq("id", args.order_id);
  if (error) throw new Error(`attachPaymentIntent failed: ${error.message}`);
}

export type CreatorJobRow = CreatorOrderStateRow & {
  brief_id: string | null;
  application_id: string | null;
  package_id: string | null;
  offer_id: string | null;
  thread_id: string | null;
  currency: string;
  hold_expires_at: string | null;
  brief_snapshot: Record<string, unknown> | null;
  agent_run_id?: string | null;
};

const JOB_COLUMNS =
  `${ORDER_STATE_COLUMNS},package_id,offer_id,thread_id,` +
  "currency,hold_expires_at,brief_snapshot,agent_run_id";

export async function listCreatorJobs(
  tenant_id: string,
  limit = 100,
): Promise<CreatorJobRow[]> {
  const base = () =>
    tenantClient(asTenantId(tenant_id))
      .from("creator_orders")
      .select(JOB_COLUMNS)
      .neq("status", "checkout_pending")
      .or(PAID_ORDER_FILTER);
  const [history, open] = await Promise.all([
    base().order("created_at", { ascending: false }).limit(limit),
    base().not("status", "in", "(completed,cancelled)").order("created_at", { ascending: false }),
  ]);
  if (history.error) throw new Error(`listCreatorJobs failed: ${history.error.message}`);
  if (open.error) throw new Error(`listCreatorJobs failed: ${open.error.message}`);
  const byId = new Map<string, CreatorJobRow>();
  for (const r of [...((open.data ?? []) as unknown as CreatorJobRow[]), ...((history.data ?? []) as unknown as CreatorJobRow[])])
    byId.set(r.id, r);
  return [...byId.values()].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
}

export async function loadCreatorJob(
  tenant_id: string,
  order_id: string,
): Promise<CreatorJobRow | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("creator_orders")
    .select(JOB_COLUMNS)
    .eq("id", order_id)
    .maybeSingle();
  if (error) throw new Error(`loadCreatorJob failed: ${error.message}`);
  return (data as unknown as CreatorJobRow | null) ?? null;
}

export async function hasCompletedJobWithCreator(
  tenant_id: string,
  human_member_id: string,
): Promise<boolean> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("creator_orders")
    .select("id")
    .eq("human_member_id", human_member_id)
    .eq("status", "completed")
    .limit(1);
  if (error) throw new Error(`hasCompletedJobWithCreator failed: ${error.message}`);
  return (data ?? []).length > 0;
}

export type CreatorSubmissionRow = {
  id: string;
  order_id: string;
  version: number;
  position: number;
  kind: "video" | "image" | "raw_footage" | "other";
  storage_path: string;
  mime_type: string | null;
  bytes: number | null;
  note: string | null;
  created_at: string;
  preview_path?: string | null;
  preview_state?: "pending" | "ready" | "failed" | null;
  preview_updated_at?: string | null;
  preview_attempts?: number | null;
};

export async function listSubmissions(
  tenant_id: string,
  order_id: string,
): Promise<CreatorSubmissionRow[]> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("creator_submissions")
    .select("id,order_id,version,position,kind,storage_path,mime_type,bytes,note,created_at,preview_path,preview_state,preview_updated_at,preview_attempts")
    .eq("order_id", order_id)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(`listSubmissions failed: ${error.message}`);
  return (data ?? []) as CreatorSubmissionRow[];
}

export async function latestSubmissionAtByOrder(
  tenant_id: string,
  order_ids: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (order_ids.length === 0) return out;
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("creator_submissions")
    .select("order_id,created_at")
    .in("order_id", order_ids)
    .order("created_at", { ascending: false })
    .limit(1000);
  if (error) throw new Error(`latestSubmissionAtByOrder failed: ${error.message}`);
  for (const r of (data ?? []) as { order_id: string; created_at: string }[]) {
    if (!out.has(r.order_id)) out.set(r.order_id, r.created_at);
  }
  return out;
}

export async function submissionRoundsByOrder(
  tenant_id: string,
  order_ids: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (order_ids.length === 0) return out;
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("creator_submissions")
    .select("order_id,version")
    .in("order_id", order_ids)
    .limit(1000);
  if (error) throw new Error(`submissionRoundsByOrder failed: ${error.message}`);
  for (const r of (data ?? []) as { order_id: string; version: number }[]) {
    out.set(r.order_id, Math.max(out.get(r.order_id) ?? 0, r.version));
  }
  return out;
}

export async function partialRefundsByOrder(
  tenant_id: string,
  order_ids: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (order_ids.length === 0) return out;
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("creator_disputes")
    .select("order_id,refund_amount_cents")
    .in("order_id", order_ids)
    .eq("outcome", "pay_part")
    .eq("status", "resolved");
  if (error) throw new Error(`partialRefundsByOrder failed: ${error.message}`);
  for (const r of (data ?? []) as { order_id: string; refund_amount_cents: number | null }[]) {
    if (typeof r.refund_amount_cents === "number") out.set(r.order_id, r.refund_amount_cents);
  }
  return out;
}

export type CreatorDisputeRow = {
  id: string;
  kind: "step_in" | "cancel_dispute";
  opened_by: "tenant" | "creator";
  reason: string;
  status: "open" | "resolved";
  outcome: "pay_full" | "pay_part" | "refund" | null;
  resolution_note: string | null;
  created_at: string;
  resolved_at: string | null;
};

export async function loadLatestDispute(
  tenant_id: string,
  order_id: string,
): Promise<CreatorDisputeRow | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("creator_disputes")
    .select("id,kind,opened_by,reason,status,outcome,resolution_note,created_at,resolved_at")
    .eq("order_id", order_id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`loadLatestDispute failed: ${error.message}`);
  return (data as CreatorDisputeRow | null) ?? null;
}
