import { z } from "zod";
import { asTenantId, platformSecretRpc, tenantClient, tenantRpc } from "@/services/tenant-client";
import { withLinkedInAdsToken } from "@/services/connectors/linkedin-ads/client";
import { LINKEDIN_ADS_BILLING_HOLD, linkedinAdsGet, linkedinCachedRead, linkedinOnBillingHold } from "@/services/connectors/linkedin-ads/http";
import { ExpectedToolError } from "@/services/tools/types";
import { logEvent } from "@/services/logging/logEvent";
import { verifyAccountBinding, type AccountBinding } from "../bindings";

export const linkedinAccountSchema = z.object({
  id: z
    .union([z.number().int().safe().positive(), z.string().regex(/^\d{1,20}$/)])
    .transform(String),
  name: z.string().optional(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  status: z.string(),
  servingStatuses: z.array(z.string()).optional(),
  reference: z.string().optional(),
  test: z.boolean().optional(),
});
export async function readLinkedinAccount(token: string, accountId: string, fresh = false, pauseCritical = false) {
  z.string()
    .regex(/^\d{1,20}$/)
    .parse(accountId);
  const account = linkedinAccountSchema.parse(
    await linkedinAdsGet(token, `adAccounts/${accountId}`, {}, {}, { fresh, pauseCritical }),
  );
  if (account.id !== accountId)
    throw new ExpectedToolError(
      "ads_account_mismatch",
      "LinkedIn returned a different advertiser account.",
    );
  return account;
}
export const managedLinkedinNotServingWords = (reason: string) =>
  `Zavi's managed LinkedIn ad account cannot run ads right now: ${reason}. Zavi is sorting out its account, and there is nothing you need to fix. Nothing was sent to LinkedIn. Try again later.`;
export const MANAGED_ACCOUNT_BILLING_HOLD = managedLinkedinNotServingWords("LinkedIn has paused it for billing");
export const MANAGED_ACCOUNT_NEEDS_ZAVI = "Zavi's own LinkedIn ad account needs attention from Zavi, so it cannot be used for new campaigns right now. Nothing was created. Zavi has been told; try again later, or use your own LinkedIn ad account.";
const CAMPAIGN_ROLES = ["ACCOUNT_BILLING_ADMIN", "ACCOUNT_MANAGER", "CAMPAIGN_MANAGER"];
const readOnly = () =>
  new ExpectedToolError(
    "ads_account_read_only",
    "Your LinkedIn user can only view this ad account. Ask an account admin in LinkedIn Campaign Manager to give you an Account Manager or Campaign Manager role, then try again.",
  );
async function linkedinCampaignRole(token: string, accountId: string, fresh: boolean, pauseCritical = false) {
  const roles = await linkedinAdsGet<{
    elements?: Array<{ account: string; role: string }>;
    paging?: { total?: number };
  }>(token, "adAccountUsers", { q: "authenticatedUser", count: 1000 }, {}, { fresh, pauseCritical });
  const elements = roles.elements ?? [];
  const role = elements.find((r) => r.account === `urn:li:sponsoredAccount:${accountId}`)?.role;
  return { manages: !!role && CAMPAIGN_ROLES.includes(role) };
}
type LinkedinRoles = { elements?: Array<{ account: string; role: string }>; paging?: { total?: number } };
export async function linkedinManagedAccountIds(token: string, fresh: boolean): Promise<Set<string> | null> {
  return managedAccountIds(await linkedinAdsGet<LinkedinRoles>(token, "adAccountUsers", { q: "authenticatedUser", count: 1000 }, {}, { fresh }));
}
export async function linkedinCachedManagedAccountIds(token: string): Promise<Set<string> | null> {
  const cached = linkedinCachedRead<LinkedinRoles>(token, "adAccountUsers", { q: "authenticatedUser", count: 1000 });
  return cached ? managedAccountIds(await cached) : null;
}
function managedAccountIds(roles: LinkedinRoles): Set<string> | null {
  const elements = roles.elements ?? [];
  if (roles.paging?.total !== elements.length) return null;
  return new Set(elements.filter((r) => CAMPAIGN_ROLES.includes(r.role)).map((r) => r.account.replace("urn:li:sponsoredAccount:", "")));
}
export async function assertLinkedinCampaignRole(token: string, accountId: string) {
  if (!(await linkedinCampaignRole(token, accountId, true)).manages) throw readOnly();
}
export async function releaseLinkedinAccountClaims(tenantId: string, accountId?: string) {
  const { error } = await tenantRpc(asTenantId(tenantId), "ads_release_customer_account_claim", {
    p_platform: "linkedin",
    p_provider_account_id: accountId ?? null,
  });
  if (error) throw new Error(`linkedin_claim_release_failed: ${error.message}`);
}
export async function reclaimLinkedinAccountClaims(tenantId: string) {
  const { data, error } = await tenantClient(asTenantId(tenantId))
    .from("ads_account_binding_details")
    .select("provider_account_id,currency")
    .eq("platform", "linkedin")
    .eq("credential_source", "tenant_connector")
    .eq("credential_tenant_id", tenantId)
    .eq("funding_source", "provider");
  if (error) throw new Error(`linkedin_claim_reclaim_failed: ${error.message}`);
  for (const a of (data ?? []) as Array<{ provider_account_id: string | null; currency: string | null }>) {
    if (!a.provider_account_id || !a.currency) continue;
    const res = await tenantRpc(asTenantId(tenantId), "ads_register_customer_account", {
      p_platform: "linkedin",
      p_provider_account_id: a.provider_account_id,
      p_currency: a.currency,
      p_credential_ref: "linkedin_ads.access_token",
    });
    if (res.error) console.warn("linkedin_claim_reclaim_failed", { tenant_id: tenantId, detail: res.error.message });
  }
}
function linkedinCredentialKind(tenantId: string, binding: AccountBinding): "connector" | "managed" {
  if (
    binding.tenant_id !== tenantId ||
    binding.platform !== "linkedin" ||
    !binding.provider_account_id
  )
    throw new ExpectedToolError(
      "ads_account_mismatch",
      "The LinkedIn account binding could not be verified.",
    );
  if (
    binding.credential_source === "tenant_connector" &&
    binding.credential_tenant_id === tenantId &&
    binding.credential_ref === "linkedin_ads.access_token" &&
    binding.funding_source === "provider"
  )
    return "connector";
  if (
    binding.credential_source === "platform" &&
    binding.credential_tenant_id === null &&
    binding.funding_source === "wallet" &&
    /^linkedin_ads_managed_[a-zA-Z0-9_-]+$/.test(binding.credential_ref)
  )
    return "managed";
  throw new ExpectedToolError(
    "ads_account_unsupported",
    "This LinkedIn credential does not match the account's funding source.",
  );
}
async function managedLinkedinToken(binding: AccountBinding): Promise<string> {
  const { data, error } = await platformSecretRpc("get_platform_secret", {
    p_key: binding.credential_ref,
  });
  if (error || typeof data !== "string" || !data.trim())
    throw new ExpectedToolError(
      "ads_credentials_unavailable",
      "The managed LinkedIn connection needs attention from Zavi.",
    );
  return data.trim();
}
export async function linkedinBindingToken(tenantId: string, binding: AccountBinding): Promise<string> {
  return linkedinCredentialKind(tenantId, binding) === "connector"
    ? withLinkedInAdsToken(tenantId, async (t) => t)
    : managedLinkedinToken(binding);
}
export async function resolveLinkedinAccount(
  tenantId: string,
  binding: AccountBinding,
  write = false,
  refuseBillingHold = write,
  pauseCritical = false,
  fresh = write,
) {
  let token: string;
  let account: Awaited<ReturnType<typeof readLinkedinAccount>> | null = null;
  if (linkedinCredentialKind(tenantId, binding) === "connector") {
    const accountId = binding.provider_account_id!;
    ({ token, account } = await withLinkedInAdsToken(tenantId, async (t) => ({ token: t, account: await readLinkedinAccount(t, accountId, fresh, pauseCritical) })));
  } else token = await managedLinkedinToken(binding);
  account ??= await readLinkedinAccount(token, binding.provider_account_id!, fresh, pauseCritical);
  await verifyAccountBinding(tenantId, binding, account.id, account.currency);
  if (refuseBillingHold && linkedinOnBillingHold(account.servingStatuses)) {
    if (binding.credential_source === "platform")
      void logEvent({
        level: "error",
        source: "ads-wallet",
        code: "ads_wallet.managed_linkedin_billing_hold",
        tenant_id: tenantId,
        message: "Zavi's managed LinkedIn ad account is on a LinkedIn billing hold, so wallet campaigns on it cannot launch.",
      }).catch(() => undefined);
    throw new ExpectedToolError(
      "linkedin_ads_write_refused",
      binding.credential_source === "platform" ? MANAGED_ACCOUNT_BILLING_HOLD : LINKEDIN_ADS_BILLING_HOLD,
      { billing_hold: true },
    );
  }
  if (write) {
    const role = await linkedinCampaignRole(token, account.id, fresh, pauseCritical);
    if (!role.manages) {
      if (binding.credential_source === "platform") {
        void logEvent({
          level: "error",
          source: "ads-wallet",
          code: "ads_wallet.managed_linkedin_role_missing",
          tenant_id: tenantId,
          message: "Zavi's managed LinkedIn login has no campaign role on its managed ad account.",
        });
        throw new ExpectedToolError("ads_credentials_unavailable", MANAGED_ACCOUNT_NEEDS_ZAVI);
      }
      throw readOnly();
    }
  }
  return { token, account };
}
