
import { z } from "zod";
import { stripeClient, wrapStripeError } from "./_client";
import type { ToolSpec } from "@/services/tools/types";

const inputSchema = z.object({
  limit: z.number().int().min(1).max(100).default(50),
  starting_after: z.string().optional(),
  arrival_date_gte_unix: z.number().int().optional(),
  arrival_date_lte_unix: z.number().int().optional(),
  status: z.enum(["paid", "pending", "in_transit", "canceled", "failed"]).optional(),
});

export const listPayoutsTool: ToolSpec = {
  name: "stripe_list_payouts",
  effect: "read",
  description:
    "List Stripe payouts with optional filters (arrival date range, status). Returns id, amount, currency, status, arrival_date, type. Used by payouts-recon.",
  input_schema: inputSchema,
  async execute(ctx, input: unknown) {
    const args = inputSchema.parse(input);
    const stripe = await stripeClient(ctx.tenant_id);
    try {
      const params: Record<string, unknown> = {
        limit: args.limit,
      };
      if (args.starting_after) params.starting_after = args.starting_after;
      if (args.status) params.status = args.status;
      const arrival: Record<string, number> = {};
      if (args.arrival_date_gte_unix) arrival.gte = args.arrival_date_gte_unix;
      if (args.arrival_date_lte_unix) arrival.lte = args.arrival_date_lte_unix;
      if (Object.keys(arrival).length > 0) params.arrival_date = arrival;

      const list = await stripe.payouts.list(params);
      return {
        payouts: list.data.map((p) => ({
          id: p.id,
          amount: p.amount,
          currency: p.currency,
          status: p.status,
          arrival_date: p.arrival_date,
          type: p.type,
          method: p.method,
          failure_code: p.failure_code ?? null,
          failure_message: p.failure_message ?? null,
        })),
        has_more: list.has_more,
      };
    } catch (e) {
      throw wrapStripeError(e);
    }
  },
};
