
import { getConnectorToken } from "@/services/connectors/core/token";
import { ExpectedToolError } from "@/services/tools/types";
import { CONNECT_ADS_HINT } from "@/services/connectors/core/ads-shapes";
import { TIKTOK_ADS_ACCESS_TOKEN_KEY, TIKTOK_ADS_SLUG, tiktokAdsCreds } from "./constants";
import { tiktokAdsGet } from "./http";

const ADVERTISER_INFO_FIELDS = ["advertiser_id", "name", "currency", "status", "timezone"];
const ADVERTISER_INFO_BATCH = 100;

export type TikTokAdvertiser = {
  advertiser_id: string;
  advertiser_name?: string;
};

export type TikTokAdvertiserInfo = {
  advertiser_id: string;
  name?: string;
  currency?: string;
  status?: string;
  timezone?: string;
};

export type TikTokCampaign = {
  campaign_id: string;
  campaign_name?: string;
  operation_status?: string;
  secondary_status?: string;
  objective_type?: string;
  budget?: number;
  budget_mode?: string;
};

async function tenantToken(tenant_id: string): Promise<string> {
  const token = await getConnectorToken(tenant_id, TIKTOK_ADS_SLUG, TIKTOK_ADS_ACCESS_TOKEN_KEY);
  if (!token) {
    throw new ExpectedToolError(
      "tiktok_ads_not_connected",
      `TikTok Ads is not connected for this tenant. ${CONNECT_ADS_HINT}`,
    );
  }
  return token;
}

export async function listTikTokAdvertisers(tenant_id: string): Promise<TikTokAdvertiserInfo[]> {
  const token = await tenantToken(tenant_id);
  const { appId, secret } = tiktokAdsCreds();

  const authorized = await tiktokAdsGet<{ list?: TikTokAdvertiser[] }>(
    token,
    "oauth2/advertiser/get",
    { app_id: appId, secret },
  );
  const ids = (authorized.list ?? []).map((a) => a.advertiser_id).filter(Boolean);
  if (ids.length === 0) return [];

  const info = await tiktokAdsGet<{ list?: TikTokAdvertiserInfo[] }>(token, "advertiser/info", {
    advertiser_ids: ids.slice(0, ADVERTISER_INFO_BATCH),
    fields: ADVERTISER_INFO_FIELDS,
  });
  const byId = new Map((info.list ?? []).map((i) => [i.advertiser_id, i]));

  return ids.map((id) => {
    const details = byId.get(id);
    const fallbackName = (authorized.list ?? []).find((a) => a.advertiser_id === id)?.advertiser_name;
    return {
      advertiser_id: id,
      name: details?.name ?? fallbackName ?? id,
      currency: details?.currency,
      status: details?.status?.replace(/^STATUS_/, ""),
      timezone: details?.timezone,
    };
  });
}

export async function listTikTokCampaigns(
  tenant_id: string,
  advertiserId: string,
  limit = 100,
): Promise<TikTokCampaign[]> {
  const token = await tenantToken(tenant_id);
  const data = await tiktokAdsGet<{ list?: TikTokCampaign[] }>(token, "campaign/get", {
    advertiser_id: advertiserId,
    page: 1,
    page_size: Math.min(limit, 1000),
  });
  return (data.list ?? []).slice(0, limit);
}
