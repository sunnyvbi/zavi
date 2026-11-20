"use client";

import { AdSpendReadError } from "./settings/AdSpendReadError";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { isZaviManagedGithubLogin } from "./build/existingProduct";
import { useSearchParams } from "next/navigation";
import { createBrowserSupabase } from "@/lib/supabase";
import {
  getActiveTenantId,
  clearActiveTenantCache,
} from "@/lib/active-tenant-client";
import { apiFetch } from "@/lib/api";
import { startConnectFlow } from "@/app/connectors/ConnectButton";
import { startRailConnect, startSettingsConnect } from "@/app/connectors/connectStrategies";
import { startMetaAdsConnect } from "@/app/connectors/MetaAdsConnectButton";
import { startGoogleAdsConnect } from "@/app/connectors/GoogleAdsConnectButton";
import { startHiggsfieldConnect } from "@/app/connectors/HiggsfieldConnectButton";
import { startGoogleAnalyticsConnect } from "@/app/connectors/GoogleAnalyticsConnectButton";
import { startGoogleSearchConsoleConnect } from "@/app/connectors/GoogleSearchConsoleConnectButton";
import { DatabaseCard } from "./settings/database/DatabaseCard";
import { PhoneBindForm } from "@/app/connectors/PhoneBindForm";
import { PhoneHandsetsDialog } from "@/app/connectors/PhoneHandsetsDialog";
import { isPhoneSurface } from "@/app/connectors/phoneSurfaces";
import { TelegramForm } from "@/app/connectors/TelegramConnectButton";
import { DiscordForm } from "@/app/connectors/DiscordConnectButton";
import { PosthogForm } from "@/app/connectors/PosthogConnectForm";
import { HiggsfieldForm } from "@/app/connectors/HiggsfieldConnectForm";
import { SentryForm } from "@/app/connectors/SentryConnectForm";
import { AppleAdsForm } from "@/app/connectors/AppleAdsConnectForm";
import { adConnectorRows } from "./settings/adConnectorRows";
import { SendgridKeyForm } from "./settings/SendgridKeyForm";
import { sendgridCampaignReady } from "@zavi/shared";
import { FigmaForm } from "@/app/connectors/FigmaConnectForm";
import { SupabaseForm } from "@/app/connectors/SupabaseConnectForm";
import {
  startGoogleCalendarConnect,
  startGoogleSheetsConnect,
} from "@/app/connectors/GoogleWorkspaceConnect";
import { StripeForm } from "@/app/connectors/StripeConnectButton";
import {
  SocialConnectForm,
  SocialConnectionsList,
} from "@/app/connectors/SocialConnectButton";
import { ComposioApps, useComposioApps } from "@/app/connectors/ComposioApps";
import {
  ConnectedAppTiles,
  disconnectConnectedApp,
  isNativeFoldedSlug,
  matchesAppQuery,
  composioErrorNotice,
  connectFailureNotice,
  prettyAppName,
  useConnectedApps,
  visibleConnectedRows,
} from "./settings/ConnectedApps";
import { AgentsDirectory } from "./AgentsDirectory";
import { TeamRosterCard } from "./TeamRosterCard";
import { AgentInboxAddresses } from "./AgentInboxAddresses";
import { SettingsSubNav } from "./SettingsSubNav";
import { WorkspaceMembersPanel } from "./WorkspaceMembersPanel";
import {
  SkeletonConnectorGrid,
  SkeletonConnectorTile,
  SkeletonListCard,
} from "./Skeleton";
import { useWorkspace } from "./WorkspaceShell";
import { useOpenStatic } from "./layout/shared";
import { isMember, isOwner } from "@/lib/members";
import { SlackWorkspacesPanel } from "./SlackWorkspacesPanel";
import { CompanyFactsPanel } from "./CompanyFactsPanel";
import { AccountSecurityPanel } from "@/components/account/AccountSecurityPanel";
import { DocumentsSection } from "./personalization/DocumentsSection";
import { ImportedKnowledgeSection } from "./personalization/ImportedKnowledgeSection";
import { DataNotesPanel } from "./settings/DataNotesPanel";
import { NotificationsPanel } from "./settings/NotificationsPanel";
import { EmailAllowlistPanel } from "./settings/EmailAllowlistPanel";
import { RulesPanel } from "./settings/RulesPanel";
import { McpClientsPanel } from "./settings/McpClientsPanel";
import { PLANS_HASH, isUpgradeHash } from "@/lib/workspace/pendingPlan";
import { BillingCreditsPanel } from "./settings/BillingCreditsPanel";
import { FeedbackPanel } from "./settings/FeedbackPanel";
import { TeamNoteSuggestionsToggle } from "./settings/TeamNoteSuggestionsToggle";
import { CONNECTOR_ICON } from "./settings/connectorLogos";
import {
  canDisconnect,
  disconnectConnector,
} from "./settings/connectorDisconnect";
import { chatConnectorRows } from "./settings/chatConnectorRows";
import { handsetsLabel, usePhoneHandsets } from "./settings/usePhoneHandsets";
import { ConnectorLockup } from "./settings/ConnectorTile";
import {
  BookOpenIcon,
  LinkSquareIcon,
  LockIcon,
  GlobeIcon,
  FilterIcon,
  BranchIcon,
  ChevronDownIcon,
} from "./settings/githubIcons";
import {
  Banner,
  ConnectorTile,
  TileButton,
  TileMenu,
} from "./settings/ConnectorTile";
import {
  CategorySections,
  INTEGRATION_GRID,
  type CatalogItem,
} from "./settings/CategorySection";
import { NATIVE_CATEGORY, categoryOf } from "./settings/connectorCategories";
import { purposeFor } from "./settings/connectorCopy";
import {
  connectionState,
  needsReconnect,
  resolveRowHealth,
  type ConnectorHealth,
} from "./settings/connectorHealth";
import { ReconnectTile } from "./settings/ReconnectTile";
import { useAdReadFailures, readFailedReason, readSlowReason } from "./settings/useAdReadFailures";
import { useEmailToolIssues, emailToolIssueReason, EMAIL_TOOL_ISSUE_STATUS, KEY_TOOLS, type EmailToolIssue } from "./settings/useEmailToolIssues";
import { startComposioConnect } from "@/app/connectors/composioConnect";
import { useConnectorRecommendations } from "./settings/useConnectorRecommendations";
import { useSlackScopeStatus } from "./settings/useSlackScopeStatus";
import { syncLine, useConnectorSyncStatus } from "./settings/useConnectorSyncStatus";
import { ReportingTimezonePanel } from "./settings/ReportingTimezonePanel";
import {
  ConnectorErrorHost,
  showConnectorError,
} from "./settings/connectorErrorDialog";

const ALL_SECTIONS = [
  { id: "company", label: "Company" },
  { id: "personalization", label: "Personalization" },
  { id: "reporting", label: "Reporting" },
  { id: "rules", label: "Rules" },
  { id: "integration", label: "Integrations" },
  { id: "notifications", label: "Notifications" },
  { id: "email", label: "Email" },
  { id: "ai-clients", label: "MCP" },
  { id: "team", label: "Members" },
  { id: "billing", label: "Billing & Credits" },
  { id: "account", label: "Account" },
  { id: "feedback", label: "Feedback" },
] as const;

type SectionId = (typeof ALL_SECTIONS)[number]["id"];

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export function settingsSectionFromParam(
  raw: string | null | undefined,
  sections: ReadonlyArray<(typeof ALL_SECTIONS)[number]>,
): SectionId | null {
  const wanted = slug(raw ?? "");
  if (!wanted) return null;
  const match = sections.find((sec) => sec.id === wanted) ?? sections.find((sec) => slug(sec.label) === wanted);
  return match ? match.id : null;
}

export function settingsSectionsFor(
  readOnly: boolean,
): ReadonlyArray<(typeof ALL_SECTIONS)[number]> {
  if (!readOnly) return ALL_SECTIONS;
  return ALL_SECTIONS.filter(
    (s) =>
      s.id === "company" ||
      s.id === "personalization" ||
      s.id === "reporting" ||
      s.id === "rules" ||
      s.id === "integration" ||
      s.id === "team" ||
      s.id === "email" ||
      s.id === "feedback" ||
      s.id === "account",
  );
}

type Slug =
  | "slack"
  | "github"
  | "meta_ads"
  | "google_ads"
  | "linkedin_ads"
  | "google_analytics"
  | "google_search_console"
  | "operator_db"
  | "jira"
  | "stripe"
  | "linear"
  | "intercom"
  | "linkedin_social"
  | "x_social"
  | "reddit_social"
  | "instagram_social"
  | "posthog"
  | "higgsfield"
  | "sentry"
  | "figma"
  | "supabase"
  | "google_calendar"
  | "google_sheets"
  | "whatsapp"
  | "imessage"
  | "telegram"
  | "discord"
  | "tiktok"
  | "x_ads"
  | "tiktok_ads"
  | "reddit_ads"
  | "snapchat_ads"
  | "spotify_ads"
  | "pinterest_ads"
  | "microsoft_ads"
  | "apple_ads"
  | "email";

type DbType = "postgres" | "mongodb" | "mysql" | "dynamodb";

type ConnectorRow = {
  slug: Slug;
  connected: boolean;
  team_name?: string;
  account_login?: string;
  repo_count?: number;
  repo_full_names?: string[];
  repo_ids?: number[];
  repo_private?: boolean[];
  account_type?: string;
  default_repo_full_name?: string;
  repo_default_branches?: Record<string, string>;
  selected_repo_ids?: number[] | null;
  ad_account_id?: string;
  db_type?: DbType;
  managed_by?: string;
  connected_at?: string;
  token_expires_at?: string;
  health?: ConnectorHealth;
  campaign_ready?: boolean;
  read_failed?: boolean;
  read_failed_since?: string;
  read_slow?: boolean;
  tool_issue?: EmailToolIssue;
  source_slug?: string;
  source_slugs?: string[];
};

const LABELS: Record<Slug, string> = {
  slack: "Slack",
  whatsapp: "WhatsApp",
  imessage: "iMessage",
  telegram: "Telegram",
  discord: "Discord",
  github: "GitHub",
  meta_ads: "Meta Ads",
  google_ads: "Google Ads",
  linkedin_ads: "LinkedIn Ads",
  google_analytics: "Google Analytics",
  google_search_console: "Google Search Console",
  operator_db: "Your database",
  jira: "Jira",
  stripe: "Stripe",
  posthog: "PostHog",
  higgsfield: "Higgsfield",
  sentry: "Sentry",
  figma: "Figma",
  supabase: "Supabase",
  google_calendar: "Google Calendar",
  google_sheets: "Google Sheets",
  linear: "Linear",
  intercom: "Intercom",
  linkedin_social: "LinkedIn",
  x_social: "X (Twitter)",
  reddit_social: "Reddit",
  instagram_social: "Instagram",
  tiktok: "TikTok",
  x_ads: "X Ads",
  tiktok_ads: "TikTok Ads",
  reddit_ads: "Reddit Ads",
  snapchat_ads: "Snapchat Ads",
  spotify_ads: "Spotify Ads",
  pinterest_ads: "Pinterest Ads",
  microsoft_ads: "Microsoft Ads",
  apple_ads: "Apple Search Ads",
  email: "SendGrid",
};
export { LABELS as CONNECTOR_TILE_LABELS };

