"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { CgoNavItem, CgoRailItem } from "./CgoNavItem";
import {
  customAgentRows,
  visibleAgentPages,
  type AgentPage,
} from "./agentPages";

export { customAgentRows, visibleAgentPages };
import {
  Blocks,
  Bot,
  MessageSquare,
  ChevronUp,
  CircleAlert,
  Columns3,
  BarChart3,
  Bell,
  CircleUserRound,
  HelpCircle,
  Inbox,
  Lock,
  LogOut,
  PlayCircle,
  GraduationCap,
  MessagesSquare,
  PanelLeftClose,
  Plus,
  Settings,
  SquarePen,
  Users,
} from "lucide-react";
import { useWorkspace } from "../WorkspaceShell";
import {
  planBadgeLabel,
  type LockTier,
} from "@/lib/workspace/planUpgrade";
import type { TabDescriptor } from "@/lib/workspace/types";
import {
  openBillingSettings,
  type BillingTarget,
} from "@/lib/workspace/openBilling";
import { upgradeHash } from "@/lib/workspace/pendingPlan";
import { apiFetch } from "@/lib/api";
import { agentDisplayName } from "@/lib/agentRegistry";
import { needsYouNavCount, useNeedsYouSnapshot } from "@/lib/workspace/needsYou";
import { NotificationsMenu } from "./NotificationsMenu";
import {
  creditBannerState,
  creditMeterModel,
  creditResetLine,
  STATUS_LOW_CREDIT_THRESHOLD,
} from "@/lib/workspace/runEstimate";
import { WorkspaceSwitcher } from "../WorkspaceSwitcher";
import { notifyThreadsChanged, useWorkspaceThreads } from "../useAgentThreads";
import { confirmAction } from "@/components/ui/ConfirmDialog";
import { HistoryRowMenu } from "./HistoryRowMenu";
import {
  activeChatBinding,
  agentThreadOpenStep,
  payloadOwnsThread,
} from "../navigation/threadBinding";
import {
  mergeHistory,
  siteBadge,
  type HistoryItem,
  type BuildSessionSite,
  type BuildSessionState,
  type HistoryStatus,
} from "@/lib/workspace/buildHistory";
import { useHistorySeen } from "./useChannelNotices";
import { historyRowBindsToBuild } from "./historyOpen";
import {
  readBuildSessions,
  refreshBuildSessions,
  useBuildSessions,
} from "@/lib/workspace/useBuildSessions";
import { pickBuildEntry } from "@/lib/workspace/buildEntry";
import { useSiteListFirst } from "@/lib/workspace/buildFraming";
import { prefetchChatThread } from "@/lib/workspace/useChatThread";
import {
  cx,
  HoverScrollTitle,
  FOCUS_RING,
  IconButton,
  useOpenStatic,
  type StaticKind,
} from "./shared";
import type { ColumnChrome } from "./columnChrome";
import type { Theme } from "./WorkspaceLayout";
import { createBrowserSupabase } from "@/lib/supabase";
import { isMember } from "@/lib/members";
import { ArtifactsIcon } from "@/components/icons/ArtifactsIcon";
import { WebsiteIcon } from "@/components/icons/WebsiteIcon";
import { AppearanceMenu } from "./AppearanceMenu";
import { HowToVideoCard, HowToVideoDialog } from "./HowToVideo";
import { trackEvent } from "@/lib/analytics/events";
import { FeedbackDialog } from "./FeedbackDialog";
import { useMyFeedback } from "@/lib/workspace/useMyFeedback";
import { PendingPlanNotice } from "../PendingPlanNotice";
import { Switch } from "@/components/ui/Switch";
import { NextChevron } from "@/components/ui/NextChevron";

const ZAVI = "operator";

const HOVER_PREFETCH_DELAY_MS = 120;

const ACTIVE_NAV =
  "bg-ink/10 text-ink before:absolute before:-left-2 before:top-1/2 before:h-5 before:w-1 before:-translate-y-1/2 before:rounded-r-full before:bg-ink";

export function NavItem({
  label,
  icon,
  active,
  badge,
  onClick,
  className,
  newTabHref,
}: {
  label: string;
  icon: ReactNode;
  active?: boolean;
  badge?: ReactNode;
  onClick: () => void;
  newTabHref?: string;
  className?: string;
}) {
  const cls = cx(
    "relative flex w-full items-center gap-2.5 rounded-cta px-2.5 py-[7px] text-left text-[14px] font-medium transition-colors duration-150 motion-reduce:transition-none",
    active ? ACTIVE_NAV : "text-inkSoft hover:bg-ink/[0.04] hover:text-ink compact:text-ink",
    FOCUS_RING,
    className,
  );
  if (newTabHref) {
    return (
      <a href={newTabHref} target="_blank" rel="noopener noreferrer" onClick={onClick} aria-current={active ? "page" : undefined} className={cls}>
        <span className="text-inkSoft compact:text-ink">{icon}</span>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="sr-only">(opens in a new tab)</span>
        {badge}
      </a>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cx(
        "relative flex w-full items-center gap-2.5 rounded-cta px-2.5 py-[7px] text-left text-[14px] font-medium transition-colors duration-150 motion-reduce:transition-none",
        active
          ? ACTIVE_NAV
          : "text-inkSoft hover:bg-ink/[0.04] hover:text-ink compact:text-ink",
        FOCUS_RING,
        className,
      )}
    >
      <span className="text-inkSoft compact:text-ink">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {badge}
    </button>
  );
}

