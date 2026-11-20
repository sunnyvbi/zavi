
import type { Request, Response } from "express";
import type Stripe from "stripe";
import { requireAuth } from "@/services/auth/middleware";
import { tenantClient } from "@/services/tenant-client";
import { billingStripe } from "@/services/billing/client";

const LIMIT = 12;

const SHOWN = new Set(["paid", "open", "uncollectible"]);

export async function billingInvoices(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const stripe = billingStripe();
  if (!stripe) {
    res
      .status(503)
      .json({ error: { code: "billing_not_configured", message: "Billing is not configured yet." } });
    return;
  }

  const { data: sub, error } = await tenantClient(auth.tenant_id)
    .from("tenant_subscriptions")
    .select("stripe_customer_id")
    .maybeSingle<{ stripe_customer_id: string | null }>();
  if (error) {
    res.status(500).json({ error: { code: "internal", message: error.message } });
    return;
  }
  if (!sub?.stripe_customer_id) {
    res.json({ invoices: [] });
    return;
  }

  try {
    const page = await stripe.invoices.list({ customer: sub.stripe_customer_id, limit: LIMIT });
    res.json({ invoices: page.data.filter((i) => SHOWN.has(i.status ?? "")).map(shape) });
  } catch (e) {
    res.status(502).json({ error: { code: "stripe_error", message: (e as Error).message } });
  }
}

function shape(i: Stripe.Invoice): {
  id: string;
  number: string | null;
  created: number;
  amount_due_usd: number;
  status: string | null;
  pdf_url: string | null;
} {
  const cents = i.status === "paid" ? i.amount_paid : i.amount_due;
  return {
    id: i.id,
    number: i.number ?? null,
    created: i.created,
    amount_due_usd: (typeof cents === "number" ? cents : 0) / 100,
    status: i.status ?? null,
    pdf_url: i.invoice_pdf ?? i.hosted_invoice_url ?? null,
  };
}
