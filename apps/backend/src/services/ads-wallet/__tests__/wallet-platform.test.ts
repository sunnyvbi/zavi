import { afterEach, beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ checkout: vi.fn(), listPms: vi.fn(), order: {} as Record<string, unknown> }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (v: string) => v,
  tenantRpc: vi.fn(),
  resolveAdsWalletOrderTenant: vi.fn(),
  applyAdsWalletPayment: vi.fn(),
  tenantClient: () => ({
    from: (table: string) => {
      const q: any = {};
      for (const k of ["select", "eq", "is", "upsert", "update", "insert"]) q[k] = () => q;
      const result = () => ({ data: table === "ads_wallets" ? { tenant_id: "t1", stripe_customer_id: "cus1", payment_method_id: "pm1", creator_consent_at: null } : m.order, error: null });
      q.single = async () => result();
      q.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result()).then(resolve);
      return q;
    },
  }),
}));
vi.mock("../stripe-client", () => {
  const stripe = { checkout: { sessions: { create: m.checkout } }, customers: { listPaymentMethods: m.listPms } };
  return { adsStripe: () => stripe, requireAdsStripe: () => stripe };
});
vi.mock("../funding-context", () => ({ readReservations: vi.fn() }));
vi.mock("../providers", () => ({ refillEligibility: vi.fn() }));
import { CREATOR_CONSENT_VERSION, inAppConsent, listCards, setupConsentText, startFunding } from "../wallet";

const CHATGPT_TOPUP = {
  customer: "cus1",
  client_reference_id: "order1",
  metadata: { kind: "chatgpt_ads_wallet", order_id: "order1" },
  success_url: "https://www.zaviagent.com/workspace?tab=channels&channel=chatgpt_ads&ads_payment=success",
  cancel_url: "https://www.zaviagent.com/workspace?tab=channels&channel=chatgpt_ads&ads_payment=cancel",
  payment_method_types: ["card"],
  mode: "payment",
  adaptive_pricing: { enabled: false },
  payment_intent_data: { metadata: { kind: "chatgpt_ads_wallet", order_id: "order1" } },
  line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: 10000, product_data: { name: "Zavi ChatGPT ads balance" } } }],
};
const setupMeta = (refill: string) => ({ kind: "chatgpt_ads_wallet", order_id: "order1", creator_consent: CREATOR_CONSENT_VERSION, enable_refill: refill });
const CHATGPT_REFILL = "Authorize Zavi to charge this card for ChatGPT ads refills and for creator hires Autopilot books within its caps. Refills are $200.00 whenever your ads balance falls below $50, up to $1,000 per UTC day. Disable auto-refill in the ChatGPT Ads channel at any time.";
const CHATGPT_SETUP = {
  customer: "cus1",
  client_reference_id: "order1",
  metadata: setupMeta("1"),
  success_url: CHATGPT_TOPUP.success_url,
  cancel_url: CHATGPT_TOPUP.cancel_url,
  payment_method_types: ["card"],
  mode: "setup",
  setup_intent_data: { metadata: setupMeta("1") },
  custom_text: { submit: { message: CHATGPT_REFILL } },
};
const CHATGPT_IN_APP = {
  version: CREATOR_CONSENT_VERSION,
  save_text: "Save this card to your Zavi ads wallet and authorize Zavi to charge it for ChatGPT ads balance you add.",
  refill_text: "Also authorize Zavi to charge this card {amount} whenever your ChatGPT ads balance falls below $50, up to $1,000 per UTC day. Disable auto-refill in the ChatGPT Ads channel at any time.",
  creator_text: "Also authorize Zavi to charge this card for creator hires Autopilot books within its caps.",
};
const params = () => m.checkout.mock.calls.at(-1)!;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("CHATGPT_ADS_FUNDING_ENABLED", "true");
  vi.stubEnv("STRIPE_ADS_WEBHOOK_SECRET", "test");
  vi.stubEnv("PRAXIS_PUBLIC_BASE", "https://www.zaviagent.com/");
  m.checkout.mockResolvedValue({ url: "https://checkout.example/session" });
  m.listPms.mockResolvedValue({ data: [] });
  m.order = { id: "order1", tenant_id: "t1", kind: "topup", amount_cents: 10000, status: "pending", created_at: new Date().toISOString() };
});
afterEach(() => {
  vi.unstubAllEnvs();
});

