import { paidAdsAdapter } from "./paidAdsTables";

const reddit = paidAdsAdapter({
  platform: "reddit_ads",
  brand: "Reddit",
  budgetColumn: true,
  problem: (code) =>
    code === "reddit_ads_token_revoked"
      ? {
          text: "Reddit Ads stopped accepting Zavi's access, so these numbers could not be read. Reconnect to bring them back.",
          reconnect: true,
        }
      : code === "reddit_ads_rate_limited"
        ? { text: "Reddit Ads is limiting requests. Wait a minute, then try Refresh.", reconnect: false }
        : { text: "Zavi could not read your Reddit Ads account just now. Try Refresh in a minute.", reconnect: false },
});

export const isRedditAdsPayload = reddit.is;
export const redditAdsKpis = reddit.kpis;
export const redditAdsCampaignTable = reddit.campaignTable;
export const redditAdsChrome = reddit.chrome;
export const redditAdsCampaignLinks = reddit.campaignLinks;
