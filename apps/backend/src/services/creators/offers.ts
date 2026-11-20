
import { asTenantId, globalClient, tenantClient, preTenantRpc } from "@/services/tenant-client";
import {
  computeCreatorFees,
  type CreatorFeeBreakdown as CreatorFeeLines,
} from "@/services/creators/order-fees";
import {
  resolveCreatorMoneyPort,
  type OfferSide,
  type PlaceHoldForOfferResult,
} from "./money-port";
import { ensureCreatorThread, resolveSide, type CreatorThreadAccessResult } from "./thread";
import { offerTitle } from "./booking-db";
import { isNeverPaidOrder } from "./order-state";
import { offerPayableUntil } from "./deadlines";
import { notifyCustomOfferAccepted, notifyCustomOfferReceived } from "./thread-notify";
import { scrubContact, type ContactKind } from "./contact-scrub";
import { logEvent } from "@/services/logging/logEvent";
import type { FileCreatorHireCardResult, HireCardRefusal } from "./hire-card";

export const OFFER_TTL_HOURS = 72;
const OFFER_TTL_MS = OFFER_TTL_HOURS * 60 * 60 * 1000;

export type OfferKind = "ugc_video";

export type OfferRow = {
  id: string;
  tenant_id: string;
  human_member_id: string;
  thread_id: string | null;
  proposed_by: OfferSide;
  kind: OfferKind;
  terms: Record<string, unknown>;
  price_cents: number;
  currency: string;
  delivery_days: number;
  note: string | null;
  status: "open" | "accepted" | "declined" | "expired" | "withdrawn";
  expires_at: string;
  responded_at: string | null;
  created_at: string;
  product_needed?: boolean;
  agent_run_id?: string | null;
};

export type OfferView = OfferRow & {
  fees: CreatorFeeLines;
  expired: boolean;
  awaiting_payment?: boolean;
  closed_unpaid?: boolean;
  awaiting_approval?: boolean;
};

export type OfferError =
  | "offer_not_found"
  | "not_authorized"
  | "cannot_accept_own_offer"
  | "offer_expired"
  | "offer_not_open"
  | "hire_refused";

export const HIRE_REFUSED_MESSAGE =
  "This business cannot confirm this offer right now, so it was withdrawn. Nothing was charged.";

const OFFER_COLUMNS =
  "id, tenant_id, human_member_id, thread_id, proposed_by, kind, terms, price_cents, currency, delivery_days, note, status, expires_at, responded_at, created_at, product_needed, agent_run_id";

export function offerExpiresAt(from: Date): Date {
  return new Date(from.getTime() + OFFER_TTL_MS);
}

export function isOfferExpired(offer: { expires_at: string; terms?: unknown }, now: Date): boolean {
  return now.getTime() >= Date.parse(offerPayableUntil(offer.expires_at, offer.terms));
}

export function toOfferView(offer: OfferRow, now: Date): OfferView {
  return {
    ...offer,
    fees: computeCreatorFees(offer.price_cents),
    expired: isOfferExpired(offer, now),
  };
}

export function offerForSide(offer: OfferView, side: OfferSide): OfferView | Omit<OfferView, "tenant_id"> {
  if (side !== "creator") return offer;
  const { tenant_id: _tenant, ...rest } = offer;
  void _tenant;
  return rest;
}

type OfferRef = {
  tenant_id: string;
  human_member_id: string;
  thread_id: string | null;
  proposed_by: OfferSide;
  status: string;
  expires_at: string;
};

export async function authorizeOfferAccess(args: {
  auth_user_id: string;
  offer_id: string;
}): Promise<CreatorThreadAccessResult> {
  const { data, error } = await preTenantRpc("creator_resolve_offer", {
    p_offer_id: args.offer_id,
  });
  if (error) throw new Error(`creator_resolve_offer failed: ${error.message}`);
  const rows = (data ?? []) as OfferRef[];
  if (rows.length === 0) return { ok: false, code: "thread_not_found" };
  const ref = rows[0];

  return resolveSide({
    auth_user_id: args.auth_user_id,
    tenant_id: ref.tenant_id,
    human_member_id: ref.human_member_id,
    thread_id: ref.thread_id ?? "",
  });
}

