import { describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/services/tenant-client", () => ({ shopifyRpc: m.rpc }));
import { isShopifyPrivacyTopic, parseShopifyPrivacyPayload, recordShopifyPrivacyRequest } from "../privacy";

describe("parseShopifyPrivacyPayload", () => {
  it("keeps the customer, request and order ids Shopify sends and nothing else", () => {
    const parsed = parseShopifyPrivacyPayload(Buffer.from(JSON.stringify({
      shop_id: 7, shop_domain: "acme.myshopify.com",
      customer: { id: 42, email: " jane@example.com ", phone: "+15551234567", extra: "x" },
      orders_requested: [100, "101", null], orders_to_redact: [102], data_request: { id: 9 },
    })));
    expect(parsed).toEqual({
      shopify_shop_id: "7", shopify_request_id: "9", customer_id: "42", customer_email: "jane@example.com",
      customer_phone: "+15551234567", order_ids: ["100", "101", "102"],
    });
  });
  it("tolerates a body that is not JSON or has no customer", () => {
    expect(parseShopifyPrivacyPayload("not json")).toEqual({
      shopify_shop_id: null, shopify_request_id: null, customer_id: null, customer_email: null, customer_phone: null, order_ids: [],
    });
    expect(parseShopifyPrivacyPayload(Buffer.from('{"shop_id":"3"}')).shopify_shop_id).toBe("3");
  });
  it("names the three compliance topics", () => {
    expect(isShopifyPrivacyTopic("customers/redact")).toBe(true);
    expect(isShopifyPrivacyTopic("app/uninstalled")).toBe(false);
  });
});

describe("recordShopifyPrivacyRequest", () => {
  it("writes the request through the RPC and returns its id", async () => {
    m.rpc.mockResolvedValueOnce({ data: "req_1", error: null });
    const payload = { shopify_shop_id: "7", shopify_request_id: "9", customer_id: "42", customer_email: null, customer_phone: null, order_ids: ["100"] };
    expect(await recordShopifyPrivacyRequest("acme.myshopify.com", "customers/redact", payload)).toBe("req_1");
    expect(m.rpc).toHaveBeenCalledWith("record_shopify_privacy_request", {
      p_shop: "acme.myshopify.com", p_topic: "customers/redact", p_shopify_shop_id: "7", p_shopify_request_id: "9",
      p_customer_id: "42", p_customer_email: null, p_customer_phone: null, p_order_ids: ["100"],
    });
  });
  it("fails loudly when the row was not written", async () => {
    m.rpc.mockResolvedValueOnce({ data: null, error: { message: "down" } });
    await expect(recordShopifyPrivacyRequest("acme.myshopify.com", "shop/redact", parseShopifyPrivacyPayload("{}"))).rejects.toThrow("shopify_privacy_record_failed:down");
    m.rpc.mockResolvedValueOnce({ data: null, error: null });
    await expect(recordShopifyPrivacyRequest("acme.myshopify.com", "shop/redact", parseShopifyPrivacyPayload("{}"))).rejects.toThrow("missing_id");
  });
});
