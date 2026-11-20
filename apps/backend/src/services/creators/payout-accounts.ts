
import type Stripe from "stripe";
import { ExpectedToolError } from "@/services/tools/types";
import { wrapPlatformStripeError } from "@/services/tools/stripe/_platform-client";
import { assertCreatorPayoutCountry } from "./payout-countries";
import { creatorStripeClient, platformKeyLivemode } from "./client";
import {
  insertCreatorPayoutAccount,
  loadCreatorPayoutAccount,
  updateCreatorPayoutAccountFlags,
  type CreatorPayoutAccountRow,
} from "./db";

export type CreatorPayoutAccountDeps = {
  stripe: () => Stripe;
  livemode: () => boolean;
  loadAccount: typeof loadCreatorPayoutAccount;
  insertAccount: typeof insertCreatorPayoutAccount;
  updateFlags: typeof updateCreatorPayoutAccountFlags;
  publicBase: () => string;
};

export const realCreatorPayoutAccountDeps: CreatorPayoutAccountDeps = {
  stripe: creatorStripeClient,
  livemode: () => platformKeyLivemode(),
  loadAccount: loadCreatorPayoutAccount,
  insertAccount: insertCreatorPayoutAccount,
  updateFlags: updateCreatorPayoutAccountFlags,
  publicBase: () => process.env.PRAXIS_PUBLIC_BASE ?? "https://www.zaviagent.com",
};

export const CREATOR_PAYOUT_DISCONNECTED = "deauthorized";

export function creatorTransfersActive(account: {
  capabilities?: { transfers?: string | null } | null;
}): boolean {
  return account.capabilities?.transfers === "active";
}

export async function ensureCreatorPayoutAccount(
  args: { human_member_id: string; country: string; email?: string | null },
  deps: CreatorPayoutAccountDeps = realCreatorPayoutAccountDeps,
): Promise<CreatorPayoutAccountRow> {
  assertCreatorPayoutCountry(args.country);
  const livemode = deps.livemode();
  const country = args.country.trim().toUpperCase();

  const existing = await deps.loadAccount(args.human_member_id, livemode);
  if (existing) return existing;

  const stripe = deps.stripe();
  let account: Stripe.Account;
  try {
    account = await stripe.accounts.create(
      {
        country,
        ...(args.email ? { email: args.email } : {}),
        controller: {
          stripe_dashboard: { type: "express" },
          fees: { payer: "application" },
          losses: { payments: "application" },
        },
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        metadata: { zavi_human_member_id: args.human_member_id, zavi_purpose: "creator_payout" },
      },
      { idempotencyKey: `cr-acct-${args.human_member_id}-${livemode ? "live" : "test"}` },
    );
  } catch (e) {
    throw wrapPlatformStripeError(e);
  }

  const written = await deps.insertAccount({
    human_member_id: args.human_member_id,
    stripe_account_id: account.id,
    livemode,
    country,
    details_submitted: account.details_submitted === true,
    payouts_enabled: account.payouts_enabled === true,
  });
  if (written === "duplicate") {
    const winner = await deps.loadAccount(args.human_member_id, livemode);
    if (winner) return winner;
    throw new ExpectedToolError(
      "creator_payout_account_write_lost",
      "The creator payout account row could not be read back after a write conflict.",
    );
  }

  return {
    id: "",
    human_member_id: args.human_member_id,
    stripe_account_id: account.id,
    livemode,
    country,
    details_submitted: account.details_submitted === true,
    payouts_enabled: account.payouts_enabled === true,
    disabled_reason: null,
  };
}

export async function createCreatorOnboardingLink(
  stripe_account_id: string,
  deps: CreatorPayoutAccountDeps = realCreatorPayoutAccountDeps,
): Promise<string> {
  const base = deps.publicBase();
  try {
    const link = await deps.stripe().accountLinks.create({
      account: stripe_account_id,
      type: "account_onboarding",
      refresh_url: `${base}/creator/earnings/stripe/refresh`,
      return_url: `${base}/creator/earnings/stripe/return`,
    });
    return link.url;
  } catch (e) {
    throw wrapPlatformStripeError(e);
  }
}

export async function createCreatorExpressLoginLink(
  stripe_account_id: string,
  deps: CreatorPayoutAccountDeps = realCreatorPayoutAccountDeps,
): Promise<string> {
  try {
    const link = await deps.stripe().accounts.createLoginLink(stripe_account_id);
    return link.url;
  } catch (e) {
    throw wrapPlatformStripeError(e);
  }
}

export type CreatorPayoutAccountStatus = {
  stripe_account_id: string;
  details_submitted: boolean;
  payouts_enabled: boolean;
  transfers_active: boolean;
  disabled_reason: string | null;
  action_required?: boolean;
};

export async function refreshCreatorPayoutAccount(
  stripe_account_id: string,
  deps: CreatorPayoutAccountDeps = realCreatorPayoutAccountDeps,
): Promise<CreatorPayoutAccountStatus> {
  let account: Stripe.Account;
  try {
    account = await deps.stripe().accounts.retrieve(stripe_account_id);
  } catch (e) {
    throw wrapPlatformStripeError(e);
  }
  const status: CreatorPayoutAccountStatus = {
    stripe_account_id,
    details_submitted: account.details_submitted === true,
    payouts_enabled: account.payouts_enabled === true,
    transfers_active: creatorTransfersActive(account),
    disabled_reason: account.requirements?.disabled_reason ?? null,
    action_required:
      account.details_submitted !== true ||
      (account.requirements?.currently_due?.length ?? 0) > 0 ||
      (account.requirements?.past_due?.length ?? 0) > 0,
  };
  await deps.updateFlags({
    stripe_account_id,
    details_submitted: status.details_submitted,
    payouts_enabled: status.payouts_enabled,
    disabled_reason: status.disabled_reason,
    keepDisconnected: true,
  });
  return status;
}