function NeedsYouCount({ snap, tenantId }: { snap: ReturnType<typeof useNeedsYouSnapshot>; tenantId?: string | null }) {
  const n = snap.tenantId === tenantId ? needsYouNavCount(snap) : 0;
  if (n <= 0) return null;
  return (
    <span
      data-needs-you-count=""
      aria-label={`${n} waiting on you`}
      className="shrink-0 rounded-full bg-[#b7791f] px-1.5 py-px text-[11px] font-semibold leading-4 text-white"
    >
      {n > 99 ? "99+" : n}
    </span>
  );
}

function HistoryRow({
  item,
  active,
  onOpen,
  onRename,
  onDelete,
}: {
  item: HistoryItem;
  active: boolean;
  onOpen: () => void;
  onRename?: (title: string) => void;
  onDelete?: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (renaming) inputRef.current?.select();
  }, [renaming]);
  const prefetch =
    item.kind === "chat" && !active
      ? () => prefetchChatThread(item.agentSlug, item.id)
      : undefined;
  const hoverTimerRef = useRef<number | null>(null);
  const cancelHoverPrefetch = () => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  };
  useEffect(() => cancelHoverPrefetch, []);
  const isBuild = item.kind === "build";
  const reply = item.kind === "chat" && !active ? (item.reply ?? null) : null;
  const rowStatus = reply && item.status === "completed" ? null : item.status;
  const status = active && rowStatus !== "running" ? null : rowStatus;
  const buildState = item.kind === "build" ? item.state : null;
  const site = item.kind === "build" ? item.site : null;
  const statusLabel = status ? historyStatusText(status, buildState, site).toLowerCase() : null;
  const kindLabel = isBuild ? "Build" : "Chat";
  const replyWho = reply && item.kind === "chat" ? agentDisplayName(item.agentSlug) : null;
  const replyLabel = reply
    ? reply.kind === "question"
      ? `${replyWho} needs your answer: ${reply.text}`
      : `${replyWho}: ${reply.text}`
    : null;
  const row = (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      aria-label={`${kindLabel}${statusLabel ? ` (${statusLabel})` : ""}${reply ? " (unread)" : ""}: ${item.title}${replyLabel ? `. ${replyLabel}` : ""}`}
      title={replyLabel ? `${item.title}\n${replyLabel}` : item.title}
      onClick={onOpen}
      onPointerEnter={
        prefetch
          ? () => {
              cancelHoverPrefetch();
              hoverTimerRef.current = window.setTimeout(
                prefetch,
                HOVER_PREFETCH_DELAY_MS,
              );
            }
          : undefined
      }
      onPointerLeave={cancelHoverPrefetch}
      onPointerDown={prefetch}
      onFocus={prefetch}
      className={cx(
        "group relative flex items-center gap-2 rounded-cta px-2.5 py-[7px] text-left text-[14px] leading-[19px] transition-colors group-focus-within/row:pr-8 group-hover/row:pr-8 motion-reduce:transition-none",
        active
          ? "bg-ink/10 font-medium text-ink"
          : reply
            ? "font-semibold text-ink hover:bg-ink/[0.04]"
            : "text-inkSoft hover:bg-ink/[0.04] hover:text-ink compact:text-ink",
        FOCUS_RING,
      )}
    >
      {active && (
        <span
          aria-hidden
          data-recent-accent=""
          className="absolute left-0 top-1/2 h-4 w-[2px] -translate-y-1/2 rounded-full bg-ink"
        />
      )}
      <HoverScrollTitle text={item.title} />
      {status && <HistoryStatusBadge status={status} buildState={buildState} site={site} />}
      {reply && (
        <span
          aria-hidden
          data-unread-reply={reply.kind}
          className={cx(
            "ml-auto h-2 w-2 shrink-0 rounded-full group-focus-within/row:hidden group-hover/row:hidden",
            reply.kind === "question" ? "bg-[#b7791f]" : "bg-ink",
          )}
        />
      )}
    </button>
  );
  if (!onDelete || !onRename) return row;
  const commitRename = () => {
    setRenaming(false);
    const next = draft.trim();
    if (next && next !== item.title) onRename(next);
  };
  if (renaming) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commitRename}
        onKeyDown={(e) => {
          if (e.key === "Enter") commitRename();
          if (e.key === "Escape") setRenaming(false);
        }}
        maxLength={120}
        aria-label="Chat title"
        className={cx(
          "rounded-[10px] bg-bone px-2.5 py-[7px] text-[14px] leading-[19px] text-ink outline-none",
          FOCUS_RING,
        )}
      />
    );
  }
  return (
    <div className="group/row relative flex flex-col">
      {row}
      <HistoryRowMenu
        onRename={() => {
          setDraft(item.title);
          setRenaming(true);
        }}
        onDelete={onDelete}
      />
    </div>
  );
}

export function historyStatusText(
  status: HistoryStatus,
  buildState: BuildSessionState | null = null,
  site: BuildSessionSite | null = null,
): string {
  if (status === "running") return buildState === "publishing" ? "Publishing" : "Working";
  if (status === "completed" && buildState && buildState !== "replaced") {
    const badge = siteBadge(site, buildState);
    if (badge) return badge.label;
  }
  if (status === "completed") return buildState === "replaced" ? "Replaced" : buildState ? "Ready" : "New";
  if (buildState === "publish_failed") return "Not live";
  return buildState === "failed" ? "Stopped" : "Failed";
}

