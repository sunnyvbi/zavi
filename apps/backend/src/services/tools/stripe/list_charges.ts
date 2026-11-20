
import { z } from "zod";
import { stripeClient, wrapStripeError } from "./_client";
import type { ToolSpec } from "@/services/tools/types";

const inputSchema = z.object({
  customer: z.string().optional().describe("Stripe customer id (cus_*)"),
  limit: z.number().int().min(1).max(100).default(50),
  starting_after: z.string().optional(),
  created_gte_unix: z.number().int().optional().describe("Filter charges created >= this unix timestamp"),
  created_lte_unix: z.number().int().optional().describe("Filter charges created <= this unix timestamp"),
});

export const listChargesTool: ToolSpec = {
  name: "stripe_list_charges",
  effect: "read",
  description:
    "List Stripe charges with optional filters (customer id, date range). Returns id, amount, currency, status, refunded, dispute id (if any), payment method type. Useful for trust-safety triage + dispute history.",
  input_schema: inputSchema,
  async execute(ctx, input: unknown) {
    const args = inputSchema.parse(input);
    const stripe = await stripeClient(ctx.tenant_id);
    try {
      const params: Record<string, unknown> = {
        limit: args.limit,
      };
      if (args.customer) params.customer = args.customer;
      if (args.starting_after) params.starting_after = args.starting_after;
      const created: Record<string, number> = {};
      if (args.created_gte_unix) created.gte = args.created_gte_unix;
      if (args.created_lte_unix) created.lte = args.created_lte_unix;
      if (Object.keys(created).length > 0) params.created = created;

      const list = await stripe.charges.list(params);
      return {
        charges: list.data.map((c) => ({
          id: c.id,
          amount: c.amount,
          currency: c.currency,
          status: c.status,
          created: c.created,
          refunded: c.refunded,
          amount_refunded: c.amount_refunded,
          disputed: c.disputed,
          customer: typeof c.customer === "string" ? c.customer : c.customer?.id ?? null,
          payment_method_type: c.payment_method_details?.type ?? null,
        })),
        has_more: list.has_more,
      };
    } catch (e) {
      throw wrapStripeError(e);
    }
  },
};
