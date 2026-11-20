
export const MICROSOFT_ADS_SLUG = "microsoft_ads";
export const MICROSOFT_ADS_ACCESS_TOKEN_KEY = `${MICROSOFT_ADS_SLUG}.access_token`;
export const MICROSOFT_ADS_REFRESH_TOKEN_KEY = `${MICROSOFT_ADS_SLUG}.refresh_token`;

export const MICROSOFT_ADS_SCOPES = ["https://ads.microsoft.com/msads.manage", "offline_access"] as const;
export const MICROSOFT_ADS_DEFAULT_TTL_SEC = 3600;
export const MICROSOFT_ADS_SANDBOX_DEVELOPER_TOKEN = "BBD37VB98";

export type MicrosoftService = "campaign" | "customer" | "reporting";

export function microsoftAdsSandbox(): boolean {
  return process.env.MICROSOFT_ADS_SANDBOX === "1";
}

export function microsoftAdsHost(service: MicrosoftService): string {
  const infix = microsoftAdsSandbox() ? ".sandbox" : "";
  if (service === "reporting") return `https://reporting.api${infix}.bingads.microsoft.com/Reporting/v13`;
  return service === "campaign"
    ? `https://campaign.api${infix}.bingads.microsoft.com/CampaignManagement/v13`
    : `https://clientcenter.api${infix}.bingads.microsoft.com/CustomerManagement/v13`;
}

export function microsoftAdsDeveloperToken(): string {
  if (microsoftAdsSandbox()) return MICROSOFT_ADS_SANDBOX_DEVELOPER_TOKEN;
  const t = process.env.MICROSOFT_ADS_DEVELOPER_TOKEN?.trim();
  if (!t) {
    throw new Error(
      "MICROSOFT_ADS_DEVELOPER_TOKEN is unset (and/or Microsoft has not approved it yet). " +
        "Set MICROSOFT_ADS_SANDBOX=1 to use the published sandbox token.",
    );
  }
  return t;
}

export function microsoftAdsCreds(): { id: string; secret: string } {
  const id = process.env.MICROSOFT_ADS_CLIENT_ID?.trim();
  const secret = process.env.MICROSOFT_ADS_CLIENT_SECRET?.trim();
  if (!id || !secret) throw new Error("MICROSOFT_ADS_CLIENT_ID and MICROSOFT_ADS_CLIENT_SECRET must be set.");
  return { id, secret };
}
