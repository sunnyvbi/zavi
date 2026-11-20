"use client";

import { NeedsYouLine } from "./NeedsYouLine";
import { requestFullPageBack } from "@/lib/workspace/fullPageBack";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { rememberWebsiteView } from "../website/websiteUrlParams";
import {
  buildPreviewStamp,
  contextAutoCollapseOnPreview,
  previewSteppedAside,
  dismissalAfterClose,
  shouldAutoOpenPreview,
  shouldOpenTargetPreview,
  isAppWorkspaceTarget,
  NOTHING_DISMISSED,
  type PreviewCloseReason,
  type PreviewDismissal,
} from "./buildPreviewAutoOpen";
import { useWorkspaceLocation } from "../navigation/useWorkspaceLocation";
import { workspaceSkipHref } from "../navigation/workspaceRoutes";
import { BarChart3, PanelLeftOpen } from "lucide-react";
import { ContextPanel, ContextRail } from "./ContextPanel";
import { ChatColumn } from "./ChatColumn";
import {
  BUILD_CHAT_DEFAULT_PX,
  BUILD_CHAT_WIDTH_KEY,
  BUILD_SPLIT_MIN_PX,
  buildChatCeiling,
  clampBuildChatWidth,
} from "./buildSplit";
import { View360 } from "./View360";
import { prefetchChannelLocks } from "./useChannelLocks";
import { ChannelsPanel } from "./ChannelsPanel";
import { WorkspaceDrawer } from "./WorkspaceDrawer";
import { CompactNavOverlay } from "./CompactNavOverlay";
import { cx, FOCUS_RING, useOpenStatic } from "./shared";
import {
  readStored,
  useStoredFlag,
  writeStored,
} from "./workspacePrefs";
import {
  COLUMN_LABEL,
  COLUMN_MIN_WIDTH_PX,
  COLUMN_WIDTH_STORAGE_KEY,
  DEFAULT_COLUMN_WIDTH_WEIGHTS,
  effectiveCollapse,
  distributeColumnWidths,
  parseColumnWidthWeights,
  resizeColumnsAcrossDivider,
  useColumnOrder,
  type ColumnId,
  type ColumnWidthWeights,
} from "./columnLayout";
import {
  MobileIconButton,
  MobileMenuIcon,
  MobileNewChatIcon,
} from "@/components/mobile";
import { createDragButtonWatch } from "@/hooks/dragButtonWatch";
import { useIsCompact, useMediaMatch } from "@/lib/responsive";
import { applyThemeColor, resolveDark, THEME_KEY } from "@/lib/themeColor";
import { useWorkspace } from "../WorkspaceShell";
import type { ColumnChrome } from "./columnChrome";
import { useNewTaskLanding } from "./useNewTaskLanding";
import { BOARD_TAB_PARAM } from "../navigation/workspaceRoutes";
import type { BuildPreviewProgress, BuildPreviewTarget } from "../build/BuildPreviewPanel";
import { AppWorkspace } from "../WebsiteTab";
import type { WorkspaceMode } from "../ZaviWelcome";

const COLUMN_KINDS = new Set(["home", "agent", "build"]);
const DRAWER_KINDS = new Set<string>(["onboarding"]);

const CHANNELS_RAIL_PX = 48;
const CONTEXT_RAIL_PX = 48;
const CONTEXT_FULLPAGE_PX = 280;
const FULLPAGE_NAV_WIDTH_KEY = "zavi:fullpage-nav-width";
const FULLPAGE_NAV_MAX_PX = 560;
const FULLPAGE_CONTENT_MIN_PX = 420;
const COLUMNS_ROW_PADDING_PX = 12;
const COLUMN_GAP_PX = 8;
const KEYBOARD_RESIZE_STEP_PX = 16;

export type Theme = "dark" | "light" | "system";

const THEME_STORED: Record<Theme, string | null> = { dark: "1", light: "0", system: null };

function readTheme(): Theme {
  const stored = readStored(THEME_KEY);
  return stored === "1" ? "dark" : stored === "0" ? "light" : "system";
}

function useTheme() {
  const [theme, setThemeState] = useState<Theme>("system");
  const [systemDark, setSystemDark] = useState(false);
  useEffect(() => {
    setThemeState(readTheme());
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => setSystemDark(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  const dark = resolveDark(THEME_STORED[theme], systemDark);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    return applyThemeColor(dark);
  }, [dark]);
  useEffect(() => () => document.documentElement.classList.remove("dark"), []);
  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    try {
      if (next === "system") window.localStorage.removeItem(THEME_KEY);
      else writeStored(THEME_KEY, next === "dark" ? "1" : "0");
    } catch {}
  }, []);
  return { theme, dark, setTheme };
}

type ResizeTargetId = ColumnId | "preview";
const RESIZE_TARGET_LABEL: Record<ResizeTargetId, string> = {
  ...COLUMN_LABEL,
  preview: "Preview",
};

