
import type { Request, Response } from "express";
import Stripe from "stripe";
import { serviceClient } from "@/services/supabase";
import { billingWebhookStripe, requireBillingStripe } from "@/services/billing/client";
import {
  planForPriceId,
  creditsUnitPriceId,
  creditsForUsdCents,
  selfServeUsdForCents,
  stripeCreditUnitAmountCents,
  tierForPriceId,
  packTierForCents,
} from "@/services/billing/plans";
import {
  getPricingConfigStrict,
  getTierCreditsStrict,
  type PricingConfig,
} from "@/services/billing/credit-rate";
import type { PaidTier } from "@/services/billing/tiers";
import { logEvent } from "@/services/logging/logEvent";
import { alert, type AlertInput } from "@/services/logging/alert";
import { requestPreviewUpgrade } from "@/services/growth/preview-upgrade";
import {
  notifyPaymentFailed as defaultNotifyPaymentFailed,
  type PaymentFailedInput,
} from "@/services/billing/payment-failed-email";
import { AFFILIATE_EVENTS, defaultAffiliateEventDeps, handleAffiliateEvent } from "@/services/affiliates/billing-events";
import { invoiceSubscriptionId } from "@/services/billing/invoice-refs";
import { inngest } from "@/../workers/client";
import { parkEvent } from "@/services/affiliates/store";

const HANDLED = new Set<string>([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.payment_failed",
  "charge.refunded",
  "charge.dispute.created",
  "charge.dispute.funds_withdrawn",
]);

const REVOKE_EVENTS = new Set<string>([
  "charge.refunded",
  "charge.dispute.created",
  "charge.dispute.funds_withdrawn",
]);

function mapStatus(s: string | undefined, eventType: string): string {
  if (eventType === "customer.subscription.deleted") return "canceled";
  switch (s) {
    case "active":
    case "trialing":
    case "past_due":
    case "canceled":
      return s;
    case "unpaid":
      return "incomplete";
    default:
      return "incomplete";
  }
}