export type CreateOfferInput = {
  tenant_id: string;
  human_member_id: string;
  proposed_by: OfferSide;
  proposed_by_user_id: string | null;
  agent_run_id?: string | null;
  kind: OfferKind;
  terms: Record<string, unknown>;
  price_cents: number;
  delivery_days: number;
  note?: string | null;
  product_needed?: boolean;
  thread_id?: string | null;
  now?: Date;
};

const CONTACT_KIND_ORDER: ContactKind[] = ["email", "link", "phone", "address"];

function scrubOfferValue(value: unknown, removed: Set<ContactKind>): unknown {
  if (typeof value === "string") {
    const out = scrubContact(value);
    for (const kind of out.removed) removed.add(kind);
    return out.body;
  }
  if (Array.isArray(value)) return value.map((v) => scrubOfferValue(v, removed));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, scrubOfferValue(v, removed)]),
    );
  }
  return value;
}

export async function createCreatorOffer(input: CreateOfferInput): Promise<OfferView> {
  const now = input.now ?? new Date();
  computeCreatorFees(input.price_cents);
  const agentRunId = input.agent_run_id ?? null;
  if (agentRunId !== null && input.proposed_by !== "tenant") {
    throw new Error("only a business offer can carry an agent run");
  }

  let threadId = input.thread_id ?? null;
  if (!threadId) {
    const thread = await ensureCreatorThread({
      tenant_id: input.tenant_id,
      human_member_id: input.human_member_id,
      started_by: input.proposed_by,
      started_by_user_id: input.proposed_by_user_id,
    });
    threadId = thread.id;
  }

  const removed = new Set<ContactKind>();
  const terms = scrubOfferValue(input.terms, removed) as Record<string, unknown>;
  const note = input.note == null ? null : (scrubOfferValue(input.note, removed) as string);

  const { data, error } = await tenantClient(asTenantId(input.tenant_id))
    .from("creator_offers")
    .insert({
      human_member_id: input.human_member_id,
      thread_id: threadId,
      proposed_by: input.proposed_by,
      proposed_by_user_id: input.proposed_by_user_id,
      agent_run_id: agentRunId,
      kind: input.kind,
      terms,
      price_cents: input.price_cents,
      currency: "usd",
      delivery_days: input.delivery_days,
      note,
      product_needed: input.product_needed === true,
      status: "open",
      expires_at: offerExpiresAt(now).toISOString(),
    })
    .select(OFFER_COLUMNS)
    .maybeSingle();
  if (error || !data) {
    throw new Error(`creator_offers insert failed: ${error?.message ?? "no row"}`);
  }
  const row = data as OfferRow;
  if (removed.size > 0) {
    void logEvent({
      level: "info",
      source: "creators/offers",
      code: "creator.contact_scrubbed",
      message: `contact details removed from a ${input.proposed_by} offer (${CONTACT_KIND_ORDER.filter((k) => removed.has(k)).join(", ")})`,
      tenant_id: input.tenant_id,
    }).catch(() => undefined);
  }
  await notifyCustomOfferReceived({
    tenant_id: input.tenant_id,
    human_member_id: input.human_member_id,
    thread_id: threadId,
    offer_id: row.id,
    from: input.proposed_by,
    job_title: offerTitle(row),
    price_cents: row.price_cents,
  });
  return toOfferView(row, now);
}

