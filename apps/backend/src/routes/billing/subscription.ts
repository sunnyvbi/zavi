
import type { Request, Response } from "express";
import type Stripe from "stripe";
import { requireAuth } from "@/services/auth/middleware";
import { requireTenantRole } from "@/services/auth/tenant-role";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { billingStripe } from "@/services/billing/client";
import {
  isBillingTerm,
  sixMonthPriceMismatch,
  termForPriceId,
  tierForPriceId,
  tierPriceId,
  type BillingTerm,
} from "@/services/billing/plans";
import { isPaidTier, isTier, tierRank, type PaidTier, type Tier } from "@/services/billing/tiers";
import { isLiveStorePlan, isShopifySource, managedElsewhere, storeTermForProduct } from "@/services/billing/store-rail";
import { planChangePortalConfiguration } from "@/services/billing/portal-config";
import { logEvent } from "@/services/logging/logEvent";
import { ACTIVE_STATUSES } from "./checkout";

const PUBLIC_BASE = (): string =>
  process.env.PRAXIS_PUBLIC_BASE ?? "https://www.zaviagent.com";

const UPGRADE_RETURN_PATH = "/workspace?tab=settings&billing=upgraded#billing";
const SETTINGS_RETURN_PATH = "/workspace?tab=settings#billing";

type SubRow = {
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  status: string;
  source: string | null;
  tier: string | null;
  store_product_id: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean | null;
};

export type PlanChangeKind = "upgrade" | "downgrade" | "same";

export function classifyPlanChange(
  from: { tier: Tier; term: BillingTerm },
  to: { tier: Tier; term: BillingTerm },
): PlanChangeKind {
  const a = tierRank(from.tier);
  const b = tierRank(to.tier);
  if (b > a) return "upgrade";
  if (b < a) return "downgrade";
  if (from.term === to.term) return "same";
  return to.term === "6mo" ? "upgrade" : "downgrade";
}

function idOf(v: string | { id: string } | null | undefined): string | null {
  if (!v) return null;
  return typeof v === "string" ? v : v.id;
}

function isoOf(unixSeconds: number | null | undefined): string | null {
  return typeof unixSeconds === "number" && unixSeconds > 0
    ? new Date(unixSeconds * 1000).toISOString()
    : null;
}

function notConfigured(res: Response): void {
  res
    .status(503)
    .json({ error: { code: "billing_not_configured", message: "Billing is not configured yet." } });
}

async function loadSubRow(tenantId: string): Promise<{ row: SubRow | null; error: string | null }> {
  const { data, error } = await tenantClient(asTenantId(tenantId))
    .from("tenant_subscriptions")
    .select("stripe_customer_id, stripe_subscription_id, status, source, tier, store_product_id, current_period_end, cancel_at_period_end")
    .maybeSingle<SubRow>();
  return { row: data ?? null, error: error?.message ?? null };
}

function isLive(row: SubRow | null): row is SubRow & { stripe_customer_id: string; stripe_subscription_id: string } {
  return Boolean(row?.stripe_customer_id && row.stripe_subscription_id && ACTIVE_STATUSES.has(row.status));
}

function nextPhase(schedule: Stripe.SubscriptionSchedule, periodEnd: number): Stripe.SubscriptionSchedule.Phase | null {
  return schedule.phases.find((p) => p.start_date >= periodEnd) ?? null;
}

type SubscriptionView = {
  tier: Tier;
  term: BillingTerm | null;
  status: string;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  scheduled_change: { tier: PaidTier; term: BillingTerm | null; effective_at: string | null } | null;
  source: string;
};

function storeViewOf(row: SubRow): SubscriptionView {
  return {
    tier: isPaidTier(row.tier) ? row.tier : "free",
    term: isShopifySource(row.source) ? "monthly" : storeTermForProduct(row.store_product_id),
    status: row.status,
    current_period_end: row.current_period_end,
    cancel_at_period_end: Boolean(row.cancel_at_period_end),
    scheduled_change: null,
    source: row.source ?? "stripe",
  };
}

async function viewOf(stripe: Stripe, sub: Stripe.Subscription): Promise<SubscriptionView> {
  const priceId = sub.items?.data?.[0]?.price?.id ?? null;
  let scheduled: SubscriptionView["scheduled_change"] = null;
  const scheduleId = idOf(sub.schedule as string | { id: string } | null);
  if (scheduleId) {
    const schedule = await stripe.subscriptionSchedules.retrieve(scheduleId);
    const next = nextPhase(schedule, sub.current_period_end);
    const nextPrice = idOf(next?.items?.[0]?.price as string | { id: string } | undefined);
    const nextTier = tierForPriceId(nextPrice);
    if (next && nextTier) {
      scheduled = { tier: nextTier, term: termForPriceId(nextPrice), effective_at: isoOf(next.start_date) };
    }
  }
  return {
    tier: tierForPriceId(priceId) ?? "free",
    term: termForPriceId(priceId),
    status: sub.status,
    current_period_end: isoOf(sub.current_period_end),
    cancel_at_period_end: Boolean(sub.cancel_at_period_end),
    scheduled_change: scheduled,
    source: "stripe",
  };
}

