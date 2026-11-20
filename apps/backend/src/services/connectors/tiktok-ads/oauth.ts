
import type { ConnectorExchangeResult, ConnectorOAuth } from "../core/types";
import {
  TIKTOK_ADS_ACCESS_TOKEN_KEY,
  TIKTOK_ADS_ADVERTISER_IDS_KEY,
  TIKTOK_ADS_SLUG,
  tiktokAdsCreds,
} from "./constants";

const TOKEN_URL = "https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/";

export const TIKTOK_ADS_EXPECTED_SCOPES = ["100", "200", "44"] as const;

export function tiktokAdsAuthorizeUrl(state: string, redirectUri: string): string {
  const configured = process.env.TIKTOK_ADS_AUTHORIZE_URL?.trim();
  if (configured) {
    const u = new URL(configured);
    u.searchParams.set("state", state);
    return u.toString();
  }
  const { appId } = tiktokAdsCreds();
  const u = new URL("https://business-api.tiktok.com/portal/auth");
  u.searchParams.set("app_id", appId);
  u.searchParams.set("state", state);
  u.searchParams.set("redirect_uri", redirectUri);
  return u.toString();
}

type TokenEnvelope = {
  code: number;
  message?: string;
  request_id?: string;
  data?: {
    access_token?: string;
    scope?: Array<number | string>;
    advertiser_ids?: string[];
  };
};

export async function tiktokAdsExchangeCode(
  authCode: string,
  _redirectUri: string,
): Promise<ConnectorExchangeResult> {
  const { appId, secret } = tiktokAdsCreds();
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      app_id: appId,
      secret,
      auth_code: authCode,
      return_advertiser_ids: true,
    }),
    signal: AbortSignal.timeout(20_000),
  });

  if (!resp.ok) {
    throw new Error(`TikTok Ads token HTTP ${resp.status}`);
  }
  const json = (await resp.json()) as TokenEnvelope;
  if (json.code !== 0 && json.code !== 20001) {
    throw new Error(
      `TikTok Ads token error ${json.code}: ${json.message ?? "unknown"}${
        json.request_id ? ` [request_id: ${json.request_id}]` : ""
      }`,
    );
  }
  const access_token = json.data?.access_token?.trim() ?? "";
  if (!access_token) throw new Error("TikTok Ads token response missing access_token");

  const advertiserIds = (json.data?.advertiser_ids ?? []).filter(Boolean);
  const scopes = (json.data?.scope ?? []).map((s) => String(s));

  return {
    secrets: {
      [TIKTOK_ADS_ACCESS_TOKEN_KEY]: access_token,
      [TIKTOK_ADS_ADVERTISER_IDS_KEY]: JSON.stringify(advertiserIds),
    },
    metadata: {
      team_id: advertiserIds[0] ?? "no_advertiser",
      team_name:
        advertiserIds.length > 0
          ? `TikTok Ads (${advertiserIds.length} advertiser${advertiserIds.length === 1 ? "" : "s"})`
          : "TikTok Ads (no advertiser authorized)",
      scopes,
    },
  };
}

export const tiktokAdsConnector: ConnectorOAuth = {
  slug: TIKTOK_ADS_SLUG,
  serverId: TIKTOK_ADS_SLUG,
  scopes: [...TIKTOK_ADS_EXPECTED_SCOPES],
  codeParam: "auth_code",
  authorizeUrl: tiktokAdsAuthorizeUrl,
  exchangeCode: tiktokAdsExchangeCode,
};
