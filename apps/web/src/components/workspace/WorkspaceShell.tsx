"use client";

import { registerCustomAgentNames } from "@/lib/agentRegistry";
import { captureStaffModelParam, setStaffModelScope } from "@/lib/workspace/staffModelParam";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { tabAfterClose } from "./navigation/tabAfterClose";
import { planThreadBind } from "./navigation/threadBinding";
import { useWorkspaceNavigation } from "./navigation/useWorkspaceNavigation";
import {
  commitTabsAndLocation,
  notifyWorkspaceLocation,
  readWorkspaceLocation,
} from "./navigation/workspaceRoutes";
import { returnFromConnect } from "@/app/connectors/ConnectButton";
import { normalizeCounters } from "./counters";
import { CmdKPalette } from "./CmdKPalette";
import { KeybindingsLayer } from "./KeybindingsLayer";
import { TabActivityWatcher } from "./TabActivityWatcher";
import { RunCompletionWatcher } from "./RunCompletionWatcher";
import { notifyThreadsChanged } from "./useAgentThreads";
import { isThreadOnScreen, onThreadViewsChanged } from "./onScreenThreads";
import { ZaviCopilotProvider } from "@/lib/copilotkit/ZaviCopilotProvider";
import { ZaviCopilotBridge } from "@/lib/copilotkit/ZaviCopilotBridge";
import { LegacyWorkspaceLayout } from "./legacy/LegacyWorkspaceLayout";
import { WorkspaceLayout } from "./layout/WorkspaceLayout";
import { buildDeepLinkSeed } from "./deepLinkSeed";
import { SetupProvider } from "./setup/SetupProvider";
import { FullscreenSetup } from "./setup/FullscreenSetup";
import { buildThreadOnOpen } from "@/lib/workspace/buildEntry";
import { apiFetch } from "@/lib/api";
import { sameShallow } from "@/lib/workspace/stableState";
import { syncRealtimeAuth } from "@/lib/realtimeAuth";
import { createBrowserSupabase } from "@/lib/supabase";
import { reconcileBrowserTenant } from "@/lib/browser-tenant";
import { listenForTenantSwitches } from "@/lib/workspace/tenantSwitch";
import {
  capTabsForPersist,
  flushTabs,
  loadTabs,
  persistTabs,
} from "@/lib/workspace/tabsSession";
import {
  clampPaneWidthPct,
  normalizeWorkspacePrefs,
  writeUserPref,
} from "@/lib/workspace/userPrefs";
import type {
  InspectorContent,
  TabDescriptor,
  WorkspaceContextValue,
  WorkspaceBootstrapPayload,
  WorkspaceNextTilesPayload,
  WorkspaceViewMode,
} from "@/lib/workspace/types";

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

function enforceSingleAgentRule(
  tabs: TabDescriptor[],
  _keepSlug: string,
): { tabs: TabDescriptor[]; prunedIds: Set<string> } {
  return { tabs, prunedIds: new Set<string>() };
}

function resyncAgentTabTitles(tabs: TabDescriptor[]): TabDescriptor[] {
  const usedBySlug: Record<string, Set<string>> = {};
  for (const t of tabs) {
    if (t.kind !== "agent" || t.customTitle !== true) continue;
    const slug = (t.payload as { slug: string }).slug;
    if (!usedBySlug[slug]) usedBySlug[slug] = new Set();
    usedBySlug[slug].add(t.title);
  }
  return tabs.map((t) => {
    if (t.kind !== "agent" || t.customTitle === true) return t;
    const slug = (t.payload as { slug: string }).slug;
    if (!usedBySlug[slug]) usedBySlug[slug] = new Set();
    let candidate = slug;
    let n = 2;
    while (usedBySlug[slug].has(candidate)) {
      candidate = `${slug} (${n})`;
      n++;
    }
    usedBySlug[slug].add(candidate);
    return t.title === candidate ? t : { ...t, title: candidate };
  });
}

export function useWorkspaceOptional(): WorkspaceContextValue | null {
  return useContext(WorkspaceContext);
}

export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) {
    throw new Error("useWorkspace must be called inside <WorkspaceShell>");
  }
  return ctx;
}

