import { getConnectorToken } from "@/services/connectors/core/token";
import { ExpectedToolError } from "@/services/tools/types";
import { CONNECT_ADS_HINT, type AdAccount, type AdCampaign } from "@/services/connectors/core/ads-shapes";
import { SNAPCHAT_ADS_ACCESS_TOKEN_KEY, SNAPCHAT_ADS_SLUG } from "./constants";
import { snapchatCollection } from "./http";

type Org = { id: string; name?: string };
type Acct = { id: string; name?: string; currency?: string; status?: string };
type Camp = { id: string; name?: string; status?: string; objective?: string; daily_budget_micro?: number | string };

async function token(tenant_id: string): Promise<string> {
  const t = await getConnectorToken(tenant_id, SNAPCHAT_ADS_SLUG, SNAPCHAT_ADS_ACCESS_TOKEN_KEY);
  if (!t) {
    throw new ExpectedToolError(
      "snapchat_ads_not_connected",
      `Snapchat Ads is not connected for this tenant. ${CONNECT_ADS_HINT}`,
    );
  }
  return t;
}

export async function listSnapchatAdAccountsRaw(accessToken: string): Promise<AdAccount[]> {
  const orgs = await snapchatCollection<Org>(accessToken, "me/organizations", "organizations", "organization");
  const byId = new Map<string, AdAccount>();
  for (const org of orgs) {
    const accts = await snapchatCollection<Acct>(
      accessToken,
      `organizations/${encodeURIComponent(org.id)}/adaccounts`,
      "adaccounts",
      "adaccount",
    );
    for (const a of accts) {
      byId.set(a.id, { id: a.id, name: a.name ?? a.id, currency: a.currency ?? null, status: a.status ?? null });
    }
  }
  return [...byId.values()];
}

export async function listSnapchatAdAccounts(tenant_id: string): Promise<AdAccount[]> {
  return listSnapchatAdAccountsRaw(await token(tenant_id));
}

export async function listSnapchatCampaigns(tenant_id: string, accountId: string, limit = 100): Promise<AdCampaign[]> {
  const rows = await snapchatCollection<Camp>(
    await token(tenant_id),
    `adaccounts/${encodeURIComponent(accountId)}/campaigns`,
    "campaigns",
    "campaign",
    { limit: String(Math.min(limit, 1000)) },
    limit,
  );
  return rows.map((c) => ({
    id: c.id,
    name: c.name ?? c.id,
    status: c.status ?? null,
    objective: c.objective ?? null,
    budget:
      c.daily_budget_micro !== undefined
        ? { amount: Number(c.daily_budget_micro) / 1_000_000, currency: null, kind: "daily" as const }
        : null,
  }));
}
