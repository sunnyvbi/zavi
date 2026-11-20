import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exchangeShopifyCode, refreshShopifyGrant, shopifyAuthorizeUrl, shopifyScopes } from "../oauth";

function response(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  vi.stubEnv("SHOPIFY_CLIENT_ID", "client-id");
  vi.stubEnv("SHOPIFY_CLIENT_SECRET", "client-secret");
  vi.stubEnv("SHOPIFY_SCOPES", "read_products,read_orders");
  vi.stubEnv("BACKEND_PUBLIC_URL", "https://api.zaviagent.com/");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Shopify standalone OAuth", () => {
  it("builds the Shopify approval URL with server-owned scopes and callback", () => {
    const url = new URL(shopifyAuthorizeUrl("acme.myshopify.com", "state-1"));
    expect(url.origin + url.pathname).toBe("https://acme.myshopify.com/admin/oauth/authorize");
    expect(url.searchParams.get("redirect_uri")).toBe("https://api.zaviagent.com/api/connectors/shopify/callback");
    expect(url.searchParams.get("scope")).toBe("read_products,read_orders");
    expect(url.searchParams.get("state")).toBe("state-1");
  });

  it("asks for product and discount writes by default when no scopes are configured", () => {
    vi.stubEnv("SHOPIFY_SCOPES", "");
    expect(shopifyScopes()).toEqual(["read_products", "write_products", "read_orders", "read_discounts", "write_discounts"]);
  });

  it("requests an expiring offline token and retains both expiries", async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => response(200, {
      access_token: "access",
      refresh_token: "refresh",
      scope: "read_products,read_orders",
      expires_in: 3600,
      refresh_token_expires_in: 7776000,
    }));
    vi.stubGlobal("fetch", fetcher);
    const grant = await exchangeShopifyCode("acme.myshopify.com", "code", 1_000_000);
    const request = fetcher.mock.calls[0][1] ?? {};
    expect(String(request.body)).toContain("expiring=1");
    expect(String(request.body)).toContain("code=code");
    expect(grant.access_token_expires_at.getTime()).toBe(1_000_000 + 3_600_000);
    expect(grant.refresh_token_expires_at.getTime()).toBe(1_000_000 + 7_776_000_000);
  });

  it("refreshes a rotated grant without user interaction", async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => response(200, {
      access_token: "access-2",
      refresh_token: "refresh-2",
      scope: "read_products,read_orders",
      expires_in: 3600,
      refresh_token_expires_in: 7776000,
    }));
    vi.stubGlobal("fetch", fetcher);
    expect((await refreshShopifyGrant("acme.myshopify.com", "refresh-1")).refresh_token).toBe("refresh-2");
    expect(String(fetcher.mock.calls[0][1]?.body)).toContain("grant_type=refresh_token");
  });

  it("fails closed when Shopify omits a required scope", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(200, {
      access_token: "access",
      refresh_token: "refresh",
      scope: "read_products",
      expires_in: 3600,
      refresh_token_expires_in: 7776000,
    })));
    await expect(exchangeShopifyCode("acme.myshopify.com", "code")).rejects.toMatchObject({ code: "missing_scope" });
  });
});