async function releaseSchedule(stripe: Stripe, sub: Stripe.Subscription): Promise<void> {
  const scheduleId = idOf(sub.schedule as string | { id: string } | null);
  if (scheduleId) await stripe.subscriptionSchedules.release(scheduleId);
}

export async function billingSubscription(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const { row, error } = await loadSubRow(auth.tenant_id);
  if (error) {
    res.status(500).json({ error: { code: "internal", message: error } });
    return;
  }
  if (row && isLiveStorePlan(row)) {
    res.json({ subscription: storeViewOf(row) });
    return;
  }
  const stripe = billingStripe();
  if (!stripe) return notConfigured(res);
  if (!isLive(row)) {
    res.json({ subscription: null });
    return;
  }
  try {
    const sub = await stripe.subscriptions.retrieve(row.stripe_subscription_id);
    res.json({ subscription: await viewOf(stripe, sub) });
  } catch (e) {
    res.status(502).json({ error: { code: "stripe_error", message: (e as Error).message } });
  }
}

async function liveSubscription(
  req: Request,
  res: Response,
): Promise<{ stripe: Stripe; tenantId: string; row: SubRow & { stripe_customer_id: string; stripe_subscription_id: string } } | null> {
  const auth = await requireAuth(req, res);
  if (!auth) return null;
  if (!(await requireTenantRole(auth, ["owner", "admin"], res))) return null;
  const stripe = billingStripe();
  if (!stripe) {
    notConfigured(res);
    return null;
  }
  const { row, error } = await loadSubRow(auth.tenant_id);
  if (error) {
    res.status(500).json({ error: { code: "internal", message: error } });
    return null;
  }
  if (isLiveStorePlan(row)) {
    res.status(409).json(managedElsewhere(row));
    return null;
  }
  if (!isLive(row)) {
    res.status(409).json({ error: { code: "no_subscription", message: "No active plan to change. Pick a plan first." } });
    return null;
  }
  return { stripe, tenantId: auth.tenant_id, row };
}

async function cancelAtPeriodEnd(stripe: Stripe, sub: Stripe.Subscription): Promise<Stripe.Subscription> {
  await releaseSchedule(stripe, sub);
  return stripe.subscriptions.update(sub.id, { cancel_at_period_end: true });
}

export async function billingChangePlan(req: Request, res: Response): Promise<void> {
  await changePlan(req, res, null);
}

export async function changePlanFromCheckout(req: Request, res: Response): Promise<void> {
  await changePlan(req, res, SETTINGS_RETURN_PATH);
}

