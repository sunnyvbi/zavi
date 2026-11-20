
import type Stripe from "stripe";
import { stripeClient } from "@/services/tools/stripe/_client";
import { ExpectedToolError } from "@/services/tools/types";

export type MrrExcludedItem = {
  subscription_id: string;
  price_id: string | null;
  reason: "metered" | "tiered" | "no_unit_amount";
};

export type TenantStripeMrr =
  | {
      available: true;
      mrr: number;
      currency: string;
      mrr_usd: number | null;
      meta: {
        sub_count: number;
        currency: string;
        excluded_items: MrrExcludedItem[];
        caveats: string[];
      };
    }
  | { available: false; reason: string };

const PAGE_LIMIT = 100;
const MAX_PAGES = 10;

function periodMonths(recurring: { interval: string; interval_count?: number | null }): number | null {
  const count = recurring.interval_count || 1;
  switch (recurring.interval) {
    case "month":
      return count;
    case "year":
      return 12 * count;
    case "week":
      return (12 * count) / 52;
    case "day":
      return (12 * count) / 365;
    default:
      return null;
  }
}

type ItemRead =
  | { kind: "amount"; cents: number; currency: string | undefined; months: number }
  | { kind: "excluded"; reason: MrrExcludedItem["reason"] }
  | { kind: "skip" };

function readItem(item: Stripe.SubscriptionItem): ItemRead {
  const price = item.price;
  const recurring = price?.recurring;
  if (!recurring) return { kind: "skip" };
  if (recurring.usage_type === "metered") return { kind: "excluded", reason: "metered" };
  if (price.billing_scheme === "tiered") return { kind: "excluded", reason: "tiered" };
  const unit =
    price.unit_amount != null
      ? price.unit_amount
      : price.unit_amount_decimal != null
        ? Number(price.unit_amount_decimal)
        : null;
  if (unit == null || !Number.isFinite(unit)) return { kind: "excluded", reason: "no_unit_amount" };
  const months = periodMonths(recurring);
  if (months == null) return { kind: "skip" };
  const quantity = item.quantity ?? 1;
  return { kind: "amount", cents: (unit * quantity) / months, currency: price.currency, months };
}

function subDiscounts(sub: Stripe.Subscription): { discounts: Stripe.Discount[]; unexpanded: number } {
  const byId = new Map<string, Stripe.Discount>();
  const legacy = (sub as { discount?: Stripe.Discount | null }).discount;
  if (legacy) byId.set(legacy.id, legacy);
  let unexpanded = 0;
  for (const d of sub.discounts ?? []) {
    if (typeof d !== "string") byId.set(d.id, d);
    else if (!byId.has(d) && d !== legacy?.id) unexpanded++;
  }
  return { discounts: [...byId.values()], unexpanded };
}

export async function readTenantStripeMrr(tenant_id: string): Promise<TenantStripeMrr> {
  let stripe: Stripe;
  try {
    stripe = await stripeClient(tenant_id);
  } catch (e) {
    if (e instanceof ExpectedToolError && e.code === "stripe_not_connected") {
      return { available: false, reason: "not_connected" };
    }
    return { available: false, reason: "read_failed" };
  }

  try {
    const subs: Stripe.Subscription[] = [];
    let startingAfter: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await stripe.subscriptions.list({
        status: "active",
        limit: PAGE_LIMIT,
        expand: ["data.discounts", "data.discounts.coupon.applies_to"],
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
      subs.push(...res.data);
      if (!res.has_more) break;
      if (page === MAX_PAGES - 1) {
        return { available: false, reason: "read_failed" };
      }
      startingAfter = res.data[res.data.length - 1]?.id;
      if (!startingAfter) return { available: false, reason: "read_failed" };
    }

    const active = subs.filter((s) => s.status === "active");
    const nowSec = Date.now() / 1000;

    let currency: string | null = null;
    let totalCents = 0;
    const excluded: MrrExcludedItem[] = [];
    let onceSkipped = 0;
    let unexpandedDiscounts = 0;
    for (const sub of active) {
      let subCents = 0;
      let subMonths: number | null = null;
      for (const item of sub.items?.data ?? []) {
        const read = readItem(item);
        if (read.kind === "skip") continue;
        if (read.kind === "excluded") {
          excluded.push({ subscription_id: sub.id, price_id: item.price?.id ?? null, reason: read.reason });
          continue;
        }
        if (!read.currency) return { available: false, reason: "read_failed" };
        if (currency === null) currency = read.currency;
        else if (currency !== read.currency) {
          return { available: false, reason: "multi_currency" };
        }
        if ((item.discounts ?? []).length > 0) return { available: false, reason: "discount_unsupported" };
        subCents += read.cents;
        subMonths ??= read.months;
      }

      const { discounts, unexpanded } = subDiscounts(sub);
      unexpandedDiscounts += unexpanded;
      for (const d of discounts) {
        if (d.end != null && d.end <= nowSec) continue;
        const coupon = d.coupon;
        if (!coupon) continue;
        if ((coupon.applies_to?.products ?? []).length > 0) {
          return { available: false, reason: "discount_unsupported" };
        }
        if (coupon.duration === "once") {
          onceSkipped++;
          continue;
        }
        if (coupon.percent_off != null) {
          subCents *= 1 - coupon.percent_off / 100;
        } else if (coupon.amount_off != null && subMonths != null) {
          if (coupon.currency && currency && coupon.currency !== currency) {
            return { available: false, reason: "multi_currency" };
          }
          subCents -= coupon.amount_off / subMonths;
        }
      }
      totalCents += Math.max(0, subCents);
    }

    const caveats: string[] = [];
    if (excluded.length > 0) {
      caveats.push(
        `${excluded.length} metered or tiered subscription item(s) are not counted: usage revenue has no committed monthly amount.`,
      );
    }
    if (onceSkipped > 0) caveats.push(`${onceSkipped} one-time coupon(s) not applied: they discount a single invoice.`);
    if (unexpandedDiscounts > 0) caveats.push(`${unexpandedDiscounts} discount(s) could not be read and are not applied.`);

    const cur = currency ?? "usd";
    const mrr = Math.round(totalCents) / 100;
    return {
      available: true,
      mrr,
      currency: cur,
      mrr_usd: cur === "usd" ? mrr : null,
      meta: { sub_count: active.length, currency: cur, excluded_items: excluded, caveats },
    };
  } catch {
    return { available: false, reason: "read_failed" };
  }
}
