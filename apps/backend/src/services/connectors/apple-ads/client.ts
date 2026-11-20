import { getSecret } from "@/services/secrets/vault";
import { ExpectedToolError } from "@/services/tools/types";
import { CONNECT_ADS_HINT, type AdAccount, type AdCampaign } from "@/services/connectors/core/ads-shapes";
import {
  APPLE_ADS_CLIENT_ID_KEY,
  APPLE_ADS_KEY_ID_KEY,
  APPLE_ADS_PRIVATE_KEY_KEY,
  APPLE_ADS_REFRESH_TOKEN_KEY,
  APPLE_ADS_TEAM_ID_KEY,
} from "./constants";
import { appleAccessToken, appleAdsRequest, type AppleCreds } from "./http";

type Acl = { adAccount?: { id?: number; name?: string; orgId?: number }; roles?: string[] };
type AppleCampaign = {
  id?: number;
  name?: string;
  status?: string;
  servingStatus?: string;
  budgetAmount?: { amount?: string; currency?: string };
  dailyBudgetAmount?: { amount?: string; currency?: string };
};

export async function tenantCreds(tenant_id: string): Promise<AppleCreds> {
  const [clientId, teamId, keyId, privateKeyPem, refreshToken] = await Promise.all([
    getSecret(tenant_id, APPLE_ADS_CLIENT_ID_KEY),
    getSecret(tenant_id, APPLE_ADS_TEAM_ID_KEY),
    getSecret(tenant_id, APPLE_ADS_KEY_ID_KEY),
    getSecret(tenant_id, APPLE_ADS_PRIVATE_KEY_KEY),
    getSecret(tenant_id, APPLE_ADS_REFRESH_TOKEN_KEY),
  ]);
  if (!clientId || !teamId || !keyId || !privateKeyPem) {
    throw new ExpectedToolError("apple_ads_not_connected", `Apple Ads is not connected for this tenant. ${CONNECT_ADS_HINT}`);
  }
  return { clientId, teamId, keyId, privateKeyPem, refreshToken: refreshToken ?? undefined };
}

export async function listAppleAdAccountsRaw(accessToken: string): Promise<AdAccount[]> {
  const env = await appleAdsRequest<{ acls?: Acl[] }>(accessToken, "GET", "acls");
  return (env.result?.acls ?? []).flatMap((acl) =>
    acl.adAccount?.id === undefined
      ? []
      : [{ id: String(acl.adAccount.id), name: acl.adAccount.name ?? String(acl.adAccount.id), currency: null, status: acl.roles?.join(",") || null }],
  );
}

export async function listAppleAdAccounts(tenant_id: string): Promise<AdAccount[]> {
  return listAppleAdAccountsRaw(await appleAccessToken(await tenantCreds(tenant_id), tenant_id));
}

export async function listAppleCampaigns(tenant_id: string, adAccountId: string, limit = 100): Promise<AdCampaign[]> {
  const token = await appleAccessToken(await tenantCreds(tenant_id), tenant_id);
  const env = await appleAdsRequest<AppleCampaign[]>(token, "POST", "campaigns/query", {
    adAccountId,
    body: { pagination: { offset: 0, pageSize: Math.min(limit, 1000), fetchTotalCount: false } },
  });
  return (env.result ?? []).slice(0, limit).map((c) => {
    const daily = c.dailyBudgetAmount?.amount;
    const total = c.budgetAmount?.amount;
    return {
      id: String(c.id ?? ""),
      name: c.name ?? String(c.id ?? ""),
      status: c.status ?? c.servingStatus ?? null,
      objective: null,
      budget: daily
        ? { amount: Number(daily), currency: c.dailyBudgetAmount?.currency ?? null, kind: "daily" as const }
        : total
          ? { amount: Number(total), currency: c.budgetAmount?.currency ?? null, kind: "lifetime" as const }
          : null,
    };
  });
}
