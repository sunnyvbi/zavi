
import type Stripe from "stripe";
import { ExpectedToolError } from "@/services/tools/types";
import { platformStripeClient } from "@/services/tools/stripe/_platform-client";

export function creatorPaymentsEnabled(): boolean {
  return process.env.CREATOR_PAYMENTS_ENABLED !== "0";
}

export function creatorStripeClient(): Stripe {
  const stripe = platformStripeClient({ enabled: creatorPaymentsEnabled });
  return stripe;
}

export function platformKeyLivemode(key = process.env.STRIPE_PLATFORM_SECRET_KEY ?? null): boolean {
  if (!key) {
    throw new ExpectedToolError(
      "stripe_platform_not_configured",
      "The Stripe platform key is not set, so creator payments are inert.",
    );
  }
  if (key.includes("_test_")) return false;
  if (key.includes("_live_")) return true;
  throw new ExpectedToolError(
    "stripe_platform_key_mode_unknown",
    "The Stripe platform key does not identify itself as test or live. Creator money refuses to act rather than guess its mode.",
  );
}

export function assertLivemodeMatchesKey(
  row_livemode: boolean,
  key = process.env.STRIPE_PLATFORM_SECRET_KEY ?? null,
): void {
  const keyLive = platformKeyLivemode(key);
  if (row_livemode !== keyLive) {
    throw new ExpectedToolError(
      "livemode_mismatch",
      `This row is ${row_livemode ? "live" : "test"} mode but the Stripe key in this process is ${keyLive ? "live" : "test"} mode. No money operation runs across that boundary.`,
    );
  }
}
