import { paidAdsAdapter } from "./paidAdsTables";

const PROBLEM: Record<string, { text: string; reconnect: boolean }> = {
  x_ads_not_connected: {
    text: "No X Ads account is connected. Connect one to read its campaigns.",
    reconnect: true,
  },
  x_ads_forbidden: {
    text: "X Ads would not let Zavi read this ad account. The X login you connected needs access to the ad account, so reconnect with one that has it.",
    reconnect: true,
  },
  x_ads_rate_limited: {
    text: "X Ads is limiting requests. Wait a minute, then try Refresh.",
    reconnect: false,
  },
};

const x = paidAdsAdapter({
  platform: "x_ads",
  brand: "X",
  budgetColumn: true,
  problem: (code) =>
    PROBLEM[code] ?? { text: "Zavi could not read your X Ads account just now. Try Refresh in a minute.", reconnect: false },
});

export const isXAdsPayload = x.is;
export const xAdsKpis = x.kpis;
export const xAdsCampaignTable = x.campaignTable;
export const xAdsChrome = x.chrome;
export const xAdsCampaignLinks = x.campaignLinks;
