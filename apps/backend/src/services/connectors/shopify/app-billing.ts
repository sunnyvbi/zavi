import { sixMonthUsd } from "@/services/billing/plans";
import { isPaidTier, TIER_PRICE_USD, type PaidTier } from "@/services/billing/tiers";
import { shopifyPlanName } from "@/services/billing/shopify-rail";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { webBaseUrl } from "@/services/web-base";
import { shopifyGraphql } from "./graphql";
import type { ShopifyAppContext } from "./app-context";

const ACTIVE = new Set(["active", "trialing", "past_due"]);
const STORE_SOURCES = new Set(["app_store", "play_store", "test_store"]);

export type ShopifyBillingLockReason = "paid_elsewhere" | "grandfathered" | "refund_blocked";

type SubscriptionRail = {
  source: string | null;
  status: string | null;
  stripe_subscription_id: string | null;
  grandfathered: boolean | null;
  credits_revoked_at: string | null;
  shopify_shop: string | null;
};

export function shopifyBillingLockReason(sub: SubscriptionRail | null, currentShop: string): ShopifyBillingLockReason | null {
  if (!sub) return null;
  if (sub.grandfathered) return "grandfathered";
  if (sub.credits_revoked_at) return "refund_blocked";
  if (ACTIVE.has(String(sub.status)) && sub.source === "shopify" && sub.shopify_shop !== currentShop) return "paid_elsewhere";
  if (!ACTIVE.has(String(sub.status)) || sub.source === "shopify") return null;
  if ((sub.source === null || sub.source === "stripe") && sub.stripe_subscription_id) return "paid_elsewhere";
  if (STORE_SOURCES.has(String(sub.source))) return "paid_elsewhere";
  return null;
}

export type ShopifyBillingTerm = "monthly" | "annual";

export class ShopifyBillingStartError extends Error {
  constructor(readonly code: "forbidden" | "invalid_plan" | ShopifyBillingLockReason | "shopify_error", message: string) {
    super(message);
    this.name = "ShopifyBillingStartError";
  }
}

export function shopifyChargeUsd(tier: PaidTier, term: ShopifyBillingTerm): number {
  return term === "annual" ? sixMonthUsd(tier) * 2 : TIER_PRICE_USD[tier];
}

export async function startShopifySubscription(context: ShopifyAppContext, tierRaw: unknown, termRaw: unknown) {
  if (!context.user_id || (context.role !== "owner" && context.role !== "admin")) {
    throw new ShopifyBillingStartError("forbidden", "Only a linked Zavi owner or admin can change this plan.");
  }
  if (!isPaidTier(tierRaw) || (termRaw !== "monthly" && termRaw !== "annual")) {
    throw new ShopifyBillingStartError("invalid_plan", "Choose a valid Zavi plan and billing term.");
  }
  const tier = tierRaw;
  const term = termRaw;
  const tid = asTenantId(context.tenant_id);
  const { data: sub, error } = await tenantClient(tid).from("tenant_subscriptions")
    .select("source, status, stripe_subscription_id, grandfathered, credits_revoked_at, shopify_shop")
    .maybeSingle<SubscriptionRail>();
  if (error) throw new ShopifyBillingStartError("shopify_error", "Could not check the current plan.");
  const lock = shopifyBillingLockReason(sub, context.shop);
  if (lock === "paid_elsewhere") {
    throw new ShopifyBillingStartError(lock, "Cancel the current paid plan where it was purchased before switching billing to Shopify.");
  }
  if (lock === "grandfathered") {
    throw new ShopifyBillingStartError(lock, "This workspace has a lifetime plan. Contact Zavi before switching it to Shopify billing.");
  }
  if (lock === "refund_blocked") {
    throw new ShopifyBillingStartError(lock, "Shopify billing is unavailable for this workspace. Contact Zavi support.");
  }

  const shopInfo = await shopifyGraphql<{ shop: { plan: { partnerDevelopment: boolean } } }>({
    shop: context.shop,
    accessToken: context.grant.access_token,
    query: `query ZaviShopBillingMode { shop { plan { partnerDevelopment } } }`,
  });
  const amount = shopifyChargeUsd(tier, term);
  const returnUrl = `${webBaseUrl()}/shopify/app-home?billing=return`;
  const result = await shopifyGraphql<{
    appSubscriptionCreate: {
      confirmationUrl: string | null;
      userErrors: Array<{ field: string[] | null; message: string }>;
    };
  }>({
    shop: context.shop,
    accessToken: context.grant.access_token,
    query: `mutation ZaviCreateSubscription(
      $name: String!, $returnUrl: URL!, $lineItems: [AppSubscriptionLineItemInput!]!,
      $replacementBehavior: AppSubscriptionReplacementBehavior!, $test: Boolean!
    ) {
      appSubscriptionCreate(
        name: $name,
        returnUrl: $returnUrl,
        lineItems: $lineItems,
        replacementBehavior: $replacementBehavior,
        test: $test
      ) {
        confirmationUrl
        userErrors { field message }
      }
    }`,
    variables: {
      name: shopifyPlanName(tier),
      returnUrl,
      replacementBehavior: "STANDARD",
      test: shopInfo.shop.plan.partnerDevelopment || (process.env.NODE_ENV !== "production" && process.env.SHOPIFY_BILLING_TEST_MODE === "1"),
      lineItems: [{
        plan: {
          appRecurringPricingDetails: {
            price: { amount, currencyCode: "USD" },
            interval: term === "annual" ? "ANNUAL" : "EVERY_30_DAYS",
          },
        },
      }],
    },
  });
  if (result.appSubscriptionCreate.userErrors.length || !result.appSubscriptionCreate.confirmationUrl) {
    throw new ShopifyBillingStartError(
      "shopify_error",
      result.appSubscriptionCreate.userErrors.map((item) => item.message).join("; ") || "Shopify did not return a confirmation page.",
    );
  }
  return { confirmation_url: result.appSubscriptionCreate.confirmationUrl };
}
