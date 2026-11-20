import { storeBillingClient } from "@/services/tenant-client";
import { logEvent } from "@/services/logging/logEvent";
import { requestPreviewUpgrade } from "@/services/growth/preview-upgrade";
import { shopifyStateForPayload, type ShopifyStatus, type ShopifySubscriptionPayload } from "@/services/billing/shopify-rail";
import type { PaidTier } from "@/services/billing/tiers";
import { connectionsForShop } from "./store";
import { getPendingShopifyInstall } from "./pending-install";
import { shopifyGraphql } from "./graphql";

export type ShopifyOutcome =
  | "applied"
  | "replay"
  | "stale"
  | "grandfathered"
  | "stripe_active"
  | "store_active"
  | "refund_blocked"
  | "shop_in_use"
  | "other_shop_active";

type DbError = { error: { message: string } | null };

export type ShopifyApplyArgs = {
  tenant_id: string;
  shop: string;
  shopify_subscription_id: string | null;
  tier: PaidTier | null;
  status: ShopifyStatus;
  event_ms: number;
};

type ShopifyVerifiedApplyArgs = ShopifyApplyArgs & { expected_event_ms: number };
type ShopifyBillingSnapshot = { source: string | null; status: string | null; watermark: number };

export type ShopifyBillingDeps = {
  eventProcessed?: (eventId: string) => Promise<boolean>;
  markProcessed?: (eventId: string, topic: string) => Promise<void>;
  resolveTenantBySubscription?: (subscriptionId: string) => Promise<string | null>;
  resolveTenantByShop?: (shop: string, liveOnly?: boolean) => Promise<string | null>;
  resolveTenantByConnection?: (shop: string) => Promise<string | null>;
  resolveBillingSnapshot?: (tenantId: string) => Promise<ShopifyBillingSnapshot | null>;
  currentActiveSubscriptionIds?: (shop: string, tenantId: string) => Promise<readonly string[]>;
  applyState?: (args: ShopifyApplyArgs) => Promise<DbError & { outcome: ShopifyOutcome | null }>;
  applyVerifiedState?: (args: ShopifyVerifiedApplyArgs) => Promise<DbError & { outcome: ShopifyOutcome | null }>;
  setMonthlyCredits?: (tenantId: string, eventSeconds: number) => Promise<DbError>;
  requestPreviewRerun?: (tenantId: string) => Promise<unknown>;
};

export type ShopifyBillingEvent = {
  eventId: string;
  topic: string;
  shop: string;
  eventMs: number;
  subscription: ShopifySubscriptionPayload | null;
};

export type ShopifyBillingResult = { ok: true; outcome?: ShopifyOutcome; ignored?: string; duplicate?: boolean; unbound?: boolean };

const db = () => storeBillingClient("Shopify billing webhook: no session, workspace resolved from our own records");

async function defaultEventProcessed(eventId: string): Promise<boolean> {
  const { data, error } = await db().from("shopify_billing_events").select("event_id").eq("event_id", eventId).maybeSingle<{ event_id: string }>();
  if (error) throw new Error(`event-processed check failed: ${error.message}`);
  return Boolean(data);
}

async function defaultMarkProcessed(eventId: string, topic: string): Promise<void> {
  const { error } = await db().from("shopify_billing_events").insert({ event_id: eventId, topic });
  if (error && !/duplicate key|unique/i.test(error.message)) throw new Error(`mark-processed failed: ${error.message}`);
}

async function defaultResolveBySubscription(subscriptionId: string): Promise<string | null> {
  const { data, error } = await db().from("tenant_subscriptions").select("tenant_id").eq("shopify_subscription_id", subscriptionId).maybeSingle<{ tenant_id: string }>();
  if (error) throw new Error(`resolve-by-subscription failed: ${error.message}`);
  return data?.tenant_id ?? null;
}

async function defaultResolveByShop(shop: string, liveOnly = false): Promise<string | null> {
  let q = db().from("tenant_subscriptions").select("tenant_id").eq("shopify_shop", shop).eq("source", "shopify");
  if (liveOnly) q = q.in("status", ["active", "trialing", "past_due"]);
  const { data, error } = await q.limit(2);
  if (error) throw new Error(`resolve-by-shop failed: ${error.message}`);
  const rows = (data ?? []) as Array<{ tenant_id: string }>;
  return rows.length === 1 ? rows[0].tenant_id : null;
}

