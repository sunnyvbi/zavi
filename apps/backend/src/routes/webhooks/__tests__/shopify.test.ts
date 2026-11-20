import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import type { Request, Response } from "express";

const m = vi.hoisted(() => ({
  disconnectShop: vi.fn(async () => 1),
  logEvent: vi.fn(async () => undefined),
  recordPrivacy: vi.fn(async () => "req_1"),
  subscriptionUpdated: vi.fn(async () => ({ ok: true, outcome: "applied" })),
  appUninstalled: vi.fn(async () => ({ ok: true, ignored: "no_shopify_plan" })),
}));
vi.mock("@/services/connectors/shopify/privacy", async (orig) => ({
  ...(await orig<typeof import("@/services/connectors/shopify/privacy")>()),
  recordShopifyPrivacyRequest: m.recordPrivacy,
}));
vi.mock("@/services/connectors/shopify/store", () => ({ disconnectShop: m.disconnectShop }));
vi.mock("@/services/connectors/shopify/billing", () => ({
  shopifyBilling: { subscriptionUpdated: m.subscriptionUpdated, appUninstalled: m.appUninstalled },
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: m.logEvent }));
import { shopifyWebhook } from "../shopify";

const SECRET = "shpss_test_secret";

function res() {
  const r: any = { statusCode: 200, body: null };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: unknown) => { r.body = b; return r; };
  return r;
}

function call(topic: string, opts: { valid?: boolean; raw?: boolean; shop?: string; body?: Record<string, unknown>; hmac?: string | null } = {}) {
  const payload = JSON.stringify(opts.body ?? { shop_domain: "acme.myshopify.com", shop_id: 1 });
  const digest = crypto.createHmac("sha256", opts.valid === false ? "wrong" : SECRET).update(payload).digest("base64");
  const headers: Record<string, string> = {
    "x-shopify-topic": topic,
    "x-shopify-shop-domain": opts.shop ?? "acme.myshopify.com",
  };
  if (opts.hmac !== null) headers["x-shopify-hmac-sha256"] = opts.hmac ?? digest;
  const req = { body: opts.raw === false ? JSON.parse(payload) : Buffer.from(payload), header: (n: string) => headers[n.toLowerCase()] } as unknown as Request;
  const r = res();
  return shopifyWebhook(req, r as Response).then(() => r);
}

