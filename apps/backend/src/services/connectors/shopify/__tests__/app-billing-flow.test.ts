import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  graphql: vi.fn(),
  subscription: vi.fn(),
}));

vi.mock("../graphql", () => ({ shopifyGraphql: m.graphql }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (id: string) => id,
  tenantClient: () => ({
    from: () => ({
      select: () => ({ maybeSingle: m.subscription }),
    }),
  }),
}));
vi.mock("@/services/web-base", () => ({ webBaseUrl: () => "https://www.zaviagent.com" }));

import { shopifyChargeUsd, startShopifySubscription } from "../app-billing";
import type { ShopifyAppContext } from "../app-context";

function context(role: ShopifyAppContext["role"] = "owner"): ShopifyAppContext {
  return {
    shop: "zavi-test-store.myshopify.com",
    tenant_id: "tenant-1",
    tenant_name: "Zavi Store",
    user_id: "user-1",
    role,
    grant: {
      access_token: "online-token",
      scope: "read_orders",
      expires_in: 86_400,
      associated_user_scope: "read_orders",
      scopes: ["read_orders"],
      user_scopes: ["read_orders"],
      associated_user: {
        id: "42",
        first_name: "Shop",
        last_name: "Owner",
        email: "owner@example.com",
        account_owner: true,
        collaborator: false,
        email_verified: true,
      },
    },
  };
}

beforeEach(() => {
  m.graphql.mockReset();
  m.subscription.mockReset();
  m.subscription.mockResolvedValue({ data: null, error: null });
});

describe("Shopify subscription checkout", () => {
  it("allows only a linked Zavi owner or admin to start billing", async () => {
    await expect(startShopifySubscription(context("member"), "starter", "monthly"))
      .rejects.toMatchObject({ code: "forbidden" });
    expect(m.graphql).not.toHaveBeenCalled();
  });

  it("refuses Shopify checkout while another paid billing rail is active", async () => {
    m.subscription.mockResolvedValue({ data: { source: "stripe", status: "active", stripe_subscription_id: "sub_1", grandfathered: false, credits_revoked_at: null, shopify_shop: null }, error: null });
    await expect(startShopifySubscription(context(), "starter", "monthly"))
      .rejects.toMatchObject({ code: "paid_elsewhere" });
    expect(m.graphql).not.toHaveBeenCalled();
  });

  it("does not mistake an active Free row for a paid Stripe plan", async () => {
    m.subscription.mockResolvedValue({ data: { source: null, status: "active", stripe_subscription_id: null, grandfathered: false, credits_revoked_at: null, shopify_shop: null }, error: null });
    m.graphql
      .mockResolvedValueOnce({ shop: { plan: { partnerDevelopment: true } } })
      .mockResolvedValueOnce({ appSubscriptionCreate: { confirmationUrl: "https://shopify.test/confirm", userErrors: [] } });
    await expect(startShopifySubscription(context(), "starter", "monthly"))
      .resolves.toEqual({ confirmation_url: "https://shopify.test/confirm" });
  });

  it.each([
    [{ source: null, status: "active", stripe_subscription_id: null, grandfathered: true, credits_revoked_at: null, shopify_shop: null }, "grandfathered"],
    [{ source: null, status: "active", stripe_subscription_id: null, grandfathered: false, credits_revoked_at: "2026-10-01T00:00:00Z", shopify_shop: null }, "refund_blocked"],
  ] as const)("blocks a protected billing row before Shopify can charge it", async (data, code) => {
    m.subscription.mockResolvedValue({ data, error: null });
    await expect(startShopifySubscription(context(), "starter", "monthly"))
      .rejects.toMatchObject({ code });
    expect(m.graphql).not.toHaveBeenCalled();
  });

  it("refuses a second Shopify charge when another shop owns the live plan", async () => {
    m.subscription.mockResolvedValue({ data: {
      source: "shopify",
      status: "active",
      stripe_subscription_id: null,
      grandfathered: false,
      credits_revoked_at: null,
      shopify_shop: "other-store.myshopify.com",
    }, error: null });
    await expect(startShopifySubscription(context(), "starter", "monthly"))
      .rejects.toMatchObject({ code: "paid_elsewhere" });
    expect(m.graphql).not.toHaveBeenCalled();
  });

  it("allows a linked owner to replace the same shop's Shopify plan", async () => {
    m.subscription.mockResolvedValue({ data: {
      source: "shopify",
      status: "active",
      stripe_subscription_id: null,
      grandfathered: false,
      credits_revoked_at: null,
      shopify_shop: "zavi-test-store.myshopify.com",
    }, error: null });
    m.graphql
      .mockResolvedValueOnce({ shop: { plan: { partnerDevelopment: true } } })
      .mockResolvedValueOnce({ appSubscriptionCreate: { confirmationUrl: "https://shopify.test/change", userErrors: [] } });
    await expect(startShopifySubscription(context(), "pro", "monthly"))
      .resolves.toEqual({ confirmation_url: "https://shopify.test/change" });
  });

  it("creates an annual test subscription at the approved canonical price with no trial", async () => {
    m.graphql
      .mockResolvedValueOnce({ shop: { plan: { partnerDevelopment: true } } })
      .mockResolvedValueOnce({ appSubscriptionCreate: { confirmationUrl: "https://shopify.test/confirm", userErrors: [] } });

    await expect(startShopifySubscription(context("admin"), "growth", "annual"))
      .resolves.toEqual({ confirmation_url: "https://shopify.test/confirm" });

    const mutation = m.graphql.mock.calls[1][0];
    expect(mutation.variables).toMatchObject({
      name: "Zavi Growth",
      returnUrl: "https://www.zaviagent.com/shopify/app-home?billing=return",
      replacementBehavior: "STANDARD",
      test: true,
      lineItems: [{ plan: { appRecurringPricingDetails: {
        price: { amount: shopifyChargeUsd("growth", "annual"), currencyCode: "USD" },
        interval: "ANNUAL",
      } } }],
    });
    expect(mutation.variables).not.toHaveProperty("trialDays");
  });
});
