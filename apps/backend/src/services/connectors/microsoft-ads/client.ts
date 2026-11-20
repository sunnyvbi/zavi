import { getConnectorToken } from "@/services/connectors/core/token";
import { ExpectedToolError } from "@/services/tools/types";
import { CONNECT_ADS_HINT, type AdAccount, type AdCampaign } from "@/services/connectors/core/ads-shapes";
import { MICROSOFT_ADS_ACCESS_TOKEN_KEY, MICROSOFT_ADS_SLUG } from "./constants";
import { microsoftAdsPost } from "./http";

export type MsAccount = {
  Id: number | string;
  TimeZone?: string;
  Name?: string;
  Number?: string;
  CurrencyCode?: string;
  AccountLifeCycleStatus?: string;
  ParentCustomerId?: number | string;
};
type MsCampaign = {
  Id?: number | string;
  Name?: string;
  Status?: string;
  CampaignType?: string;
  DailyBudget?: number;
  BudgetType?: string;
};

async function token(tenant_id: string): Promise<string> {
  const t = await getConnectorToken(tenant_id, MICROSOFT_ADS_SLUG, MICROSOFT_ADS_ACCESS_TOKEN_KEY);
  if (!t) {
    throw new ExpectedToolError(
      "microsoft_ads_not_connected",
      `Microsoft Ads is not connected for this tenant. ${CONNECT_ADS_HINT}`,
    );
  }
  return t;
}

export async function searchAccounts(accessToken: string): Promise<MsAccount[]> {
  const user = await microsoftAdsPost<{ User?: { Id?: number | string } }>(accessToken, "customer", "User/Query", {
    UserId: null,
  });
  const userId = user.User?.Id;
  if (userId === undefined) {
    throw new ExpectedToolError("microsoft_ads_error", "Microsoft Ads User/Query returned no user id.");
  }
  const search = await microsoftAdsPost<{ Accounts?: MsAccount[] }>(accessToken, "customer", "Accounts/Search", {
    Predicates: [{ Field: "UserId", Operator: "Equals", Value: String(userId) }],
    PageInfo: { Index: 0, Size: 100 },
  });
  return search.Accounts ?? [];
}

export async function listMicrosoftAdAccountsRaw(accessToken: string): Promise<AdAccount[]> {
  return (await searchAccounts(accessToken)).map((a) => ({
    id: String(a.Id),
    name: a.Name ?? a.Number ?? String(a.Id),
    currency: a.CurrencyCode ?? null,
    status: a.AccountLifeCycleStatus ?? null,
  }));
}

export async function listMicrosoftAdAccounts(tenant_id: string): Promise<AdAccount[]> {
  return listMicrosoftAdAccountsRaw(await token(tenant_id));
}

export async function listMicrosoftCampaigns(tenant_id: string, accountId: string, limit = 100): Promise<AdCampaign[]> {
  const t = await token(tenant_id);
  const account = (await searchAccounts(t)).find((a) => String(a.Id) === accountId);
  if (!account) {
    throw new ExpectedToolError("microsoft_ads_account_not_found", `Ad account ${accountId} is not visible to this connection.`);
  }
  const data = await microsoftAdsPost<{ Campaigns?: MsCampaign[] | null }>(
    t,
    "campaign",
    "Campaigns/QueryByAccountId",
    { AccountId: accountId, ReturnAdditionalFields: null },
    {
      customerId: account.ParentCustomerId !== undefined ? String(account.ParentCustomerId) : undefined,
      customerAccountId: accountId,
    },
  );
  return (data.Campaigns ?? []).slice(0, limit).map((c) => ({
    id: String(c.Id ?? ""),
    name: c.Name ?? String(c.Id ?? ""),
    status: c.Status ?? null,
    objective: c.CampaignType ?? null,
    budget:
      typeof c.DailyBudget === "number"
        ? { amount: c.DailyBudget, currency: account.CurrencyCode ?? null, kind: "daily" as const }
        : null,
  }));
}
