import { getConnectorToken } from "@/services/connectors/core/token";
import { ExpectedToolError } from "@/services/tools/types";
import { CONNECT_ADS_HINT, type AdAccount, type AdCampaign } from "@/services/connectors/core/ads-shapes";
import { PINTEREST_ADS_ACCESS_TOKEN_KEY, PINTEREST_ADS_SLUG } from "./constants";
import { pinterestCollect } from "./http";

type Acct = { id: string; name?: string; currency?: string };
type Camp = {
  id: string;
  name?: string | null;
  status?: string;
  objective_type?: string;
  daily_spend_cap?: number | null;
  lifetime_spend_cap?: number | null;
};
const ENTITY_STATUSES = ["ACTIVE", "PAUSED", "ARCHIVED", "DRAFT"];

async function token(tenant_id: string): Promise<string> {
  const t = await getConnectorToken(tenant_id, PINTEREST_ADS_SLUG, PINTEREST_ADS_ACCESS_TOKEN_KEY);
  if (!t) {
    throw new ExpectedToolError(
      "pinterest_ads_not_connected",
      `Pinterest Ads is not connected for this tenant. ${CONNECT_ADS_HINT}`,
    );
  }
  return t;
}

export async function listPinterestAdAccountsRaw(accessToken: string): Promise<AdAccount[]> {
  const rows = await pinterestCollect<Acct>(accessToken, "ad_accounts");
  return rows.map((a) => ({ id: a.id, name: a.name ?? a.id, currency: a.currency ?? null, status: null }));
}

export async function listPinterestAdAccounts(tenant_id: string): Promise<AdAccount[]> {
  return listPinterestAdAccountsRaw(await token(tenant_id));
}

export async function listPinterestCampaigns(tenant_id: string, accountId: string, limit = 100): Promise<AdCampaign[]> {
  const params = new URLSearchParams();
  for (const s of ENTITY_STATUSES) params.append("entity_statuses", s);
  const rows = await pinterestCollect<Camp>(await token(tenant_id), `ad_accounts/${accountId}/campaigns`, params, limit);
  return rows.map((c) => ({
    id: c.id,
    name: c.name ?? c.id,
    status: c.status ?? null,
    objective: c.objective_type ?? null,
    budget:
      c.daily_spend_cap != null
        ? { amount: c.daily_spend_cap / 1_000_000, currency: null, kind: "daily" as const }
        : c.lifetime_spend_cap != null
          ? { amount: c.lifetime_spend_cap / 1_000_000, currency: null, kind: "lifetime" as const }
          : null,
  }));
}
