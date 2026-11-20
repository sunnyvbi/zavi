import { getConnectorToken } from "@/services/connectors/core/token";
import { ExpectedToolError } from "@/services/tools/types";
import { CONNECT_ADS_HINT, type AdAccount, type AdCampaign } from "@/services/connectors/core/ads-shapes";
import { SPOTIFY_ADS_ACCESS_TOKEN_KEY, SPOTIFY_ADS_SLUG } from "./constants";
import { spotifyAdsGet } from "./http";

type Biz = { id: string; name?: string };
type Acct = { id: string; name?: string; currency_code?: string; status?: string };
type Camp = { id: string; name?: string; status?: string; objective?: string };

async function token(tenant_id: string): Promise<string> {
  const t = await getConnectorToken(tenant_id, SPOTIFY_ADS_SLUG, SPOTIFY_ADS_ACCESS_TOKEN_KEY);
  if (!t) {
    throw new ExpectedToolError(
      "spotify_ads_not_connected",
      `Spotify Ads is not connected for this tenant. ${CONNECT_ADS_HINT}`,
    );
  }
  return t;
}

export async function listSpotifyAdAccountsRaw(accessToken: string): Promise<AdAccount[]> {
  const { businesses = [] } = await spotifyAdsGet<{ businesses?: Biz[] }>(accessToken, "businesses");
  const byId = new Map<string, AdAccount>();
  for (const b of businesses) {
    const { ad_accounts = [] } = await spotifyAdsGet<{ ad_accounts?: Acct[] }>(
      accessToken,
      `businesses/${b.id}/ad_accounts`,
    );
    for (const a of ad_accounts) {
      byId.set(a.id, { id: a.id, name: a.name ?? a.id, currency: a.currency_code ?? null, status: a.status ?? null });
    }
  }
  return [...byId.values()];
}

export async function listSpotifyAdAccounts(tenant_id: string): Promise<AdAccount[]> {
  return listSpotifyAdAccountsRaw(await token(tenant_id));
}

export async function listSpotifyCampaigns(tenant_id: string, accountId: string, limit = 100): Promise<AdCampaign[]> {
  const { campaigns = [] } = await spotifyAdsGet<{ campaigns?: Camp[] }>(
    await token(tenant_id),
    `ad_accounts/${accountId}/campaigns`,
  );
  return campaigns.slice(0, limit).map((c) => ({
    id: c.id,
    name: c.name ?? c.id,
    status: c.status ?? null,
    objective: c.objective ?? null,
    budget: null,
  }));
}
