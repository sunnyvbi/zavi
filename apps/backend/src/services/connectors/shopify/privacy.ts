import { shopifyRpc } from "@/services/tenant-client";

export const SHOPIFY_PRIVACY_TOPICS = ["customers/data_request", "customers/redact", "shop/redact"] as const;
export type ShopifyPrivacyTopic = (typeof SHOPIFY_PRIVACY_TOPICS)[number];

export function isShopifyPrivacyTopic(topic: string): topic is ShopifyPrivacyTopic {
  return (SHOPIFY_PRIVACY_TOPICS as readonly string[]).includes(topic);
}

function record(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function scalar(v: unknown): string | null {
  if (typeof v === "string") return v.trim().slice(0, 320) || null;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function ids(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map(scalar).filter((id): id is string => id !== null).slice(0, 1000);
}

export type ShopifyPrivacyPayload = {
  shopify_shop_id: string | null;
  shopify_request_id: string | null;
  customer_id: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  order_ids: string[];
};

export function parseShopifyPrivacyPayload(raw: Buffer | string): ShopifyPrivacyPayload {
  let body: Record<string, unknown> = {};
  try {
    body = record(JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8")));
  } catch {
    body = {};
  }
  const customer = record(body.customer);
  return {
    shopify_shop_id: scalar(body.shop_id),
    shopify_request_id: scalar(record(body.data_request).id),
    customer_id: scalar(customer.id),
    customer_email: scalar(customer.email),
    customer_phone: scalar(customer.phone),
    order_ids: ids(body.orders_requested).concat(ids(body.orders_to_redact)),
  };
}

export async function recordShopifyPrivacyRequest(shop: string, topic: ShopifyPrivacyTopic, payload: ShopifyPrivacyPayload): Promise<string> {
  const { data, error } = await shopifyRpc("record_shopify_privacy_request", {
    p_shop: shop,
    p_topic: topic,
    p_shopify_shop_id: payload.shopify_shop_id,
    p_shopify_request_id: payload.shopify_request_id,
    p_customer_id: payload.customer_id,
    p_customer_email: payload.customer_email,
    p_customer_phone: payload.customer_phone,
    p_order_ids: payload.order_ids,
  });
  if (error) throw new Error(`shopify_privacy_record_failed:${error.message}`);
  if (typeof data !== "string" || !data) throw new Error("shopify_privacy_record_failed:missing_id");
  return data;
}
