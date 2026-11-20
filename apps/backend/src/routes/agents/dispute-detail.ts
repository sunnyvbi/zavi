
import type { Request, Response } from "express";
import type Stripe from "stripe";
import { requireAuth } from "@/services/auth/middleware";
import { serverClientFromBearer } from "@/services/supabase";
import { stripeClient } from "@/services/tools/stripe/_client";
import { ExpectedToolError } from "@/services/tools/types";
import type { ToolContext } from "@/services/tools/types";
import { operatorDbQueryTool } from "@/services/tools/operator-db/tools";
import {
  readCe3,
  humanizeReason,
  round2,
  type StripeDisputeLite,
} from "./dashboards/dispute-response";

const DP_ID_RE = /^d[pu]_[A-Za-z0-9]+$/;
const DAY = 86400;

function usd(minor: number | null | undefined): number {
  return round2((Number(minor) || 0) / 100);
}

function isMissingOrForbidden(e: unknown): boolean {
  const err = e as { code?: string; statusCode?: number; type?: string };
  return (
    err?.code === "resource_missing" ||
    err?.statusCode === 404 ||
    err?.statusCode === 403 ||
    err?.type === "StripePermissionError"
  );
}

function isoDate(unix: number | null | undefined): string | null {
  if (typeof unix !== "number" || !Number.isFinite(unix)) return null;
  return new Date(unix * 1000).toISOString();
}

const MEANINGFUL_EVIDENCE_FIELDS: Array<{ key: string; label: string }> = [
  { key: "product_description", label: "Product description" },
  { key: "customer_communication", label: "Customer communication" },
  { key: "customer_email_address", label: "Customer email" },
  { key: "customer_name", label: "Customer name" },
  { key: "billing_address", label: "Billing address" },
  { key: "receipt", label: "Receipt" },
  { key: "customer_signature", label: "Customer signature" },
  { key: "service_documentation", label: "Service documentation" },
  { key: "shipping_documentation", label: "Shipping documentation" },
  { key: "shipping_tracking_number", label: "Shipping tracking number" },
  { key: "duplicate_charge_documentation", label: "Duplicate-charge documentation" },
  { key: "uncategorized_text", label: "Written explanation" },
];

function evidenceChecklist(
  evidence: Record<string, unknown> | null | undefined,
): { attached: number; total: number; missing: string[] } {
  const ev = evidence ?? {};
  const missing: string[] = [];
  let attached = 0;
  for (const f of MEANINGFUL_EVIDENCE_FIELDS) {
    const v = ev[f.key];
    if (v != null && v !== "") attached += 1;
    else missing.push(f.label);
  }
  return { attached, total: MEANINGFUL_EVIDENCE_FIELDS.length, missing };
}

type ChargeShape = Stripe.Charge & {
  calculated_statement_descriptor?: string | null;
};
type CustomerShape = Stripe.Customer;

function resolveCharge(d: Stripe.Dispute): ChargeShape | null {
  const c = d.charge;
  if (!c || typeof c === "string") return null;
  return c as ChargeShape;
}

function resolveCustomer(charge: ChargeShape | null): CustomerShape | null {
  const c = charge?.customer;
  if (!c || typeof c === "string") return null;
  if ((c as { deleted?: boolean }).deleted) return null;
  return c as CustomerShape;
}

async function winRateForReason(
  stripe: Stripe,
  reason: string,
  nowSecs: number,
): Promise<{ won: number; resolved: number; rate: number | null }> {
  let won = 0;
  let lost = 0;
  try {
    const res = (await stripe.disputes.list({
      created: { gte: nowSecs - 90 * DAY },
      limit: 100,
    })) as unknown as { data?: Array<{ reason?: string; status?: string }> };
    for (const d of res.data ?? []) {
      if (d.reason !== reason) continue;
      if (d.status === "won") won += 1;
      else if (d.status === "lost") lost += 1;
    }
  } catch {
    return { won: 0, resolved: 0, rate: null };
  }
  const resolved = won + lost;
  return { won, resolved, rate: resolved >= 1 ? round2(won / resolved) : null };
}

function disputeFeeUsd(d: Stripe.Dispute): number | null {
  const bts = d.balance_transactions;
  if (!Array.isArray(bts) || bts.length === 0) return null;
  let feeMinor = 0;
  let matched = false;
  for (const bt of bts) {
    if ((bt as { reporting_category?: string }).reporting_category === "dispute") {
      feeMinor += Number(bt.fee) || 0;
      matched = true;
    }
  }
  if (!matched) return null;
  return usd(feeMinor);
}

const BOOKING_ID_KEYS = [
  "tripId",
  "bookingId",
  "reservationId",
  "trip_id",
  "booking_id",
  "reservation_id",
];
const BOOKING_COLLECTIONS = ["bookings", "trips", "reservations"];
const BOOKING_LABEL_KEYS = ["title", "name", "label", "listingTitle", "vehicleName"];
const BOOKING_START_KEYS = ["startDate", "start_date", "pickupDate", "pickup_date", "tripStart", "start"];
const BOOKING_END_KEYS = ["endDate", "end_date", "dropoffDate", "dropoff_date", "tripEnd", "end"];

