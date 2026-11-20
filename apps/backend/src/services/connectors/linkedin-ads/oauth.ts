
import type { ConnectorOAuth } from "../core/types";
import { oauth2AuthCode } from "../core/oauth2-authcode";
import {
  LINKEDIN_ADS_ACCESS_TOKEN_KEY,
  LINKEDIN_ADS_DEFAULT_TTL_SEC,
  LINKEDIN_ADS_REFRESH_TOKEN_KEY,
  LINKEDIN_ADS_SCOPES,
  LINKEDIN_ADS_SLUG,
  linkedinAdsCreds,
} from "./constants";

const flow = oauth2AuthCode({
  slug: LINKEDIN_ADS_SLUG,
  authorizeUrl: "https://www.linkedin.com/oauth/v2/authorization",
  tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
  scopes: LINKEDIN_ADS_SCOPES,
  clientAuth: "body",
  creds: linkedinAdsCreds,
  accessTokenKey: LINKEDIN_ADS_ACCESS_TOKEN_KEY,
  refreshTokenKey: LINKEDIN_ADS_REFRESH_TOKEN_KEY,
  defaultTtlSec: LINKEDIN_ADS_DEFAULT_TTL_SEC,
  async identify(accessToken) {
    const { listLinkedInAdAccountsRaw } = await import("./client");
    const accounts = await listLinkedInAdAccountsRaw(accessToken).catch((e: unknown) => {
      console.warn("linkedin_ads_identify_failed", { detail: (e as Error).message });
      return null;
    });
    if (!accounts) return { team_id: "", team_name: "LinkedIn Ads" };
    const first = accounts[0];
    return {
      team_id: first?.id ?? "no_ad_account",
      team_name: first
        ? `${first.name}${accounts.length > 1 ? ` (+${accounts.length - 1})` : ""}`
        : "LinkedIn Ads (no ad account)",
    };
  },
});

export const linkedinAdsConnector: ConnectorOAuth = {
  slug: LINKEDIN_ADS_SLUG,
  serverId: LINKEDIN_ADS_SLUG,
  scopes: [...LINKEDIN_ADS_SCOPES],
  ...flow,
  bindCallbackToSession: true,
  async onConnect(tenant_id) {
    const { reclaimLinkedinAccountClaims } = await import("@/services/ads-wallet/adapters/linkedin-account");
    await reclaimLinkedinAccountClaims(tenant_id);
  },
  async onDisconnect(tenant_id) {
    const { releaseLinkedinAccountClaims } = await import("@/services/ads-wallet/adapters/linkedin-account");
    await releaseLinkedinAccountClaims(tenant_id);
  },
};
