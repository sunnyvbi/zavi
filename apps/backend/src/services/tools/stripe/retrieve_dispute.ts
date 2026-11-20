
import { z } from "zod";
import { stripeClient, wrapStripeError } from "./_client";
import type { ToolSpec } from "@/services/tools/types";

const inputSchema = z.object({
  dispute_id: z
    .string()
    .regex(
      /^d[pu]_[A-Za-z0-9]+$/,
      "must be a Stripe dispute id (du_* or legacy dp_*)",
    ),
});

export const retrieveDisputeTool: ToolSpec = {
  name: "stripe_retrieve_dispute",
  effect: "read",
  description:
    "Retrieve a Stripe dispute object + the underlying charge. Returns the dispute reason, amount, currency, evidence_due_by deadline, current evidence, and the buyer's prior dispute history. Call this first when handling a new dispute.",
  input_schema: inputSchema,
  async execute(ctx, input: unknown) {
    const { dispute_id } = inputSchema.parse(input);
    const stripe = await stripeClient(ctx.tenant_id);
    try {
      const dispute = await stripe.disputes.retrieve(dispute_id, { expand: ["charge", "charge.customer"] });

      const charge: Stripe_ChargeShape =
        typeof dispute.charge === "string"
          ? ((await stripe.charges.retrieve(dispute.charge)) as unknown as Stripe_ChargeShape)
          : (dispute.charge as unknown as Stripe_ChargeShape);

      const disputedChargeId = charge?.id ?? null;
      const disputedCreated = charge?.created ?? Math.floor(Date.now() / 1000);
      const disputedPm =
        typeof charge?.payment_method === "string"
          ? charge.payment_method
          : (charge?.payment_method as { id?: string } | null)?.id ?? null;

      const DAY = 86400;
      const WINDOW_OLDEST = disputedCreated - 365 * DAY;
      const WINDOW_NEWEST = disputedCreated - 120 * DAY;

      let priorDisputeCount = 0;
      let priorUndisputedSamePm = 0;
      let priorUndisputedInCe3Window = 0;
      let disputedSamePm = 0;

      const customerId =
        typeof charge?.customer === "string"
          ? charge.customer
          : (charge?.customer as { id?: string } | null)?.id;

      if (customerId) {
        const priorCharges = await stripe.charges.list({ customer: customerId, limit: 100 });
        for (const c of priorCharges.data) {
          if (c.id === disputedChargeId) continue;
          if (c.disputed) priorDisputeCount += 1;
          const cPm =
            typeof c.payment_method === "string"
              ? c.payment_method
              : (c.payment_method as unknown as { id?: string } | null)?.id ?? null;
          if (!disputedPm || cPm !== disputedPm) continue;
          if (c.disputed) {
            disputedSamePm += 1;
            continue;
          }
          if (!(c.paid && c.status === "succeeded")) continue;
          if (c.refunded) continue;
          priorUndisputedSamePm += 1;
          if (c.created >= WINDOW_OLDEST && c.created <= WINDOW_NEWEST) priorUndisputedInCe3Window += 1;
        }
      }

      return {
        dispute: {
          id: dispute.id,
          amount: dispute.amount,
          currency: dispute.currency,
          reason: dispute.reason,
          status: dispute.status,
          evidence_due_by: dispute.evidence_details?.due_by ?? null,
          past_due: dispute.evidence_details?.past_due ?? false,
          submission_count: dispute.evidence_details?.submission_count ?? 0,
          current_evidence: pickEvidenceFields(dispute.evidence as unknown as Record<string, unknown>),
        },
        charge: charge
          ? {
              id: charge.id,
              amount: charge.amount,
              currency: charge.currency,
              created: charge.created,
              description: charge.description ?? null,
              receipt_url: charge.receipt_url ?? null,
              payment_method: disputedPm,
              payment_method_details: charge.payment_method_details
                ? {
                    type: charge.payment_method_details.type,
                    card_brand: charge.payment_method_details.card?.brand ?? null,
                    card_last4: charge.payment_method_details.card?.last4 ?? null,
                  }
                : null,
            }
          : null,
        buyer: {
          customer_id: customerId ?? null,
          prior_dispute_count: priorDisputeCount,
          prior_undisputed_same_pm: {
            total: priorUndisputedSamePm,
            in_ce3_window_120_365d: priorUndisputedInCe3Window,
          },
          accepted_charges_same_pm: priorUndisputedSamePm,
          disputed_charges_same_pm: disputedSamePm,
          matching_data_available: {
            ip: false,
            device: false,
          },
        },
      };
    } catch (e) {
      throw wrapStripeError(e);
    }
  },
};

type Stripe_ChargeShape = {
  id: string;
  amount: number;
  currency: string;
  created: number;
  description?: string | null;
  receipt_url?: string | null;
  customer?: string | { id: string } | null;
  payment_method?: string | { id?: string } | null;
  paid?: boolean;
  status?: string;
  refunded?: boolean;
  disputed?: boolean;
  payment_method_details?: {
    type: string;
    card?: { brand?: string | null; last4?: string | null } | null;
  } | null;
  dispute?: string | null;
} | null;

function pickEvidenceFields(ev: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!ev) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ev)) {
    if (v == null || v === "") continue;
    out[k] = v;
  }
  return out;
}
