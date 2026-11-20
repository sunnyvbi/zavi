
import { getConnectorToken } from "@/services/connectors/core/token";
import { ExpectedToolError } from "@/services/tools/types";
import { CONNECT_ADS_HINT } from "@/services/connectors/core/ads-shapes";
import { REDDIT_ADS_API_BASE, REDDIT_ADS_ACCESS_TOKEN_KEY, REDDIT_ADS_SLUG } from "./constants";
import { redditAdsGet, type RedditBusiness } from "./http";

const MAX_PAGES = 20;

export type RedditAdAccount = {
  id: string;
  name?: string;
  currency?: string;
};

export type RedditCampaign = {
  id: string;
  name?: string;
  configured_status?: string;
  effective_status?: string;
  objective?: string;
};

async function tenantToken(tenant_id: string): Promise<string> {
  const token = await getConnectorToken(tenant_id, REDDIT_ADS_SLUG, REDDIT_ADS_ACCESS_TOKEN_KEY);
  if (!token) {
    throw new ExpectedToolError(
      "reddit_ads_not_connected",
      `Reddit Ads is not connected for this tenant. ${CONNECT_ADS_HINT}`,
    );
  }
  return token;
}

async function getPaged<T>(tenant_id: string, path: string, limit = 200): Promise<T[]> {
  const token = await tenantToken(tenant_id);
  const rows: T[] = [];
  let url = `${REDDIT_ADS_API_BASE}/${path}`;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const env = await redditAdsGet<T[]>(token, url);
    const chunk = Array.isArray(env.data) ? env.data : [];
    rows.push(...chunk.slice(0, Math.max(0, limit - rows.length)));
    const next = env.pagination?.next_url;
    if (rows.length >= limit || !next || !next.startsWith(`${REDDIT_ADS_API_BASE}/`)) return rows;
    url = next;
  }
  return rows;
}

export async function listRedditAdAccounts(tenant_id: string): Promise<RedditAdAccount[]> {
  const businesses = await getPaged<RedditBusiness>(tenant_id, "me/businesses?page.size=100", 100);
  const byId = new Map<string, RedditAdAccount>();
  for (const business of businesses) {
    const accounts = await getPaged<RedditAdAccount>(
      tenant_id,
      `businesses/${encodeURIComponent(business.id)}/ad_accounts?page.size=100`,
      200,
    );
    for (const account of accounts) byId.set(account.id, account);
  }
  return [...byId.values()];
}

export async function listRedditCampaigns(
  tenant_id: string,
  accountId: string,
  limit = 200,
): Promise<RedditCampaign[]> {
  return getPaged<RedditCampaign>(
    tenant_id,
    `ad_accounts/${encodeURIComponent(accountId)}/campaigns?page.size=${Math.min(limit, 1000)}`,
    limit,
  );
}