export async function listThreadOffers(args: {
  tenant_id: string;
  thread_id: string;
  now?: Date;
}): Promise<OfferView[]> {
  const now = args.now ?? new Date();
  const { data, error } = await tenantClient(asTenantId(args.tenant_id))
    .from("creator_offers")
    .select(OFFER_COLUMNS)
    .eq("thread_id", args.thread_id)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw new Error(`creator_offers read failed: ${error.message}`);
  const views = ((data ?? []) as OfferRow[]).map((row) => toOfferView(row, now));

  const accepted = views.filter((v) => v.status === "accepted").map((v) => v.id);
  const orderOf = new Map<string, { status: string; closed_reason: string | null }>();
  if (accepted.length > 0) {
    const { data: orders, error: orderError } = await tenantClient(asTenantId(args.tenant_id))
      .from("creator_orders")
      .select("offer_id, status, closed_reason")
      .in("offer_id", accepted);
    if (orderError) throw new Error(`creator_orders offer read failed: ${orderError.message}`);
    for (const o of (orders ?? []) as { offer_id: string; status: string; closed_reason: string | null }[]) {
      orderOf.set(o.offer_id, o);
    }
  }
  return views.map((v) => {
    if (v.status !== "accepted") return { ...v, awaiting_payment: false, closed_unpaid: false, awaiting_approval: false };
    return { ...v, ...acceptedOfferPayment(v.expired, orderOf.get(v.id), Boolean(v.agent_run_id)) };
  });
}

export function acceptedOfferPayment(
  expired: boolean,
  order: { status: string; closed_reason: string | null } | undefined,
  agent = false,
): { awaiting_payment?: boolean; closed_unpaid: boolean; awaiting_approval: boolean } {
  const unpaid = order === undefined || isNeverPaidOrder(order);
  const abandoned = order !== undefined && order.status === "cancelled";
  const open = unpaid && !abandoned && !expired;
  const closed_unpaid = unpaid && (abandoned || expired);
  if (open && agent) return { closed_unpaid, awaiting_approval: true };
  return { awaiting_payment: open, closed_unpaid, awaiting_approval: false };
}

async function readOffer(tenant_id: string, offer_id: string): Promise<OfferRow | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("creator_offers")
    .select(OFFER_COLUMNS)
    .eq("id", offer_id)
    .maybeSingle();
  if (error) throw new Error(`creator_offers read failed: ${error.message}`);
  return (data as OfferRow | null) ?? null;
}

export async function getOfferView(args: {
  tenant_id: string;
  offer_id: string;
  now?: Date;
}): Promise<OfferView | null> {
  const row = await readOffer(args.tenant_id, args.offer_id);
  return row ? toOfferView(row, args.now ?? new Date()) : null;
}

export type AcceptOfferResult =
  | { ok: true; offer: OfferView; order: PlaceHoldForOfferResult }
  | { ok: false; code: Exclude<OfferError, "hire_refused"> }
  | { ok: false; code: "hire_refused"; refusal: HireCardRefusal; message: string };

