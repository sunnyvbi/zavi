
import { z } from "zod";
import type { ToolSpec } from "@/services/tools/types";
import { readTenantStripeGrossRevenue } from "@/services/analytics/stripe-gross-revenue";
import { readTenantStripeMrr } from "@/services/analytics/stripe-mrr";

const inputSchema = z.object({});

export const readRevenueTool: ToolSpec = {
  name: "growth_read_revenue",
  effect: "read",
  description:
    "Read the company's money from its connected Stripe, live: gross_revenue_30d_usd (succeeded payments in the last 30 days, before refunds) and subscription_mrr_usd (active subscriptions, monthly). Use it to check a revenue-shaped goal's number before you change the goal or question the founder: if the goal's number disagrees with this, say so with both numbers. available:false means Stripe is not connected or could not be read; say that, never guess a figure. Read-only.",
  input_schema: inputSchema,
  async execute(ctx) {
    const [gross, mrr] = await Promise.all([
      readTenantStripeGrossRevenue(ctx.tenant_id),
      readTenantStripeMrr(ctx.tenant_id),
    ]);
    return {
      gross_revenue_30d_usd: gross.available ? gross.gross_usd : null,
      gross_revenue_note: gross.available
        ? `${gross.meta.charge_count} succeeded payments in the last ${gross.meta.window_days} days (${gross.meta.currency}), before refunds`
        : `unavailable: ${gross.reason}`,
      subscription_mrr_usd: mrr.available ? mrr.mrr_usd : null,
      subscription_mrr: mrr.available ? mrr.mrr : null,
      subscription_mrr_currency: mrr.available ? mrr.currency : null,
      subscription_mrr_note: mrr.available
        ? [`${mrr.meta.sub_count} active subscriptions (${mrr.meta.currency})`, ...mrr.meta.caveats].join(" ")
        : `unavailable: ${mrr.reason}`,
      available: gross.available || mrr.available,
    };
  },
};
