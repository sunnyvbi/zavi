
import { createHash } from "node:crypto";
import type { Request, Response } from "express";
import type Stripe from "stripe";
import { requireAuth } from "@/services/auth/middleware";
import { requireTenantRole } from "@/services/auth/tenant-role";
import { serviceClient } from "@/services/supabase";
import { billingStripe } from "@/services/billing/client";
import {
  isBillingTerm,
  sixMonthPriceMismatch,
  tierPriceId,
  type BillingTerm,
} from "@/services/billing/plans";
import { isPaidTier, PAID_TIERS } from "@/services/billing/tiers";
import { isLiveStorePlan, managedElsewhere } from "@/services/billing/store-rail";
import { logEvent } from "@/services/logging/logEvent";
import { attributeTenant } from "@/services/affiliates/attribution";

const PUBLIC_BASE = (): string =>
  process.env.PRAXIS_PUBLIC_BASE ?? "https://www.zaviagent.com";

export const ACTIVE_STATUSES = new Set(["active", "trialing", "past_due"]);

const CANCEL_RETURN = new Map<string, string>([
  ["pricing", "/pricing?billing=cancel"],
  ["workspace", "/workspace?tab=settings&billing=cancel"],
]);
const CANCEL_DEFAULT_KEY = "pricing";
function cancelKeyFor(origin: unknown): string {
  return typeof origin === "string" && CANCEL_RETURN.has(origin) ? origin : CANCEL_DEFAULT_KEY;
}

export function checkoutIdempotencyKey(tenantId: string, tier: string, params: object): string {
  const digest = createHash("sha256").update(JSON.stringify(params)).digest("hex").slice(0, 16);
  return `co_${tenantId}_tier_${tier}_${digest}`;
}

export async function billingCheckout(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const stripe = billingStripe();
  if (!stripe) {
    res
      .status(503)
      .json({ error: { code: "billing_not_configured", message: "Billing is not configured yet." } });
    return;
  }

  if (!(await requireTenantRole(auth, ["owner", "admin"], res))) return;

  const body = (req.body ?? {}) as { tier?: unknown; term?: unknown; origin?: unknown; affiliate_click?: unknown };
  const tier = body.tier;
  if (!isPaidTier(tier)) {
    res.status(400).json({ error: { code: "bad_tier", message: `tier must be one of ${PAID_TIERS.join(", ")}` } });
    return;
  }
  if (body.term !== undefined && !isBillingTerm(body.term)) {
    res.status(400).json({ error: { code: "bad_term", message: 'term must be "monthly" or "6mo"' } });
    return;
  }
  const term: BillingTerm = isBillingTerm(body.term) ? body.term : "monthly";
  const price = tierPriceId(tier, term);
  if (!price) {
    res.status(503).json({ error: { code: "price_not_configured", message: `no ${term} price for ${tier}` } });
    return;
  }
  const cancelKey = cancelKeyFor(body.origin);

  const { data: sub, error: subErr } = await serviceClient()
    .from("tenant_subscriptions")
    .select("stripe_customer_id, stripe_subscription_id, status, source")
    .eq("tenant_id", auth.tenant_id)
    .maybeSingle<{
      stripe_customer_id: string | null;
      stripe_subscription_id: string | null;
      status: string;
      source: string | null;
    }>();
  if (subErr) {
    res.status(500).json({ error: { code: "internal", message: subErr.message } });
    return;
  }

  if (isLiveStorePlan(sub)) {
    res.status(409).json(managedElsewhere(sub));
    return;
  }

  try {
    if (sub?.stripe_customer_id && sub.stripe_subscription_id && ACTIVE_STATUSES.has(sub.status)) {
      const { changePlanFromCheckout } = await import("./subscription");
      await changePlanFromCheckout(req, res);
      return;
    }

    if (term === "6mo") {
      const mismatch = sixMonthPriceMismatch(tier, await stripe.prices.retrieve(price));
      if (mismatch) {
        await logEvent({
          level: "error", source: "billing-checkout", code: "billing.six_month_price_mismatch",
          message: `six-month ${tier} price does not match the quote: ${mismatch}`,
          tenant_id: auth.tenant_id,
        });
        res.status(503).json({
          error: { code: "price_misconfigured", message: `the ${term} price for ${tier} does not match the quoted price` },
        });
        return;
      }
    }

    await attributeTenant({ tenantId: auth.tenant_id, click: body.affiliate_click, door: "checkout", email: null, userId: auth.user_id ?? null });

    const meta: Record<string, string> = { tenant_id: auth.tenant_id, tier, term };
    const params: Stripe.Checkout.SessionCreateParams = {
      mode: "subscription",
      line_items: [{ price, quantity: 1 }],
      ...(sub?.stripe_customer_id ? { customer: sub.stripe_customer_id } : {}),
      client_reference_id: auth.tenant_id,
      metadata: meta,
      subscription_data: { metadata: meta },
      allow_promotion_codes: true,
      success_url: `${PUBLIC_BASE()}/workspace?tab=settings&billing=success#billing`,
      cancel_url: `${PUBLIC_BASE()}${CANCEL_RETURN.get(cancelKey)}`,
    };
    const session = await stripe.checkout.sessions.create(params, {
      idempotencyKey: checkoutIdempotencyKey(auth.tenant_id, tier, params),
    });

    res.json({ url: session.url });
  } catch (e) {
    res.status(502).json({ error: { code: "stripe_error", message: (e as Error).message } });
  }
}
