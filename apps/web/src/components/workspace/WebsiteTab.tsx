"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import {
  useResizablePane,
  type ClampSpec,
  type UseResizablePaneOptions,
} from "@/hooks/useResizablePane";
import {
  ArrowLeft,
  History,
  Loader2,
  Menu,
  MessageSquare,
  Monitor,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  X,
} from "lucide-react";
import { BuildHistoryPanel, type CheckpointView } from "./build/BuildHistoryPanel";
import {
  EMPTY_REVISION_BASELINE,
  advanceRevisionBaseline,
  busyRefineKey,
  gainedBusyRefine,
  landedRefine,
  previewPathToOpen,
  previewRevisionOf,
  refineShippedSince,
  shippedRefineRevision,
  startBuildRefine,
  isHeldChange,
  type BuildRefine,
  type RefineSelection,
} from "@/lib/workspace/useBuildSession";
import { sendSiteEditsOptimistic, siteEditsAppId, useSiteEditsApply, useSiteEditsSession, type SiteTextEditSnapshot } from "@/lib/workspace/siteInlineEdits";
import { isOldSiteFrozen } from "@/lib/workspace/oldSiteRebuild";
import { apiFetch } from "@/lib/api";
import { SlidingIndicator, useSlidingIndicator } from "@/components/ui/SlidingIndicator";
import { useWorkspace } from "./WorkspaceShell";
import { AppStartingScreen, WebsitePreview, type PreviewPick } from "./website/WebsitePreview";
import { PreviewStoppedScreen } from "./website/PreviewStoppedScreen";
import { restartBuildPreview } from "@/lib/workspace/buildPreviewRestart";
import { AppInitialTile } from "./website/AppInitialTile";
import { appDisplayName } from "./website/appDisplayName";
import {
  resolveBuildRefine,
  resolveWebsiteChatEdit,
  siteChangeFailureText,
  type SiteChangeResult,
  type BeforeSendResult,
} from "./website/websiteChatEdit";
import { WebsiteConsole } from "./website/WebsiteConsole";
import { PublishPopover } from "./website/PublishPopover";
import { prefetchPublishPopover } from "./website/publishReads";
import { BuildShareButton } from "./build/BuildSharePopover";
import { prefetchWorkspaceMembers } from "@/hooks/workspaceMembersCache";
import {
  PUBLISH_WAITS_TITLE,
  PUBLISHING_TITLE,
  PublishTrigger,
  publishTriggerMode,
  siteAwaitingFirstBuild,
  sitePublishOnRequest,
} from "./website/PublishTrigger";
import {
  BUILD_RUN_RESUMED_EVENT,
  PUBLISH_PICKUP_MAX_TICKS,
  PUBLISH_PICKUP_POLL_MS,
  buildPublishesOnRequest,
  publishRequestStillPending,
  publishWentLive,
  type PublishWatch,
} from "@/lib/workspace/buildPublish";
import { SITE_NOT_PUBLISHED } from "@/lib/workspace/buildFraming";
import { toast } from "@/components/ui/toast";
import { confirmAction } from "@/components/ui/ConfirmDialog";
import { useVersionPreview } from "@/lib/workspace/useVersionPreview";
import { useLiveEdit } from "@/lib/workspace/useLiveEdit";
import { settledChimeStatus, useBuildDoneChime } from "@/lib/workspace/buildChime";
import { watchRestoreDeploy, shortVersionTitle, publishCopy } from "@/lib/workspace/restoreDeploy";
import { readWebsiteParam, writeWebsiteParam, WEBSITE_MODE_KEY } from "./website/websiteUrlParams";
import { takeZaviBuilderDraft } from "./actions/zaviBuilder";
import { previewSource } from "./website/previewSourceLabel";
import { PreviewLoadingScreen, WebsiteBuildProgress } from "./website/WebsiteBuildProgress";
import { LookPicker } from "./build/LookPicker";
import { useSiteDesign } from "@/lib/workspace/useSiteDesign";
import { designAwaitsPick } from "@/lib/workspace/buildEstimate";
import {
  BUILD_PREVIEW_MIN_PX,
  PREVIEW_MIN_SCREEN_FRACTION,
} from "./layout/buildSplit";
import { HomeChatPanel } from "./home/calm/HomeChatPanel";
import { composePickerPrefill, type PickedElement } from "./home/previewPicker";
import { loadSummary } from "./home/summaryState";
import type { HomeSummaryPayload } from "./home/types";
import { isTerminalBuildRun, useBuildPreview, type BuildSite } from "@/lib/workspace/useBuildPreview";
import { SearchHoldNote } from "./build/SearchHoldNote";
import { useOptimisticBuildStart } from "@/lib/workspace/optimisticBuildStart";
import { ExportToGithubButton, prefetchExportStatus, refreshExportStatusAfterEdit } from "./home/ExportToGithubButton";
import { GithubMark } from "./GithubMark";
import {
  BuildStoppedPane,
  BuildTranscriptContent,
  useBuildTimelineItems,
  canRetryFailedBuild,
  canStartAgain,
  canStopBuild,
  PUBLISH_CHANGES_BLOCKED,
  RETRY_FALLBACK_CODES,
  visibleRefines,
} from "./build/BuildModePane";
import { BUILD_SITE_PUBLISHED_EVENT, latestBusyRefine, sitePublishLanded, undoBuildRefine, useBuildSession } from "@/lib/workspace/useBuildSession";
import { refineSandboxPreviewRunId } from "@/lib/workspace/refineSandboxPreview";
import { heldPreviewFrame, samePreviewHold, type PreviewHold } from "@/lib/workspace/previewHold";
import { usePreviewErrorFix } from "./website/previewErrorGate";
import { useRefineSandboxPreview } from "@/lib/workspace/useRefineSandboxPreview";
import {
  WEBSITE_BUILD_SUGGESTIONS,
  WEBSITE_COMPOSER_HINTS,
  useWebsiteFraming,
} from "@/lib/workspace/buildFraming";
import { AppCodePane, ReadOnlyBadge } from "./build/AppCodePane";
import { DownloadCodeButton } from "./build/DownloadCodeButton";
import type { FileRef } from "@/lib/workspace/fileRefs";
import { BuildFilesPane } from "./build/BuildFilesPane";
import {
  BUILD_SURFACE_TABS_WIDTH,
  BuildSurfaceTabs,
  buildSurfacePanelId,
  type BuildSurfaceTab,
} from "./build/BuildSurfaceTabs";
import { isZaviHostedRepoUrl } from "./build/existingProduct";
import { repoNameFromUrl } from "@/lib/workspace/exportGithubCopy";
import { notifyBuildSessionsChanged, useBuildSessions } from "@/lib/workspace/useBuildSessions";
import { siteHref, siteName, type BuildSessionSite } from "@/lib/workspace/buildHistory";
import { BuildMobileActions } from "./build/BuildMobileActions";

type ProductUrl = { marketing?: string; api?: string };
export type Mode = "dashboard" | "preview";

type TenantResource = {
  resource_kind: string;
  mode?: string | null;
  status: string;
  external_ref?: Record<string, unknown> | null;
};

function takeSeq(order: { applied: number }, seq: number): boolean {
  if (seq <= order.applied) return false;
  order.applied = seq;
  return true;
}

function readBuiltAppUrl(resources: TenantResource[]): string | null {
  const hosting = resources.find((r) => r.resource_kind === "hosting");
  if (!hosting || hosting.status !== "ready") return null;
  const u = hosting.external_ref?.url;
  return typeof u === "string" && u.length > 0 ? u : null;
}

function readBuiltinLiveUrl(resources: TenantResource[]): string | null {
  const d = resources.find((r) => r.resource_kind === "domain");
  const ref = d?.external_ref;
  if (!ref || ref.status !== "live") return null;
  const host = ref.hostname;
  return typeof host === "string" && host.length > 0 ? `https://${host}` : null;
}

function servableMarketingUrl(
  url: string | null | undefined,
  buildRetired: boolean | null,
): string | null {
  if (!url) return null;
  if (buildRetired === false) return url;
  try {
    return new URL(url).hostname.endsWith(".onrender.com") ? null : url;
  } catch {
    return null;
  }
}

function readRepoManaged(resources: TenantResource[]): boolean | null {
  const mode = resources.find((r) => r.resource_kind === "repo")?.mode;
  return mode === "provisioned" ? true : mode === "connected" ? false : null;
}

function readRepoUrl(resources: TenantResource[]): string | null {
  const repo = resources.find((r) => r.resource_kind === "repo");
  const ref = repo?.external_ref;
  if (!ref) return null;
  const html = ref.html_url;
  if (typeof html === "string" && html.startsWith("http")) return html;
  const full = ref.github_full_name ?? ref.full_name;
  return typeof full === "string" && full.includes("/")
    ? `https://github.com/${full}`
    : null;
}

const SUGGESTIONS = [
  "What did the team do this week?",
  "What needs my attention right now?",
  "Draft a short update for investors",
];

const CHAT_WIDTH_KEY = "zavi.websiteChatWidth";
const MENU_OPEN_EVENT = "zavi:menu-open";
const HEADER_POPOVER_ID = "website-tab-header";
const BUILD_CHAT_WIDTH_KEY = "zavi.buildAppChatWidth";
const CHAT_MIN_PX = 340;
const CHAT_MAX_FRACTION = 0.4;
const CHAT_DEFAULT_PX = 405;
const BUILD_CHAT_MIN_PX = 420;
const BUILD_CHAT_DEFAULT_PX = 460;

const CHAT_CLAMP: ClampSpec = {
  min: CHAT_MIN_PX,
  maxFraction: CHAT_MAX_FRACTION,
  round: "max",
};

export const WEBSITE_CHAT_PANE_OPTIONS: UseResizablePaneOptions = {
  ...CHAT_CLAMP,
  storageKey: CHAT_WIDTH_KEY,
  defaultPx: CHAT_DEFAULT_PX,
  resetTo: CHAT_DEFAULT_PX,
  trackDragging: true,
  ariaLabel: "Resize chat",
};

export type AppWorkspaceVariant = "website" | "build";

export function websiteChatClassifyBody(
  message: string,
  boundBuildSessionId: string | null,
  scoped = false,
): { message: string; conductor_run_id?: string; scoped?: true } {
  if (!boundBuildSessionId) return { message };
  return scoped ? { message, conductor_run_id: boundBuildSessionId, scoped: true } : { message, conductor_run_id: boundBuildSessionId };
}

export function refineSelectionOf(pick: PreviewPick): RefineSelection {
  return {
    selector: pick.selector,
    tag: pick.tag,
    ...(pick.text.trim() ? { text: pick.text.trim().slice(0, 200) } : {}),
    path: pick.path,
    ...(pick.src ? { src: pick.src } : {}),
  };
}

export function websiteChatSide(variant: AppWorkspaceVariant): "left" | "right" {
  return variant === "build" ? "left" : "right";
}

export function remembersWebsiteMode(variant: AppWorkspaceVariant): boolean {
  return variant !== "build";
}

export function buildChatKey(sessionId: string | null): string {
  return `build-chat-${sessionId ?? "unstarted"}`;
}

export function initialWebsiteMode(
  variant: AppWorkspaceVariant,
  urlView: string | null,
  savedView: string | null,
): Mode {
  if (!remembersWebsiteMode(variant)) return "preview";
  for (const candidate of [urlView, savedView]) {
    if (candidate === "dashboard" || candidate === "preview") return candidate;
  }
  return "preview";
}

export function websiteChatDefaultPx(variant: AppWorkspaceVariant): number {
  return variant === "build" ? BUILD_CHAT_DEFAULT_PX : CHAT_DEFAULT_PX;
}

const buildChatCeilingPx = (rowWidth: number) => {
  const screen =
    typeof window === "undefined" ? rowWidth : window.innerWidth || rowWidth;
  return (
    rowWidth -
    Math.max(BUILD_PREVIEW_MIN_PX, screen * PREVIEW_MIN_SCREEN_FRACTION)
  );
};

export function websiteChatPaneOptions(
  variant: AppWorkspaceVariant,
  containerRef?: RefObject<HTMLElement | null>,
): UseResizablePaneOptions {
  const defaultPx = websiteChatDefaultPx(variant);
  const base: UseResizablePaneOptions = {
    ...WEBSITE_CHAT_PANE_OPTIONS,
    anchor: websiteChatSide(variant),
    defaultPx,
    resetTo: defaultPx,
  };
  if (variant !== "build") return base;
  return {
    ...base,
    min: BUILD_CHAT_MIN_PX,
    storageKey: BUILD_CHAT_WIDTH_KEY,
    containerRef,
    maxFraction: undefined,
    maxFn: buildChatCeilingPx,
    keyboard: true,
  };
}