type Booking =
  | { linked: false }
  | {
      linked: true;
      source_collection: string;
      id: string;
      id_field: string;
      label: string | null;
      start_date: string | null;
      end_date: string | null;
    };

function pickBookingId(
  charge: ChargeShape | null,
): { idField: string; idVal: string } | null {
  const m = charge?.metadata;
  if (!m || typeof m !== "object") return null;
  const meta = m as Record<string, unknown>;
  for (const k of BOOKING_ID_KEYS) {
    const v = meta[k];
    if (typeof v === "string" && v.length > 0) return { idField: k, idVal: v };
    if (typeof v === "number" && Number.isFinite(v)) {
      return { idField: k, idVal: String(v) };
    }
  }
  return null;
}

function firstScalar(row: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === "string" && v.trim().length > 0) return v.slice(0, 120);
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

async function tryLinkBooking(
  ctx: ToolContext,
  bookingId: { idField: string; idVal: string } | null,
): Promise<Booking> {
  if (!bookingId) return { linked: false };
  const { idField, idVal } = bookingId;

  for (const collection of BOOKING_COLLECTIONS) {
    for (const filter of [{ _id: idVal }, { [idField]: idVal }]) {
      try {
        const out = (await operatorDbQueryTool.execute(ctx, {
          collection,
          mode: "find",
          filter,
          limit: 1,
        })) as { data?: { rows?: unknown[] } } | undefined;
        const rows = out?.data?.rows;
        if (Array.isArray(rows) && rows.length > 0) {
          const row = (rows[0] ?? {}) as Record<string, unknown>;
          return {
            linked: true,
            source_collection: collection,
            id: idVal,
            id_field: idField,
            label: firstScalar(row, BOOKING_LABEL_KEYS),
            start_date: firstScalar(row, BOOKING_START_KEYS),
            end_date: firstScalar(row, BOOKING_END_KEYS),
          };
        }
      } catch {
      }
    }
  }
  return { linked: false };
}

