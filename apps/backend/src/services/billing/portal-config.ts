
import type Stripe from "stripe";
import { PAID_TIERS } from "./tiers";
import { sixMonthPriceMismatch, tierPriceId, type BillingTerm } from "./plans";

const PURPOSE = "zavi_plan_change";

export type PlanChangePortalMode = "confirm" | "picker";

export function planChangePriceIds(term: BillingTerm): string[] {
  const ids = new Set<string>();
  for (const tier of PAID_TIERS) {
    const id = tierPriceId(tier, term);
    if (id) ids.add(id);
  }
  return [...ids].sort();
}

const CACHE = new Map<string, string>();

export function resetPlanChangePortalConfigCache(): void {
  CACHE.clear();
}

async function findExisting(
  stripe: Stripe,
  key: string,
  mode: PlanChangePortalMode,
  updates: string,
): Promise<string | null> {
  for await (const c of stripe.billingPortal.configurations.list({ active: true, limit: 100 })) {
    if (
      c.metadata?.purpose === PURPOSE &&
      c.metadata?.prices === key &&
      c.metadata?.mode === mode &&
      (c.metadata?.updates ?? "price") === updates
    ) {
      return c.id;
    }
  }
  return null;
}

export async function planChangePortalConfiguration(
  stripe: Stripe,
  term: BillingTerm = "monthly",
  mode: PlanChangePortalMode = "picker",
  { quantity = false }: { quantity?: boolean } = {},
): Promise<string> {
  const priceIds = planChangePriceIds(term);
  if (priceIds.length === 0) throw new Error(`no ${term} tier prices configured`);
  const key = priceIds.join(",");
  const allowedUpdates: Array<"price" | "quantity"> = quantity ? ["price", "quantity"] : ["price"];
  const updates = allowedUpdates.join(",");
  const variant = quantity ? `${mode}:qty` : mode;
  const cacheKey = `${variant}:${key}`;
  const cached = CACHE.get(cacheKey);
  if (cached) return cached;

  const existing = await findExisting(stripe, key, mode, updates);
  if (existing) {
    CACHE.set(cacheKey, existing);
    return existing;
  }

  const byProduct = new Map<string, string[]>();
  for (const id of priceIds) {
    const price = await stripe.prices.retrieve(id);
    if (term === "6mo") {
      for (const tier of PAID_TIERS.filter((t) => tierPriceId(t, term) === id)) {
        const mismatch = sixMonthPriceMismatch(tier, price);
        if (mismatch) throw new Error(`six-month ${tier} price does not match the quote: ${mismatch}`);
      }
    }
    const product = typeof price.product === "string" ? price.product : price.product.id;
    byProduct.set(product, [...(byProduct.get(product) ?? []), id]);
  }

  const created = await stripe.billingPortal.configurations.create(
    {
      features: {
        invoice_history: { enabled: true },
        payment_method_update: { enabled: true },
        subscription_cancel: { enabled: false },
        subscription_update: {
          enabled: true,
          default_allowed_updates: allowedUpdates,
          products: [...byProduct].map(([product, prices]) => ({ product, prices })),
          proration_behavior: "always_invoice",
          ...(mode === "picker"
            ? {
                schedule_at_period_end: {
                  conditions: [{ type: "decreasing_item_amount" as const }, { type: "shortening_interval" as const }],
                },
              }
            : {}),
        },
      },
      metadata: { purpose: PURPOSE, prices: key, mode, ...(quantity ? { updates } : {}) },
    },
    { idempotencyKey: `${PURPOSE}:${variant}:${key}` },
  );
  CACHE.set(cacheKey, created.id);
  return created.id;
}