beforeEach(() => { vi.stubEnv("SHOPIFY_CLIENT_SECRET", SECRET); m.disconnectShop.mockClear(); m.logEvent.mockClear(); m.recordPrivacy.mockClear(); m.recordPrivacy.mockResolvedValue("req_1"); m.subscriptionUpdated.mockClear(); m.appUninstalled.mockClear(); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("POST /api/webhooks/shopify", () => {
  it("answers 401 to a bad signature and touches nothing", async () => {
    const r = await call("app/uninstalled", { valid: false });
    expect(r.statusCode).toBe(401);
    expect(m.disconnectShop).not.toHaveBeenCalled();
  });

  it("answers 401 to a missing or malformed signature and touches nothing", async () => {
    expect((await call("customers/data_request", { hmac: null })).statusCode).toBe(401);
    expect((await call("customers/data_request", { hmac: "not-base64" })).statusCode).toBe(401);
    expect(m.recordPrivacy).not.toHaveBeenCalled();
    expect(m.disconnectShop).not.toHaveBeenCalled();
  });

  it("rejects an unparsed body as an authentication failure before trusting it", async () => {
    expect((await call("app/uninstalled", { raw: false })).statusCode).toBe(401);
    expect(m.disconnectShop).not.toHaveBeenCalled();
  });

  it("is inert without the client secret", async () => {
    vi.stubEnv("SHOPIFY_CLIENT_SECRET", "");
    expect((await call("app/uninstalled")).statusCode).toBe(503);
  });

  it("disconnects every Zavi connection for the store on app/uninstalled", async () => {
    const r = await call("app/uninstalled");
    expect(r.statusCode).toBe(200);
    expect(m.disconnectShop).toHaveBeenCalledWith("acme.myshopify.com", "app/uninstalled");
  });

  it("records shop/redact as a privacy request, then disconnects", async () => {
    await call("shop/redact");
    expect(m.recordPrivacy).toHaveBeenCalledWith("acme.myshopify.com", "shop/redact", expect.objectContaining({ shopify_shop_id: "1" }));
    expect(m.disconnectShop).toHaveBeenCalledWith("acme.myshopify.com", "shop/redact");
  });

  it("records every customer privacy request with the customer and orders Shopify named", async () => {
    const body = {
      shop_id: 7, shop_domain: "acme.myshopify.com",
      customer: { id: 42, email: "jane@example.com", phone: "+15551234567" },
      orders_requested: [100, 101], data_request: { id: 9 },
    };
    for (const topic of ["customers/data_request", "customers/redact"]) {
      m.logEvent.mockClear();
      expect((await call(topic, { body })).statusCode).toBe(200);
      expect(m.disconnectShop).not.toHaveBeenCalled();
      expect(m.recordPrivacy).toHaveBeenLastCalledWith("acme.myshopify.com", topic, {
        shopify_shop_id: "7", shopify_request_id: "9", customer_id: "42", customer_email: "jane@example.com", customer_phone: "+15551234567", order_ids: ["100", "101"],
      });
      expect(m.logEvent).toHaveBeenCalledWith(expect.objectContaining({ level: "warn", code: "shopify_privacy_request_recorded", meta: { topic, request_id: "req_1" } }));
    }
  });

  it("never acknowledges a privacy request it could not record", async () => {
    m.recordPrivacy.mockRejectedValueOnce(new Error("db down"));
    expect((await call("customers/redact")).statusCode).toBe(500);
  });

  it("refuses a shop header that is not a myshopify domain", async () => {
    expect((await call("app/uninstalled", { shop: "evil.com" })).statusCode).toBe(400);
    expect(m.disconnectShop).not.toHaveBeenCalled();
  });

  it("asks Shopify to retry when the disconnect fails", async () => {
    m.disconnectShop.mockRejectedValueOnce(new Error("db down"));
    expect((await call("app/uninstalled")).statusCode).toBe(500);
  });

  it("acknowledges an unknown topic", async () => {
    expect((await call("products/update")).statusCode).toBe(200);
  });

  it("hands app_subscriptions/update to the billing rail with the shop, the event id and the subscription", async () => {
    const body = { app_subscription: { admin_graphql_api_id: "gid://shopify/AppSubscription/9", name: "Zavi Starter", status: "ACTIVE", updated_at: "2026-10-30T10:00:00Z" } };
    const r = await call("app_subscriptions/update", { body });
    expect(r.statusCode).toBe(200);
    expect(m.subscriptionUpdated).toHaveBeenCalledWith(expect.objectContaining({
      shop: "acme.myshopify.com",
      topic: "app_subscriptions/update",
      eventMs: Date.parse("2026-10-30T10:00:00Z"),
      subscription: body.app_subscription,
    }));
    expect(m.disconnectShop).not.toHaveBeenCalled();
  });

  it("asks Shopify to retry when the billing write fails", async () => {
    m.subscriptionUpdated.mockRejectedValueOnce(new Error("db down"));
    expect((await call("app_subscriptions/update", { body: { app_subscription: { admin_graphql_api_id: "gid://shopify/AppSubscription/9", name: "Zavi Pro", status: "ACTIVE" } } })).statusCode).toBe(500);
  });

  it("ends the Shopify plan before disconnecting on app/uninstalled", async () => {
    await call("app/uninstalled");
    expect(m.appUninstalled).toHaveBeenCalledWith(expect.objectContaining({ shop: "acme.myshopify.com", topic: "app/uninstalled" }));
    expect(m.appUninstalled.mock.invocationCallOrder[0]).toBeLessThan(m.disconnectShop.mock.invocationCallOrder[0]);
  });
});