export function HistoryStatusBadge({
  status,
  buildState = null,
  site = null,
}: {
  status: HistoryStatus;
  buildState?: BuildSessionState | null;
  site?: BuildSessionSite | null;
}) {
  const siteTone = status === "completed" && buildState && buildState !== "replaced" ? siteBadge(site, buildState)?.tone : undefined;
  const tone =
    status === "running"
      ? "bg-marigold/15 text-ink"
      : siteTone === "danger"
        ? "bg-coral/15 text-coral"
        : siteTone && siteTone !== "success"
          ? "bg-ink/[0.06] text-inkMuted"
          : status === "completed"
            ? "bg-emerald-500/15 text-emerald-700"
            : "bg-coral/15 text-coral";
  return (
    <span
      data-history-status={status}
      className={cx(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-px text-[11px] font-medium leading-4",
        tone,
      )}
      aria-hidden
    >
      {status === "running" && (
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-marigold opacity-60 motion-reduce:animate-none" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-marigold" />
        </span>
      )}
      {historyStatusText(status, buildState, site)}
    </span>
  );
}

function ChatSection({
  buildChatFollowsThread,
}: {
  buildChatFollowsThread: boolean;
}) {
  const {
    tabs,
    activeTabId,
    openAgentTab,
    setActiveTab,
    setTabThreadId,
    closeTab,
    openBuildTab,
    buildSessionId,
    currentUserId,
    tenantName,
  } = useWorkspace();
  const [open, setOpen] = useState(true);

  const active = tabs.find((t) => t.id === activeTabId);
  const { slug: activeSlug, threadId: activeThreadId } =
    active?.kind === "build"
      ? { slug: null, threadId: null }
      : activeChatBinding(active, ZAVI);
  const { threads, loaded: threadsLoaded } = useWorkspaceThreads();
  const { sessions, loaded: sessionsLoaded, flags: siteFlags, uiFlags } = useBuildSessions();
  const { seen, markSeen } = useHistorySeen(currentUserId, tenantName);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  const [deletedIds, setDeletedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [renamed, setRenamed] = useState<Readonly<Record<string, string>>>({});
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  useEffect(() => {
    const caughtUp = threads.filter((t) => renamed[t.id] !== undefined && t.title === renamed[t.id]);
    if (caughtUp.length === 0) return;
    setRenamed((prev) => {
      const next = { ...prev };
      for (const t of caughtUp) delete next[t.id];
      return next;
    });
  }, [threads, renamed]);
  const history = mergeHistory(threads, sessions, {
    now,
    seen,
    siteNames: siteFlags?.siteListDetails === true,
    foldBuildChats: uiFlags?.chatThreadFollowsBuild === true,
    stable: uiFlags?.recentRowsStable === true,
  })
    .filter((h) => h.kind === "build" || !deletedIds.has(h.id))
    .map((h) => (h.kind === "chat" && renamed[h.id] ? { ...h, title: renamed[h.id]! } : h));
  const deleteChat = async (slug: string, threadId: string, title: string) => {
    const ok = await confirmAction({
      title: "Delete this chat?",
      description: `"${title}" will be removed from your history.`,
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (!ok) return;
    setDeletedIds((prev) => new Set(prev).add(threadId));
    try {
      const res = await apiFetch(`/api/agents/${encodeURIComponent(slug)}/threads/${threadId}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`delete failed: ${res.status}`);
      for (const tab of tabsRef.current) {
        if (!payloadOwnsThread(tab.payload)) continue;
        if ((tab.payload as { threadId?: string | null }).threadId !== threadId) continue;
        if (tab.pinned || tab.kind === "build" || tab.payload.kind === "dispute-detail") {
          setTabThreadId(tab.id, null);
        } else closeTab(tab.id);
      }
    } catch {
      setDeletedIds((prev) => {
        const next = new Set(prev);
        next.delete(threadId);
        return next;
      });
    }
    notifyThreadsChanged();
  };
  const renameChat = async (slug: string, threadId: string, title: string) => {
    setRenamed((prev) => ({ ...prev, [threadId]: title }));
    const undo = () =>
      setRenamed((prev) => {
        const next = { ...prev };
        delete next[threadId];
        return next;
      });
    try {
      const res = await apiFetch(`/api/agents/${encodeURIComponent(slug)}/threads/${threadId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      if (!res.ok) throw new Error(`rename failed: ${res.status}`);
    } catch {
      undo();
    }
    notifyThreadsChanged();
  };
  const activeBuildId = active?.kind === "build" ? buildSessionId : null;
  const activeHistoryId = activeBuildId ?? activeThreadId;
  const activeItem = activeHistoryId
    ? history.find((h) => h.id === activeHistoryId)
    : undefined;
  const activeRunning = activeItem?.status === "running";
  const activeAt = activeItem?.at ?? null;
  useEffect(() => {
    if (!activeHistoryId || activeRunning) return;
    markSeen(activeHistoryId, Math.max(Date.now(), activeAt ?? 0));
  }, [activeHistoryId, activeRunning, activeAt, markSeen]);

  const openThread = (slug: string, threadId: string) => {
    const buildTab = tabs.find((t) => t.payload.kind === "build");
    if (
      historyRowBindsToBuild({
        rowSlug: slug,
        rowThreadId: threadId,
        operatorSlug: ZAVI,
        activeTabKind: active?.kind,
        hasBuildTab: buildTab !== undefined,
        buildThreadId:
          buildTab?.payload.kind === "build"
            ? buildTab.payload.threadId
            : undefined,
        buildChatFollowsThread,
      }) &&
      buildTab
    ) {
      setTabThreadId(buildTab.id, threadId, { activate: true, push: true });
      return;
    }
    const step = agentThreadOpenStep(tabs, slug, threadId);
    if (step.kind === "open") {
      void openAgentTab(slug, { threadId, push: true });
      return;
    }
    if (step.kind === "activate") {
      setActiveTab(step.tabId, { push: true });
      return;
    }
    setTabThreadId(step.tabId, threadId, { activate: true, push: true });
  };

  return (
    <div className={cx("flex flex-col px-2", !open && "shrink-0 pb-2")}>
      {}
      <div className="sticky top-0 z-10 -mx-2 border-t border-rule bg-cream px-2 pb-1 pt-2">
        <div className="flex items-center gap-1 px-0.5">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={open ? "Collapse recent" : "Expand recent"}
            className={cx(
              "group flex min-w-0 items-center gap-1 rounded-cta px-1 py-1 text-inkMuted hover:text-ink compact:text-ink",
              FOCUS_RING,
            )}
          >
            <span className="truncate text-[11px] font-semibold uppercase tracking-[0.08em]">
              Recent
            </span>
            <ChevronUp
              className={cx(
                "h-3.5 w-3.5 shrink-0 transition-transform duration-150 motion-reduce:transition-none",
                open ? "rotate-180" : "rotate-90",
              )}
              aria-hidden
            />
          </button>
          <span className="flex-1" />
          <button
            type="button"
            onClick={() => {
              void openAgentTab(ZAVI, { newThread: true, push: true });
            }}
            aria-label="New Chat"
            title="New Chat"
            className={cx(
              "inline-flex h-7 w-7 items-center justify-center rounded-full text-inkLight transition-colors hover:bg-ink/[0.06] hover:text-ink motion-reduce:transition-none",
              FOCUS_RING,
            )}
          >
            <Plus className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </div>

      {open && (
        <div className="flex flex-col gap-0.5 pb-2">
          {history.length === 0 &&
            (threadsLoaded && sessionsLoaded ? (
              <p className="px-2.5 py-1 text-[13px] text-inkLight">
                No history yet. Start a chat or build something.
              </p>
            ) : (
              <div role="status" aria-label="Loading history">
                {[68, 84, 56, 76].map((w) => (
                  <div key={w} className="px-2.5 py-[7px]">
                    <div
                      className="h-[13px] animate-pulse rounded bg-ink/[0.06] motion-reduce:animate-none"
                      style={{ width: `${w}%` }}
                    />
                  </div>
                ))}
              </div>
            ))}
          {history.map((item) => (
              <HistoryRow
                key={`${item.kind}:${item.id}`}
                item={item}
                active={
                  item.kind === "build"
                    ? activeBuildId === item.id
                    : activeSlug === item.agentSlug && activeThreadId === item.id
                }
                onOpen={() =>
                  item.kind === "build"
                    ? openBuildTab(item.id, { push: true })
                    : openThread(item.agentSlug, item.id)
                }
                onRename={
                  item.kind === "chat"
                    ? (title) => void renameChat(item.agentSlug, item.id, title)
                    : undefined
                }
                onDelete={
                  item.kind === "chat"
                    ? () => void deleteChat(item.agentSlug, item.id, item.title)
                    : undefined
                }
              />
          ))}
        </div>
      )}
    </div>
  );
}

function fmtResetDate(d: string | null): string | null {
  if (!d) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) return null;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function AccountFooter({
  theme,
  onSetTheme,
  onHowTo,
}: {
  theme: Theme;
  onSetTheme: (next: Theme) => void;
  onHowTo: () => void;
}) {
  const {
    userEmail,
    role,
    creditsRemaining,
    creditsAllowance,
    creditsTotal,
    openTab,
    openAgentTab,
  } = useWorkspace();
  const openStatic = useOpenStatic();
  const [menuOpen, setMenuOpen] = useState(false);
  const [resetDate, setResetDate] = useState<string | null>(null);
  const resetAsked = useRef(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen || resetAsked.current) return;
    resetAsked.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiFetch("/api/billing/credits");
        if (!res.ok) return;
        const j = (await res.json()) as { period_end?: unknown };
        if (!cancelled && typeof j.period_end === "string")
          setResetDate(j.period_end);
      } catch {
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target;
      const inMenu =
        target instanceof Node && menuRef.current?.contains(target);
      const inFlyout =
        target instanceof Element &&
        target.closest("[data-account-menu-portal]");
      if (!inMenu && !inFlyout) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const email = userEmail ?? "";
  const name = email.split("@")[0] || "You";
  const initials = name.slice(0, 2).toUpperCase();

  const item = (kind: StaticKind) => () => {
    setMenuOpen(false);
    openStatic(kind);
  };
  const signOut = async () => {
    setMenuOpen(false);
    await createBrowserSupabase().auth.signOut({ scope: "local" });
    window.location.replace("/login");
  };
  const canManageBilling = !isMember(role);
  const goBilling = (target: BillingTarget = "billing") => {
    setMenuOpen(false);
    openBillingSettings(openTab, target);
  };

  const creditState =
    typeof creditsRemaining === "number"
      ? creditBannerState(
          creditsRemaining,
          creditsAllowance ?? 0,
          STATUS_LOW_CREDIT_THRESHOLD,
        )
      : "none";
  const creditMeter = creditMeterModel(
    creditsRemaining ?? 0,
    creditsTotal ?? creditsAllowance ?? 0,
    0,
    creditState,
  );
  const creditsLabel =
    typeof creditsRemaining !== "number"
      ? "-"
      : creditMeter.pctLabel !== null
        ? `${creditMeter.pctLabel}% left`
        : `${creditsRemaining.toLocaleString()} left`;
  const resetLabel = fmtResetDate(resetDate);

  const menuItem =
    "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] font-medium text-ink hover:bg-creamDeep " +
    FOCUS_RING;

  return (
    <div
      ref={menuRef}
      className="relative mt-auto shrink-0 border-t border-rule px-2 py-2"
    >
      <button
        type="button"
        aria-label="Account menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((v) => !v)}
        className={cx(
          "flex w-full items-center gap-2.5 rounded-cta py-1 text-left",
          FOCUS_RING,
        )}
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-ink text-[12px] font-bold tracking-[0.03em] text-cream">
          {initials}
        </span>
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="truncate text-[14px] font-semibold text-ink">
            {name}
          </span>
          <span className="mt-0.5 truncate text-[12px] text-inkMuted">
            {email}
          </span>
        </span>
        <ChevronUp
          className={cx(
            "mr-1.5 h-4 w-4 shrink-0 text-ink transition-transform duration-200 motion-reduce:transition-none",
            menuOpen && "rotate-180",
          )}
          aria-hidden
        />
      </button>

      {menuOpen && (
        <div
          role="menu"
          aria-label="Account"
          className="account-menu absolute bottom-full left-2 z-30 mb-2 flex w-64 max-w-[calc(100%-24px)] flex-col gap-0.5 rounded-xl border border-rule bg-cream p-1.5 shadow-pop"
        >
          {}
          <div className="flex flex-col gap-3 px-2.5 pb-1 pt-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[14px] font-semibold leading-5 text-ink">
                Credits
              </span>
              {canManageBilling ? (
                <button
                  type="button"
                  onClick={() => goBilling("billing-usage")}
                  title="Credit usage"
                  className={cx(
                    "flex shrink-0 items-center gap-0.5 rounded-cta text-[13px] font-medium tabular-nums transition-colors",
                    creditState === "none"
                      ? "text-inkMuted hover:text-ink"
                      : "text-danger hover:opacity-80",
                    FOCUS_RING,
                  )}
                >
                  {creditsLabel}
                  <NextChevron />
                </button>
              ) : (
                <span
                  className={cx(
                    "shrink-0 text-[13px] font-medium tabular-nums",
                    creditState === "none" ? "text-inkMuted" : "text-danger",
                  )}
                >
                  {creditsLabel}
                </span>
              )}
            </div>

            {}
            {creditMeter.total > 0 && (
              <div className="credit-meter-track h-1.5 w-full overflow-hidden rounded-full bg-bone">
                <div
                  className={cx(
                    "h-full rounded-full transition-[width] duration-300 motion-reduce:transition-none",
                    creditState === "none" ? "bg-ink" : "bg-danger",
                  )}
                  style={{ width: `${creditMeter.fillPct}%` }}
                />
              </div>
            )}

            {resetLabel && (
              <p className="flex items-center gap-2 text-[12px] leading-4 text-inkMuted">
                <CircleAlert
                  className="h-3.5 w-3.5 shrink-0 text-marigoldDeep"
                  aria-hidden
                />
                {creditResetLine(resetLabel)}
              </p>
            )}

            {canManageBilling && (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => goBilling("billing")}
                  className={cx(
                    "flex h-8 min-w-[6.5rem] flex-1 items-center justify-center rounded-cta border border-rule bg-transparent whitespace-nowrap px-2 text-[13px] font-semibold text-ink transition-colors hover:bg-ink/[0.06]",
                    FOCUS_RING,
                  )}
                >
                  Buy Credits
                </button>
                <button
                  type="button"
                  onClick={() => goBilling("billing")}
                  className={cx(
                    "flex h-8 min-w-[6.5rem] flex-1 items-center justify-center rounded-cta bg-ink whitespace-nowrap px-2 text-[13px] font-semibold text-cream transition-opacity hover:opacity-90",
                    FOCUS_RING,
                  )}
                >
                  Upgrade Plan
                </button>
              </div>
            )}
          </div>
          <span className="my-1 h-px bg-rule" aria-hidden />
          <button
            type="button"
            role="menuitem"
            className={menuItem}
            onClick={item("settings")}
          >
            <Settings className="h-4 w-4 text-inkMuted" aria-hidden /> Settings
          </button>
          {}
          <button
            type="button"
            role="menuitem"
            className={menuItem}
            onClick={() => {
              setMenuOpen(false);
              openStatic("settings", { section: "account", requestedAt: Date.now() });
            }}
          >
            <CircleUserRound className="h-4 w-4 text-inkMuted" aria-hidden /> Account
          </button>
          <button
            type="button"
            role="menuitem"
            className={menuItem}
            onClick={item("home")}
          >
            <Columns3 className="h-4 w-4 text-inkMuted" aria-hidden /> Board
          </button>
          {!isMember(role) && (
            <button
              type="button"
              role="menuitem"
              className={menuItem}
              onClick={item("members")}
            >
              <Users className="h-4 w-4 text-inkMuted" aria-hidden /> Members
            </button>
          )}
          {}
          <button
            type="button"
            role="menuitem"
            className={menuItem}
            onClick={() => {
              setMenuOpen(false);
              openStatic("settings", { section: "feedback", requestedAt: Date.now() });
            }}
          >
            <MessageSquare className="h-4 w-4 text-inkMuted" aria-hidden />{" "}
            Feedback
          </button>
          <a
            role="menuitem"
            href="/talk-to-team"
            target="_blank"
            rel="noreferrer"
            className={menuItem}
            onClick={() => setMenuOpen(false)}
          >
            <HelpCircle className="h-4 w-4 text-inkMuted" aria-hidden /> Help
          </a>
          {}
          <button
            type="button"
            role="menuitem"
            className={menuItem}
            onClick={() => {
              setMenuOpen(false);
              onHowTo();
            }}
          >
            <PlayCircle className="h-4 w-4 text-inkMuted" aria-hidden /> How to
            use Zavi
          </button>
          {}
          <a
            role="menuitem"
            href="/tutorials"
            target="_blank"
            rel="noreferrer"
            className={menuItem}
            onClick={() => {
              setMenuOpen(false);
              trackEvent("tutorials_link_clicked", { source: "menu" });
            }}
          >
            <GraduationCap className="h-4 w-4 text-inkMuted" aria-hidden />{" "}
            Tutorials
          </a>
          <AppearanceMenu
            theme={theme}
            onSetTheme={onSetTheme}
            menuItemClassName={menuItem}
          />
          <span className="my-1 h-px bg-rule" aria-hidden />
          <button
            type="button"
            role="menuitem"
            className={menuItem}
            onClick={signOut}
          >
            <LogOut className="h-4 w-4 text-inkMuted" aria-hidden /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}

export function homeIsCurrent(
  active: TabDescriptor | undefined,
  chatFocus: boolean,
): boolean {
  if (!chatFocus || active?.payload.kind !== "agent") return false;
  return active.payload.threadId === null;
}

export function ContextPanel({
  chrome,
  onCollapse,
  theme,
  onSetTheme,
  chatFocus,
  buildChatFollowsThread = false,
}: {
  chrome?: ColumnChrome;
  onCollapse: () => void;
  theme: Theme;
  onSetTheme: (next: Theme) => void;
  chatFocus: boolean;
  buildChatFollowsThread?: boolean;
}) {
  const [howTo, setHowTo] = useState<"card" | "menu" | null>(null);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const { updates: feedbackUpdates } = useMyFeedback();
  const needsYouSnap = useNeedsYouSnapshot();
  const {
    tabs,
    activeTabId,
    tenantName,
    tenantId,
    openAgentTab,
    openBuildTab,
    buildSessionId,
    treeAgents,
    supplyDemandEligible,
    role,
    openTab,
  } = useWorkspace();
  const openStatic = useOpenStatic();
  const agentPages = visibleAgentPages(treeAgents, supplyDemandEligible);
  const openAgentPage = (page: AgentPage) => {
    if (page.lockedTier && !isMember(role))
      openBillingSettings(
        openTab,
        upgradeHash({ tier: page.lockedTier, term: "6mo" }),
      );
    else openStatic(page.kind);
  };
  const { currentSessionId: currentBuildId, loaded: buildsLoaded } =
    useBuildSessions();
  const activeTabRef = useRef(activeTabId);
  activeTabRef.current = activeTabId;
  const siteListFirst = useSiteListFirst();
  const openBuild = async () => {
    if (siteListFirst === true) {
      openBuildTab(null);
      return;
    }
    if (!buildSessionId && !buildsLoaded) {
      const clickedOn = activeTabRef.current;
      await refreshBuildSessions();
      if (activeTabRef.current !== clickedOn) return;
      const latest = readBuildSessions();
      openBuildTab(
        pickBuildEntry(null, latest.currentSessionId, latest.loaded),
      );
      return;
    }
    openBuildTab(pickBuildEntry(buildSessionId, currentBuildId, buildsLoaded));
  };

  const active = tabs.find((t) => t.id === activeTabId);
  const is = (kind: StaticKind) => active?.kind === kind;

  const companyName = tenantName ?? "Zavi";
  const initial = (companyName.trim()[0] || "Z").toUpperCase();

  return (
    <aside
      aria-label="Navigation"
      className="flex h-full w-full flex-col overflow-hidden rounded-2xl bg-cream font-ui shadow-elev"
    >
      {}
      <div
        {...(chrome?.dropProps ?? {})}
        className="flex h-14 shrink-0 items-center gap-2 px-2 pt-2"
      >
        <div className="min-w-0 flex-1">
          <WorkspaceSwitcher
            companyName={companyName}
            companyInitial={initial}
            onOpenHome={() => void openAgentTab(ZAVI)}
          />
        </div>
        <NotificationsMenu className="compact:h-11 compact:w-11" />
        <IconButton
          label="Hide sidebar"
          onClick={onCollapse}
          className="compact:h-11 compact:w-11"
        >
          <PanelLeftClose
            className="h-4 w-4 compact:h-5 compact:w-5"
            aria-hidden
          />
        </IconButton>
      </div>

      {}
      <div className="ws-scroll min-h-0 flex-1">
        <nav
          aria-label="Destinations"
          className="flex flex-col gap-0.5 px-2 pb-2 pt-1"
        >
          {}
          <CgoNavItem active={is("autopilot")} onClick={() => openStatic("autopilot")} tenantId={tenantId} />
          <div aria-hidden className="mx-2.5 my-1 border-t border-rule" />
          {}
          {}
          <NavItem
            label="Home"
            icon={<SquarePen className="h-4 w-4" aria-hidden />}
            active={homeIsCurrent(active, chatFocus)}
            onClick={() => {
              void openAgentTab(ZAVI, { newThread: true, push: true });
            }}
          />
          {}
          <NavItem
            label="Growth Channels"
            icon={<Inbox className="h-4 w-4" aria-hidden />}
            active={is("channels")}
            onClick={() => {
              openStatic("channels");
            }}
          />
          <NavItem
            label="Needs you"
            icon={<Bell className="h-4 w-4" aria-hidden />}
            active={is("needs-you")}
            badge={<NeedsYouCount snap={needsYouSnap} tenantId={tenantId} />}
            onClick={() => {
              openStatic("needs-you");
            }}
          />
          <NavItem
            label="Analytics"
            icon={<BarChart3 className="h-4 w-4" aria-hidden />}
            active={is("analytics")}
            onClick={() => {
              openStatic("analytics");
            }}
          />
          {}
          <NavItem
            label="Messaging"
            icon={<MessagesSquare className="h-4 w-4" aria-hidden />}
            active={is("messaging")}
            onClick={() => {
              openStatic("messaging");
            }}
          />
          {}
          <NavItem
            label="Build"
            icon={<WebsiteIcon className="h-5 w-5" aria-hidden />}
            active={active?.kind === "build"}
            onClick={() => void openBuild()}
          />
          <NavItem
            label="Agent Builder"
            icon={<Bot className="h-4 w-4" aria-hidden />}
            active={is("agent-builder")}
            onClick={() => {
              openStatic("agent-builder", { agentId: null });
            }}
          />
          <NavItem
            label="Artifacts"
            icon={<ArtifactsIcon className="h-5 w-5" aria-hidden />}
            active={is("artifacts")}
            onClick={() => {
              openStatic("artifacts");
            }}
          />
          {}
          {}
          <NavItem
            label="Connectors"
            icon={<Blocks className="h-4 w-4" aria-hidden />}
            active={is("brain")}
            onClick={() => {
              openStatic("brain");
            }}
          />
          {}
          {agentPages.map((page) => (
            <NavItem
              key={page.kind}
              label={page.label}
              icon={page.icon}
              active={is(page.kind)}
              badge={
                page.lockedTier ? (
                  <PlanLockIcon tier={page.lockedTier} />
                ) : undefined
              }
              onClick={() => openAgentPage(page)}
            />
          ))}
        </nav>
        <CustomAgentsNav
          agents={treeAgents}
          activeAgentId={
            active?.payload.kind === "agent-builder"
              ? (active.payload.agentId ?? null)
              : null
          }
          onOpen={(slug) => openStatic("agent-builder", { agentId: slug })}
        />

        <ChatSection buildChatFollowsThread={buildChatFollowsThread} />
      </div>

      <PendingPlanNotice />
      {}
      <div className="mx-2 mb-1 shrink-0">
        <NavItem
          label="Tutorials"
          icon={<GraduationCap className="h-4 w-4" aria-hidden />}
          newTabHref="/tutorials"
          onClick={() => trackEvent("tutorials_link_clicked", { source: "sidebar" })}
        />
      </div>
      {}
      <div className="mx-2 mb-1.5 shrink-0">
        <NavItem
          label="Send feedback"
          icon={<MessageSquare className="h-4 w-4" aria-hidden />}
          onClick={() => setFeedbackOpen(true)}
          badge={
            feedbackUpdates > 0 ? (
              <span className="shrink-0 rounded-full bg-[#0F766E] px-1.5 py-px text-[11px] font-semibold text-white">
                {feedbackUpdates} {feedbackUpdates === 1 ? "update" : "updates"}
              </span>
            ) : undefined
          }
        />
      </div>
      {feedbackOpen && <FeedbackDialog onClose={() => setFeedbackOpen(false)} />}
      <HowToVideoCard
        onOpen={() => setHowTo("card")}
        dialogOpen={howTo !== null}
      />
      <AccountFooter
        theme={theme}
        onSetTheme={onSetTheme}
        onHowTo={() => setHowTo("menu")}
      />
      {howTo && (
        <HowToVideoDialog
          source={howTo}
          onClose={() => {
            setHowTo(null);
            requestAnimationFrame(() =>
              document
                .querySelector<HTMLElement>('[aria-label="Account menu"]')
                ?.focus(),
            );
          }}
          onStart={() => {
            setHowTo(null);
            openStatic("messaging");
          }}
        />
      )}
    </aside>
  );
}

function PlanLockIcon({ tier }: { tier: LockTier }) {
  return (
    <span className="shrink-0 text-inkLight" title={planBadgeLabel(tier)}>
      <Lock className="h-3.5 w-3.5" aria-hidden />
      <span className="sr-only">({planBadgeLabel(tier)})</span>
    </span>
  );
}

export function ContextRail({
  onExpand,
  chatFocus,
}: {
  onExpand: () => void;
  chatFocus: boolean;
}) {
  const {
    tabs,
    activeTabId,
    tenantId,
    openAgentTab,
    openBuildTab,
    buildSessionId,
    treeAgents,
    supplyDemandEligible,
    role,
    openTab,
  } = useWorkspace();
  const openStatic = useOpenStatic();
  const agentPages = visibleAgentPages(treeAgents, supplyDemandEligible);
  const openAgentPage = (page: AgentPage) => {
    if (page.lockedTier && !isMember(role))
      openBillingSettings(
        openTab,
        upgradeHash({ tier: page.lockedTier, term: "6mo" }),
      );
    else openStatic(page.kind);
  };
  const { currentSessionId: currentBuildId, loaded: buildsLoaded } =
    useBuildSessions();
  const activeTabRef = useRef(activeTabId);
  activeTabRef.current = activeTabId;
  const siteListFirst = useSiteListFirst();
  const openBuild = async () => {
    if (siteListFirst === true) {
      openBuildTab(null);
      return;
    }
    if (!buildSessionId && !buildsLoaded) {
      const clickedOn = activeTabRef.current;
      await refreshBuildSessions();
      if (activeTabRef.current !== clickedOn) return;
      const latest = readBuildSessions();
      openBuildTab(
        pickBuildEntry(null, latest.currentSessionId, latest.loaded),
      );
      return;
    }
    openBuildTab(pickBuildEntry(buildSessionId, currentBuildId, buildsLoaded));
  };

  const active = tabs.find((t) => t.id === activeTabId);
  const is = (kind: StaticKind) => active?.kind === kind;

  const item = (
    label: string,
    icon: ReactNode,
    isActive: boolean,
    onClick: () => void,
  ) => (
    <button
      key={label}
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-current={isActive ? "page" : undefined}
      className={cx(
        "relative flex h-10 w-10 items-center justify-center rounded-cta transition-colors duration-150 motion-reduce:transition-none",
        isActive
          ? "bg-ink/10 text-ink"
          : "text-inkLight hover:bg-ink/[0.04] hover:text-ink",
        FOCUS_RING,
      )}
    >
      {icon}
    </button>
  );

  return (
    <nav
      aria-label="Destinations"
      className="flex min-h-0 flex-col items-center gap-1 overflow-y-auto pt-1"
    >
      <CgoRailItem active={is("autopilot")} onClick={() => openStatic("autopilot")} tenantId={tenantId} />
      <div aria-hidden className="my-0.5 w-6 border-t border-rule" />
      {item(
        "Home",
        <SquarePen className="h-4 w-4" aria-hidden />,
        homeIsCurrent(active, chatFocus),
        () => {
          void openAgentTab("operator", { newThread: true, push: true });
        },
      )}
      {item(
        "Growth Channels",
        <Inbox className="h-4 w-4" aria-hidden />,
        is("channels"),
        () => {
          openStatic("channels");
        },
      )}
      <NotificationsMenu side="right" className="h-10 w-10" />
      {item(
        "Analytics",
        <BarChart3 className="h-4 w-4" aria-hidden />,
        is("analytics"),
        () => {
          openStatic("analytics");
        },
      )}
      {item(
        "Messaging",
        <MessagesSquare className="h-4 w-4" aria-hidden />,
        is("messaging"),
        () => {
          openStatic("messaging");
        },
      )}
      {item(
        "Build",
        <WebsiteIcon className="h-5 w-5" aria-hidden />,
        active?.kind === "build",
        () => void openBuild(),
      )}
      {item(
        "Agent Builder",
        <Bot className="h-4 w-4" aria-hidden />,
        is("agent-builder"),
        () => {
          openStatic("agent-builder", { agentId: null });
        },
      )}
      {item(
        "Artifacts",
        <ArtifactsIcon className="h-5 w-5" aria-hidden />,
        is("artifacts"),
        () => {
          openStatic("artifacts");
        },
      )}
      {}
      {item(
        "Connectors",
        <Blocks className="h-4 w-4" aria-hidden />,
        is("brain"),
        () => {
          openStatic("brain");
        },
      )}
      {}
      {agentPages.map((page) =>
        item(
          page.lockedTier
            ? `${page.label} (${planBadgeLabel(page.lockedTier)})`
            : page.label,
          page.lockedTier ? (
            <span className="relative">
              {page.icon}
              <Lock
                className="absolute -bottom-1 -right-1.5 h-2.5 w-2.5 rounded-full bg-cream"
                aria-hidden
              />
            </span>
          ) : (
            page.icon
          ),
          is(page.kind),
          () => openAgentPage(page),
        ),
      )}
    </nav>
  );
}

export function CustomAgentsNav({
  agents,
  activeAgentId,
  onOpen,
}: {
  agents: ReadonlyArray<{
    slug: string;
    name?: string;
    custom?: boolean;
    custom_agent_id?: string;
  }>;
  activeAgentId: string | null;
  onOpen: (slug: string) => void;
}) {
  const rows = customAgentRows(agents);
  if (rows.length === 0) return null;
  return (
    <nav aria-label="Custom agents" className="flex flex-col gap-0.5 px-2 pb-2">
      <p className="px-2.5 pb-1 pt-2 text-[12px] font-medium uppercase tracking-[0.06em] text-inkMuted">
        Custom agents
      </p>
      {rows.map((a) => (
        <NavItem
          key={a.slug}
          label={a.name as string}
          icon={<Bot className="h-4 w-4" aria-hidden />}
          active={
            !!activeAgentId &&
            (activeAgentId === a.slug || activeAgentId === a.custom_agent_id)
          }
          onClick={() => onOpen(a.slug)}
        />
      ))}
    </nav>
  );
}
