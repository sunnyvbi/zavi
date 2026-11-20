
import type { Request, Response } from "express";
import { z } from "zod";
import Stripe from "stripe";
import { requireAuth } from "@/services/auth/middleware";
import { serviceClient } from "@/services/supabase";
import { STRIPE_API_VERSION } from "@/services/tools/stripe/_platform-client";
import { notifyFounderActivity } from "@/services/tenants/founder-activity-alert";
import { autoSetCompanyCountryInBackground, recordAccountGeo } from "@/services/company/country-inference";

const bodySchema = z.object({
  api_key: z
    .string()
    .trim()
    .min(12)
    .refine((k) => k.startsWith("rk_") || k.startsWith("sk_"), {
      message:
        "Use a Stripe secret or restricted key (starts with rk_ or sk_), not a publishable key.",
    }),
});

export async function stripeConnect(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: "invalid_body",
        message: parsed.error.issues.map((i) => i.message).join("; "),
      },
    });
    return;
  }

  const { api_key } = parsed.data;

  const probe = new Stripe(api_key, {
    apiVersion: STRIPE_API_VERSION,
    appInfo: { name: "Zavi", url: "https://zaviagent.com" },
    maxNetworkRetries: 1,
    timeout: 20_000,
  });

  try {
    await probe.charges.list({ limit: 1 });
  } catch (e) {
    const err = e as { type?: string; code?: string; statusCode?: number };
    console.error("stripe_connect_validate_failed", {
      tenant_id: auth.tenant_id,
      error_type: err.type ?? "unknown",
      error_code: err.code ?? null,
      status: err.statusCode ?? null,
    });
    res.status(400).json({
      error: {
        code: "stripe_key_invalid",
        message:
          "Stripe rejected this key. Use a live secret key (sk_live_…) or a restricted key with Charges: Read (add Disputes: Read/Write and Payouts: Read so the dispute and payout agents can work).",
      },
    });
    return;
  }

  let account: Stripe.Account | null = null;
  try {
    account = await probe.accounts.retrieve();
  } catch {
    console.warn("stripe_connect_account_metadata_unavailable", {
      tenant_id: auth.tenant_id,
    });
  }

  const capabilities = Object.entries(account?.capabilities ?? {})
    .filter(([, v]) => v === "active")
    .map(([k]) => k);

  const { error } = await serviceClient().rpc("set_stripe_connection", {
    p_tenant_id: auth.tenant_id,
    p_api_key: api_key,
    p_account_id: account?.id ?? null,
    p_account_email: account?.email ?? null,
    p_country: account?.country ?? null,
    p_default_currency: account?.default_currency ?? null,
    p_capabilities: capabilities,
  });

  if (error) {
    console.error("stripe_connect_failed", {
      tenant_id: auth.tenant_id,
      error_code: error.code,
    });
    res.status(500).json({
      error: {
        code: "stripe_connect_failed",
        message: "Failed to save Stripe connection. Check server logs.",
      },
    });
    return;
  }

  if (account?.country) {
    await recordAccountGeo(auth.tenant_id, "stripe", { for: account.id ?? null, countries: [account.country], timezones: [] });
  }
  autoSetCompanyCountryInBackground(auth.tenant_id);

  void notifyFounderActivity({ event: "first_connector", tenant_id: auth.tenant_id, user_id: auth.user_id, details: { connector: "stripe" } });
  res.json({
    ok: true,
    account_id: account?.id ?? null,
    account_email: account?.email ?? null,
    country: account?.country ?? null,
    capabilities,
  });
}
