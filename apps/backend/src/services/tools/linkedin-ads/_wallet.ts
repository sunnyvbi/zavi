import type { AdAccount } from "@/services/connectors/core/ads-shapes";
import type { AccountBinding } from "@/services/ads-wallet/bindings";
import { linkedinAccountInUse } from "@/services/connectors/linkedin-ads/own-accounts";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { ExpectedToolError } from "@/services/tools/types";

export const LINKEDIN_WALLET_ACCOUNT_NAME = "Zavi ads wallet";

const WALLET_READ_FAILED = () => new ExpectedToolError("linkedin_ads_read_failed", "Zavi-managed LinkedIn campaigns could not be read.");

export const LINKEDIN_ACCOUNT_NOT_IN_USE = () =>
  new ExpectedToolError(
    "linkedin_ads_account_not_in_use",
    "This ad account is not one this workspace uses. Call linkedin_ads_list_accounts and use an account id from there.",
  );

export type LinkedinWalletGroup = { binding: AccountBinding; campaignBindingIds: string[]; campaignIds: string[] };

export async function linkedinWalletGroups(tenantId: string): Promise<LinkedinWalletGroup[]> {
  const { data, error } = await tenantClient(asTenantId(tenantId))
    .from("ads_campaign_binding_details")
    .select("id, tenant_id, account_binding_id, provider_campaign_id")
    .eq("platform", "linkedin")
    .eq("funding_source", "wallet")
    .order("id")
    .range(0, 999);
  if (error || !Array.isArray(data) || data.length === 1000) throw WALLET_READ_FAILED();
  const mine = (data as Array<{ id: string; tenant_id: string; account_binding_id: string; provider_campaign_id: string | null }>).filter(
    (b) => b.tenant_id === tenantId && typeof b.provider_campaign_id === "string" && /^\d{1,20}$/.test(b.provider_campaign_id),
  );
  if (!mine.length) return [];
  const { getAccountBinding } = await import("@/services/ads-wallet/bindings");
  const groups = new Map<string, LinkedinWalletGroup>();
  for (const b of mine) {
    let group = groups.get(b.account_binding_id);
    if (!group) {
      const binding = await getAccountBinding(tenantId, b.account_binding_id);
      if (binding.funding_source !== "wallet" || binding.platform !== "linkedin" || !binding.provider_account_id) continue;
      group = { binding, campaignBindingIds: [], campaignIds: [] };
      groups.set(b.account_binding_id, group);
    }
    group.campaignBindingIds.push(b.id);
    group.campaignIds.push(b.provider_campaign_id as string);
  }
  return [...groups.values()];
}

export function walletAdAccount(group: LinkedinWalletGroup): AdAccount {
  return { id: group.binding.provider_account_id as string, name: LINKEDIN_WALLET_ACCOUNT_NAME, currency: group.binding.currency, status: null };
}

export type LinkedinAccountAccess =
  | { kind: "own" }
  | { kind: "wallet"; group: LinkedinWalletGroup; token: string; currency: string; campaignUrns: string[] };

export async function linkedinAccountAccess(tenantId: string, accountId: string): Promise<LinkedinAccountAccess> {
  const group = (await linkedinWalletGroups(tenantId)).find((g) => g.binding.provider_account_id === accountId);
  if (group) {
    const { resolveLinkedinAccount } = await import("@/services/ads-wallet/adapters/linkedin-account");
    const { token, account } = await resolveLinkedinAccount(tenantId, group.binding);
    return { kind: "wallet", group, token, currency: account.currency, campaignUrns: group.campaignIds.map((id) => `urn:li:sponsoredCampaign:${id}`) };
  }
  if (await linkedinAccountInUse(tenantId, accountId)) return { kind: "own" };
  throw LINKEDIN_ACCOUNT_NOT_IN_USE();
}