async function changePlan(req: Request, res: Response, downgradeReturnPath: string | null): Promise<void> {
  const ctx = await liveSubscription(req, res);
  if (!ctx) return;
  const { stripe, tenantId, row } = ctx;

  const body = (req.body ?? {}) as { tier?: unknown; term?: unknown };
  if (!isTier(body.tier)) {
    res.status(400).json({ error: { code: "bad_tier", message: "tier must be one of free, starter, growth, pro" } });
    return;
  }
  if (body.term !== undefined && !isBillingTerm(body.term)) {
    res.status(400).json({ error: { code: "bad_term", message: 'term must be "monthly" or "6mo"' } });
    return;
  }
  const toTier: Tier = body.tier;
  const toTerm: BillingTerm = isBillingTerm(body.term) ? body.term : "monthly";

  try {
    const sub = await stripe.subscriptions.retrieve(row.stripe_subscription_id);

    if (toTier === "free") {
      const updated = await cancelAtPeriodEnd(stripe, sub);
      res.json({ ok: true, kind: "downgrade", subscription: await viewOf(stripe, updated) });
      return;
    }

    const item = sub.items?.data?.[0];
    if (!item) {
      res.status(409).json({ error: { code: "no_subscription_item", message: "This subscription has no plan to change." } });
      return;
    }
    const price = tierPriceId(toTier, toTerm);
    if (!price) {
      res.status(503).json({ error: { code: "price_not_configured", message: `no ${toTerm} price for ${toTier}` } });
      return;
    }
    if (toTerm === "6mo") {
      const mismatch = sixMonthPriceMismatch(toTier, await stripe.prices.retrieve(price));
      if (mismatch) {
        await logEvent({
          level: "error", source: "billing-change-plan", code: "billing.six_month_price_mismatch",
          message: `six-month ${toTier} price does not match the quote: ${mismatch}`,
          tenant_id: tenantId,
        });
        res.status(503).json({
          error: { code: "price_misconfigured", message: `the ${toTerm} price for ${toTier} does not match the quoted price` },
        });
        return;
      }
    }

    const kind = classifyPlanChange(
      { tier: tierForPriceId(item.price.id) ?? "free", term: termForPriceId(item.price.id) ?? "monthly" },
      { tier: toTier, term: toTerm },
    );
    if (kind === "same") {
      res.status(400).json({ error: { code: "same_plan", message: "You're already on this plan." } });
      return;
    }

    if (kind === "upgrade") {
      if (sub.cancel_at_period_end || (await viewOf(stripe, sub)).scheduled_change) {
        res.status(409).json({
          error: { code: "pending_change", message: "Keep your current plan first, then upgrade." },
        });
        return;
      }
      await releaseSchedule(stripe, sub);
      const resetQuantity = (item.quantity ?? 1) !== 1;
      const portal = await stripe.billingPortal.sessions.create({
        customer: row.stripe_customer_id,
        configuration: await planChangePortalConfiguration(
          stripe,
          toTerm,
          tierForPriceId(item.price.id) ? "confirm" : "picker",
          { quantity: resetQuantity },
        ),
        return_url: `${PUBLIC_BASE()}${SETTINGS_RETURN_PATH}`,
        flow_data: {
          type: "subscription_update_confirm",
          subscription_update_confirm: {
            subscription: sub.id,
            items: [resetQuantity ? { id: item.id, price, quantity: 1 } : { id: item.id, price }],
          },
          after_completion: {
            type: "redirect",
            redirect: { return_url: `${PUBLIC_BASE()}${UPGRADE_RETURN_PATH}` },
          },
        },
      });
      res.json({ ok: true, kind, redirect: portal.url });
      return;
    }

    let current = sub;
    if (current.cancel_at_period_end) {
      current = await stripe.subscriptions.update(sub.id, { cancel_at_period_end: false });
    }
    const scheduleId =
      idOf(current.schedule as string | { id: string } | null) ??
      (await stripe.subscriptionSchedules.create({ from_subscription: current.id })).id;
    const schedule = await stripe.subscriptionSchedules.retrieve(scheduleId);
    const now = Math.floor(Date.now() / 1000);
    const phase =
      schedule.phases.find((p) => p.start_date <= now && p.end_date > now) ?? schedule.phases[0];
    if (!phase) {
      res.status(409).json({ error: { code: "schedule_unavailable", message: "Couldn't schedule the change. Try again." } });
      return;
    }
    const meta = { tenant_id: tenantId, tier: toTier, term: toTerm };
    type PhaseDiscount = Stripe.SubscriptionScheduleUpdateParams.Phase.Discount;
    const discounts = (phase.discounts ?? []).flatMap((d): PhaseDiscount[] => {
      const discount = idOf(d.discount);
      const promo = idOf(d.promotion_code);
      const coupon = idOf(d.coupon);
      return discount ? [{ discount }] : promo ? [{ promotion_code: promo }] : coupon ? [{ coupon }] : [];
    });
    const carried = discounts.filter((d) => d.discount);
    await stripe.subscriptionSchedules.update(scheduleId, {
      end_behavior: "release",
      phases: [
        {
          items: [{ price: item.price.id, quantity: item.quantity ?? 1 }],
          start_date: phase.start_date,
          end_date: phase.end_date,
          discounts,
          proration_behavior: "none",
        },
        {
          items: [{ price, quantity: 1 }],
          discounts: carried,
          iterations: 1,
          proration_behavior: "none",
          metadata: meta,
        },
      ],
    });
    const fresh = await stripe.subscriptions.retrieve(sub.id);
    res.json({
      ok: true,
      kind,
      subscription: await viewOf(stripe, fresh),
      ...(downgradeReturnPath ? { redirect: `${PUBLIC_BASE()}${downgradeReturnPath}` } : {}),
    });
  } catch (e) {
    res.status(502).json({ error: { code: "stripe_error", message: (e as Error).message } });
  }
}

export async function billingCancel(req: Request, res: Response): Promise<void> {
  const ctx = await liveSubscription(req, res);
  if (!ctx) return;
  const { stripe, row } = ctx;
  try {
    const sub = await stripe.subscriptions.retrieve(row.stripe_subscription_id);
    const updated = await cancelAtPeriodEnd(stripe, sub);
    res.json({ ok: true, subscription: await viewOf(stripe, updated) });
  } catch (e) {
    res.status(502).json({ error: { code: "stripe_error", message: (e as Error).message } });
  }
}

export async function billingResume(req: Request, res: Response): Promise<void> {
  const ctx = await liveSubscription(req, res);
  if (!ctx) return;
  const { stripe, row } = ctx;
  try {
    let sub = await stripe.subscriptions.retrieve(row.stripe_subscription_id);
    await releaseSchedule(stripe, sub);
    if (sub.cancel_at_period_end) {
      sub = await stripe.subscriptions.update(sub.id, { cancel_at_period_end: false });
    } else {
      sub = await stripe.subscriptions.retrieve(sub.id);
    }
    res.json({ ok: true, subscription: await viewOf(stripe, sub) });
  } catch (e) {
    res.status(502).json({ error: { code: "stripe_error", message: (e as Error).message } });
  }
}
