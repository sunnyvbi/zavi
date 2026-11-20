
import type Stripe from "stripe";
import { stripeClient } from "@/services/tools/stripe/_client";
import { ExpectedToolError } from "@/services/tools/types";

export type TenantStripeGrossRevenue =
  | { available: true; gross_usd: number; meta: { charge_count: number; currency: string; window_days: number } }
  | { available: false; reason: string };

const PAGE_LIMIT = 100;
const MAX_PAGES = 100;

export async function readTenantStripeGrossRevenue(
  tenant_id: string,
  now: Date = new Date(),
  days = 30,
): Promise<TenantStripeGrossRevenue> {
  let stripe: Stripe;
  try {
    stripe = await stripeClient(tenant_id);
  } catch (e) {
    if (e instanceof ExpectedToolError && e.code === "stripe_not_connected") {
      return { available: false, reason: "not_connected" };
    }
    return { available: false, reason: "read_failed" };
  }
  const since = Math.floor(now.getTime() / 1000) - days * 86_400;
  try {
    let totalCents = 0;
    let count = 0;
    let currency: string | null = null;
    let startingAfter: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await stripe.charges.list({
        created: { gte: since },
        limit: PAGE_LIMIT,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
      for (const c of res.data) {
        if (c.status !== "succeeded" || !c.captured) continue;
        if (c.currency !== "usd") return { available: false, reason: "non_usd_currency" };
        currency = c.currency;
        totalCents += c.amount;
        count++;
      }
      if (!res.has_more) {
        return {
          available: true,
          gross_usd: Math.round(totalCents) / 100,
          meta: { charge_count: count, currency: currency ?? "usd", window_days: days },
        };
      }
      startingAfter = res.data[res.data.length - 1]?.id;
      if (!startingAfter) return { available: false, reason: "read_failed" };
    }
    return { available: false, reason: "too_many_charges" };
  } catch {
    return { available: false, reason: "read_failed" };
  }
}
