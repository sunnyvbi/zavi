
import { z } from "zod";
import { stripeClient, wrapStripeError } from "@/services/tools/stripe/_client";
import type { ToolSpec } from "@/services/tools/types";

const inputSchema = z.object({
  months: z.number().int().min(1).max(24).default(6),
  blended_cac_usd: z.number().positive().optional(),
});

const MAX_CUSTOMER_PAGES = 10;
const MAX_CHARGE_PAGES = 20;

type CohortAccum = {
  cohort: string;
  signups: number;
  revenue_minor: number;
  refunded_minor: number;
};

export const readCohortTool: ToolSpec = {
  name: "growth_read_cohort",
  effect: "read",
  description:
    "Read revenue-per-signup cohorts from Stripe. Groups customers by signup month, sums each cohort's succeeded-charge revenue (minus refunds), and reports revenue-per-signup. With an operator-supplied blended_cac_usd, also reports a payback proxy. Read-only — no money writes. Returns cohort_not_connected ONLY when Stripe is absent; when connected this is real revenue data, not a manual lever.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const { months, blended_cac_usd } = inputSchema.parse(input);
    let stripe;
    try {
      stripe = await stripeClient(ctx.tenant_id);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "stripe_not_connected") {
        const { ExpectedToolError } = await import("@/services/tools/types");
        throw new ExpectedToolError(
          "cohort_not_connected",
          "Stripe is not connected for this workspace, so cohort revenue can't be derived. Treat retention as a manual operator lever; connect Stripe at /connectors to enable real revenue-per-signup cohorts.",
        );
      }
      throw e;
    }

    const sinceUnix = Math.floor(Date.now() / 1000) - months * 31 * 86400;

    try {
      const customerCohort = new Map<string, string>();
      const cohorts = new Map<string, CohortAccum>();
      let custTruncated = false;
      let custStartingAfter: string | undefined;
      for (let page = 0; page < MAX_CUSTOMER_PAGES; page++) {
        const params: Record<string, unknown> = {
          limit: 100,
          created: { gte: sinceUnix },
        };
        if (custStartingAfter) params.starting_after = custStartingAfter;
        const list = await stripe.customers.list(params);
        for (const c of list.data) {
          const cohort = monthBucket(c.created);
          customerCohort.set(c.id, cohort);
          const acc = cohorts.get(cohort) ?? emptyCohort(cohort);
          acc.signups += 1;
          cohorts.set(cohort, acc);
        }
        if (!list.has_more) break;
        custStartingAfter = list.data[list.data.length - 1]?.id;
        if (page === MAX_CUSTOMER_PAGES - 1 && list.has_more) custTruncated = true;
      }

      let chargeTruncated = false;
      let unattributed_minor = 0;
      let chargeStartingAfter: string | undefined;
      let currency: string | null = null;
      for (let page = 0; page < MAX_CHARGE_PAGES; page++) {
        const params: Record<string, unknown> = {
          limit: 100,
          created: { gte: sinceUnix },
        };
        if (chargeStartingAfter) params.starting_after = chargeStartingAfter;
        const list = await stripe.charges.list(params);
        for (const ch of list.data) {
          if (ch.status !== "succeeded") continue;
          if (currency == null) currency = ch.currency;
          const net = (ch.amount ?? 0) - (ch.amount_refunded ?? 0);
          const cusId = typeof ch.customer === "string" ? ch.customer : ch.customer?.id ?? null;
          const cohort = cusId ? customerCohort.get(cusId) : undefined;
          if (!cohort) {
            unattributed_minor += net;
            continue;
          }
          const acc = cohorts.get(cohort) ?? emptyCohort(cohort);
          acc.revenue_minor += net;
          acc.refunded_minor += ch.amount_refunded ?? 0;
          cohorts.set(cohort, acc);
        }
        if (!list.has_more) break;
        chargeStartingAfter = list.data[list.data.length - 1]?.id;
        if (page === MAX_CHARGE_PAGES - 1 && list.has_more) chargeTruncated = true;
      }

      const sorted = [...cohorts.values()].sort((a, b) => (a.cohort < b.cohort ? 1 : -1));
      const rows = sorted.map((c) => {
        const revenue = minorToMajor(c.revenue_minor);
        const revPerSignup = c.signups > 0 ? round2(revenue / c.signups) : null;
        const paybackRatio =
          blended_cac_usd != null && revPerSignup != null
            ? round2(revPerSignup / blended_cac_usd)
            : null;
        return {
          cohort: c.cohort,
          signups: c.signups,
          revenue: revenue,
          revenue_per_signup: revPerSignup,
          payback_ratio: paybackRatio,
        };
      });

      return {
        connected: true,
        currency: currency ?? null,
        months,
        blended_cac_usd: blended_cac_usd ?? null,
        cohorts: rows,
        unattributed_revenue: minorToMajor(unattributed_minor),
        truncated: custTruncated || chargeTruncated,
        truncation_note:
          custTruncated || chargeTruncated
            ? `Scanned the most recent ${MAX_CUSTOMER_PAGES * 100} customers / ${MAX_CHARGE_PAGES * 100} charges in the window — older rows omitted for cost. Numbers are a recent-window read, not a full ledger export.`
            : null,
        limitation:
          "Revenue is attributed to each customer's Stripe signup month. Charges from customers created before the window appear as unattributed_revenue. Assumes a single charge currency; mixed-currency accounts will sum minor units across currencies.",
      };
    } catch (e) {
      throw wrapStripeError(e);
    }
  },
};

function emptyCohort(cohort: string): CohortAccum {
  return { cohort, signups: 0, revenue_minor: 0, refunded_minor: 0 };
}

function monthBucket(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${d.getUTCFullYear()}-${m}`;
}

function minorToMajor(minor: number): number {
  return round2(minor / 100);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
