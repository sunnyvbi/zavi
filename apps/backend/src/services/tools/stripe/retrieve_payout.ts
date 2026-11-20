
import { z } from "zod";
import { stripeClient, wrapStripeError } from "./_client";
import type { ToolSpec } from "@/services/tools/types";

const inputSchema = z.object({
  payout_id: z.string().regex(/^po_/, "must be a Stripe payout id (po_*)"),
  list_balance_transactions: z.boolean().default(true),
});

export const retrievePayoutTool: ToolSpec = {
  name: "stripe_retrieve_payout",
  effect: "read",
  description:
    "Retrieve a Stripe payout + (optionally) the balance transactions that make it up. Used by payouts-recon to break a payout into per-transfer detail.",
  input_schema: inputSchema,
  async execute(ctx, input: unknown) {
    const { payout_id, list_balance_transactions } = inputSchema.parse(input);
    const stripe = await stripeClient(ctx.tenant_id);
    try {
      const payout = await stripe.payouts.retrieve(payout_id);
      const result: Record<string, unknown> = {
        id: payout.id,
        amount: payout.amount,
        currency: payout.currency,
        status: payout.status,
        arrival_date: payout.arrival_date,
        type: payout.type,
        method: payout.method,
        failure_code: payout.failure_code ?? null,
        failure_message: payout.failure_message ?? null,
      };
      if (list_balance_transactions) {
        const bts = await stripe.balanceTransactions.list({
          payout: payout_id,
          limit: 100,
        });
        result.balance_transactions = bts.data.map((bt) => ({
          id: bt.id,
          amount: bt.amount,
          fee: bt.fee,
          net: bt.net,
          type: bt.type,
          source: bt.source,
          description: bt.description,
          created: bt.created,
        }));
        result.balance_transactions_has_more = bts.has_more;
      }
      return result;
    } catch (e) {
      throw wrapStripeError(e);
    }
  },
};
