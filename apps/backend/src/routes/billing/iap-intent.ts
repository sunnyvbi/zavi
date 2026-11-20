
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { requireTenantRole } from "@/services/auth/tenant-role";
import { asTenantId, storeBillingClient, tenantClient } from "@/services/tenant-client";
import { isLiveShopifyPlan, isLiveStorePlan } from "@/services/billing/store-rail";
import { ACTIVE_STATUSES } from "./checkout";

type SubscriptionRow = {
  status: string | null;
  source: string | null;
  stripe_subscription_id: string | null;
  grandfathered: boolean | null;
  credits_revoked_at: string | null;
};

const hasLiveStripePlan = (row: SubscriptionRow | null): boolean =>
  !!row && !!row.stripe_subscription_id && ACTIVE_STATUSES.has(row.status ?? "") && !isLiveStorePlan(row);

const refuse = (res: Response, code: string, message: string): void => {
  res.status(409).json({ error: { code, message } });
};

export async function billingIapIntent(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  if (!(await requireTenantRole(auth, ["owner", "admin"], res))) return;

  const { data: current, error: currentErr } = await tenantClient(asTenantId(auth.tenant_id))
    .from("tenant_subscriptions")
    .select("status, source, stripe_subscription_id, grandfathered, credits_revoked_at")
    .maybeSingle<SubscriptionRow>();
  if (currentErr) {
    res.status(500).json({ error: { code: "internal", message: currentErr.message } });
    return;
  }

  if (current?.grandfathered) {
    return refuse(res, "not_purchasable", "This workspace has a free lifetime plan, so there is nothing to buy.");
  }
  if (current?.credits_revoked_at) {
    return refuse(res, "purchases_blocked", "Purchases are paused for this workspace. Please contact support.");
  }
  if (isLiveShopifyPlan(current)) {
    return refuse(res, "already_subscribed", "This workspace already has a plan billed by Shopify.");
  }
  if (isLiveStorePlan(current)) {
    return refuse(res, "already_subscribed", "This workspace already has a plan from the App Store or Google Play.");
  }
  if (hasLiveStripePlan(current)) {
    return refuse(res, "managed_on_web", "Your plan is managed on the web.");
  }

  const db = storeBillingClient("iap intent: a store account is per person, so its other workspace is looked up across workspaces");
  const { data: other, error: otherErr } = await db
    .from("tenant_subscriptions")
    .select("status, source, stripe_subscription_id, grandfathered, credits_revoked_at")
    .eq("store_app_user_id", auth.user_id)
    .neq("tenant_id", auth.tenant_id)
    .maybeSingle<SubscriptionRow>();
  if (otherErr) {
    res.status(500).json({ error: { code: "internal", message: otherErr.message } });
    return;
  }

  if (isLiveStorePlan(other)) {
    return refuse(
      res,
      "store_account_in_use",
      "Your store subscription already pays for another workspace. One store account can pay for one workspace.",
    );
  }

  const { error: bindErr } = await db
    .from("tenant_store_bindings")
    .upsert(
      { user_id: auth.user_id, tenant_id: auth.tenant_id, updated_at: new Date().toISOString() },
      { onConflict: "user_id" },
    );
  if (bindErr) {
    res.status(500).json({ error: { code: "internal", message: bindErr.message } });
    return;
  }

  res.json({ tenant_id: auth.tenant_id });
}
