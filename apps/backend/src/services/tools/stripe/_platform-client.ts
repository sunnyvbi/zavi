
import Stripe from "stripe";
import { ExpectedToolError } from "@/services/tools/types";
import { resolveResourceCreds } from "@/services/provisioning/resolve-creds";

export const STRIPE_API_VERSION = "2025-02-24.acacia" as const;

type PlatformDeps = {
  platformKey?: () => string | null;
  enabled?: () => boolean;
  makeClient?: (key: string) => Stripe;
};

let CACHED: { client: Stripe; key: string } | null = null;

function defaultMakeClient(key: string): Stripe {
  return new Stripe(key, {
    apiVersion: STRIPE_API_VERSION,
    appInfo: { name: "Zavi Autopilot", url: "https://zaviagent.com" },
    maxNetworkRetries: 1,
    timeout: 20_000,
  });
}

export function platformStripeClient(deps: PlatformDeps = {}): Stripe {
  const getKey = deps.platformKey ?? (() => process.env.STRIPE_PLATFORM_SECRET_KEY ?? null);
  const isEnabled = deps.enabled ?? (() => process.env.STRIPE_PROVISIONING_ENABLED === "1");
  const make = deps.makeClient ?? defaultMakeClient;

  const key = getKey();
  if (!key) {
    throw new ExpectedToolError(
      "stripe_platform_not_configured",
      "The Praxis Stripe platform key is not set. The autopilot money rail is inert until STRIPE_PLATFORM_SECRET_KEY is configured.",
    );
  }
  if (!isEnabled()) {
    throw new ExpectedToolError(
      "stripe_provisioning_disabled",
      "The autopilot money rail is gated off (STRIPE_PROVISIONING_ENABLED != 1). No charges are created until it is explicitly enabled.",
    );
  }
  if (CACHED && CACHED.key === key) return CACHED.client;
  const client = make(key);
  CACHED = { client, key };
  return client;
}

export function _resetPlatformClient(): void {
  CACHED = null;
}

export async function resolveConnectedAccountId(
  tenant_id: string,
  resolve: typeof resolveResourceCreds = resolveResourceCreds,
): Promise<string | null> {
  const creds = await resolve(tenant_id, "stripe");
  if (!creds) return null;
  const id = creds.external_ref?.stripe_account_id;
  return typeof id === "string" && id.startsWith("acct_") ? id : null;
}

export async function resolveConnectedAccountPayoutsEnabled(
  tenant_id: string,
  deps: {
    resolveAcctId?: (t: string) => Promise<string | null>;
    retrieve?: (acctId: string) => Promise<{ payouts_enabled?: boolean }>;
  } = {},
): Promise<boolean> {
  const resolveAcctId = deps.resolveAcctId ?? resolveConnectedAccountId;
  const acctId = await resolveAcctId(tenant_id);
  if (!acctId) return false;

  const retrieve =
    deps.retrieve ?? ((id: string) => platformStripeClient().accounts.retrieve(id));
  try {
    const acct = await retrieve(acctId);
    return acct.payouts_enabled === true;
  } catch (e) {
    if (
      e instanceof ExpectedToolError &&
      (e.code === "stripe_platform_not_configured" ||
        e.code === "stripe_provisioning_disabled")
    ) {
      return false;
    }
    throw wrapPlatformStripeError(e);
  }
}

export function wrapPlatformStripeError(e: unknown): ExpectedToolError {
  if (e instanceof ExpectedToolError) return e;
  const err = e as { type?: string; code?: string; message?: string; statusCode?: number };
  if (err.type) {
    return new ExpectedToolError(`stripe_${err.type}`, err.message ?? "Stripe API error", {
      code: err.code,
      statusCode: err.statusCode,
    });
  }
  return new ExpectedToolError("stripe_unknown_error", (err as Error).message ?? String(e));
}

export function isAmbiguousTransferError(e: unknown): boolean {
  if (e instanceof ExpectedToolError) return e.code === "stripe_unknown_error";
  const t = (e as { type?: string })?.type;
  if (!t) return true;
  return t === "StripeConnectionError" || t === "StripeAPIError";
}
