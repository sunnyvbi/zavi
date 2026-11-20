
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { requireTenantRole } from "@/services/auth/tenant-role";
import { serviceClient } from "@/services/supabase";
import { billingStripe } from "@/services/billing/client";
import { packTierForUsd } from "@/services/billing/plans";
import { getTierCreditsStrict } from "@/services/billing/credit-rate";
import { TOPUP_USD_PACKS, type PaidTier } from "@/services/billing/tiers";
import { isLiveShopifyPlan, MANAGED_IN_SHOPIFY } from "@/services/billing/store-rail";

const PUBLIC_BASE = (): string =>
  process.env.PRAXIS_PUBLIC_BASE ?? "https://www.zaviagent.com";

export async function billingTopup(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const stripe = billingStripe();
  if (!stripe) {
    res.status(503).json({ error: { code: "billing_not_configured", message: "Billing is not configured yet." } });
    return;
  }

  if (!(await requireTenantRole(auth, ["owner", "admin"], res))) return;

  const body = (req.body ?? {}) as { usd?: unknown };
  const packTier = packTierForUsd(body.usd);
  if (!packTier) {
    res.status(400).json({
      error: { code: "bad_amount", message: `usd must be one of ${TOPUP_USD_PACKS.join(", ")}` },
    });
    return;
  }
  const usd = body.usd as number;

  const { data: sub, error: subErr } = await serviceClient()
    .from("tenant_subscriptions")
    .select("stripe_customer_id, source, status")
    .eq("tenant_id", auth.tenant_id)
    .maybeSingle<{ stripe_customer_id: string | null; source: string | null; status: string | null }>();
  if (subErr) {
    res.status(500).json({ error: { code: "internal", message: subErr.message } });
    return;
  }
  if (isLiveShopifyPlan(sub)) {
    res.status(409).json(MANAGED_IN_SHOPIFY);
    return;
  }

  let tierCredits: Record<PaidTier, number>;
  try {
    tierCredits = await getTierCreditsStrict();
  } catch (e) {
    res.status(503).json({ error: { code: "credit_rate_unavailable", message: (e as Error).message } });
    return;
  }
  const credits = tierCredits[packTier];
  if (!(credits > 0)) {
    res.status(503).json({ error: { code: "pack_zero_credits", message: "pack credits not configured" } });
    return;
  }

  const unitAmountCents = usd * 100;

  const meta: Record<string, string> = {
    kind: "credit_topup",
    tenant_id: auth.tenant_id,
    credits: String(credits),
    usd_cents: String(unitAmountCents),
    pack_tier: packTier,
  };

  try {
    const session = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        payment_method_types: ["card"],
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: "usd",
              unit_amount: unitAmountCents,
              product_data: { name: `${credits.toLocaleString("en-US")} Zavi credits (one-time pack)` },
            },
          },
        ],
        ...(sub?.stripe_customer_id ? { customer: sub.stripe_customer_id } : {}),
        client_reference_id: auth.tenant_id,
        metadata: meta,
        payment_intent_data: { metadata: meta },
        success_url: `${PUBLIC_BASE()}/workspace?topup=success`,
        cancel_url: `${PUBLIC_BASE()}/workspace?topup=cancel`,
      },
      {
        idempotencyKey: `topup_${auth.tenant_id}_${usd}usd_c${credits}_${Math.floor(Date.now() / 60000)}`,
      },
    );
    res.json({ url: session.url });
  } catch (e) {
    res.status(502).json({ error: { code: "stripe_error", message: (e as Error).message } });
  }
}