export function subscriptionPeriodEnd(sub: unknown): string | null {
  const s = sub as {
    current_period_end?: number | null;
    items?: { data?: Array<{ current_period_end?: number | null }> };
  } | null;
  const top = s?.current_period_end;
  const fromItem = s?.items?.data?.[0]?.current_period_end;
  const secs = typeof top === "number" && top > 0 ? top
    : typeof fromItem === "number" && fromItem > 0 ? fromItem
    : null;
  return secs === null ? null : new Date(secs * 1000).toISOString();
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ApplyArgs = {
  tenant_id: string;
  customer_id: string | null;
  subscription_id: string | null;
  plan: string;
  status: string;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  event_created: number;
};

type Deps = {
  webhookSecret?: () => string | null;
  constructEvent?: (payload: Buffer, sig: string, secret: string) => Stripe.Event;
  applyState?: (args: ApplyArgs) => Promise<{ error: { message: string } | null; outcome?: string | null }>;
  alertStaff?: (input: AlertInput) => Promise<void>;
  resolveTenantByCustomer?: (customerId: string) => Promise<string | null>;
  tenantExists?: (tenantId: string) => Promise<boolean>;
  eventProcessed?: (eventId: string) => Promise<boolean>;
  markProcessed?: (eventId: string, type: string) => Promise<void>;
  setMonthlyCredits?: (
    tenantId: string,
    credits: number | null,
    monthlyUsd: number | null,
    eventCreated: number,
  ) => Promise<{ error: { message: string } | null }>;
  revokeCredits?: (
    tenantId: string,
    eventCreated: number,
    subscriptionId: string,
  ) => Promise<{ error: { message: string } | null; applied?: boolean }>;
  readRevocation?: (tenantId: string) => Promise<{ revoked: boolean; subscriptionId: string | null }>;
  clearRevocation?: (tenantId: string) => Promise<{ error: { message: string } | null }>;
  readIncludedUsed?: (tenantId: string) => Promise<number | null>;
  resolveCustomerForCharge?: (chargeId: string) => Promise<string | null>;
  resolveSubscriptionForCharge?: (chargeId: string) => Promise<string | null>;
  applyCreditTopup?: (
    tenantId: string,
    credits: number,
    paymentIntentId: string,
    eventId: string,
  ) => Promise<{ error: { message: string } | null }>;
  revokeCreditTopup?: (
    paymentIntentId: string,
    eventId: string,
    tenantHint: string | null,
  ) => Promise<{ error: { message: string } | null; outcome: string }>;
  resolvePaymentIntentForCharge?: (
    chargeId: string,
  ) => Promise<{ id: string; isTopup: boolean; isStartupOffer: boolean; tenantHint: string | null; isCreatorOrder?: boolean } | null>;
  pricingConfig?: () => Promise<PricingConfig>;
  tierCredits?: () => Promise<Record<PaidTier, number>>;
  setTier?: (
    tenantId: string,
    tier: PaidTier | null | "keep",
    eventCreated: number,
  ) => Promise<{ error: { message: string } | null }>;
  requestPreviewRerun?: (tenantId: string) => Promise<unknown>;
  clearTierForSubscription?: (
    tenantId: string,
    subscriptionId: string,
  ) => Promise<{ error: { message: string } | null }>;
  notifyPaymentFailed?: (input: PaymentFailedInput) => Promise<unknown>;
  affiliateEvent?: (event: Stripe.Event) => Promise<string>;
  affiliateRetry?: (eventId: string) => Promise<void>;
  affiliatePark?: (eventId: string) => Promise<void>;
};

async function defaultApplyState(args: ApplyArgs) {
  const { data, error } = (await serviceClient().rpc("apply_subscription_state", {
    p_tenant_id: args.tenant_id,
    p_stripe_customer_id: args.customer_id,
    p_stripe_subscription_id: args.subscription_id,
    p_plan: args.plan,
    p_status: args.status,
    p_current_period_end: args.current_period_end,
    p_cancel_at_period_end: args.cancel_at_period_end,
    p_event_created: args.event_created,
  })) as unknown as { data: string | null; error: { message: string } | null };
  return { error, outcome: data };
}

async function defaultSetTier(tenantId: string, tier: PaidTier | null | "keep", eventCreated: number) {
  const patch =
    tier === "keep"
      ? { comp_expires_at: null, tier_event_created: eventCreated, updated_at: new Date().toISOString() }
      : { tier, comp_expires_at: null, tier_event_created: eventCreated, updated_at: new Date().toISOString() };
  let q = serviceClient()
    .from("tenant_subscriptions")
    .update(patch)
    .eq("tenant_id", tenantId)
    .eq("stripe_event_created", eventCreated)
    .lt("tier_event_created", eventCreated)
    .eq("grandfathered", false);
  if (tier !== null && tier !== "keep") q = q.is("credits_revoked_at", null);
  const { error } = await q;
  return { error: error ? { message: error.message } : null };
}

async function defaultReadRevocation(tenantId: string) {
  const { data, error } = await serviceClient()
    .from("tenant_subscriptions")
    .select("credits_revoked_at, stripe_subscription_id")
    .eq("tenant_id", tenantId)
    .maybeSingle<{ credits_revoked_at: string | null; stripe_subscription_id: string | null }>();
  if (error) throw new Error(`read revocation failed: ${error.message}`);
  return { revoked: !!data?.credits_revoked_at, subscriptionId: data?.stripe_subscription_id ?? null };
}

async function defaultClearRevocation(tenantId: string) {
  const { error } = await serviceClient().rpc("clear_credit_revocation", { p_tenant_id: tenantId });
  return { error: error ? { message: error.message } : null };
}

async function defaultClearTierForSubscription(tenantId: string, subscriptionId: string) {
  const { error } = await serviceClient()
    .from("tenant_subscriptions")
    .update({ tier: null, comp_expires_at: null, updated_at: new Date().toISOString() })
    .eq("tenant_id", tenantId)
    .eq("stripe_subscription_id", subscriptionId)
    .eq("grandfathered", false);
  return { error: error ? { message: error.message } : null };
}

async function defaultResolveByCustomer(customerId: string): Promise<string | null> {
  const { data, error } = await serviceClient()
    .from("tenant_subscriptions")
    .select("tenant_id")
    .eq("stripe_customer_id", customerId)
    .maybeSingle<{ tenant_id: string }>();
  if (error) throw new Error(`resolve-by-customer failed: ${error.message}`);
  return data?.tenant_id ?? null;
}

async function defaultTenantExists(tenantId: string): Promise<boolean> {
  const { data, error } = await serviceClient()
    .from("tenants")
    .select("id")
    .eq("id", tenantId)
    .maybeSingle<{ id: string }>();
  if (error) throw new Error(`tenant-exists failed: ${error.message}`);
  return Boolean(data);
}

async function defaultEventProcessed(eventId: string): Promise<boolean> {
  const { data, error } = await serviceClient()
    .from("stripe_billing_events")
    .select("event_id")
    .eq("event_id", eventId)
    .maybeSingle<{ event_id: string }>();
  if (error) throw new Error(`event-processed check failed: ${error.message}`);
  return Boolean(data);
}

async function defaultMarkProcessed(eventId: string, type: string): Promise<void> {
  const { error } = await serviceClient()
    .from("stripe_billing_events")
    .insert({ event_id: eventId, type });
  if (error && !/duplicate key|unique/i.test(error.message)) {
    throw new Error(`mark-processed failed: ${error.message}`);
  }
}

function defaultSetMonthlyCredits(
  tenantId: string,
  credits: number | null,
  monthlyUsd: number | null,
  eventCreated: number,
) {
  return serviceClient().rpc("set_tenant_monthly_credits", {
    p_tenant_id: tenantId,
    p_monthly_credits: credits,
    p_monthly_usd: monthlyUsd,
    p_event_created: eventCreated,
  }) as unknown as Promise<{ error: { message: string } | null }>;
}

async function defaultRevokeCredits(tenantId: string, eventCreated: number, subscriptionId: string) {
  const { data, error } = (await serviceClient().rpc("revoke_tenant_credits", {
    p_tenant_id: tenantId,
    p_event_created: eventCreated,
    p_stripe_subscription_id: subscriptionId,
  })) as unknown as { data: boolean | null; error: { message: string } | null };
  return { error, applied: data === true };
}

async function defaultApplyCreditTopup(
  tenantId: string,
  credits: number,
  paymentIntentId: string,
  eventId: string,
) {
  const { error } = await serviceClient().rpc("apply_credit_topup", {
    p_tenant_id: tenantId,
    p_credits: credits,
    p_stripe_payment_intent_id: paymentIntentId,
    p_stripe_event_id: eventId,
  });
  return { error };
}

async function defaultRevokeCreditTopup(
  paymentIntentId: string,
  eventId: string,
  tenantHint: string | null,
) {
  const { data, error } = (await serviceClient().rpc("revoke_credit_topup", {
    p_stripe_payment_intent_id: paymentIntentId,
    p_stripe_event_id: eventId,
    p_tenant_hint: tenantHint,
  })) as unknown as { data: string | null; error: { message: string } | null };
  return { error, outcome: data ?? "not_a_topup" };
}

async function defaultResolvePaymentIntentForCharge(
  chargeId: string,
): Promise<{ id: string; isTopup: boolean; isStartupOffer: boolean; tenantHint: string | null; isCreatorOrder?: boolean } | null> {
  const charge = (await requireBillingStripe().charges.retrieve(chargeId)) as Stripe.Charge;
  const piRef = charge.payment_intent;
  const piId = typeof piRef === "string" ? piRef : piRef?.id ?? null;
  if (!piId) return null;
  const pi = (await requireBillingStripe().paymentIntents.retrieve(piId)) as Stripe.PaymentIntent;
  const md = (pi.metadata as Record<string, string> | undefined) ?? {};
  const isTopup = md.kind === "credit_topup";
  const isStartupOffer = md.kind === "startup_offer";
  const tenantHint =
    md.tenant_id && /^[0-9a-f-]{36}$/i.test(md.tenant_id) ? md.tenant_id : null;
  const isCreatorOrder = typeof md.zavi_creator_order_id === "string" && md.zavi_creator_order_id.length > 0;
  return { id: piId, isTopup, isStartupOffer, tenantHint, isCreatorOrder };
}

async function defaultReadIncludedUsed(tenantId: string): Promise<number | null> {
  try {
    const { data, error } = await serviceClient()
      .from("tenant_credit_balances")
      .select("included_used")
      .eq("tenant_id", tenantId)
      .maybeSingle<{ included_used: number }>();
    if (error || !data) return null;
    return typeof data.included_used === "number" ? data.included_used : null;
  } catch {
    return null;
  }
}

async function defaultResolveCustomerForCharge(chargeId: string): Promise<string | null> {
  const charge = await requireBillingStripe().charges.retrieve(chargeId);
  const cust = (charge as Stripe.Charge).customer;
  return typeof cust === "string" ? cust : cust?.id ?? null;
}

async function defaultResolveSubscriptionForCharge(chargeId: string): Promise<string | null> {
  const charge = (await requireBillingStripe().charges.retrieve(chargeId)) as Stripe.Charge;
  const invoiceRef = charge.invoice;
  const invoiceId = typeof invoiceRef === "string" ? invoiceRef : invoiceRef?.id ?? null;
  if (!invoiceId) return null;
  const invoice = (await requireBillingStripe().invoices.retrieve(invoiceId)) as Stripe.Invoice;
  const subRef = (invoice as unknown as { subscription?: string | { id?: string } | null }).subscription;
  return typeof subRef === "string" ? subRef : subRef?.id ?? null;
}

export function makeStripeBillingWebhook(deps: Deps = {}) {
  const getSecret = deps.webhookSecret ?? (() => process.env.STRIPE_BILLING_WEBHOOK_SECRET ?? null);
  const construct =
    deps.constructEvent ??
    ((payload, sig, secret) => billingWebhookStripe().webhooks.constructEvent(payload, sig, secret));
  const applyState = deps.applyState ?? defaultApplyState;
  const alertStaff = deps.alertStaff ?? alert;
  const resolveByCustomer = deps.resolveTenantByCustomer ?? defaultResolveByCustomer;
  const tenantExists = deps.tenantExists ?? defaultTenantExists;
  const eventProcessed = deps.eventProcessed ?? defaultEventProcessed;
  const markProcessed = deps.markProcessed ?? defaultMarkProcessed;
  const setMonthlyCredits = deps.setMonthlyCredits ?? defaultSetMonthlyCredits;
  const applyCreditTopup = deps.applyCreditTopup ?? defaultApplyCreditTopup;
  const revokeCreditTopup = deps.revokeCreditTopup ?? defaultRevokeCreditTopup;
  const resolvePaymentIntentForCharge =
    deps.resolvePaymentIntentForCharge ?? defaultResolvePaymentIntentForCharge;
  const revokeCredits = deps.revokeCredits ?? defaultRevokeCredits;
  const readIncludedUsed = deps.readIncludedUsed ?? defaultReadIncludedUsed;
  const resolveCustomerForCharge = deps.resolveCustomerForCharge ?? defaultResolveCustomerForCharge;
  const resolveSubscriptionForCharge =
    deps.resolveSubscriptionForCharge ?? defaultResolveSubscriptionForCharge;
  const pricingConfig = deps.pricingConfig ?? getPricingConfigStrict;
  const tierCredits = deps.tierCredits ?? getTierCreditsStrict;
  const setTier = deps.setTier ?? defaultSetTier;
  const requestPreviewRerun = deps.requestPreviewRerun ?? requestPreviewUpgrade;
  const clearTierForSubscription = deps.clearTierForSubscription ?? defaultClearTierForSubscription;
  const readRevocation = deps.readRevocation ?? defaultReadRevocation;
  const notifyPaymentFailed = deps.notifyPaymentFailed ?? defaultNotifyPaymentFailed;
  const clearRevocation = deps.clearRevocation ?? defaultClearRevocation;
  const affiliateEvent =
    deps.affiliateEvent ?? ((e: Stripe.Event) => handleAffiliateEvent(e, defaultAffiliateEventDeps(requireBillingStripe)));
  const affiliateRetry =
    deps.affiliateRetry ??
    (async (eventId: string) => {
      await inngest.send({ id: `affiliate-retry-${eventId}`, name: "affiliate/stripe-event.retry", data: { event_id: eventId } });
    });
  const affiliatePark = deps.affiliatePark ?? parkEvent;

  const billingStuck = async (event: Stripe.Event, code: string, tenantId: string | null) => {
    try {
      await alertStaff({
        source: "stripe-billing-webhook",
        code: `billing_webhook_${code}`,
        tenant_id: tenantId,
        msg: `Stripe ${event.type} ${event.id} was not applied (${code}). Stripe retries for about 3 days; until it lands, a paying customer may be on the wrong plan or missing credits.`,
        email: { dedupeKey: `billing-webhook:${code}:${Math.floor(Date.now() / 3_600_000)}` },
      });
    } catch {
    }
  };

  return async function stripeBillingWebhook(req: Request, res: Response): Promise<void> {
    const secret = getSecret();
    if (!secret) {
      res.status(503).json({ error: { code: "billing_webhook_disabled", message: "STRIPE_BILLING_WEBHOOK_SECRET unset" } });
      return;
    }
    const signature = String(req.header("stripe-signature") ?? "");
    if (!signature) {
      res.status(400).json({ error: { code: "no_signature", message: "stripe-signature missing" } });
      return;
    }
    const rawBuf = (req.body as Buffer | undefined) ?? Buffer.alloc(0);

    let event: Stripe.Event;
    try {
      event = construct(rawBuf, signature, secret);
    } catch (e) {
      res.status(400).json({ error: { code: "bad_signature", message: (e as Error).message } });
      return;
    }

    if (AFFILIATE_EVENTS.has(event.type)) {
      try {
        const outcome = await affiliateEvent(event);
        if (outcome !== "not_referred" && outcome !== "ignored") {
          void logEvent({
            level: "info", source: "stripe-billing-webhook", code: "affiliate.event",
            message: `affiliate ${event.type}: ${outcome}`,
            meta: { event_id: event.id },
          });
        }
      } catch (e) {
        void logEvent({
          level: "error", source: "stripe-billing-webhook", code: "affiliate.event_failed",
          message: `affiliate ${event.type} failed, handed to the retry worker: ${(e as Error).message?.slice(0, 200)}`,
          meta: { event_id: event.id },
        });
        try {
          await affiliateRetry(event.id);
        } catch {
          try {
            await affiliatePark(event.id);
          } catch {
            res.status(500).json({ error: { code: "affiliate_event_failed", message: "retry" } });
            return;
          }
        }
      }
    }

    if (!HANDLED.has(event.type)) {
      res.status(200).json({ ok: true, ignored: event.type });
      return;
    }

    try {
      if (await eventProcessed(event.id)) {
        res.status(200).json({ ok: true, duplicate: event.id });
        return;
      }

      const obj = event.data.object as unknown as Record<string, unknown>;
      let customerId = typeof obj.customer === "string" ? obj.customer : null;
      if (
        !customerId &&
        (event.type === "charge.dispute.created" || event.type === "charge.dispute.funds_withdrawn")
      ) {
        const chargeId = typeof obj.charge === "string" ? obj.charge : null;
        if (chargeId) customerId = await resolveCustomerForCharge(chargeId);
      }
      const metaTenant = (obj.metadata as Record<string, string> | undefined)?.tenant_id ?? null;
      const isSubEvent = event.type.startsWith("customer.subscription.");

      const creatorOrderId =
        event.type === "checkout.session.completed"
          ? (obj.metadata as Record<string, unknown> | undefined)?.zavi_creator_order_id
          : undefined;
      if (typeof creatorOrderId === "string" && creatorOrderId.length > 0) {
        await markProcessed(event.id, event.type);
        await logEvent({
          level: "info", source: "stripe-billing-webhook", code: "billing.creator_checkout_ignored",
          message: `billing ${event.type}: creator-marketplace checkout, handled by the creator webhook`,
          meta: { event_id: event.id, object_id: String(obj.id ?? ""), creator_order_id: creatorOrderId },
        });
        res.status(200).json({ ok: true, type: event.type, note: "creator-checkout-ignored" });
        return;
      }

      if (REVOKE_EVENTS.has(event.type)) {
        const rvChargeId =
          event.type === "charge.refunded"
            ? (typeof obj.id === "string" ? obj.id : null)
            : (typeof obj.charge === "string" ? obj.charge : null);
        const piInfo = rvChargeId ? await resolvePaymentIntentForCharge(rvChargeId) : null;
        if (piInfo?.isCreatorOrder) {
          await markProcessed(event.id, event.type);
          await logEvent({
            level: "info", source: "stripe-billing-webhook", code: "billing.creator_charge_ignored",
            message: `billing ${event.type}: creator-marketplace charge, handled by the creator webhook`,
            meta: { event_id: event.id, charge_id: String(rvChargeId ?? "") },
          });
          res.status(200).json({ ok: true, type: event.type, note: "creator-charge-ignored" });
          return;
        }
        if (piInfo?.isStartupOffer) {
          const { data: outcome, error: soErr } = (await serviceClient().rpc(
            "tombstone_startup_claim",
            {
              p_payment_intent: piInfo.id,
              p_grant_key: `startup:${piInfo.id}`,
              p_reason: event.type,
            },
          )) as unknown as { data: string | null; error: { message: string } | null };
          if (soErr) {
            res.status(500).json({ error: { code: "startup_offer_revoke_failed", message: soErr.message } });
            return;
          }
          await markProcessed(event.id, event.type);
          await logEvent({
            level: "info", source: "stripe-billing-webhook", code: `billing.${event.type}`,
            message: `billing ${event.type}: startup offer ${outcome ?? "unknown"}`,
            tenant_id: piInfo.tenantHint,
            meta: { event_id: event.id, charge_id: String(rvChargeId ?? ""), outcome: String(outcome ?? "") },
          });
          res.status(200).json({ ok: true, type: event.type, note: `startup-offer-${outcome ?? "unknown"}` });
          return;
        }
        if (piInfo?.isTopup) {
          const { error: tuErr, outcome } = await revokeCreditTopup(
            piInfo.id, event.id, piInfo.tenantHint,
          );
          if (tuErr) {
            res.status(500).json({ error: { code: "topup_revoke_failed", message: tuErr.message } });
            return;
          }
          if (outcome === "not_a_topup") {
            await logEvent({
              level: "error", source: "stripe-billing-webhook", code: "billing.topup.revoke_no_tenant",
              message: `top-up ${event.type}: PI is a top-up but tenant hint invalid — cannot tombstone, retrying`,
              meta: { event_id: event.id, payment_intent: piInfo.id },
            });
            await billingStuck(event, "topup_revoke_no_tenant", null);
            res.status(503).json({ error: { code: "topup_revoke_no_tenant", message: "retry" } });
            return;
          }
          await markProcessed(event.id, event.type);
          await logEvent({
            level: "info", source: "stripe-billing-webhook", code: `billing.${event.type}`,
            message: `billing ${event.type}: top-up ${outcome}`,
            tenant_id: piInfo.tenantHint,
            meta: { event_id: event.id, charge_id: String(rvChargeId ?? ""), outcome },
          });
          res.status(200).json({ ok: true, type: event.type, note: `topup-${outcome}` });
          return;
        }
      }

      let tenantId: string | null = null;
      if (customerId) tenantId = await resolveByCustomer(customerId);
      if (!tenantId && metaTenant && UUID_RE.test(metaTenant)) {
        if (await tenantExists(metaTenant)) tenantId = metaTenant;
      }
      if (!tenantId) {
        await logEvent({
          level: "warn", source: "stripe-billing-webhook", code: "tenant_unresolved",
          message: `billing ${event.type}: tenant unresolved`,
          meta: { event_id: event.id, object_id: String(obj.id ?? "") },
        });
        await billingStuck(event, "tenant_unresolved", null);
        res.status(503).json({ error: { code: "tenant_unresolved", message: "retry" } });
        return;
      }

      if (REVOKE_EVENTS.has(event.type)) {
        const chargeId =
          event.type === "charge.refunded"
            ? (typeof obj.id === "string" ? obj.id : null)
            : (typeof obj.charge === "string" ? obj.charge : null);

        const isPartialRefund =
          event.type === "charge.refunded" && obj.refunded !== true;
        if (isPartialRefund) {
          await markProcessed(event.id, event.type);
          await logEvent({
            level: "info", source: "stripe-billing-webhook", code: `billing.${event.type}`,
            message: `billing ${event.type}: partial refund — credits NOT revoked`, tenant_id: tenantId,
            meta: { event_id: event.id },
          });
          res.status(200).json({ ok: true, type: event.type, note: "partial-refund-skipped" });
          return;
        }

        const subscriptionId = chargeId ? await resolveSubscriptionForCharge(chargeId) : null;
        if (!subscriptionId) {
          await markProcessed(event.id, event.type);
          await logEvent({
            level: "info", source: "stripe-billing-webhook", code: `billing.${event.type}`,
            message: `billing ${event.type}: no granting subscription for charge — credits NOT revoked`,
            tenant_id: tenantId, meta: { event_id: event.id, charge_id: String(chargeId ?? "") },
          });
          res.status(200).json({ ok: true, type: event.type, note: "unrelated-charge-skipped" });
          return;
        }

        const { error: rvErr, applied } = await revokeCredits(tenantId, event.created, subscriptionId);
        if (rvErr) {
          res.status(500).json({ error: { code: "revoke_failed", message: rvErr.message } });
          return;
        }
        if (applied) {
          const { error: ctErr } = await clearTierForSubscription(tenantId, subscriptionId);
          if (ctErr) {
            res.status(500).json({ error: { code: "clear_tier_failed", message: ctErr.message } });
            return;
          }
        }
        await markProcessed(event.id, event.type);
        await logEvent({
          level: "info", source: "stripe-billing-webhook", code: `billing.${event.type}`,
          message: `billing ${event.type}: ${applied ? "credits revoked + blocked" : "subscription mismatch — no revoke"}`,
          tenant_id: tenantId, meta: { event_id: event.id },
        });
        res.status(200).json({
          ok: true, type: event.type,
          note: applied ? "credits-revoked" : "subscription-mismatch-skipped",
        });
        return;
      }

      let subscriptionId: string | null = null;
      let plan: string | null = null;
      let status = mapStatus(undefined, event.type);
      let periodEnd: string | null = null;
      let cancelAtPeriodEnd = false;
      let monthlyCredits: number | null = null;
      let monthlyUsd: number | null = null;
      let tier: PaidTier | null = null;

      if (isSubEvent) {
        const sub = obj as unknown as Stripe.Subscription;
        subscriptionId = sub.id ?? null;
        status = mapStatus(sub.status, event.type);
        cancelAtPeriodEnd = Boolean(sub.cancel_at_period_end);
        periodEnd = subscriptionPeriodEnd(sub);
        const item = sub.items?.data?.[0];
        const priceId = item?.price?.id;
        const unitPrice = creditsUnitPriceId();
        const priceTier = tierForPriceId(priceId);

        if (status === "canceled") {
          plan = "free";
        } else if (priceTier) {
          plan = "team";
          tier = priceTier;
        } else if (unitPrice && priceId === unitPrice) {
          plan = "team";
          const qty = item?.quantity ?? 0;
          const unitAmountCents = item?.price?.unit_amount ?? stripeCreditUnitAmountCents();
          if (!(qty > 0) || !(unitAmountCents > 0)) {
            await logEvent({
              level: "error", source: "stripe-billing-webhook", code: "ladder_missing_quantity",
              message: `billing ${event.type}: credit-ladder price with no billable quantity/unit amount`,
              tenant_id: tenantId,
              meta: { event_id: event.id, price_id: String(priceId ?? "") },
            });
            await billingStuck(event, "ladder_missing_quantity", tenantId);
            res.status(503).json({ error: { code: "ladder_missing_quantity", message: "retry" } });
            return;
          }
          let pricing: PricingConfig;
          try {
            pricing = await pricingConfig();
          } catch (e) {
            await logEvent({
              level: "error", source: "stripe-billing-webhook", code: "credit_rate_unavailable",
              message: `billing ${event.type}: sell pricing unreadable — deferring grant`,
              tenant_id: tenantId,
              meta: { event_id: event.id },
            });
            await billingStuck(event, "credit_rate_unavailable", tenantId);
            res.status(503).json({ error: { code: "credit_rate_unavailable", message: (e as Error).message } });
            return;
          }
          const billedCents = qty * unitAmountCents;
          monthlyUsd = selfServeUsdForCents(billedCents);
          monthlyCredits = creditsForUsdCents(billedCents, pricing);
          if (!(monthlyCredits > 0)) {
            await billingStuck(event, "ladder_zero_credits", tenantId);
            res.status(503).json({ error: { code: "ladder_zero_credits", message: "retry" } });
            return;
          }
        } else {
          plan = planForPriceId(priceId);
        }

        if (!plan) {
          await logEvent({
            level: "error", source: "stripe-billing-webhook", code: "unknown_price",
            message: `billing ${event.type}: price not mapped to a tier or plan — no grant`,
            tenant_id: tenantId,
            meta: { event_id: event.id, price_id: String(priceId ?? ""), status },
          });
          await billingStuck(event, "unknown_price", tenantId);
          res.status(503).json({ error: { code: "unknown_price", message: "price not configured" } });
          return;
        }
      } else if (event.type === "checkout.session.completed") {
        const sess = obj as unknown as Stripe.Checkout.Session;
        const sessMeta = (sess.metadata as Record<string, string> | undefined) ?? {};
        if (sess.mode === "payment" && sessMeta.kind === "startup_offer") {
          const pi = typeof sess.payment_intent === "string" ? sess.payment_intent : null;
          const paidOk = sess.payment_status === "paid";
          const currencyOk = (sess.currency ?? "").toLowerCase() === "usd";
          const { data: offerRow } = await serviceClient()
            .from("startup_offer")
            .select("price_cents")
            .eq("slug", sessMeta.offer_slug ?? "")
            .maybeSingle<{ price_cents: number }>();
          const amountOk =
            typeof sess.amount_total === "number" &&
            typeof offerRow?.price_cents === "number" &&
            sess.amount_total === offerRow.price_cents;

          if (!pi || !paidOk || !currencyOk || !amountOk) {
            await markProcessed(event.id, event.type);
            await logEvent({
              level: "warn", source: "stripe-billing-webhook", code: "billing.startup_offer.rejected",
              message: "startup-offer session failed validation — NOT granted",
              tenant_id: tenantId,
              meta: {
                event_id: event.id, has_pi: Boolean(pi), paid: paidOk,
                currency_ok: currencyOk, amount_ok: amountOk,
                amount_total: typeof sess.amount_total === "number" ? sess.amount_total : null,
              },
            });
            res.status(200).json({ ok: true, type: event.type, note: "startup-offer-validation-rejected" });
            return;
          }

          const { data: outcome, error: soErr } = (await serviceClient().rpc("settle_startup_claim", {
            p_payment_intent: pi,
            p_grant_key: `startup:${pi}`,
            p_actor_email: "stripe-webhook",
          })) as unknown as { data: string | null; error: { message: string } | null };

          if (soErr) {
            res.status(500).json({ error: { code: "startup_offer_grant_failed", message: soErr.message } });
            return;
          }
          await markProcessed(event.id, event.type);
          await logEvent({
            level: outcome === "granted" || outcome === "already_granted" ? "info" : "warn",
            source: "stripe-billing-webhook", code: "billing.startup_offer.settled",
            message: `startup offer settle: ${outcome ?? "unknown"}`,
            tenant_id: tenantId,
            meta: { event_id: event.id, outcome: String(outcome ?? "") },
          });
          res.status(200).json({ ok: true, type: event.type, note: `startup-offer-${outcome ?? "unknown"}` });
          return;
        }

        if (sess.mode === "payment" && sessMeta.kind === "credit_topup") {
          const pi = typeof sess.payment_intent === "string" ? sess.payment_intent : null;
          const paidCents = typeof sess.amount_total === "number" ? sess.amount_total : null;
          const packTier = packTierForCents(paidCents);
          const paidOk = sess.payment_status === "paid";
          const currencyOk = (sess.currency ?? "").toLowerCase() === "usd";
          if (!pi || packTier === null || !paidOk || !currencyOk) {
            await markProcessed(event.id, event.type);
            await logEvent({
              level: "warn", source: "stripe-billing-webhook", code: "billing.topup.rejected",
              message: `top-up session failed validation — NOT granted`, tenant_id: tenantId,
              meta: {
                event_id: event.id, has_pi: Boolean(pi),
                paid: paidOk, currency_ok: currencyOk, amount_ok: packTier !== null,
                amount_total: paidCents,
                claimed_credits: Number(sessMeta.credits) || null,
              },
            });
            res.status(200).json({ ok: true, type: event.type, note: "topup-validation-rejected" });
            return;
          }
          let packCredits: Record<PaidTier, number>;
          try {
            packCredits = await tierCredits();
          } catch (e) {
            await billingStuck(event, "credit_rate_unavailable", tenantId);
            res.status(503).json({ error: { code: "credit_rate_unavailable", message: (e as Error).message } });
            return;
          }
          const credits = packCredits[packTier];
          if (!(credits > 0)) {
            await billingStuck(event, "topup_zero_credits", tenantId);
            res.status(503).json({ error: { code: "topup_zero_credits", message: "retry" } });
            return;
          }
          const { error: tuErr } = await applyCreditTopup(tenantId, credits, pi, event.id);
          if (tuErr) {
            res.status(500).json({ error: { code: "topup_failed", message: tuErr.message } });
            return;
          }
          {
            const { error: crErr } = await clearRevocation(tenantId);
            if (crErr) {
              res.status(500).json({ error: { code: "clear_revocation_failed", message: crErr.message } });
              return;
            }
          }
          await markProcessed(event.id, event.type);
          await logEvent({
            level: "info", source: "stripe-billing-webhook", code: "billing.topup.granted",
            message: `top-up granted: ${credits} credits`, tenant_id: tenantId,
            meta: { event_id: event.id, usd: paidCents! / 100, pack_tier: packTier },
          });
          res.status(200).json({ ok: true, type: event.type, note: "topup-granted" });
          return;
        }
        subscriptionId = typeof sess.subscription === "string" ? sess.subscription : null;
        await markProcessed(event.id, event.type);
        res.status(200).json({ ok: true, type: event.type, note: "binding-via-subscription-event" });
        return;
      } else if (event.type === "invoice.payment_failed") {
        const invoiceId = typeof obj.id === "string" ? obj.id : null;
        const invoiceSub = invoiceSubscriptionId(obj);
        const billingReason = typeof obj.billing_reason === "string" ? obj.billing_reason : null;
        const current = invoiceId && invoiceSub ? (await readRevocation(tenantId)).subscriptionId : null;
        if (invoiceId && invoiceSub && invoiceSub === current && billingReason !== "subscription_create") {
          try {
            await notifyPaymentFailed({
              tenantId,
              invoiceId,
              amountDueCents: typeof obj.amount_due === "number" ? obj.amount_due : null,
              currency: typeof obj.currency === "string" ? obj.currency : null,
              attemptCount: typeof obj.attempt_count === "number" ? obj.attempt_count : null,
              billingReason,
            });
          } catch (e) {
            await logEvent({
              level: "error", source: "stripe-billing-webhook", code: "billing.payment_failed.notify_failed",
              message: `payment-failed notice not sent, retrying: ${(e as Error).message}`, tenant_id: tenantId,
              meta: { event_id: event.id, object_id: invoiceId },
            });
            res.status(500).json({ error: { code: "payment_failed_notify_failed", message: "retry" } });
            return;
          }
        } else {
          await logEvent({
            level: "info", source: "stripe-billing-webhook", code: "billing.payment_failed.not_notified",
            message: `payment failed on an invoice that is not a renewal of the current subscription (${billingReason ?? "unknown"}); no email`,
            tenant_id: tenantId,
            meta: { event_id: event.id, object_id: invoiceId ?? "" },
          });
        }
        await markProcessed(event.id, event.type);
        res.status(200).json({ ok: true, type: event.type, note: "dunning-via-subscription-event" });
        return;
      }

      let liftRefundBlock = false;
      let alreadyOnThisSubscription = false;
      if (
        event.type.startsWith("customer.subscription.") &&
        (status === "active" || status === "trialing") &&
        subscriptionId
      ) {
        const rv = await readRevocation(tenantId);
        liftRefundBlock =
          rv.revoked && (rv.subscriptionId !== subscriptionId || event.type === "customer.subscription.created");
        alreadyOnThisSubscription = rv.subscriptionId === subscriptionId;
      }

      const { error: applyErr, outcome: applyOutcome } = await applyState({
        tenant_id: tenantId,
        customer_id: customerId,
        subscription_id: subscriptionId,
        plan: plan as string,
        status,
        current_period_end: periodEnd,
        cancel_at_period_end: cancelAtPeriodEnd,
        event_created: event.created,
      });
      if (applyErr) {
        res.status(500).json({ error: { code: "apply_failed", message: applyErr.message } });
        return;
      }

      if (applyOutcome === "store_active" || applyOutcome === "shopify_active") {
        const liveOnStripe = status === "active" || status === "trialing" || status === "past_due";
        if (liveOnStripe) {
          await alertStaff({
            source: "stripe-billing-webhook",
            code: "stripe_skipped_store_active",
            tenant_id: tenantId,
            msg: `Stripe ${event.type} ${event.id} (subscription ${subscriptionId ?? "none"}, status ${status}) was not applied: the workspace has a live ${applyOutcome === "shopify_active" ? "Shopify" : "App Store / Play"} plan. The customer may be billed on both; cancel or refund one.`,
          });
        } else {
          await logEvent({
            level: "info",
            source: "stripe-billing-webhook",
            code: "stripe_skipped_store_active",
            tenant_id: tenantId,
            message: `Stripe ${event.type} ${event.id} (status ${status}) skipped: the workspace has a live store plan.`,
          });
        }
        await markProcessed(event.id, event.type);
        res.status(200).json({ ok: true, type: event.type, note: "skipped-store-plan-active" });
        return;
      }

      if (liftRefundBlock && (applyOutcome !== "skipped" || alreadyOnThisSubscription)) {
        const { error: crErr } = await clearRevocation(tenantId);
        if (crErr) {
          res.status(500).json({ error: { code: "clear_revocation_failed", message: crErr.message } });
          return;
        }
        await logEvent({
          level: "info",
          source: "stripe-billing-webhook",
          code: "billing.refund_block_cleared",
          message: "refund block cleared by a new subscription",
          tenant_id: tenantId,
          meta: { event_id: event.id },
        });
      }

      let paidTierLanded = false;
      if (isSubEvent) {
        let tierWrite: PaidTier | null | "keep";
        if (status === "canceled") tierWrite = null;
        else if (tier !== null) tierWrite = status === "active" || status === "trialing" ? tier : "keep";
        else tierWrite = null;
        {
          const { error: tErr } = await setTier(tenantId, tierWrite, event.created);
          if (tErr) {
            res.status(500).json({ error: { code: "set_tier_failed", message: tErr.message } });
            return;
          }
        }
        if (tierWrite !== null && tierWrite !== "keep") paidTierLanded = true;
      }

      let grantCredits: number | null | undefined;
      if (status === "canceled") {
        grantCredits = null;
      } else if (monthlyCredits !== null) {
        grantCredits = status === "active" || status === "trialing" ? monthlyCredits : undefined;
      } else {
        grantCredits = null;
      }
      if (grantCredits !== undefined) {
        const { error: mcErr } = await setMonthlyCredits(
          tenantId,
          grantCredits,
          grantCredits === null ? null : monthlyUsd,
          event.created,
        );
        if (mcErr) {
          res.status(500).json({ error: { code: "set_credits_failed", message: mcErr.message } });
          return;
        }
      }

      if (paidTierLanded) {
        try {
          await requestPreviewRerun(tenantId);
        } catch (e) {
          await logEvent({
            level: "warn",
            source: "webhook.stripe-billing",
            code: "preview_rerun_request_failed",
            tenant_id: tenantId,
            error: e,
          });
          res.status(500).json({ error: { code: "preview_rerun_request_failed", message: "Could not queue the upgraded channels." } });
          return;
        }
      }

      await markProcessed(event.id, event.type);

      if (typeof grantCredits === "number") {
        try {
          const usedNow = await readIncludedUsed(tenantId);
          if (typeof usedNow === "number" && grantCredits < usedNow) {
            await logEvent({
              level: "warn",
              source: "stripe-billing-webhook",
              code: "billing.allowance.shrunk_below_used",
              message: `subscription volume dropped allowance below credits already used this period`,
              tenant_id: tenantId,
              meta: { code: "allowance_below_used" },
            });
          }
        } catch {
        }
      }

      await logEvent({
        level: "info", source: "stripe-billing-webhook", code: `billing.${event.type}`,
        message: `billing ${event.type} applied`, tenant_id: tenantId,
        meta: { event_id: event.id, plan, status, tier },
      });
      res.status(200).json({ ok: true, type: event.type, plan, status, tier });
    } catch (e) {
      res.status(500).json({ error: { code: "internal", message: (e as Error).message } });
    }
  };
}

export const stripeBillingWebhook = makeStripeBillingWebhook();
