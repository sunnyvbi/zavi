import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { adsStripe, adsStripeKey, adsStripeMode } from "../stripe-client";
import { billingWebhookStripe } from "@/services/billing/client";
import Stripe from "stripe";

beforeEach(() => {
  vi.stubEnv("STRIPE_PLATFORM_SECRET_KEY", "sk_test_existing_platform");
  vi.stubEnv("STRIPE_ADS_SECRET_KEY", "");
});
afterEach(() => { vi.unstubAllEnvs(); });

it("preserves the shared platform account when no ads override exists", () => {
  expect(adsStripeKey()).toBe("sk_test_existing_platform");
  expect(adsStripeMode()).toBe("test");
  expect(adsStripe()).not.toBeNull();
});
it("isolates the ads override and refreshes only its cached client", () => {
  const shared = adsStripe();
  vi.stubEnv("STRIPE_ADS_SECRET_KEY", "rk_live_ads_account");
  expect(adsStripeKey()).toBe("rk_live_ads_account");
  expect(adsStripeMode()).toBe("live");
  expect(adsStripe()).not.toBe(shared);
  expect(adsStripe()).toBe(adsStripe());
  expect(process.env.STRIPE_PLATFORM_SECRET_KEY).toBe("sk_test_existing_platform");
});
it("does not change existing billing signature verification", () => {
  const payload = JSON.stringify({ id: "evt_billing", object: "event" });
  const sdk = new Stripe("sk_test_fixture");
  const signature = sdk.webhooks.generateTestHeaderString({ payload, secret: "whsec_billing" });
  vi.stubEnv("STRIPE_ADS_SECRET_KEY", "sk_live_ads_account");
  vi.stubEnv("STRIPE_ADS_WEBHOOK_SECRET", "whsec_ads");
  expect(billingWebhookStripe().webhooks.constructEvent(payload, signature, "whsec_billing").id).toBe("evt_billing");
  const adsSignature = sdk.webhooks.generateTestHeaderString({ payload, secret: "whsec_ads" });
  expect(() => billingWebhookStripe().webhooks.constructEvent(payload, adsSignature, "whsec_billing")).toThrow();
});
