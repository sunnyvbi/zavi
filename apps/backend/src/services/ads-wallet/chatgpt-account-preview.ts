import { asTenantId, tenantClient } from "@/services/tenant-client";
import { getAccountBinding } from "./bindings";
import { resolveChatgptAccount } from "@/services/connectors/chatgpt-ads/account-binding";
import { getChatgptAdsApiKey } from "@/services/connectors/chatgpt-ads/key-provider";
import { chatgptAdsGet } from "@/services/connectors/chatgpt-ads/http";

export async function previewChatgptAccount(
  tenantId: string,
  requestId?: string,
) {
  const db = tenantClient(asTenantId(tenantId));
  let id: string | undefined;
  if (requestId) {
    const request = await db
      .from("ads_campaign_create_requests")
      .select("account_binding_id")
      .eq("platform", "chatgpt")
      .eq("request_id", requestId)
      .maybeSingle();
    if (request.error) throw new Error("Campaign account is unavailable");
    id = (request.data as { account_binding_id: string } | null)
      ?.account_binding_id;
  }
  if (!id) {
    const selection = await db
      .from("ads_account_selections")
      .select("account_binding_id")
      .eq("platform", "chatgpt")
      .maybeSingle();
    if (selection.error) throw new Error("Selected account is unavailable");
    id = (selection.data as { account_binding_id: string } | null)
      ?.account_binding_id;
  }
  if (id) {
    const binding = await getAccountBinding(tenantId, id);
    return {
      ...(await resolveChatgptAccount(tenantId, binding)),
      accountId: binding.account_id,
      fundingSource: binding.funding_source,
    };
  }
  const key = await getChatgptAdsApiKey();
  return {
    key,
    accountId: null,
    fundingSource: "wallet" as const,
    account: await chatgptAdsGet<{ id?: string; currency_code?: string }>(
      key,
      "/ad_account",
    ),
  };
}
