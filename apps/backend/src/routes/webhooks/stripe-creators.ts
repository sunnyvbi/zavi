
import type { Request, Response } from "express";
import Stripe from "stripe";
import { STRIPE_API_VERSION } from "@/services/tools/stripe/_platform-client";
import { logEvent } from "@/services/logging/logEvent";
import { creatorPaymentsEnabled, platformKeyLivemode } from "@/services/creators/client";
import {
  applyCreatorStripeEvent,
  isCreatorWebhookEvent,
} from "@/services/creators/webhook-events";

export type CreatorStripeWebhookDeps = {
  webhookSecrets?: () => string[];
  constructEvent?: (payload: Buffer, signature: string, secret: string) => Stripe.Event;
  railEnabled?: () => boolean;
  keyLivemode?: () => boolean;
  apply?: typeof applyCreatorStripeEvent;
  log?: typeof logEvent;
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

function envSecrets(): string[] {
  return [
    process.env.STRIPE_CREATOR_WEBHOOK_SECRET,
    process.env.STRIPE_CREATOR_CONNECT_WEBHOOK_SECRET,
  ].filter((s): s is string => typeof s === "string" && s.length > 0);
}

export function makeCreatorStripeWebhook(deps: CreatorStripeWebhookDeps = {}) {
  const getSecrets = deps.webhookSecrets ?? envSecrets;
  const construct =
    deps.constructEvent ??
    ((payload, signature, secret) =>
      webhookStripe().webhooks.constructEvent(payload, signature, secret));
  const railEnabled =
    deps.railEnabled ??
    (() => creatorPaymentsEnabled() && Boolean(process.env.STRIPE_PLATFORM_SECRET_KEY));
  const keyLivemode = deps.keyLivemode ?? (() => platformKeyLivemode());
  const apply = deps.apply ?? applyCreatorStripeEvent;
  const log = deps.log ?? logEvent;

  return async function creatorStripeWebhook(req: Request, res: Response): Promise<void> {
    const secrets = getSecrets();
    if (secrets.length === 0) {
      res.status(503).json({
        error: {
          code: "creator_webhook_disabled",
          message: "STRIPE_CREATOR_WEBHOOK_SECRET unset",
        },
      });
      return;
    }

    const signature = String(req.header("stripe-signature") ?? "");
    if (!signature) {
      res.status(400).json({ error: { code: "no_signature", message: "stripe-signature missing" } });
      return;
    }

    const rawBuf = (req.body as Buffer | undefined) ?? Buffer.alloc(0);

    let event: Stripe.Event | null = null;
    let lastError = "no signing secret matched";
    for (const secret of secrets) {
      try {
        event = construct(rawBuf, signature, secret);
        break;
      } catch (e) {
        lastError = (e as Error).message;
      }
    }
    if (!event) {
      res.status(400).json({ error: { code: "bad_signature", message: lastError } });
      return;
    }

    if (!railEnabled()) {
      res.status(503).json({
        error: {
          code: "creator_payments_disabled",
          message: "The creator payments rail is off in this process",
        },
      });
      return;
    }

    let keyLive: boolean;
    try {
      keyLive = keyLivemode();
    } catch {
      res.status(503).json({
        error: {
          code: "stripe_platform_not_configured",
          message: "No usable Stripe platform key in this process",
        },
      });
      return;
    }
    if (event.livemode !== keyLive) {
      await log({
        level: "warn",
        source: "creator-webhook",
        code: "creator.webhook.ignored",
        message:
          "Creator Stripe event ignored: its mode does not match the Stripe key in this process",
        meta: { event_id: event.id, reject_reason: "livemode_mismatch" },
      }).catch(() => {});
      res
        .status(200)
        .json({ ok: true, event_id: event.id, outcome: "ignored_livemode_mismatch" });
      return;
    }

    if (!isCreatorWebhookEvent(event.type)) {
      res.status(200).json({ ok: true, event_id: event.id, outcome: "ignored_unhandled_type" });
      return;
    }

    try {
      const result = await apply(event);
      res.status(200).json({ ok: true, event_id: event.id, type: event.type, ...result });
    } catch (e) {
      await log({
        level: "error",
        source: "creator-webhook",
        code: "creator.webhook.handler_error",
        error: e,
        message: `Creator Stripe webhook handler failed for ${event.type}`,
        meta: { event_id: event.id },
      }).catch(() => {});
      res.status(500).json({
        error: { code: "creator_webhook_handler_failed", message: "Event not processed; retry." },
      });
    }
  };
}

export const creatorStripeWebhook = makeCreatorStripeWebhook();