async function defaultResolveByConnection(shop: string): Promise<string | null> {
  const tenants = [...new Set((await connectionsForShop(shop)).map((c) => c.tenant_id))];
  return tenants.length === 1 ? tenants[0] : null;
}

async function defaultResolveBillingSnapshot(tenantId: string): Promise<ShopifyBillingSnapshot | null> {
  const { data, error } = await db().from("tenant_subscriptions")
    .select("source, status, store_event_created").eq("tenant_id", tenantId)
    .maybeSingle<{ source: string | null; status: string | null; store_event_created: number | null }>();
  if (error) throw new Error(`resolve-billing-snapshot failed: ${error.message}`);
  return data ? { source: data.source, status: data.status, watermark: Number(data.store_event_created ?? 0) } : null;
}

export async function loadCurrentActiveSubscriptionIds(shop: string, tenantId: string): Promise<readonly string[]> {
  const { data: ref, error } = await db().from("shopify_pending_installations")
    .select("id, generation")
    .eq("shop", shop)
    .eq("claimed_tenant_id", tenantId)
    .eq("grant_pending", false)
    .maybeSingle<{ id: string; generation: number }>();
  if (error) throw new Error(`shopify-active-subscriptions grant lookup failed: ${error.message}`);
  if (!ref) return [];
  const grant = await getPendingShopifyInstall({ installation_id: ref.id, generation: ref.generation });
  if (!grant || grant.shop !== shop || grant.access_token_expires_at.getTime() <= Date.now()) {
    throw new Error("shopify-active-subscriptions grant unavailable");
  }
  const current = await shopifyGraphql<{
    currentAppInstallation: { activeSubscriptions: Array<{ id: string }> };
  }>({
    shop,
    accessToken: grant.access_token,
    query: `query ZaviCurrentAppSubscriptions {
      currentAppInstallation { activeSubscriptions { id } }
    }`,
  });
  return current.currentAppInstallation.activeSubscriptions.map((subscription) => subscription.id);
}

async function defaultApplyState(args: ShopifyApplyArgs) {
  const { data, error } = (await db().rpc("apply_shopify_subscription_state", {
    p_tenant_id: args.tenant_id,
    p_shop: args.shop,
    p_shopify_subscription_id: args.shopify_subscription_id,
    p_tier: args.tier,
    p_status: args.status,
    p_current_period_end: null,
    p_cancel_at_period_end: false,
    p_event_ms: args.event_ms,
  })) as unknown as { data: ShopifyOutcome | null; error: { message: string } | null };
  return { error, outcome: data };
}

async function defaultApplyVerifiedState(args: ShopifyVerifiedApplyArgs) {
  const { data, error } = (await db().rpc("apply_verified_shopify_subscription_state", {
    p_tenant_id: args.tenant_id,
    p_shop: args.shop,
    p_shopify_subscription_id: args.shopify_subscription_id,
    p_tier: args.tier,
    p_status: args.status,
    p_current_period_end: null,
    p_cancel_at_period_end: false,
    p_expected_event_ms: args.expected_event_ms,
    p_event_ms: args.event_ms,
  })) as unknown as { data: ShopifyOutcome | null; error: { message: string } | null };
  return { error, outcome: data };
}

function defaultSetMonthlyCredits(tenantId: string, eventSeconds: number) {
  return db().rpc("set_tenant_monthly_credits", {
    p_tenant_id: tenantId,
    p_monthly_credits: null,
    p_monthly_usd: null,
    p_event_created: eventSeconds,
  }) as unknown as Promise<DbError>;
}

