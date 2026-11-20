import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { ExpectedToolError } from "@/services/tools/types";

export type AccountBinding = {
  id: string; tenant_id: string; account_id: string; platform: string;
  provider_account_id: string | null; currency: string | null; verified_at: string | null;
  credential_source: "platform" | "tenant_connector"; credential_ref: string;
  credential_tenant_id: string | null; funding_source: "wallet" | "provider";
  legacy_key: "chatgpt_platform" | null;
};
export type CampaignBinding = {
  id: string; tenant_id: string; account_binding_id: string; account_id: string;
  platform: string; provider_campaign_id: string; funding_source: "wallet" | "provider";
};
export const ACCOUNT_OWNED_ELSEWHERE = "This ad account is now connected to another Zavi workspace, so this workspace cannot use it any more. Pick another account in Ad account and shared wallet.";
function unavailable(): never {
  throw new ExpectedToolError("ads_binding_unavailable", "The campaign account could not be verified. Refresh before trying again.");
}
async function rpcId(tenantId: string, name: string, args: Record<string, unknown>): Promise<string> {
  const { data, error } = await tenantRpc(asTenantId(tenantId), name, args);
  if (error || typeof data !== "string" || !data) return unavailable();
  return data;
}
export async function getAccountBinding(tenantId: string, bindingId: string): Promise<AccountBinding> {
  const { data, error } = await tenantClient(asTenantId(tenantId)).from("ads_account_binding_details")
    .select("*").eq("id", bindingId).maybeSingle();
  const binding = data as AccountBinding | null;
  if (error || !binding || binding.tenant_id !== tenantId) return unavailable();
  if (binding.credential_tenant_id && binding.credential_tenant_id !== tenantId) throw new ExpectedToolError("ads_account_owned_elsewhere", ACCOUNT_OWNED_ELSEWHERE);
  return binding;
}
export async function legacyChatgptAccount(tenantId: string): Promise<AccountBinding> {
  return getAccountBinding(tenantId, await rpcId(tenantId, "ads_legacy_account_binding", {}));
}
export async function claimCampaignAccount(tenantId: string, platform: string, requestId: string): Promise<AccountBinding> {
  return getAccountBinding(tenantId, await rpcId(tenantId, "ads_claim_campaign_account", { p_platform: platform, p_request_id: requestId }));
}
export async function verifyAccountBinding(tenantId: string, binding: AccountBinding, providerAccountId: string, currency: string): Promise<void> {
  if (binding.tenant_id !== tenantId || !providerAccountId || !/^[A-Z]{3}$/.test(currency)) return unavailable();
  if (binding.provider_account_id !== null && (binding.provider_account_id !== providerAccountId || binding.currency !== currency)) return unavailable();
  const { error } = await tenantRpc(asTenantId(tenantId), "ads_verify_account_binding", {
    p_binding_id: binding.id, p_provider_account_id: providerAccountId, p_currency: currency,
  });
  if (error) return unavailable();
}
export async function selectAccountBinding(tenantId: string, bindingId: string): Promise<void> {
  const { error } = await tenantRpc(asTenantId(tenantId), "ads_select_account_binding", { p_binding_id: bindingId });
  if (error) return unavailable();
}
export async function getCampaignBinding(tenantId: string, bindingId: string): Promise<CampaignBinding> {
  const { data, error } = await tenantClient(asTenantId(tenantId)).from("ads_campaign_binding_details")
    .select("*").eq("id", bindingId).maybeSingle();
  const binding = data as CampaignBinding | null;
  if (error || !binding || binding.tenant_id !== tenantId) return unavailable();
  return binding;
}
export async function findCampaignBinding(tenantId: string, platform: string, campaignId: string): Promise<CampaignBinding | null> {
  const { data, error } = await tenantClient(asTenantId(tenantId)).from("ads_campaign_binding_details")
    .select("*").eq("platform", platform).eq("provider_campaign_id", campaignId).maybeSingle();
  const binding = data as CampaignBinding | null;
  if (error || (binding && binding.tenant_id !== tenantId)) return unavailable();
  return binding;
}
export async function bindCampaign(tenantId: string, account: AccountBinding, campaignId: string): Promise<CampaignBinding> {
  if (account.tenant_id !== tenantId) return unavailable();
  const id = await rpcId(tenantId, "ads_bind_campaign", { p_account_binding_id: account.id, p_provider_campaign_id: campaignId });
  return { id, tenant_id: tenantId, account_binding_id: account.id, account_id: account.account_id,
    platform: account.platform, provider_campaign_id: campaignId, funding_source: account.funding_source };
}
