
import type { Request, Response } from "express";
import Stripe from "stripe";
import { STRIPE_API_VERSION } from "@/services/tools/stripe/_platform-client";
import { logEvent } from "@/services/logging/logEvent";
import { serviceClient } from "@/services/supabase";
import {
  findHeldFundByChargeId,
  markHeldFundRefunded,
  type HeldFundRow,
} from "@/services/tools/stripe/held-funds";
import { inngest } from "../../../workers/client";

const HANDLED_EVENTS = new Set<string>([
  "checkout.session.completed",
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "charge.refunded",
  "charge.dispute.created",
  "account.updated",
]);

async function resolveTenantByStripeAccount(stripeAccountId: string): Promise<string | null> {
  if (!stripeAccountId || !stripeAccountId.startsWith("acct_")) return null;
  const { data, error } = await serviceClient()
    .from("tenant_resources")
    .select("tenant_id")
    .eq("resource_kind", "stripe")
    .eq("external_ref->>stripe_account_id", stripeAccountId)
    .maybeSingle<{ tenant_id: string }>();
  if (error || !data) return null;
  return data.tenant_id ?? null;
}

type WebhookDeps = {
  webhookSecret?: () => string | null;
  constructEvent?: (payload: Buffer, signature: string, secret: string) => Stripe.Event;
  resolveTenantByStripeAccount?: (stripeAccountId: string) => Promise<string | null>;
  sendEvent?: (name: string, data: Record<string, unknown>) => Promise<void>;
  findHeldFundByChargeId?: (charge_id: string) => Promise<HeldFundRow | null>;
  markHeldFundRefunded?: (args: { id: string }) => Promise<boolean>;
};

let WEBHOOK_STRIPE: Stripe | null = null;
function webhookStripe(): Stripe {
  if (!WEBHOOK_STRIPE) {
    WEBHOOK_STRIPE = new Stripe("sk_placeholder_for_webhook_construct_only", {
      apiVersion: STRIPE_API_VERSION,
    });
  }
  return WEBHOOK_STRIPE;
}

export function makeStripeWebhook(deps: WebhookDeps = {}) {
  const getSecret = deps.webhookSecret ?? (() => process.env.STRIPE_WEBHOOK_SECRET ?? null);
  const construct =
    deps.constructEvent ??
    ((payload, signature, secret) =>
      webhookStripe().webhooks.constructEvent(payload, signature, secret));
  const resolveTenant = deps.resolveTenantByStripeAccount ?? resolveTenantByStripeAccount;
  const sendEvent =
    deps.sendEvent ??
    (async (name, data) => {
      await inngest.send({ name, data } as Parameters<typeof inngest.send>[0]);
    });
  const findHeldByCharge = deps.findHeldFundByChargeId ?? findHeldFundByChargeId;
  const markRefunded = deps.markHeldFundRefunded ?? markHeldFundRefunded;

  return async function stripeWebhook(req: Request, res: Response): Promise<void> {
    const secret = getSecret();
    if (!secret) {
      res
        .status(503)
        .json({ error: { code: "stripe_webhook_disabled", message: "STRIPE_WEBHOOK_SECRET unset" } });
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
      res
        .status(400)
        .json({ error: { code: "bad_signature", message: (e as Error).message } });
      return;
    }

    if (!HANDLED_EVENTS.has(event.type)) {
      res.status(200).json({ ok: true, ignored: event.type });
      return;
    }

    if (event.type === "account.updated") {
      const acct = event.data.object as { id?: string; payouts_enabled?: boolean };
      const acctId = String(acct.id ?? "");
      if (acct.payouts_enabled === true && acctId.startsWith("acct_")) {
        const tenantId = await resolveTenant(acctId);
        await logEvent({
          level: "info",
          source: "stripe-webhook",
          code: "stripe.account.updated.payouts_enabled",
          message: "Connected account payouts_enabled → autopilot remit sweep",
          tenant_id: tenantId ?? undefined,
          meta: { event_id: event.id, object_id: acctId },
        });
        if (tenantId) {
          await sendEvent("autopilot/connect.payouts_enabled", {
            stripe_account_id: acctId,
            tenant_id: tenantId,
          });
        }
        res.status(200).json({
          ok: true,
          type: event.type,
          event_id: event.id,
          swept: Boolean(tenantId),
        });
        return;
      }
      await logEvent({
        level: "info",
        source: "stripe-webhook",
        code: "stripe.account.updated",
        message: "Stripe webhook account.updated received (payouts not yet enabled)",
        meta: {
          event_id: event.id,
          object_id: acctId || null,
          payouts_enabled: acct.payouts_enabled === true,
        },
      });
      res.status(200).json({ ok: true, type: event.type, event_id: event.id, swept: false });
      return;
    }

    if (event.type === "charge.refunded") {
      const charge = event.data.object as {
        id?: string;
        payment_intent?: string | { id?: string } | null;
      };
      const piId =
        typeof charge.payment_intent === "string"
          ? charge.payment_intent
          : (charge.payment_intent?.id ?? null);
      if (piId) {
        try {
          const row = await findHeldByCharge(piId);
          if (row) {
            const flipped = await markRefunded({ id: row.id });
            await logEvent({
              level: flipped ? "info" : "warn",
              source: "stripe-webhook",
              code: flipped
                ? "autopilot.held_fund.refunded"
                : "autopilot.held_fund.refund_after_remit",
              message: flipped
                ? "Refunded held collection excluded from remit (held → refunded)"
                : "Refund on an already-remitting/remitted held fund — manual reconcile (cannot auto-unwind a transfer)",
              tenant_id: row.tenant_id,
              meta: {
                event_id: event.id,
                held_fund_id: row.id,
                charge_id: piId,
                prior_status: row.status,
              },
            });
          }
        } catch (e) {
          await logEvent({
            level: "warn",
            source: "stripe-webhook",
            code: "autopilot.held_fund.refund_handler_error",
            message: `charge.refunded held-fund flip failed: ${(e as Error).message}`,
            meta: { event_id: event.id, charge_id: piId },
          }).catch(() => {});
        }
      }
    }

    const obj = event.data.object as {
      id?: string;
      amount?: number;
      amount_total?: number;
      currency?: string;
      metadata?: Record<string, string> | null;
    };
    const tenantHint = obj.metadata?.praxis_tenant_id;

    await logEvent({
      level: event.type === "charge.dispute.created" ? "warn" : "info",
      source: "stripe-webhook",
      code: `stripe.${event.type}`,
      message: `Stripe webhook ${event.type} received`,
      tenant_id: tenantHint && /^[0-9a-f-]{36}$/i.test(tenantHint) ? tenantHint : undefined,
      meta: {
        event_id: event.id,
        object_id: obj.id ?? null,
        amount: obj.amount ?? obj.amount_total ?? null,
        currency: obj.currency ?? null,
        money_model: obj.metadata?.praxis_money_model ?? null,
      },
    });

    res.status(200).json({ ok: true, type: event.type, event_id: event.id });
  };
}

export const stripeWebhook = makeStripeWebhook();
