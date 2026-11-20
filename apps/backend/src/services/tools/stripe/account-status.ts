
import { platformStripeClient } from "./_platform-client";
import { ExpectedToolError } from "@/services/tools/types";

export type AccountStatus = {
  charges_enabled: boolean;
  payouts_enabled: boolean;
  details_submitted: boolean;
};

export type RetrieveAccountStatusDeps = {
  retrieve: (acctId: string) => Promise<{
    charges_enabled?: boolean;
    payouts_enabled?: boolean;
    details_submitted?: boolean;
  }>;
  now: () => number;
};

const CACHE_TTL_MS = 60_000;

const CACHE = new Map<string, { value: AccountStatus; expiresAt: number }>();

const realDeps: RetrieveAccountStatusDeps = {
  retrieve: (acctId) => platformStripeClient().accounts.retrieve(acctId),
  now: () => Date.now(),
};

export async function retrieveAccountStatus(
  acctId: string,
  deps: RetrieveAccountStatusDeps = realDeps,
): Promise<AccountStatus | null> {
  const cached = CACHE.get(acctId);
  if (cached && cached.expiresAt > deps.now()) return cached.value;

  let acct: Awaited<ReturnType<RetrieveAccountStatusDeps["retrieve"]>>;
  try {
    acct = await deps.retrieve(acctId);
  } catch (e) {
    if (
      e instanceof ExpectedToolError &&
      (e.code === "stripe_platform_not_configured" ||
        e.code === "stripe_provisioning_disabled")
    ) {
      return null;
    }
    throw e;
  }

  const value: AccountStatus = {
    charges_enabled: acct.charges_enabled === true,
    payouts_enabled: acct.payouts_enabled === true,
    details_submitted: acct.details_submitted === true,
  };
  CACHE.set(acctId, { value, expiresAt: deps.now() + CACHE_TTL_MS });
  return value;
}

export function _resetAccountStatusCache(): void {
  CACHE.clear();
}
