
import { z } from "zod";
import {
  platformStripeClient,
  resolveConnectedAccountId,
  resolveConnectedAccountPayoutsEnabled,
  wrapPlatformStripeError,
  isAmbiguousTransferError,
} from "./_platform-client";
import { resolveMoneyModel } from "./money-model";
import {
  findHeldFundByRef,
  claimHeldFundForRemit,
  markHeldFundRemitted,
  releaseHeldFundClaim,
} from "./held-funds";
import { logEvent } from "@/services/logging/logEvent";
import { ExpectedToolError } from "@/services/tools/types";
import type { ToolSpec } from "@/services/tools/types";

const inputSchema = z.object({
  client_reference: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe(
      "Caller-stable id of the held collection to remit (the same client_reference used at collect). Resolves the matching 'held' autopilot_held_funds row; the gross amount, reserve, fee, and source charge all come FROM that row. Drives idempotency.",
    ),
  description: z.string().trim().max(500).optional(),
});

type RemitInput = z.infer<typeof inputSchema>;

export const remitToTenantTool: ToolSpec = {
  name: "stripe_remit_to_tenant",
  effect: "money",
  description:
    "Path B only: explicitly remit NET proceeds (the held collection's gross minus its withheld reserve and platform fee) from the Praxis platform balance to this workspace's connected Stripe account via a Transfer (separate charges + transfers shape). Requires a previously collected, still-'held' fund identified by client_reference — refuses ad-hoc remits with no held row. Refuses under Path A (which never holds funds on the platform) and refuses if the connected account is not yet payouts-enabled. Returns the transfer id + net amount + reserve + fee withheld. Inert until the Praxis Stripe platform rail is enabled.",
  input_schema: inputSchema,
  async execute(ctx, rawInput: unknown) {
    const input: RemitInput = inputSchema.parse(rawInput);

    const stripe = platformStripeClient();

    const model = await resolveMoneyModel(ctx.tenant_id);
    if (model !== "path_b") {
      throw new ExpectedToolError(
        "remit_not_allowed_for_path_a",
        "Remittance via transfer is a Path B (Praxis collect+remit) action. This workspace is on Path A (direct charge), where funds settle straight to the connected account — there is nothing to remit.",
      );
    }

    const acctId = await resolveConnectedAccountId(ctx.tenant_id);
    if (!acctId) {
      throw new ExpectedToolError(
        "no_connected_account",
        "This workspace has no connected Stripe account yet.",
      );
    }

    const payoutsEnabled = await resolveConnectedAccountPayoutsEnabled(ctx.tenant_id);
    if (!payoutsEnabled) {
      throw new ExpectedToolError(
        "account_not_payouts_ready",
        "The connected Stripe account is not yet payouts-enabled (onboarding/KYC incomplete, or the rail is gated off). Funds remain held on the platform until the account can receive payouts.",
      );
    }

    const row = await findHeldFundByRef(ctx.tenant_id, input.client_reference);
    if (!row) {
      throw new ExpectedToolError(
        "held_fund_not_found",
        `No held collection found for client_reference '${input.client_reference}'. Remit only transfers a previously collected, held fund — there is nothing to remit.`,
      );
    }
    if (row.status === "remitted") {
      throw new ExpectedToolError(
        "held_fund_already_remitted",
        `The held collection for '${input.client_reference}' was already remitted (transfer ${row.remitted_transfer_id ?? "?"}).`,
      );
    }
    if (row.status !== "held") {
      throw new ExpectedToolError(
        "held_fund_not_remittable",
        `The held collection for '${input.client_reference}' is '${row.status}', not 'held'. It cannot be remitted right now.`,
      );
    }

    const reserveWithheld = row.reserve_held_minor;
    const platformFee = row.platform_fee_minor;

    if (reserveWithheld < 0 || platformFee < 0) {
      throw new ExpectedToolError(
        "held_fund_row_corrupt",
        `Held row for '${input.client_reference}' has a negative reserve (${reserveWithheld}) or platform fee (${platformFee}). Refusing to transfer.`,
      );
    }

    const netAmount = row.amount_minor - reserveWithheld - platformFee;

    if (netAmount <= 0) {
      throw new ExpectedToolError(
        "remit_amount_zero",
        `After withholding the reserve (${reserveWithheld}) and platform fee (${platformFee}), the net remittable amount is ${netAmount}. Nothing to transfer.`,
      );
    }

    const transferAmount = Math.min(netAmount, row.amount_minor);

    const claimed = await claimHeldFundForRemit({ id: row.id });
    if (!claimed) {
      throw new ExpectedToolError(
        "held_fund_claim_lost",
        `The held collection for '${input.client_reference}' is already being remitted or was just remitted. No transfer was made.`,
      );
    }

    const idempotencyKey = `tr-${ctx.tenant_id}-${input.client_reference}`;

    let transfer: { id: string; amount: number; currency: string; destination: string | unknown };
    try {
      transfer = await stripe.transfers.create(
        {
          amount: transferAmount,
          currency: row.currency,
          destination: acctId,
          description: input.description,
          ...(row.charge_id && row.charge_id.startsWith("ch_")
            ? { source_transaction: row.charge_id }
            : {}),
          metadata: {
            praxis_tenant_id: ctx.tenant_id,
            praxis_money_model: model,
            client_reference: input.client_reference,
            collected_minor: String(row.amount_minor),
            reserve_held_minor: String(reserveWithheld),
            platform_fee_minor: String(platformFee),
            held_fund_id: row.id,
          },
        },
        { idempotencyKey },
      );
    } catch (e) {
      if (isAmbiguousTransferError(e)) {
        await logEvent({
          level: "warn",
          source: "stripe-remit",
          code: "autopilot.remit.transfer_ambiguous",
          message: "Transfer failed ambiguously; held fund left 'remitting' for reconcile (NOT released)",
          tenant_id: ctx.tenant_id,
          meta: {
            held_fund_id: row.id,
            client_reference: input.client_reference,
            idempotency_key: idempotencyKey,
          },
        }).catch(() => {});
        throw wrapPlatformStripeError(e);
      }
      await releaseHeldFundClaim({ id: row.id }).catch(() => {});
      throw wrapPlatformStripeError(e);
    }

    await markHeldFundRemitted({ id: row.id, transfer_id: transfer.id });

    return {
      path: "path_b" as const,
      connected_account: acctId,
      transfer_id: transfer.id,
      amount: transfer.amount,
      currency: transfer.currency,
      collected_minor: row.amount_minor,
      reserve_held_minor: reserveWithheld,
      platform_fee_minor: platformFee,
      destination: typeof transfer.destination === "string" ? transfer.destination : acctId,
    };
  },
};
