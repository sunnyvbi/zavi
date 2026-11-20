
import type { ConnectorOAuth } from "../core/types";
import { oauth2AuthCode } from "../core/oauth2-authcode";
import {
  SNAPCHAT_ADS_ACCESS_TOKEN_KEY,
  SNAPCHAT_ADS_DEFAULT_TTL_SEC,
  SNAPCHAT_ADS_REFRESH_TOKEN_KEY,
  SNAPCHAT_ADS_SCOPES,
  SNAPCHAT_ADS_SLUG,
  snapchatAdsCreds,
} from "./constants";

const flow = oauth2AuthCode({
  slug: SNAPCHAT_ADS_SLUG,
  authorizeUrl: "https://accounts.snapchat.com/login/oauth2/authorize",
  tokenUrl: "https://accounts.snapchat.com/login/oauth2/access_token",
  scopes: SNAPCHAT_ADS_SCOPES,
  clientAuth: "body",
  creds: snapchatAdsCreds,
  accessTokenKey: SNAPCHAT_ADS_ACCESS_TOKEN_KEY,
  refreshTokenKey: SNAPCHAT_ADS_REFRESH_TOKEN_KEY,
  defaultTtlSec: SNAPCHAT_ADS_DEFAULT_TTL_SEC,
  async identify(accessToken) {
    const { listSnapchatAdAccountsRaw } = await import("./client");
    const accounts = await listSnapchatAdAccountsRaw(accessToken);
    const first = accounts[0];
    return {
      team_id: first?.id ?? "no_ad_account",
      team_name: first
        ? `${first.name}${accounts.length > 1 ? ` (+${accounts.length - 1})` : ""}`
        : "Snapchat Ads (no ad account)",
    };
  },
});

export const snapchatAdsConnector: ConnectorOAuth = {
  slug: SNAPCHAT_ADS_SLUG,
  serverId: SNAPCHAT_ADS_SLUG,
  scopes: [...SNAPCHAT_ADS_SCOPES],
  ...flow,
};
