
import type { EnsureInput, Provisioner, ProvisionResult } from "./types";
import { CredentialNotConfigured } from "./github-repo";
import { isProdBackend } from "@/services/config/backend-env";

type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; json: () => Promise<unknown>; text: () => Promise<string> }>;

type StripeDeps = {
  token?: () => string | null;
  enabled?: () => boolean;
  returnBase?: () => string;
  isProd?: () => boolean;
  fetchFn?: FetchLike;
};

const STRIPE = "https://api.stripe.com";

function form(obj: Record<string, string>): string {
  return Object.entries(obj)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}
function headers(token: string, idempotencyKey?: string): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (idempotencyKey) h["Idempotency-Key"] = idempotencyKey;
  return h;
}

export function createStripeConnectProvisioner(deps: StripeDeps = {}): Provisioner {
  const getToken = deps.token ?? (() => process.env.STRIPE_PLATFORM_SECRET_KEY ?? null);
  const isEnabled = deps.enabled ?? (() => process.env.STRIPE_PROVISIONING_ENABLED === "1");
  const getReturnBase = deps.returnBase ?? (() => process.env.PRAXIS_PUBLIC_BASE ?? "https://www.zaviagent.com");
  const fetchFn = deps.fetchFn ?? ((globalThis as { fetch: FetchLike }).fetch);
  const isProd = deps.isProd ?? (() => isProdBackend());

  async function ensure(input: EnsureInput): Promise<ProvisionResult> {
    const token = getToken();
    if (!token) throw new CredentialNotConfigured("STRIPE_PLATFORM_SECRET_KEY");
    if (!isEnabled()) throw new CredentialNotConfigured("STRIPE_PROVISIONING_ENABLED");
    if (!isProd() && !token.trim().startsWith("sk_test_")) {
      throw new CredentialNotConfigured("STRIPE_PLATFORM_SECRET_KEY (a test-mode key, off the prod backend)");
    }

    const acctRes = await fetchFn(`${STRIPE}/v1/accounts`, {
      method: "POST",
      headers: headers(token, `stripe-acct-${input.tenant_id}`),
      body: form({ type: "standard" }),
    });
    if (acctRes.status !== 200) {
      throw new Error(`stripe account create failed (${acctRes.status}): ${await acctRes.text()}`);
    }
    const acct = (await acctRes.json()) as { id?: string };
    const acctId = acct.id ?? null;

    let onboardingUrl: string | null = null;
    if (acctId) {
      const base = getReturnBase();
      const linkRes = await fetchFn(`${STRIPE}/v1/account_links`, {
        method: "POST",
        headers: headers(token),
        body: form({
          account: acctId,
          type: "account_onboarding",
          refresh_url: `${base}/autopilot/stripe/refresh`,
          return_url: `${base}/autopilot/stripe/return`,
        }),
      });
      if (linkRes.status === 200) {
        onboardingUrl = ((await linkRes.json()) as { url?: string }).url ?? null;
      }
    }
    return { external_ref: { stripe_account_id: acctId, onboarding_url: onboardingUrl }, vault_keys: {} };
  }

  async function teardown(external_ref: Record<string, unknown>): Promise<void> {
    const token = getToken();
    if (!token) throw new CredentialNotConfigured("STRIPE_PLATFORM_SECRET_KEY");
    const id = String(external_ref.stripe_account_id ?? "");
    if (!id) return;
    const res = await fetchFn(`${STRIPE}/v1/accounts/${id}`, { method: "DELETE", headers: headers(token) });
    if (res.status !== 200 && res.status !== 404) {
      throw new Error(`stripe account teardown failed (${res.status}): ${await res.text()}`);
    }
  }

  return { kind: "stripe", provider: "stripe-connect", ensure, teardown };
}
