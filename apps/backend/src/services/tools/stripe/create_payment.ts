
import { z } from "zod";
import {
  platformStripeClient,
  resolveConnectedAccountId,
  resolveConnectedAccountPayoutsEnabled,
  wrapPlatformStripeError,
} from "./_platform-client";
import { resolveMoneyModel } from "./money-model";
import { assertWithinCaps, recordUsage } from "./payment-caps";
import { reserveHeldFund, markHeldFundCharged } from "./held-funds";
import { resolveReservePolicy, computeReserveWithhold } from "./reserves";
import { logEvent } from "@/services/logging/logEvent";
import { ExpectedToolError } from "@/services/tools/types";
import type { ToolSpec } from "@/services/tools/types";

export const MAX_PAYMENT_AMOUNT_MINOR = 500_000;

const inputSchema = z.object({
  amount: z
    .number()
    .int()
    .min(1)
    .max(MAX_PAYMENT_AMOUNT_MINOR)
    .describe("Amount to collect from the end customer, in the smallest currency unit (e.g. cents)."),
  currency: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z]{3}$/, "currency must be a 3-letter ISO code")
    .default("usd"),
  application_fee_amount: z
    .number()
    .int()
    .min(0)
    .describe("Praxis platform fee in the smallest currency unit. Must be < amount.")
    .default(0),
  client_reference: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe("Caller-stable id for this payment (order id / invoice id). Drives idempotency."),
  description: z.string().trim().max(500).optional(),
  receipt_email: z.string().email().optional(),
});

type CreatePaymentInput = z.infer<typeof inputSchema>;

