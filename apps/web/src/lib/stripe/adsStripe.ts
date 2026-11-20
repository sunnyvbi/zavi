import { loadStripe } from "@stripe/stripe-js/pure";
import type { Stripe } from "@stripe/stripe-js";

export const adsPublishableKey = (): string | null => process.env.NEXT_PUBLIC_STRIPE_ADS_PUBLISHABLE_KEY?.trim() || null;

let promise: Promise<Stripe | null> | null = null;
export function adsStripe(): Promise<Stripe | null> | null {
  const key = adsPublishableKey();
  if (!key) return null;
  if (!promise) promise = loadStripe(key);
  return promise;
}
