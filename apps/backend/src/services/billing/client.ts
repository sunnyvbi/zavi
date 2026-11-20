
import Stripe from "stripe";
import { STRIPE_API_VERSION } from "@/services/tools/stripe/_platform-client";
import { billingConfigured } from "./plans";

let CACHED: { client: Stripe; key: string } | null = null;

export function billingStripe(): Stripe | null {
  if (!billingConfigured()) return null;
  const key = process.env.STRIPE_PLATFORM_SECRET_KEY as string;
  if (CACHED && CACHED.key === key) return CACHED.client;
  const client = new Stripe(key, {
    apiVersion: STRIPE_API_VERSION,
    appInfo: { name: "Zavi Billing", url: "https://zaviagent.com" },
    maxNetworkRetries: 1,
    timeout: 20_000,
  });
  CACHED = { client, key };
  return client;
}

export function requireBillingStripe(): Stripe {
  const client = billingStripe();
  if (!client) throw new Error("billing Stripe client not configured");
  return client;
}

let WEBHOOK_STRIPE: Stripe | null = null;
export function billingWebhookStripe(): Pick<Stripe, "webhooks"> {
  if (!WEBHOOK_STRIPE) {
    WEBHOOK_STRIPE = new Stripe("sk_placeholder_for_webhook_construct_only", {
      apiVersion: STRIPE_API_VERSION,
    });
  }
  return WEBHOOK_STRIPE;
}