type WorkspaceShellProps = {
  bootstrap: WorkspaceBootstrapPayload;
  userEmail?: string;
  tenantName?: string;
  initialNextTiles?: WorkspaceNextTilesPayload | null;
  currentUserId?: string;
  tenantId?: string;
  role?: "owner" | "admin" | "member" | "viewer" | null;
  initialAgentSlug?: string;
  initialTab?:
    | "settings"
    | "brain"
    | "members"
    | "autopilot"
    | "competitor"
    | "website"
    | "onboarding"
    | "analytics"
    | "channels"
    | "needs-you"
    | "messaging"
    | "meet"
    | "memory"
    | "calendar"
    | "artifacts"
    | "fundraising"
    | "supply-demand"
    | "engineer"
    | "agent-builder"
    | "dispute-detail"
    | "build";
  layout?: "zavi" | "legacy";
  initialBuildSessionId?: string | null;
  initialThreadId?: string | "new" | null;
  initialDisputeId?: string;
};

type StaticTabKind =
  | "settings"
  | "brain"
  | "members"
  | "autopilot"
  | "competitor"
  | "website"
  | "onboarding"
  | "analytics"
  | "channels"
  | "needs-you"
  | "messaging"
  | "meet"
  | "memory"
  | "calendar"
  | "artifacts"
  | "fundraising"
  | "supply-demand"
  | "engineer"
  | "agent-builder";

export const STATIC_TAB_TITLES: Partial<Record<StaticTabKind, string>> = {
  competitor: "Competitor Intel",
  website: "Your Website",
  channels: "Growth Channels",
  "needs-you": "Needs you",
  autopilot: "Your CGO",
  "supply-demand": "Supply & Demand",
  "agent-builder": "Agent Builder",
};

const RENAMED_STATIC_TITLES: Partial<Record<StaticTabKind, readonly string[]>> = {
  autopilot: ["Autopilot", "Growth Strategy"],
};

export function migrateStaticTabTitles(tabs: TabDescriptor[]): TabDescriptor[] {
  return tabs.map((tab) => {
    if (tab.customTitle) return tab;
    const retired = RENAMED_STATIC_TITLES[tab.kind as StaticTabKind];
    if (!retired?.includes(tab.title)) return tab;
    const current = STATIC_TAB_TITLES[tab.kind as StaticTabKind];
    return current ? { ...tab, title: current } : tab;
  });
}

function staticTabDescriptor(kind: StaticTabKind): TabDescriptor {
  return {
    id: `${kind}-default`,
    kind,
    title: STATIC_TAB_TITLES[kind] ?? kind[0].toUpperCase() + kind.slice(1),
    payload: { kind } as TabDescriptor["payload"],
    dirty: false,
    pinned: false,
  };
}

