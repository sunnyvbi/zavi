
import Stripe from "stripe";
import { getSecret } from "@/services/secrets/vault";
import { ExpectedToolError } from "@/services/tools/types";

const STRIPE_SECRET_KEY = "stripe.api_key";

const CLIENT_CACHE = new Map<string, { client: Stripe; expiresAt: number }>();
const CLIENT_TTL_MS = 60 * 1000;

export async function stripeClient(tenant_id: string): Promise<Stripe> {
  const cached = CLIENT_CACHE.get(tenant_id);
  if (cached && cached.expiresAt > Date.now()) return cached.client;

  const apiKey = await getSecret(tenant_id, STRIPE_SECRET_KEY);
  if (!apiKey) {
    throw new ExpectedToolError(
      "stripe_not_connected",
      "Stripe is not connected for this workspace. Open Settings → Connectors and paste a restricted Stripe API key (scopes: charges read+write, disputes read+write, payouts read).",
    );
  }

  const client = new Stripe(apiKey, {
    apiVersion: "2025-02-24.acacia",
    appInfo: {
      name: "Zavi",
      url: "https://zaviagent.com",
    },
    maxNetworkRetries: 1,
    timeout: 20_000,
  });

  CLIENT_CACHE.set(tenant_id, { client, expiresAt: Date.now() + CLIENT_TTL_MS });
  return client;
}

export function wrapStripeError(e: unknown): ExpectedToolError {
  const err = e as { type?: string; code?: string; message?: string; statusCode?: number };
  if (err.type) {
    return new ExpectedToolError(
      `stripe_${err.type}`,
      err.message ?? "Stripe API error",
      { code: err.code, statusCode: err.statusCode },
    );
  }
  return new ExpectedToolError("stripe_unknown_error", (err as Error).message ?? String(e));
}
