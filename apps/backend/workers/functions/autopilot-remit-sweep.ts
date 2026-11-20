
import { inngest } from "../client";
import {
  platformStripeClient,
  resolveConnectedAccountId,
  resolveConnectedAccountPayoutsEnabled,
  wrapPlatformStripeError,
  isAmbiguousTransferError,
} from "@/services/tools/stripe/_platform-client";
import {
  listHeldFundsForTenant,
  claimHeldFundForRemit,
  markHeldFundRemitted,
  releaseHeldFundClaim,
  type HeldFundRow,
} from "@/services/tools/stripe/held-funds";
import { logEvent } from "@/services/logging/logEvent";
import { serviceClient } from "@/services/supabase";

export const AUTOPILOT_REMIT_SWEEP_C8reverified = true;

async function resolveTenantByAccount(stripeAccountId: string): Promise<string | null> {
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

export type RemitSweepDeps = {
  resolveTenantByAccount?: (stripeAccountId: string) => Promise<string | null>;
  resolveConnectedAccountPayoutsEnabled?: (tenant_id: string) => Promise<boolean>;
  resolveConnectedAccountId?: (tenant_id: string) => Promise<string | null>;
  listHeldFundsForTenant?: (tenant_id: string) => Promise<HeldFundRow[]>;
  claimHeldFundForRemit?: (args: { id: string }) => Promise<HeldFundRow | null>;
  markHeldFundRemitted?: (args: { id: string; transfer_id: string }) => Promise<boolean>;
  releaseHeldFundClaim?: (args: { id: string }) => Promise<boolean>;
  createTransfer?: (
    params: {
      amount: number;
      currency: string;
      destination: string;
      source_transaction?: string;
      metadata: Record<string, string>;
    },
    opts: { idempotencyKey: string },
  ) => Promise<{ id: string; amount: number }>;
};

type SweepRowOutcome =
  | { client_reference: string; outcome: "remitted"; transfer_id: string; amount: number }
  | { client_reference: string; outcome: "skipped_zero_net" }
  | { client_reference: string; outcome: "skipped_claim_lost" }
  | { client_reference: string; outcome: "error"; error: string }
  | { client_reference: string; outcome: "error_ambiguous"; error: string };

export async function runRemitSweep(
  stripeAccountId: string,
  deps: RemitSweepDeps = {},
): Promise<{
  outcome: "no_tenant" | "not_payouts_ready" | "no_connected_account" | "swept";
  tenant_id?: string;
  remitted?: number;
  rows?: SweepRowOutcome[];
}> {
  const resolveTenant = deps.resolveTenantByAccount ?? resolveTenantByAccount;
  const payoutsEnabled =
    deps.resolveConnectedAccountPayoutsEnabled ?? resolveConnectedAccountPayoutsEnabled;
  const resolveAcctId = deps.resolveConnectedAccountId ?? resolveConnectedAccountId;
  const listHeld = deps.listHeldFundsForTenant ?? listHeldFundsForTenant;
  const claimRow = deps.claimHeldFundForRemit ?? claimHeldFundForRemit;
  const markRemitted = deps.markHeldFundRemitted ?? markHeldFundRemitted;
  const releaseClaim = deps.releaseHeldFundClaim ?? releaseHeldFundClaim;
  const createTransfer =
    deps.createTransfer ??
    (async (params, opts) => {
      const stripe = platformStripeClient();
      try {
        const tr = await stripe.transfers.create(params, opts);
        return { id: tr.id, amount: tr.amount };
      } catch (e) {
        throw wrapPlatformStripeError(e);
      }
    });

  const tenant_id = await resolveTenant(stripeAccountId);
  if (!tenant_id) return { outcome: "no_tenant" };

  const ready = await payoutsEnabled(tenant_id);
  if (!ready) return { outcome: "not_payouts_ready", tenant_id };

  const acctId = await resolveAcctId(tenant_id);
  if (!acctId) return { outcome: "no_connected_account", tenant_id };

  const held = await listHeld(tenant_id);

  const rows: SweepRowOutcome[] = [];
  let remitted = 0;
  for (const row of held) {
    const reserveWithheld = row.reserve_held_minor;
    const platformFee = row.platform_fee_minor;
    const netAmount = row.amount_minor - reserveWithheld - platformFee;
    if (netAmount <= 0) {
      rows.push({ client_reference: row.client_reference, outcome: "skipped_zero_net" });
      continue;
    }

    const claimed = await claimRow({ id: row.id });
    if (!claimed) {
      rows.push({ client_reference: row.client_reference, outcome: "skipped_claim_lost" });
      continue;
    }

    const idempotencyKey = `tr-${tenant_id}-${row.client_reference}`;
    try {
      const transfer = await createTransfer(
        {
          amount: netAmount,
          currency: row.currency,
          destination: acctId,
          ...(row.charge_id && row.charge_id.startsWith("ch_")
            ? { source_transaction: row.charge_id }
            : {}),
          metadata: {
            praxis_tenant_id: tenant_id,
            praxis_money_model: "path_b",
            client_reference: row.client_reference,
            collected_minor: String(row.amount_minor),
            reserve_held_minor: String(reserveWithheld),
            platform_fee_minor: String(platformFee),
            held_fund_id: row.id,
          },
        },
        { idempotencyKey },
      );
      await markRemitted({ id: row.id, transfer_id: transfer.id });
      remitted += 1;
      rows.push({
        client_reference: row.client_reference,
        outcome: "remitted",
        transfer_id: transfer.id,
        amount: transfer.amount,
      });
    } catch (e) {
      if (isAmbiguousTransferError(e)) {
        await logEvent({
          level: "warn",
          source: "autopilot-remit-sweep",
          code: "autopilot.remit.transfer_ambiguous",
          message: "Sweep transfer failed ambiguously; held fund left 'remitting' for reconcile (NOT released)",
          tenant_id,
          meta: {
            held_fund_id: row.id,
            client_reference: row.client_reference,
            idempotency_key: idempotencyKey,
          },
        }).catch(() => {});
        rows.push({
          client_reference: row.client_reference,
          outcome: "error_ambiguous",
          error: (e as Error).message ?? String(e),
        });
        continue;
      }
      await releaseClaim({ id: row.id }).catch(() => {});
      rows.push({
        client_reference: row.client_reference,
        outcome: "error",
        error: (e as Error).message ?? String(e),
      });
    }
  }

  return { outcome: "swept", tenant_id, remitted, rows };
}

export const autopilotRemitSweepFn = inngest.createFunction(
  { id: "autopilot-remit-sweep", concurrency: 4, retries: 2 },
  { event: "autopilot/connect.payouts_enabled" },
  async ({ event, logger }) => {
    const stripeAccountId = String(event.data.stripe_account_id ?? "");
    if (!stripeAccountId.startsWith("acct_")) {
      logger.warn("autopilot-remit-sweep: missing/invalid stripe_account_id");
      return { outcome: "no_account" };
    }
    const result = await runRemitSweep(stripeAccountId);
    logger.info(
      `autopilot-remit-sweep: account=${stripeAccountId} outcome=${result.outcome} ` +
        `tenant=${result.tenant_id ?? "-"} remitted=${result.remitted ?? 0}`,
    );
    return result;
  },
);