export async function acceptCreatorOffer(args: {
  access: { tenant_id: string; sender_kind: OfferSide; human_member_id: string };
  offer_id: string;
  now?: Date;
}): Promise<AcceptOfferResult> {
  const now = args.now ?? new Date();
  const tenant_id = args.access.tenant_id;
  const client = tenantClient(asTenantId(tenant_id));

  const offer = await readOffer(tenant_id, args.offer_id);
  if (!offer) return { ok: false, code: "offer_not_found" };

  if (offer.proposed_by === args.access.sender_kind) {
    return { ok: false, code: "cannot_accept_own_offer" };
  }

  if (offer.status === "accepted") {
    const existing = await readOrderForOffer(tenant_id, offer.id);
    if (existing) {
      const refusal = await refileAgentOfferHireCard(tenant_id, offer, existing);
      if (refusal) return { ok: false, code: "hire_refused", refusal, message: HIRE_REFUSED_MESSAGE };
      return { ok: true, offer: toOfferView(offer, now), order: { ...existing, already_existed: true } };
    }
    return { ok: false, code: "offer_not_open" };
  }

  if (offer.status !== "open" || offer.kind !== "ugc_video") return { ok: false, code: "offer_not_open" };

  if (isOfferExpired(offer, now)) {
    void client
      .from("creator_offers")
      .update({ status: "expired", updated_at: now.toISOString() })
      .eq("id", offer.id)
      .eq("status", "open")
      .then(undefined, () => undefined);
    return { ok: false, code: "offer_expired" };
  }

  if (offer.agent_run_id) {
    const refusal = await agentOfferCapRefusal(tenant_id, offer.price_cents);
    if (refusal) {
      await client
        .from("creator_offers")
        .update({ status: "withdrawn", updated_at: now.toISOString() })
        .eq("id", offer.id)
        .eq("status", "open")
        .then(undefined, () => undefined);
      return { ok: false, code: "hire_refused", refusal, message: HIRE_REFUSED_MESSAGE };
    }
  }

  const claimed = await client
    .from("creator_offers")
    .update({ status: "accepted", responded_at: now.toISOString(), updated_at: now.toISOString() })
    .eq("id", offer.id)
    .eq("status", "open")
    .select(OFFER_COLUMNS)
    .maybeSingle();
  if (claimed.error) {
    throw new Error(`creator_offers claim failed: ${claimed.error.message}`);
  }
  if (!claimed.data) {
    const existing = await readOrderForOffer(tenant_id, offer.id);
    if (existing) {
      return { ok: true, offer: toOfferView(offer, now), order: { ...existing, already_existed: true } };
    }
    return { ok: false, code: "offer_not_open" };
  }
  const accepted = claimed.data as OfferRow;

  const fees = computeCreatorFees(accepted.price_cents);
  const agentRunId = accepted.agent_run_id ?? null;
  let order: PlaceHoldForOfferResult;
  try {
    order = await resolveCreatorMoneyPort().placeHoldForOffer({
      tenant_id,
      offer_id: accepted.id,
      human_member_id: accepted.human_member_id,
      thread_id: accepted.thread_id,
      proposed_by: accepted.proposed_by,
      accepted_by: args.access.sender_kind,
      kind: accepted.kind,
      package_snapshot: {
        source: "offer",
        kind: accepted.kind,
        terms: accepted.terms,
        price_cents: accepted.price_cents,
        delivery_days: accepted.delivery_days,
        note: accepted.note,
      },
      delivery_days: accepted.delivery_days,
      currency: "usd",
      price_cents: fees.price_cents,
      business_fee_cents: fees.business_fee_cents,
      creator_fee_cents: fees.creator_fee_cents,
      idempotency_key: accepted.id,
      ...(agentRunId ? { initiator: "agent" as const, agent_run_id: agentRunId } : {}),
    });
  } catch (e) {
    await client
      .from("creator_offers")
      .update({ status: "open", responded_at: null, updated_at: now.toISOString() })
      .eq("id", accepted.id)
      .eq("status", "accepted")
      .then(undefined, () => undefined);
    throw e;
  }

  if (agentRunId) {
    if (order.already_existed) {
      const refusal = await refileAgentOfferHireCard(tenant_id, accepted, { order_id: order.order_id, status: "checkout_pending" });
      if (refusal) return { ok: false, code: "hire_refused", refusal, message: HIRE_REFUSED_MESSAGE };
      return { ok: true, offer: toOfferView(accepted, now), order };
    }
    const reason = await fileAgentOfferHireCard({ tenant_id, run_id: agentRunId, offer: accepted, order_id: order.order_id });
    if (reason) {
      return { ok: false, code: "hire_refused", refusal: reason, message: HIRE_REFUSED_MESSAGE };
    }
    return { ok: true, offer: toOfferView(accepted, now), order };
  }

  if (args.access.sender_kind === "creator" && !order.already_existed) {
    await notifyCustomOfferAccepted({
      tenant_id,
      human_member_id: accepted.human_member_id,
      order_id: order.order_id,
      job_title: offerTitle(accepted),
      price_cents: accepted.price_cents,
      checkout_url: order.checkout_url ?? null,
    });
  }
  return { ok: true, offer: toOfferView(accepted, now), order };
}

async function creatorDisplayName(human_member_id: string): Promise<string> {
  const { data, error } = await globalClient()
    .from("human_members")
    .select("display_name")
    .eq("id", human_member_id)
    .maybeSingle();
  if (error) throw new Error(`creator name lookup failed: ${error.message}`);
  return ((data as { display_name?: string | null } | null)?.display_name ?? "").trim() || "the creator";
}

export async function openAgentOfferExists(tenant_id: string, human_member_id: string): Promise<boolean> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("creator_offers")
    .select("id")
    .eq("human_member_id", human_member_id)
    .eq("status", "open")
    .not("agent_run_id", "is", null)
    .limit(1);
  if (error) throw new Error(`creator_offers read failed: ${error.message}`);
  return ((data as unknown[] | null) ?? []).length > 0;
}