export function shouldAutoExpandWebsiteChat(
  previewUrl: string | null,
  building: boolean = false,
  previewRestartable: boolean = false,
): boolean {
  return previewUrl === null && !building && !previewRestartable;
}

export function servableHostingUrls(
  building: boolean,
  builtinLiveUrl: string | null,
  builtAppUrl: string | null,
): { builtinLiveUrl: string | null; builtAppUrl: string | null } {
  if (building) return { builtinLiveUrl: null, builtAppUrl: null };
  return { builtinLiveUrl, builtAppUrl };
}

export function buildPaneSources(input: {
  isBuild: boolean;
  site: BuildSite | null | undefined;
  marketingUrl: string | null;
  hosted: { builtinLiveUrl: string | null; builtAppUrl: string | null };
  buildPreviewUrl: string | null;
  appUrl: string | null;
  repoUrl: string | null;
  appRepoUrl: string | null;
  pending?: boolean;
  previewStopped?: boolean;
}): { previewUrl: string | null; repoUrl: string | null; builtinLiveUrl: string | null; builtAppUrl: string | null } {
  const { isBuild, site, hosted } = input;
  if (isBuild && input.pending) {
    return { previewUrl: null, repoUrl: null, builtinLiveUrl: null, builtAppUrl: null };
  }
  if (isBuild && site) {
    return {
      previewUrl:
        (site.unpublished || site.unpublishedUnknown ? input.buildPreviewUrl : null) ??
        site.liveUrl ??
        input.buildPreviewUrl ??
        (input.previewStopped ? null : input.appUrl) ??
        null,
      repoUrl: site.repoUrl ?? input.appRepoUrl ?? null,
      builtinLiveUrl: null,
      builtAppUrl: null,
    };
  }
  return {
    previewUrl:
      (isBuild ? null : input.marketingUrl) ??
      hosted.builtinLiveUrl ??
      hosted.builtAppUrl ??
      input.buildPreviewUrl ??
      (isBuild ? input.appUrl : null) ??
      null,
    repoUrl: input.repoUrl ?? (isBuild ? input.appRepoUrl : null),
    builtinLiveUrl: hosted.builtinLiveUrl,
    builtAppUrl: hosted.builtAppUrl,
  };
}

export function paneAppName(input: {
  siteNames: boolean;
  site: BuildSessionSite | null | undefined;
  appHost: string | null;
  tenantName: string | null | undefined;
}): string | null {
  return (input.siteNames ? siteName(input.site) : null) ?? appDisplayName(input.site?.hostname ?? input.appHost, input.tenantName);
}

function finishedUndoRevision(refines: BuildRefine[]): string | null {
  const undo = [...refines].reverse().find((r) => r.kind === "undo" && r.status === "done");
  return undo ? undo.id : null;
}

export function shouldShowStoppedBuildPane(input: {
  isBuild: boolean;
  stoppedByFounder: boolean;
  buildStarting: boolean;
  viewingCheckpoint: boolean;
}): boolean {
  return input.isBuild && input.stoppedByFounder && !input.buildStarting && !input.viewingCheckpoint;
}

export function shouldShowWebsiteBuildProgress(
  previewUrl: string | null,
  building: boolean,
  buildStarting: boolean,
  buildFailed: boolean,
  settledNonce: number,
  appReady = true,
): boolean {
  return buildStarting || (building && !appReady) || (previewUrl === null && (building || (buildFailed && settledNonce > 0)));
}

export const WAITING_PREVIEW_KEY = "build-waiting";

export type WaitingPane = "stopped" | "progress" | "latest-draft" | "preview-stopped" | "preview-pending";

export function waitingPaneOf(input: {
  showStoppedPane: boolean;
  showBuildProgress: boolean;
  awaitingLookPick: boolean;
  isBuild: boolean;
  loadingLatestDraft: boolean;
  frameUrl: string | null;
  historyBooting: boolean;
  checkpointView: boolean;
  previewState: unknown;
}): WaitingPane | null {
  if (input.showStoppedPane) return "stopped";
  if (input.showBuildProgress || input.awaitingLookPick) return "progress";
  if (input.isBuild && input.loadingLatestDraft) return "latest-draft";
  if (input.isBuild && input.frameUrl === null && !input.historyBooting && !input.checkpointView && input.previewState) return "preview-stopped";
  if (input.isBuild && input.frameUrl === null && !input.historyBooting) return "preview-pending";
  return null;
}

export function websitePreviewKey(previewUrl: string | null, _reloadKey: number): string {
  return previewUrl ?? "no-url";
}

function greetingName(email?: string): string | null {
  if (!email) return null;
  const local = (email.split("@")[0] ?? "").replace(/[._-]/g, " ").replace(/\d+/g, " ");
  const first = local.trim().split(/\s+/)[0] ?? "";
  if (first.length < 2) return null;
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}
function timeGreeting(now: Date): string {
  const h = now.getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}
function countAnswered(runs: HomeSummaryPayload["active_runs_today"]): number {
  let n = 0;
  for (const r of runs) {
    if (r.presentation_status) {
      if (r.presentation_status === "answered") n++;
    } else if (r.status === "success") n++;
  }
  return n;
}

export function WebsiteTab() {
  return <AppWorkspace variant="website" />;
}

export type AppWorkspaceProps = {
  variant?: AppWorkspaceVariant;
  appUrl?: string | null;
  appUrlLive?: boolean;
  appRevision?: string | null;
  appRepoUrl?: string | null;
  buildLogOpen?: boolean;
  onToggleBuildLog?: () => void;
  onOpenNav?: () => void;
};

