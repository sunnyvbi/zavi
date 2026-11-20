"use client";

import { connectorSettingsPath, railFor, satisfyingSlugs, type ConnectInfo } from "@zavi/shared";
import { isZaviManagedGithubLogin } from "@/components/workspace/build/existingProduct";
import { startConnectFlow } from "./ConnectButton";
import { startComposioConnect } from "./composioConnect";
import { startMetaAdsConnect } from "./MetaAdsConnectButton";
import { startGoogleAdsConnect } from "./GoogleAdsConnectButton";
import { startGoogleAnalyticsConnect } from "./GoogleAnalyticsConnectButton";
import { startGoogleSearchConsoleConnect } from "./GoogleSearchConsoleConnectButton";
import {
  startGoogleCalendarConnect,
  startGoogleSheetsConnect,
} from "./GoogleWorkspaceConnect";

const OAUTH_LAUNCHERS: Readonly<Record<string, () => Promise<void>>> = {
  meta_ads: startMetaAdsConnect,
  google_ads: startGoogleAdsConnect,
  google_analytics: startGoogleAnalyticsConnect,
  google_search_console: startGoogleSearchConsoleConnect,
  google_calendar: startGoogleCalendarConnect,
  google_sheets: startGoogleSheetsConnect,
  instagram_social: () => startRailConnect("instagram", "instagram_social"),
  reddit_social: () => startRailConnect("reddit", "reddit_social"),
  tiktok_ads: () => startRailConnect("tiktok_ads", "tiktok_ads"),
  reddit_ads: () => startRailConnect("reddit_ads", "reddit_ads"),
};

export function startRailConnect(toolkit: string, nativeSlug: string): Promise<void> {
  return railFor(toolkit) === "composio" ? startComposioConnect(toolkit) : startConnectFlow(nativeSlug);
}

export function startSettingsConnect(slug: string): Promise<void> {
  const launcher = OAUTH_LAUNCHERS[slug];
  return launcher ? launcher() : startConnectFlow(slug);
}

const PIPEDREAM_TO_COMPOSIO: Readonly<Record<string, () => Promise<void>>> = {
  instagram_business: () => startRailConnect("instagram", "instagram_social"),
  youtube_data_api: () => startComposioConnect("youtube"),
  youtube_analytics_api: () => startComposioConnect("youtube"),
};

export async function launchConnect(slug: string, info: ConnectInfo): Promise<void> {
  if (info.connect === "key_form") {
    window.location.href = connectorSettingsPath(info);
    return;
  }
  if (info.connect === "composio") {
    await startComposioConnect(slug.slice("composio.".length));
    return;
  }
  if (info.connect === "pipedream") {
    const app = slug.startsWith("pipedream.") ? slug.slice("pipedream.".length) : slug;
    const twin = Object.hasOwn(PIPEDREAM_TO_COMPOSIO, app) ? PIPEDREAM_TO_COMPOSIO[app] : undefined;
    if (twin) {
      await twin();
      return;
    }
    window.location.href = connectorSettingsPath(info);
    return;
  }
  const launcher = OAUTH_LAUNCHERS[slug];
  if (launcher) {
    await launcher();
    return;
  }
  await startConnectFlow(slug);
}

export type ConnectorListRow = {
  slug: string;
  account_login?: string | null;
  connected_at?: string | null;
  scopes?: readonly string[] | Partial<Record<string, boolean>> | null;
};

export function findConnectorRow(
  rows: readonly ConnectorListRow[],
  slug: string,
): ConnectorListRow | null {
  const slugs = satisfyingSlugs(slug);
  return (
    rows.find(
      (r) =>
        slugs.includes(r.slug) &&
        !(r.slug === "github" && isZaviManagedGithubLogin(r.account_login)),
    ) ?? null
  );
}

export function isRequestSatisfied(
  rows: readonly ConnectorListRow[],
  req: { slug: string; mode: "connect" | "reconnect"; created_at: string },
): boolean {
  const row = findConnectorRow(rows, req.slug);
  if (!row) return false;
  if (req.mode === "connect") return true;
  const at = row.connected_at ? Date.parse(row.connected_at) : NaN;
  const asked = Date.parse(req.created_at);
  return Number.isFinite(at) && Number.isFinite(asked) && at > asked;
}