export async function disputeDetail(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const id = req.params.id;
  if (typeof id !== "string" || !DP_ID_RE.test(id)) {
    res.status(400).json({ error: "invalid_dispute_id" });
    return;
  }

  let stripe: Stripe;
  try {
    stripe = await stripeClient(auth.tenant_id);
  } catch (e) {
    if (e instanceof ExpectedToolError && e.code === "stripe_not_connected") {
      res.json({ connected: false });
      return;
    }
    throw e;
  }

  let d: Stripe.Dispute;
  try {
    d = await stripe.disputes.retrieve(id, {
      expand: [
        "charge",
        "charge.customer",
        "charge.payment_intent",
        "balance_transactions",
      ],
    });
  } catch (e) {
    if (isMissingOrForbidden(e)) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.status(502).json({ error: "stripe_error" });
    return;
  }

  const nowSecs = Math.floor(Date.now() / 1000);
  const charge = resolveCharge(d);
  const customer = resolveCustomer(charge);
  const ce3 = readCe3(d as unknown as StripeDisputeLite);
  const dueBy = d.evidence_details?.due_by ?? null;
  const pastDue =
    d.evidence_details?.past_due === true ||
    (dueBy != null && dueBy <= nowSecs);

  const card = charge?.payment_method_details?.card ?? null;
  const pi = charge?.payment_intent;
  const paymentIntentId = pi ? (typeof pi === "string" ? pi : pi.id) : null;
  const bookingId = pickBookingId(charge);

  const win = await winRateForReason(stripe, d.reason, nowSecs);
  const booking = await tryLinkBooking(
    { tenant_id: auth.tenant_id, log: () => {}, agent_slug: "dispute-response" },
    bookingId,
  );

  const amountUsd = usd(d.amount);

  const submissionCount = d.evidence_details?.submission_count ?? 0;
  let draftDecisionId: string | null = null;
  let finalizeChildExists = false;
  try {
    const sb = serverClientFromBearer(auth.access_token);
    const { data: draft } = await sb
      .from("decisions")
      .select("id")
      .eq("tenant_id", auth.tenant_id)
      .eq("decision_class", "dispute-response.submit-evidence")
      .eq("status", "acted")
      .eq("body->evidence_packet->>dispute_id", d.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    draftDecisionId = (draft as { id?: string } | null)?.id ?? null;
    if (draftDecisionId) {
      const { data: child } = await sb
        .from("decisions")
        .select("id")
        .eq("tenant_id", auth.tenant_id)
        .eq("decision_class", "dispute-response.final-submit-evidence")
        .eq("body->>source_draft_decision_id", draftDecisionId)
        .maybeSingle();
      finalizeChildExists = !!child;
    }
  } catch {
    draftDecisionId = null;
  }
  const submitted = submissionCount >= 1 || finalizeChildExists;

  res.json({
    connected: true,
    dispute: {
      id: d.id,
      reason: d.reason,
      reason_label: humanizeReason(d.reason),
      network_reason_code:
        (d as { network_reason_code?: string | null }).network_reason_code ??
        null,
      status: d.status,
      amount_usd: amountUsd,
      currency: String(d.currency || "usd").toUpperCase(),
      evidence_due_by: dueBy,
      past_due: pastDue,
      submission_count: submissionCount,
      opened: d.created,
    },
    finalize: {
      draft_decision_id: draftDecisionId,
      submitted,
      can_submit: draftDecisionId != null && !submitted && !pastDue,
    },
    charge: charge
      ? {
          id: charge.id,
          amount_usd: usd(charge.amount),
          currency: String(charge.currency || "usd").toUpperCase(),
          created: isoDate(charge.created),
          statement_descriptor:
            charge.statement_descriptor ??
            charge.calculated_statement_descriptor ??
            charge.description ??
            null,
          card_brand: card?.brand ?? null,
          card_last4: card?.last4 ?? null,
          receipt_url: charge.receipt_url ?? null,
        }
      : null,
    cardholder: customer
      ? {
          customer_id: customer.id,
          name: customer.name ?? null,
          email: customer.email ?? null,
          customer_since: customer.created ?? null,
        }
      : null,
    ce3: {
      status: ce3.status,
      required_actions: ce3.required_actions,
    },
    evidence_checklist: evidenceChecklist(
      d.evidence as unknown as Record<string, unknown>,
    ),
    matching_data: {
      ip: "unavailable" as const,
      device: "unavailable" as const,
    },
    win_rate: win,
    fees: {
      dispute_fee_usd: disputeFeeUsd(d),
      recoverable_usd: amountUsd,
    },
    booking,
    links: {
      stripe_dispute_url: `https://dashboard.stripe.com/disputes/${d.id}`,
      booking_url: booking.linked
        ? `booking://${booking.source_collection}/${booking.id}`
        : null,
    },
    raw: {
      charge_id: charge?.id ?? null,
      payment_intent: paymentIntentId,
      network_reason_code:
        (d as { network_reason_code?: string | null }).network_reason_code ??
        null,
      evidence_details: d.evidence_details ?? null,
    },
  });
}

export async function disputeHistory(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const id = req.params.id;
  if (typeof id !== "string" || !DP_ID_RE.test(id)) {
    res.status(400).json({ error: "invalid_dispute_id" });
    return;
  }

  let stripe: Stripe;
  try {
    stripe = await stripeClient(auth.tenant_id);
  } catch (e) {
    if (e instanceof ExpectedToolError && e.code === "stripe_not_connected") {
      res.json({ connected: false });
      return;
    }
    throw e;
  }

  let d: Stripe.Dispute;
  try {
    d = await stripe.disputes.retrieve(id, { expand: ["charge", "charge.customer"] });
  } catch (e) {
    if (isMissingOrForbidden(e)) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.status(502).json({ error: "stripe_error" });
    return;
  }

  const charge = resolveCharge(d);
  const customer = resolveCustomer(charge);
  const customerId =
    customer?.id ??
    (typeof charge?.customer === "string" ? charge.customer : null);

  if (!customerId) {
    res.json({
      connected: true,
      available: false,
      customer_since: customer?.created ?? null,
    });
    return;
  }

  let chargeIds = new Set<string>();
  let totalCharges = 0;
  try {
    const charges = await stripe.charges.list({ customer: customerId, limit: 100 });
    totalCharges = charges.data.length;
    for (const c of charges.data) chargeIds.add(c.id);
  } catch {
    res.json({
      connected: true,
      available: false,
      customer_since: customer?.created ?? null,
    });
    return;
  }

  const priorDisputes: Array<{
    id: string;
    amount_usd: number;
    reason: string;
    status: string;
    created: number;
  }> = [];
  try {
    const disputes = await stripe.disputes.list({ limit: 100 });
    for (const dp of disputes.data) {
      if (dp.id === d.id) continue;
      const dpChargeId = typeof dp.charge === "string" ? dp.charge : dp.charge?.id;
      if (!dpChargeId || !chargeIds.has(dpChargeId)) continue;
      priorDisputes.push({
        id: dp.id,
        amount_usd: usd(dp.amount),
        reason: dp.reason,
        status: dp.status,
        created: dp.created,
      });
    }
  } catch {
    res.json({
      connected: true,
      available: false,
      customer_since: customer?.created ?? null,
    });
    return;
  }

  res.json({
    connected: true,
    available: true,
    customer_since: customer?.created ?? null,
    total_charges: totalCharges,
    prior_dispute_count: priorDisputes.length,
    prior_disputes: priorDisputes,
    capped: true,
  });
}
