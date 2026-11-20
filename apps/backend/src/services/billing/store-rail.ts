
import type { PaidTier } from "./tiers";

export const STORE_SOURCES = ["app_store", "play_store", "test_store"] as const;
export type StoreSource = (typeof STORE_SOURCES)[number];

export const isStoreSource = (v: unknown): v is StoreSource =>
  typeof v === "string" && (STORE_SOURCES as readonly string[]).includes(v);

const SOURCE_FOR_STORE: Record<string, StoreSource> = {
  APP_STORE: "app_store",
  PLAY_STORE: "play_store",
  TEST_STORE: "test_store",
};

export const sourceForStore = (store: unknown): StoreSource | null =>
  typeof store === "string" ? SOURCE_FOR_STORE[store] ?? null : null;

const LIVE_STATUSES = new Set(["active", "trialing", "past_due"]);

export const SHOPIFY_SOURCE = "shopify" as const;

export const isShopifySource = (v: unknown): v is typeof SHOPIFY_SOURCE => v === SHOPIFY_SOURCE;

export const isLiveStorePlan = (row: { source?: unknown; status?: unknown } | null | undefined): boolean =>
  !!row && (isStoreSource(row.source) || isShopifySource(row.source)) && LIVE_STATUSES.has(String(row.status));

export const isLiveShopifyPlan = (row: { source?: unknown; status?: unknown } | null | undefined): boolean =>
  !!row && isShopifySource(row.source) && LIVE_STATUSES.has(String(row.status));

export const MANAGED_IN_STORE = {
  error: { code: "managed_in_store", message: "Your plan is managed in the App Store or Google Play." },
} as const;

export const MANAGED_IN_SHOPIFY = {
  error: { code: "managed_in_store", message: "Your plan is billed by Shopify. Change or cancel it from the Zavi app in your Shopify admin." },
} as const;

export const managedElsewhere = (row: { source?: unknown } | null | undefined) =>
  isShopifySource(row?.source) ? MANAGED_IN_SHOPIFY : MANAGED_IN_STORE;

export const managedElsewhereLabel = (row: { source?: unknown } | null | undefined): string =>
  isShopifySource(row?.source) ? "Shopify" : "the App Store or Google Play";

const PRODUCT_RE = /^zavi_(starter|growth|pro)_(monthly|6mo)$/;

export function tierForStoreProduct(productId: unknown): PaidTier | null {
  if (typeof productId !== "string") return null;
  const match = PRODUCT_RE.exec(productId.split(":")[0]);
  return match ? (match[1] as PaidTier) : null;
}

export function storeTermForProduct(productId: unknown): "monthly" | "6mo" | null {
  if (typeof productId !== "string") return null;
  const match = PRODUCT_RE.exec(productId.split(":")[0]);
  return match ? (match[2] as "monthly" | "6mo") : null;
}

export type StoreEvent = {
  id?: unknown;
  type?: unknown;
  app_user_id?: unknown;
  product_id?: unknown;
  period_type?: unknown;
  expiration_at_ms?: unknown;
  event_timestamp_ms?: unknown;
  cancel_reason?: unknown;
  store?: unknown;
  environment?: unknown;
};

export type StoreStatus = "active" | "trialing" | "past_due" | "canceled";

export type StoreState =
  | { kind: "ignore"; reason: string }
  | { kind: "unknown_product" }
  | {
      kind: "state";
      tier: PaidTier | null;
      status: StoreStatus;
      cancelAtPeriodEnd: boolean;
      periodEnd: string | null;
      refund: boolean;
      refundReversed: boolean;
    };

const RENEWING = new Set([
  "INITIAL_PURCHASE",
  "RENEWAL",
  "UNCANCELLATION",
  "SUBSCRIPTION_EXTENDED",
  "REFUND_REVERSED",
]);

const periodEndIso = (ms: unknown): string | null =>
  typeof ms === "number" && ms > 0 ? new Date(ms).toISOString() : null;

export function storeStateForEvent(event: StoreEvent): StoreState {
  const type = typeof event.type === "string" ? event.type : "";
  const periodEnd = periodEndIso(event.expiration_at_ms);

  if (type === "EXPIRATION") {
    return { kind: "state", tier: null, status: "canceled", cancelAtPeriodEnd: false, periodEnd, refund: false, refundReversed: false };
  }

  const isPlanEvent = RENEWING.has(type) || type === "CANCELLATION" || type === "BILLING_ISSUE";
  if (!isPlanEvent) return { kind: "ignore", reason: type || "no_type" };

  const tier = tierForStoreProduct(event.product_id);
  if (!tier) return { kind: "unknown_product" };

  if (type === "BILLING_ISSUE") {
    return { kind: "state", tier, status: "past_due", cancelAtPeriodEnd: false, periodEnd, refund: false, refundReversed: false };
  }
  if (type === "CANCELLATION") {
    return {
      kind: "state",
      tier,
      status: "active",
      cancelAtPeriodEnd: true,
      periodEnd,
      refund: event.cancel_reason === "CUSTOMER_SUPPORT",
      refundReversed: false,
    };
  }
  if (
    type === "REFUND_REVERSED" &&
    typeof event.expiration_at_ms === "number" &&
    typeof event.event_timestamp_ms === "number" &&
    event.expiration_at_ms <= event.event_timestamp_ms
  ) {
    return { kind: "state", tier: null, status: "canceled", cancelAtPeriodEnd: false, periodEnd, refund: false, refundReversed: true };
  }
  return {
    kind: "state",
    tier,
    status: event.period_type === "TRIAL" ? "trialing" : "active",
    cancelAtPeriodEnd: false,
    periodEnd,
    refund: false,
    refundReversed: type === "REFUND_REVERSED",
  };
}
