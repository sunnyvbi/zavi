
import { z } from "zod";
import { stripeClient, wrapStripeError } from "./_client";
import type { ToolSpec } from "@/services/tools/types";

const inputSchema = z.object({
  customer: z.string().optional().describe("Stripe customer id (cus_*) to filter to."),
  max_results: z.number().int().min(1).max(100).default(20),
});

export const listPaymentIntentsTool: ToolSpec = {
  name: "stripe_list_payment_intents",
  effect: "read",
  description:
    "List Stripe payment intents, optionally filtered by customer (cus_*). Returns id, customer, status, amount, currency, created, description. PaymentIntents are Stripe's modern payment primitive — many checkout / subscription flows produce intents, NOT direct charges. Use this when list_charges shows fewer items than expected for a customer.",
  input_schema: inputSchema,
  async execute(ctx, input: unknown) {
    const args = inputSchema.parse(input);
    const stripe = await stripeClient(ctx.tenant_id);
    try {
      const params: Record<string, unknown> = { limit: args.max_results };
      if (args.customer) params.customer = args.customer;
      const list = await stripe.paymentIntents.list(params);
      return {
        payment_intents: list.data.map((p) => ({
          id: p.id,
          customer: typeof p.customer === "string" ? p.customer : p.customer?.id ?? null,
          status: p.status,
          amount: p.amount,
          currency: p.currency,
          created: p.created,
          description: p.description,
        })),
        has_more: list.has_more,
      };
    } catch (e) {
      throw wrapStripeError(e);
    }
  },
};
