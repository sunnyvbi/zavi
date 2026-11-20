import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => {
  class GraphqlError extends Error {
    constructor(readonly code: string, message: string) { super(message); }
  }
  return { graphql: vi.fn(), GraphqlError };
});

vi.mock("../graphql", () => ({
  shopifyGraphql: m.graphql,
  ShopifyGraphqlError: m.GraphqlError,
}));

import { readShopifyWindowMetrics } from "../app-home";
import type { ShopifyAppContext } from "../app-context";

function context(userScopes: string[] = ["read_orders"]): ShopifyAppContext {
  return {
    shop: "zavi-test-store.myshopify.com",
    tenant_id: "tenant-1",
    tenant_name: "Zavi Store",
    user_id: "user-1",
    role: "owner",
    grant: {
      access_token: "online-token",
      scope: "read_orders",
      expires_in: 86_400,
      associated_user_scope: userScopes.join(","),
      scopes: ["read_orders"],
      user_scopes: userScopes,
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
});

describe("Shopify App Home order metrics", () => {
  it("computes current and previous seven-day values from Shopify orders", async () => {
    m.graphql
      .mockResolvedValueOnce({ shop: { name: "Zavi Test Store" } })
      .mockResolvedValueOnce({
        orders: {
          nodes: [
            { createdAt: "2026-10-30T10:00:00.000Z", currentTotalPriceSet: { shopMoney: { amount: "120", currencyCode: "USD" } } },
            { createdAt: "2026-10-20T10:00:00.000Z", currentTotalPriceSet: { shopMoney: { amount: "50", currencyCode: "USD" } } },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      });

    await expect(readShopifyWindowMetrics(context(), new Date("2026-11-01T00:00:00.000Z"))).resolves.toMatchObject({
      displayName: "Zavi Test Store",
      sales: { value: 120, currency: "USD", comparison: 140, availability: "live" },
      orders: { value: 1, comparison: 0, availability: "live" },
      syncedAt: "2026-11-01T00:00:00.000Z",
    });
  });

  it("does not query orders when the current Shopify staff member lacks read access", async () => {
    m.graphql.mockResolvedValueOnce({ shop: { name: "Zavi Test Store" } });
    const result = await readShopifyWindowMetrics(context([]));
    expect(result.sales).toMatchObject({ value: null, availability: "unavailable" });
    expect(result.orders.note).toMatch(/does not have permission/i);
    expect(m.graphql).toHaveBeenCalledTimes(1);
  });

  it("reports unavailable data rather than inventing a number when Shopify denies order access", async () => {
    m.graphql
      .mockResolvedValueOnce({ shop: { name: "Zavi Test Store" } })
      .mockRejectedValueOnce(new m.GraphqlError("access_denied", "denied"));
    const result = await readShopifyWindowMetrics(context());
    expect(result.sales).toMatchObject({ value: null, availability: "unavailable" });
    expect(result.sales.note).toMatch(/cannot read order totals/i);
  });
});
