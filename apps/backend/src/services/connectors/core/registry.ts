
import type { ConnectorOAuth } from "./types";
import { jiraConnector } from "../jira";
import { linearConnector } from "../linear";
import { intercomConnector } from "../intercom";
import { linkedinSocialConnector } from "../linkedin-social/oauth";
import { xSocialConnector } from "../x-social/oauth";
import { higgsfieldOauthConnector } from "../higgsfield/oauth";
import { redditSocialConnector } from "../reddit-social/oauth";
import { instagramSocialConnector } from "../instagram-social/oauth";
import { redditAdsConnector } from "../reddit-ads/oauth";
import { tiktokAdsConnector } from "../tiktok-ads/oauth";
import { linkedinAdsConnector } from "../linkedin-ads/oauth";
import { snapchatAdsConnector } from "../snapchat-ads/oauth";
import { spotifyAdsConnector } from "../spotify-ads/oauth";
import { pinterestAdsConnector } from "../pinterest-ads/oauth";
import { microsoftAdsConnector } from "../microsoft-ads/oauth";

const CONNECTORS: Record<string, ConnectorOAuth> = {
  [jiraConnector.slug]: jiraConnector,
  [higgsfieldOauthConnector.slug]: higgsfieldOauthConnector,
  [linearConnector.slug]: linearConnector,
  [linkedinSocialConnector.slug]: linkedinSocialConnector,
  [xSocialConnector.slug]: xSocialConnector,
  [redditSocialConnector.slug]: redditSocialConnector,
  [instagramSocialConnector.slug]: instagramSocialConnector,
  [redditAdsConnector.slug]: redditAdsConnector,
  [tiktokAdsConnector.slug]: tiktokAdsConnector,
  [linkedinAdsConnector.slug]: linkedinAdsConnector,
  [snapchatAdsConnector.slug]: snapchatAdsConnector,
  [spotifyAdsConnector.slug]: spotifyAdsConnector,
  [pinterestAdsConnector.slug]: pinterestAdsConnector,
  [microsoftAdsConnector.slug]: microsoftAdsConnector,
  [intercomConnector.slug]: intercomConnector,
};

export function isKnownConnector(slug: string): boolean {
  return Object.prototype.hasOwnProperty.call(CONNECTORS, slug);
}

export function getConnector(slug: string): ConnectorOAuth | null {
  return isKnownConnector(slug) ? CONNECTORS[slug] : null;
}

export function knownConnectorSlugs(): string[] {
  return Object.keys(CONNECTORS);
}