it.each([[undefined], ["chatgpt" as const]])("a ChatGPT top-up checkout is unchanged to the byte (platform %s)", async (platform) => {
  await startFunding("t1", "u1", 10000, "topup", "order1", false, platform);
  expect(JSON.stringify(params()[0])).toBe(JSON.stringify(CHATGPT_TOPUP));
  expect(params()[1]).toEqual({ idempotencyKey: "ads_checkout_order1" });
});
it.each([[undefined], ["chatgpt" as const]])("a ChatGPT auto-refill setup checkout and its consent are unchanged to the byte (platform %s)", async (platform) => {
  m.order = { ...m.order, kind: "setup", amount_cents: 20000 };
  await startFunding("t1", "u1", 20000, "setup", "order1", true, platform);
  expect(JSON.stringify(params()[0])).toBe(JSON.stringify(CHATGPT_SETUP));
  expect(setupConsentText(20000, true)).toBe(CHATGPT_REFILL);
  expect(setupConsentText(20000, false)).toBe("Authorize Zavi to charge this card for creator hires Autopilot books within its caps.");
});
it("the ChatGPT in-app consent texts are unchanged to the byte", async () => {
  expect(JSON.stringify(inAppConsent)).toBe(JSON.stringify(CHATGPT_IN_APP));
  vi.stubEnv("CHATGPT_ADS_INAPP_PAYMENTS", "1");
  expect(JSON.stringify((await listCards("t1")).consent)).toBe(JSON.stringify(CHATGPT_IN_APP));
});
it("a LinkedIn top-up names LinkedIn on Stripe and returns the founder to the LinkedIn Ads channel, keeping the wallet's payment kind", async () => {
  await startFunding("t1", "u1", 10000, "topup", "order1", false, "linkedin");
  const [p] = params();
  expect(p.line_items[0].price_data.product_data.name).toBe("Zavi LinkedIn ads balance");
  expect(p.success_url).toBe("https://www.zaviagent.com/workspace?tab=channels&channel=linkedin_ads&ads_payment=success");
  expect(p.cancel_url).toBe("https://www.zaviagent.com/workspace?tab=channels&channel=linkedin_ads&ads_payment=cancel");
  expect(p.metadata).toEqual({ kind: "chatgpt_ads_wallet", order_id: "order1" });
  expect(p.payment_intent_data.metadata).toEqual({ kind: "chatgpt_ads_wallet", order_id: "order1" });
  expect(JSON.stringify(p)).not.toMatch(/ChatGPT|chatgpt_ads&/);
});
it("a LinkedIn auto-refill setup asks consent in LinkedIn words and returns to the LinkedIn Ads channel", async () => {
  m.order = { ...m.order, kind: "setup", amount_cents: 20000 };
  await startFunding("t1", "u1", 20000, "setup", "order1", true, "linkedin");
  const [p] = params();
  expect(p.custom_text.submit.message).toBe("Authorize Zavi to charge this card for LinkedIn ads refills and for creator hires Autopilot books within its caps. Refills are $200.00 whenever your ads balance falls below $50, up to $1,000 per UTC day. Disable auto-refill in the LinkedIn Ads channel at any time.");
  expect(p.success_url).toContain("channel=linkedin_ads&");
  expect(p.metadata).toEqual(setupMeta("1"));
});
it("the LinkedIn in-app consent speaks of LinkedIn under the same consent version", async () => {
  vi.stubEnv("CHATGPT_ADS_INAPP_PAYMENTS", "1");
  const { consent } = await listCards("t1", "linkedin");
  expect(consent).toEqual({
    version: CREATOR_CONSENT_VERSION,
    save_text: "Save this card to your Zavi ads wallet and authorize Zavi to charge it for LinkedIn ads balance you add.",
    refill_text: "Also authorize Zavi to charge this card {amount} whenever your LinkedIn ads balance falls below $50, up to $1,000 per UTC day. Disable auto-refill in the LinkedIn Ads channel at any time.",
    creator_text: "Also authorize Zavi to charge this card for creator hires Autopilot books within its caps.",
  });
});