const PLACEHOLDER_COPY: Record<Slug, string> = {
  slack: "Read channels and messages. Pick which once connected.",
  whatsapp:
    "Message your agents from WhatsApp. Connecting takes two steps: send the pre-filled message, then enter the code it replies with.",
  imessage:
    "Text your agents from iMessage. Connecting takes two steps: send the pre-filled text, then enter the code it replies with.",
  telegram:
    "Message your agents from Telegram. Get a connect link here, tap it in Telegram from the account or group you want linked.",
  discord:
    "Message your agents from Discord. Add the bot to your server, then post the one-time connect code you get here. @mention the bot with a task.",
  github: "Install the Praxis GitHub App so engineer can read repos and open PRs.",
  meta_ads:
    "Connect Facebook + Instagram ad accounts so performance-marketer can read campaigns and propose reallocations.",
  google_ads:
    "Connect Google Ads so performance-marketer can read campaigns + spend and propose reallocations.",
  linkedin_ads:
    "Connect LinkedIn Ads so the LinkedIn Ads channel can read your campaigns, spend, and results. Read-only: no changes are made to your account.",
  google_analytics:
    "Connect Google Analytics so performance-marketer can read GA4 traffic and conversions by source. Read-only: no changes are made to your Analytics.",
  google_search_console:
    "Connect Google Search Console so seo-geo can read real clicks, impressions, CTR, and rankings by query and page. Read-only.",
  operator_db:
    "Connect your company DB (Postgres / MongoDB / MySQL) so agents can read listings, users, and transactions.",
  jira: "Connect Jira so pm, engineer, and qa get product + engineering context from your Atlassian site.",
  stripe:
    "Paste a restricted Stripe key so operator, dispute-response, and chief-of-staff can read charges, payouts, and disputes.",
  posthog:
    "Paste a PostHog API key so growth, pm, and operator can answer funnel, activation, and retention questions from your real product events. Read-only.",
  higgsfield:
    "Paste a Higgsfield access token so the Generated video channel can stage creator-style videos (reviews, unboxings, try-ons) for your approval. Generation runs on your Higgsfield account and spends your credits, and only after you approve a specific video.",
  tiktok:
    "Connect TikTok to schedule, publish, and analyze organic videos and photo posts with explicit approval.",
  x_ads:
    "Connect your X Ads account so Zavi can read campaign spend and conversions. Pausing, editing or launching a campaign always waits for your approval.",
  email:
    "Paste a SendGrid API key so Zavi can send one-to-one email and, with the campaign permissions, email campaigns you approve. Zavi checks every permission before saving.",
  linear:
    "Connect Linear so engineer, pm, and operator get issue + project context. Creating/updating issues is approval-gated.",
  sentry:
    "Paste a Sentry org auth token so engineer and qa can read issues, events, and error volume when they investigate a regression. Read-only.",
  figma:
    "Paste a Figma personal access token so pm and engineer can read design files and projects. Read-only: nothing is edited or commented on.",
  supabase:
    "Paste a Supabase personal access token so agents can read project metadata, edge functions, and analytics for one project you pick. Read-only.",
  google_calendar:
    "Connect Google Calendar so chief-of-staff and pm know what your week actually looks like. Read-only: no events are created or changed.",
  google_sheets:
    "Connect Google Sheets so agents can read spreadsheets the connected Google account can open. Read-only: nothing is written back.",
  intercom:
    "Connect Intercom so support-lead and dispute-response can read your customer support conversations as evidence. Read-only: no replies are sent.",
  linkedin_social:
    "Connect your LinkedIn profile so approved posts publish there directly. Nothing posts without your approval. LinkedIn tokens last 60 days, then you'll be asked to reconnect.",
  x_social:
    "Connect your X account so approved posts publish there directly. Nothing posts without your approval. X charges per post to Zavi's developer app.",
  reddit_social:
    "Connect your Reddit account so approved text posts publish to a subreddit you name. Nothing posts without your approval. Mind each subreddit's self-promotion rules.",
  instagram_social:
    "Connect your Instagram Business or Creator account (linked to a Facebook Page) so approved image posts publish there directly and Zavi can read your post insights. Nothing posts without your approval.",
  tiktok_ads:
    "Connect your TikTok Ads account so Zavi can read campaign spend and results, and count them against your ad budget. Changes to campaigns always wait for your approval.",
  reddit_ads:
    "Connect your Reddit Ads account so Zavi can read campaign spend and results, and count them against your ad budget. Changes to campaigns always wait for your approval.",
  snapchat_ads:
    "Connect your Snapchat Ads account so Zavi can read campaign spend and results, and count them against your ad budget. Read-only: no changes are made to your account.",
  spotify_ads:
    "Connect your Spotify Ads account so Zavi can read campaign spend and results, and count them against your ad budget. Read-only: no changes are made to your account.",
  pinterest_ads:
    "Connect your Pinterest Ads account so Zavi can read campaign spend and results, and count them against your ad budget. Read-only: no changes are made to your account.",
  microsoft_ads:
    "Connect your Microsoft Ads account so Zavi can read campaign spend and results, and count them against your ad budget. Read-only: no changes are made to your account.",
  apple_ads:
    "Paste your Apple Search Ads API credentials so Zavi can read campaign spend and results, and count them against your ad budget. Read-only: no changes are made to your account.",
};

function stripeDetail(
  teamName: string | undefined,
  accountLogin: string | undefined,
): string {
  const isMeaningful = (v: string | undefined): v is string => {
    const t = (v ?? "").trim();
    return t.length > 0 && t.toLowerCase() !== "unknown";
  };
  if (isMeaningful(teamName)) return teamName;
  if (isMeaningful(accountLogin)) return accountLogin;
  return "-";
}

const RICH_SLUGS: Slug[] = ["slack", "github"];

export const DEFAULT_FOR_YOU_SLUGS: Slug[] = [
  "slack",
  "github",
  "telegram",
  "discord",
  "meta_ads",
  "google_ads",
  "linkedin_ads",
  "google_analytics",
  "google_search_console",
  "posthog",
  "stripe",
  "jira",
  "linear",
  "intercom",
  "linkedin_social",
  "x_social",
  "reddit_social",
  "instagram_social",
  "tiktok",
];

export const FOR_YOU_CAP = 6;

export function partitionConnectorRows(
  rows: ConnectorRow[],
  query: string,
  forYouSlugs: readonly string[] = DEFAULT_FOR_YOU_SLUGS,
  forYouCap: number = FOR_YOU_CAP,
) {
  const q = query.trim().toLowerCase();
  const matches = (row: ConnectorRow) =>
    !q ||
    LABELS[row.slug].toLowerCase().includes(q) ||
    row.slug.toLowerCase().includes(q);
  const visible = rows.filter(matches);
  const richFirst = (a: ConnectorRow, b: ConnectorRow) =>
    Number(RICH_SLUGS.includes(b.slug)) - Number(RICH_SLUGS.includes(a.slug));

  const needs = visible.filter((r) => r.connected && (needsReconnect(r.health) || r.read_failed || r.read_slow || r.tool_issue));
  const connected = visible
    .filter((r) => r.connected && !needsReconnect(r.health) && !r.read_failed && !r.read_slow && !r.tool_issue)
    .sort(richFirst);
  const notConnected = visible.filter((r) => !r.connected);
  const forYou: ConnectorRow[] = [];
  for (const slug of forYouSlugs) {
    if (forYou.length >= forYouCap) break;
    const row = notConnected.find((r) => r.slug === slug);
    if (row && !forYou.includes(row)) forYou.push(row);
  }
  const rest = notConnected.filter((r) => !forYou.includes(r));

  return { needsReconnect: needs, connected, forYou, rest };
}

function sourceSlugs(list: Array<{ slug: string }>, slugs: string[]): string[] | undefined {
  const hit = slugs.filter((s) => list.some((r) => r.slug === s));
  return hit.length ? hit : undefined;
}

export function buildSettingsRows(
  rawList: Array<{
    slug: string;
    team_id: string | null;
    team_name: string | null;
    account_login: string | null;
    account_type?: string | null;
    repo_full_names: string[] | null;
    repo_ids: number[] | null;
    repo_private?: boolean[] | null;
    selected_repo_ids: number[] | null;
    default_repo_full_name: string | null;
    repo_default_branches?: Record<string, string> | null;
    managed_by?: string | null;
    scopes?: string[] | null;
    connected_at: string | null;
    token_expires_at: string | null;
  }>,
): ConnectorRow[] {
  const list = visibleConnectedRows(rawList);
  const github = list.find((r) => r.slug === "github");
  const metaAds = list.find((r) => r.slug === "meta_ads");
  const googleAds = list.find((r) => r.slug === "google_ads");
  const googleAnalytics = list.find((r) => r.slug === "google_analytics");
  const googleSearchConsole = list.find((r) => r.slug === "google_search_console");
  const operatorDb = list.find((r) => r.slug === "operator_db");
  const jira = list.find((r) => r.slug === "jira");
  const stripe = list.find((r) => r.slug === "stripe");
  const linear = list.find((r) => r.slug === "linear");
  const intercom = list.find((r) => r.slug === "intercom");
  const linkedinSocial = list.find((r) => r.slug === "linkedin_social");
  const xSocial = list.find((r) => r.slug === "x_social");
  const redditSocial =
    list.find((r) => r.slug === "reddit_social") ??
    list.find((r) => r.slug === "composio.reddit");
  const instagramSocial =
    list.find((r) => r.slug === "instagram_social") ??
    list.find((r) => r.slug === "composio.instagram");
  const higgsfield = list.find((r) => r.slug === "higgsfield");
  const posthogRow = list.find((r) => r.slug === "posthog");
  const sentry = list.find((r) => r.slug === "sentry");
  const figma = list.find((r) => r.slug === "figma");
  const supabaseConn = list.find((r) => r.slug === "supabase");
  const googleCalendar = list.find((r) => r.slug === "google_calendar");
  const googleSheets = list.find((r) => r.slug === "google_sheets");
  const tiktok = list.find((r) => r.slug === "tiktok");
  const email = list.find((r) => r.slug === "email");
  return [
    ...chatConnectorRows(list),
    {
      slug: "github",
      connected: !!github,
      account_login: github?.account_login ?? undefined,
      account_type: github?.account_type ?? undefined,
      repo_count: (github?.repo_full_names ?? []).length,
      repo_full_names: github?.repo_full_names ?? undefined,
      repo_ids: github?.repo_ids ?? undefined,
      repo_private: github?.repo_private ?? undefined,
      selected_repo_ids: github?.selected_repo_ids ?? null,
      default_repo_full_name: github?.default_repo_full_name ?? undefined,
      repo_default_branches: github?.repo_default_branches ?? undefined,
      connected_at: github?.connected_at ?? undefined,
    },
    {
      slug: "meta_ads",
      connected: !!metaAds,
      ad_account_id: metaAds?.team_id ?? undefined,
      connected_at: metaAds?.connected_at ?? undefined,
      token_expires_at: metaAds?.token_expires_at ?? undefined,
    },
    {
      slug: "google_ads",
      connected: !!googleAds,
      ad_account_id: googleAds?.team_id ?? undefined,
      connected_at: googleAds?.connected_at ?? undefined,
      token_expires_at: googleAds?.token_expires_at ?? undefined,
    },
    ...adConnectorRows(rawList),
    {
      slug: "google_analytics",
      connected: !!googleAnalytics,
      ad_account_id: googleAnalytics?.team_id ?? undefined,
      connected_at: googleAnalytics?.connected_at ?? undefined,
    },
    {
      slug: "google_search_console",
      connected: !!googleSearchConsole,
      ad_account_id: googleSearchConsole?.team_id ?? undefined,
      connected_at: googleSearchConsole?.connected_at ?? undefined,
    },
    {
      slug: "operator_db",
      connected: !!operatorDb,
      db_type: (operatorDb?.team_id ?? undefined) as DbType | undefined,
      connected_at: operatorDb?.connected_at ?? undefined,
      managed_by: operatorDb?.managed_by ?? undefined,
    },
    {
      slug: "jira",
      connected: !!jira,
      team_name: jira?.team_name ?? undefined,
      connected_at: jira?.connected_at ?? undefined,
    },
    {
      slug: "stripe",
      connected: !!stripe,
      account_login: stripe?.team_id ?? undefined,
      team_name: stripe?.team_name ?? undefined,
      connected_at: stripe?.connected_at ?? undefined,
    },
    {
      slug: "linear",
      connected: !!linear,
      team_name: linear?.team_name ?? undefined,
      connected_at: linear?.connected_at ?? undefined,
    },
    {
      slug: "linkedin_social",
      connected: !!linkedinSocial,
      team_name: linkedinSocial?.team_name ?? undefined,
      connected_at: linkedinSocial?.connected_at ?? undefined,
      token_expires_at: linkedinSocial?.token_expires_at ?? undefined,
    },
    {
      slug: "x_social",
      connected: !!xSocial,
      team_name: xSocial?.team_name ?? undefined,
      connected_at: xSocial?.connected_at ?? undefined,
    },
    {
      slug: "reddit_social",
      connected: !!redditSocial,
      team_name: redditSocial?.team_name ?? undefined,
      connected_at: redditSocial?.connected_at ?? undefined,
      source_slugs: sourceSlugs(list, ["reddit_social", "composio.reddit"]),
    },
    {
      slug: "instagram_social",
      connected: !!instagramSocial,
      team_name: instagramSocial?.team_name ?? undefined,
      connected_at: instagramSocial?.connected_at ?? undefined,
      source_slugs: sourceSlugs(list, ["instagram_social", "composio.instagram"]),
    },
    {
      slug: "higgsfield",
      connected: !!higgsfield,
      team_name: higgsfield?.team_name ?? undefined,
      connected_at: higgsfield?.connected_at ?? undefined,
    },
    {
      slug: "posthog",
      connected: !!posthogRow,
      team_name: posthogRow?.team_name ?? undefined,
      connected_at: posthogRow?.connected_at ?? undefined,
    },
    {
      slug: "sentry",
      connected: !!sentry,
      team_name: sentry?.team_id ?? undefined,
      connected_at: sentry?.connected_at ?? undefined,
    },
    {
      slug: "figma",
      connected: !!figma,
      team_name: figma?.team_name ?? undefined,
      connected_at: figma?.connected_at ?? undefined,
    },
    {
      slug: "supabase",
      connected: !!supabaseConn,
      team_name: supabaseConn?.team_name ?? undefined,
      connected_at: supabaseConn?.connected_at ?? undefined,
    },
    {
      slug: "google_calendar",
      connected: !!googleCalendar,
      ad_account_id: googleCalendar?.team_id ?? undefined,
      connected_at: googleCalendar?.connected_at ?? undefined,
    },
    {
      slug: "google_sheets",
      connected: !!googleSheets,
      connected_at: googleSheets?.connected_at ?? undefined,
    },
    {
      slug: "intercom",
      connected: !!intercom,
      team_name: intercom?.team_name ?? undefined,
      connected_at: intercom?.connected_at ?? undefined,
    },
    {
      slug: "tiktok",
      connected: !!tiktok,
      account_login: tiktok?.team_id ?? undefined,
      connected_at: tiktok?.connected_at ?? undefined,
    },
    {
      slug: "email",
      connected: !!email,
      campaign_ready: sendgridCampaignReady(email?.scopes ?? null),
      connected_at: email?.connected_at ?? undefined,
    },
  ];
}