export function makeShopifyBillingHandler(deps: ShopifyBillingDeps = {}) {
  const eventProcessed = deps.eventProcessed ?? defaultEventProcessed;
  const markProcessed = deps.markProcessed ?? defaultMarkProcessed;
  const bySubscription = deps.resolveTenantBySubscription ?? defaultResolveBySubscription;
  const byShop = deps.resolveTenantByShop ?? defaultResolveByShop;
  const byConnection = deps.resolveTenantByConnection ?? defaultResolveByConnection;
  const billingSnapshot = deps.resolveBillingSnapshot ?? defaultResolveBillingSnapshot;
  const currentActiveSubscriptionIds = deps.currentActiveSubscriptionIds ?? loadCurrentActiveSubscriptionIds;
  const applyState = deps.applyState ?? defaultApplyState;
  const applyVerifiedState = deps.applyVerifiedState ?? defaultApplyVerifiedState;
  const setMonthlyCredits = deps.setMonthlyCredits ?? defaultSetMonthlyCredits;
  const requestPreviewRerun = deps.requestPreviewRerun ?? requestPreviewUpgrade;

  async function apply(event: ShopifyBillingEvent, tenantId: string, state: { subscriptionId: string | null; tier: PaidTier | null; status: ShopifyStatus }): Promise<ShopifyBillingResult> {
    const applied = await applyState({
      tenant_id: tenantId,
      shop: event.shop,
      shopify_subscription_id: state.subscriptionId,
      tier: state.tier,
      status: state.status,
      event_ms: event.eventMs,
    });
    if (applied.error || !applied.outcome) throw new Error(`apply failed: ${applied.error?.message ?? "no outcome"}`);
    let outcome = applied.outcome;
    if ((outcome === "stale" || outcome === "replay") && state.tier && state.status === "active" && state.subscriptionId) {
      const snapshot = await billingSnapshot(tenantId);
      if (snapshot?.source === "shopify" && snapshot.status === "canceled") {
        const activeIds = await currentActiveSubscriptionIds(event.shop, tenantId);
        if (activeIds.includes(state.subscriptionId)) {
          const retried = await applyVerifiedState({
            tenant_id: tenantId,
            shop: event.shop,
            shopify_subscription_id: state.subscriptionId,
            tier: state.tier,
            status: state.status,
            expected_event_ms: snapshot.watermark,
            event_ms: Math.max(event.eventMs, snapshot.watermark + 1000),
          });
          if (retried.error || !retried.outcome) throw new Error(`apply failed: ${retried.error?.message ?? "no outcome"}`);
          if (retried.outcome === "stale") throw new Error("verified_shopify_state_changed");
          outcome = retried.outcome;
        }
      }
    }
    if (outcome !== "applied" && outcome !== "replay") {
      if (outcome === "stale") {
        await logEvent({
          level: "warn",
          source: "shopify.billing",
          code: "shopify_state_stale",
          tenant_id: tenantId,
          message: `${event.topic} ${event.eventId} was older than the granting Shopify billing state and was not applied`,
        });
      } else {
        await logEvent({
          level: "error",
          source: "shopify.billing",
          code: "shopify_state_conflict",
          tenant_id: tenantId,
          message: `${event.topic} ${event.eventId} was not applied: ${outcome}. Check whether the merchant was charged on Shopify and needs a refund.`,
        });
      }
      await markProcessed(event.eventId, event.topic);
      return { ok: true, outcome };
    }
    const { error: creditsErr } = await setMonthlyCredits(tenantId, Math.floor(event.eventMs / 1000));
    if (creditsErr) throw new Error(`set credits failed: ${creditsErr.message}`);
    if (state.tier && state.status === "active") {
      await requestPreviewRerun(tenantId);
    }
    await markProcessed(event.eventId, event.topic);
    return { ok: true, outcome };
  }

  return {
    async subscriptionUpdated(event: ShopifyBillingEvent): Promise<ShopifyBillingResult> {
      const state = shopifyStateForPayload(event.subscription);
      if (state.kind === "ignore") return { ok: true, ignored: state.reason };
      if (state.kind === "unknown_plan") {
        await logEvent({
          level: "error",
          source: "shopify.billing",
          code: "shopify_unknown_plan",
          message: `${event.topic} ${event.eventId} carries a plan this backend cannot map to a tier`,
          meta: { shop: event.shop },
        });
        throw new Error("unknown_plan");
      }
      if (await eventProcessed(event.eventId)) return { ok: true, duplicate: true };
      const subscriptionTenant = await bySubscription(state.subscriptionId);
      const tenantId = subscriptionTenant ?? (await byShop(event.shop, true)) ?? (await byConnection(event.shop));
      if (!tenantId) {
        await logEvent({
          level: state.tier ? "error" : "warn",
          source: "shopify.billing",
          code: "shopify_billing_unbound",
          message: `${event.topic} ${event.eventId} has no workspace for its shop; nothing was applied`,
          meta: { shop: event.shop },
        });
        return { ok: true, unbound: true };
      }
      return apply(event, tenantId, state);
    },

    async appUninstalled(event: ShopifyBillingEvent): Promise<ShopifyBillingResult> {
      const tenantId = await byShop(event.shop);
      if (!tenantId) return { ok: true, ignored: "no_shopify_plan" };
      if (await eventProcessed(event.eventId)) return { ok: true, duplicate: true };
      return apply(event, tenantId, { subscriptionId: null, tier: null, status: "canceled" });
    },
  };
}

export const shopifyBilling = makeShopifyBillingHandler();
