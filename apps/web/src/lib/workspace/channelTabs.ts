
import { CHANNELS } from "@zavi/shared";

export type ChannelSlug = (typeof CHANNELS)[number]["slug"];

const channelTab = <T extends ChannelSlug>(slug: T): T => slug;

export const CHANNEL_TAB = {
  metaAds: channelTab("meta_ads"),
  googleAds: channelTab("google_ads"),
  seo: channelTab("seo"),
  geo: channelTab("geo"),
  x: channelTab("x_organic"),
  reddit: channelTab("reddit_organic"),
  email: channelTab("email_marketing"),
} as const;
