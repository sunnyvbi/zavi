import { startConnectFlow } from "@/app/connectors/ConnectButton";
import { startMetaAdsConnect } from "@/app/connectors/MetaAdsConnectButton";
import { startGoogleAdsConnect } from "@/app/connectors/GoogleAdsConnectButton";
import { startGoogleAnalyticsConnect } from "@/app/connectors/GoogleAnalyticsConnectButton";
import { startGoogleSearchConsoleConnect } from "@/app/connectors/GoogleSearchConsoleConnectButton";
import {
  startGoogleCalendarConnect,
  startGoogleSheetsConnect,
} from "@/app/connectors/GoogleWorkspaceConnect";
import { startRailConnect } from "@/app/connectors/connectStrategies";

export async function startReconnectFlow(slug: string): Promise<void> {
  switch (slug) {
    case "meta_ads":
      return startMetaAdsConnect();
    case "google_ads":
      return startGoogleAdsConnect();
    case "google_analytics":
      return startGoogleAnalyticsConnect();
    case "google_search_console":
      return startGoogleSearchConsoleConnect();
    case "google_calendar":
      return startGoogleCalendarConnect();
    case "google_sheets":
      return startGoogleSheetsConnect();
    case "tiktok_ads":
    case "reddit_ads":
      return startRailConnect(slug, slug);
    case "apple_ads":
      window.location.hash = "connector-apple_ads";
      return Promise.resolve();
    default:
      return startConnectFlow(slug);
  }
}