export function SettingsTab({
  modal,
  only,
  initialSection,
  sectionRequestedAt,
}: {
  modal?: boolean;
  only?: SectionId;
  initialSection?: SectionId;
  sectionRequestedAt?: number;
} = {}) {
  const [rows, setRows] = useState<ConnectorRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [githubLimitOpen, setGithubLimitOpen] = useState(false);
  const [activeIdState, setActiveId] = useState<SectionId>(
    only ?? initialSection ?? (modal ? "company" : "company"),
  );
  const [usageDeepLink, setUsageDeepLink] = useState(false);
  const [billingNonce, setBillingNonce] = useState(0);
  const [billingFullPage, setBillingFullPage] = useState(false);
  const [billingWidePage, setBillingWidePage] = useState(false);
  const onBillingFullPage = useCallback((open: boolean, view?: "upgrade" | "usage") => {
    setBillingFullPage(open);
    setBillingWidePage(open && view === "upgrade");
  }, []);
  const activeId = only ?? activeIdState;
  const [highlightedSlug, setHighlightedSlug] = useState<Slug | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchParams = useSearchParams();
  const [connectorQuery, setConnectorQuery] = useState(
    () => searchParams.get("q") ?? "",
  );
  const connectorSearchRef = useRef<HTMLInputElement>(null);
  const sectionParam = searchParams.get("section");
  const { role, currentUserId, tenantId } = useWorkspace();
  const openStatic = useOpenStatic();
  const readOnly = isMember(role);
  const sections = settingsSectionsFor(readOnly);
  useEffect(() => {
    if (!sectionParam || only) return;
    const wanted = settingsSectionFromParam(sectionParam, sections);
    if (wanted) setActiveId(wanted);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `sections` is derived from readOnly
  }, [sectionParam, only, readOnly]);
  const mountedAt = useRef(Date.now());
  useEffect(() => {
    if (!sectionRequestedAt || sectionRequestedAt < mountedAt.current) return;
    if (!initialSection || only) return;
    const wanted = settingsSectionFromParam(initialSection, sections);
    if (wanted) selectSection(wanted);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- follow the request only, not role changes
  }, [initialSection, sectionRequestedAt, only]);

  const visibleSections = only
    ? sections.filter((sec) => sec.id === only)
    : sections.filter((sec) => sec.id !== "integration");

  const justConnected: Partial<Record<Slug, boolean>> = {
    slack: searchParams.get("slack") === "connected",
    github: searchParams.get("github") === "connected",
    meta_ads: searchParams.get("meta_ads") === "connected",
    google_ads: searchParams.get("google_ads") === "connected",
    linkedin_ads: searchParams.get("linkedin_ads") === "connected",
    google_analytics: searchParams.get("google_analytics") === "connected",
    google_search_console: searchParams.get("google_search_console") === "connected",
    operator_db: searchParams.get("operator_db") === "connected",
    jira: searchParams.get("jira") === "connected",
    stripe: searchParams.get("stripe") === "connected",
    linear: searchParams.get("linear") === "connected",
    google_calendar: searchParams.get("google_calendar") === "connected",
    google_sheets: searchParams.get("google_sheets") === "connected",
    intercom: searchParams.get("intercom") === "connected",
    linkedin_social: searchParams.get("linkedin_social") === "connected",
    x_social: searchParams.get("x_social") === "connected",
    reddit_social: searchParams.get("reddit_social") === "connected",
    instagram_social: searchParams.get("instagram_social") === "connected",
    tiktok: searchParams.get("tiktok") === "connected",
    x_ads: searchParams.get("x_ads") === "connected",
    tiktok_ads: searchParams.get("tiktok_ads") === "connected",
    reddit_ads: searchParams.get("reddit_ads") === "connected",
    snapchat_ads: searchParams.get("snapchat_ads") === "connected",
    spotify_ads: searchParams.get("spotify_ads") === "connected",
    pinterest_ads: searchParams.get("pinterest_ads") === "connected",
    microsoft_ads: searchParams.get("microsoft_ads") === "connected",
    apple_ads: searchParams.get("apple_ads") === "connected",
  };

  const {
    apps: connectedApps,
    loading: connectedAppsLoading,
    removeApp: removeConnectedApp,
  } = useConnectedApps(reloadKey);
  const composio = useComposioApps(reloadKey);
  const [composioErrorDismissed, setComposioErrorDismissed] = useState(false);
  const composioErrorSlug = searchParams.get("composio_error");
  const composioError =
    composioErrorSlug && !composioErrorDismissed
      ? composioErrorSlug === "unknown"
        ? "the app"
        : (composio.toolkits ?? []).find((t) => t.slug === composioErrorSlug)?.name ??
          prettyAppName(composioErrorSlug)
      : null;
  const [connectFailureDismissed, setConnectFailureDismissed] = useState(false);
  const connectFailure = connectFailureNotice(searchParams, connectFailureDismissed);
  const recommendedSlugs = useConnectorRecommendations(reloadKey);
  const slackConnected = rows.some((r) => r.slug === "slack" && r.connected);
  const slackMissingScopes = useSlackScopeStatus(slackConnected, reloadKey);
  const connectorSync = useConnectorSyncStatus(reloadKey);
  const adRead = useAdReadFailures(reloadKey);
  const { issues: emailIssues, checking: emailChecking, failed: emailReadFailed } = useEmailToolIssues(
    rows.some((r) => r.slug === "email" && r.connected) ||
      connectedApps.some((a) => a.app === "klaviyo" || a.app === "mailchimp"),
    reloadKey,
  );
  const rowsWithHealth = useMemo(
    () =>
      rows.map((r) => {
        const since = r.connected ? adRead.failed[r.slug] : undefined;
        const slow = r.connected && !since && !!adRead.slow[r.slug];
        const toolIssue = r.connected && r.slug === "email" ? emailIssues.get("sendgrid") : undefined;
        return {
          ...r,
          health: resolveRowHealth(r, slackMissingScopes),
          ...(since ? { read_failed: true, read_failed_since: since } : {}),
          ...(slow ? { read_slow: true } : {}),
          ...(toolIssue ? { tool_issue: toolIssue } : {}),
        };
      }),
    [rows, slackMissingScopes, adRead.failed, adRead.slow, emailIssues],
  );
  const [stripAppleOpen, setStripAppleOpen] = useState(false);
  const [stripSendgridOpen, setStripSendgridOpen] = useState(false);
  const stripSendgridSaved = useRef(false);
  const attentionRows = useMemo(
    () => rowsWithHealth.filter((r) => r.connected && (needsReconnect(r.health) || r.read_failed || r.read_slow || r.tool_issue)),
    [rowsWithHealth],
  );
  const attentionApps = useMemo(
    () => connectedApps.filter((a) => !isNativeFoldedSlug(a.slug) && emailIssues.has(a.app)),
    [connectedApps, emailIssues],
  );

  const onAggregatorRemoved = useCallback(
    (slug: string) => {
      removeConnectedApp(slug);
      setReloadKey((k) => k + 1);
    },
    [removeConnectedApp],
  );

  const isValidSectionId = (id: string): id is SectionId =>
    (ALL_SECTIONS as readonly { id: string }[]).some((s) => s.id === id);

  const isVisibleSection = (id: SectionId): boolean =>
    (sections as readonly { id: SectionId }[]).some((s) => s.id === id);
  useEffect(() => {
    if (!only && !isVisibleSection(activeIdState)) setActiveId("company");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sections derive from readOnly
  }, [activeIdState, readOnly, only]);

  const scrollContainerToTop = () => {
    let el: HTMLElement | null = rootRef.current;
    while (el) {
      const oy = window.getComputedStyle(el).overflowY;
      if (oy === "auto" || oy === "scroll") {
        el.scrollTop = 0;
        return;
      }
      el = el.parentElement;
    }
  };

  const selectSection = (id: SectionId) => {
    if (id === "billing" && activeId === "billing") setBillingNonce((n) => n + 1);
    setActiveId(id);
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", `#${id}`);
      scrollContainerToTop();
    }
  };

  const jumpToConnector = (slug: string) => {
    if (!(slug in LABELS)) return;
    setConnectorQuery("");
    const typed = slug as Slug;
    setHighlightedSlug(typed);
    requestAnimationFrame(() => {
      const el = document.getElementById(`connector-${typed}`);
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    window.setTimeout(() => setHighlightedSlug(null), 2200);
  };

  const runUsageHash = (raw: string): boolean => {
    if (isUpgradeHash(raw) || raw === PLANS_HASH) {
      if (isVisibleSection("billing")) setActiveId("billing");
      return true;
    }
    if (raw !== "billing-usage") return false;
    if (!isVisibleSection("billing")) return true;
    setUsageDeepLink(true);
    setActiveId("billing");
    if (typeof window !== "undefined") scrollContainerToTop();
    return true;
  };

  const runConnectorHashScroll = (raw: string): boolean => {
    if (!raw.startsWith("connector-")) return false;
    const slug = raw.slice("connector-".length);
    if (slug in LABELS) {
      setActiveId("integration");
      let tries = 0;
      const tick = () => {
        if (document.getElementById(`connector-${slug}`)) {
          jumpToConnector(slug);
        } else if (tries++ < 20) {
          window.setTimeout(tick, 100);
        }
      };
      window.setTimeout(tick, 50);
    }
    return true;
  };

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (new URLSearchParams(window.location.search).has("teams_bind")) {
      openStatic("meet");
      return;
    }
    const raw = window.location.hash.replace(/^#/, "");
    if (!raw) return;
    if (runConnectorHashScroll(raw)) return;
    if (runUsageHash(raw)) return;
    const hashSection = settingsSectionFromParam(raw, sections);
    if (hashSection) selectSection(hashSection);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onHash = () => {
      const raw = window.location.hash.replace(/^#/, "");
      if (runConnectorHashScroll(raw)) return;
      if (runUsageHash(raw)) return;
      const hashSection = settingsSectionFromParam(raw, sections);
      if (hashSection) selectSection(hashSection);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly, loading]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoadError(false);
        const sb = createBrowserSupabase();
        const tenantId = await getActiveTenantId(sb);
        if (cancelled) return;
        if (!tenantId) {
          setLoadError(true);
          setLoading(false);
          return;
        }
        const FULL_COLS =
          "slug, team_id, team_name, account_login, account_type, repo_full_names, repo_ids, repo_private, selected_repo_ids, default_repo_full_name, repo_default_branches, connected_at, token_expires_at, managed_by, scopes";
        const BASE_COLS =
          "slug, team_id, team_name, account_login, repo_full_names, repo_ids, selected_repo_ids, default_repo_full_name, connected_at, token_expires_at";
        const full = await sb
          .from("connector_metadata")
          .select(FULL_COLS)
          .eq("tenant_id", tenantId);
        const res = full.error
          ? await sb.from("connector_metadata").select(BASE_COLS).eq("tenant_id", tenantId)
          : full;
        const data = res.data as unknown[] | null;
        const error = res.error;
        if (cancelled) return;
        if (error) {
          setLoadError(true);
          setLoading(false);
          return;
        }
        const rawList = (data ?? []) as Array<{
          slug: string;
          team_id: string | null;
          team_name: string | null;
          account_login: string | null;
          account_type?: string | null;
          repo_full_names: string[] | null;
          repo_ids: number[] | null;
          repo_private?: boolean[] | null;
          selected_repo_ids: number[] | null;
          default_repo_full_name: string | null;
          repo_default_branches?: Record<string, string> | null;
          managed_by?: string | null;
          scopes?: string[] | null;
          connected_at: string | null;
          token_expires_at: string | null;
        }>;
        setRows(buildSettingsRows(rawList));
        setLoading(false);
      } catch {
        if (!cancelled) {
          setLoadError(true);
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const retryConnectorLoad = () => {
    clearActiveTenantCache();
    setLoading(true);
    setLoadError(false);
    setReloadKey((k) => k + 1);
  };

  const onSetDefaultRepo = async (name: string) => {
    const r = await apiFetch("/api/connectors/github/default-repo", {
      method: "POST",
      body: JSON.stringify({ repo_full_name: name }),
    });
    if (!r.ok) {
      const errBody = (await r.json().catch(() => null)) as
        | { error?: { message?: string } }
        | null;
      alert(`Failed to set default: ${errBody?.error?.message ?? r.status}`);
      return;
    }
    setRows((prev) =>
      prev.map((rr) =>
        rr.slug === "github" ? { ...rr, default_repo_full_name: name } : rr,
      ),
    );
  };
  const onSetSelectedRepos = async (ids: number[] | null) => {
    const r =
      ids === null
        ? await apiFetch("/api/connectors/github/selected-repos", {
            method: "DELETE",
          })
        : await apiFetch("/api/connectors/github/selected-repos", {
            method: "POST",
            body: JSON.stringify({ repo_ids: ids }),
          });
    if (!r.ok) {
      const errBody = (await r.json().catch(() => null)) as
        | { error?: { message?: string } }
        | null;
      alert(`Failed to save repo selection: ${errBody?.error?.message ?? r.status}`);
      return;
    }
    setRows((prev) =>
      prev.map((rr) => {
        if (rr.slug !== "github") return rr;
        const pos =
          rr.default_repo_full_name && Array.isArray(rr.repo_full_names)
            ? rr.repo_full_names.indexOf(rr.default_repo_full_name)
            : -1;
        const defaultId =
          pos >= 0 && Array.isArray(rr.repo_ids) ? rr.repo_ids[pos] : undefined;
        const keepsDefault =
          ids === null || (defaultId !== undefined && ids.includes(defaultId));
        return {
          ...rr,
          selected_repo_ids: ids,
          default_repo_full_name: keepsDefault
            ? rr.default_repo_full_name
            : undefined,
        };
      }),
    );
  };

  const onNavSelect = (id: string) => {
    if (isValidSectionId(id) && isVisibleSection(id)) selectSection(id);
  };

  return (
    <div
      className={
        modal
          ? "flex h-full min-h-0 w-full"
          :
            `mx-auto w-full px-8 py-6 compact:px-4 md:flex md:gap-9 ${
              billingWidePage ? "max-w-[1320px]" : "max-w-[1080px]"
            }`
      }
    >
      {}
      {!only && !billingFullPage && (
        <SettingsSubNav
          variant={modal ? "rail" : "default"}
          title="Settings"
          sections={visibleSections as unknown as { id: string; label: string }[]}
          activeId={activeId}
          onSelect={onNavSelect}
        />
      )}

      <div
        ref={rootRef}
        className={
          modal
            ? "min-w-0 flex-1 overflow-y-auto px-6 py-6 md:px-10 md:py-8"
            : "min-w-0 flex-1"
        }
      >
        {modal && !only && !billingFullPage && (
          <SettingsSubNav
            variant="pills"
            sections={visibleSections as unknown as { id: string; label: string }[]}
            activeId={activeId}
            onSelect={onNavSelect}
          />
        )}
        {activeId === "company" && (
        <section id="company" className="mt-1">
          <h2 className="mb-1 text-[16px] font-semibold tracking-tight text-ink">
            Company
          </h2>
          <p className="mb-4 text-[16px] text-inkMuted leading-[1.55]">
            The facts every one of your agents is told about your company. Wrong here means wrong
            in a customer email, an ad, or a chat reply.
          </p>
          <CompanyFactsPanel readOnly={readOnly} />
          <div className="mt-4">
            <DataNotesPanel readOnly={readOnly} />
          </div>
        </section>
        )}

        {activeId === "personalization" && (
        <section id="personalization" className="mt-1">
          <h2 className="mb-1 text-[16px] font-semibold tracking-tight text-ink">
            Personalization
          </h2>
          <p className="mb-4 text-[16px] text-inkMuted leading-[1.55]">
            The files you gave Zavi and the facts it learned from them. You can remove any of them here.
          </p>
          <div className="space-y-5">
            <DocumentsSection readOnly={readOnly} />
            <ImportedKnowledgeSection readOnly={readOnly} />
          </div>
        </section>
        )}

        {activeId === "reporting" && (
        <section id="reporting" className="mt-1">
          <h2 className="mb-1 text-[16px] font-semibold tracking-tight text-ink">
            Reporting
          </h2>
          <p className="mb-4 text-[16px] text-inkMuted leading-[1.55]">
            How Zavi counts days in every number it shows you.
          </p>
          <ReportingTimezonePanel readOnly={readOnly} />
        </section>
        )}

        {activeId === "integration" && (
        <section id="integration" className="mt-1">
          <ConnectorErrorHost />
          <div className="flex flex-col gap-4">
            <h2 className="text-[20px] font-semibold leading-[28px] tracking-tight text-ink">
              Connect Integrations
            </h2>
            <div className="flex h-10 items-center gap-2 rounded-full border border-rule bg-white px-3">
              <svg
                className="h-5 w-5 shrink-0 text-inkLight"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                aria-hidden
              >
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" strokeLinecap="round" />
              </svg>
              <input
                ref={connectorSearchRef}
                type="search"
                value={connectorQuery}
                onChange={(e) => setConnectorQuery(e.target.value)}
                placeholder="Search integrations"
                aria-label="Search integrations"
                className="w-full bg-transparent text-[14px] font-medium leading-[22px] text-ink outline-none placeholder:font-medium placeholder:text-inkLight [&::-webkit-search-cancel-button]:appearance-none"
              />
              {connectorQuery && (
                <button
                  type="button"
                  onClick={() => {
                    setConnectorQuery("");
                    connectorSearchRef.current?.focus();
                  }}
                  className="-mr-2 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-inkLight transition-colors hover:bg-creamDeep hover:text-ink focus-visible:bg-creamDeep focus-visible:text-ink focus-visible:outline-none"
                  aria-label="Clear search"
                >
                  <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" aria-hidden>
                    <path d="M6 6l12 12M18 6 6 18" />
                  </svg>
                </button>
              )}
            </div>
          </div>

          {loading ? (
            <div className="mt-6">
              <SkeletonConnectorGrid />
            </div>
          ) : (
            <div className="mt-6 flex flex-col gap-8">
              {composioError && (
                <Banner tone="error" onDismiss={() => setComposioErrorDismissed(true)}>
                  {composioErrorNotice(composioErrorSlug ?? "", composioError, searchParams.get("code"))}
                </Banner>
              )}

              {connectFailure && (
                <Banner tone="error" onDismiss={() => setConnectFailureDismissed(true)}>
                  {connectFailure}
                </Banner>
              )}

              {loadError && (
                <Banner
                  tone="warning"
                  title="Couldn’t load your connected sources"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <span>
                      Slack, GitHub, Meta Ads, and the rest are still connected. This is a display hiccup.
                    </span>
                    <button
                      type="button"
                      onClick={retryConnectorLoad}
                      className="shrink-0 rounded-cta border border-amber-300 bg-white px-3 py-1.5 text-[13px] font-semibold text-amber-800 hover:bg-amber-100"
                    >
                      Retry
                    </button>
                  </div>
                </Banner>
              )}

              {(() => {
                const q = connectorQuery.trim().toLowerCase();
                const forYouOrder =
                  recommendedSlugs.length > 0 ? recommendedSlugs : DEFAULT_FOR_YOU_SLUGS;
                const {
                  connected: partitionedConnectedRows,
                  forYou: forYouRows,
                  rest: restRows,
                } = partitionConnectorRows(rowsWithHealth, connectorQuery, forYouOrder);
                const connectedRows = partitionedConnectedRows.filter((r) => !(emailChecking && r.slug === "email"));
                const renderRow = (row: ConnectorRow) => (
                  <ConnectorRowView
                    onConnectorsChanged={() => setReloadKey((k) => k + 1)}
                    key={row.slug}
                    row={row}
                    flashConnected={!!justConnected[row.slug]}
                    highlighted={highlightedSlug === row.slug}
                    readOnly={readOnly}
                    onSetDefaultRepo={onSetDefaultRepo}
                    onSetSelectedRepos={onSetSelectedRepos}
                    githubLimitOpen={githubLimitOpen}
                    onToggleGithubLimit={() => setGithubLimitOpen((v) => !v)}
                    syncedAt={connectorSync.sources?.[row.slug] ?? null}
                  />
                );
                const connectedAppTiles = connectedApps.filter(
                  (a) => !isNativeFoldedSlug(a.slug) && !emailIssues.has(a.app) && matchesAppQuery(a, connectorQuery),
                );
                const emailTilesHeld =
                  emailChecking &&
                  (connectedRows.length < partitionedConnectedRows.length ||
                    connectedAppTiles.some((a) => KEY_TOOLS.has(a.app)));
                const verifiedAppTiles = emailChecking
                  ? connectedAppTiles.filter((a) => !KEY_TOOLS.has(a.app))
                  : connectedAppTiles;
                const showConnected =
                  emailTilesHeld ||
                  connectedRows.length > 0 ||
                  connectedAppTiles.length > 0 ||
                  connectedAppsLoading;
                const catalogItems: CatalogItem[] = [
                  ...restRows.map((row) => ({
                    key: row.slug,
                    category: categoryOf(row.slug, NATIVE_CATEGORY),
                    node: renderRow(row),
                  })),
                  ...(!q || "social linkedin instagram tiktok".includes(q)
                    ? [
                        {
                          key: "social",
                          category: categoryOf("social", NATIVE_CATEGORY),
                          node: <SocialConnectorTile readOnly={readOnly} />,
                        },
                      ]
                    : []),
                ];
                return (
                  <>
                    {}
                    <SettingsSection title="Needs attention">
                      {attentionRows.length > 0 || attentionApps.length > 0 ? (
                        <div className={INTEGRATION_GRID}>
                          {attentionRows.map((row) => {
                            if (row.tool_issue) {
                              return (
                                <ReconnectTile
                                  key={row.slug}
                                  slug={row.slug}
                                  label={LABELS[row.slug]}
                                  statusText={EMAIL_TOOL_ISSUE_STATUS[row.tool_issue]}
                                  reason={emailToolIssueReason(row.tool_issue, LABELS[row.slug])}
                                  readOnly={readOnly}
                                  highlighted={highlightedSlug === row.slug}
                                  onReconnect={() => setStripSendgridOpen((v) => !v)}
                                  onDisconnect={
                                    canDisconnect(row.slug)
                                      ? () => void disconnectConnector(row.slug, LABELS[row.slug], { sourceSlugs: row.source_slugs })
                                      : undefined
                                  }
                                />
                              );
                            }
                            const authBroken = !!row.health && needsReconnect(row.health);
                            const slowOnly = !authBroken && !row.read_failed && !!row.read_slow;
                            return (
                              <ReconnectTile
                                key={row.slug}
                                slug={row.slug}
                                label={LABELS[row.slug]}
                                statusText={authBroken ? "Needs reconnect" : slowOnly ? "Not answering" : "Spend read failing"}
                                showReconnect={!slowOnly}
                                reason={
                                  authBroken
                                    ? row.health?.reason ?? "Reconnect to restore access."
                                    : slowOnly
                                      ? readSlowReason(LABELS[row.slug])
                                      : row.read_failed_since
                                      ? readFailedReason(row.read_failed_since)
                                      : "Reconnect to restore access."
                                }
                                readOnly={readOnly}
                                highlighted={highlightedSlug === row.slug}
                                onReconnect={
                                  row.slug === "apple_ads" ? () => setStripAppleOpen((v) => !v) : undefined
                                }
                                onDisconnect={
                                  canDisconnect(row.slug)
                                    ? () => void disconnectConnector(row.slug, LABELS[row.slug], { sourceSlugs: row.source_slugs })
                                    : undefined
                                }
                              />
                            );
                          })}
                          {attentionApps.map((app) => {
                            const issue = emailIssues.get(app.app)!;
                            return (
                              <ReconnectTile
                                key={app.slug}
                                slug={app.app}
                                label={app.name}
                                statusText={EMAIL_TOOL_ISSUE_STATUS[issue]}
                                reason={emailToolIssueReason(issue, app.name)}
                                readOnly={readOnly}
                                onReconnect={() =>
                                  void startComposioConnect(app.app).catch((e: Error) =>
                                    showConnectorError({ title: `Couldn’t reconnect ${app.name}`, message: e.message }),
                                  )
                                }
                                onDisconnect={() => void disconnectConnectedApp(app, onAggregatorRemoved)}
                              />
                            );
                          })}
                          {stripSendgridOpen && attentionRows.some((r) => r.slug === "email" && r.tool_issue) && (
                            <div className="col-span-full">
                              <SendgridKeyForm
                                onClose={() => {
                                  setStripSendgridOpen(false);
                                  if (stripSendgridSaved.current) {
                                    stripSendgridSaved.current = false;
                                    setReloadKey((k) => k + 1);
                                  }
                                }}
                                onConnected={() => {
                                  stripSendgridSaved.current = true;
                                }}
                              />
                            </div>
                          )}
                          {stripAppleOpen && attentionRows.some((r) => r.slug === "apple_ads") && (
                            <div className="col-span-full">
                              <AppleAdsForm
                                onClose={() => setStripAppleOpen(false)}
                                onConnected={() => {
                                  setStripAppleOpen(false);
                                  setReloadKey((k) => k + 1);
                                }}
                              />
                            </div>
                          )}
                        </div>
                      ) : adRead.status === "error" ? (
                        <AdSpendReadError />
                      ) : adRead.status === "loading" || emailChecking ? (
                        <p className="text-[13px] text-[#8a8a8a]">Checking your connections…</p>
                      ) : emailReadFailed ? (
                        <p role="alert" className="flex flex-wrap items-center gap-2 text-[13px] text-danger">
                          Zavi could not check your email tools, so it cannot say they are working.
                          <button type="button" onClick={() => setReloadKey((k) => k + 1)} className="rounded-sm font-medium text-ink underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30">
                            Try again
                          </button>
                        </p>
                      ) : (
                        <p className="text-[13px] text-[#8a8a8a]">
                          Every connection is working. Anything that breaks shows up here with its fix.
                        </p>
                      )}
                    </SettingsSection>

                    {showConnected && (
                      <SettingsSection title="Connected">
                        <div className={INTEGRATION_GRID}>
                          {connectedRows.map(renderRow)}
                          {emailTilesHeld && <SkeletonConnectorTile />}
                          {connectedAppsLoading ? (
                            <SkeletonConnectorTile />
                          ) : (
                            <ConnectedAppTiles
                              apps={verifiedAppTiles}
                              readOnly={readOnly}
                              onRemoved={onAggregatorRemoved}
                            />
                          )}
                        </div>
                      </SettingsSection>
                    )}

                    {forYouRows.length > 0 && (
                      <SettingsSection title="For You">
                        <div className={INTEGRATION_GRID}>
                          {forYouRows.map(renderRow)}
                        </div>
                      </SettingsSection>
                    )}

                    <CategorySections items={catalogItems} />

                    <SettingsSection title="More apps">
                      <div className={INTEGRATION_GRID}>
                        {!composio.loaded ? (
                          <SkeletonConnectorTile />
                        ) : (
                          <ComposioApps
                            apps={composio}
                            readOnly={readOnly}
                            query={connectorQuery}
                          />
                        )}
                      </div>
                    </SettingsSection>
                  </>
                );
              })()}
            </div>
          )}
        </section>
        )}

        {}

        {activeId === "notifications" && (
        <section id="notifications" className="mt-1">
          <h2 className="mb-1 text-[16px] font-semibold tracking-tight text-ink">
            Notifications
          </h2>
          <p className="mb-4 text-[16px] text-inkMuted leading-[1.55]">
            Where your agents&apos; results land when a schedule delivers by email.
          </p>
          {}
          <div className="space-y-3">
            <NotificationsPanel />
          </div>
        </section>
        )}

        {activeId === "rules" && (
        <section id="rules" className="mt-1">
          <h2 className="mb-1 text-[16px] font-semibold tracking-tight text-ink">
            Rules
          </h2>
          <p className="mb-4 text-[16px] text-inkMuted leading-[1.55]">
            How you want your agents to work, in your own words.
          </p>
          <RulesPanel />
        </section>
        )}

        {activeId === "email" && (
        <section id="email" className="mt-1">
          <h2 className="mb-1 text-[16px] font-semibold tracking-tight text-ink">
            Email
          </h2>
          <p className="mb-4 text-[16px] text-inkMuted leading-[1.55]">
            Your agent&apos;s own address, and who is allowed to write to it.
          </p>
          <EmailAllowlistPanel canEdit={!readOnly} />
        </section>
        )}

        {activeId === "ai-clients" && (
        <section id="ai-clients" className="mt-1">
          <h2 className="mb-1 text-[16px] font-semibold tracking-tight text-ink">
            MCP
          </h2>
          <p className="mb-6 text-[16px] text-inkMuted leading-[1.55]">
            Run your agents from Claude Code, claude.ai or ChatGPT.
          </p>
          <McpClientsPanel />
        </section>
        )}

        {activeId === "account" && (
        <section id="account" className="mt-1">
          <h2 className="mb-1 text-[16px] font-semibold tracking-tight text-ink">
            Account
          </h2>
          <p className="mb-4 text-[16px] text-inkMuted leading-[1.55]">
            Your own sign-in, separate from the workspace. Only you can change it.
          </p>
          <AccountSecurityPanel
            role={role}
            onOpenBilling={isVisibleSection("billing") ? () => selectSection("billing") : undefined}
          />
        </section>
        )}

        {activeId === "feedback" && (
        <section id="feedback" className="mt-1">
          <h2 className="mb-1 text-[16px] font-semibold tracking-tight text-ink">
            Feedback
          </h2>
          <p className="mb-6 text-[16px] text-inkMuted leading-[1.55]">
            Tell us what is working and what is not. It goes straight to the team.
          </p>
          <TeamNoteSuggestionsToggle />
          <FeedbackPanel showRequests />
        </section>
        )}

        {activeId === "team" && (
        <section id="team" className="team-surface-enter mt-1">
          {currentUserId && role ? (
            <WorkspaceMembersPanel
              role={role}
              currentUserId={currentUserId}
              embedded
              title="Members"
              subtitle={
                readOnly
                  ? "Everyone in this workspace."
                  : "Invite members as an admin, member or viewer."
              }
            />
          ) : (
            <>
              <h2 className="mb-1 text-[16px] font-semibold tracking-tight text-ink">
                Team
              </h2>
              <SkeletonListCard rows={4} label="Loading members…" />
            </>
          )}
          {!readOnly && (
            <div className="mt-12 flex flex-col gap-6 border-t border-rule pt-10">
              <div className="flex flex-col gap-2">
                {}
                <h3 className="text-[20px] font-semibold leading-[28px] tracking-tight text-ink">
                  Observed team
                </h3>
                <p className="text-[14px] leading-6 text-inkMuted">
                  People Zavi sees across connected{" "}
                  <span className="font-semibold">GitHub / Slack / Jira</span>. No
                  employee logs in to Zavi.
                </p>
              </div>
              <TeamRosterCard />
            </div>
          )}
          <AgentInboxAddresses />
        </section>
        )}

        {}
        {activeId === "billing" && isVisibleSection("billing") && (
          <div className="space-y-5">
            <BillingCreditsPanel
              key={billingNonce}
              openUsage={usageDeepLink}
              onUsageOpened={() => setUsageDeepLink(false)}
              onFullPageChange={onBillingFullPage}
              inlineBack={modal}
              tenantId={tenantId}
            />
          </div>
        )}
      </div>
    </div>
  );
}

export function SettingsModal({
  onClose,
  isActive = true,
}: {
  onClose: () => void;
  isActive?: boolean;
}) {
  useEffect(() => {
    if (!isActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isActive, onClose]);

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center p-3 md:p-10">
      <div
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        className="relative flex h-full max-h-[840px] w-full max-w-[1120px] overflow-hidden rounded-2xl bg-white shadow-[0_32px_90px_rgba(10,10,14,0.45)] ring-1 ring-black/10"
      >
        <SettingsTab modal />
        <button
          type="button"
          onClick={onClose}
          aria-label="Close settings"
          className="absolute right-4 top-4 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-white/80 text-[#8a8a8a] transition-colors hover:bg-[#f0f0f0] hover:text-[#0e0f11]"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      </div>
    </div>
  );
}

function SettingsSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-[13px]">
      <h3 className="text-[20px] font-semibold leading-[25px] tracking-tight text-[#0e0f11]">
        {title}
      </h3>
      {children}
    </div>
  );
}

function TertiaryButton({
  children,
  onClick,
  disabled,
  icon,
  className = "",
  title,
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  icon?: ReactNode;
  className?: string;
  title?: string;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-cta border border-[#f0f0f0] bg-white px-4 text-[16px] font-semibold leading-[20px] tracking-[0.01px] text-[#1f1f1f] transition-colors hover:border-[#e0e0e0] hover:bg-[#fafafa] disabled:opacity-50 ${className}`}
    >
      {icon}
      {children}
    </button>
  );
}

export const ZAVI_MANAGED_DB_DETAIL = "Your app's database, set up by Zavi";

export function ConnectorRowView({
  row,
  flashConnected,
  highlighted = false,
  readOnly = false,
  onSetDefaultRepo,
  onSetSelectedRepos,
  githubLimitOpen = false,
  onToggleGithubLimit,
  showConnectAffordance = false,
  syncedAt = null,
  onConnectorsChanged,
}: {
  row: ConnectorRow;
  onConnectorsChanged?: () => void;
  syncedAt?: string | null;
  flashConnected: boolean;
  highlighted?: boolean;
  readOnly?: boolean;
  onSetDefaultRepo?: (name: string) => void | Promise<void>;
  onSetSelectedRepos?: (ids: number[] | null) => void | Promise<void>;
  githubLimitOpen?: boolean;
  onToggleGithubLimit?: () => void;
  showConnectAffordance?: boolean;
}) {
  const label = LABELS[row.slug];
  const phoneSurface = isPhoneSurface(row.slug) ? row.slug : null;
  const [phoneOpen, setPhoneOpen] = useState(false);
  const [phoneManageOpen, setPhoneManageOpen] = useState(false);
  const { handsets: phoneHandsets, reload: reloadPhoneHandsets } = usePhoneHandsets(
    phoneSurface,
    row.connected,
  );
  const [telegramOpen, setTelegramOpen] = useState(false);
  const [discordOpen, setDiscordOpen] = useState(false);
  const [stripeOpen, setStripeOpen] = useState(false);
  const [posthogOpen, setPosthogOpen] = useState(false);
  const [higgsfieldOpen, setHiggsfieldOpen] = useState(false);
  const [sentryOpen, setSentryOpen] = useState(false);
  const [appleAdsOpen, setAppleAdsOpen] = useState(false);
  const [figmaOpen, setFigmaOpen] = useState(false);
  const [supabaseOpen, setSupabaseOpen] = useState(false);
  const [sendgridOpen, setSendgridOpen] = useState(false);
  const [connectBusy, setConnectBusy] = useState(false);
  const [reconnectBusy, setReconnectBusy] = useState(false);
  const showStripeForm = !readOnly && row.slug === "stripe" && stripeOpen;
  const showPosthogForm = !readOnly && row.slug === "posthog" && posthogOpen;
  const showHiggsfieldForm = !readOnly && row.slug === "higgsfield" && higgsfieldOpen;
  const showSentryForm = !readOnly && row.slug === "sentry" && sentryOpen;
  const showAppleAdsForm = !readOnly && row.slug === "apple_ads" && appleAdsOpen;
  const showFigmaForm = !readOnly && row.slug === "figma" && figmaOpen;
  const showSupabaseForm = !readOnly && row.slug === "supabase" && supabaseOpen;
  const showSendgridForm = !readOnly && row.slug === "email" && sendgridOpen;
  const showPhoneForm = !readOnly && phoneSurface !== null && phoneOpen;
  const showTelegramForm = !readOnly && row.slug === "telegram" && telegramOpen;
  const showDiscordForm = !readOnly && row.slug === "discord" && discordOpen;

  if (row.slug === "operator_db") {
    return (
      <DatabaseCard
        connected={row.connected || flashConnected}
        dbType={row.db_type ?? null}
        managedBy={row.managed_by ?? null}
        canManage={!readOnly}
        highlighted={highlighted}
        syncedText={syncLine(syncedAt)?.text ?? null}
      />
    );
  }

  if (row.slug === "slack" && row.connected) {
    return (
      <SlackWorkspacesPanel
        asCard
        connected={row.connected}
        readOnly={readOnly}
        highlighted={highlighted}
      />
    );
  }

  if (row.slug === "github" && row.connected) {
    return (
      <GithubConnectedCard
        row={row}
        highlighted={highlighted}
        flashConnected={flashConnected}
        readOnly={readOnly}
        onSetDefaultRepo={onSetDefaultRepo}
        onSetSelectedRepos={onSetSelectedRepos}
        limitOpen={githubLimitOpen}
        onToggleLimit={onToggleGithubLimit}
      />
    );
  }

  if (!row.connected) {
    const togglesForm =
      row.slug === "stripe" ||
      row.slug === "posthog" ||
      row.slug === "higgsfield" ||
      row.slug === "sentry" ||
      row.slug === "figma" ||
      row.slug === "supabase" ||
      row.slug === "email" ||
      phoneSurface !== null ||
      row.slug === "telegram" ||
      row.slug === "discord";
    const formOpen =
      row.slug === "posthog"
          ? posthogOpen
          : row.slug === "higgsfield"
            ? higgsfieldOpen
            : row.slug === "sentry"
              ? sentryOpen
              : row.slug === "figma"
                ? figmaOpen
                : row.slug === "supabase"
                  ? supabaseOpen
                  : row.slug === "email"
                  ? sendgridOpen
                  : phoneSurface
                    ? phoneOpen
                    : row.slug === "telegram"
                      ? telegramOpen
                      : row.slug === "discord"
                        ? discordOpen
                        : stripeOpen;
    const connectFromCard = async () => {
      if (row.slug === "stripe") {
        setStripeOpen((v) => !v);
        return;
      }
      if (row.slug === "posthog") {
        setPosthogOpen((v) => !v);
        return;
      }
      if (row.slug === "higgsfield") {
        setConnectBusy(true);
        try {
          await startHiggsfieldConnect();
        } finally {
          setConnectBusy(false);
        }
        return;
      }
      if (row.slug === "sentry") {
        setSentryOpen((v) => !v);
        return;
      }
      if (row.slug === "apple_ads") {
        setAppleAdsOpen((v) => !v);
        return;
      }
      if (row.slug === "figma") {
        setFigmaOpen((v) => !v);
        return;
      }
      if (row.slug === "supabase") {
        setSupabaseOpen((v) => !v);
        return;
      }
      if (row.slug === "email") {
        setSendgridOpen((v) => !v);
        return;
      }
      if (phoneSurface) {
        setPhoneOpen((v) => !v);
        return;
      }
      if (row.slug === "telegram") {
        setTelegramOpen((v) => !v);
        return;
      }
      if (row.slug === "discord") {
        setDiscordOpen((v) => !v);
        return;
      }
      setConnectBusy(true);
      try {
        if (row.slug === "meta_ads") await startMetaAdsConnect();
        else if (row.slug === "google_ads") await startGoogleAdsConnect();
        else if (row.slug === "google_analytics") await startGoogleAnalyticsConnect();
        else if (row.slug === "google_search_console") await startGoogleSearchConsoleConnect();
        else if (row.slug === "google_calendar") await startGoogleCalendarConnect();
        else if (row.slug === "google_sheets") await startGoogleSheetsConnect();
        else if (row.slug === "instagram_social") await startRailConnect("instagram", "instagram_social");
        else if (row.slug === "reddit_social") await startRailConnect("reddit", "reddit_social");
        else await startSettingsConnect(row.slug);
      } catch (e) {
        showConnectorError({
          title: `Couldn’t connect ${label}`,
          message: (e as Error).message,
        });
      } finally {
        setConnectBusy(false);
      }
    };
    return (
      <>
        <ConnectorTile
          id={`connector-${row.slug}`}
          logo={<ConnectorLockup slug={row.slug} label={label} />}
          name={label}
          description={purposeFor(row.slug, label)}
          status={connectionState(false, undefined)}
          highlighted={highlighted}
          title={PLACEHOLDER_COPY[row.slug]}
          action={
            readOnly ? null : (
              <TileButton
                onClick={() => void connectFromCard()}
                disabled={connectBusy}
                ariaExpanded={togglesForm ? formOpen : undefined}
              >
                <span aria-hidden>{connectBusy ? "Opening…" : "Connect"}</span>
                <span className="sr-only">Connect {label}</span>
              </TileButton>
            )
          }
        />
        {showStripeForm && (
          <div className="col-span-full">
            <StripeForm onClose={() => setStripeOpen(false)} />
          </div>
        )}
        {showPosthogForm && (
          <div className="col-span-full">
            <PosthogForm onClose={() => setPosthogOpen(false)} onConnected={onConnectorsChanged} />
          </div>
        )}
        {showHiggsfieldForm && (
          <div className="col-span-full">
            <HiggsfieldForm onClose={() => setHiggsfieldOpen(false)} />
          </div>
        )}
        {showSentryForm && (
          <div className="col-span-full">
            <SentryForm onClose={() => setSentryOpen(false)} />
          </div>
        )}
        {showAppleAdsForm && (
          <div className="col-span-full">
            <AppleAdsForm onClose={() => setAppleAdsOpen(false)} onConnected={onConnectorsChanged} />
          </div>
        )}
        {showFigmaForm && (
          <div className="col-span-full">
            <FigmaForm onClose={() => setFigmaOpen(false)} />
          </div>
        )}
        {showSupabaseForm && (
          <div className="col-span-full">
            <SupabaseForm onClose={() => setSupabaseOpen(false)} />
          </div>
        )}
        {showSendgridForm && (
          <div className="col-span-full">
            <SendgridKeyForm onClose={() => setSendgridOpen(false)} onConnected={onConnectorsChanged} />
          </div>
        )}
        {showPhoneForm && phoneSurface && <PhoneBindForm surface={phoneSurface} onClose={() => setPhoneOpen(false)} />}
        {showTelegramForm && <TelegramForm onClose={() => setTelegramOpen(false)} />}
        {showDiscordForm && <DiscordForm onClose={() => setDiscordOpen(false)} />}
      </>
    );
  }

  const connectedDetail =
    row.slug === "google_ads"
      ? ""
      : row.slug === "meta_ads" ||
          row.slug === "google_analytics" ||
          row.slug === "google_search_console" ||
          row.slug === "google_calendar"
      ? row.ad_account_id ?? "-"
      : row.slug === "stripe"
          ?
            stripeDetail(row.team_name, row.account_login)
          : row.slug === "jira" ||
              row.slug === "linear" ||
              row.slug === "sentry" ||
              row.slug === "figma" ||
              row.slug === "supabase" ||
              row.slug === "intercom" ||
              row.slug === "discord" ||
              row.slug === "linkedin_ads" ||
              row.slug === "linkedin_social" ||
              row.slug === "x_social" ||
              row.slug === "reddit_social" ||
              row.slug === "instagram_social" ||
              row.slug === "x_ads" ||
              row.slug === "tiktok_ads" ||
              row.slug === "reddit_ads" ||
              row.slug === "snapchat_ads" ||
              row.slug === "spotify_ads" ||
              row.slug === "pinterest_ads" ||
              row.slug === "microsoft_ads" ||
              row.slug === "apple_ads"
            ? row.team_name ?? "-"
            : row.slug === "github"
              ? `${row.account_login ?? "-"} · ${row.repo_count ?? 0} repos`
              : row.slug === "email"
                ? row.campaign_ready
                  ? "Ready for email campaigns"
                  : "Needs more permissions for campaigns"
              : phoneSurface
                ?
                  handsetsLabel(phoneHandsets)
                : "";

  const startReconnect = (): void | Promise<void> => {
    if (row.slug === "stripe") return setStripeOpen((v) => !v);
    if (row.slug === "posthog") return setPosthogOpen((v) => !v);
    if (row.slug === "higgsfield") return startHiggsfieldConnect();
    if (row.slug === "sentry") return setSentryOpen((v) => !v);
    if (row.slug === "figma") return setFigmaOpen((v) => !v);
    if (row.slug === "supabase") return setSupabaseOpen((v) => !v);
    if (row.slug === "email") return setSendgridOpen((v) => !v);
    if (phoneSurface) return setPhoneOpen((v) => !v);
    if (row.slug === "telegram") return setTelegramOpen((v) => !v);
    if (row.slug === "discord") return setDiscordOpen((v) => !v);
    if (row.slug === "meta_ads") return startMetaAdsConnect();
    if (row.slug === "google_ads") return startGoogleAdsConnect();
    if (row.slug === "google_analytics") return startGoogleAnalyticsConnect();
    if (row.slug === "google_search_console") return startGoogleSearchConsoleConnect();
    if (row.slug === "google_calendar") return startGoogleCalendarConnect();
    if (row.slug === "google_sheets") return startGoogleSheetsConnect();
    if (row.slug === "instagram_social") return startRailConnect("instagram", "instagram_social");
    if (row.slug === "reddit_social") return startRailConnect("reddit", "reddit_social");
    if (row.slug === "apple_ads") return void setAppleAdsOpen((v) => !v);
    return startSettingsConnect(row.slug);
  };
  const reconnect = async () => {
    setReconnectBusy(true);
    try {
      await startReconnect();
    } catch (e) {
      showConnectorError({
        title: `Couldn’t reconnect ${label}`,
        message: (e as Error).message,
      });
    } finally {
      setReconnectBusy(false);
    }
  };
  const menuItems: { label: string; onClick: () => void; danger?: boolean }[] = [
    { label: reconnectBusy ? "Opening…" : "Reconnect", onClick: () => void reconnect() },
    ...(phoneSurface
      ? [{ label: "Manage numbers", onClick: () => setPhoneManageOpen(true) }]
      : []),
    ...(canDisconnect(row.slug)
      ? [
          {
            label: "Disconnect",
            onClick: () => void disconnectConnector(row.slug, label, { sourceSlugs: row.source_slugs }),
            danger: true,
          },
        ]
      : []),
  ];

  const baseState = connectionState(true, row.health);
  const detail =
    connectedDetail && connectedDetail !== "-" ? connectedDetail : undefined;
  const synced = syncLine(syncedAt);
  const state =
    synced?.stale && baseState.tone === "connected" ? { tone: "warning" as const, text: "Not syncing" } : baseState;
  const syncedDetail = synced ? [synced.text, detail].filter(Boolean).join(" · ") : undefined;

  return (
    <>
      <ConnectorTile
        id={`connector-${row.slug}`}
        logo={<ConnectorLockup slug={row.slug} label={label} />}
        name={label}
        description={row.health?.reason ?? syncedDetail ?? detail ?? purposeFor(row.slug, label)}
        status={{
          tone: state.tone,
          text: flashConnected ? `${state.text} ✓` : state.text,
        }}
        highlighted={highlighted}
        action={
          readOnly ? null : (
            <TileMenu label="Manage" items={menuItems} disabled={reconnectBusy} />
          )
        }
      />

      {}
      {showStripeForm && (
        <div className="col-span-full">
          <StripeForm onClose={() => setStripeOpen(false)} />
        </div>
      )}
      {showPosthogForm && (
        <div className="col-span-full">
          <PosthogForm onClose={() => setPosthogOpen(false)} onConnected={onConnectorsChanged} />
        </div>
      )}
      {showHiggsfieldForm && (
        <div className="col-span-full">
          <HiggsfieldForm onClose={() => setHiggsfieldOpen(false)} />
        </div>
      )}
      {showSentryForm && (
        <div className="col-span-full">
          <SentryForm onClose={() => setSentryOpen(false)} />
        </div>
      )}
      {showAppleAdsForm && (
        <div className="col-span-full">
          <AppleAdsForm onClose={() => setAppleAdsOpen(false)} onConnected={onConnectorsChanged} />
        </div>
      )}
      {showFigmaForm && (
        <div className="col-span-full">
          <FigmaForm onClose={() => setFigmaOpen(false)} />
        </div>
      )}
      {showSupabaseForm && (
        <div className="col-span-full">
          <SupabaseForm onClose={() => setSupabaseOpen(false)} />
        </div>
      )}
      {showSendgridForm && (
        <div className="col-span-full">
          <SendgridKeyForm onClose={() => setSendgridOpen(false)} onConnected={onConnectorsChanged} />
        </div>
      )}
      {}
      {showPhoneForm && phoneSurface && <PhoneBindForm surface={phoneSurface} onClose={() => setPhoneOpen(false)} />}
      {!readOnly && phoneSurface && phoneManageOpen && (
        <PhoneHandsetsDialog
          surface={phoneSurface}
          handsets={phoneHandsets}
          onClose={() => setPhoneManageOpen(false)}
          onChanged={reloadPhoneHandsets}
          onAddNumber={() => {
            setPhoneManageOpen(false);
            setPhoneOpen(true);
          }}
        />
      )}
      {showTelegramForm && <TelegramForm onClose={() => setTelegramOpen(false)} />}
      {showDiscordForm && <DiscordForm onClose={() => setDiscordOpen(false)} />}
    </>
  );
}

const INSTALLED_MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
function formatInstalledDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  const month = INSTALLED_MONTHS[Number(m) - 1];
  if (!y || !month || !d) return iso.slice(0, 10);
  return `${month} ${Number(d)}, ${y}`;
}

function GithubConnectedCard({
  row,
  highlighted,
  flashConnected = false,
  readOnly,
  onSetDefaultRepo,
  onSetSelectedRepos,
  limitOpen = false,
  onToggleLimit,
}: {
  row: ConnectorRow;
  highlighted: boolean;
  flashConnected?: boolean;
  readOnly: boolean;
  onSetDefaultRepo?: (name: string) => void | Promise<void>;
  onSetSelectedRepos?: (ids: number[] | null) => void | Promise<void>;
  limitOpen?: boolean;
  onToggleLimit?: () => void;
}) {
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectErr, setDisconnectErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(flashConnected || highlighted);
  useEffect(() => {
    if (flashConnected || highlighted) setExpanded(true);
  }, [flashConnected, highlighted]);
  useEffect(() => {
    if (limitOpen) setExpanded(true);
  }, [limitOpen]);

  const names = row.repo_full_names ?? [];
  const priv = row.repo_private;
  const repoCount = names.length;
  const repoIds = row.repo_ids ?? [];
  const selection = Array.isArray(row.selected_repo_ids) ? row.selected_repo_ids : null;
  const isAllowed = (i: number) =>
    selection === null || (repoIds[i] !== undefined && selection.includes(repoIds[i]));
  const allowedCount = names.filter((_, i) => isAllowed(i)).length;
  const repoOrder = names
    .map((_, i) => i)
    .sort((a, b) => Number(!isAllowed(a)) - Number(!isAllowed(b)));
  const allowRepo = (i: number) => {
    const id = repoIds[i];
    if (id === undefined || selection === null) return;
    void onSetSelectedRepos?.([...selection, id]);
  };
  const managed = isZaviManagedGithubLogin(row.account_login);
  const installed = row.connected_at ? formatInstalledDate(row.connected_at) : null;
  const accountLabel =
    (row.account_type ?? "").toLowerCase() === "organization"
      ? "organization"
      : "personal account";

  async function disconnect() {
    if (
      !window.confirm(
        "Disconnect GitHub? Agents will immediately stop reading your repos. Your GitHub App install stays in place. Reconnect anytime.",
      )
    )
      return;
    setDisconnecting(true);
    setDisconnectErr(null);
    try {
      const r = await apiFetch("/api/connectors/github/disconnect", {
        method: "POST",
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        setDisconnectErr(body?.error?.message ?? `HTTP ${r.status}`);
        return;
      }
      window.location.reload();
    } catch (e) {
      setDisconnectErr((e as Error).message);
    } finally {
      setDisconnecting(false);
    }
  }

  return (
    <div
      id="connector-github"
      className={`scroll-mt-24 col-span-full flex flex-col gap-4 rounded-[16px] border bg-white px-4 py-[19px] transition-shadow ${
        highlighted ? "border-emerald-400 ring-2 ring-emerald-300/60" : "border-[#f0f0f0]"
      }`}
    >
      {}
      <div
        className={`flex flex-wrap items-center justify-between gap-3 ${
          expanded ? "border-b border-[#f0f0f0] pb-4" : ""
        }`}
      >
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex h-6 items-center gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={CONNECTOR_ICON.github}
              alt=""
              className="h-6 w-6 shrink-0 rounded-[6px] object-contain"
            />
            <span className="text-[14px] font-bold tracking-tight text-[#0e0f11]">
              GitHub
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] leading-[16px] tracking-[0.01px]">
            {managed ? (
              <span className="flex items-center gap-2 font-medium text-[#595959]">
                <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-[#9a9a9a]" />
                Managed by Zavi
              </span>
            ) : (
              <span className="flex items-center gap-2 font-medium text-[#167f50]">
                <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-[#167f50]" />
                Connected
              </span>
            )}
            <span aria-hidden className="inline-block h-1 w-1 rounded-full bg-[#d0d0d0]" />
            <span className="font-medium text-[#0e0f11]">
              {managed
                ? `${repoCount} ${repoCount === 1 ? "repository" : "repositories"}`
                : allowedCount === repoCount
                  ? repoCount === 1
                    ? "Zavi can use your repository"
                    : `Zavi can use all ${repoCount} repositories`
                  : `Zavi can use ${allowedCount} of ${repoCount} repositories`}
            </span>
            {installed && (
              <>
                <span aria-hidden className="inline-block h-1 w-1 rounded-full bg-[#d0d0d0]" />
                <span className="font-medium text-[#0e0f11]">installed {installed}</span>
              </>
            )}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <TileButton
            onClick={() => setExpanded((v) => !v)}
            ariaExpanded={expanded}
            ariaControls="connector-github-body"
          >
            {expanded ? "Done" : "Manage"}
          </TileButton>
        </div>
      </div>

      {disconnectErr && (
        <Banner tone="error" title="Couldn’t disconnect GitHub" onDismiss={() => setDisconnectErr(null)}>
          {disconnectErr}
        </Banner>
      )}

      {}
      {expanded && (
        <div id="connector-github-body" className="flex flex-col gap-4">
          {managed && (
            <p className="text-[14px] leading-[20px] text-[#595959]">
              Zavi keeps your app&rsquo;s code in a private repo it manages
              {names[0] ? (
                <>
                  {" "}
                  (<span className="font-mono text-[#0e0f11]">{names[0]}</span>)
                </>
              ) : null}
              . To get your own copy, connect a GitHub account you own below, then use{" "}
              <span className="font-semibold text-ink">Export to GitHub</span> from
              the GitHub button on the Build screen.
            </p>
          )}
          {!readOnly && !managed && (
            <div className="flex flex-wrap items-center gap-2">
              <TertiaryButton
                onClick={() => onToggleLimit?.()}
                icon={<FilterIcon className="h-5 w-5" />}
                className={limitOpen ? "border-[#027bff] text-[#027bff]" : undefined}
              >
                Choose which repos Zavi can use
              </TertiaryButton>
              <TertiaryButton onClick={disconnect} disabled={disconnecting}>
                {disconnecting ? "Disconnecting…" : "Disconnect"}
              </TertiaryButton>
            </div>
          )}
          {}
          {limitOpen && !readOnly && repoCount > 0 && (
            <RepoScopePanel
              names={names}
              ids={row.repo_ids}
              selectedIds={row.selected_repo_ids}
              defaultRepoFullName={row.default_repo_full_name}
              onSave={onSetSelectedRepos}
              onClose={() => onToggleLimit?.()}
            />
          )}

          {}
          {repoCount > 0 && !managed && (
            <div className="flex flex-col gap-4 rounded-[22px] border border-[#f0f0f0] p-4">
              <div className="flex items-center gap-2 text-[16px] font-medium leading-[20px] text-[#0e0f11]">
                <GithubAvatar login={row.account_login} />
                <span className="truncate">{row.account_login ?? "-"}</span>
                <span aria-hidden className="inline-block h-1 w-1 rounded-full bg-[#d0d0d0]" />
                <span className="truncate text-[#595959]">{accountLabel}</span>
              </div>
              <div className="flex flex-col">
                {repoOrder.map((i, pos) => {
                  const full = names[i];
                  return (
                    <GithubRepoRow
                      key={full}
                      fullName={full}
                      isPrimary={row.default_repo_full_name === full}
                      isPrivate={priv && i < priv.length ? priv[i] : undefined}
                      baseBranch={row.repo_default_branches?.[full]}
                      showDivider={pos > 0}
                      readOnly={readOnly}
                      blocked={!isAllowed(i)}
                      onAllow={() => allowRepo(i)}
                      onSetDefault={() => onSetDefaultRepo?.(full)}
                    />
                  );
                })}
              </div>
            </div>
          )}

          {}
          {!readOnly && (
            <GithubInstallAnotherOrg
              embedded
              lead={
                managed ? (
                  <span className="font-semibold">
                    Connect a GitHub account you own to export your app&rsquo;s code.
                  </span>
                ) : undefined
              }
            />
          )}
        </div>
      )}
    </div>
  );
}

function RepoScopePanel({
  names,
  ids,
  selectedIds,
  defaultRepoFullName,
  onSave,
  onClose,
}: {
  names: string[];
  ids?: number[];
  selectedIds?: number[] | null;
  defaultRepoFullName?: string | null;
  onSave?: (ids: number[] | null) => void | Promise<void>;
  onClose: () => void;
}) {
  const haveIds = Array.isArray(ids) && ids.length === names.length;
  const isScoped = Array.isArray(selectedIds);
  const initial = useMemo(() => {
    if (isScoped) return new Set<number>(selectedIds as number[]);
    return new Set<number>(haveIds ? (ids as number[]) : []);
  }, [isScoped, selectedIds, haveIds, ids]);
  const [checked, setChecked] = useState<Set<number>>(initial);
  const [saving, setSaving] = useState(false);

  if (!haveIds) {
    return (
      <div className="rounded-[16px] border border-[#f0f0f0] bg-white p-4">
        <div className="flex items-center justify-between gap-3">
          <p className="text-[16px] font-semibold text-[#0e0f11]">
            Select the repositories Zavi&rsquo;s agents may reach
          </p>
          <button
            type="button"
            onClick={onClose}
            className="text-[13px] font-medium text-[#595959] hover:text-[#0e0f11]"
          >
            Close
          </button>
        </div>
        <p className="mt-2 text-[13px] leading-[18px] text-[#595959]">
          Repo scoping isn&rsquo;t available for this connection yet. Reconnect
          GitHub to enable per-repo access control.
        </p>
      </div>
    );
  }

  const pairs = names.map((name, i) => ({ name, id: (ids as number[])[i] }));
  const allChecked = pairs.every((p) => checked.has(p.id));
  const defaultPair = defaultRepoFullName
    ? pairs.find((p) => p.name === defaultRepoFullName)
    : undefined;
  const defaultWillBeCleared = defaultPair !== undefined && !checked.has(defaultPair.id);
  const toggle = (id: number) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = () =>
    setChecked(allChecked ? new Set() : new Set(pairs.map((p) => p.id)));

  return (
    <div className="flex flex-col gap-4 rounded-[16px] border border-[#f0f0f0] bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <p className="text-[16px] font-semibold leading-[22px] text-[#0e0f11]">
            Select the repositories Zavi&rsquo;s agents may reach
          </p>
          <p className="text-[13px] leading-[18px] text-[#595959]">
            Only checked repositories are reachable by your agents. Access is
            enforced on the server for every repo read.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="shrink-0 rounded-cta p-1 text-[#595959] hover:bg-[#f6f6f6] hover:text-[#0e0f11]"
        >
          <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden>
            <path d="m6 6 12 12M18 6 6 18" />
          </svg>
        </button>
      </div>

      {}
      <label className="flex cursor-pointer items-center gap-2.5 rounded-[10px] border border-[#f0f0f0] bg-[#f9f9f9] px-3 py-2.5">
        <input
          type="checkbox"
          checked={allChecked}
          onChange={toggleAll}
          className="h-4 w-4 accent-[#027bff]"
        />
        <span className="text-[16px] font-semibold text-[#0e0f11]">
          {allChecked ? "Deselect all" : "Select all"}
        </span>
        <span className="ml-auto text-[13px] font-medium text-[#595959]">
          {checked.size} of {pairs.length} selected
        </span>
      </label>

      {}
      <div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto rounded-[10px] border border-[#f0f0f0] p-1.5">
        {pairs.map(({ name, id }) => {
          const short = name.includes("/") ? name.slice(name.indexOf("/") + 1) : name;
          const owner = name.includes("/") ? name.slice(0, name.indexOf("/") + 1) : "";
          return (
            <label
              key={id}
              className="flex cursor-pointer items-center gap-2.5 rounded-[8px] px-2.5 py-2 hover:bg-[#f6f6f6]"
              title={name}
            >
              <input
                type="checkbox"
                checked={checked.has(id)}
                onChange={() => toggle(id)}
                className="h-4 w-4 accent-[#027bff]"
              />
              <BookOpenIcon className="h-[18px] w-[18px] shrink-0 text-[#595959]" />
              <span className="truncate text-[16px] leading-[18px]">
                <span className="font-normal text-[#595959]">{owner}</span>
                <span className="font-semibold text-[#0e0f11]">{short}</span>
              </span>
              {name === defaultRepoFullName && (
                <span className="ml-auto shrink-0 rounded-[3px] bg-[#f5faf8] px-1 py-px text-[11px] font-semibold leading-none text-[#167f50]">
                  Primary
                </span>
              )}
            </label>
          );
        })}
      </div>

      {defaultWillBeCleared && (
        <div className="flex items-start gap-2 rounded-[10px] border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] font-medium text-amber-700">
          <span aria-hidden>&#9888;</span>
          <span>
            <span className="font-semibold">{defaultRepoFullName}</span> is your
            default repo. Unchecking it clears the default, and agents then have
            to guess which repo a request means. Set a new default after saving.
          </span>
        </div>
      )}

      {checked.size === 0 && (
        <div className="flex items-center gap-2 rounded-[10px] border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] font-medium text-amber-700">
          <span aria-hidden>⚠</span> No repositories selected, so agents
          won&rsquo;t be able to reach any repo.
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={saving}
          onClick={async () => {
            setSaving(true);
            try {
              await onSave?.(Array.from(checked));
              onClose();
            } finally {
              setSaving(false);
            }
          }}
          className="inline-flex h-10 items-center justify-center rounded-cta bg-[#1f1f1f] px-4 text-[16px] font-semibold leading-[20px] text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save selection"}
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={onClose}
          className="inline-flex h-10 items-center justify-center rounded-cta border border-[#f0f0f0] bg-white px-4 text-[16px] font-semibold leading-[20px] text-[#1f1f1f] transition-colors hover:border-[#e0e0e0] hover:bg-[#fafafa] disabled:opacity-50"
        >
          Cancel
        </button>
        {isScoped && (
          <button
            type="button"
            disabled={saving}
            onClick={async () => {
              setSaving(true);
              try {
                await onSave?.(null);
                onClose();
              } finally {
                setSaving(false);
              }
            }}
            className="ml-auto text-[13px] font-medium text-[#595959] underline hover:text-[#0e0f11] disabled:opacity-50"
          >
            Allow all repositories
          </button>
        )}
      </div>
    </div>
  );
}

function GithubAvatar({ login }: { login?: string }) {
  const [failed, setFailed] = useState(false);
  if (!login || failed) {
    return (
      <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] bg-bone text-[9px] font-bold text-ink">
        {(login ?? "G").slice(0, 1).toUpperCase()}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`https://github.com/${encodeURIComponent(login)}.png?size=40`}
      alt=""
      className="h-5 w-5 shrink-0 rounded-[5px] object-cover"
      onError={() => setFailed(true)}
    />
  );
}

function errorCopy(code: string | undefined, status: number): string {
  switch (code) {
    case "unsafe_branch":
      return "That branch name isn't valid.";
    case "repo_not_connected":
      return "That repo isn't connected anymore.";
    case "not_admin":
      return "Only admins can change the base branch.";
    default:
      return status >= 500 ? "Couldn't save, please try again." : "Couldn't save.";
  }
}

function GithubRepoBranchSelect({
  fullName,
  baseBranch,
  readOnly,
}: {
  fullName: string;
  baseBranch: string | undefined;
  readOnly: boolean;
}) {
  const [current, setCurrent] = useState<string | undefined>(baseBranch);
  const [branches, setBranches] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadBranches = async () => {
    if (branches !== null || loading) return;
    setLoading(true);
    setError(null);
    try {
      const r = await apiFetch(
        `/api/connectors/github/repo-branches?repo_full_name=${encodeURIComponent(fullName)}`,
      );
      const body = (await r.json().catch(() => null)) as
        | { branches?: string[]; current?: string | null; error?: { message?: string } }
        | null;
      if (!r.ok) {
        setError("Couldn't load branches");
        return;
      }
      setBranches(body?.branches ?? []);
      if (body?.current) setCurrent(body.current);
    } catch {
      setError("Couldn't load branches");
    } finally {
      setLoading(false);
    }
  };

  const onPick = async (branch: string) => {
    if (branch === current) return;
    const prev = current;
    setCurrent(branch);
    setSaving(true);
    setError(null);
    try {
      const r = await apiFetch("/api/connectors/github/repo-branch", {
        method: "POST",
        body: JSON.stringify({ repo_full_name: fullName, branch }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => null)) as
          | { error?: { code?: string } }
          | null;
        setCurrent(prev);
        setError(errorCopy(body?.error?.code, r.status));
      }
    } catch {
      setCurrent(prev);
      setError("Couldn't save. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  };

  const disabled = readOnly || saving;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const boxRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const matches = useMemo(() => {
    const all = branches ?? [];
    const needle = query.trim().toLowerCase();
    return needle ? all.filter((b) => b.toLowerCase().includes(needle)) : all;
  }, [branches, query]);
  const shown = matches.slice(0, 200);
  const totalLabel = branches && branches.length >= 1000 ? "1,000+" : String(branches?.length ?? 0);
  const choose = (branch: string) => {
    setOpen(false);
    setQuery("");
    void onPick(branch);
  };

  return (
    <span
      ref={boxRef}
      className="relative inline-flex shrink-0 items-center gap-1 text-[13px] leading-[18px] text-[#595959]"
    >
      <BranchIcon className="h-4 w-4 text-[#595959]" />
      <button
        type="button"
        aria-label={`Base branch for ${fullName}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={readOnly ? "Only admins can change the base branch" : "Branch the engineer opens PRs against"}
        disabled={disabled}
        onClick={() => {
          void loadBranches();
          setOpen((v) => !v);
        }}
        className={`inline-flex max-w-[180px] items-center gap-1 rounded-[6px] border border-[#f0f0f0] bg-white px-1.5 py-0.5 text-[13px] text-[#0e0f11] ${
          disabled ? "cursor-default opacity-70" : "cursor-pointer hover:border-[#d0d0d0]"
        }`}
      >
        {}
        <span className="truncate">{current || "Repo default"}</span>
        <ChevronDownIcon className="h-3.5 w-3.5 shrink-0 text-[#595959]" />
      </button>
      {open && (
        <div className="absolute right-0 top-7 z-30 w-[320px] rounded-[12px] border border-[#e6e6e6] bg-white p-2 shadow-lg">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={branches ? `Search ${totalLabel} branches` : "Search branches"}
            aria-label={`Search branches in ${fullName}`}
            className="w-full rounded-[8px] border border-[#e6e6e6] px-2 py-1.5 text-[13px] text-[#0e0f11] outline-none placeholder:text-[#8c8c8c] focus:border-[#d0d0d0]"
          />
          <div role="listbox" className="mt-2 max-h-[260px] overflow-y-auto">
            {loading && <div className="px-2 py-2 text-[13px] text-[#8c8c8c]">Loading branches…</div>}
            {!loading && error && <div className="px-2 py-2 text-[13px] text-[#b42318]">{error}</div>}
            {!loading && !error && shown.map((b) => (
              <button
                key={b}
                type="button"
                role="option"
                aria-selected={b === current}
                onClick={() => choose(b)}
                className="flex w-full items-center justify-between gap-2 rounded-[6px] px-2 py-1.5 text-left text-[13px] text-[#0e0f11] hover:bg-[#f5f5f5]"
              >
                <span className="truncate">{b}</span>
                {b === current && <span aria-hidden className="text-[#167f50]">✓</span>}
              </button>
            ))}
            {!loading && !error && branches && matches.length === 0 && (
              <div className="px-2 py-2 text-[13px] text-[#8c8c8c]">No branch matches &ldquo;{query}&rdquo;.</div>
            )}
          </div>
          {!loading && !error && branches && (
            <div className="mt-1 border-t border-[#f0f0f0] px-2 pt-1.5 text-[11px] text-[#8c8c8c]">
              {query
                ? `${matches.length} of ${totalLabel} branches match`
                : matches.length > shown.length
                  ? `Showing ${shown.length} of ${totalLabel}. Type to search them all.`
                  : `${totalLabel} branches`}
            </div>
          )}
        </div>
      )}
      {(loading || saving) && !open && (
        <span
          aria-label={saving ? "Saving" : "Loading branches"}
          className="h-2 w-2 animate-pulse rounded-full bg-[#595959]"
        />
      )}
      {error && !open && <span className="text-[12px] text-[#b42318]">{error}</span>}
    </span>
  );
}

function GithubRepoRow({
  fullName,
  isPrimary,
  isPrivate,
  baseBranch,
  showDivider,
  readOnly,
  blocked = false,
  onAllow,
  onSetDefault,
}: {
  fullName: string;
  isPrimary: boolean;
  isPrivate: boolean | undefined;
  baseBranch: string | undefined;
  showDivider: boolean;
  readOnly: boolean;
  blocked?: boolean;
  onAllow?: () => void;
  onSetDefault: () => void;
}) {
  const slash = fullName.indexOf("/");
  const owner = slash >= 0 ? fullName.slice(0, slash + 1) : "";
  const repo = slash >= 0 ? fullName.slice(slash + 1) : fullName;
  return (
    <div className={showDivider ? "border-t border-[#f0f0f0]" : ""}>
      <div className="group flex items-center gap-3 py-2.5">
        <div className={`flex min-w-0 flex-1 items-center gap-2 ${blocked ? "opacity-60" : ""}`}>
          {}
          <BookOpenIcon
            aria-hidden
            className={`h-5 w-5 shrink-0 ${
              isPrimary ? "text-[#167f50]" : "text-[#595959]"
            }`}
          />
          <a
            href={`https://github.com/${fullName}`}
            target="_blank"
            rel="noreferrer"
            className="truncate text-[16px] leading-[20px]"
            title={fullName}
          >
            <span className="font-normal text-[#595959]">{owner}</span>
            <span className="font-semibold text-[#0e0f11]">{repo}</span>
          </a>
        </div>
        {blocked ? (
          <>
            <span
              title="Zavi's agents can't read or change this repo."
              className="shrink-0 rounded-[3px] bg-[#f5f5f5] px-1.5 py-0.5 text-[11px] font-semibold leading-none text-[#595959]"
            >
              Not allowed
            </span>
            {!readOnly && onAllow && (
              <button
                type="button"
                onClick={onAllow}
                aria-label={`Allow Zavi to use ${fullName}`}
                className="shrink-0 rounded-[6px] border border-[#e6e6e6] px-2 py-1 text-[11px] font-semibold leading-none text-[#0e0f11] hover:border-[#d0d0d0]"
              >
                Allow
              </button>
            )}
          </>
        ) : isPrimary ? (
          <span
            title="Default repo: agents use this when a request doesn't name a product."
            className="shrink-0 rounded-[3px] bg-[#f5faf8] px-1 py-px text-[11px] font-semibold leading-none text-[#167f50]"
          >
            Primary
          </span>
        ) : (
          !readOnly && (
            <button
              type="button"
              onClick={onSetDefault}
              aria-label={`Set ${fullName} as default repo`}
              title="Agents use the default repo when a request doesn't name a specific product."
              className="shrink-0 rounded-[6px] border border-[#e6e6e6] px-2 py-1 text-[11px] font-semibold leading-none text-[#595959] opacity-0 transition-opacity hover:border-[#d0d0d0] hover:text-[#0e0f11] focus:opacity-100 focus-visible:opacity-100 group-hover:opacity-100"
            >
              Set as default
            </button>
          )
        )}
        {!blocked && (
          <GithubRepoBranchSelect
            fullName={fullName}
            baseBranch={baseBranch}
            readOnly={readOnly}
          />
        )}
        {isPrivate !== undefined && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-[36px] bg-[#f9f9f9] py-1.5 pl-2 pr-2.5 text-[13px] font-medium leading-[18px] text-[#0e0f11]">
            {isPrivate ? (
              <LockIcon className="h-4 w-4 text-[#595959]" />
            ) : (
              <GlobeIcon className="h-4 w-4 text-[#595959]" />
            )}
            {isPrivate ? "Private" : "Public"}
          </span>
        )}
        <a
          href={`https://github.com/${fullName}`}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open ${fullName} on GitHub`}
          className="shrink-0 text-[#595959] hover:text-[#0e0f11]"
        >
          <LinkSquareIcon className="h-5 w-5" />
        </a>
      </div>
    </div>
  );
}

function SocialConnectorTile({ readOnly }: { readOnly?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <ConnectorTile
        id="connector-social"
        logo={<ConnectorLockup slug="social" label="Social" />}
        name="Social"
        description={purposeFor("social", "Social")}
        status={{ tone: "idle", text: "Not connected" }}
        title="Connect a LinkedIn / Instagram / TikTok account so agents can post on your behalf."
        extra={<SocialConnectionsList />}
        action={
          readOnly ? null : (
            <TileButton onClick={() => setOpen((v) => !v)} ariaExpanded={open}>
              <span aria-hidden>Connect</span>
              <span className="sr-only">Connect Social</span>
            </TileButton>
          )
        }
      />
      {open && !readOnly && (
        <div className="col-span-full">
          <SocialConnectForm onClose={() => setOpen(false)} />
        </div>
      )}
    </>
  );
}

export function GithubInstallAnotherOrg({
  onInstall = () => {
    void startConnectFlow("github");
  },
  embedded = false,
  lead,
}: {
  onInstall?: () => void;
  embedded?: boolean;
  lead?: ReactNode;
}) {
  return (
    <div
      className={
        embedded
          ? "flex items-center gap-6 border-t border-[#f0f0f0] pt-4"
          : "flex items-center gap-6 rounded-[16px] border border-[#f0f0f0] bg-white px-4 py-3 col-span-full"
      }
    >
      <p className="min-w-0 flex-1 text-[16px] leading-[20px] text-[#0e0f11]">
        {lead ? (
          <>
            {lead}{" "}
          </>
        ) : (
          <>
            <span className="font-semibold">
              Only repos owned by the account where the Zavi GitHub App is installed
              appear here.
            </span>{" "}
            <span className="text-[#595959]">
              To add repos in another organization (e.g. where you&rsquo;re a
              contributor), install Zavi on that organization too.
            </span>{" "}
          </>
        )}
        <a
          href="https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app"
          target="_blank"
          rel="noreferrer"
          className="font-semibold text-[#027bff] hover:underline"
        >
          Learn more
        </a>
      </p>
      <button
        type="button"
        onClick={onInstall}
        className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-cta border border-[#f0f0f0] bg-white px-4 text-[16px] font-semibold leading-[20px] tracking-[0.01px] text-[#1f1f1f] transition-colors hover:border-[#e0e0e0] hover:bg-[#fafafa]"
      >
        <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M12 5v14M5 12h14" />
        </svg>
        Install on another organization
        <LinkSquareIcon className="h-5 w-5 text-[#595959]" />
      </button>
    </div>
  );
}

export function RepoChips({
  names,
  ids,
  selectedIds,
  defaultRepo,
  readOnly,
  onSetDefault,
}: {
  names: string[];
  ids?: number[];
  selectedIds?: number[] | null;
  defaultRepo?: string;
  readOnly?: boolean;
  onSetDefault: (name: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const VISIBLE = 5;

  const haveIds = Array.isArray(ids) && ids.length === names.length;
  const isScoped = haveIds && Array.isArray(selectedIds);
  const reachable = (i: number): boolean => {
    if (!isScoped) return true;
    return (selectedIds as number[]).includes((ids as number[])[i]);
  };

  const items = names.map((full, i) => ({ full, i, ok: reachable(i) }));
  const ordered = isScoped
    ? [...items].sort((a, b) => Number(b.ok) - Number(a.ok))
    : items;
  const visible = expanded ? ordered : ordered.slice(0, VISIBLE);
  const hidden = ordered.length - visible.length;
  const hiddenReachable = isScoped
    ? ordered.slice(VISIBLE).filter((it) => it.ok).length
    : 0;

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      {visible.map(({ full, ok }) => {
        const short = full.includes("/") ? full.slice(full.indexOf("/") + 1) : full;
        const isDefault = defaultRepo === full;
        return (
          <span
            key={full}
            className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[11px] ${
              isDefault
                ? "border-ink bg-ink text-bone"
                : ok
                  ? "border-ink/10 bg-bone text-ink"
                  : "border-dashed border-ink/15 bg-bone/40 text-inkMuted"
            }`}
            title={
              ok
                ? full
                : `${full}: not reachable (limited by repo access)`
            }
          >
            <a
              href={`https://github.com/${full}`}
              target="_blank"
              rel="noreferrer"
              className={`${isDefault ? "text-bone" : ok ? "text-ink" : "text-inkMuted line-through decoration-ink/30"}`}
            >
              {short}
            </a>
            {!ok && (
              <span
                aria-hidden
                title="Not reachable: limited by repo access"
                className="leading-none text-inkMuted"
              >
                🚫
              </span>
            )}
            {isDefault ? (
              <span aria-hidden title="Default repo" className="leading-none">
                ★
              </span>
            ) : (
              !readOnly && (
                <button
                  type="button"
                  onClick={() => onSetDefault(full)}
                  aria-label={`Set ${full} as default repo`}
                  title="Set as default repo"
                  className="leading-none"
                >
                  ☆
                </button>
              )
            )}
          </span>
        );
      })}
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="font-mono text-[11px] text-inkMuted hover:text-ink"
          title={
            hiddenReachable > 0
              ? `${hiddenReachable} of these are reachable`
              : undefined
          }
        >
          +{hidden} more
        </button>
      )}
      {isScoped && (
        <span className="ml-1 inline-flex items-center gap-1 font-mono text-[11px] text-inkMuted">
          <span aria-hidden>🚫</span> = not reachable
        </span>
      )}
    </div>
  );
}