export function AppWorkspace({
  variant = "website",
  appUrl = null,
  appUrlLive = true,
  appRevision = null,
  appRepoUrl = null,
  buildLogOpen = false,
  onToggleBuildLog,
  onOpenNav,
}: AppWorkspaceProps = {}) {
  const isBuild = variant === "build";
  const { userEmail, openTab, tenantName, tabs, setTabThreadId, role } = useWorkspace();
  const buildTab = tabs.find((tab) => tab.payload.kind === "build");
  const buildThreadId =
    buildTab?.payload.kind === "build" ? (buildTab.payload.threadId ?? null) : null;
  const chatKey =
    buildTab?.payload.kind === "build"
      ? buildChatKey(buildTab.payload.sessionId)
      : undefined;
  const buildSessionId =
    buildTab?.payload.kind === "build" ? buildTab.payload.sessionId : null;
  const buildConversation = useBuildSession(isBuild ? buildSessionId : null, null);
  const { sessions: buildSessionRows = [], flags: siteFlags, uiFlags } = useBuildSessions();
  const sessionRow = isBuild && buildSessionId ? buildSessionRows.find((row) => row.id === buildSessionId) : undefined;
  const sessionSite = sessionRow?.site ?? null;
  const threadFollowsBuild = isBuild && uiFlags?.chatThreadFollowsBuild === true;
  const linkedThreadIds = threadFollowsBuild ? (sessionRow?.chat_thread_ids ?? []) : [];
  const chatThreadId = buildThreadId ?? linkedThreadIds[0] ?? null;
  const mobileActionsOn = isBuild && uiFlags?.mobileActions === true;
  const refineSandboxUrl = useRefineSandboxPreview(
    isBuild ? refineSandboxPreviewRunId(buildConversation.refines) : null,
  );
  const buildRunId = buildConversation.run?.id ?? null;
  const usageKey = isBuild && buildRunId
    ? [buildRunId, ...buildConversation.refines.map((refine) => refine.id)].join(",")
    : "";
  const usageRunIds = useMemo(() => (usageKey ? usageKey.split(",") : null), [usageKey]);
  const usageChangeCount = visibleRefines(buildConversation.refines).length;
  const shippedRevision = isBuild ? shippedRefineRevision(buildConversation.refines) : null;
  const runningChange = isBuild
    ? latestBusyRefine(buildConversation.refines)
    : null;
  const websiteFraming = useWebsiteFraming(isBuild) === true;
  const buildTabId = buildTab?.id ?? null;
  const [chatHidden, setChatHidden] = useState(false);
  const [buildLastAt, setBuildLastAt] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const closeHistory = useCallback(() => setHistoryOpen(false), []);
  const [checkpointView, setCheckpointView] = useState<CheckpointView | null>(null);
  const [reverting, setReverting] = useState(false);
  const [revertError, setRevertError] = useState<string | null>(null);
  useEffect(() => {
    setCheckpointView(null);
    setRevertError(null);
  }, [buildSessionId]);
  const refreshedThreadsRef = useRef(new Set<string>());
  const linkedKey = linkedThreadIds.join(",");
  useEffect(() => {
    if (!buildThreadId || !threadFollowsBuild || !buildSessionId || linkedKey.split(",").includes(buildThreadId)) return;
    const key = `${buildSessionId}:${buildThreadId}`;
    if (refreshedThreadsRef.current.has(key)) return;
    refreshedThreadsRef.current.add(key);
    notifyBuildSessionsChanged();
  }, [buildThreadId, threadFollowsBuild, buildSessionId, linkedKey]);
  const bindBuildThread = useCallback(
    (id: string | null) => {
      if (!buildTabId) return;
      setTabThreadId(buildTabId, id);
    },
    [buildTabId, setTabThreadId],
  );
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [narrowView, setNarrowView] = useState<"chat" | "app">(isBuild ? "app" : "chat");
  const [exportOpen, setExportOpen] = useState(false);
  const [mobileSheet, setMobileSheet] = useState<"publish" | "export" | null>(null);
  useEffect(() => {
    if (isBuild && buildSessionId) void prefetchExportStatus(buildSessionId);
  }, [isBuild, buildSessionId]);
  useEffect(() => {
    setExportOpen(false);
    setPublishOpen(false);
  }, [narrowView]);
  useEffect(() => {
    if (!isBuild || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(min-width: 1024px)");
    const close = () => {
      setExportOpen(false);
      setPublishOpen(false);
      setMobileSheet(null);
    };
    mq.addEventListener?.("change", close);
    return () => mq.removeEventListener?.("change", close);
  }, [isBuild]);
  const exportRef = useRef<HTMLDivElement | null>(null);
  const githubButtonRef = useRef<HTMLButtonElement | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready">("loading");
  const [mode, setMode] = useState<Mode>("preview");
  const [buildPane, setBuildPane] = useState<BuildSurfaceTab>("preview");
  const [visitedPanes, setVisitedPanes] = useState<ReadonlySet<"files" | "code">>(new Set());
  const buildSurfaceTab: BuildSurfaceTab | null = mode === "dashboard" ? null : buildPane;
  const mountedSurfacePanels = useMemo<ReadonlySet<BuildSurfaceTab>>(
    () => new Set<BuildSurfaceTab>(["preview", ...visitedPanes]),
    [visitedPanes],
  );
  const selectBuildSurfaceTab = useCallback((tab: BuildSurfaceTab) => {
    writeWebsiteParam("section", null);
    if (tab === "files" || tab === "code") {
      setVisitedPanes((prev) => (prev.has(tab) ? prev : new Set([...prev, tab])));
    }
    setBuildPane(tab);
    setMode("preview");
  }, []);
  const closeBuildSettings = useCallback(() => {
    writeWebsiteParam("section", null);
    setMode("preview");
  }, []);
  const toggleBuildSettings = useCallback(() => {
    if (mode === "dashboard") closeBuildSettings();
    else setMode("dashboard");
  }, [mode, closeBuildSettings]);
  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = window.localStorage.getItem(WEBSITE_MODE_KEY);
    } catch {
    }
    const initial = initialWebsiteMode(variant, readWebsiteParam("view"), saved);
    if (initial !== "preview") setMode(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (remembersWebsiteMode(variant)) {
      try {
        window.localStorage.setItem(WEBSITE_MODE_KEY, mode);
      } catch {
      }
    }
    writeWebsiteParam("view", mode);
  }, [mode, variant]);
  const [productUrl, setProductUrl] = useState<ProductUrl>({});

  const [builtAppUrl, setBuiltAppUrl] = useState<string | null>(null);
  const [builtinLiveUrl, setBuiltinLiveUrl] = useState<string | null>(null);
  const [repoUrl, setRepoUrl] = useState<string | null>(null);
  const [repoManaged, setRepoManaged] = useState<boolean | null>(null);
  const [buildRetired, setBuildRetired] = useState<boolean | null>(null);

  const [pickSeed, setPickSeed] = useState<{ text: string; nonce: number; files?: FileRef[] } | null>(null);
  const [refusedRetryRunId, setRefusedRetryRunId] = useState<string | null>(null);
  const pickNonceRef = useRef(0);
  const [scopePick, setScopePick] = useState<PreviewPick | null>(null);
  const scopePickRef = useRef<PreviewPick | null>(null);
  scopePickRef.current = scopePick;
  const [clearPickKey, setClearPickKey] = useState(0);
  const removeScopePick = useCallback(() => {
    setScopePick(null);
    setClearPickKey((k) => k + 1);
  }, []);

  const [publishOpen, setPublishOpen] = useState(false);
  const publishBusyRef = useRef(false);
  const onPublishBusyChange = useCallback((busy: boolean) => {
    publishBusyRef.current = busy;
  }, []);
  const deployWatchesRef = useRef(new Set<AbortController>());
  useEffect(() => {
    const watches = deployWatchesRef.current;
    return () => {
      watches.forEach((c) => c.abort());
      watches.clear();
    };
  }, []);
  const watchDeploy = useCallback((args: Omit<Parameters<typeof watchRestoreDeploy>[0], "signal">) => {
    const controller = new AbortController();
    deployWatchesRef.current.add(controller);
    return watchRestoreDeploy({ ...args, signal: controller.signal }).finally(() => {
      deployWatchesRef.current.delete(controller);
    });
  }, []);
  const publishRef = useRef<HTMLDivElement | null>(null);
  const [previewReloadKey, setPreviewReloadKey] = useState(0);

  const [navSignal, setNavSignal] = useState<{ section: string; nonce: number } | null>(null);
  const navNonceRef = useRef(0);

  const [summary, setSummary] = useState<HomeSummaryPayload | null>(null);
  const [summaryLoaded, setSummaryLoaded] = useState(false);
  const [chatExpanded, setChatExpanded] = useState(false);
  const {
    sizePx: chatWidthOrNull,
    dragging: chatDragging,
    separatorProps: chatSeparatorProps,
  } = useResizablePane(websiteChatPaneOptions(variant, rootRef));
  const chatWidth = chatWidthOrNull ?? websiteChatDefaultPx(variant);
  const chatSide = websiteChatSide(variant);
  const chatOnLeft = chatSide === "left";

  const productUrlSeqRef = useRef({ issued: 0, applied: 0 });
  const resourcesSeqRef = useRef({ issued: 0, applied: 0 });
  useEffect(() => {
    let cancelled = false;
    const seq = ++productUrlSeqRef.current.issued;
    void (async () => {
      try {
        const res = await apiFetch("/api/connectors/product-url");
        if (!cancelled && res.ok) {
          const j = (await res.json()) as { product_url?: ProductUrl };
          if (takeSeq(productUrlSeqRef.current, seq)) setProductUrl(j.product_url ?? {});
        }
      } catch {
      } finally {
        if (!cancelled) setPhase("ready");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const build = useBuildPreview(true, 0, isBuild ? buildSessionId : null, isBuild ? undefined : "workspace");
  const siteDesign = useSiteDesign(isBuild ? build.runId ?? buildSessionId ?? null : null, build.building);
  const [restartingPreview, setRestartingPreview] = useState(false);
  const [restartPreviewError, setRestartPreviewError] = useState<string | null>(null);
  useEffect(() => {
    if (restartingPreview && build.previewState !== "stopped") setRestartingPreview(false);
  }, [build.previewState, restartingPreview]);
  const restartPreview = useCallback(async () => {
    const id = build.runId ?? buildSessionId;
    if (!id) return;
    setRestartingPreview(true);
    setRestartPreviewError(null);
    const r = await restartBuildPreview(id);
    if (!r.ok) {
      setRestartingPreview(false);
      setRestartPreviewError(r.message);
    }
  }, [build.runId, buildSessionId]);
  const liveEdit = useLiveEdit(isBuild && build.classified !== false && !build.site, { autoWake: !checkpointView });
  const refreshLiveEdit = liveEdit.refresh;
  useBuildDoneChime({
    active: isBuild,
    settledNonce: build.settledNonce,
    runStatus: settledChimeStatus(build),
    refines: buildConversation.refines,
  });
  const publishStatus = build.publish?.status ?? "none";
  const buildStartingEarly = useOptimisticBuildStart();
  const sourcesPending = isBuild && !!buildSessionId && (!build.loaded || build.classified === false);
  const publishWaitsOn = isBuild && uiFlags?.publishWaitsForApp === true;
  const publishOnRequestSetting = isBuild && uiFlags?.publishOnRequest === true;
  const buildTimelineItems = useBuildTimelineItems(
    isBuild ? buildSessionId : null,
    buildConversation,
    publishOnRequestSetting,
    isBuild ? chatThreadId : null,
  );
  const publishOnRequest = isBuild && buildPublishesOnRequest(build.stages ?? [], publishOnRequestSetting);
  const onRequestPublish =
    isBuild && buildSessionId
      ? sitePublishOnRequest(publishOnRequestSetting, build.site, build.runStatus, build.stages ?? [])
      : null;
  const publishStartedAt = build.publish?.startedAt ?? null;
  const [publishRequest, setPublishRequest] = useState<{ sessionId: string; startedAt: string | null } | null>(null);
  const [publishLateFor, setPublishLateFor] = useState<string | null>(null);
  const publishRequestPending =
    publishRequest !== null &&
    publishRequest.sessionId === buildSessionId &&
    publishRequestStillPending(publishStatus, publishStartedAt, publishRequest.startedAt);
  const publishRequested = onRequestPublish !== null && publishRequestPending;
  const shownPublishStatus = publishRequested ? "publishing" : publishStatus;
  useEffect(() => {
    if (!publishRequest) return;
    if (!publishRequestPending) {
      setPublishRequest(null);
      return;
    }
    const runId = publishRequest.sessionId;
    let ticks = 0;
    const timer = window.setInterval(() => {
      ticks += 1;
      if (ticks > PUBLISH_PICKUP_MAX_TICKS) {
        setPublishLateFor(runId);
        setPublishRequest(null);
        return;
      }
      window.dispatchEvent(new CustomEvent(BUILD_RUN_RESUMED_EVENT, { detail: { runId } }));
    }, PUBLISH_PICKUP_POLL_MS);
    return () => window.clearInterval(timer);
  }, [publishRequest, publishRequestPending]);
  const onSitePublishStarted = useCallback(() => {
    if (!buildSessionId) return;
    setPublishLateFor(null);
    setPublishRequest({ sessionId: buildSessionId, startedAt: publishStartedAt });
    window.dispatchEvent(new CustomEvent(BUILD_RUN_RESUMED_EVENT, { detail: { runId: buildSessionId } }));
    notifyBuildSessionsChanged();
  }, [buildSessionId, publishStartedAt]);
  const { applying: siteEditsApplying, onApplied: onSiteEditsApplied } = useSiteEditsApply(
    buildSessionId,
    build.building || runningChange !== null,
  );
  const onSitePublishRefresh = useCallback(() => {
    if (!buildSessionId) return;
    window.dispatchEvent(new CustomEvent(BUILD_RUN_RESUMED_EVENT, { detail: { runId: buildSessionId } }));
    notifyBuildSessionsChanged();
  }, [buildSessionId]);
  const siteChanges = isBuild && onRequestPublish === null ? build.site?.unpublished ?? null : null;
  const [changesPublishAsked, setChangesPublishAsked] = useState<string | null>(null);
  const changesKey = siteChanges ? `${buildSessionId}:${siteChanges.changes[0]?.id ?? ""}:${siteChanges.count}` : null;
  const changesPublishStatus =
    siteChanges && changesPublishAsked === changesKey && siteChanges.publish.status === "none"
      ? "publishing"
      : siteChanges?.publish.status ?? "none";
  const onChangesPublishStarted = useCallback(() => {
    setChangesPublishAsked(changesKey);
    onSitePublishRefresh();
  }, [changesKey, onSitePublishRefresh]);
  const lastPublishView = useRef<{ key: string; site: typeof build.site } | null>(null);
  useEffect(() => {
    if (!isBuild || !buildSessionId || !build.site) return;
    const prev = lastPublishView.current;
    lastPublishView.current = { key: buildSessionId, site: build.site };
    if (prev?.key === buildSessionId && sitePublishLanded(prev.site, build.site)) {
      window.dispatchEvent(new CustomEvent(BUILD_SITE_PUBLISHED_EVENT, { detail: { sessionId: buildSessionId } }));
    }
  }, [isBuild, buildSessionId, build.site]);
  useEffect(() => {
    if (!changesKey || changesPublishAsked !== changesKey) return;
    let ticks = 0;
    const timer = window.setInterval(() => {
      ticks += 1;
      if (ticks > PUBLISH_PICKUP_MAX_TICKS) {
        window.clearInterval(timer);
        setChangesPublishAsked(null);
        return;
      }
      onSitePublishRefresh();
    }, PUBLISH_PICKUP_POLL_MS);
    return () => window.clearInterval(timer);
  }, [changesKey, changesPublishAsked, onSitePublishRefresh]);
  const paneSources = buildPaneSources({
    isBuild,
    site: build.site,
    marketingUrl: isBuild ? null : servableMarketingUrl(productUrl.marketing, buildRetired),
    hosted: servableHostingUrls(build.building || buildStartingEarly, builtinLiveUrl, builtAppUrl),
    buildPreviewUrl: build.previewUrl,
    appUrl,
    previewStopped: !!build.previewState,
    repoUrl,
    appRepoUrl,
    pending: sourcesPending,
  });
  const publishWaits =
    publishWaitsOn &&
    !sourcesPending &&
    (!paneSources.previewUrl || ((build.building || buildStartingEarly) && !build.appReady));
  const publishMode = publishTriggerMode(
    build.appReady,
    shownPublishStatus,
    isBuild && !!buildSessionId && build.publish?.retryable === true,
    publishWaits ||
      (isBuild && !!buildSessionId && (!build.classified || siteAwaitingFirstBuild(build.site, build.appReady, publishStatus))),
    onRequestPublish === "ready",
  );
  const publishProgressInPopover = onRequestPublish !== null;
  const publishPopoverShown =
    publishMode === "publish" || (publishMode === "publishing" && publishProgressInPopover);
  const [publishRetryError, setPublishRetryError] = useState<string | null>(null);
  useEffect(() => {
    if (publishStatus !== "failed") setPublishRetryError(null);
  }, [publishStatus]);
  const retryPublish = useCallback(async () => {
    if (buildConversation.continuing) return;
    setPublishRetryError(null);
    const error = await buildConversation.continueRun();
    if (error) setPublishRetryError(error.message);
  }, [buildConversation]);
  const buildStarting = buildStartingEarly;
  const activelyBuilding = build.building || buildStarting;

  const applyResources = useCallback((resources: TenantResource[]) => {
    setBuiltAppUrl(readBuiltAppUrl(resources));
    setBuiltinLiveUrl(readBuiltinLiveUrl(resources));
    setRepoUrl(readRepoUrl(resources));
    setRepoManaged(readRepoManaged(resources));
  }, []);
  const refreshResources = useCallback(async (): Promise<boolean> => {
    const seq = ++resourcesSeqRef.current.issued;
    try {
      const res = await apiFetch("/api/workspace/autopilot");
      if (!res.ok) return false;
      const j = (await res.json()) as {
        resources?: TenantResource[] | null;
        build_retired?: boolean;
      };
      if (!takeSeq(resourcesSeqRef.current, seq)) return true;
      applyResources(Array.isArray(j.resources) ? j.resources : []);
      setBuildRetired(j.build_retired === true);
      return true;
    } catch {
      return false;
    }
  }, [applyResources]);
  useEffect(() => {
    void refreshResources();
  }, [refreshResources]);

  useEffect(() => {
    if (mode !== "preview") return;
    void refreshResources();
  }, [mode, refreshResources]);

  useEffect(() => {
    let cancelled = false;
    void loadSummary()
      .then((r) => {
        if (cancelled) return;
        if (r.status === "ok") setSummary(r.summary);
        setSummaryLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setSummaryLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!publishOpen) return;
    const onDown = (e: MouseEvent) => {
      if (publishBusyRef.current) return;
      if (publishRef.current && !publishRef.current.contains(e.target as Node)) {
        setPublishOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !publishBusyRef.current) setPublishOpen(false);
    };
    const onWindowBlur = () => {
      if (!publishBusyRef.current) setPublishOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [publishOpen]);

  const headerPopoverOpen = publishOpen || exportOpen || mobileSheet !== null;
  useEffect(() => {
    if (!headerPopoverOpen) return;
    window.dispatchEvent(new CustomEvent(MENU_OPEN_EVENT, { detail: HEADER_POPOVER_ID }));
    const onOtherMenu = (e: Event) => {
      if ((e as CustomEvent<unknown>).detail === HEADER_POPOVER_ID) return;
      setExportOpen(false);
      if (publishBusyRef.current) return;
      setPublishOpen(false);
      setMobileSheet(null);
    };
    window.addEventListener(MENU_OPEN_EVENT, onOtherMenu);
    return () => window.removeEventListener(MENU_OPEN_EVENT, onOtherMenu);
  }, [headerPopoverOpen]);

  const goHome = useCallback(() => {
    openTab({ kind: "home", title: "Home", payload: { kind: "home" }, dirty: false, pinned: true });
  }, [openTab]);

  const focusChat = useCallback(() => {
    const el = rootRef.current?.querySelector<HTMLTextAreaElement>(
      'aside[aria-label="Chat with your team"] textarea',
    );
    if (isBuild) setNarrowView("chat");
    el?.focus();
  }, [isBuild]);

  const onElementPicked = useCallback(
    (picked: PickedElement) => {
      pickNonceRef.current += 1;
      setPickSeed({ text: composePickerPrefill(picked), nonce: pickNonceRef.current });
      window.setTimeout(focusChat, 60);
    },
    [focusChat],
  );

  useEffect(() => {
    if (isBuild) return;
    const draft = takeZaviBuilderDraft();
    if (!draft) return;
    setChatHidden(false);
    pickNonceRef.current += 1;
    setPickSeed({ text: draft, nonce: pickNonceRef.current });
    window.setTimeout(focusChat, 60);
  }, [isBuild, focusChat]);

  const seedFilesOnSite = useCallback(
    (files: FileRef[]) => {
      setChatHidden(false);
      selectBuildSurfaceTab("preview");
      pickNonceRef.current += 1;
      setPickSeed({ text: "", files, nonce: pickNonceRef.current });
      window.setTimeout(focusChat, 60);
    },
    [focusChat, selectBuildSurfaceTab],
  );

  const refineActiveBuild = useCallback(
    async (message: string, optimistic = false, selection: RefineSelection | null = null, imagePaths: string[] = []) => {
      if (!isBuild || !buildSessionId) {
        return { ok: false as const, message: "This build is no longer active." };
      }
      const error = await startBuildRefine(buildSessionId, message, {
        optimistic,
        selection,
        ...(imagePaths.length > 0 ? { imagePaths } : {}),
      });
      if (!error) {
        refreshLiveEdit();
        return { ok: true as const };
      }
      if (isHeldChange(error)) return { ok: true as const, held: error.message };
      return typeof error === "string"
        ? { ok: false as const, message: error }
        : isOldSiteFrozen(error)
          ? { ok: false as const, message: error.message }
          : { ok: false as const, message: `${error.headline}${error.detail}`.trim(), credit: true };
    },
    [isBuild, buildSessionId, refreshLiveEdit],
  );

  const onBuildSuggestionSend = useCallback(
    (message: string): Promise<BeforeSendResult> =>
      resolveBuildRefine(message, refineActiveBuild),
    [refineActiveBuild],
  );

  const onBeforeSend = useCallback(
    async (message: string, imagePaths: string[] = []): Promise<BeforeSendResult> => {
      const buildBound = isBuild && !!buildSessionId;
      if (imagePaths.length > 0 && !buildBound) return { handled: false };
      let note: string | null = null;
      const pick = buildBound ? scopePickRef.current : null;
      const selection = pick ? refineSelectionOf(pick) : null;
      const result = await resolveWebsiteChatEdit(message, {
        classify: async (m) => {
          const res = await apiFetch("/api/workspace/website/chat", {
            method: "POST",
            idempotent: true,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(websiteChatClassifyBody(m, isBuild ? buildSessionId : null, !!selection)),
          });
          if (res.ok) {
            const body = (await res.json()) as { route?: string; note?: unknown };
            note = typeof body.note === "string" && body.note.trim() ? body.note.trim() : null;
            return body.route;
          }
          const body = (await res.json().catch(() => null)) as { error?: { chat?: unknown } } | null;
          const rejected = typeof body?.error?.chat === "string" ? body.error.chat.trim() : "";
          return rejected ? { rejected } : undefined;
        },
        refine: buildBound
          ? async (m) => {
              const r = await refineActiveBuild(m, false, selection, imagePaths);
              return r.ok && note ? { ...r, note } : r;
            }
          : undefined,
      });
      if (pick && result.consumed && scopePickRef.current === pick) removeScopePick();
      return result;
    },
    [isBuild, buildSessionId, refineActiveBuild, removeScopePick],
  );

  const hosted = { builtinLiveUrl: paneSources.builtinLiveUrl, builtAppUrl: paneSources.builtAppUrl };
  const hostedPreviewUrl = paneSources.previewUrl;
  const sandboxDraftShown = isBuild && !!refineSandboxUrl;
  const [editOnSandboxFor, setEditOnSandboxFor] = useState<string | null>(null);
  const [armSandboxEdit, setArmSandboxEdit] = useState(false);
  const sandboxEditUrl =
    isBuild && !!build.site && !checkpointView && !sandboxDraftShown && build.previewUrl && build.previewUrl !== hostedPreviewUrl
      ? build.previewUrl
      : null;
  const editOnSandbox = !!sandboxEditUrl && !!buildSessionId && editOnSandboxFor === buildSessionId;
  const previewUrl = sandboxDraftShown ? refineSandboxUrl : editOnSandbox ? sandboxEditUrl : hostedPreviewUrl;
  const shownRepoUrl = paneSources.repoUrl;
  const versionPreview = useVersionPreview(checkpointView && !checkpointView.url ? checkpointView.id : null);
  const [publishHoldUrl, setPublishHoldUrl] = useState<string | null>(null);
  const liveFrameUrl = liveEdit.frameUrl ?? publishHoldUrl;
  const liveFramed = !checkpointView && !!liveFrameUrl;
  const candidateFrameUrl = checkpointView
    ? checkpointView.url ?? (versionPreview.status === "live" ? versionPreview.url : null)
    : liveFrameUrl ?? previewUrl;
  const [previewHold, setPreviewHold] = useState<PreviewHold | null>(null);
  const frameRevision = isBuild ? previewRevisionOf(buildConversation.refines) : appRevision;
  const reloadCacheKey = !liveFramed && !sandboxDraftShown && previewReloadKey > 0 ? String(previewReloadKey) : null;
  const frameCacheKey =
    isBuild && !!build.site && !liveFramed && !sandboxDraftShown && frameRevision !== "initial"
      ? `${reloadCacheKey ?? "0"}-${frameRevision}`
      : reloadCacheKey;
  const shownFrame = heldPreviewFrame({
    held: previewHold,
    sessionId: buildSessionId,
    eligible: isBuild && !checkpointView && !liveFramed && !sandboxDraftShown,
    frame: {
      url: candidateFrameUrl,
      revision: frameRevision,
      cacheKey: frameCacheKey,
    },
    changing: runningChange !== null,
    previewState: build.previewState,
  });
  const nextPreviewHold = shownFrame.hold;
  useEffect(() => {
    setPreviewHold((prev) => (samePreviewHold(prev, nextPreviewHold) ? prev : nextPreviewHold));
  }, [nextPreviewHold]);
  const frameUrl = shownFrame.url;
  const previewUpdating = shownFrame.updating;
  const onPublished = useCallback(() => {
    void refreshResources().then(() => setPreviewReloadKey((k) => k + 1));
  }, [refreshResources]);
  const onEditUnavailable = useCallback(() => {
    if (!sandboxEditUrl || !buildSessionId || editOnSandbox || liveFramed) return false;
    setEditOnSandboxFor(buildSessionId);
    setArmSandboxEdit(true);
    return true;
  }, [sandboxEditUrl, buildSessionId, editOnSandbox, liveFramed]);
  useEffect(() => {
    if (armSandboxEdit) setArmSandboxEdit(false);
  }, [armSandboxEdit]);
  const previewRestartable = isBuild && !!build.previewState;
  useEffect(() => {
    if (previewUrl || previewRestartable) setChatExpanded(false);
  }, [previewUrl, previewRestartable]);
  const appHost = (() => {
    try {
      return hostedPreviewUrl ? new URL(hostedPreviewUrl).host : null;
    } catch {
      return null;
    }
  })();
  const siteSession = isBuild && !!build.site;
  const siteEditsApp = siteSession && build.site?.id ? siteEditsAppId(build.site.id) : null;
  useSiteEditsSession(siteEditsApp, buildSessionId);
  const sendSiteEdits = useCallback(async (count: number, edits?: ReadonlyArray<SiteTextEditSnapshot>): Promise<{ ok: true; direct?: true; applied: number; appliedSelectors: string[] } | { ok: false; message: string }> => {
    if (!siteEditsApp) return { ok: false, message: "There's no site to send these changes to yet." };
    return sendSiteEditsOptimistic(siteEditsApp, buildSessionId, count, onSiteEditsApplied, edits);
  }, [siteEditsApp, onSiteEditsApplied, buildSessionId]);
  const sendRefine = buildConversation.sendRefine;
  const requestSiteChange = useCallback(
    async (request: string): Promise<SiteChangeResult> => {
      const refusal = await sendRefine(request);
      if (refusal === null) return { ok: true };
      if (isHeldChange(refusal)) return { ok: true, held: refusal.message };
      return { ok: false, message: siteChangeFailureText(refusal) };
    },
    [sendRefine],
  );
  const codeScope = siteSession && buildSessionId ? `site:${buildSessionId}` : appHost;
  const ownBuiltAppUrl = siteSession ? null : builtAppUrl;
  const ownBuiltinLiveUrl = siteSession ? null : builtinLiveUrl;
  const builtAppHost = (() => {
    try {
      return ownBuiltAppUrl ? new URL(ownBuiltAppUrl).host : null;
    } catch {
      return null;
    }
  })();
  const builtinLiveHost = (() => {
    try {
      return ownBuiltinLiveUrl ? new URL(ownBuiltinLiveUrl).host : null;
    } catch {
      return null;
    }
  })();
  const buildTargetHost = (() => {
    try {
      return isBuild && appUrl && appUrlLive ? new URL(appUrl).host : null;
    } catch {
      return null;
    }
  })();
  const publishable =
    !!appHost &&
    ((!!builtAppHost && appHost === builtAppHost) ||
      (!!builtinLiveHost && appHost === builtinLiveHost) ||
      (!!buildTargetHost && appHost === buildTargetHost));

  const buildFailed =
    isTerminalBuildRun(build.runStatus) && build.runStatus !== "done";
  const showStoppedPane = shouldShowStoppedBuildPane({
    isBuild,
    stoppedByFounder: canStartAgain(buildConversation),
    buildStarting,
    viewingCheckpoint: !!checkpointView,
  });
  const scopePickable = isBuild && !!siteEditsApp && !checkpointView && !liveFramed && !sandboxDraftShown;
  useEffect(() => {
    if (!scopePickable) setScopePick(null);
  }, [scopePickable]);
  const showBuildProgress = shouldShowWebsiteBuildProgress(
    previewUrl,
    build.building,
    buildStarting,
    buildFailed,
    build.settledNonce,
    build.appReady || !isBuild || !!checkpointView || liveFramed || sandboxDraftShown,
  );
  const awaitingLookPick =
    isBuild &&
    !checkpointView &&
    !buildFailed &&
    designAwaitsPick(siteDesign.design, siteDesign.started);
  useEffect(() => {
    if (awaitingLookPick) setNarrowView("app");
  }, [awaitingLookPick]);
  const progressPublish =
    build.appReady && publishStatus === "publishing"
      ? "publishing"
      : build.appReady && publishStatus === "failed"
        ? publishMode === "retry"
          ? "failed-retry"
          : "failed"
        : null;
  const openSettings = useCallback(() => {
    openTab(
      { kind: "settings", title: "Settings", payload: { kind: "settings" }, dirty: false, pinned: false },
      { push: true },
    );
  }, [openTab]);
  const githubExports = isBuild && !!shownRepoUrl && (siteSession || (repoManaged ?? isZaviHostedRepoUrl(shownRepoUrl)));
  const exportReady = !isBuild || (!buildStarting && build.runStatus === "done" && !build.previewState);
  useEffect(() => {
    if (!exportReady) setExportOpen(false);
  }, [exportReady]);
  const onGithub = useCallback(() => {
    if (githubExports || isBuild) {
      setExportOpen((open) => !open);
      return;
    }
    if (shownRepoUrl) window.open(shownRepoUrl, "_blank", "noopener,noreferrer");
    else if (!isBuild) openSettings();
  }, [githubExports, shownRepoUrl, openSettings, isBuild]);
  const ownRepoUrl = isBuild && !githubExports ? shownRepoUrl : null;
  const exportBody = (sessionId: string | null) => (
    <>
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-creamDeep text-ink ring-1 ring-inset ring-rule">
            <GithubMark className="h-4 w-4" />
          </span>
          <p className="text-[14px] font-semibold text-ink">{ownRepoUrl ? "Your code on GitHub" : "Export to GitHub"}</p>
        </div>
        <button
          type="button"
          onClick={() => {
            setExportOpen(false);
            setMobileSheet((sheet) => (sheet === "export" ? null : sheet));
            githubButtonRef.current?.focus();
          }}
          aria-label="Close export"
          className="-mr-1.5 -mt-1 inline-flex h-8 w-8 items-center justify-center rounded-cta text-inkMuted hover:bg-creamDeep hover:text-ink"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>
      {ownRepoUrl ? (
        <a
          href={ownRepoUrl}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="export-open-repo"
          className="mt-3 inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-full border border-rule px-4 text-[13px] font-semibold text-ink hover:bg-creamDeep"
        >
          <GithubMark className="h-3.5 w-3.5" />
          Open the code on GitHub
        </a>
      ) : (
        <ExportToGithubButton className="mt-3" repoName={repoNameFromUrl(shownRepoUrl)} buildId={sessionId} revision={shippedRevision} />
      )}
    </>
  );
  const mobileLiveUrl = siteHref(sessionSite) ?? hosted.builtinLiveUrl ?? hosted.builtAppUrl ?? null;
  const plannedAddress = publishWaitsOn
    ? onRequestPublish !== null
      ? { host: sessionSite?.hostname ?? null, label: SITE_NOT_PUBLISHED }
      : { host: sessionSite?.hostname ?? null }
    : null;
  useEffect(() => {
    if (!exportOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setExportOpen(false);
        githubButtonRef.current?.focus();
      }
    };
    const onPointer = (e: MouseEvent) => {
      const node = e.target as Node;
      if (exportRef.current?.contains(node) || githubButtonRef.current?.contains(node)) return;
      setExportOpen(false);
    };
    const onBlur = () => {
      if (document.activeElement?.tagName === "IFRAME") setExportOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPointer);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointer);
    };
  }, [exportOpen]);

  const refreshPreviewAfterRun = useCallback((reload: boolean = true) => {
    const productSeq = ++productUrlSeqRef.current.issued;
    const resourcesSeq = ++resourcesSeqRef.current.issued;
    void (async () => {
      try {
        const [productRes, resourcesRes] = await Promise.all([
          apiFetch("/api/connectors/product-url"),
          apiFetch("/api/workspace/autopilot"),
        ]);
        if (productRes.ok) {
          const product = (await productRes.json()) as { product_url?: ProductUrl };
          if (takeSeq(productUrlSeqRef.current, productSeq)) setProductUrl(product.product_url ?? {});
        }
        if (resourcesRes.ok) {
          const data = (await resourcesRes.json()) as { resources?: TenantResource[] | null };
          if (takeSeq(resourcesSeqRef.current, resourcesSeq)) {
            applyResources(Array.isArray(data.resources) ? data.resources : []);
          }
        }
      } catch {
      } finally {
        if (reload) setPreviewReloadKey((key) => key + 1);
      }
    })();
  }, []);
  const rereadBuildSession = buildConversation.retry;
  const refreshAfterChatRun = useCallback(() => {
    refreshPreviewAfterRun();
    if (isBuild) rereadBuildSession();
  }, [refreshPreviewAfterRun, isBuild, rereadBuildSession]);

  const revertToCheckpoint = useCallback(async () => {
    if (!checkpointView || reverting) return;
    setReverting(true);
    setRevertError(null);
    try {
      const res = await apiFetch("/api/workspace/autopilot/restore-checkpoint", {
        method: "POST",
        idempotent: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conductor_run_id: checkpointView.id }),
      });
      const j = (await res.json().catch(() => null)) as
        | { noop?: boolean; new_commit_sha?: string; error?: { message?: string } }
        | null;
      if (!res.ok) {
        const message = j?.error?.message ?? "We couldn't revert to that version. Try again.";
        setRevertError(message);
        toast.add({ type: "error", title: "Couldn't revert", description: message });
        return;
      }
      const title = checkpointView.title;
      setCheckpointView(null);
      setHistoryOpen(false);
      if (j?.noop || !j?.new_commit_sha) {
        toast.add({ type: "success", title: "Already on this version", dismissible: false });
        refreshPreviewAfterRun();
        return;
      }
      void watchDeploy({ commitSha: j.new_commit_sha, title, onLive: refreshPreviewAfterRun });
    } catch {
      setRevertError("We couldn't reach the server. Try again.");
      toast.add({ type: "error", title: "Couldn't revert", description: "We couldn't reach the server. Try again." });
    } finally {
      setReverting(false);
    }
  }, [checkpointView, reverting, refreshPreviewAfterRun, watchDeploy]);
  const leaveHistoryView = useCallback(() => {
    setCheckpointView(null);
    setRevertError(null);
  }, []);
  const historyChrome = checkpointView ? (
    <div
      data-testid="history-chrome"
      className="grid h-12 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-3 border-b border-rule bg-cream px-3"
    >
      <button
        type="button"
        onClick={leaveHistoryView}
        className="inline-flex h-8 items-center gap-2 justify-self-start rounded-full px-3 text-[13px] font-medium text-inkSoft transition-colors hover:bg-bone hover:text-ink"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        Back to latest
      </button>
      <span className="flex min-w-0 max-w-[min(420px,50vw)] items-center gap-2 justify-self-center rounded-full bg-bone px-3 py-1 text-[13px] text-inkSoft">
        <History className="h-3.5 w-3.5 shrink-0 text-inkMuted" aria-hidden />
        <span className="truncate" title={checkpointView.title}>
          {shortVersionTitle(checkpointView.title, 80)}
        </span>
      </span>
      {checkpointView.viewOnly ? (
        <span
          data-testid="history-view-only"
          className="inline-flex h-8 items-center justify-self-end rounded-full bg-bone px-3 text-[13px] text-inkMuted"
          title="This is how your site looked then. It uses your live data, so a form sent from here is real."
        >
          View only
        </span>
      ) : checkpointView.restorable ? (
        <button
          type="button"
          onClick={() => void revertToCheckpoint()}
          disabled={reverting}
          className="inline-flex h-8 items-center gap-2 justify-self-end rounded-full bg-ink px-3.5 text-[13px] font-semibold text-cream transition-colors hover:bg-ink/85 disabled:opacity-60"
        >
          {reverting && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
          {reverting ? "Reverting…" : "Revert to this version"}
        </button>
      ) : checkpointView.draft ? (
        <span
          className="inline-flex h-8 items-center justify-self-end rounded-full bg-bone px-3 text-[13px] text-inkMuted"
          title="This change is only in your preview. Publish it to make it live."
        >
          In your preview
        </span>
      ) : (
        <span
          className="inline-flex h-8 items-center justify-self-end rounded-full bg-bone px-3 text-[13px] text-inkMuted"
          title="This change is waiting for your approval. Approve it from the chat to make it live."
        >
          Waiting for approval
        </span>
      )}
    </div>
  ) : undefined;
  const historyBooting = !!checkpointView && !frameUrl;

  const [waking, setWaking] = useState(false);
  const [discardingStale, setDiscardingStale] = useState(false);
  const draftPending = liveEdit.state.enabled ? liveEdit.state.draft.ahead_by : 0;
  const draftStale = draftPending > 0 && liveEdit.state.draft.behind_by > 0;
  const liveEditAsleep =
    isBuild && !checkpointView && !liveFramed && draftPending > 0 && !draftStale && !liveEdit.state.refine_active;
  const liveEditStale = isBuild && !checkpointView && draftStale && !liveEdit.state.refine_active;
  const loadingLatestDraft = liveEditAsleep && (waking || !!liveEdit.loadingLatest);
  const discardStaleDraft = useCallback(async () => {
    setDiscardingStale(true);
    try {
      const r = await liveEdit.discard();
      if (!r.ok) toast.add({ type: "error", title: "Couldn't discard", description: r.message });
    } finally {
      setDiscardingStale(false);
    }
  }, [liveEdit]);
  const wakeLiveEdit = useCallback(async () => {
    setWaking(true);
    try {
      const r = await liveEdit.wake();
      if (!r.ok) toast.add({ type: "error", title: "Preview didn't start", description: r.message });
    } finally {
      setWaking(false);
    }
  }, [liveEdit]);
  const previewCompiling =
    isBuild && !checkpointView && !liveFramed && !previewUpdating && build.previewCompiling && !!frameUrl && frameUrl === build.previewUrl;
  usePreviewErrorFix({ active: isBuild && !!buildSessionId, busy: isBuild && (build.building || !!runningChange || !!build.previewCompiling), failed: buildFailed, refine: (message) => refineActiveBuild(message, true) });
  const liveNoteLabel =
    draftPending > 0 ? `Preview · ${draftPending} unpublished change${draftPending === 1 ? "" : "s"}` : "Preview · updating live";
  const liveEditNote = previewUpdating ? (
    <div
      role="status"
      data-testid="preview-updating"
      className="pointer-events-none absolute right-4 top-[4.25rem] z-20 flex items-center gap-2 rounded-full border border-rule bg-cream py-1 pl-2.5 pr-3 text-[12px] font-medium text-inkSoft shadow-sm"
    >
      <Loader2 className="h-3.5 w-3.5 animate-spin text-inkMuted motion-reduce:animate-none" aria-hidden />
      Updating your preview
    </div>
  ) : previewCompiling ? (
    <div
      role="status"
      data-testid="preview-compiling"
      className="absolute inset-x-4 bottom-24 top-14 z-20 flex items-center justify-center rounded-2xl bg-cream/95 px-6 text-center"
    >
      <div className="max-w-sm">
        <Loader2 className="mx-auto h-5 w-5 animate-spin text-inkMuted motion-reduce:animate-none" aria-hidden />
        <p className="mt-3 text-[14px] font-semibold text-ink">Your app is mid-change</p>
        <p className="mt-1 text-[13px] leading-5 text-inkMuted">
          The builder is partway through an edit, so this page does not compile yet. The preview comes back on its own as soon as it does.
        </p>
      </div>
    </div>
  ) : editOnSandbox && !liveFramed ? (
    <div
      data-testid="sandbox-edit-note"
      role="status"
      className="absolute left-1/2 top-14 z-20 flex w-max max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-2 rounded-full border border-rule bg-cream py-1 pl-3 pr-1 text-[12px] leading-4 text-inkSoft shadow-sm"
    >
      <span className="min-w-0">Editing your site’s preview. Publish to put changes live.</span>
      <button
        type="button"
        onClick={() => setEditOnSandboxFor(null)}
        className="inline-flex h-8 shrink-0 items-center whitespace-nowrap rounded-full border border-rule bg-white px-3 text-[12px] font-semibold text-ink"
      >
        Show live site
      </button>
    </div>
  ) : liveFramed ? (
    <div
      data-testid="live-edit-note"
      role="status"
      className="pointer-events-none absolute right-4 top-[4.25rem] z-20 flex items-center gap-2 rounded-full border border-rule bg-cream py-1 pl-2.5 pr-3 text-[12px] font-medium text-inkSoft shadow-sm"
    >
      <span aria-hidden className="relative flex h-2.5 w-2.5 items-center justify-center">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-60 motion-reduce:animate-none" />
        <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-amber-500" />
      </span>
      {liveNoteLabel}
    </div>
  ) : liveEditStale ? (
    <div
      data-testid="live-edit-stale"
      className="absolute left-1/2 top-14 z-20 flex w-max max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-2 rounded-full border border-rule bg-cream py-1 pl-3 pr-1 text-[12px] leading-4 text-inkSoft shadow-sm"
    >
      <span className="min-w-0">Your live app changed, so the preview changes are out of date</span>
      <button
        type="button"
        onClick={() => void discardStaleDraft()}
        disabled={discardingStale}
        className="inline-flex h-8 shrink-0 items-center gap-2 whitespace-nowrap rounded-full bg-ink px-3 text-[12px] font-semibold text-cream disabled:opacity-60"
      >
        {discardingStale && <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />}
        Discard
      </button>
    </div>
  ) : liveEditAsleep && !loadingLatestDraft ? (
    <div
      data-testid="live-edit-asleep"
      className="absolute left-1/2 top-14 z-20 flex w-max max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-2 rounded-full border border-rule bg-cream py-1 pl-3 pr-1 text-[12px] leading-4 text-inkSoft shadow-sm"
    >
      <span className="min-w-0">
        {draftPending} unpublished change{draftPending === 1 ? "" : "s"} not shown
      </span>
      <button
        type="button"
        onClick={() => void wakeLiveEdit()}
        disabled={waking}
        className="inline-flex h-8 shrink-0 items-center gap-2 whitespace-nowrap rounded-full bg-ink px-3 text-[12px] font-semibold text-cream disabled:opacity-60"
      >
        {waking && <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />}
        Show preview
      </button>
    </div>
  ) : isBuild && build.site?.searchHidden && build.site.liveUrl && !checkpointView ? (
    <SearchHoldNote key={build.site.id} siteId={build.site.id} />
  ) : null;

  const conversationSession = isBuild ? buildSessionId : null;
  const refinesLoaded = buildConversation.refinesLoaded;
  const shippedBaseline = useRef(EMPTY_REVISION_BASELINE);
  const exportOpenRef = useRef(exportOpen);
  exportOpenRef.current = exportOpen;
  useEffect(() => {
    const { next, prior: prev } = advanceRevisionBaseline(shippedBaseline.current, conversationSession, refinesLoaded, shippedRevision);
    shippedBaseline.current = next;
    if (refineShippedSince(prev, shippedRevision)) refreshPreviewAfterRun(!siteSession);
    if (refineShippedSince(prev, shippedRevision) && conversationSession && !exportOpenRef.current) void refreshExportStatusAfterEdit(conversationSession);
  }, [conversationSession, refinesLoaded, shippedRevision, refreshPreviewAfterRun, siteSession]);

  const undoneRevision = isBuild ? finishedUndoRevision(buildConversation.refines) : null;
  const undoneBaseline = useRef(EMPTY_REVISION_BASELINE);
  useEffect(() => {
    const { next, prior } = advanceRevisionBaseline(undoneBaseline.current, conversationSession, refinesLoaded, undoneRevision);
    undoneBaseline.current = next;
    if (refineShippedSince(prior, undoneRevision)) refreshPreviewAfterRun(!siteSession);
  }, [conversationSession, refinesLoaded, undoneRevision, refreshPreviewAfterRun, siteSession]);

  const finishedRevision = isBuild ? previewRevisionOf(buildConversation.refines) : null;
  const finishedBaseline = useRef(EMPTY_REVISION_BASELINE);
  useEffect(() => {
    const { next, prior } = advanceRevisionBaseline(finishedBaseline.current, conversationSession, refinesLoaded, finishedRevision);
    finishedBaseline.current = next;
    if (refineShippedSince(prior, finishedRevision)) onSitePublishRefresh();
  }, [conversationSession, refinesLoaded, finishedRevision, onSitePublishRefresh]);

  const landed = isBuild ? landedRefine(buildConversation.refines) : null;
  const landedId = landed?.id ?? null;
  const landedPath = landed?.preview_path ?? null;
  const landedBaseline = useRef(EMPTY_REVISION_BASELINE);
  const [shipOpenPath, setShipOpenPath] = useState<{ path: string; nonce: string } | null>(null);
  useEffect(() => {
    const { next, prior } = advanceRevisionBaseline(landedBaseline.current, conversationSession, refinesLoaded, landedId);
    landedBaseline.current = next;
    const path = previewPathToOpen(prior, landedId, landedPath);
    if (path && landedId) setShipOpenPath({ path, nonce: landedId });
  }, [conversationSession, refinesLoaded, landedId, landedPath]);

  const busyKey = isBuild ? busyRefineKey(buildConversation.refines) : "";
  const lastBusyKey = useRef<string | undefined>(undefined);
  useEffect(() => {
    const prev = lastBusyKey.current;
    lastBusyKey.current = busyKey;
    if (gainedBusyRefine(prev, busyKey)) refreshLiveEdit();
  }, [busyKey, refreshLiveEdit]);
  useEffect(() => {
    if (checkpointView) setShipOpenPath(null);
  }, [checkpointView]);
  useEffect(() => {
    setShipOpenPath(null);
  }, [conversationSession]);

  useEffect(() => {
    if (build.settledNonce === 0) return;
    refreshPreviewAfterRun();
  }, [build.settledNonce, refreshPreviewAfterRun]);

  useEffect(() => {
    if (publishPopoverShown) return;
    if (publishMode === "publishing" || publishMode === "waiting") setPublishOpen(false);
    setMobileSheet((s) => (s === "publish" ? null : s));
  }, [publishMode, publishPopoverShown]);

  const publishWatch = useRef<PublishWatch | null>(null);
  const buildAppReady = build.appReady === true;
  useEffect(() => {
    const next: PublishWatch = {
      runId: build.runId ?? null,
      runStatus: build.runStatus ?? null,
      appReady: buildAppReady,
      publishStatus,
    };
    const prev = publishWatch.current;
    publishWatch.current = next;
    if (publishWentLive(prev, next, publishOnRequest)) refreshPreviewAfterRun();
  }, [build.runId, build.runStatus, buildAppReady, publishStatus, publishOnRequest, refreshPreviewAfterRun]);

  const goToDomains = useCallback(() => {
    writeWebsiteParam("section", "domains");
    setMode("dashboard");
    navNonceRef.current += 1;
    setNavSignal({ section: "domains", nonce: navNonceRef.current });
    setPublishOpen(false);
  }, []);

  const name = greetingName(userEmail);
  const greeting = `${timeGreeting(new Date())}${name ? `, ${name}.` : "."}`;
  const runs = summary?.active_runs_today ?? [];
  const runsToday = runs.length;
  const answered = countAnswered(runs);
  const needsYou = summary?.pending_approvals_count ?? 0;
  const pulse = !summaryLoaded ? (
    <span className="inline-block h-4 w-64 animate-pulse rounded bg-[#f0f0f0] align-middle" />
  ) : runsToday === 0 ? (
    <>No runs yet today. Hand your team something below.</>
  ) : (
    <>
      Your team ran <b className="text-ink">{runsToday}</b> {runsToday === 1 ? "task" : "tasks"} today
      {answered > 0 && (
        <>
          {" "}
          and handled <b className="text-ink">{answered}</b> on its own
        </>
      )}
      .{" "}
      {needsYou > 0 ? (
        <>
          {}
          <button
            type="button"
            onClick={() =>
              openTab({ kind: "needs-you", title: "Needs you", payload: { kind: "needs-you" }, dirty: false, pinned: false })
            }
            className="font-bold text-ink underline decoration-rule underline-offset-2 hover:decoration-ink"
          >
            {needsYou} {needsYou === 1 ? "thing" : "things"}
          </button>{" "}
          {needsYou === 1 ? "needs" : "need"} a call from you.
        </>
      ) : (
        <>Nothing needs a call from you right now.</>
      )}
    </>
  );

  const appName = paneAppName({ siteNames: siteFlags?.siteNames === true, site: sessionSite, appHost, tenantName });
  const buildTitle = appName ? (
    <>
      <AppInitialTile name={appName} />
      <span className="min-w-0 truncate text-[14px] font-semibold text-[#0e0f11]">
        {appName}
      </span>
    </>
  ) : null;

  const buildNarrowLeading = onOpenNav ? (
    <div className="flex items-center gap-2 lg:hidden">
      <HeaderIconButton
        onClick={onOpenNav}
        title="Open navigation"
        label="Open navigation"
        compact
      >
        <Menu className="h-4 w-4" />
      </HeaderIconButton>
    </div>
  ) : undefined;

  const buildPaneToggle = (target: "chat" | "app") => (
    <div className="flex items-center lg:hidden">
      {mobileActionsOn && <BuildShareButton />}
      {mobileActionsOn && (
        <BuildMobileActions
          onPreview={() => {
            setChatExpanded(false);
            selectBuildSurfaceTab("preview");
            setNarrowView("app");
          }}
          publish={{
            label: publishMode === "retry" ? "Retry publish" : publishMode === "publishing" ? "Publishing…" : "Publish",
            prominent: publishMode === "retry" || (publishMode === "publish" && (onRequestPublish === "ready" || (!!siteChanges && siteChanges.count > 0 && changesPublishStatus === "none"))),
            disabledReason:
              publishMode === "waiting"
                ? PUBLISH_WAITS_TITLE
                : publishMode === "publishing"
                  ? publishProgressInPopover
                    ? null
                    : PUBLISHING_TITLE
                  : publishMode === "retry" && buildConversation.continuing
                    ? PUBLISHING_TITLE
                    : null,
            onSelect: () => {
              if (publishMode === "retry") {
                void retryPublish();
                return;
              }
              setChatExpanded(false);
              setNarrowView("app");
              setMobileSheet("publish");
            },
          }}
          liveUrl={mobileLiveUrl}
          onSettings={() => {
            setChatExpanded(false);
            setNarrowView("app");
            setMode("dashboard");
          }}
          onDomains={() => {
            setChatExpanded(false);
            setNarrowView("app");
            goToDomains();
          }}
          github={
            exportReady
              ? {
                  label: "Export",
                  disabledReason: null,
                  onSelect: () => {
                    if (githubExports || isBuild) {
                      setChatExpanded(false);
                      setNarrowView("app");
                      setMobileSheet("export");
                      return;
                    }
                    onGithub();
                  },
                }
              : null
          }
        />
      )}
      <HeaderIconButton
        onClick={() => {
          if (target === "app") setChatExpanded(false);
          setNarrowView(target);
        }}
        title={target === "app" ? "Show the app" : "Show the chat"}
        label={target === "app" ? "Show the app" : "Show the chat"}
        compact
      >
        {target === "app" ? (
          <Monitor className="h-4 w-4" />
        ) : (
          <MessageSquare className="h-4 w-4" />
        )}
      </HeaderIconButton>
    </div>
  );

  const buildSurfaceLead = (interactive: boolean) => (
    <div
      aria-hidden={interactive ? undefined : true}
      className={`flex items-center gap-2 ${interactive ? "" : "invisible"}`}
    >
      {buildNarrowLeading}
      {chatHidden && (
        <HeaderIconButton
          onClick={() => setChatHidden(false)}
          title="Show chat"
          label="Show chat"
          className="hidden lg:inline-flex"
          compact
        >
          <PanelLeftOpen className="h-4 w-4" />
        </HeaderIconButton>
      )}
      {interactive ? (
        <BuildSurfaceTabs active={buildSurfaceTab} onChange={selectBuildSurfaceTab} mountedPanels={mountedSurfacePanels} />
      ) : (
        <div className="h-9 shrink-0" style={{ width: BUILD_SURFACE_TABS_WIDTH }} />
      )}
    </div>
  );
  const buildChatActions = (
    <>
      <HeaderIconButton
        onClick={() => setHistoryOpen((open) => !open)}
        title="History"
        label="History"
        pressed={historyOpen}
        compact
      >
        <History className="h-4 w-4" />
      </HeaderIconButton>
      {!showBuildProgress && (
        <HeaderIconButton
          onClick={() => setChatHidden(true)}
          title="Hide chat"
          label="Hide chat"
          className="hidden lg:inline-flex"
          compact
        >
          <PanelLeftClose className="h-4 w-4" />
        </HeaderIconButton>
      )}
    </>
  );
  const buildSurfaceHeader = (title: string, badge?: React.ReactNode) => (
    <div className="grid h-12 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-3 border-b border-[#f0f0f0] px-4">
      <div className="flex items-center gap-2 justify-self-start">
        {buildSurfaceLead(false)}
      </div>
      <div className="flex min-w-0 items-center">
        <h2 className="truncate text-[14px] font-semibold text-ink">{title}</h2>
      </div>
      <div data-testid="build-surface-header-end" className="flex items-center gap-2 justify-self-end">
        {buildPaneToggle("chat")}
        {badge}
      </div>
    </div>
  );
  const publishReadsApp = siteSession ? siteEditsApp : appHost;
  const publishReadsReadable = siteSession ? !!siteEditsApp : publishable;
  const publishReadsBuiltin = !siteSession && !(!publishable && appUrl && hostedPreviewUrl !== appUrl);
  useEffect(() => {
    if (!isBuild || !exportReady) return;
    void prefetchPublishPopover({ editsApp: publishReadsApp, editsReadable: publishReadsReadable, siteSession, readsBuiltin: publishReadsBuiltin });
  }, [isBuild, exportReady, publishReadsApp, publishReadsReadable, siteSession, publishReadsBuiltin, shippedRevision]);
  useEffect(() => {
    if (isBuild && exportReady) void prefetchWorkspaceMembers();
  }, [isBuild, exportReady]);
  const renderPublishPopover = (onClose: () => void) => (
    <PublishPopover
      key={siteSession && build.site ? build.site.id : appHost ?? "workspace"}
      appUrl={hostedPreviewUrl}
      appHost={appHost}
      publishable={publishable}
      ownBuildApp={isBuild && !!appUrl && hostedPreviewUrl === appUrl}
      site={siteSession && build.site ? { liveUrl: build.site.liveUrl, status: build.site.status } : null}
      siteEditsApp={siteEditsApp}
      siteEditsApplying={siteEditsApplying}
      onSiteEditsApplied={onSiteEditsApplied}
      sitePublish={
        siteChanges && build.site
          ? {
              siteId: build.site.id,
              hostname: sessionSite?.hostname ?? null,
              built: true,
              status: changesPublishStatus,
              reason: siteChanges.publish.reason ?? null,
              fixing: siteChanges.publish.fixing === true,
              waiting: siteChanges.publish.waiting === true,
              changes: { count: siteChanges.count, items: siteChanges.changes },
              onUndoChange: buildSessionId ? (id: string) => undoBuildRefine(buildSessionId, id) : undefined,
              onStarted: onChangesPublishStarted,
              onRefresh: onSitePublishRefresh,
            }
          : onRequestPublish !== null && build.site
          ? {
              siteId: build.site.id,
              hostname: sessionSite?.hostname ?? null,
              built: onRequestPublish === "ready",
              status: shownPublishStatus,
              reason: build.publish?.reason ?? null,
              fixing: build.publish?.fixing === true,
              waiting: build.publish?.waiting === true,
              late: publishLateFor === buildSessionId && shownPublishStatus === "none",
              onStarted: onSitePublishStarted,
              onRefresh: onSitePublishRefresh,
            }
          : null
      }
      onGetDomain={goToDomains}
      onDiscarded={() => setPreviewReloadKey((k) => k + 1)}
      onPublished={onPublished}
      onClose={onClose}
      onBusyChange={onPublishBusyChange}
      draft={
        liveEdit.state.enabled
          ? {
              pending: draftPending,
              changes: liveEdit.state.draft.changes,
              publish: liveEdit.publish,
              discard: liveEdit.discard,
              onPublished: (commitSha, count) => {
                const held = liveEdit.frameUrl;
                if (held) setPublishHoldUrl(held);
                void watchDeploy({
                  commitSha,
                  title: "Publish",
                  onLive: () => {
                    setPublishHoldUrl(null);
                    refreshPreviewAfterRun();
                  },
                  copy: publishCopy(count),
                }).finally(() => {
                  if (held) setPublishHoldUrl((current) => (current === held ? null : current));
                });
              },
            }
          : undefined
      }
    />
  );
  const renderSurfaceActions = (compact: boolean) => (
    <div className={`relative flex items-center ${compact ? "gap-0" : "gap-2"}${mobileActionsOn ? " max-lg:hidden" : ""}`}>
          {isBuild && exportReady && (
            <button
              ref={githubButtonRef}
              type="button"
              onClick={onGithub}
              aria-haspopup="dialog"
              aria-expanded={exportOpen}
              aria-label="GitHub export"
              title="Export to GitHub"
              data-testid="build-export"
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-cta text-ink transition-colors hover:bg-creamDeep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
            >
              <GithubMark className={compact ? "h-4 w-4" : "h-[18px] w-[18px]"} />
            </button>
          )}
          {!isBuild && (
            <HeaderIconButton
              onClick={onGithub}
              title={shownRepoUrl ? "Open the app repository on GitHub" : "Connect GitHub"}
              label="GitHub repository"
              buttonRef={githubButtonRef}
              compact={compact}
            >
              <GithubMark className={compact ? "h-4 w-4" : "h-5 w-5"} />
            </HeaderIconButton>
          )}
          {exportOpen && (
            <div
              ref={exportRef}
              role="dialog"
              aria-label="Export your code"
              className="absolute right-0 top-[calc(100%+10px)] z-30 w-[360px] max-w-[calc(100vw-32px)] rounded-2xl border border-rule bg-cream p-4 shadow-pop"
            >
              {exportBody(isBuild ? buildSessionId : null)}
            </div>
          )}
          {isBuild ? (
            <HeaderIconButton
              onClick={toggleBuildSettings}
              title="App settings"
              label="App settings"
              pressed={mode === "dashboard"}
              compact={compact}
            >
              <Settings className={compact ? "h-4 w-4" : "h-5 w-5"} />
            </HeaderIconButton>
          ) : (
            <HeaderIconButton
              onClick={openSettings}
              title="Settings"
              label="Settings"
              compact={compact}
            >
              <Settings className={compact ? "h-4 w-4" : "h-5 w-5"} />
            </HeaderIconButton>
          )}
          {isBuild && <BuildShareButton compact={compact} />}
          <div ref={publishRef} className={`relative${compact ? " ml-2" : ""}`}>
            <PublishTrigger
              mode={publishMode}
              open={publishOpen}
              onToggle={() => setPublishOpen((v) => (publishBusyRef.current ? v : !v))}
              onRetry={() => void retryPublish()}
              retrying={buildConversation.continuing}
              retryError={publishRetryError}
              progressInPopover={publishProgressInPopover}
            />
            {publishOpen && publishPopoverShown && renderPublishPopover(() => setPublishOpen(false))}
          </div>
    </div>
  );

  const waitingPane = waitingPaneOf({
    showStoppedPane,
    showBuildProgress,
    awaitingLookPick,
    isBuild,
    loadingLatestDraft,
    frameUrl,
    historyBooting,
    checkpointView: !!checkpointView,
    previewState: build.previewState,
  });
  const waitingAddress = sourcesPending ? null : plannedAddress;
  const waitingBody: React.ReactNode =
    waitingPane === "stopped" ? (
      <BuildStoppedPane runId={buildConversation.run?.id ?? null} objective={buildConversation.run?.objective ?? null} />
    ) : waitingPane === "progress" ? (
      <WebsiteBuildProgress
        stages={build.stages}
        failure={build.failure}
        failed={buildFailed}
        publish={progressPublish}
        runId={build.runId}
        publishOnRequest={publishOnRequest}
        awaitingPick={awaitingLookPick}
        picker={
          awaitingLookPick && siteDesign.design ? (
            <LookPicker
              design={siteDesign.design}
              starting={siteDesign.starting}
              started={siteDesign.started}
              startError={siteDesign.startError}
              onStart={siteDesign.start}
              wide
            />
          ) : null
        }
      />
    ) : waitingPane === "latest-draft" ? (
      <div data-testid="live-edit-loading-latest" className="relative h-full w-full">
        <AppStartingScreen state="loading" openUrl={null} onRetry={() => void wakeLiveEdit()} />
      </div>
    ) : waitingPane === "preview-stopped" ? (
      <PreviewStoppedScreen
        starting={restartingPreview || build.previewState === "starting"}
        error={restartPreviewError}
        onRestart={() => void restartPreview()}
      />
    ) : waitingPane === "preview-pending" ? (
      <div data-testid="build-preview-pending" className="h-full w-full">
        <PreviewLoadingScreen />
      </div>
    ) : null;

  return (
    <div
      ref={rootRef}
      className={`relative h-full min-h-0 w-full min-w-0 flex-1 overflow-hidden ${
        isBuild ? "bg-transparent" : "bg-white"
      }`}
      style={
        {
          "--website-chat-w": `${chatWidth + 6}px`,
        } as CSSProperties
      }
    >
      {}
      <div
        aria-hidden={chatExpanded}
        className={`flex h-full min-w-0 flex-col transition-opacity duration-200 ${
          isBuild && chatHidden
            ? ""
            : chatOnLeft
              ? "lg:ml-[var(--website-chat-w)]"
              : "lg:mr-[var(--website-chat-w)]"
        } ${chatExpanded ? "pointer-events-none opacity-0" : "opacity-100"}${
          isBuild && narrowView === "chat" ? " max-lg:hidden" : ""
        }`}
      >
        {}
        {!isBuild && (
          <div
            className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-[#f0f0f0] px-4"
          >
            <div className="flex min-w-0 items-center gap-3">
                <button
                  type="button"
                  onClick={goHome}
                  aria-label="Back to Home"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-cta text-[#595959] transition-colors hover:bg-[#f4f4f4] hover:text-[#0e0f11]"
                >
                  <ArrowLeft className="h-5 w-5" />
                </button>
              {}
              <ModeTabs mode={mode} onMode={setMode} />
            </div>
            {renderSurfaceActions(false)}
          </div>
        )}

        {}
        {}
        {phase === "ready" && mode === "preview" && !isBuild && (
          <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[#f0f0f0] px-4 text-[13px] text-[#595959]">
            <span className="min-w-0 truncate">
              {}
              {(() => {
                const found = previewSource(
                  isBuild ? null : servableMarketingUrl(productUrl.marketing, buildRetired),
                  hosted.builtinLiveUrl,
                  hosted.builtAppUrl,
                  build.previewUrl,
                );
                const s = isBuild ? { prefix: "Website", url: found.url ?? appUrl } : found;
                return s.url ? (
                  <>
                    {s.prefix}:{" "}
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[#595959] underline decoration-[#cfcfcf] underline-offset-2 transition-colors hover:text-[#0e0f11] hover:decoration-[#0e0f11]"
                    >
                      {s.url}
                    </a>
                  </>
                ) : (
                  `${s.prefix}: ${s.note ?? "not set"}`
                );
              })()}
            </span>
            {}
            {}
            {!isBuild && (
              <button
                type="button"
                onClick={goToDomains}
                className="shrink-0 font-semibold text-[#027bff] hover:underline"
              >
                Change
              </button>
            )}
          </div>
        )}

        {}
        <div className={`relative min-h-0 flex-1 overflow-hidden ${isBuild ? "" : "p-4"}`}>
          {isBuild && !checkpointView && (
            <div className="absolute left-[17px] top-[7px] z-20">{buildSurfaceLead(true)}</div>
          )}
          <div
            id={isBuild ? buildSurfacePanelId("preview") : undefined}
            role={isBuild ? "tabpanel" : undefined}
            aria-labelledby={isBuild ? `${buildSurfacePanelId("preview")}-tab` : undefined}
            className={
              mode === "dashboard" || (isBuild && buildPane !== "preview")
                ? "hidden"
                : `h-full ${isBuild ? "animate-pane-fade" : "animate-mode-switch"} motion-reduce:animate-none`
            }
          >
            {waitingBody !== null ? (
              <WebsitePreview
                key={WAITING_PREVIEW_KEY}
                flush={isBuild}
                headerActions={isBuild ? renderSurfaceActions(true) : undefined}
                leading={isBuild ? buildSurfaceLead(false) : undefined}
                editPlacement={isBuild ? "dock" : "header"}
                narrowTrailing={isBuild ? buildPaneToggle("chat") : undefined}
                notLiveAddress={waitingAddress}
                liveUrl={null}
                builtApp={false}
                body={waitingBody}
              />
            ) : phase === "loading" && !isBuild ? (
              <div className="h-full animate-pulse rounded-2xl bg-[#f9f9f9]" />
            ) : historyBooting ? (
              <div className="flex h-full flex-col overflow-hidden rounded-2xl bg-cream" data-testid="history-version-boot">
                {historyChrome}
                <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
                  {versionPreview.status === "dead" ? (
                    <>
                      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-bone">
                        <History className="h-5 w-5 text-inkMuted" strokeWidth={1.75} aria-hidden />
                      </span>
                      <p className="text-[14px] font-semibold text-ink">{versionPreview.retryable === false ? "This version can't be shown" : "This version's preview didn't start"}</p>
                      <p role="alert" className="max-w-sm text-[13px] leading-5 text-inkMuted">{versionPreview.error}</p>
                      {versionPreview.retryable !== false && <button
                        type="button"
                        onClick={versionPreview.retry}
                        className="inline-flex h-10 items-center rounded-full border border-rule bg-cream px-4 text-[13px] font-semibold text-ink transition-colors hover:bg-bone"
                      >
                        Try again
                      </button>}
                      <p className="max-w-sm text-[13px] leading-5 text-inkMuted">You can still revert to this version from the bar above.</p>
                    </>
                  ) : (
                    <>
                      <Loader2 className="h-6 w-6 animate-spin text-inkMuted motion-reduce:animate-none" aria-hidden />
                      <p className="text-[14px] font-semibold text-ink">Starting a preview of this version</p>
                      <p className="max-w-sm text-[13px] leading-5 text-inkMuted">
                        Zavi is opening the files as they were at this point. This usually takes a minute or two.
                      </p>
                    </>
                  )}
                  {revertError && (
                    <p role="alert" className="max-w-sm text-[13px] leading-5 text-danger">
                      {revertError}
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <>
              {liveEditNote}
              <WebsitePreview
                key={`${websitePreviewKey(frameUrl, liveFramed ? 0 : previewReloadKey)}:${liveFramed ? "live" : shownFrame.revision ?? ""}:${checkpointView?.id ?? ""}`}
                chromeOverride={historyChrome}
                flush={isBuild}
                headerActions={isBuild ? renderSurfaceActions(true) : undefined}
                leading={isBuild ? buildSurfaceLead(false) : undefined}
                editPlacement={isBuild ? "dock" : "header"}
                narrowLeading={undefined}
                narrowTrailing={isBuild ? buildPaneToggle("chat") : undefined}
                liveUrl={frameUrl}
                openPath={checkpointView ? null : shipOpenPath}
                keepPreviewCookie={!!checkpointView && !checkpointView.url}
                cacheKey={shownFrame.cacheKey}
                appId={checkpointView || liveFramed || sandboxDraftShown ? null : siteEditsApp ?? appHost}
                builtApp={checkpointView || liveFramed || sandboxDraftShown ? false : siteEditsApp ? true : publishable}
                siteApp={siteSession}
                onElementPicked={onElementPicked}
                onSelectionChange={scopePickable ? setScopePick : undefined}
                clearSelectionKey={clearPickKey}
                surfaceActive={!(mode === "dashboard" || (isBuild && buildPane !== "preview"))}
                onEditFallback={focusChat}
                onEditUnavailable={onEditUnavailable}
                armEditOnLoad={armSandboxEdit}
                onSendEdits={isBuild && siteEditsApp && !checkpointView && !liveFramed && !sandboxDraftShown ? sendSiteEdits : undefined}
                onRequestSiteChange={isBuild && siteEditsApp && !checkpointView && !liveFramed && !sandboxDraftShown ? requestSiteChange : undefined}
                editsBusy={siteEditsApplying || build.building || runningChange !== null}
                readOnly={role === "viewer"}
              />
              </>
            )}
          </div>
          {isBuild &&
            (["files", "code"] as const)
              .filter((pane) => visitedPanes.has(pane))
              .map((pane) => {
                const shown = mode === "preview" && buildPane === pane;
                return (
                  <div
                    key={pane}
                    id={buildSurfacePanelId(pane)}
                    role="tabpanel"
                    aria-labelledby={`${buildSurfacePanelId(pane)}-tab`}
                    hidden={!shown}
                    className={
                      shown
                        ? "flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-[#f0f0f0] bg-white animate-pane-fade motion-reduce:animate-none"
                        : "hidden"
                    }
                  >
                    {pane === "code"
                      ? buildSurfaceHeader(
                          "Code",
                          <>
                            {shownRepoUrl && <DownloadCodeButton variant="compact" sessionId={buildSessionId} />}
                            <ReadOnlyBadge />
                          </>,
                        )
                      : buildSurfaceHeader("Files")}
                    <div className="min-h-0 flex-1">
                      {pane === "code" ? (
                        <AppCodePane
                          key={codeScope ?? "app"}
                          scope={codeScope}
                          sessionId={buildSessionId}
                          active={shown}
                        />
                      ) : (
                        <BuildFilesPane onUseOnSite={seedFilesOnSite} active={shown} />
                      )}
                    </div>
                  </div>
                );
              })}
          {mode === "dashboard" && (
            <div
              role={isBuild ? "region" : undefined}
              aria-label={isBuild ? "App settings" : undefined}
              className={`flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-[#f0f0f0] bg-white ${isBuild ? "animate-pane-fade" : "animate-mode-switch"} motion-reduce:animate-none`}
            >
              {isBuild &&
                buildSurfaceHeader(
                  "Settings",
                  <HeaderIconButton onClick={closeBuildSettings} title="Close settings" label="Close settings" compact>
                    <X className="h-4 w-4" />
                  </HeaderIconButton>,
                )}
              <div className="min-h-0 flex-1 p-3">
                <WebsiteConsole
                  key={isBuild && buildSessionId ? `session:${buildSessionId}` : "workspace"}
                  buildSessionId={isBuild ? buildSessionId : null}
                  navSignal={navSignal}
                  onDeployedUrlChanged={refreshPreviewAfterRun}
                  usageRunIds={usageRunIds}
                  usageChangeCount={usageChangeCount}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {mobileActionsOn && mobileSheet && (
        <div data-testid="build-mobile-sheet" className="absolute inset-x-4 top-14 z-40 lg:hidden">
          <div className="relative">
            {mobileSheet === "publish" && publishPopoverShown ? (
              renderPublishPopover(() => setMobileSheet(null))
            ) : mobileSheet === "export" ? (
              <div
                role="dialog"
                aria-label="Export your code"
                className="absolute right-0 top-0 w-full rounded-[12px] border border-[#f0f0f0] bg-white p-3 shadow-lg"
              >
                {exportBody(buildSessionId)}
              </div>
            ) : null}
          </div>
        </div>
      )}
      {}
      <HomeChatPanel
        key={isBuild ? chatKey : undefined}
        side={chatSide}
        surface={isBuild ? "card" : "flush"}
        showExpand={!isBuild}
        showThreadBar={!isBuild}
        initialThreadId={isBuild ? chatThreadId : undefined}
        onThreadChange={isBuild ? bindBuildThread : undefined}
        buildSessionId={isBuild ? buildSessionId : null}
        prelude={
          isBuild && buildSessionId ? (
            <BuildTranscriptContent
              sessionId={buildSessionId}
              session={buildConversation}
              onLastActivity={setBuildLastAt}
              publishOnRequest={publishOnRequestSetting}
              changesInThread
            />
          ) : undefined
        }
        preludeLastAt={isBuild ? buildLastAt : null}
        timelineItems={isBuild ? buildTimelineItems : undefined}
        timelineStartAt={isBuild ? (buildConversation.run?.createdAt ?? null) : null}
        sendBlockedNotice={isBuild && shownPublishStatus === "publishing" ? PUBLISH_CHANGES_BLOCKED : null}
        title={isBuild ? buildTitle : undefined}
        greeting={greeting}
        pulse={pulse}
        suggestions={isBuild && websiteFraming ? WEBSITE_BUILD_SUGGESTIONS : SUGGESTIONS}
        composerHints={isBuild && websiteFraming ? WEBSITE_COMPOSER_HINTS : undefined}
        repoChipScope={isBuild ? { kind: "build", sessionId: buildSessionId } : undefined}
        expanded={chatExpanded}
        onExpandedChange={setChatExpanded}
        width={chatWidth}
        dragging={chatDragging}
        separatorProps={chatSeparatorProps}
        composerSeed={pickSeed ?? undefined}
        externalStop={
          runningChange && !runningChange.id.startsWith("pending:")
            ? {
                ariaLabel: "Stop change",
                stopping: buildConversation.stopping,
                onStop: async () => {
                  const confirmed = await confirmAction({
                    title: "Stop this change?",
                    description:
                      "Your app stays as it was before this change. You can ask again afterward.",
                    confirmLabel: "Stop change",
                    cancelLabel: "Keep going",
                    tone: "danger",
                  });
                  if (!confirmed) return null;
                  const error = await buildConversation.cancelRun(runningChange.id);
                  if (error) {
                    toast.add({
                      type: "error",
                      title: "Couldn't stop the change",
                      description: error,
                    });
                  }
                  return error;
                },
              }
            : isBuild && canStopBuild(buildConversation)
              ? {
                  ariaLabel: "Stop build",
                  stopping: buildConversation.stopping,
                  allowSend: true,
                  onStop: async () => {
                    const confirmed = await confirmAction({
                      title: "Stop this build?",
                      description: "Finished steps are kept. You can start a new build afterward.",
                      confirmLabel: "Stop build",
                      cancelLabel: "Keep building",
                      tone: "danger",
                    });
                    if (!confirmed) return null;
                    const error = await buildConversation.cancelRun();
                    if (error) {
                      toast.add({
                        type: "error",
                        title: "Couldn't stop the build",
                        description: error,
                      });
                    }
                    return error;
                  },
                }
              : undefined
        }
        externalRetry={
          isBuild &&
          !runningChange &&
          buildConversation.run?.id !== refusedRetryRunId &&
          canRetryFailedBuild(buildConversation)
            ? {
                ariaLabel: "Retry build",
                retrying: buildConversation.continuing,
                onRetry: async () => {
                  const error = await buildConversation.continueRun();
                  if (error && RETRY_FALLBACK_CODES.has(error.code)) {
                    setRefusedRetryRunId(buildConversation.run?.id ?? null);
                    toast.add({ type: "info", title: "This build can't be retried", description: error.message });
                  } else if (error) {
                    toast.add({
                      type: "error",
                      title: "Couldn't retry the build",
                      description: error.message,
                    });
                  }
                },
              }
            : undefined
        }
        autoExpandOnEngagement={shouldAutoExpandWebsiteChat(
          previewUrl,
          activelyBuilding || !build.loaded,
          previewRestartable,
        )}
        onRunCompleted={refreshAfterChatRun}
        onBeforeSend={onBeforeSend}
        onBuildSuggestionSend={isBuild ? onBuildSuggestionSend : undefined}
        scopeChip={scopePickable && scopePick ? { tag: scopePick.tag, text: scopePick.text, path: scopePick.path, thumb: scopePick.src } : null}
        onRemoveScopeChip={removeScopePick}
        fullWidthBelowLg={isBuild}
        narrowHidden={isBuild && narrowView === "app"}
        hidden={isBuild && chatHidden && !showBuildProgress}
        headerActions={isBuild ? buildChatActions : undefined}
        overlay={
          isBuild && historyOpen ? (
            <BuildHistoryPanel
              sessionId={buildSessionId}
              liveUrl={hostedPreviewUrl}
              selectedId={checkpointView?.id ?? null}
              prewarm={siteSession}
              onSelect={(view) => {
                setCheckpointView(siteSession ? { ...view, restorable: false, viewOnly: true } : view);
                setRevertError(null);
                setBuildPane("preview");
              }}
              onClose={closeHistory}
            />
          ) : undefined
        }
        narrowLeading={isBuild ? buildNarrowLeading : undefined}
        narrowTrailing={isBuild ? buildPaneToggle("app") : undefined}
      />
    </div>
  );
}

function ModeTabs({ mode, onMode }: { mode: Mode; onMode: (mode: Mode) => void }) {
  const { listRef, box } = useSlidingIndicator<HTMLDivElement>(mode);
  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label="Website view"
      className="relative flex w-[226px] items-center gap-2 rounded-full bg-[#f0f0f0] p-1"
    >
      <SlidingIndicator box={box} className="rounded-full bg-white shadow-sm" />
      <ModeButton active={mode === "preview"} onClick={() => onMode("preview")} label="Preview" />
      <ModeButton active={mode === "dashboard"} onClick={() => onMode("dashboard")} label="Dashboard" />
    </div>
  );
}

function ModeButton({
  active,
  onClick,
  label,
  compact = false,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`relative flex h-8 flex-1 items-center justify-center rounded-full font-semibold transition-colors duration-300 ${
        compact ? "px-3 text-[14px]" : "px-4 text-[16px]"
      } ${
        active ? "text-[#1f1f1f]" : "text-[#454545] hover:text-[#1f1f1f]"
      }`}
    >
      {label}
    </button>
  );
}

function HeaderIconButton({
  onClick,
  title,
  label,
  children,
  className,
  buttonRef,
  haspopup,
  expanded,
  compact,
  pressed,
  disabled,
}: {
  onClick: () => void;
  title?: string;
  label: string;
  disabled?: boolean;
  children: React.ReactNode;
  className?: string;
  buttonRef?: React.Ref<HTMLButtonElement>;
  haspopup?: "dialog";
  expanded?: boolean;
  compact?: boolean;
  pressed?: boolean;
}) {
  return (
      <button
        ref={buttonRef}
        type="button"
        onClick={onClick}
        title={title}
        aria-label={label}
        aria-haspopup={haspopup}
        aria-expanded={expanded}
        aria-pressed={pressed}
        disabled={disabled}
        className={`${className ?? "inline-flex"} h-8 w-8 shrink-0 items-center justify-center rounded-full ${
          compact ? "" : "border border-[#f0f0f0] bg-white"
        } transition-colors ${
          pressed
            ? "bg-bone text-ink ring-1 ring-inset ring-ink/15"
            : disabled
              ? "cursor-not-allowed text-[#b5b5b5]"
              : "text-[#454545] hover:bg-[#f4f4f4] hover:text-[#0e0f11]"
        }`}
      >
        {children}
      </button>
  );
}
