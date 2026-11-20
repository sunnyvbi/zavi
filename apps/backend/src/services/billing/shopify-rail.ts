import { PAID_TIERS, TIER_DISPLAY_NAME, type PaidTier } from "./tiers";

export const SHOPIFY_PLAN_PREFIX = "Zavi ";

export function shopifyPlanName(tier: PaidTier): string {
  return `${SHOPIFY_PLAN_PREFIX}${TIER_DISPLAY_NAME[tier]}`;
}

export function tierForShopifyPlanName(name: unknown): PaidTier | null {
  if (typeof name !== "string") return null;
  const wanted = name.trim().toLowerCase();
  return PAID_TIERS.find((t) => shopifyPlanName(t).toLowerCase() === wanted) ?? null;
}

export type ShopifyStatus = "active" | "past_due" | "canceled";

export type ShopifySubscriptionPayload = {
  admin_graphql_api_id?: unknown;
  name?: unknown;
  status?: unknown;
  updated_at?: unknown;
};

export type ShopifyPlanState =
  | { kind: "ignore"; reason: string }
  | { kind: "unknown_plan"; name: string }
  | { kind: "state"; subscriptionId: string; tier: PaidTier | null; status: ShopifyStatus };

const ENDED = new Set(["CANCELLED", "EXPIRED", "DECLINED"]);

export function shopifyStateForPayload(sub: ShopifySubscriptionPayload | null | undefined): ShopifyPlanState {
  const subscriptionId = typeof sub?.admin_graphql_api_id === "string" ? sub.admin_graphql_api_id : "";
  const status = typeof sub?.status === "string" ? sub.status.toUpperCase() : "";
  if (!subscriptionId) return { kind: "ignore", reason: "no_subscription_id" };
  if (ENDED.has(status)) return { kind: "state", subscriptionId, tier: null, status: "canceled" };
  if (status !== "ACTIVE" && status !== "FROZEN") return { kind: "ignore", reason: status || "no_status" };
  const tier = tierForShopifyPlanName(sub?.name);
  if (!tier) return { kind: "unknown_plan", name: typeof sub?.name === "string" ? sub.name : "" };
  return { kind: "state", subscriptionId, tier, status: status === "FROZEN" ? "past_due" : "active" };
}

export function shopifyEventMs(triggeredAt: unknown, updatedAt: unknown, now: number): number {
  for (const v of [triggeredAt, updatedAt]) {
    if (typeof v !== "string") continue;
    const ms = Date.parse(v);
    if (Number.isFinite(ms) && ms > 0) return ms;
  }
  return now;
}
