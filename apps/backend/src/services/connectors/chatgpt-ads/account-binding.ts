import { ExpectedToolError } from "@/services/tools/types";
import { getChatgptAdsApiKey } from "./key-provider";
import { chatgptAdsGet } from "./http";
import { verifyAccountBinding, type AccountBinding } from "@/services/ads-wallet/bindings";
import { getConnectorToken } from "@/services/connectors/core/token";

export async function resolveChatgptAccount(tenantId: string, binding: AccountBinding) {
  if (binding.tenant_id !== tenantId || binding.platform !== "chatgpt") {
    throw new ExpectedToolError("ads_account_unsupported", "This ads account connection is not enabled yet.");
  }
  let key: string|null;
  if(binding.credential_source==="platform" && binding.credential_ref==="chatgpt_ads_api_key" && binding.credential_tenant_id===null && binding.funding_source==="wallet") key=await getChatgptAdsApiKey();
  else if(binding.credential_source==="tenant_connector" && binding.credential_tenant_id===tenantId && binding.funding_source==="provider" && /^chatgpt_ads\.account\.[a-f0-9]{32}\.api_key$/.test(binding.credential_ref)) key=await getConnectorToken(tenantId,"chatgpt_ads",binding.credential_ref);
  else throw new ExpectedToolError("ads_account_unsupported","This ads account credential does not match its funding source.");
  if(!key) throw new ExpectedToolError("ads_credentials_unavailable","Reconnect this ChatGPT advertiser account.");
  const account = await chatgptAdsGet<{ id?: string; currency_code?: string }>(key, "/ad_account");
  if (typeof account.id !== "string" || !account.id.trim() || typeof account.currency_code !== "string") {
    throw new ExpectedToolError("ads_binding_unavailable", "The ads account identity could not be verified.");
  }
  await verifyAccountBinding(tenantId, binding, account.id, account.currency_code);
  return { key, account };
}