function migrateFeedTabs(tabs: TabDescriptor[]): TabDescriptor[] {
  const migrated = tabs.map((tab) => {
    if ((tab.kind as string) !== "feed" && tab.id !== "feed-default")
      return tab;
    return {
      ...tab,
      id: tab.id === "feed-default" ? "channels-default" : tab.id,
      kind: "channels" as const,
      title: tab.title === "Feed" ? "Growth Channels" : tab.title,
      payload: { kind: "channels" as const },
    };
  });
  const seen = new Set<string>();
  return migrated.filter((tab) => {
    if (tab.kind !== "channels") return true;
    const key = tab.id === "channels-default" ? "channels-default" : tab.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function findDisputeDetailTab(
  tabs: TabDescriptor[],
  disputeId: string,
): TabDescriptor | undefined {
  return tabs.find(
    (t) =>
      t.kind === "dispute-detail" &&
      (t.payload as { disputeId: string }).disputeId === disputeId,
  );
}

function disputeDetailDeepLinkDescriptor(disputeId: string): TabDescriptor {
  return {
    id: `dispute-detail-deeplink-${disputeId}`,
    kind: "dispute-detail",
    title: `Dispute ${disputeId.slice(0, 10)}…`,
    payload: { kind: "dispute-detail", disputeId, threadId: null },
    dirty: false,
    pinned: false,
  };
}

const BUILD_TAB_ID = "build-default";

function buildTabDescriptor(
  sessionId: string | null,
  threadId?: string | null,
): TabDescriptor {
  return {
    id: BUILD_TAB_ID,
    kind: "build",
    title: "Build",
    payload:
      threadId === undefined
        ? { kind: "build", sessionId }
        : { kind: "build", sessionId, threadId },
    dirty: false,
    pinned: false,
  };
}

function findBuildTab(tabs: TabDescriptor[]): TabDescriptor | undefined {
  return tabs.find((t) => t.kind === "build");
}

function buildTabSessionId(tab: TabDescriptor | undefined): string | null {
  if (!tab || tab.kind !== "build") return null;
  const id = (tab.payload as { sessionId?: string | null }).sessionId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function withBuildTab(
  tabs: TabDescriptor[],
  sessionId: string | null | undefined,
  threadId?: string | null,
): TabDescriptor[] {
  const existing = findBuildTab(tabs);
  if (!existing) return [...tabs, buildTabDescriptor(sessionId ?? null, threadId)];
  if (sessionId === undefined || buildTabSessionId(existing) === sessionId) {
    return tabs;
  }
  return tabs.map((t) =>
    t.id === existing.id
      ? { ...t, payload: buildTabDescriptor(sessionId, threadId).payload }
      : t,
  );
}

const DEFAULT_HOME_TAB: TabDescriptor = {
  id: "home-default",
  kind: "home",
  title: "Home",
  payload: { kind: "home" },
  dirty: false,
  pinned: true,
};

export function WorkspaceShell({
  bootstrap,
  userEmail,
  tenantName,
  initialNextTiles = null,
  currentUserId,
  tenantId,
  role = null,
  initialAgentSlug,
  initialTab,
  initialThreadId = null,
  initialDisputeId,
  initialBuildSessionId = null,
  layout = "zavi",
}: WorkspaceShellProps) {
  useEffect(() => syncRealtimeAuth(), []);
  useEffect(() => listenForTenantSwitches(), []);
  if (typeof window !== "undefined") {
    setStaffModelScope(currentUserId, tenantId);
    captureStaffModelParam(window.location.search);
  }

  useEffect(() => {
    void reconcileBrowserTenant(createBrowserSupabase());
  }, []);

  const seedTabs = (() => {
    const restored = migrateStaticTabTitles(
      migrateFeedTabs(
        bootstrap.tabs_session.tabs.filter(
          (tab) =>
            (tab.kind as string) !== "approvals" &&
            (tab.kind as string) !== "calendar",
        ),
      ),
    );
    const base =
      restored.length > 0
        ? restored.some((t) => t.kind === "home")
          ? restored
          : [DEFAULT_HOME_TAB, ...restored]
        : [DEFAULT_HOME_TAB];
    if (
      initialTab === "dispute-detail" &&
      initialDisputeId &&
      !initialAgentSlug
    ) {
      const existing = findDisputeDetailTab(base, initialDisputeId);
      return existing
        ? base
        : [...base, disputeDetailDeepLinkDescriptor(initialDisputeId)];
    }
    if (initialTab === "build" && !initialAgentSlug) {
      return withBuildTab(base, initialBuildSessionId ?? undefined);
    }
    if (
      initialTab &&
      initialTab !== "dispute-detail" &&
      initialTab !== "build" &&
      !initialAgentSlug
    ) {
      const existing = base.find((t) => t.kind === initialTab);
      return existing ? base : [...base, staticTabDescriptor(initialTab)];
    }
    return buildDeepLinkSeed(base, initialAgentSlug, initialThreadId);
  })();
  const resyncedSeedTabs = resyncAgentTabTitles(seedTabs);
  const initialKeepSlug = (() => {
    if (initialAgentSlug) return initialAgentSlug;
    const persistedActiveId = bootstrap.tabs_session.active_tab_id;
    if (persistedActiveId) {
      const t = resyncedSeedTabs.find((x) => x.id === persistedActiveId);
      if (t && t.kind === "agent") {
        return (t.payload as { slug: string }).slug;
      }
    }
    const firstAgent = resyncedSeedTabs.find((t) => t.kind === "agent");
    return firstAgent ? (firstAgent.payload as { slug: string }).slug : null;
  })();
  const initialTabs = initialKeepSlug
    ? enforceSingleAgentRule(resyncedSeedTabs, initialKeepSlug).tabs
    : resyncedSeedTabs;
  const [storedTabs, setTabs] = useState<TabDescriptor[]>(initialTabs);
  const { tabs, activeTabId, activateTab, setActiveTabId } =
    useWorkspaceNavigation(storedTabs);

  const oauthLandingTakenRef = useRef(false);
  useEffect(() => {
    if (oauthLandingTakenRef.current) return;
    oauthLandingTakenRef.current = true;
    returnFromConnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const markUrlWritten = notifyWorkspaceLocation;
  const [inspectorByTab, setInspectorByTab] = useState<
    Record<string, InspectorContent>
  >({});
  const [paletteOpen, setPaletteOpen] = useState(false);

  const [composerSeeds, setComposerSeeds] = useState<
    Record<
      string,
      {
        text: string;
        nonce: number;
        autoSend?: boolean;
        placeholderHint?: string;
      }
    >
  >({});

  const [builderRetryNonce, setBuilderRetryNonce] = useState(0);
  const builderRetrySeqRef = useRef(0);

  const [unreadTabIds, setUnreadTabIds] = useState<Record<string, true>>({});

  const markTabUnread = useCallback((tabId: string) => {
    setUnreadTabIds((prev) =>
      prev[tabId] ? prev : { ...prev, [tabId]: true },
    );
    setTabs((prev) =>
      prev.map((t) =>
        t.id === tabId && !t.unread ? { ...t, unread: true } : t,
      ),
    );
  }, []);

  const clearTabUnread = useCallback((tabId: string) => {
    setUnreadTabIds((prev) => {
      if (!prev[tabId]) return prev;
      const next = { ...prev };
      delete next[tabId];
      return next;
    });
    setTabs((prev) =>
      prev.map((t) =>
        t.id === tabId && t.unread ? { ...t, unread: false } : t,
      ),
    );
  }, []);

  const [seenThisSession, setSeenThisSession] = useState<Set<string>>(
    () => new Set(),
  );
  const markAgentSeen = useCallback(
    (slug: string) => {
      if (seenThisSession.has(slug)) return;
      setSeenThisSession((prev) => new Set(prev).add(slug));
      void apiFetch("/api/workspace/agent-seen", {
        method: "POST",
        body: JSON.stringify({ slug }),
      }).catch(() => {});
    },
    [seenThisSession],
  );

  const [liveCounters, setLiveCounters] = useState(bootstrap.status_counters);
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        const res = await apiFetch("/api/workspace/status-counters");
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as typeof bootstrap.status_counters;
        if (!cancelled) {
          setLiveCounters((prev) => (sameShallow(prev, data) ? prev : data));
        }
      } catch {
      }
    };
    void tick();
    const id = window.setInterval(tick, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const seededPrefs = normalizeWorkspacePrefs(bootstrap.prefs);
  const [viewMode, setViewModeState] = useState<WorkspaceViewMode>(
    seededPrefs.viewMode,
  );
  const [paneWidthPct, setPaneWidthPctState] = useState<number>(
    seededPrefs.paneWidthPct,
  );

  const setViewMode = useCallback(
    (mode: WorkspaceViewMode) => {
      if (mode === viewMode) return;
      const prev = viewMode;
      setViewModeState(mode);
      void writeUserPref("viewMode", mode).catch(() => {
        setViewModeState(prev);
      });
    },
    [viewMode],
  );

  const setPaneWidthPct = useCallback(
    (pct: number) => {
      const next = clampPaneWidthPct(pct);
      if (next === paneWidthPct) return;
      const prev = paneWidthPct;
      setPaneWidthPctState(next);
      void writeUserPref("paneWidthPct", next).catch(() => {
        setPaneWidthPctState(prev);
      });
    },
    [paneWidthPct],
  );

  const [liveTreeAgents, setLiveTreeAgents] = useState(bootstrap.tree.agents);
  registerCustomAgentNames(liveTreeAgents);

  const refreshTree = useCallback(async () => {
    try {
      const res = await apiFetch("/api/workspace/tree");
      if (!res.ok) return;
      const data = (await res.json()) as {
        agents?: typeof bootstrap.tree.agents;
      };
      if (Array.isArray(data.agents)) setLiveTreeAgents(data.agents);
    } catch {
    }
  }, []);

  const seenThreadIdsRef = useRef<Set<string>>(new Set());
  const markThreadSeen = useCallback(
    (threadId: string, opts?: { again?: boolean }) => {
      if (opts?.again) seenThreadIdsRef.current.delete(threadId);
      if (seenThreadIdsRef.current.has(threadId)) return;
      seenThreadIdsRef.current.add(threadId);
      void apiFetch("/api/workspace/thread-seen", {
        method: "POST",
        body: JSON.stringify({ thread_id: threadId }),
      })
        .then((res) => {
          if (res.ok) {
            notifyThreadsChanged();
            return refreshTree();
          }
          seenThreadIdsRef.current.delete(threadId);
        })
        .catch(() => {
          seenThreadIdsRef.current.delete(threadId);
        });
    },
    [refreshTree],
  );
  const liveActiveRuns = liveCounters.active_runs;
  const RUNNING_STALE_AFTER_MS = 2 * 60 * 60 * 1000;
  const treeHasRunning = liveTreeAgents.some((a) => {
    if (a.latest_run_status !== "running" && a.latest_run_status !== "queued") {
      return false;
    }
    const startedAtMs = a.latest_run_started_at
      ? Date.parse(a.latest_run_started_at)
      : NaN;
    return (
      Number.isNaN(startedAtMs) ||
      Date.now() - startedAtMs < RUNNING_STALE_AFTER_MS
    );
  });
  const shouldPollTree = liveActiveRuns > 0 || treeHasRunning;
  useEffect(() => {
    if (!shouldPollTree) return;
    const fetchTree = async () => {
      if (typeof document !== "undefined" && document.hidden) return;
      await refreshTree();
    };
    void fetchTree();
    const id = window.setInterval(fetchTree, 10_000);
    return () => {
      window.clearInterval(id);
    };
  }, [shouldPollTree, refreshTree]);

  useEffect(() => {
    const onRefresh = () => void refreshTree();
    window.addEventListener("zavi:workspace-tree-refresh", onRefresh);
    return () => window.removeEventListener("zavi:workspace-tree-refresh", onRefresh);
  }, [refreshTree]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const fresh = await loadTabs();
      if (cancelled || fresh.tabs.length === 0) return;
      const nextTabs = resyncAgentTabTitles(
        migrateStaticTabTitles(
          migrateFeedTabs(
            fresh.tabs.filter(
              (tab) =>
                (tab.kind as string) !== "approvals" &&
                (tab.kind as string) !== "calendar",
            ),
          ),
        ),
      );
      setTabs((prev) => {
        const currentIds = new Set(prev.map((tab) => tab.id));
        return [...prev, ...nextTabs.filter((tab) => !currentIds.has(tab.id))];
      });
      const restoredUnread: Record<string, true> = {};
      for (const t of nextTabs) if (t.unread) restoredUnread[t.id] = true;
      if (Object.keys(restoredUnread).length > 0) {
        setUnreadTabIds((prev) => ({ ...restoredUnread, ...prev }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    persistTabs({
      tabs: capTabsForPersist(tabs, activeTabId),
      active_tab_id: activeTabId,
    });
  }, [tabs, activeTabId]);

  useEffect(() => {
    const onBeforeUnload = () => flushTabs();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      setInspectorByTab({});
    };
  }, []);

  const openTab = useCallback(
    (
      descriptor: Omit<TabDescriptor, "id">,
      opts?: { push?: boolean },
    ): string => {
      const existing = tabs.find((t) => {
        if (t.kind !== descriptor.kind) return false;
        if (t.kind === "agent") return false;
        if (t.kind === "run" && descriptor.kind === "run") {
          return (
            (t.payload as { runId: string }).runId ===
            (descriptor.payload as { runId: string }).runId
          );
        }
        if (
          t.kind === "dispute-detail" &&
          descriptor.kind === "dispute-detail"
        ) {
          return (
            (t.payload as { disputeId: string }).disputeId ===
            (descriptor.payload as { disputeId: string }).disputeId
          );
        }
        return (
          t.kind === descriptor.kind &&
          t.kind !== "run" &&
          t.kind !== "dispute-detail"
        );
      });
      if (existing) {
        setTabs((prev) =>
          prev.map((t) => {
            if (t.id !== existing.id) return t;
            if (
              t.kind === "dispute-detail" &&
              descriptor.kind === "dispute-detail"
            ) {
              const cur = t.payload as {
                kind: "dispute-detail";
                disputeId: string;
                threadId?: string | null;
              };
              const next = descriptor.payload as {
                kind: "dispute-detail";
                disputeId: string;
                threadId?: string | null;
              };
              const boundThreadId =
                typeof cur.threadId === "string" && cur.threadId.length > 0
                  ? cur.threadId
                  : next.threadId;
              return { ...t, payload: { ...next, threadId: boundThreadId } };
            }
            if (
              t.payload.kind === "autopilot" &&
              descriptor.payload.kind === "autopilot" &&
              !("threadId" in descriptor.payload)
            ) {
              return { ...t, payload: { ...descriptor.payload, threadId: t.payload.threadId } };
            }
            return { ...t, payload: descriptor.payload };
          }),
        );
        if (existing.kind === "dispute-detail") setActiveTabId(existing.id);
        else
          activateTab(
            { ...existing, payload: descriptor.payload } as TabDescriptor,
            { push: opts?.push },
          );
        return existing.id;
      }
      let baseTabs = tabs;
      let prunedIds: Set<string> = new Set();
      if (descriptor.kind === "agent") {
        const newSlug = (descriptor.payload as { slug: string }).slug;
        const res = enforceSingleAgentRule(tabs, newSlug);
        baseTabs = res.tabs;
        prunedIds = res.prunedIds;
      }
      const id = crypto.randomUUID();
      const next: TabDescriptor = { id, ...descriptor };
      setTabs(
        prunedIds.size > 0 ? [...baseTabs, next] : (prev) => [...prev, next],
      );
      if (prunedIds.size > 0) {
        setInspectorByTab((prev) => {
          let mutated = false;
          const out = { ...prev };
          for (const pid of prunedIds) {
            if (pid in out) {
              delete out[pid];
              mutated = true;
            }
          }
          return mutated ? out : prev;
        });
      }
      activateTab(next, { push: opts?.push });
      return id;
    },
    [tabs, activateTab, setActiveTabId],
  );

  const openAgentTab = useCallback(
    async (
      slug: string,
      opts?: { newThread?: boolean; threadId?: string; push?: boolean },
    ): Promise<string> => {
      const threadId = opts?.threadId || null;
      const existing = tabs.find(
        (tab) =>
          tab.payload.kind === "agent" &&
          tab.payload.slug === slug &&
          tab.payload.threadId === threadId,
      );
      if (existing && (!opts?.newThread || threadId)) {
        activateTab(existing, { push: opts?.push });
        return existing.id;
      }
      const next: TabDescriptor = {
        id: crypto.randomUUID(),
        kind: "agent",
        title: slug,
        payload: { kind: "agent", slug, threadId },
        dirty: false,
        pinned: false,
      };
      commitTabsAndLocation(
        () => setTabs((prev) => resyncAgentTabTitles([...prev, next])),
        () => activateTab(next, { push: opts?.push }),
      );
      return next.id;
    },
    [tabs, activateTab],
  );

  useEffect(() => {
    const active = tabs.find((t) => t.id === activeTabId);
    if (active?.kind === "agent") {
      const payload = active.payload as {
        slug?: string;
        threadId?: string | null;
      };
      if (payload.slug) markAgentSeen(payload.slug);
      if (payload.threadId) {
        markThreadSeen(payload.threadId);
      }
    }
  }, [tabs, activeTabId, markAgentSeen, markThreadSeen]);

  const setTabThreadId = useCallback(
    (
      tabId: string,
      threadId: string | null,
      opts?: { activate?: boolean; push?: boolean },
    ) => {
      const plan = planThreadBind(
        tabs,
        tabId,
        threadId,
        readWorkspaceLocation(),
        opts?.activate === true,
      );
      if (!plan) return;
      const { next, activate: shouldActivate } = plan;
      commitTabsAndLocation(
        () =>
          setTabs((prev) =>
            prev.some((candidate) => candidate.id === tabId)
              ? prev.map((candidate) =>
                  candidate.id === tabId ? next : candidate,
                )
              : [...prev, next],
          ),
        shouldActivate
          ? () => activateTab(next, { push: opts?.push })
          : undefined,
      );
    },
    [tabs, activateTab],
  );

  const openBuildTab = useCallback(
    (
      sessionId?: string | null,
      opts?: { activate?: boolean; push?: boolean },
    ): string => {
      const current = findBuildTab(tabs);
      const nextSessionId =
        sessionId === undefined ? buildTabSessionId(current) : sessionId;
      const keptThread = buildThreadOnOpen(
        current?.payload.kind === "build" ? buildTabSessionId(current) : undefined,
        nextSessionId,
        current?.payload.kind === "build" ? current.payload.threadId : undefined,
      );
      const next = buildTabDescriptor(nextSessionId, keptThread);
      const shouldActivate = opts?.activate !== false;
      commitTabsAndLocation(
        () =>
          setTabs((prev) =>
            withBuildTab(
              prev,
              next.payload.kind === "build" ? next.payload.sessionId : null,
              keptThread,
            ),
          ),
        shouldActivate
          ? () => activateTab(next, { push: opts?.push })
          : undefined,
      );
      return next.id;
    },
    [tabs, activateTab],
  );
  const buildSessionId = buildTabSessionId(findBuildTab(tabs));

  const setTabTitle = useCallback((tabId: string, title: string) => {
    setTabs((prev) =>
      prev.map((t) =>
        t.id === tabId && t.title !== title ? { ...t, title } : t,
      ),
    );
  }, []);

  const renameTab = useCallback((tabId: string, title: string) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    setTabs((prev) =>
      prev.map((t) =>
        t.id === tabId
          ? t.title === trimmed && t.customTitle === true
            ? t
            : { ...t, title: trimmed, customTitle: true }
          : t,
      ),
    );
  }, []);

  const reorderTabs = useCallback((activeId: string, overId: string) => {
    if (activeId === overId) return;
    setTabs((prev) => {
      const from = prev.findIndex((t) => t.id === activeId);
      const to = prev.findIndex((t) => t.id === overId);
      if (from < 0 || to < 0) return prev;
      const next = prev.slice();
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }, []);

  const closeTab = useCallback(
    (id: string, opts?: { toHome?: boolean }) => {
      const tab = tabs.find((candidate) => candidate.id === id);
      if (!tab || tab.pinned) return;
      if (activeTabId === id) {
        const fallback = tabAfterClose(tabs, tab, opts?.toHome);
        if (fallback) activateTab(fallback);
      }
      setTabs((prev) => prev.filter((candidate) => candidate.id !== id));
      setInspectorByTab((prev) => {
        if (!(id in prev)) return prev;
        const { [id]: _, ...rest } = prev;
        return rest;
      });
      setUnreadTabIds((prev) => {
        if (!prev[id]) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
    },
    [tabs, activeTabId, activateTab],
  );

  const setTabDirty = useCallback((id: string, dirty: boolean) => {
    setTabs((prev) => {
      const current = prev.find((t) => t.id === id);
      if (!current || current.dirty === dirty) return prev;
      return prev.map((t) => (t.id === id ? { ...t, dirty } : t));
    });
  }, []);

  const setInspectorForTab = useCallback(
    (tabId: string, content: InspectorContent) => {
      setInspectorByTab((prev) => ({ ...prev, [tabId]: content }));
    },
    [],
  );

  const consumeComposerSeed = useCallback((tabId: string) => {
    setComposerSeeds((prev) => {
      if (!(tabId in prev)) return prev;
      const { [tabId]: _drop, ...rest } = prev;
      return rest;
    });
  }, []);

  const seedComposer = useCallback(
    (opts: {
      agentSlug: string;
      text: string;
      tabId?: string;
      thread?: "current" | "new";
      autoSend?: boolean;
      placeholderHint?: string;
      origin?: "edit";
      editMessageId?: string;
    }) => {
      const {
        agentSlug,
        text,
        thread = "current",
        autoSend,
        placeholderHint,
        origin,
        editMessageId,
      } = opts;
      const stash = (id: string) => {
        setActiveTabId(id);
        setComposerSeeds((prev) => ({
          ...prev,
          [id]: {
            text,
            nonce: (prev[id]?.nonce ?? 0) + 1,
            autoSend,
            placeholderHint,
            origin,
            editMessageId,
          },
        }));
      };
      let tabId = opts.tabId;
      if (!tabId && thread !== "new") {
        const active = tabs.find((t) => t.id === activeTabId);
        if (
          active?.kind === "agent" &&
          (active.payload as { slug: string }).slug === agentSlug
        ) {
          tabId = active.id;
        } else {
          const matching = tabs.filter(
            (t) =>
              t.kind === "agent" &&
              (t.payload as { slug: string }).slug === agentSlug,
          );
          tabId = matching[matching.length - 1]?.id;
        }
      }
      if (tabId) stash(tabId);
      else
        void openAgentTab(agentSlug, { newThread: thread === "new" }).then(
          stash,
        );
    },
    [tabs, activeTabId, openAgentTab, setActiveTabId],
  );

  const requestBuilderRetry = useCallback(() => {
    builderRetrySeqRef.current += 1;
    setBuilderRetryNonce(builderRetrySeqRef.current);
  }, []);
  const ackBuilderRetry = useCallback((nonce: number) => {
    setBuilderRetryNonce((cur) => (cur === nonce ? 0 : cur));
  }, []);

  const ctxValue = useMemo<WorkspaceContextValue>(
    () => ({
      tabs,
      activeTabId,
      openTab,
      openAgentTab,
      closeTab,
      setActiveTab: setActiveTabId,
      setTabDirty,
      setTabThreadId,
      openBuildTab,
      buildSessionId,
      setTabTitle,
      renameTab,
      reorderTabs,
      inspectorByTab,
      setInspectorForTab,
      paletteOpen,
      setPaletteOpen,
      seedComposer,
      composerSeeds,
      consumeComposerSeed,
      builderRetryNonce,
      requestBuilderRetry,
      ackBuilderRetry,
      markUrlWritten,
      unreadTabIds,
      markTabUnread,
      clearTabUnread,
      treeAgents: liveTreeAgents,
      userEmail,
      tenantName,
      tenantId,
      initialNextTiles,
      currentUserId,
      role,
      supplyDemandEligible: bootstrap.supply_demand_eligible === true,
      supplyDemandReachable:
        bootstrap.supply_demand_reachable ?? bootstrap.supply_demand_eligible === true,
      creditsRemaining: liveCounters.credits_remaining,
      creditsAllowance: liveCounters.included_allowance,
      creditsTotal: liveCounters.credits_total ?? null,
      creditsEnforced: liveCounters.credits_enforced,
      approvalsPending: liveCounters.approvals_pending,
      viewMode,
      setViewMode,
      paneWidthPct,
      setPaneWidthPct,
      layout,
      seenThisSession,
      markAgentSeen,
      markThreadSeen,
      refreshTree,
    }),
    [
      tabs,
      activeTabId,
      openTab,
      openAgentTab,
      closeTab,
      setActiveTabId,
      setTabDirty,
      setTabThreadId,
      openBuildTab,
      buildSessionId,
      setTabTitle,
      renameTab,
      reorderTabs,
      inspectorByTab,
      setInspectorForTab,
      paletteOpen,
      seedComposer,
      composerSeeds,
      consumeComposerSeed,
      builderRetryNonce,
      requestBuilderRetry,
      ackBuilderRetry,
      markUrlWritten,
      unreadTabIds,
      markTabUnread,
      clearTabUnread,
      liveTreeAgents,
      userEmail,
      tenantName,
      tenantId,
      initialNextTiles,
      currentUserId,
      role,
      bootstrap.supply_demand_eligible,
      bootstrap.supply_demand_reachable,
      liveCounters,
      viewMode,
      setViewMode,
      paneWidthPct,
      setPaneWidthPct,
      layout,
      seenThisSession,
      markAgentSeen,
      markThreadSeen,
      refreshTree,
    ],
  );

  const clearSeenUnread = useCallback(() => {
    if (unreadTabIds[activeTabId]) clearTabUnread(activeTabId);
    for (const t of tabs) {
      if (t.kind !== "agent" || !unreadTabIds[t.id]) continue;
      const tid = (t.payload as { threadId?: unknown }).threadId;
      if (typeof tid === "string" && isThreadOnScreen(tid)) clearTabUnread(t.id);
    }
  }, [activeTabId, unreadTabIds, clearTabUnread, tabs]);
  useEffect(() => {
    clearSeenUnread();
    return onThreadViewsChanged(clearSeenUnread);
  }, [clearSeenUnread]);

  const copilotActive = tabs.find((t) => t.id === activeTabId);
  const copilotActivePayload = (copilotActive?.payload ?? {}) as {
    slug?: string;
    threadId?: string | null;
  };
  const copilotActiveAgent =
    copilotActive?.kind === "agent"
      ? (copilotActivePayload.slug ?? null)
      : null;
  const copilotActiveThread =
    copilotActive?.kind === "agent" &&
    typeof copilotActivePayload.threadId === "string"
      ? copilotActivePayload.threadId
      : null;

  return (
    <WorkspaceContext.Provider value={ctxValue}>
      <SetupProvider>
        <FullscreenSetup />
        {}
        <ZaviCopilotProvider
          agentSlug={copilotActiveAgent}
          threadId={copilotActiveThread}
        >
          <ZaviCopilotBridge />
          <KeybindingsLayer />
          <CmdKPalette agents={liveTreeAgents} />
          <RunCompletionWatcher />
          {}
          {tabs.map((t) => {
            if (t.kind !== "agent") return null;
            const p = t.payload as { threadId?: string | null };
            if (typeof p.threadId !== "string") return null;
            return (
              <TabActivityWatcher key={t.id} tabId={t.id} threadId={p.threadId} />
            );
          })}
          {layout === "legacy" ? <LegacyWorkspaceLayout /> : <WorkspaceLayout />}
        </ZaviCopilotProvider>
      </SetupProvider>
    </WorkspaceContext.Provider>
  );
}
