import type { PlatformSpec } from "./_shared";

export const youtube_ads: PlatformSpec = {
  name: "YouTube Ads",
  createMenu: "Create",
  description: "Reviews your video campaigns and proposes changes you approve",
  manageUrl: "https://ads.google.com/aw/campaigns",
  paidAnalytics: "youtube",
  postingSettings: {
    accountFromPayload: (payload) => {
      const name = (payload as { account?: { name?: unknown } } | null)?.account?.name;
      return typeof name === "string" && name.trim() ? name.trim() : null;
    },
    connectionName: "YouTube Ads",
    connectionLogo: "/logos/youtube-channel.svg",
  },
  extras: ["campaign_table"],
  topActions: [
    { key: "new_campaign", label: "Create campaign", modal: "google_campaign" },
  ],
};