function ColumnResizeHandle({
  leftId,
  rightId,
  prominent = false,
  onMouseDown,
  onKeyDown,
  onReset,
}: {
  leftId: ColumnId;
  rightId: ResizeTargetId;
  prominent?: boolean;
  onMouseDown: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  onReset: () => void;
}) {
  const label = `Resize ${RESIZE_TARGET_LABEL[leftId]} and ${RESIZE_TARGET_LABEL[rightId]} panels`;
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!dragging) return;
    const end = () => setDragging(false);
    window.addEventListener("mouseup", end);
    window.addEventListener("blur", end);
    return () => {
      window.removeEventListener("mouseup", end);
      window.removeEventListener("blur", end);
    };
  }, [dragging]);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      tabIndex={0}
      title="Drag to resize · double-click to reset panel widths"
      data-testid={`column-resizer-${leftId}-${rightId}`}
      onMouseDown={(event) => {
        if (event.button === 0) setDragging(true);
        onMouseDown(event);
      }}
      onDoubleClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onReset();
      }}
      onKeyDown={onKeyDown}
      className={cx(
        "group absolute inset-y-0 -right-2 z-40 w-2.5 cursor-col-resize touch-none outline-none",
        prominent &&
          "focus-visible:ring-2 focus-visible:ring-ink/20 focus-visible:ring-offset-0",
      )}
    >
      <span
        className={cx(
          "pointer-events-none absolute left-1/2 w-px -translate-x-1/2 rounded-full transition-colors group-focus-visible:bg-ink/40",
          prominent ? "inset-y-0" : "inset-y-3",
          dragging
            ? "bg-ink/40"
            : prominent
              ? "bg-rule group-hover:bg-ink/25"
              : "bg-transparent group-hover:bg-ink/25",
        )}
      />
    </div>
  );
}

function WorkspaceColumn({
  id,
  collapsed,
  hidden,
  fixedWidth,
  resizedWidth,
  minimumWidth,
  resizeHandle,
  children,
}: {
  id: ColumnId;
  collapsed: boolean;
  hidden?: boolean;
  fixedWidth?: number;
  resizedWidth?: number;
  minimumWidth?: number;
  resizeHandle?: ReactNode;
  children: (chrome: ColumnChrome) => ReactNode;
}) {
  const chrome: ColumnChrome = { dropProps: {} };
  return (
    <div
      style={{
        ...(hidden ? { display: "none" } : {}),
        ...(!collapsed && minimumWidth ? { minWidth: minimumWidth } : {}),
        ...(!collapsed && resizedWidth !== undefined
          ? { width: resizedWidth }
          : fixedWidth && !collapsed
            ? { width: fixedWidth }
            : {}),
      }}
      data-workspace-column={id}
      className={cx(
        "group/column relative flex h-full min-h-0",
        id === "context" && "compact:hidden",
        collapsed || fixedWidth || resizedWidth !== undefined
          ? "shrink-0"
          : "min-w-0 basis-0 flex-1",
      )}
    >
      {children(chrome)}
      {resizeHandle}
    </div>
  );
}

const narrowViewport = () => window.innerWidth < 1280;
const veryNarrowViewport = () => window.innerWidth < 1600;

const NAV_REACHABLE_KINDS = new Set<string>([
  "artifacts",
  "build",
  "analytics",
  "channels",
  "needs-you",
  "messaging",
  "autopilot",
  "brain",
  "fundraising",
  "supply-demand",
  "engineer",
  "agent-builder",
]);

