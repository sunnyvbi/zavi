
import { z } from "zod";
import { stripeClient, wrapStripeError } from "./_client";
import type { ToolSpec } from "@/services/tools/types";
import type Stripe from "stripe";

const inputSchema = z.object({
  resource: z
    .enum([
      "customers",
      "charges",
      "invoices",
      "subscriptions",
      "payment_intents",
      "products",
    ])
    .describe("Which Stripe resource collection to search."),
  query: z
    .string()
    .min(1)
    .describe(
      "Stripe search query DSL — e.g. \"email:'alice@acme.com'\", \"amount>1000 AND currency:'usd'\", \"metadata['order_id']:'12345'\".",
    ),
  max_results: z.number().int().min(1).max(100).default(20),
});

type SearchResource = z.infer<typeof inputSchema>["resource"];

export const searchStripeResourcesTool: ToolSpec = {
  name: "stripe_search_stripe_resources",
  effect: "read",
  description:
    "Generic search across Stripe resources (customers, charges, invoices, subscriptions, payment_intents, products) using Stripe's query DSL. The DSL supports field equality (`email:'a@b.com'`), comparison (`amount>1000`), metadata lookup (`metadata['order_id']:'12345'`), and AND combinations. Examples: (a) email-based customer search → search_stripe_resources(resource='customers', query=\"email:'alice@acme.com'\"); (b) metadata-tagged charge search → search_stripe_resources(resource='charges', query=\"metadata['order_id']:'12345'\"). Use this when list_customers / list_charges with their exact-match filters won't cut it.",
  input_schema: inputSchema,
  async execute(ctx, input: unknown) {
    const args = inputSchema.parse(input);
    const stripe = await stripeClient(ctx.tenant_id);
    try {
      const params = { query: args.query, limit: args.max_results };
      let raw: { data: unknown[]; has_more: boolean };
      switch (args.resource as SearchResource) {
        case "customers":
          raw = (await stripe.customers.search(params)) as unknown as { data: Stripe.Customer[]; has_more: boolean };
          break;
        case "charges":
          raw = (await stripe.charges.search(params)) as unknown as { data: Stripe.Charge[]; has_more: boolean };
          break;
        case "invoices":
          raw = (await stripe.invoices.search(params)) as unknown as { data: Stripe.Invoice[]; has_more: boolean };
          break;
        case "subscriptions":
          raw = (await stripe.subscriptions.search(params)) as unknown as { data: Stripe.Subscription[]; has_more: boolean };
          break;
        case "payment_intents":
          raw = (await stripe.paymentIntents.search(params)) as unknown as { data: Stripe.PaymentIntent[]; has_more: boolean };
          break;
        case "products":
          raw = (await stripe.products.search(params)) as unknown as { data: Stripe.Product[]; has_more: boolean };
          break;
      }
      return {
        resource: args.resource,
        query: args.query,
        results: raw.data,
        has_more: raw.has_more,
      };
    } catch (e) {
      throw wrapStripeError(e);
    }
  },
};
