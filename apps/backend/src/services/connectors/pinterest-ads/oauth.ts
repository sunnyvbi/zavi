
import type { ConnectorOAuth } from "../core/types";
import { oauth2AuthCode } from "../core/oauth2-authcode";
import {
  PINTEREST_ADS_ACCESS_TOKEN_KEY,
  PINTEREST_ADS_DEFAULT_TTL_SEC,
  PINTEREST_ADS_REFRESH_TOKEN_KEY,
  PINTEREST_ADS_SCOPES,
  PINTEREST_ADS_SLUG,
  pinterestAdsCreds,
} from "./constants";

const flow = oauth2AuthCode({
  slug: PINTEREST_ADS_SLUG,
  authorizeUrl: "https://www.pinterest.com/oauth/",
  tokenUrl: "https://api.pinterest.com/v5/oauth/token",
  scopes: PINTEREST_ADS_SCOPES,
  scopeSeparator: ",",
  clientAuth: "basic",
  extraExchangeParams: { continuous_refresh: "true" },
  creds: pinterestAdsCreds,
  accessTokenKey: PINTEREST_ADS_ACCESS_TOKEN_KEY,
  refreshTokenKey: PINTEREST_ADS_REFRESH_TOKEN_KEY,
  defaultTtlSec: PINTEREST_ADS_DEFAULT_TTL_SEC,
  async identify(accessToken) {
    const { listPinterestAdAccountsRaw } = await import("./client");
    const accounts = await listPinterestAdAccountsRaw(accessToken);
    const first = accounts[0];
    return {
      team_id: first?.id ?? "no_ad_account",
      team_name: first
        ? `${first.name}${accounts.length > 1 ? ` (+${accounts.length - 1})` : ""}`
        : "Pinterest Ads (no ad account)",
    };
  },
});

export const pinterestAdsConnector: ConnectorOAuth = {
  slug: PINTEREST_ADS_SLUG,
  serverId: PINTEREST_ADS_SLUG,
  scopes: [...PINTEREST_ADS_SCOPES],
  ...flow,
};
