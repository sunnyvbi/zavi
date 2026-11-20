
import { z } from "zod";
import { stripeClient, wrapStripeError } from "./_client";
import type { ToolSpec } from "@/services/tools/types";

const inputSchema = z.object({
  email: z
    .string()
    .optional()
    .describe(
      "Filter to customers with this exact email. If omitted, lists recent customers.",
    ),
  max_results: z.number().int().min(1).max(100).default(20),
});

export const listCustomersTool: ToolSpec = {
  name: "stripe_list_customers",
  effect: "read",
  description:
    "List or lookup Stripe customers. With `email`, filters server-side to customers matching that exact email — use this to resolve a person to their cus_id (Stripe's mandatory filter primitive for downstream calls). Without `email`, returns recent customers. Stripe IDs are mandatory for filtering charges / invoices / payment intents; email + name are display only. Example: user asks 'find customer alice@acme.com' → list_customers(email='alice@acme.com') → take id (cus_*) → use with list_charges / list_invoices / list_payment_intents.",
  input_schema: inputSchema,
  async execute(ctx, input: unknown) {
    const args = inputSchema.parse(input);
    const stripe = await stripeClient(ctx.tenant_id);
    try {
      const params: Record<string, unknown> = { limit: args.max_results };
      if (args.email) params.email = args.email;
      const list = await stripe.customers.list(params);
      return {
        customers: list.data.map((c) => ({
          id: c.id,
          email: c.email,
          name: c.name,
          created: c.created,
          balance: c.balance,
          currency: c.currency,
          default_source:
            typeof c.default_source === "string"
              ? c.default_source
              : c.default_source?.id ?? null,
        })),
        has_more: list.has_more,
      };
    } catch (e) {
      throw wrapStripeError(e);
    }
  },
};
