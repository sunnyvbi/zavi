
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { serviceClient } from "@/services/supabase";
import {
  creditsToUsd,
  CREDIT_USD,
  creditsEnforcedFromBlob,
  shouldSoftWarnCredits,
} from "@/services/agents/credits";
import { pricingFromBlob } from "@/services/billing/credit-rate";
import { selfServeLadder } from "@/services/billing/plans";
import { isLiveStorePlan } from "@/services/billing/store-rail";
import { getBoolSetting } from "@/services/settings";
import type { Plan } from "@/services/agents/entitlement";
import { ACTIVE_STATUSES } from "./checkout";
import { TIER_DISPLAY_NAME } from "@/services/billing/tiers";
import { creditBalanceView, type BalanceRow } from "@/services/billing/balance-view";

type SubRow = {
  plan: Plan;
  status: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  tier: string | null;
  current_period_end: string | null;
  comp_expires_at: string | null;
  source: string | null;
};
export async function billingCredits(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const svc = serviceClient();

  const { data: sub, error: subErr } = await svc
    .from("tenant_subscriptions")
    .select("plan, status, stripe_customer_id, stripe_subscription_id, tier, current_period_end, comp_expires_at, source")
    .eq("tenant_id", auth.tenant_id)
    .maybeSingle<SubRow>();
  if (subErr) {
    res.status(500).json({ error: { code: "internal", message: subErr.message } });
    return;
  }
  const manageViaPortal = Boolean(
    sub?.stripe_customer_id && sub?.stripe_subscription_id && ACTIVE_STATUSES.has(sub.status),
  );
  const managedInStore = isLiveStorePlan(sub);

  const { data: bal, error: balErr } = await svc
    .from("tenant_credit_balances")
    .select("period_start, period_end, included_allowance, included_used, purchased_balance, reserved, daily_allowance, daily_used, daily_period_end")
    .eq("tenant_id", auth.tenant_id)
    .maybeSingle<BalanceRow>();
  if (balErr) {
    res.status(500).json({ error: { code: "internal", message: balErr.message } });
    return;
  }

  const { data: tenantRow } = await svc
    .from("tenants")
    .select("credits_unlimited")
    .eq("id", auth.tenant_id)
    .maybeSingle<{ credits_unlimited: boolean | null }>();
  const unlimited = tenantRow?.credits_unlimited === true;

  const { data: cfg } = await svc
    .from("system_config")
    .select("blob")
    .eq("id", 1)
    .maybeSingle<{
      blob: {
        credits_enforced?: boolean;
        credits_enforced_allowlist?: unknown;
        free_daily_credits?: unknown;
        credits_per_usd?: unknown;
        credit_tiers?: unknown;
      } | null;
    }>();
  const enforced = creditsEnforcedFromBlob(cfg?.blob, auth.tenant_id);

  const v = creditBalanceView(sub, bal, cfg?.blob);
  const { plan, tier, allowance, used, reserved, purchased } = v;
  const effectiveAvailable = v.effective_available;

  const softWarnFlag =
    !unlimited && (await getBoolSetting("credits_soft_warn_enabled", auth.tenant_id));
  const { pct_used, warn: soft_warn } = shouldSoftWarnCredits({
    allowance,
    used,
    effectiveAvailable,
    enforced,
    flagEnabled: softWarnFlag,
  });

  res.json({
    enforced,
    unlimited,
    plan,
    tier,
    tier_name: TIER_DISPLAY_NAME[tier],
    credit_usd: CREDIT_USD,
    credit_rungs: selfServeLadder(pricingFromBlob(cfg?.blob)),
    period_start: v.period_start,
    period_end: v.period_end,
    included_allowance: allowance,
    included_used: used,
    included_remaining: v.included_remaining,
    daily_allowance: v.daily_allowance,
    daily_used: v.daily_used,
    daily_remaining: v.daily_remaining,
    purchased_balance: purchased,
    reserved,
    effective_available: effectiveAvailable,
    effective_available_display: Math.max(0, effectiveAvailable),
    credits_total: v.credits_total,
    credits_used: v.credits_used,
    effective_available_usd: creditsToUsd(Math.max(0, effectiveAvailable)),
    manage_via_portal: manageViaPortal,
    source: managedInStore ? sub?.source ?? null : manageViaPortal ? "stripe" : null,
    managed_in_store: managedInStore,
    pct_used,
    soft_warn,
  });
}
