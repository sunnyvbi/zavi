import type { Request, Response } from "express";
import { normalizeShopDomain, shopifyClientSecret, verifyShopifyWebhookHmac } from "@/services/connectors/shopify/hmac";
import { disconnectShop } from "@/services/connectors/shopify/store";
import { shopifyBilling, type ShopifyBillingEvent } from "@/services/connectors/shopify/billing";
import { shopifyEventMs, type ShopifySubscriptionPayload } from "@/services/billing/shopify-rail";
import { isShopifyPrivacyTopic, parseShopifyPrivacyPayload, recordShopifyPrivacyRequest } from "@/services/connectors/shopify/privacy";
import { logEvent } from "@/services/logging/logEvent";

function header(req: Request, name: string): string {
  const v = req.header(name);
  return typeof v === "string" ? v.trim() : "";
}

function parseSubscription(raw: Buffer): ShopifySubscriptionPayload | null {
  try {
    const body = JSON.parse(raw.toString("utf8")) as { app_subscription?: ShopifySubscriptionPayload } | null;
    return body && typeof body === "object" && body.app_subscription && typeof body.app_subscription === "object" ? body.app_subscription : null;
  } catch {
    return null;
  }
}

function billingEvent(req: Request, topic: string, shop: string, subscription: ShopifySubscriptionPayload | null): ShopifyBillingEvent {
  const eventId = header(req, "x-shopify-webhook-id") || `${topic}:${shop}:${header(req, "x-shopify-triggered-at")}`;
  return { eventId, topic, shop, eventMs: shopifyEventMs(header(req, "x-shopify-triggered-at"), subscription?.updated_at, Date.now()), subscription };
}

export async function shopifyWebhook(req: Request, res: Response): Promise<void> {
  if (!shopifyClientSecret()) {
    res.status(503).json({ error: { code: "shopify_not_configured" } });
    return;
  }
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!verifyShopifyWebhookHmac(rawBody, header(req, "x-shopify-hmac-sha256"))) {
    res.status(401).json({ error: { code: "invalid_signature" } });
    return;
  }
  const topic = header(req, "x-shopify-topic").toLowerCase();
  const shop = normalizeShopDomain(header(req, "x-shopify-shop-domain"));
  if (!shop) {
    res.status(400).json({ error: { code: "invalid_shop" } });
    return;
  }
  try {
    if (isShopifyPrivacyTopic(topic)) {
      const requestId = await recordShopifyPrivacyRequest(shop, topic, parseShopifyPrivacyPayload(rawBody));
      void logEvent({ level: "warn", source: "shopify.webhook", code: "shopify_privacy_request_recorded", meta: { topic, request_id: requestId } });
    }
    if (topic === "app_subscriptions/update") {
      const result = await shopifyBilling.subscriptionUpdated(billingEvent(req, topic, shop, parseSubscription(rawBody)));
      void logEvent({ level: "info", source: "shopify.webhook", code: "shopify_subscription_update", meta: { outcome: result.outcome ?? result.ignored ?? (result.duplicate ? "duplicate" : result.unbound ? "unbound" : "ok") } });
    }
    if (topic === "app/uninstalled" || topic === "shop/redact") {
      const ended = await shopifyBilling.appUninstalled(billingEvent(req, topic, shop, null));
      const n = await disconnectShop(shop, topic);
      void logEvent({ level: "info", source: "shopify.webhook", code: topic === "shop/redact" ? "shopify_shop_redact" : "shopify_app_uninstalled", meta: { connections: n, plan: ended.outcome ?? ended.ignored ?? "ok" } });
    }
  } catch (e) {
    void logEvent({ level: "error", source: "shopify.webhook", code: "shopify_webhook_failed", message: (e as Error).message, meta: { topic } });
    res.status(500).json({ error: { code: "webhook_failed" } });
    return;
  }
  res.status(200).json({ ok: true });
}
