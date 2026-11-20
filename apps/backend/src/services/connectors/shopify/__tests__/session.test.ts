import { afterEach, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";
import { exchangeShopifyOfflineToken, exchangeShopifyOnlineToken, ShopifySessionError, verifyShopifyIdToken } from "../session";

const SECRET = "shopify-secret-for-tests";
const CLIENT_ID = "shopify-client-id";
const SHOP = "zavi-test-store.myshopify.com";

async function token(overrides: Record<string, unknown> = {}) {
  return new SignJWT({ dest: `https://${SHOP}`, sub: "12345", ...overrides })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(`https://${SHOP}/admin`)
    .setAudience(CLIENT_ID)
    .setIssuedAt()
    .setExpirationTime("1m")
    .sign(new TextEncoder().encode(SECRET));
}

async function expiredToken() {
  return new SignJWT({ dest: `https://${SHOP}`, sub: "12345" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(`https://${SHOP}/admin`)
    .setAudience(CLIENT_ID)
    .setIssuedAt()
    .setExpirationTime("-10s")
    .sign(new TextEncoder().encode(SECRET));
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Shopify embedded session", () => {
  it("accepts a signed token only when audience, issuer and destination agree", async () => {
    vi.stubEnv("SHOPIFY_CLIENT_ID", CLIENT_ID);
    vi.stubEnv("SHOPIFY_CLIENT_SECRET", SECRET);
    await expect(verifyShopifyIdToken(`Bearer ${await token()}`)).resolves.toMatchObject({ shop: SHOP, shopify_user_id: "12345" });
    await expect(verifyShopifyIdToken(`Bearer ${await token({ dest: "https://other-store.myshopify.com" })}`)).rejects.toMatchObject({ code: "invalid_token" });
  });

  it("classifies an expired ID token as refreshable", async () => {
    vi.stubEnv("SHOPIFY_CLIENT_ID", CLIENT_ID);
    vi.stubEnv("SHOPIFY_CLIENT_SECRET", SECRET);
    await expect(verifyShopifyIdToken(`Bearer ${await expiredToken()}`)).rejects.toMatchObject({ code: "stale_token" });
  });

  it("exchanges the ID token for the same staff member's online token and scopes", async () => {
    vi.stubEnv("SHOPIFY_CLIENT_ID", CLIENT_ID);
    vi.stubEnv("SHOPIFY_CLIENT_SECRET", SECRET);
    const session = await verifyShopifyIdToken(`Bearer ${await token()}`);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      access_token: "online-token",
      scope: "read_orders,read_products",
      expires_in: 86400,
      associated_user_scope: "read_orders",
      associated_user: {
        id: 12345,
        first_name: "Store",
        last_name: "Owner",
        email: "owner@example.com",
        account_owner: true,
        collaborator: false,
        email_verified: true,
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    await expect(exchangeShopifyOnlineToken(session)).resolves.toMatchObject({
      access_token: "online-token",
      scopes: ["read_orders", "read_products"],
      user_scopes: ["read_orders"],
      associated_user: { id: "12345", email_verified: true },
    });
  });

  it("exchanges the signed App Bridge session for an expiring offline grant", async () => {
    vi.stubEnv("SHOPIFY_CLIENT_ID", CLIENT_ID);
    vi.stubEnv("SHOPIFY_CLIENT_SECRET", SECRET);
    vi.stubEnv("SHOPIFY_SCOPES", "read_orders,read_products,write_products");
    const session = await verifyShopifyIdToken(`Bearer ${await token()}`);
    let requestBody = "";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      requestBody = String(init?.body ?? "");
      return new Response(JSON.stringify({
        access_token: "offline-token",
        refresh_token: "offline-refresh",
        scope: "read_orders,write_products",
        expires_in: 3600,
        refresh_token_expires_in: 7_776_000,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const now = Date.parse("2026-11-03T10:00:00Z");
    await expect(exchangeShopifyOfflineToken(session, now)).resolves.toEqual({
      access_token: "offline-token",
      refresh_token: "offline-refresh",
      scopes: ["read_orders", "write_products"],
      access_token_expires_at: new Date("2026-11-03T11:00:00Z"),
      refresh_token_expires_at: new Date("2027-02-01T10:00:00Z"),
    });
    const body = new URLSearchParams(requestBody);
    expect(body.get("requested_token_type")).toBe("urn:shopify:params:oauth:token-type:offline-access-token");
    expect(body.get("expiring")).toBe("1");
  });

  it("requires reauthorization when Shopify refuses a fresh token exchange", async () => {
    vi.stubEnv("SHOPIFY_CLIENT_ID", CLIENT_ID);
    vi.stubEnv("SHOPIFY_CLIENT_SECRET", SECRET);
    const session = await verifyShopifyIdToken(`Bearer ${await token()}`);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("stale", { status: 400 }));
    await expect(exchangeShopifyOnlineToken(session)).rejects.toEqual(expect.objectContaining<Partial<ShopifySessionError>>({ code: "reauthorization_required" }));
  });
});
