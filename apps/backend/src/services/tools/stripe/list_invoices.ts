
import { z } from "zod";
import { stripeClient, wrapStripeError } from "./_client";
import type { ToolSpec } from "@/services/tools/types";

const inputSchema = z.object({
  customer: z.string().optional().describe("Stripe customer id (cus_*) to filter to."),
  status: z
    .enum(["draft", "open", "paid", "uncollectible", "void"])
    .optional()
    .describe("Filter to one invoice status."),
  max_results: z.number().int().min(1).max(100).default(20),
});

export const listInvoicesTool: ToolSpec = {
  name: "stripe_list_invoices",
  effect: "read",
  description:
    "List Stripe invoices, optionally filtered by customer (cus_*) and/or status (draft / open / paid / uncollectible / void). Returns id, customer, status, amounts, currency, dates, hosted_invoice_url. Use after resolving a customer via list_customers; for cross-customer status queries use search_stripe_resources.",
  input_schema: inputSchema,
  async execute(ctx, input: unknown) {
    const args = inputSchema.parse(input);
    const stripe = await stripeClient(ctx.tenant_id);
    try {
      const params: Record<string, unknown> = { limit: args.max_results };
      if (args.customer) params.customer = args.customer;
      if (args.status) params.status = args.status;
      const list = await stripe.invoices.list(params);
      return {
        invoices: list.data.map((i) => ({
          id: i.id,
          customer: typeof i.customer === "string" ? i.customer : i.customer?.id ?? null,
          status: i.status,
          amount_due: i.amount_due,
          amount_paid: i.amount_paid,
          currency: i.currency,
          created: i.created,
          due_date: i.due_date,
          hosted_invoice_url: i.hosted_invoice_url,
        })),
        has_more: list.has_more,
      };
    } catch (e) {
      throw wrapStripeError(e);
    }
  },
};