export function WorkspaceLayout() {
  const workspaceLocation = useWorkspaceLocation();
  const [contextHidden, setContextHidden] = useStoredFlag(
    "zavi:context-hidden",
    narrowViewport,
  );
  const [channelsHidden, setChannelsHidden] = useStoredFlag(
    "zavi:channels-hidden",
    veryNarrowViewport,
  );
  const [analyticsHidden, setAnalyticsHidden] = useStoredFlag(
    "zavi:analytics-hidden",
    () => false,
  );
  const { theme, setTheme } = useTheme();
  const [buildPreview, setBuildPreview] = useState<{
    sessionId: string | null;
    target: BuildPreviewTarget;
  } | null>(null);
  const [previewPending, setPreviewPending] = useState(false);
  const [previewHiddenAt, setPreviewHiddenAt] = useState<string | null>(null);
  const previewStampRef = useRef<string | null>(null);
  const previewDismissedForRef = useRef<PreviewDismissal>(NOTHING_DISMISSED);
  const [buildChatCollapsed, setBuildChatCollapsed] = useState(false);
  const [buildFocusNonce, setBuildFocusNonce] = useState(0);
  const [buildResetNonce, setBuildResetNonce] = useState(0);
  const [mobileContextOpen, setMobileContextOpen] = useState(false);
  const closeMobileContext = useCallback(() => setMobileContextOpen(false), []);
  const compactViewport = useIsCompact();
  const buildSplitWide = useMediaMatch(`(min-width: ${BUILD_SPLIT_MIN_PX}px)`);
  useEffect(() => {
    if (!compactViewport) setMobileContextOpen(false);
  }, [compactViewport]);
  useEffect(() => {
    if (compactViewport) return;
    const pin = () => {
      if (window.scrollY === 0 && window.scrollX === 0) return;
      const el = document.activeElement;
      const typing = el instanceof HTMLElement && el.matches('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
      if (typing && !window.matchMedia("(pointer: fine)").matches) return;
      window.scrollTo(0, 0);
    };
    pin();
    window.addEventListener("scroll", pin);
    return () => window.removeEventListener("scroll", pin);
  }, [compactViewport]);
  useEffect(() => {
    prefetchChannelLocks();
  }, []);
  const { order } = useColumnOrder();
  const columnsRowRef = useRef<HTMLDivElement>(null);
  const [columnsRowWidth, setColumnsRowWidth] = useState(0);
  const [columnWeights, setColumnWeights] = useState<ColumnWidthWeights | null>(
    null,
  );
  const columnWeightsRef = useRef<ColumnWidthWeights | null>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const [resizingColumns, setResizingColumns] = useState(false);

  useEffect(() => {
    const stored = parseColumnWidthWeights(
      readStored(COLUMN_WIDTH_STORAGE_KEY),
    );
    if (!stored) return;
    columnWeightsRef.current = stored;
    setColumnWeights(stored);
  }, []);

  useEffect(() => {
    const row = columnsRowRef.current;
    if (!row) return;
    const measure = () => setColumnsRowWidth(row.clientWidth);
    measure();
    const initialFrame = window.requestAnimationFrame(measure);
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(row);
    window.addEventListener("resize", measure);
    return () => {
      window.cancelAnimationFrame(initialFrame);
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  useEffect(
    () => () => {
      resizeCleanupRef.current?.();
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    },
    [],
  );

  const setTransientColumnWeights = useCallback((next: ColumnWidthWeights) => {
    columnWeightsRef.current = next;
    setColumnWeights(next);
  }, []);

  const persistColumnWeights = useCallback(
    (next: ColumnWidthWeights) => {
      setTransientColumnWeights(next);
      writeStored(COLUMN_WIDTH_STORAGE_KEY, JSON.stringify(next));
    },
    [setTransientColumnWeights],
  );

  const resetColumnWidths = useCallback(() => {
    columnWeightsRef.current = null;
    setColumnWeights(null);
    try {
      window.localStorage.removeItem(COLUMN_WIDTH_STORAGE_KEY);
    } catch {}
  }, []);

  const measureColumnWidths = useCallback(
    (ids: ColumnId[]): ColumnWidthWeights => {
      const widths: ColumnWidthWeights = {
        ...DEFAULT_COLUMN_WIDTH_WEIGHTS,
        ...(columnWeightsRef.current ?? {}),
      };
      const row = columnsRowRef.current;
      if (!row) return widths;
      for (const id of ids) {
        const column = row.querySelector<HTMLElement>(
          `[data-workspace-column="${id}"]`,
        );
        const width = column?.getBoundingClientRect().width ?? 0;
        if (width > 0) widths[id] = width;
      }
      return widths;
    },
    [],
  );

  const beginColumnResize = useCallback(
    (
      leftId: ColumnId,
      rightId: ColumnId,
      expandedIds: ColumnId[],
      event: ReactMouseEvent<HTMLDivElement>,
    ) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      resizeCleanupRef.current?.();

      const startX = event.clientX;
      const startWidths = measureColumnWidths(expandedIds);
      const stillHeld = createDragButtonWatch();
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const onMove = (moveEvent: MouseEvent) => {
        if (!stillHeld(moveEvent.buttons)) {
          onUp();
          return;
        }
        setResizingColumns(true);
        setTransientColumnWeights(
          resizeColumnsAcrossDivider(
            startWidths,
            expandedIds,
            leftId,
            rightId,
            moveEvent.clientX - startX,
          ),
        );
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        window.removeEventListener("blur", onUp);
        resizeCleanupRef.current = null;
        setResizingColumns(false);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        const latest = columnWeightsRef.current;
        if (latest) {
          writeStored(COLUMN_WIDTH_STORAGE_KEY, JSON.stringify(latest));
        }
      };
      const cleanup = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        window.removeEventListener("blur", onUp);
      };

      resizeCleanupRef.current = cleanup;
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      window.addEventListener("blur", onUp);
    },
    [measureColumnWidths, setTransientColumnWeights],
  );

  const [fullPageNavWidth, setFullPageNavWidth] = useState(CONTEXT_FULLPAGE_PX);
  const fullPageNavWidthRef = useRef(CONTEXT_FULLPAGE_PX);

  useEffect(() => {
    const stored = Number(readStored(FULLPAGE_NAV_WIDTH_KEY));
    if (!Number.isFinite(stored) || stored <= 0) return;
    fullPageNavWidthRef.current = stored;
    setFullPageNavWidth(stored);
  }, []);

  const clampNavWidth = useCallback(
    (width: number) => {
      const ceiling = Math.max(
        COLUMN_MIN_WIDTH_PX.context,
        Math.min(
          FULLPAGE_NAV_MAX_PX,
          columnsRowWidth > 0
            ? columnsRowWidth -
                COLUMNS_ROW_PADDING_PX -
                COLUMN_GAP_PX -
                FULLPAGE_CONTENT_MIN_PX
            : FULLPAGE_NAV_MAX_PX,
        ),
      );
      return Math.round(
        Math.min(ceiling, Math.max(COLUMN_MIN_WIDTH_PX.context, width)),
      );
    },
    [columnsRowWidth],
  );

  const applyNavWidth = useCallback(
    (width: number, persist: boolean) => {
      const next = clampNavWidth(width);
      fullPageNavWidthRef.current = next;
      setFullPageNavWidth(next);
      if (persist) writeStored(FULLPAGE_NAV_WIDTH_KEY, String(next));
    },
    [clampNavWidth],
  );

  const beginNavResize = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      resizeCleanupRef.current?.();

      const startX = event.clientX;
      const startWidth = fullPageNavWidthRef.current;
      const stillHeld = createDragButtonWatch();
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const onMove = (moveEvent: MouseEvent) => {
        if (!stillHeld(moveEvent.buttons)) {
          onUp();
          return;
        }
        setResizingColumns(true);
        applyNavWidth(startWidth + (moveEvent.clientX - startX), false);
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        window.removeEventListener("blur", onUp);
        resizeCleanupRef.current = null;
        setResizingColumns(false);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        writeStored(
          FULLPAGE_NAV_WIDTH_KEY,
          String(fullPageNavWidthRef.current),
        );
      };
      resizeCleanupRef.current = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        window.removeEventListener("blur", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      window.addEventListener("blur", onUp);
    },
    [applyNavWidth],
  );

  const resetNavWidth = useCallback(() => {
    fullPageNavWidthRef.current = CONTEXT_FULLPAGE_PX;
    setFullPageNavWidth(CONTEXT_FULLPAGE_PX);
    try {
      window.localStorage.removeItem(FULLPAGE_NAV_WIDTH_KEY);
    } catch {}
  }, []);

  const [buildChatWidth, setBuildChatWidth] = useState(BUILD_CHAT_DEFAULT_PX);
  const buildChatWidthRef = useRef(BUILD_CHAT_DEFAULT_PX);

  const measureBuildChatCeiling = useCallback(() => {
    const row = columnsRowRef.current;
    const chat = row?.querySelector<HTMLElement>(
      '[data-workspace-column="chat"]',
    );
    if (!row || !chat) return Number.POSITIVE_INFINITY;
    return buildChatCeiling({
      rowRight: row.getBoundingClientRect().right,
      chatLeft: chat.getBoundingClientRect().left,
      gapPx: COLUMN_GAP_PX,
      rowPaddingPx: COLUMNS_ROW_PADDING_PX,
      screenWidth: window.innerWidth,
    });
  }, []);

  const applyBuildChatWidth = useCallback(
    (width: number, persist: boolean) => {
      const next = clampBuildChatWidth(width, measureBuildChatCeiling());
      buildChatWidthRef.current = next;
      setBuildChatWidth(next);
      if (persist) writeStored(BUILD_CHAT_WIDTH_KEY, String(next));
    },
    [measureBuildChatCeiling],
  );

  useEffect(() => {
    const rawStored = Number(readStored(BUILD_CHAT_WIDTH_KEY));
    if (!Number.isFinite(rawStored) || rawStored <= 0) return;
    const stored = clampBuildChatWidth(rawStored, measureBuildChatCeiling());
    buildChatWidthRef.current = stored;
    setBuildChatWidth(stored);
  }, [measureBuildChatCeiling]);

  const beginBuildChatResize = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      resizeCleanupRef.current?.();

      const startX = event.clientX;
      const startWidth = buildChatWidthRef.current;
      const stillHeld = createDragButtonWatch();
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const onMove = (moveEvent: MouseEvent) => {
        if (!stillHeld(moveEvent.buttons)) {
          onUp();
          return;
        }
        setResizingColumns(true);
        applyBuildChatWidth(startWidth + (moveEvent.clientX - startX), false);
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        window.removeEventListener("blur", onUp);
        resizeCleanupRef.current = null;
        setResizingColumns(false);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        writeStored(BUILD_CHAT_WIDTH_KEY, String(buildChatWidthRef.current));
      };
      resizeCleanupRef.current = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        window.removeEventListener("blur", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      window.addEventListener("blur", onUp);
    },
    [applyBuildChatWidth],
  );

  const resetBuildChatWidth = useCallback(() => {
    buildChatWidthRef.current = BUILD_CHAT_DEFAULT_PX;
    setBuildChatWidth(BUILD_CHAT_DEFAULT_PX);
    try {
      window.localStorage.removeItem(BUILD_CHAT_WIDTH_KEY);
    } catch {}
  }, []);

  useEffect(() => {
    const onResize = () => applyBuildChatWidth(buildChatWidthRef.current, false);
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [applyBuildChatWidth]);

  const stepColumnResize = useCallback(
    (
      leftId: ColumnId,
      rightId: ColumnId,
      expandedIds: ColumnId[],
      deltaPx: number,
    ) => {
      persistColumnWeights(
        resizeColumnsAcrossDivider(
          measureColumnWidths(expandedIds),
          expandedIds,
          leftId,
          rightId,
          deltaPx,
        ),
      );
    },
    [measureColumnWidths, persistColumnWeights],
  );
  const {
    tabs,
    activeTabId,
    setActiveTab,
    openTab,
    openBuildTab,
    openAgentTab,
    buildSessionId,
  } = useWorkspace();
  const openStatic = useOpenStatic();
  const activeTab = tabs.find((t) => t.id === activeTabId);

  const activeThreadKey =
    activeTab?.payload.kind === "agent" || activeTab?.payload.kind === "home"
      ? (activeTab.payload.threadId ?? "")
      : "";
  const chatStarted = activeThreadKey !== "";
  const navigationKey = `${activeTabId}:${activeThreadKey}`;
  const lastNavigationKey = useRef(navigationKey);
  useEffect(() => {
    if (lastNavigationKey.current === navigationKey) return;
    lastNavigationKey.current = navigationKey;
    setMobileContextOpen(false);
  }, [navigationKey]);
  useNewTaskLanding(openAgentTab);
  const workspaceMode: WorkspaceMode =
    activeTab?.kind === "build" ? "build" : "grow";
  const chatFocus = activeTab?.kind !== "home";
  const hideBuildPreview = useCallback(
    (reason: PreviewCloseReason) => {
      previewDismissedForRef.current = dismissalAfterClose(
        reason,
        buildSessionId,
        previewDismissedForRef.current,
      );
      setBuildPreview(null);
      setPreviewPending(false);
      setPreviewHiddenAt(null);
      setBuildChatCollapsed(false);
    },
    [buildSessionId],
  );
  const closeBuildPreview = useCallback(
    () => hideBuildPreview("user"),
    [hideBuildPreview],
  );
  const buildPreviewProgress = useCallback(
    (progress: BuildPreviewProgress | null) => {
      if (
        !shouldAutoOpenPreview({
          hasProgress: !!progress,
          splitWide: buildSplitWide,
          sessionId: buildSessionId,
          dismissedFor: previewDismissedForRef.current,
        })
      )
        return;
      setPreviewPending(true);
    },
    [buildSessionId, buildSplitWide],
  );
  useEffect(() => {
    if (buildPreview && buildPreview.sessionId !== buildSessionId) {
      setBuildPreview(null);
      setPreviewPending(buildSessionId !== null);
      setPreviewHiddenAt(null);
    }
  }, [buildPreview, buildSessionId]);
  const drawerTab =
    activeTab && DRAWER_KINDS.has(activeTab.kind) ? activeTab : null;
  const overlayTab = drawerTab;
  const backgroundTabId = useRef<string | null>(null);
  if (activeTab && COLUMN_KINDS.has(activeTab.kind)) {
    backgroundTabId.current = activeTab.id;
  }
  const backgroundTab =
    tabs.find(
      (t) => t.id === backgroundTabId.current && COLUMN_KINDS.has(t.kind),
    ) ?? tabs.find((t) => COLUMN_KINDS.has(t.kind));
  const fullPage =
    !!activeTab && !COLUMN_KINDS.has(activeTab.kind) && !overlayTab;
  const analyticsFullPage = fullPage && activeTab?.kind === "analytics";
  const builderEligible =
    activeTab?.kind === "home" ||
    activeTab?.kind === "build" ||
    (activeTab?.kind === "agent" &&
      (activeTab.payload as { slug?: string }).slug === "operator");
  const closeOverlay = useCallback(() => {
    if (backgroundTab) setActiveTab(backgroundTab.id);
  }, [backgroundTab, setActiveTab]);
  const exitFullPage = () => {
    if (requestFullPageBack()) return;
    const back =
      tabs.find((t) => t.kind === "home") ??
      tabs.find((t) => t.kind === "agent");
    if (back) setActiveTab(back.id);
  };
  const resetBuild = useCallback(() => {
    openBuildTab(null);
    setBuildResetNonce((value) => value + 1);
    setBuildFocusNonce((value) => value + 1);
    setPreviewHiddenAt(null);
  }, [openBuildTab]);
  const buildSurface =
    workspaceMode === "build" && builderEligible && !fullPage;
  const buildPreviewWanted = useCallback(() => {
    if (!buildSurface) return;
    if (buildPreview && buildPreview.sessionId === buildSessionId) {
      setBuildPreview(null);
      setPreviewPending(true);
      return;
    }
    if (
      !shouldAutoOpenPreview({
        hasProgress: true,
        splitWide: buildSplitWide,
        sessionId: buildSessionId,
        dismissedFor: previewDismissedForRef.current,
      })
    )
      return;
    setPreviewPending(true);
  }, [buildPreview, buildSessionId, buildSplitWide, buildSurface]);
  const openBuildPreview = useCallback(
    (target: BuildPreviewTarget, intent?: "user") => {
      if (!buildSurface) return;
      setBuildPreview((prev) => {
        if (prev && prev.sessionId === buildSessionId) {
          return prev.target === target
            ? prev
            : { sessionId: buildSessionId, target };
        }
        if (
          intent !== "user" &&
          !shouldOpenTargetPreview({
            splitWide: buildSplitWide,
            sessionId: buildSessionId,
            dismissedFor: previewDismissedForRef.current,
            openForSession: previewPending || isAppWorkspaceTarget(target),
          })
        )
          return prev;
        return { sessionId: buildSessionId, target };
      });
      if (intent === "user") {
        previewDismissedForRef.current = NOTHING_DISMISSED;
        setPreviewHiddenAt(null);
      }
      setPreviewPending(false);
    },
    [buildSessionId, buildSplitWide, buildSurface, previewPending],
  );
  const showBuildApp = useCallback(() => {
    previewDismissedForRef.current = NOTHING_DISMISSED;
    setPreviewHiddenAt(null);
    setPreviewPending(true);
  }, []);
  const buildPreviewUnavailable = useCallback(() => {
    setPreviewPending(false);
    setBuildChatCollapsed(false);
  }, []);
  const fullChatSurface =
    (buildSurface || chatFocus) && builderEligible && !fullPage;
  const previewOpen = !!buildPreview || previewPending;
  const previewMounted = previewOpen && buildSurface;
  const appWorkspace = !!buildPreview && isAppWorkspaceTarget(buildPreview.target);
  const previewStamp = buildPreviewStamp(buildPreview?.target);
  const previewHidden = previewSteppedAside(previewHiddenAt, previewStamp);
  useEffect(() => {
    previewStampRef.current = previewStamp;
  }, [previewStamp]);
  const showBuildPreview = previewMounted && !previewHidden;
  useEffect(() => {
    if (!buildSurface && previewOpen) hideBuildPreview("surface");
  }, [buildSurface, hideBuildPreview, previewOpen]);
  const [contextAutoCollapsed, setContextAutoCollapsed] = useState(false);
  useEffect(() => {
    setContextAutoCollapsed((previous) =>
      contextAutoCollapseOnPreview({
        previewOpen: showBuildPreview,
        contextHidden,
        previous,
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showBuildPreview]);
  const appWorkspaceSessionRef = useRef<string | null>(null);
  useEffect(() => {
    if (!previewMounted) {
      appWorkspaceSessionRef.current = null;
      return;
    }
    if (appWorkspaceSessionRef.current === buildSessionId) return;
    appWorkspaceSessionRef.current = buildSessionId;
    setBuildChatCollapsed(true);
  }, [previewMounted, buildSessionId]);

  const compactCollapse = effectiveCollapse({
    compact: compactViewport,
    context: contextHidden || contextAutoCollapsed,
    channels: channelsHidden,
    analytics: analyticsHidden,
    contextEscapeOpen: buildSurface && mobileContextOpen,
  });
  const effectiveContextHidden = compactCollapse.context;
  const effectiveChannelsHidden = compactCollapse.channels;
  const effectiveAnalyticsHidden = compactCollapse.analytics;
  useEffect(() => {
    if (!showBuildPreview || !buildSplitWide) return;
    applyBuildChatWidth(buildChatWidthRef.current, false);
  }, [
    applyBuildChatWidth,
    buildSplitWide,
    effectiveContextHidden,
    showBuildPreview,
  ]);
  const channelsColumnPresent = !buildSurface && !fullPage && !chatFocus;
  const railsMerged =
    effectiveContextHidden && effectiveChannelsHidden && channelsColumnPresent;
  const analyticsMergedIntoContext =
    effectiveContextHidden && effectiveAnalyticsHidden && channelsColumnPresent;
  const analyticsMergedIntoChannels =
    !effectiveContextHidden &&
    effectiveChannelsHidden &&
    effectiveAnalyticsHidden &&
    channelsColumnPresent;
  const isColumnCollapsed = (id: ColumnId) =>
    (id === "context" && effectiveContextHidden) ||
    (id === "channels" && effectiveChannelsHidden) ||
    (id === "analytics" && effectiveAnalyticsHidden);
  const expandContext = () => {
    setContextAutoCollapsed(false);
    if (buildSurface && compactViewport) {
      setMobileContextOpen(true);
      return;
    }
    setContextHidden(false);
  };
  const showChannels = () => {
    if (compactViewport) {
      openStatic("channels");
      return;
    }
    setChannelsHidden(false);
  };
  const showAnalytics = () => {
    if (compactViewport) {
      openStatic("analytics");
      return;
    }
    setAnalyticsHidden(false);
  };
  const analyticsRailControls = (
    <button
      type="button"
      onClick={showAnalytics}
      aria-label="Show analytics"
      title="Show analytics"
      className={cx(
        "flex h-10 w-10 items-center justify-center rounded-cta text-ink hover:bg-bone",
        FOCUS_RING,
      )}
    >
      <BarChart3 className="h-[18px] w-[18px]" aria-hidden />
    </button>
  );
  const renderColumn = (id: ColumnId, chrome: ColumnChrome) => {
    if (id === "context") {
      return effectiveContextHidden ? (
        <div
          key={id}
          style={{ width: CONTEXT_RAIL_PX }}
          className="flex h-full shrink-0 flex-col items-center rounded-[16px] bg-cream pt-2 shadow-elev"
        >
          {}
          {!(compactViewport && !buildSurface) && (
            <button
              type="button"
              onClick={expandContext}
              aria-label="Show context"
              title="Show context"
              className={cx(
                "inline-flex h-8 w-8 items-center justify-center rounded-cta text-inkLight hover:bg-bone hover:text-ink",
                FOCUS_RING,
              )}
            >
              <PanelLeftOpen className="h-[18px] w-[18px]" aria-hidden />
            </button>
          )}
          <ContextRail
            onExpand={expandContext}
            chatFocus={chatFocus}
          />
          {railsMerged && (
            <>
              {}
              <span
                aria-hidden
                className="my-1.5 h-px w-6 shrink-0 rounded-full bg-rule"
              />
              <ChannelsPanel collapsed inlineRail onToggle={showChannels} />
            </>
          )}
          {analyticsMergedIntoContext && (
            <>
              <span
                aria-hidden
                className="my-1.5 h-px w-6 shrink-0 rounded-full bg-rule"
              />
              {analyticsRailControls}
            </>
          )}
        </div>
      ) : (
        <ContextPanel
          key={id}
          chrome={chrome}
          onCollapse={() => {
            setMobileContextOpen(false);
            setContextHidden(true);
          }}
          theme={theme}
          onSetTheme={setTheme}
          chatFocus={chatFocus}
          buildChatFollowsThread={appWorkspace}
        />
      );
    }
    if (id === "chat")
      return (
        <ChatColumn
          key={id}
          chrome={chrome}
          compactLeading={
            compactViewport ? (
              <MobileIconButton
                label="Open navigation"
                aria-expanded={mobileContextOpen}
                aria-haspopup="dialog"
                onClick={() => setMobileContextOpen(true)}
              >
                <MobileMenuIcon className="h-[18px] w-[18px]" />
              </MobileIconButton>
            ) : undefined
          }
          compactTrailing={
            compactViewport && chatStarted ? (
              <MobileIconButton
                label="New chat"
                onClick={() => {
                  void openAgentTab("operator", {
                    newThread: true,
                    push: true,
                  });
                }}
              >
                <MobileNewChatIcon className="h-[21px] w-[21px]" />
              </MobileIconButton>
            ) : undefined
          }
          fullPage={fullPage}
          onExitFullPage={exitFullPage}
          showExitFullPage={!NAV_REACHABLE_KINDS.has(activeTab?.kind ?? "")}
          displayTabId={overlayTab ? backgroundTab?.id : undefined}
          workspaceMode={workspaceMode}
          previewOpen={showBuildPreview}
          buildFocusNonce={buildFocusNonce}
          buildResetNonce={buildResetNonce}
          onResetBuild={resetBuild}
          onOpenBuildPreview={openBuildPreview}
          onCloseBuildPreview={closeBuildPreview}
          onBuildPreviewUnavailable={buildPreviewUnavailable}
          onBuildPreviewWanted={buildPreviewWanted}
          onBuildPreviewProgress={buildPreviewProgress}
          onShowBuildApp={showBuildApp}
          chatFocus={chatFocus}
        />
      );
    if (id === "analytics") {
      if (effectiveAnalyticsHidden) {
        return (
          <aside
            key={id}
            aria-label="Analytics"
            style={{ width: CHANNELS_RAIL_PX }}
            className="flex h-full shrink-0 flex-col items-center gap-2 rounded-[16px] bg-cream pt-3 shadow-elev"
            {...(chrome?.dropProps ?? {})}
          >
            {analyticsRailControls}
          </aside>
        );
      }
      return (
        <section
          key={id}
          aria-label="Analytics"
          className="flex h-full min-h-0 w-full flex-col overflow-hidden rounded-[16px] bg-cream shadow-elev"
        >
          <View360
            chrome={chrome}
            onCollapse={() => setAnalyticsHidden(true)}
            onExpand={() => openStatic("analytics")}
          />
        </section>
      );
    }
    return (
      <ChannelsPanel
        key={id}
        collapsed={effectiveChannelsHidden}
        width={effectiveChannelsHidden ? CHANNELS_RAIL_PX : undefined}
        onToggle={
          effectiveChannelsHidden ? showChannels : () => setChannelsHidden(true)
        }
        chrome={chrome}
        railExtra={analyticsMergedIntoChannels ? analyticsRailControls : undefined}
      />
    );
  };

  const visibleOrder: ColumnId[] = buildSurface
    ? ["context", "chat"]
    : fullPage || chatFocus
      ? order.filter((id) => id === "context" || id === "chat")
      : order.filter(
          (id) =>
            !(id === "channels" && railsMerged) &&
            !(
              id === "analytics" &&
              (analyticsMergedIntoContext || analyticsMergedIntoChannels)
            ),
        );
  const columnOrder: ColumnId[] = compactViewport
    ? visibleOrder.filter((id) => id !== "context")
    : visibleOrder;
  const columnResizingEnabled =
    !compactViewport && !buildSurface && !fullPage && !chatFocus;
  const expandedColumnIds = columnOrder.filter((id) => !isColumnCollapsed(id));
  const collapsedWidth = columnOrder.reduce(
    (total, id) =>
      total +
      (isColumnCollapsed(id)
        ? id === "context"
          ? CONTEXT_RAIL_PX
          : CHANNELS_RAIL_PX
        : 0),
    0,
  );
  const minimumExpandedWidth = expandedColumnIds.reduce(
    (total, id) => total + COLUMN_MIN_WIDTH_PX[id],
    0,
  );
  const availableExpandedWidth = Math.max(
    minimumExpandedWidth,
    columnsRowWidth -
      COLUMNS_ROW_PADDING_PX -
      COLUMN_GAP_PX * Math.max(0, columnOrder.length - 1) -
      collapsedWidth,
  );
  const resizedColumnWidths =
    columnResizingEnabled && columnWeights && columnsRowWidth > 0
      ? distributeColumnWidths(
          expandedColumnIds,
          availableExpandedWidth,
          columnWeights,
        )
      : null;

  return (
    <div
      className={cx(
        "workspace-shell flex h-screen w-screen flex-col overflow-hidden bg-bone pt-[var(--service-banner-h,0px)] text-ink compact:h-[var(--app-height)]",
        compactViewport && "compact-safe-bottom",
        resizingColumns && "cursor-col-resize select-none",
      )}
      onScroll={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.currentTarget.scrollTop !== 0) e.currentTarget.scrollTop = 0;
        if (e.currentTarget.scrollLeft !== 0) e.currentTarget.scrollLeft = 0;
      }}
    >
      <a href={workspaceSkipHref(workspaceLocation)} className="skip-to-main">
        Skip to main content
      </a>
      {resizingColumns && (
        <div
          aria-hidden
          data-testid="resize-pointer-shield"
          className="fixed inset-0 z-[60] cursor-col-resize"
        />
      )}
          {}
          <NeedsYouLine />
          {}
          <div
            ref={columnsRowRef}
            className={cx(
              "ws-scroll relative flex min-h-0 flex-1 overflow-x-auto !overflow-y-hidden px-1.5 pt-1.5 compact:gap-0 compact:px-0 compact:pt-0",
              analyticsFullPage ? "gap-0" : "gap-2",
            )}
            onScroll={(e) => {
              if (e.currentTarget.scrollTop !== 0 && !resizingColumns) {
                e.currentTarget.scrollTop = 0;
              }
            }}
          >
            {columnOrder.map((id, index) => {
              const collapsed = isColumnCollapsed(id);
              const nextId = columnOrder[index + 1];
              const canResizeAfter =
                columnResizingEnabled &&
                !collapsed &&
                nextId !== undefined &&
                !isColumnCollapsed(nextId);
              const canResizeNavAfter =
                fullPage &&
                id === "context" &&
                !collapsed &&
                nextId !== undefined &&
                !isColumnCollapsed(nextId);
              const canResizeBuildAfter =
                showBuildPreview &&
                buildSplitWide &&
                id === "chat" &&
                !collapsed &&
                !buildChatCollapsed;
              return (
                <WorkspaceColumn
                  key={id}
                  id={id}
                  collapsed={collapsed}
                  hidden={
                    showBuildPreview && buildChatCollapsed && id === "chat"
                  }
                  fixedWidth={
                    showBuildPreview && id === "chat"
                      ? buildChatWidth
                      : id === "context"
                        ? fullPage
                          ? fullPageNavWidth
                          : CONTEXT_FULLPAGE_PX
                        : undefined
                  }
                  resizedWidth={resizedColumnWidths?.[id]}
                  minimumWidth={
                    !collapsed && !buildSurface
                      ? COLUMN_MIN_WIDTH_PX[id]
                      : undefined
                  }
                  resizeHandle={
                    canResizeBuildAfter ? (
                      <ColumnResizeHandle
                        leftId="chat"
                        rightId="preview"
                        prominent
                        onMouseDown={beginBuildChatResize}
                        onKeyDown={(event) => {
                          const delta =
                            event.key === "ArrowLeft"
                              ? -KEYBOARD_RESIZE_STEP_PX
                              : event.key === "ArrowRight"
                                ? KEYBOARD_RESIZE_STEP_PX
                                : null;
                          if (delta === null) return;
                          event.preventDefault();
                          event.stopPropagation();
                          applyBuildChatWidth(
                            buildChatWidthRef.current + delta,
                            true,
                          );
                        }}
                        onReset={resetBuildChatWidth}
                      />
                    ) : canResizeNavAfter ? (
                      <ColumnResizeHandle
                        leftId={id}
                        rightId={nextId}
                        onMouseDown={beginNavResize}
                        onKeyDown={(event) => {
                          const delta =
                            event.key === "ArrowLeft"
                              ? -KEYBOARD_RESIZE_STEP_PX
                              : event.key === "ArrowRight"
                                ? KEYBOARD_RESIZE_STEP_PX
                                : null;
                          if (delta === null) return;
                          event.preventDefault();
                          event.stopPropagation();
                          applyNavWidth(
                            fullPageNavWidthRef.current + delta,
                            true,
                          );
                        }}
                        onReset={resetNavWidth}
                      />
                    ) : canResizeAfter ? (
                      <ColumnResizeHandle
                        leftId={id}
                        rightId={nextId}
                        onMouseDown={(event) =>
                          beginColumnResize(
                            id,
                            nextId,
                            expandedColumnIds,
                            event,
                          )
                        }
                        onKeyDown={(event) => {
                          const delta =
                            event.key === "ArrowLeft"
                              ? -KEYBOARD_RESIZE_STEP_PX
                              : event.key === "ArrowRight"
                                ? KEYBOARD_RESIZE_STEP_PX
                                : null;
                          if (delta === null) return;
                          event.preventDefault();
                          event.stopPropagation();
                          stepColumnResize(
                            id,
                            nextId,
                            expandedColumnIds,
                            delta,
                          );
                        }}
                        onReset={resetColumnWidths}
                      />
                    ) : undefined
                  }
                >
                  {(chrome) => renderColumn(id, chrome)}
                </WorkspaceColumn>
              );
            })}
            {previewMounted && (
              <div
                className={
                  previewHidden
                    ? "hidden"
                    : "absolute inset-0 z-40 flex min-h-0 min-w-0 animate-slide-in-right motion-reduce:animate-none lg:static lg:z-auto lg:flex-1"
                }
              >
                <AppWorkspace
                  variant="build"
                  appUrl={buildPreview?.target.url ?? null}
                  appUrlLive={appWorkspace}
                  appRevision={buildPreview?.target.revision ?? null}
                  appRepoUrl={buildPreview?.target.repoUrl ?? null}
                  buildLogOpen={!buildChatCollapsed}
                  onToggleBuildLog={() =>
                    setBuildChatCollapsed((value) => !value)
                  }
                  onOpenNav={
                    buildSplitWide ? undefined : () => setMobileContextOpen(true)
                  }
                />
              </div>
            )}
          </div>
      {drawerTab && <WorkspaceDrawer tab={drawerTab} onClose={closeOverlay} />}
      {(compactViewport || (appWorkspace && previewMounted && !buildSplitWide)) &&
        mobileContextOpen && (
        <CompactNavOverlay onClose={closeMobileContext}>
          {(dismiss) => (
            <ContextPanel
              onCollapse={dismiss}
              theme={theme}
              onSetTheme={setTheme}
              chatFocus={chatFocus}
              buildChatFollowsThread={appWorkspace}
            />
          )}
        </CompactNavOverlay>
      )}
    </div>
  );
}
