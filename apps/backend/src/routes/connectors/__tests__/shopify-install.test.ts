import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import type { Request, Response } from "express";
import { shopifyQueryMessage } from "@/services/connectors/shopify/hmac";
import { shopifyInstall } from "../shopify";

vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));
const pending = vi.hoisted(() => ({ mint: vi.fn(async () => undefined) }));
vi.mock("@/services/connectors/shopify/pending-install", () => ({
  mintShopifyOAuthState: pending.mint,
  consumeShopifyOAuthState: vi.fn(),
  storePendingShopifyInstall: vi.fn(),
  getPendingShopifyInstall: vi.fn(),
  getShopifyInstallStatus: vi.fn(),
  rotatePendingShopifyTokens: vi.fn(),
  setPendingComposioAccount: vi.fn(),
  completePendingShopifyInstall: vi.fn(),
}));

const store = vi.hoisted(() => ({ connections: vi.fn(async (): Promise<Array<{ tenant_id: string; connected_account_id: string }>> => []) }));
vi.mock("@/services/connectors/shopify/store", () => ({
  connectionsForShop: store.connections,
  saveShopDomain: vi.fn(),
}));

const SECRET = "shpss_test_secret";

function signed(q: Record<string, string>): Record<string, string> {
  return { ...q, hmac: crypto.createHmac("sha256", SECRET).update(shopifyQueryMessage(q)).digest("hex") };
}

function res() {
  const r: any = { statusCode: 200, body: null, redirectedTo: null as string | null, html: null as string | null, headers: {} as Record<string, string> };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: unknown) => { r.body = b; return r; };
  r.set = (k: string, v: string) => { r.headers[k] = v; return r; };
  r.send = (b: string) => { r.html = b; return r; };
  r.redirect = (c: number, u: string) => { r.statusCode = c; r.redirectedTo = u; return r; };
  return r;
}

