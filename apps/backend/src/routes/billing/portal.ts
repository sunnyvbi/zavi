
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { requireTenantRole } from "@/services/auth/tenant-role";
import { serviceClient } from "@/services/supabase";
import { billingStripe } from "@/services/billing/client";
import { isLiveStorePlan, managedElsewhere } from "@/services/billing/store-rail";

const PUBLIC_BASE = (): string =>
  process.env.PRAXIS_PUBLIC_BASE ?? "https://www.zaviagent.com";

export async function billingPortal(req: Request, res: Response): Promise<void> {
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

  const { data: sub, error } = await serviceClient()
    .from("tenant_subscriptions")
    .select("stripe_customer_id, source, status")
    .eq("tenant_id", auth.tenant_id)
    .maybeSingle<{ stripe_customer_id: string | null; source: string | null; status: string | null }>();
  if (error) {
    res.status(500).json({ error: { code: "internal", message: error.message } });
    return;
  }
  if (isLiveStorePlan(sub)) {
    res.status(409).json(managedElsewhere(sub));
    return;
  }
  if (!sub?.stripe_customer_id) {
    res.status(400).json({ error: { code: "no_customer", message: "No subscription to manage. Pick a plan first." } });
    return;
  }

  try {
    const portal = await stripe.billingPortal.sessions.create({
      customer: sub.stripe_customer_id,
      return_url: `${PUBLIC_BASE()}/workspace?tab=settings#billing`,
    });
    res.json({ url: portal.url });
  } catch (e) {
    res.status(502).json({ error: { code: "stripe_error", message: (e as Error).message } });
  }
}
