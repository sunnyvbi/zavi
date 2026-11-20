import type { LucideIcon } from "lucide-react";
import type { PostImageSize } from "@zavi/shared";
import type { MetricDisplay, PerRow } from "../metrics/SummaryRow";
import type { ActionItem, ChannelScanSpec, ChannelPayloadSpec, ExtraId, OverviewPanelId, SettingsBadgeId, SettingsField, SettingsPanelId } from "./types";

export type TopActionSpec = {
  key: string;
  label: string;
  modal: "plan" | "form" | "boost_post" | "chatgpt_campaign" | "meta_campaign" | "google_campaign" | "tiktok_campaign" | "scan" | "drawer" | "tab";
  drawer?: "brief";
  tab?: "studio";
  lead?: string;
  fields?: readonly TopActionField[];
  primary?: string;
  hint?: string;
  note?: string;
  done?: string;
  closeOnDone?: boolean;
  submit?: "run" | "linkedin_campaign_draft" | "social_propose" | "tiktok_drafts" | "reddit_community" | "geo_prompt" | "geo_rival" | "video_starters";
  socialChannel?: "instagram_image" | "x_image" | "linkedin_image" | "pinterest_pin";
  writes?: { key: string; done: string };
  postNow?: { stageLabel: string; needsWords: string };
  notReady?: string;
  ownersOnly?: string;
  consent?: string;
};

export type TopActionField =
  | {
      kind: "text" | "area" | "url";
      name: string;
      label: string;
      placeholder?: string;
      hint?: string;
      max?: number;
      measure?: (text: string) => number;
      optional?: boolean;
      error?: string;
      accepts?: "youtube_video" | "x_posts" | "subreddit";
      defaultFrom?: string;
    }
  | {
      kind: "money";
      name: string;
      label: string;
      hint?: string;
      initial?: string;
      above?: number;
      atLeast?: number;
      perDay?: boolean;
      optional?: boolean;
      error?: string;
    }
  | { kind: "choice"; name: string; label: string; options: ReadonlyArray<{ id: string; label: string; sub: string }>; initial: string }
  | { kind: "multi_select"; name: string; label: string; hint?: string; options?: ReadonlyArray<{ id: string; label: string }>; from?: string; allLabel: string; max: number }
  | { kind: "select"; name: string; label: string; hint?: string;  from: string; empty: string; unavailable?: string; partial?: string; disconnected?: string; pinterestBoards?: true }
  | { kind: "places"; name: string; label: string; hint?: string; from?: string; optional?: boolean; max?: number; placeholder?: string; notIn?: string; takenLabel?: string }
  | { kind: "countries"; name: string; label: string; hint?: string; placeholder: string; optional?: boolean; notIn?: string; takenLabel?: string }
  | { kind: "video"; name: string; label: string; hint?: string; from: string; uploadOnly?: boolean }
  | { kind: "image"; name: string; label: string; hint?: string };

export type PlatformSpec = {
  paidAnalytics?: "meta" | "google" | "youtube" | "tiktok" | "x" | "reddit";
  adsAccountPlatform?: "chatgpt" | "linkedin";
  name: string;
  directPublishOnly?: boolean;
  noSnooze?: boolean;
  markDone?: boolean;
  weekCalendar?: boolean;
  description?: string;
  icon?: LucideIcon;
  charLimit?: number;
  maxThreadPosts?: number;
  measure?: (text: string) => number;
  composerUrl?: (text: string, action: ActionItem) => string | null;
  composerLabel?: string;
  account?: { name: string; handle?: string | null };
  accountFromPayload?: (payload: unknown) => PlatformSpec["account"];
  hidePublishingAccount?: boolean;
  metricDisplay?: Record<string, MetricDisplay>;
  metricLayout?: {
    variant?: "grid" | "spend" | "score";
    perRow?: PerRow;
    pacingKey?: string;
    lead?: readonly string[];
    startClosed?: boolean;
  };
  requireActionResponsibility?: boolean;
  execCopy?: {
    working: string;
    done: string;
    doneFor?: (a: ActionItem) => string;
    failedTitle: string;
    failedHint: string;
    waiting?: string;
    partialTitle?: string;
    temporaryHint?: string;
  };
  starters?: boolean;
  studio?: boolean;
  postsNoun?: string;
  execPartial?: { href: string; label: string };
  priorItemsCopy?: { title: string; help: string };
  campaignWorkspace?: import("./managed-campaigns/types").CampaignWorkspaceSpec;
  sponsoredPostReview?: { actionReviewPath: string; title: string };
  accountReadable?: (dashboard: unknown) => boolean;
  kpiFallback?: "chatgpt" | "gads" | "x" | "reddit" | "seo" | "geo" | "linkedin" | "meta" | "instagram" | "pinterest" | "tiktok" | "tiktok_ads" | "reddit_ads" | "linkedin_ads" | "x_ads";
  dashboardSlug?: string;
  manageUrl?: string;
  taskLink?: (targetKind: string | null, accountId: string | null) => string | null;
  taskLinkLabel?: string;
  scan?: ChannelScanSpec;
  headerAction?: { label: string; drawer: "find" };
  newItem?: { label: string; request: string };
  topActions?: readonly TopActionSpec[];
  createMenu?: string;
  createDirect?: true;
  analyticsView?: "pinterest" | "x";
  planDayLine?: false;
  pinCards?: true;
  postImageSizes?: ReadonlyArray<{ value: PostImageSize; label: string }>;
  headTools?: "email_campaign";
  runIsSecondary?: true;
  hideRunCost?: true;
  hideAccountSnapshot?: true;
  hideStrategyPrompt?: true;
  analyticsLead?: "geo";
  topActionsInHeading?: true;
  doneHistory?: true;
  compactSections?: true;
  workCard?: true;
  creatorMessages?: boolean;
  payload?: ChannelPayloadSpec;
  sectionTitle?: string;
  sectionLead?: string;
  tablesLast?: boolean | readonly string[];
  stagedCards?: (payload: unknown, actions: ActionItem[]) => ActionItem[];
  maxWidth?: string;
  isDecisionId?: boolean;
  settings?: readonly SettingsField[];
  postingSettings?: { accountFromPayload: (payload: unknown) => string | null; connectionName: string; connectionLogo: string };
  settingsPanels?: readonly SettingsPanelId[];
  settingsBadge?: SettingsBadgeId;
  actionsLeadPanels?: readonly OverviewPanelId[];
  overviewPanels?: readonly OverviewPanelId[];
  overviewTopPanels?: readonly OverviewPanelId[];
  extras?: readonly ExtraId[];
  adAccountPicker?: "tiktok_ads";
  spendSettings?: boolean;
  connect?: () => void | Promise<unknown>;
  connectCopy?: { blurb: string; link: string; also?: string };
  railConnect?: { toolkit: string; native: string; label: string };
  publish?: (
    action: ActionItem,
    content: { text: string; thread: string[] | null; image_path?: string; post_revision?: string },
    context?: { tenantId?: string | null },
  ) => Promise<boolean>;
  publishBlocked?: (action: ActionItem, text: string) => string | null;
};

export const showsAccountSnapshot = (spec: Pick<PlatformSpec, "hideAccountSnapshot">): boolean => spec.hideAccountSnapshot !== true;