export const createPaymentTool: ToolSpec = {
  name: "stripe_create_payment",
  effect: "money",
  description:
    "Create a PaymentIntent to collect a payment from an END CUSTOMER, routed to this workspace's connected Stripe account per its money model. Returns the PaymentIntent id + client_secret + status. Path A = direct charge with platform application_fee (owner is merchant of record); Path B = destination charge (Praxis is merchant of record, remits net to the owner) — or HOLD MODE collecting onto the platform balance when the owner's account is not yet payouts-enabled. Per-transaction + per-tenant daily caps bound exposure. Inert until the Praxis Stripe platform rail is enabled.",
  input_schema: inputSchema,
  async execute(ctx, rawInput: unknown) {
    const input: CreatePaymentInput = inputSchema.parse(rawInput);
    if (input.application_fee_amount >= input.amount) {
      throw new ExpectedToolError(
        "application_fee_too_high",
        `application_fee_amount (${input.application_fee_amount}) must be strictly less than amount (${input.amount}).`,
      );
    }

    const stripe = platformStripeClient();

    const model = await resolveMoneyModel(ctx.tenant_id);

    await assertWithinCaps({ tenant_id: ctx.tenant_id, amount_minor: input.amount });

    const common = {
      amount: input.amount,
      currency: input.currency,
      description: input.description,
      receipt_email: input.receipt_email,
      metadata: {
        praxis_tenant_id: ctx.tenant_id,
        praxis_money_model: model,
        client_reference: input.client_reference,
      },
    } as const;

    if (model === "path_a") {
      const acctId = await resolveConnectedAccountId(ctx.tenant_id);
      if (!acctId) {
        throw new ExpectedToolError(
          "no_connected_account",
          "This workspace has no connected Stripe account yet. Provision one (stripe.create_connected_account) before collecting payments.",
        );
      }

      const idempotencyKey = `pi-${ctx.tenant_id}-${model}-${input.client_reference}`;

      try {
        const pi = await stripe.paymentIntents.create(
          {
            ...common,
            ...(input.application_fee_amount > 0
              ? { application_fee_amount: input.application_fee_amount }
              : {}),
          },
          { idempotencyKey, stripeAccount: acctId },
        );
        await recordUsage(ctx.tenant_id, input.amount);
        return {
          path: "path_a" as const,
          mode: "direct" as const,
          connected_account: acctId,
          payment_intent_id: pi.id,
          client_secret: pi.client_secret,
          status: pi.status,
          amount: pi.amount,
          currency: pi.currency,
          application_fee_amount: input.application_fee_amount,
        };
      } catch (e) {
        throw wrapPlatformStripeError(e);
      }
    }

    const canPayout = await resolveConnectedAccountPayoutsEnabled(ctx.tenant_id);
    const idempotencyKey = `pi-${ctx.tenant_id}-${model}-${input.client_reference}`;

    if (canPayout) {
      const acctId = await resolveConnectedAccountId(ctx.tenant_id);
      if (!acctId) {
        throw new ExpectedToolError(
          "no_connected_account",
          "This workspace has no connected Stripe account yet. Provision one (stripe.create_connected_account) before collecting payments.",
        );
      }
      try {
        const pi = await stripe.paymentIntents.create(
          {
            ...common,
            transfer_data: { destination: acctId },
            ...(input.application_fee_amount > 0
              ? { application_fee_amount: input.application_fee_amount }
              : {}),
            on_behalf_of: acctId,
          },
          { idempotencyKey },
        );
        await recordUsage(ctx.tenant_id, input.amount);
        return {
          path: "path_b" as const,
          mode: "direct" as const,
          connected_account: acctId,
          payment_intent_id: pi.id,
          client_secret: pi.client_secret,
          status: pi.status,
          amount: pi.amount,
          currency: pi.currency,
          application_fee_amount: input.application_fee_amount,
        };
      } catch (e) {
        throw wrapPlatformStripeError(e);
      }
    }

    const policy = await resolveReservePolicy();
    const reserveHeld = computeReserveWithhold(input.amount, policy.bps);

    const reserved = await reserveHeldFund({
      tenant_id: ctx.tenant_id,
      amount_minor: input.amount,
      currency: input.currency,
      client_reference: input.client_reference,
      reserve_held_minor: reserveHeld,
      platform_fee_minor: input.application_fee_amount,
    });

    if (reserved.status !== "pending") {
      return {
        path: "path_b" as const,
        mode: "held" as const,
        connected_account: null,
        payment_intent_id: reserved.charge_id,
        client_secret: null,
        status: "already_collected",
        amount: reserved.amount_minor,
        currency: reserved.currency,
        application_fee_amount: reserved.platform_fee_minor,
        reserve_held_minor: reserved.reserve_held_minor,
      };
    }

    let pi: { id: string; client_secret: string | null; status: string; amount: number; currency: string };
    try {
      pi = (await stripe.paymentIntents.create(
        {
          ...common,
        },
        { idempotencyKey },
      )) as typeof pi;
    } catch (e) {
      throw wrapPlatformStripeError(e);
    }

    try {
      await markHeldFundCharged({ id: reserved.id, charge_id: pi.id });
    } catch (e1) {
      try {
        await markHeldFundCharged({ id: reserved.id, charge_id: pi.id });
      } catch (e2) {
        await logEvent({
          level: "warn",
          source: "stripe-collect",
          code: "autopilot.held_fund.mark_charged_failed",
          message: "Charge succeeded but held row stuck 'pending' (could re-charge on a >24h retry) — reconcile",
          tenant_id: ctx.tenant_id,
          meta: {
            held_fund_id: reserved.id,
            client_reference: input.client_reference,
            charge_id: pi.id,
            error: (e2 as Error).message ?? String(e2),
          },
        }).catch(() => {});
      }
    }

    await recordUsage(ctx.tenant_id, input.amount);

    return {
      path: "path_b" as const,
      mode: "held" as const,
      connected_account: null,
      payment_intent_id: pi.id,
      client_secret: pi.client_secret,
      status: pi.status,
      amount: pi.amount,
      currency: pi.currency,
      application_fee_amount: input.application_fee_amount,
      reserve_held_minor: reserveHeld,
    };
  },
};
