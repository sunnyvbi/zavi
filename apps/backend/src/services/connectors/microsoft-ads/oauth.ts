
import type { ConnectorOAuth } from "../core/types";
import { oauth2AuthCode } from "../core/oauth2-authcode";
import {
  MICROSOFT_ADS_ACCESS_TOKEN_KEY,
  MICROSOFT_ADS_DEFAULT_TTL_SEC,
  MICROSOFT_ADS_REFRESH_TOKEN_KEY,
  MICROSOFT_ADS_SCOPES,
  MICROSOFT_ADS_SLUG,
  microsoftAdsCreds,
} from "./constants";

const flow = oauth2AuthCode({
  slug: MICROSOFT_ADS_SLUG,
  authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
  tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
  scopes: MICROSOFT_ADS_SCOPES,
  clientAuth: "body",
  extraAuthorizeParams: { response_mode: "query" },
  extraRefreshParams: { scope: MICROSOFT_ADS_SCOPES[0] },
  creds: microsoftAdsCreds,
  accessTokenKey: MICROSOFT_ADS_ACCESS_TOKEN_KEY,
  refreshTokenKey: MICROSOFT_ADS_REFRESH_TOKEN_KEY,
  defaultTtlSec: MICROSOFT_ADS_DEFAULT_TTL_SEC,
  async identify(accessToken) {
    const { listMicrosoftAdAccountsRaw } = await import("./client");
    const accounts = await listMicrosoftAdAccountsRaw(accessToken);
    const first = accounts[0];
    return {
      team_id: first?.id ?? "no_ad_account",
      team_name: first
        ? `${first.name}${accounts.length > 1 ? ` (+${accounts.length - 1})` : ""}`
        : "Microsoft Ads (no ad account)",
    };
  },
});

export const microsoftAdsConnector: ConnectorOAuth = {
  slug: MICROSOFT_ADS_SLUG,
  serverId: MICROSOFT_ADS_SLUG,
  scopes: [...MICROSOFT_ADS_SCOPES],
  ...flow,
};
