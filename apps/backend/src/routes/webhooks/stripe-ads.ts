import type { Request, Response } from "express";
import { adsStripeMode, adsWebhookStripe } from "@/services/ads-wallet/stripe-client";
import { applyWalletEvent } from "@/services/ads-wallet/wallet";

export async function stripeAdsWebhook(req: Request, res: Response) {
  const secret = process.env.STRIPE_ADS_WEBHOOK_SECRET?.trim();
  const mode = adsStripeMode();
  if (!secret || !mode) { res.status(503).json({ error: "ads_billing_not_configured" }); return; }
  const signature = req.header("stripe-signature");
  if (!signature || !Buffer.isBuffer(req.body)) { res.status(400).json({ error: "bad_signature" }); return; }
  let event;
  try { event = adsWebhookStripe().webhooks.constructEvent(req.body, signature, secret); }
  catch { res.status(400).json({ error: "bad_signature" }); return; }
  if (event.livemode !== (mode === "live")) { res.status(400).json({ error: "mode_mismatch" }); return; }
  try { await applyWalletEvent(event); res.json({ ok: true }); }
  catch { res.status(500).json({ error: "ads_payment_not_applied" }); }
}