async function agentOfferCapRefusal(tenant_id: string, price_cents: number): Promise<HireCardRefusal | null> {
  const { latestCreatorCaps } = await import("@/services/decisions/creator-hire-budget");
  const caps = await latestCreatorCaps(tenant_id);
  if (!caps) return "no_caps";
  return computeCreatorFees(price_cents).business_total_cents / 100 > caps.per_hire_usd ? "over_hire_cap" : null;
}

async function refileAgentOfferHireCard(
  tenant_id: string,
  offer: OfferRow,
  order: { order_id: string; status: string },
): Promise<HireCardRefusal | null> {
  if (!offer.agent_run_id || order.status !== "checkout_pending") return null;
  return fileAgentOfferHireCard({ tenant_id, run_id: offer.agent_run_id, offer, order_id: order.order_id });
}

async function fileAgentOfferHireCard(args: {
  tenant_id: string;
  run_id: string;
  offer: OfferRow;
  order_id: string;
}): Promise<HireCardRefusal | null> {
  const fees = computeCreatorFees(args.offer.price_cents);
  const { declineCreatorHire, fileCreatorHireCard } = await import("./hire-card");
  let filed: FileCreatorHireCardResult;
  try {
    filed = await fileCreatorHireCard({
      tenant_id: args.tenant_id,
      run_id: args.run_id,
      order_id: args.order_id,
      creator_name: await creatorDisplayName(args.offer.human_member_id),
      package_title: offerTitle(args.offer),
      business_total_cents: fees.business_total_cents,
      price_cents: fees.price_cents,
      fee_cents: fees.business_fee_cents,
      source: "offer",
    });
  } catch (e) {
    await declineCreatorHire({
      tenant_id: args.tenant_id,
      order_id: args.order_id,
      reason: `the hire card could not be filed: ${e instanceof Error ? e.message : String(e)}`,
    });
    throw e;
  }
  if (filed.ok) return null;
  await declineCreatorHire({ tenant_id: args.tenant_id, order_id: args.order_id, reason: filed.message });
  return filed.refusal;
}

async function readOrderForOffer(
  tenant_id: string,
  offer_id: string,
): Promise<{ order_id: string; status: string } | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("creator_orders")
    .select("id, status")
    .eq("offer_id", offer_id)
    .maybeSingle();
  if (error) throw new Error(`creator_orders read failed: ${error.message}`);
  if (!data) return null;
  const row = data as { id: string; status: string };
  return { order_id: row.id, status: row.status };
}

export async function closeCreatorOffer(args: {
  access: { tenant_id: string; sender_kind: OfferSide };
  offer_id: string;
  action: "decline" | "withdraw";
  now?: Date;
}): Promise<{ ok: true; offer: OfferView } | { ok: false; code: OfferError }> {
  const now = args.now ?? new Date();
  const offer = await readOffer(args.access.tenant_id, args.offer_id);
  if (!offer) return { ok: false, code: "offer_not_found" };

  const isProposer = offer.proposed_by === args.access.sender_kind;
  if (args.action === "withdraw" && !isProposer) return { ok: false, code: "not_authorized" };
  if (args.action === "decline" && isProposer) return { ok: false, code: "cannot_accept_own_offer" };
  if (offer.status !== "open") return { ok: false, code: "offer_not_open" };

  const { data, error } = await tenantClient(asTenantId(args.access.tenant_id))
    .from("creator_offers")
    .update({
      status: args.action === "decline" ? "declined" : "withdrawn",
      responded_at: now.toISOString(),
      updated_at: now.toISOString(),
    })
    .eq("id", offer.id)
    .eq("status", "open")
    .select(OFFER_COLUMNS)
    .maybeSingle();
  if (error) throw new Error(`creator_offers close failed: ${error.message}`);
  if (!data) return { ok: false, code: "offer_not_open" };
  return { ok: true, offer: toOfferView(data as OfferRow, now) };
}
