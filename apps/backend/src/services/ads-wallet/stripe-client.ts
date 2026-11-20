import Stripe from "stripe";
import { STRIPE_API_VERSION } from "@/services/tools/stripe/_platform-client";

export function adsStripeKey(): string | undefined {
  return process.env.STRIPE_ADS_SECRET_KEY?.trim() || process.env.STRIPE_PLATFORM_SECRET_KEY?.trim() || undefined;
}
export function adsStripeMode(): "test" | "live" | null {
  const match = adsStripeKey()?.match(/^(?:sk|rk)_(test|live)_/);
  return match ? match[1] as "test" | "live" : null;
}

let cached: { key: string; client: Stripe } | undefined;
export function adsStripe(): Stripe | null {
  const key = adsStripeKey();
  if (!key || !adsStripeMode()) return null;
  if (!cached || cached.key !== key) cached = { key, client: new Stripe(key, {
    apiVersion: STRIPE_API_VERSION, maxNetworkRetries: 1, timeout: 20_000,
    appInfo: { name: "Zavi Ads", url: "https://zaviagent.com" },
  }) };
  return cached.client;
}
export function requireAdsStripe(): Stripe {
  const client = adsStripe();
  if (!client) throw new Error("Ads Stripe client is not configured");
  return client;
}

const webhookClient = new Stripe("sk_placeholder_for_ads_signature_only", { apiVersion: STRIPE_API_VERSION });
export const adsWebhookStripe = (): Pick<Stripe, "webhooks"> => webhookClient;