const now = 1_700_000_000_000;
beforeEach(() => {
  pending.mint.mockClear();
  store.connections.mockReset();
  store.connections.mockResolvedValue([]);
  vi.stubEnv("SHOPIFY_CLIENT_ID", "client-id");
  vi.stubEnv("SHOPIFY_CLIENT_SECRET", SECRET);
  vi.stubEnv("SHOPIFY_SCOPES", "read_products,read_orders");
  vi.stubEnv("BACKEND_PUBLIC_URL", "https://api.zaviagent.com");
  vi.stubEnv("WEB_ORIGIN", "https://www.zaviagent.com");
  vi.useFakeTimers();
  vi.setSystemTime(now);
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

const fresh = { shop: "acme.myshopify.com", timestamp: String(Math.floor(now / 1000) - 30) };

describe("GET /api/connectors/shopify/install", () => {
  it("starts Shopify OAuth immediately, before any Zavi login or UI", async () => {
    const r = res();
    await shopifyInstall({ query: signed(fresh) } as unknown as Request, r as Response);
    expect(r.statusCode).toBe(302);
    const url = new URL(r.redirectedTo!);
    expect(url.origin + url.pathname).toBe("https://acme.myshopify.com/admin/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("redirect_uri")).toBe("https://api.zaviagent.com/api/connectors/shopify/callback");
    expect(url.searchParams.get("scope")).toBe("read_products,read_orders");
    expect(pending.mint).toHaveBeenCalledWith("acme.myshopify.com", url.searchParams.get("state"));
  });

  it("sends a store that has not installed yet straight to Shopify's permission screen, with no App Bridge page", async () => {
    const r = res();
    await shopifyInstall({ query: signed({ ...fresh, host: "YWRtaW4uc2hvcGlmeS5jb20vc3RvcmUvYWNtZQ" }) } as unknown as Request, r as Response);
    expect(r.statusCode).toBe(302);
    expect(r.html).toBeNull();
    const url = new URL(r.redirectedTo!);
    expect(url.origin + url.pathname).toBe("https://acme.myshopify.com/admin/oauth/authorize");
    expect(pending.mint).toHaveBeenCalledWith("acme.myshopify.com", url.searchParams.get("state"));
  });

  it("starts OAuth for an unconnected embedded store instead of looping through App Home", async () => {
    const query = signed({ ...fresh, embedded: "1", host: "YWRtaW4uc2hvcGlmeS5jb20vc3RvcmUvYWNtZQ" });
    const r = res();
    await shopifyInstall({ query } as unknown as Request, r as Response);
    expect(r.statusCode).toBe(302);
    const url = new URL(r.redirectedTo!);
    expect(url.origin + url.pathname).toBe("https://acme.myshopify.com/admin/oauth/authorize");
    expect(pending.mint).toHaveBeenCalledWith("acme.myshopify.com", url.searchParams.get("state"));
  });

  it("opens App Home with Shopify's launch parameters when the connected app loads inside Shopify admin", async () => {
    store.connections.mockResolvedValue([{ tenant_id: "t1", connected_account_id: "ca_1" }]);
    const query = signed({ ...fresh, embedded: "1", host: "YWRtaW4uc2hvcGlmeS5jb20vc3RvcmUvYWNtZQ", id_token: "must-not-forward" });
    const r = res();
    await shopifyInstall({ query } as unknown as Request, r as Response);
    expect(r.statusCode).toBe(302);
    const url = new URL(r.redirectedTo!);
    expect(url.origin + url.pathname).toBe("https://www.zaviagent.com/shopify/app-home");
    expect(url.searchParams.get("shop")).toBe("acme.myshopify.com");
    expect(url.searchParams.get("host")).toBe(query.host);
    expect(url.searchParams.get("embedded")).toBe("1");
    expect(url.searchParams.has("id_token")).toBe(false);
    expect(pending.mint).not.toHaveBeenCalled();
  });

  it("sends a store already connected to Zavi into the app inside Shopify admin instead of restarting OAuth", async () => {
    store.connections.mockResolvedValue([{ tenant_id: "t1", connected_account_id: "ca_1" }]);
    const r = res();
    await shopifyInstall({ query: signed(fresh) } as unknown as Request, r as Response);
    expect(r.statusCode).toBe(302);
    expect(r.redirectedTo).toBe("https://admin.shopify.com/store/acme/apps/client-id");
    expect(pending.mint).not.toHaveBeenCalled();
  });

  it("fails closed when the connection lookup fails", async () => {
    store.connections.mockRejectedValue(new Error("db down"));
    const r = res();
    await shopifyInstall({ query: signed(fresh) } as unknown as Request, r as Response);
    expect(r.statusCode).toBe(503);
    expect(r.body.error.code).toBe("shopify_install_unavailable");
    expect(r.redirectedTo).toBeNull();
    expect(pending.mint).not.toHaveBeenCalled();
  });

  it("does not open App Home for an unsigned embedded request", async () => {
    const r = res();
    await shopifyInstall({ query: { ...signed(fresh), embedded: "1" } } as unknown as Request, r as Response);
    expect(r.statusCode).toBe(401);
    expect(r.redirectedTo).toBeNull();
  });

  it("refuses a request without a valid Shopify signature", async () => {
    const r = res();
    await shopifyInstall({ query: { ...signed(fresh), shop: "other.myshopify.com" } } as unknown as Request, r as Response);
    expect(r.statusCode).toBe(401);
    expect(r.redirectedTo).toBeNull();
  });

  it("refuses a signed request whose shop is not a myshopify domain", async () => {
    const r = res();
    await shopifyInstall({ query: signed({ ...fresh, shop: "evil.com" }) } as unknown as Request, r as Response);
    expect(r.statusCode).toBe(400);
  });

  it("refuses a signed request older than a day", async () => {
    const r = res();
    await shopifyInstall({ query: signed({ ...fresh, timestamp: String(Math.floor(now / 1000) - 2 * 86_400) }) } as unknown as Request, r as Response);
    expect(r.statusCode).toBe(401);
    expect(r.body.error.code).toBe("stale_request");
  });

  it("is inert without the client secret", async () => {
    vi.stubEnv("SHOPIFY_CLIENT_SECRET", "");
    const r = res();
    await shopifyInstall({ query: signed(fresh) } as unknown as Request, r as Response);
    expect(r.statusCode).toBe(503);
  });

  it("is inert without the client id", async () => {
    vi.stubEnv("SHOPIFY_CLIENT_ID", "");
    const r = res();
    await shopifyInstall({ query: signed(fresh) } as unknown as Request, r as Response);
    expect(r.statusCode).toBe(503);
  });
});
