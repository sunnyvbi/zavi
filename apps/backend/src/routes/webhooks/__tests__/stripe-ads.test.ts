import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import Stripe from "stripe";
const apply = vi.hoisted(() => vi.fn());
vi.mock("@/services/ads-wallet/wallet", () => ({ applyWalletEvent: apply }));
import { stripeAdsWebhook } from "../stripe-ads";
const stripe = new Stripe("sk_test_placeholder");
beforeEach(() => { apply.mockReset(); vi.stubEnv("STRIPE_ADS_SECRET_KEY", ""); vi.stubEnv("STRIPE_ADS_WEBHOOK_SECRET", "whsec_test"); vi.stubEnv("STRIPE_PLATFORM_SECRET_KEY", "sk_test_placeholder"); });
afterEach(() => { vi.unstubAllEnvs(); });
async function request(valid: boolean, live = false, raw = true, signingSecret?: string) {
  const payload = JSON.stringify({ id: "evt1", object: "event", livemode: live, type: "payment_intent.succeeded", data: { object: { id: "pi1" } } });
  const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: signingSecret ?? (valid ? "whsec_test" : "wrong") });
  const req = { body: raw ? Buffer.from(payload) : JSON.parse(payload), header: () => signature } as unknown as Request;
  const res = { status: vi.fn(), json: vi.fn() }; res.status.mockReturnValue(res);
  await stripeAdsWebhook(req, res as unknown as Response); return res;
}
it("applies a correctly signed raw event", async () => { await request(true); expect(apply).toHaveBeenCalledTimes(1); });
it("rejects forged signatures before touching the wallet", async () => { expect((await request(false)).status).toHaveBeenCalledWith(400); expect(apply).not.toHaveBeenCalled(); });
it("rejects a live event in a test environment", async () => { expect((await request(true, true)).status).toHaveBeenCalledWith(400); expect(apply).not.toHaveBeenCalled(); });
it("requires the raw request body", async () => { expect((await request(true, false, false)).status).toHaveBeenCalledWith(400); expect(apply).not.toHaveBeenCalled(); });
it("asks Stripe to retry an uncommitted ledger event", async () => { apply.mockRejectedValue(new Error("db failure")); expect((await request(true)).status).toHaveBeenCalledWith(500); });

it("rejects the existing billing secret at the ads endpoint", async () => {
  vi.stubEnv("STRIPE_BILLING_WEBHOOK_SECRET", "whsec_existing_billing");
  expect((await request(true, false, true, "whsec_existing_billing")).status).toHaveBeenCalledWith(400);
  expect(apply).not.toHaveBeenCalled();
});
it("never falls back to a billing secret when the ads secret is missing", async () => {
  vi.stubEnv("STRIPE_ADS_WEBHOOK_SECRET", "");
  vi.stubEnv("STRIPE_BILLING_WEBHOOK_SECRET", "whsec_test");
  expect((await request(true)).status).toHaveBeenCalledWith(503);
  expect(apply).not.toHaveBeenCalled();
});
it("uses the ads-only key's mode even when billing uses a different mode", async () => {
  vi.stubEnv("STRIPE_ADS_SECRET_KEY", "rk_live_ads");
  expect((await request(true, true)).json).toHaveBeenCalledWith({ ok: true });
  apply.mockClear();
  expect((await request(true, false)).status).toHaveBeenCalledWith(400);
  expect(apply).not.toHaveBeenCalled();
});
it("fails closed for an invalid ads override instead of falling back to billing", async () => {
  vi.stubEnv("STRIPE_ADS_SECRET_KEY", "invalid");
  expect((await request(true)).status).toHaveBeenCalledWith(503);
  expect(apply).not.toHaveBeenCalled();
});
