"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { useSearchParams } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { agentDisplayName } from "@/lib/agentRegistry";
import {
  useResizablePane,
  type UseResizablePaneOptions,
} from "@/hooks/useResizablePane";
import { useWorkspace } from "./WorkspaceShell";
import { ChatThread } from "./ChatThread";
import { onThreadPaneRequest, takeThreadPaneRequest } from "./onScreenThreads";
import { Composer, createComposerDraft, type Attachment } from "./Composer";
import { AgentComposerFrame } from "./agent/AgentComposerFrame";
import { CreditWallNotice, type CreditWall } from "./CreditWallNotice";
import { InlineStatusRow } from "./InlineStatusRow";
import { ThreadBar } from "./ThreadBar";
import { ThreadTitleBar } from "./layout/ThreadTitleBar";
import { ThreadFeed } from "./ThreadFeed";
import { ThreadPane, THREAD_PANE_COLLAPSED_FRACTION } from "./ThreadPane";
import { ArtifactPane } from "./artifacts/ArtifactPane";
import { dismissReport } from "./uiBlockData";
import {
  ArtifactPreviewProvider,
  useArtifactPreview,
} from "./artifacts/artifactPreviewContext";
import { useAgentRun } from "@/lib/workspace/useAgentRun";
import type { ChatRow } from "@/lib/workspace/useChatThread";
import { useInlineEdit } from "@/lib/workspace/useInlineEdit";
import type { WorkspaceViewMode } from "@/lib/workspace/types";
import { Tooltip } from "./Tooltip";
import { ChatExpandButton, HEADER_CARD_SHADOW } from "./ChatExpandButton";
import { LowCreditsWarning } from "./LowCreditsWarning";
import { WaitingForYouLink } from "./WaitingForYou";
import { SetupChatNotices } from "./setup/SetupChatNotices";
import { AgentAvatar } from "./AgentAvatar";
import { AgentDashboard } from "./agent/AgentDashboard";
import { ScheduleView } from "./agent/ScheduleView";
import { FeedbackView } from "./agent/FeedbackView";
import { EngineerSitePreview } from "./EngineerSitePreview";
import { useProductUrl } from "./useProductUrl";
import {
  WorkspaceModeWelcome,
  type WorkspaceMode,
} from "./ZaviWelcome";
import { useChatThread } from "@/lib/workspace/useChatThread";
import { notifyThreadsChanged } from "./useAgentThreads";
import { resolveInflight } from "./chatInflight";
import { NEXT_TILE_MAKE_PROMPTS, NEXT_TILE_THINK_PROMPTS } from "@zavi/shared";
import { NextTiles } from "./NextTiles";
import { shouldFoldWelcomeIdeas } from "./home/welcomeLoading";
import { TeamNoteStrip } from "./chat/TeamNoteStrip";

type InnerTab = "preview" | "dashboard" | "schedule" | "feedback";

function hasPreviewTab(slug: string): boolean {
  return slug === "engineer";
}

function availableTabs(slug: string): InnerTab[] {
  return hasPreviewTab(slug)
    ? ["preview", "dashboard", "schedule", "feedback"]
    : ["dashboard", "schedule", "feedback"];
}

export function defaultTab(_slug: string): InnerTab {
  return "dashboard";
}

export function parseInnerTab(raw: string | null, slug: string): InnerTab {
  const avail = availableTabs(slug);
  return avail.includes(raw as InnerTab)
    ? (raw as InnerTab)
    : defaultTab(slug);
}

const CHAT_WIDTH_KEY = "zavi.agentChatWidth";
const CHAT_MIN_PX = 340;
const CHAT_MAX_FRACTION = 0.4;
const CHAT_DEFAULT_PX = 420;
const CHAT_PLUS_PANE_MAX_FRACTION = 0.48;
const CHAT_EXPAND_AT_PX = 560;

export const AGENT_CHAT_PANE_OPTIONS: UseResizablePaneOptions = {
  storageKey: CHAT_WIDTH_KEY,
  min: CHAT_MIN_PX,
  maxFraction: CHAT_MAX_FRACTION,
  round: "max",
  defaultPx: CHAT_DEFAULT_PX,
  resetTo: CHAT_DEFAULT_PX,
  ariaLabel: "Resize chat",
};

export function chatPaneLayout(
  chatWidth: number,
  paneOpen: boolean,
  _paneWidthPct: number,
  viewportPx: number,
): { chatVisiblePx: number; paneExtraPx: number } {
  if (!paneOpen || viewportPx <= 0) {
    return { chatVisiblePx: chatWidth, paneExtraPx: 0 };
  }
  const roomForBoth = Math.round(viewportPx * CHAT_PLUS_PANE_MAX_FRACTION);
  const want = Math.round(viewportPx * THREAD_PANE_COLLAPSED_FRACTION);
  const paneExtraPx = Math.max(0, Math.min(want, roomForBoth - CHAT_MIN_PX));
  const chatVisiblePx = Math.max(
    CHAT_MIN_PX,
    Math.min(chatWidth, roomForBoth - paneExtraPx),
  );
  return { chatVisiblePx, paneExtraPx };
}

export function AgentTab({
  slug,
  tabId,
  threadId,
  isActive = true,
  chatOnly = false,
  sidePanel = false,
  workspaceMode = "grow",
}: {
  slug: string;
  tabId: string;
  threadId?: string | null;
  chatOnly?: boolean;
  sidePanel?: boolean;
  workspaceMode?: WorkspaceMode;
  isActive?: boolean;
}) {
  const searchParams = useSearchParams();
  const { markUrlWritten, paneWidthPct } = useWorkspace();
  const productUrl = useProductUrl();

  const urlSubTab = parseInnerTab(searchParams.get("tab"), slug);
  const [innerTab, setInnerTabState] = useState<InnerTab>(urlSubTab);

  useEffect(() => {
    if (!isActive) return;
    if (urlSubTab !== innerTab) setInnerTabState(urlSubTab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlSubTab, isActive]);

  const setInnerTab = useCallback(
    (t: InnerTab) => {
      setInnerTabState(t);
      if (!isActive) return;
      const livePathname = window.location.pathname;
      const params = new URLSearchParams(window.location.search);
      if (t === defaultTab(slug)) params.delete("tab");
      else params.set("tab", t);
      const qs = params.toString();
      window.history.replaceState(
        window.history.state,
        "",
        qs ? `${livePathname}?${qs}` : livePathname,
      );
      markUrlWritten(qs);
    },
    [isActive, markUrlWritten, slug],
  );

  const [pendingRunId, setPendingRunId] = useState<string | null>(null);
  const prevThreadIdRef = useRef(threadId);
  useEffect(() => {
    const prev = prevThreadIdRef.current;
    prevThreadIdRef.current = threadId;
    if (typeof prev === "string" && prev !== threadId) setPendingRunId(null);
  }, [threadId]);

  const [previewSessionId, setPreviewSessionId] = useState<string | null>(null);

  const paneOpenRef = useRef(false);
  const chatExpandedRef = useRef(false);
  const {
    sizePx,
    dragging,
    separatorProps: chatSeparatorProps,
  } = useResizablePane({
    ...AGENT_CHAT_PANE_OPTIONS,
    onCommit: (_pct, px) => {
      if (paneOpenRef.current && !chatExpandedRef.current && px >= CHAT_EXPAND_AT_PX) {
        setChatExpanded(true);
      }
    },
  });
  const chatWidth = sizePx ?? CHAT_DEFAULT_PX;

  const [paneOpen, setPaneOpen] = useState(false);
  const [viewportPx, setViewportPx] = useState(0);
  useEffect(() => {
    const read = () => setViewportPx(window.innerWidth);
    read();
    window.addEventListener("resize", read);
    return () => window.removeEventListener("resize", read);
  }, []);
  const { chatVisiblePx, paneExtraPx } = chatPaneLayout(
    chatWidth,
    paneOpen,
    paneWidthPct,
    viewportPx,
  );

  const [chatExpanded, setChatExpanded] = useState(false);

  const chatResizable = !chatExpanded;
  paneOpenRef.current = paneOpen;
  chatExpandedRef.current = chatExpanded;

  if (slug === "operator" || chatOnly) {
    return (
      <div className="flex h-full flex-col bg-cream">
        <ChatPane
          slug={slug}
          tabId={tabId}
          threadId={threadId}
          pendingRunId={pendingRunId}
          setPendingRunId={setPendingRunId}
          previewSessionId={null}
          isActive={isActive}
          expanded
          onExpandedChange={() => {}}
          zavi={slug === "operator"}
          chatOnly
          sidePanel={sidePanel}
          workspaceMode={workspaceMode}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-cream">
      {}
      <div className="relative flex min-h-0 flex-1">
        {}
        <section
          aria-hidden={chatExpanded}
          className={`flex h-full min-h-0 min-w-0 flex-1 flex-col transition-opacity duration-200 ${
            chatExpanded ? "pointer-events-none opacity-0" : "opacity-100"
          }`}
          style={{ marginRight: chatVisiblePx + paneExtraPx + 6 }}
        >
          <AgentHeader
            slug={slug}
            innerTab={innerTab}
            onChangeInnerTab={setInnerTab}
          />
          {innerTab === "preview" && (
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-cream px-6 py-6">
              <EngineerSitePreview
                key={productUrl?.marketing ?? "no-url"}
                defaultUrl={productUrl?.marketing}
                description={
                  productUrl?.marketing
                    ? "Load your site in a live browser so the engineer can see it alongside the chat. Log in and click around: when you send a message, the engineer sees the page you're on. Your site is filled in below, so just hit Load."
                    : undefined
                }
                onSessionChange={setPreviewSessionId}
              />
            </div>
          )}
          {innerTab === "dashboard" && (
            <ScrollPane wide>
              <AgentDashboard slug={slug} />
            </ScrollPane>
          )}
          {innerTab === "schedule" && (
            <ScrollPane>
              <ScheduleView slug={slug} />
            </ScrollPane>
          )}
          {innerTab === "feedback" && (
            <ScrollPane>
              <FeedbackView slug={slug} />
            </ScrollPane>
          )}
        </section>

        {}
        {}
        {}
        {}
        <aside
          className={`absolute inset-y-0 right-0 flex h-full flex-col border-l border-rule bg-cream ${
            chatExpanded
              ? "shadow-[-12px_0_32px_-16px_rgba(14,15,17,0.10)]"
              : paneOpen
                ? "shadow-[-6px_4px_11.45px_rgba(0,0,0,0.10)]"
                : ""
          } ${dragging ? "" : "transition-[width] duration-300 ease-in-out"}`}
          style={{
            width: chatExpanded ? "100%" : chatVisiblePx + paneExtraPx,
          }}
        >
          {chatResizable && (
            <div
              {...chatSeparatorProps}
              className="group absolute inset-y-0 left-0 z-10 w-[6px] cursor-col-resize"
              title="Drag to resize · double-click to reset"
            >
              <div className="absolute inset-y-0 left-0 w-px -ml-px bg-transparent transition-colors group-hover:bg-[#c9a24b]" />
            </div>
          )}
          <ChatPane
            slug={slug}
            tabId={tabId}
            threadId={threadId}
            pendingRunId={pendingRunId}
            setPendingRunId={setPendingRunId}
            previewSessionId={previewSessionId}
            isActive={isActive}
            expanded={chatExpanded}
            onExpandedChange={setChatExpanded}
            onThreadOpenChange={setPaneOpen}
          />
        </aside>
      </div>
    </div>
  );
}

function ChatPane({
  slug,
  tabId,
  threadId,
  pendingRunId,
  setPendingRunId,
  previewSessionId,
  isActive,
  expanded,
  onExpandedChange,
  onThreadOpenChange,
  zavi,
  chatOnly,
  sidePanel = false,
  workspaceMode = "grow",
}: {
  slug: string;
  tabId: string;
  threadId?: string | null;
  pendingRunId: string | null;
  setPendingRunId: Dispatch<SetStateAction<string | null>>;
  previewSessionId: string | null;
  isActive: boolean;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onThreadOpenChange?: (open: boolean) => void;
  zavi?: boolean;
  chatOnly?: boolean;
  sidePanel?: boolean;
  workspaceMode?: WorkspaceMode;
}) {
  const {
    setTabThreadId,
    viewMode,
    setViewMode,
    paneWidthPct,
    setPaneWidthPct,
    openTab,
    layout,
    initialNextTiles,
  } = useWorkspace();

  const openApprovalDecision = useCallback(
    (decisionId?: string) => {
      openTab({
        kind: "needs-you",
        title: "Needs you",
        payload: { kind: "needs-you", ...(decisionId ? { decision: decisionId } : {}) },
        dirty: false,
        pinned: false,
      });
    },
    [openTab],
  );

  const threaded = viewMode === "threaded";
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);
  useEffect(() => {
    if (!threaded) return;
    const take = () => {
      const requested = takeThreadPaneRequest(tabId);
      if (requested) setOpenThreadId(requested);
    };
    take();
    return onThreadPaneRequest((id) => {
      if (id === tabId) take();
    });
  }, [tabId, threaded]);
  const paneOpen = threaded && !!openThreadId;
  useEffect(() => {
    onThreadOpenChange?.(paneOpen);
  }, [paneOpen, onThreadOpenChange]);
  const conversationRowRef = useRef<HTMLDivElement | null>(null);
  const tabRowRef = useRef<HTMLDivElement | null>(null);
  const agentName = agentDisplayName(slug);
  const [feedNonce, setFeedNonce] = useState(0);
  const refreshFeed = useCallback(() => setFeedNonce((n) => n + 1), []);
  const onThreadLoaded = useCallback(
    (thread: { id: string; title: string | null }) => {
      if (threadId === undefined) {
        setTabThreadId(tabId, thread.id);
      }
    },
    [tabId, threadId, setTabThreadId],
  );
  const chat = useChatThread(slug, threadId, onThreadLoaded);
  const onEditMessage = useInlineEdit(chat, slug, threadId);

  const handleStopRun = useCallback(
    (runId: string) => {
      const hadPendingRun = pendingRunId === runId;
      if (hadPendingRun) setPendingRunId(null);
      chat.markRunStopped(runId);
      return () => {
        chat.unmarkRunStopped(runId);
        if (hadPendingRun) setPendingRunId((cur) => cur ?? runId);
        void chat.refetch();
      };
    },
    [pendingRunId, setPendingRunId, chat],
  );

  const { show: inflightShow, runId: inflightRunId } = resolveInflight({
    activeRunId: chat.activeRunId,
    activeTrigger: chat.activeTrigger,
    pendingRunId,
    rows: chat.rows,
  });
  const loadingEmpty = chat.loading && chat.rows.length === 0;
  const stopRunId = inflightShow && !loadingEmpty ? inflightRunId : null;

  const latestRunId = useMemo(() => {
    for (let i = chat.rows.length - 1; i >= 0; i--) {
      const r = chat.rows[i];
      if (r.kind === "chat_assistant" && r.agent_run_id) return r.agent_run_id;
    }
    return null;
  }, [chat.rows]);

  useEffect(() => {
    if (!pendingRunId) return;
    const replied = chat.rows.some(
      (r) => r.kind === "chat_assistant" && r.agent_run_id === pendingRunId,
    );
    if (!replied) return;
    const id = window.setTimeout(() => setPendingRunId(null), 2000);
    return () => window.clearTimeout(id);
  }, [chat.rows, pendingRunId, setPendingRunId]);

  useEffect(() => {
    if (!pendingRunId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      void apiFetch(
        `/api/agents/runs/${encodeURIComponent(pendingRunId)}/cancel`,
        { method: "POST" },
      ).catch(() => {});
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [pendingRunId]);

  const [seed, setSeed] = useState<{ text: string; nonce: number; autoSend?: boolean } | null>(null);
  const pickSuggestion = (prompt: string) => {
    setSeed((current) => ({
      text: prompt,
      nonce: (current?.nonce ?? 0) + 1,
    }));
    const markKind = NEXT_TILE_THINK_PROMPTS.some((p) => p.prompt === prompt)
      ? "asked"
      : NEXT_TILE_MAKE_PROMPTS.some((p) => p.prompt === prompt)
        ? "made"
        : null;
    if (markKind) {
      void apiFetch("/api/workspace/next-tiles/mark", {
        method: "POST",
        body: JSON.stringify({ kind: markKind, key: prompt }),
      }).catch(() => {});
    }
  };
  const [creditWall, setCreditWall] = useState<CreditWall | null>(null);
  const handleCreditWall = useCallback((wall: CreditWall | null) => {
    setCreditWall(wall);
  }, []);
  const [dropActive, setDropActive] = useState(false);
  const [droppedFiles, setDroppedFiles] = useState<{ files: File[]; nonce: number } | null>(null);
  const dragDepthRef = useRef(0);
  const [firstRunDone, setFirstRunDone] = useState<boolean | null>(
    initialNextTiles?.first_run_done ?? null,
  );
  const composerSeed = useMemo(
    () => (seed ? { ...seed, autoSend: seed.autoSend ?? true } : undefined),
    [seed],
  );

  const [composerAttachments, setComposerAttachments] = useState<Attachment[]>([]);
  const [composerDraft] = useState(createComposerDraft);
  const composerAttachmentsRef = useRef(composerAttachments);
  composerAttachmentsRef.current = composerAttachments;
  useEffect(
    () => () => {
      composerAttachmentsRef.current.forEach((a) => {
        if (a.previewUrl.startsWith("blob:")) URL.revokeObjectURL(a.previewUrl);
      });
    },
    [],
  );

  const showWelcome =
    !!zavi &&
    !threaded &&
    !chat.loading &&
    chat.rows.length === 0 &&
    !pendingRunId &&
    !chat.errorMsg &&
    !chat.notFound;

  const renderComposer = (embedded = false) => (
    <>
      <TeamNoteStrip
        threadId={threadId ?? null}
        teamNote={chat.offeredTeamNote}
        turnKey={chat.teamNoteTurnKey}
        replying={!!chat.activeRunId || !!pendingRunId}
        visible={isActive}
      />
      <Composer
        agentSlug={slug}
        onCreditWall={handleCreditWall}
        tabId={tabId}
        threadId={threadId}
        latestRunId={latestRunId}
        stopRunId={stopRunId}
        previewSessionId={previewSessionId}
        onStopRun={handleStopRun}
        onSent={(runId) => {
          setCreditWall(null);
          setPendingRunId(runId);
          if (threaded) refreshFeed();
        }}
        onNonRunHandled={() => {
          void chat.refetch();
          if (threaded) refreshFeed();
        }}
        onOptimistic={(text, attachments) =>
          chat.appendOptimisticUser(text, attachments, { settleLater: true })
        }
        onOptimisticSettled={chat.settleOptimisticUser}
        draft={composerDraft}
        onSystem={chat.appendOptimisticSystem}
        attachments={composerAttachments}
        onAttachmentsChange={setComposerAttachments}
        seed={composerSeed}
        droppedFiles={droppedFiles ?? undefined}
        hideStarterChips={zavi}
        homeMentions={zavi}
        embedded={embedded}
      />
    </>
  );

  return (
    <ArtifactPreviewProvider>
    <div ref={tabRowRef} className="relative flex h-full min-h-0 w-full">
      {}
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-cream">
      {}
      {!chatOnly && (
      <div className="flex shrink-0 items-stretch border-b border-rule bg-cream [&>div>div]:border-b-0">
        {}
        <div className="min-w-0 flex-1 overflow-hidden">
          {}
          {!threaded &&
            (layout === "legacy" ? (
              <ThreadBar slug={slug} currentThreadId={threadId} />
            ) : (
              <ThreadTitleBar slug={slug} threadId={threadId} />
            ))}
        </div>
        {}
        {}
        {layout === "legacy" && (
        <div className="flex shrink-0 items-stretch gap-2 bg-cream pl-2 pr-3">
          <ViewModeToggle mode={viewMode} onChange={setViewMode} />
          {!zavi && !chatOnly && (
            <ChatExpandButton
              expanded={expanded}
              onExpandedChange={onExpandedChange}
            />
          )}
        </div>
        )}
      </div>
      )}
      {}
      <div
        ref={conversationRowRef}
        className="relative flex min-h-0 min-w-0 flex-1"
        onDragEnter={(e) => {
          if (!Array.from(e.dataTransfer.items).some((i) => i.kind === "file")) return;
          dragDepthRef.current += 1;
          setDropActive(true);
        }}
        onDragOver={(e) => {
          if (!Array.from(e.dataTransfer.items).some((i) => i.kind === "file")) return;
          e.preventDefault();
        }}
        onDragLeave={() => {
          dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
          if (dragDepthRef.current === 0) setDropActive(false);
        }}
        onDrop={(e) => {
          const files = Array.from(e.dataTransfer.files);
          dragDepthRef.current = 0;
          setDropActive(false);
          if (files.length === 0 || e.defaultPrevented) return;
          e.preventDefault();
          setDroppedFiles((current) => ({ files, nonce: (current?.nonce ?? 0) + 1 }));
        }}
      >
        {}
        {dropActive && (
          <div className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-xl border-2 border-dashed border-ink/30 bg-cream/80">
            <span className="rounded-full bg-ink px-3 py-1.5 text-[13px] font-medium text-cream">
              Drop files to attach
            </span>
          </div>
        )}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {showWelcome ? (
            <WorkspaceModeWelcome
              mode={workspaceMode}
              composer={renderComposer(true)}
              beforeComposer={
                <>
                  {zavi && <SetupChatNotices embedded />}
                  {zavi && <WaitingForYouLink embedded />}
                  <LowCreditsWarning embedded />
                </>
              }
              onPickSuggestion={pickSuggestion}
              nextTiles={
                <NextTiles onPrompt={pickSuggestion} onFirstRunDone={setFirstRunDone} />
              }
              foldIdeas={shouldFoldWelcomeIdeas(workspaceMode, firstRunDone)}
              foldConnect={workspaceMode === "grow"}
            />
          ) : (
            <>
              {threaded && (
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <ThreadFeed
                    key={feedNonce}
                    agentSlug={slug}
                    agentName={agentName}
                    isActive={isActive}
                    onOpenThread={setOpenThreadId}
                    onReviewDecision={openApprovalDecision}
                  />
                </div>
              )}
              {!threaded && chat.notFound && (
                <div className="flex min-h-0 flex-1 items-center justify-center px-6 py-12 text-center">
                  <div>
                    <div className="text-[14px] font-medium text-ink">
                      This conversation couldn&apos;t be found.
                    </div>
                    <p className="mx-auto mt-1.5 max-w-sm text-[13px] leading-5 text-inkMuted">
                      It may have been deleted, or the link points to a thread
                      from a different agent or workspace.
                    </p>
                    <button
                      type="button"
                      onClick={() => setTabThreadId(tabId, null)}
                      className="mt-4 rounded-cta border border-rule bg-cream px-3 py-1.5 text-[12px] font-medium text-ink hover:bg-creamDeep"
                    >
                      Start a new conversation
                    </button>
                  </div>
                </div>
              )}
              {!threaded && !chat.notFound && (
                <div className="min-h-0 flex-1 overflow-y-auto focus:outline-none focus-visible:outline-none focus-visible:ring-0">
                  <ChatThread
                    agentSlug={slug}
                    onEditMessage={onEditMessage}
                    threadId={threadId}
                    onRetry={chat.refetch}
                    hideEmptyState={sidePanel}
                    state={{
                      rows: chat.rows,
                      activityRows: chat.activityRows,
                      activityByRun: chat.activityByRun,
                      loading: chat.loading,
                      errorMsg: chat.errorMsg,
                      activeRunId: chat.activeRunId,
                      activeTrigger: chat.activeTrigger,
                      activeRunStartedAt: chat.activeRunStartedAt,
                      activeRunTurnStartedAt: chat.activeRunTurnStartedAt,
                      pendingRunId,
                    }}
                  />
                  {creditWall && <CreditWallNotice wall={creditWall} />}
                  {pendingRunId && (
                    <div className="mx-auto max-w-3xl px-6">
                      <InlineStatusRow
                        key={pendingRunId}
                        agentSlug={slug}
                        runId={pendingRunId}
                        headless
                        onComplete={() => {
                          const completedRunId = pendingRunId;
                          setTimeout(
                            () =>
                              setPendingRunId((current) =>
                                current === completedRunId ? null : current,
                              ),
                            2000,
                          );
                          void chat.refetch();
                          notifyThreadsChanged();
                        }}
                      />
                    </div>
                  )}
                </div>
              )}
              {}
              {threaded && creditWall && (
                <div className="shrink-0">
                  <CreditWallNotice wall={creditWall} />
                </div>
              )}
              {zavi && <SetupChatNotices />}
              {}
              <LowCreditsWarning />
              <AgentComposerFrame agentSlug={slug} zavi={!!zavi} sidePanel={sidePanel}>
                {renderComposer()}
              </AgentComposerFrame>
            </>
          )}
        </div>
      </div>
      </div>

      {}
      {threaded && openThreadId && (
        <ThreadPaneHost
          key={openThreadId}
          threadId={openThreadId}
          agentSlug={slug}
          tabId={tabId}
          paneWidthPct={paneWidthPct}
          containerRef={tabRowRef}
          resizable={expanded}
          onWidthCommit={setPaneWidthPct}
          onClose={() => setOpenThreadId(null)}
        />
      )}

      {}
      <ArtifactPaneHost containerRef={tabRowRef} resizable={expanded} />
    </div>
    </ArtifactPreviewProvider>
  );
}

function ArtifactPaneHost({
  containerRef,
  resizable,
}: {
  containerRef: React.RefObject<HTMLElement | null>;
  resizable: boolean;
}) {
  const { open, close } = useArtifactPreview();
  if (!open) return null;
  return (
    <ArtifactPane
      key={open.artifact.id}
      artifact={open.artifact}
      onClose={() => {
        if (open.report) dismissReport(open.artifact.id);
        close();
      }}
      onDownload={open.onDownload}
      report={open.report}
      autoOpened={open.autoOpened}
      resizable={resizable}
      containerRef={containerRef}
    />
  );
}

const VIEW_MODE_ICON: Record<WorkspaceViewMode, { viewBox: string; path: string }> = {
  chat: {
    viewBox: "0 0 14.333 14.3335",
    path: "M13.228 6.04345C13.4793 5.93014 13.7758 6.04255 13.8892 6.29443C14.1252 6.81776 14.2673 7.38841 14.312 7.98974V7.99658C14.34 8.45373 14.34 8.93279 14.312 9.3833C14.2607 10.1693 13.9607 10.9661 13.394 11.8208C13.2455 12.1008 13.445 12.5543 13.5796 12.8022L13.5894 12.8188C13.814 13.2435 13.9911 13.5792 13.7798 13.9438C13.5631 14.3178 13.1635 14.3262 12.7769 14.3335C12.7516 14.3335 12.726 14.3335 12.7007 14.3335C12.0515 14.3334 11.4979 14.1626 11.0093 13.812C10.9567 13.7734 10.9041 13.7362 10.8608 13.7056C10.7822 13.7355 10.6855 13.7754 10.6382 13.7954C10.3643 13.9093 10.0305 13.9869 9.69873 14.0122H9.69092C8.91575 14.0595 8.09257 14.0595 7.31006 14.0122C6.27073 13.9402 5.33083 13.5609 4.51416 12.8843C4.30166 12.7082 4.27278 12.3928 4.44873 12.1802C4.62475 11.9678 4.9393 11.9389 5.15186 12.1147C5.80386 12.6547 6.55185 12.9575 7.37452 13.0142C8.11107 13.0595 8.89094 13.0595 9.62549 13.0142C9.84944 12.9968 10.0791 12.9449 10.2544 12.8716C10.6062 12.7256 10.7842 12.6567 10.9761 12.6753C10.9894 12.6766 11.0038 12.6785 11.0171 12.6811C11.203 12.7152 11.3427 12.8175 11.5952 13.0034C11.9079 13.2274 12.262 13.3335 12.7007 13.3335H12.73C12.7214 13.3176 12.7132 13.3019 12.7046 13.2866L12.6978 13.2739C12.1791 12.3173 12.3214 11.6774 12.5327 11.3101C12.538 11.3008 12.5444 11.2919 12.5503 11.2827C13.0242 10.5722 13.2739 9.93 13.314 9.3208C13.3393 8.91355 13.3393 8.47664 13.314 8.06005C13.278 7.57693 13.1652 7.12075 12.978 6.70556C12.8647 6.4536 12.9761 6.15683 13.228 6.04345ZM4.90088 0.0415C5.74088 -0.0138333 6.59244 -0.0138333 7.43311 0.0415C10.0384 0.210205 12.136 2.31596 12.312 4.93994C12.34 5.42914 12.34 5.93765 12.312 6.41552C12.136 9.04006 10.0392 11.1495 7.43409 11.3257H7.43213C6.59222 11.3803 5.73982 11.3803 4.89991 11.3257C4.55539 11.3003 4.2027 11.2185 3.90284 11.0952C3.82224 11.0612 3.72509 11.0206 3.65186 10.9927C3.61386 11.0193 3.56855 11.0528 3.52588 11.0835L3.48389 11.1128C2.97327 11.4894 2.40389 11.6675 1.70264 11.6675H1.62354C1.20836 11.6595 0.815963 11.6522 0.591312 11.2778C0.589312 11.2745 0.586786 11.2714 0.585453 11.2681C0.36713 10.8849 0.557422 10.5345 0.79932 10.0913C0.974585 9.75677 1.14738 9.29951 0.991703 8.99951C0.396461 8.10164 0.0790703 7.25792 0.021 6.42138C-0.007 5.93805 -0.007 5.42882 0.021 4.94482C0.197751 2.3163 2.29569 0.210911 4.90088 0.0415ZM7.36768 1.04052C6.57035 0.988523 5.76231 0.987857 4.96631 1.04052C2.85904 1.17723 1.16241 2.88302 1.01905 5.0083C0.993716 5.45025 0.993721 5.91892 1.01905 6.35888C1.06437 7.01678 1.3316 7.70751 1.83545 8.46338C1.8421 8.47401 1.849 8.48496 1.85498 8.4956C2.16826 9.05151 2.10994 9.74623 1.68213 10.5601C1.68082 10.562 1.6789 10.5649 1.67823 10.5669C1.66089 10.5989 1.64221 10.6335 1.62354 10.6675H1.64209C2.156 10.6755 2.54272 10.5641 2.896 10.3042L2.9419 10.272C3.17923 10.1013 3.32669 9.99616 3.52002 9.97216C3.73259 9.94093 3.9221 10.0201 4.28662 10.1733C4.4851 10.2545 4.73485 10.3112 4.96924 10.3286C5.76191 10.3806 6.57004 10.3806 7.3667 10.3286C9.47455 10.1858 11.1713 8.47722 11.314 6.354C11.3393 5.9182 11.3393 5.44987 11.314 5.00341C11.1713 2.88275 9.47501 1.17719 7.36768 1.04052ZM8.16651 6.6665C8.44251 6.6665 8.66651 6.8905 8.66651 7.1665C8.66635 7.44237 8.44241 7.6665 8.16651 7.6665H4.16651C3.89071 7.66637 3.66666 7.44229 3.66651 7.1665C3.66651 6.89058 3.89062 6.66663 4.16651 6.6665H8.16651ZM6.16651 3.99951C6.4425 3.99951 6.66649 4.22352 6.66651 4.49951C6.66651 4.77551 6.44251 4.99951 6.16651 4.99951H4.16651C3.89062 4.99938 3.66651 4.77543 3.66651 4.49951C3.66653 4.2236 3.89063 3.99964 4.16651 3.99951H6.16651Z",
  },
  threaded: {
    viewBox: "0 0 13 10.334",
    path: "M1.83301 9.33398C2.10915 9.33398 2.33301 9.55784 2.33301 9.83398C2.33283 10.11 2.10904 10.334 1.83301 10.334H0.5C0.223966 10.334 0.00017564 10.11 0 9.83398C2.22841e-08 9.55784 0.223858 9.33398 0.5 9.33398H1.83301ZM12.5 9.33398C12.7761 9.33398 13 9.55784 13 9.83398C12.9998 10.11 12.776 10.334 12.5 10.334H4.5C4.22397 10.334 4.00018 10.11 4 9.83398C4 9.55784 4.22386 9.33398 4.5 9.33398H12.5ZM1.83301 4.66699C2.10915 4.66699 2.33301 4.89085 2.33301 5.16699C2.33301 5.44313 2.10915 5.66699 1.83301 5.66699H0.5C0.223858 5.66699 -2.22841e-08 5.44313 0 5.16699C3.03374e-08 4.89085 0.223858 4.66699 0.5 4.66699H1.83301ZM12.5 4.66699C12.7761 4.66699 13 4.89085 13 5.16699C13 5.44313 12.7761 5.66699 12.5 5.66699H4.5C4.22386 5.66699 4 5.44313 4 5.16699C4 4.89085 4.22386 4.66699 4.5 4.66699H12.5ZM1.83301 0C2.10904 2.59879e-08 2.33283 0.224007 2.33301 0.5C2.33301 0.776142 2.10915 1 1.83301 1H0.5C0.223858 1 -2.24168e-08 0.776142 0 0.5C0.000175894 0.224007 0.223966 -2.59879e-08 0.5 0H1.83301ZM12.5 0C12.776 2.61426e-08 12.9998 0.224008 13 0.5C13 0.776142 12.7761 1 12.5 1H4.5C4.22386 1 4 0.776142 4 0.5C4.00018 0.224007 4.22397 -1.80811e-08 4.5 0H12.5Z",
  },
};

const VIEW_MODE_LABEL: Record<WorkspaceViewMode, string> = {
  chat: "Chat view",
  threaded: "Threaded view",
};

export function ViewModeToggle({
  mode,
  onChange,
}: {
  mode: WorkspaceViewMode;
  onChange: (mode: WorkspaceViewMode) => void;
}) {
  return (
    <div className="flex h-14 shrink-0 items-center">
      <div
        role="group"
        aria-label="Conversation view"
        className={`inline-flex items-center gap-1 rounded-full border border-rule bg-cream p-1 ${HEADER_CARD_SHADOW}`}
      >
        {(["chat", "threaded"] as const).map((m) => {
          const isActive = mode === m;
          return (
            <Tooltip key={m} label={VIEW_MODE_LABEL[m]} side="bottom">
              <button
                type="button"
                aria-label={VIEW_MODE_LABEL[m]}
                aria-pressed={isActive}
                onClick={() => onChange(m)}
                className={`inline-flex size-6 items-center justify-center rounded-full transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/20 motion-reduce:transition-none ${
                  isActive
                    ? "bg-bone text-ink"
                    : "text-inkLight hover:bg-creamDeep hover:text-ink"
                }`}
              >
                <svg
                  aria-hidden
                  viewBox={VIEW_MODE_ICON[m].viewBox}
                  fill="currentColor"
                  className="size-4"
                >
                  <path d={VIEW_MODE_ICON[m].path} />
                </svg>
              </button>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
}

function ThreadPaneHost({
  threadId,
  agentSlug,
  tabId,
  paneWidthPct,
  containerRef,
  onWidthCommit,
  onClose,
  resizable,
}: {
  threadId: string;
  agentSlug: string;
  tabId: string;
  paneWidthPct: number;
  resizable?: boolean;
  containerRef: React.RefObject<HTMLElement | null>;
  onWidthCommit: (pct: number) => void;
  onClose: () => void;
}) {
  const chat = useChatThread(agentSlug, threadId);
  const { send, inflight } = useAgentRun();

  const rootRow = chat.rows[0] ?? null;
  const replies = useMemo(() => chat.rows.slice(1), [chat.rows]);

  const onSendReply = useCallback(
    async (text: string) => {
      const result = await send(agentSlug, text, threadId);
      if (result) void chat.refetch();
    },
    [send, agentSlug, threadId, chat],
  );

  const showLoading = chat.loading && !rootRow;
  const errorMsg =
    chat.errorMsg ??
    (!chat.loading && !rootRow ? "This conversation couldn't be loaded." : null);

  return (
    <ThreadPane
      threadId={threadId}
      agentSlug={agentSlug}
      rootRow={rootRow ?? EMPTY_ROW}
      replies={replies}
      loading={showLoading}
      errorMsg={errorMsg}
      onClose={onClose}
      initialWidthPct={paneWidthPct}
      containerRef={containerRef}
      onWidthCommit={onWidthCommit}
      resizable={resizable}
      onSendReply={onSendReply}
      sendingReply={inflight}
      composer={
        <Composer
          agentSlug={agentSlug}
          tabId={tabId}
          threadId={threadId}
          placeholder="Reply…"
          ariaLabel={`Reply in this ${agentDisplayName(agentSlug)} thread`}
          hideStarterChips
          ignoreTabSeeds
          onSent={() => void chat.refetch()}
          onNonRunHandled={() => void chat.refetch()}
          onSystem={chat.appendOptimisticSystem}
        />
      }
    />
  );
}

const EMPTY_ROW: ChatRow = {
  id: "",
  kind: "chat_user",
  agent_run_id: null,
  body: null,
  citations: [],
  created_at: "",
};

function ScrollPane({
  children,
  wide,
}: {
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-cream focus:outline-none focus-visible:outline-none focus-visible:ring-0">
      <div className={`mx-auto px-6 py-6 ${wide ? "max-w-7xl" : "max-w-3xl"}`}>
        {children}
      </div>
    </div>
  );
}

const TAB_ICON: Record<InnerTab, { viewBox: string; path: string }> = {
  preview: {
    viewBox: "0 0 24 24",
    path: "M4 3h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-5v2h2a1 1 0 1 1 0 2H7a1 1 0 1 1 0-2h2v-2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z",
  },
  dashboard: {
    viewBox: "0 0 17.916 16.25",
    path: "M16.9209 6.66699C17.389 6.66699 17.6231 6.66715 17.7695 6.81348C17.9157 6.95984 17.9157 7.19313 17.916 7.65918V8.1582C17.916 9.66735 17.9166 10.8444 17.8291 11.7783C17.7402 12.7265 17.556 13.4935 17.1436 14.1563C16.856 14.6182 16.4965 15.0237 16.0791 15.3525C15.4699 15.8324 14.7588 16.0478 13.8936 16.1504C13.0525 16.2501 11.9971 16.25 10.665 16.25H7.25098C5.91896 16.25 4.86349 16.2501 4.02246 16.1504C3.15721 16.0478 2.44613 15.8324 1.83691 15.3525C1.41951 15.0237 1.05999 14.6182 0.772461 14.1563C0.359974 13.4935 0.175772 12.7265 0.0869143 11.7783C-0.000585755 10.8444 -4.02694e-06 9.66735 2.87402e-07 8.1582V7.65918C0.000268812 7.19313 0.000341301 6.95984 0.146485 6.81348C0.292891 6.66715 0.527051 6.66699 0.995117 6.66699H16.9209ZM10.666 2.01206e-07C11.998 -8.79548e-06 13.0535 -0.000119061 13.8945 0.0996096C14.7597 0.202223 15.4709 0.417597 16.0801 0.897461C16.4974 1.22631 16.857 1.63185 17.1445 2.09375C17.557 2.75645 17.7402 3.52355 17.8291 4.47168C17.865 4.85529 17.8835 5.04738 17.7842 5.19531C17.7577 5.2347 17.7223 5.27365 17.6855 5.30371C17.5475 5.4164 17.345 5.41699 16.9414 5.41699H0.975586C0.572018 5.41699 0.370441 5.41638 0.232422 5.30371C0.195566 5.27362 0.159335 5.23482 0.132813 5.19531C0.0336755 5.04741 0.0519634 4.85513 0.0878909 4.47168C0.176739 3.52362 0.36008 2.75642 0.772461 2.09375C1.06003 1.63172 1.42039 1.22636 1.83789 0.897461C2.44711 0.417559 3.15818 0.202214 4.02344 0.0996096C4.86444 -8.28851e-05 5.92006 -8.79544e-06 7.25195 2.01206e-07H10.666ZM3.95801 2.08301C3.61294 2.08301 3.33318 2.36298 3.33301 2.70801C3.33301 3.05319 3.61283 3.33301 3.95801 3.33301H4.79102C5.13619 3.33301 5.41602 3.05319 5.41602 2.70801C5.41584 2.36298 5.13609 2.08301 4.79102 2.08301H3.95801ZM7.29102 2.08301C6.9461 2.08318 6.66619 2.36309 6.66602 2.70801C6.66602 3.05308 6.94599 3.33283 7.29102 3.33301H8.125C8.47003 3.33283 8.75 3.05308 8.75 2.70801C8.74983 2.36309 8.46992 2.08318 8.125 2.08301H7.29102Z",
  },
  schedule: {
    viewBox: "0 0 17.916 17.9164",
    path: "M8.95801 0C13.9056 1.12752e-07 17.916 4.01046 17.916 8.95801C17.916 9.57077 17.8549 10.1698 17.7373 10.749C17.6686 11.0873 17.3383 11.306 17 11.2373C16.6619 11.1685 16.4431 10.8382 16.5117 10.5C16.6127 10.0023 16.666 9.4867 16.666 8.95801C16.666 4.70081 13.2152 1.25 8.95801 1.25C4.70081 1.25 1.25 4.70081 1.25 8.95801C1.25 13.2152 4.70081 16.666 8.95801 16.666C9.2255 16.666 9.48989 16.6525 9.75 16.626C10.0932 16.5912 10.3995 16.8413 10.4346 17.1846C10.4696 17.5278 10.2201 17.8349 9.87695 17.8701C9.5748 17.9009 9.2679 17.916 8.95801 17.916C4.01046 17.916 1.12749e-07 13.9056 0 8.95801C0 4.01046 4.01046 0 8.95801 0ZM12.7783 10.835C12.975 10.8475 13.1675 10.9088 13.3369 10.9756C13.6653 11.1051 14.0848 11.3323 14.5762 11.5977C14.5887 11.6044 14.6017 11.6114 14.6143 11.6182L15.543 12.1191C15.5584 12.1275 15.5735 12.1363 15.5889 12.1445C16.2311 12.4913 16.7783 12.7863 17.1582 13.0752C17.5569 13.3784 17.916 13.7827 17.916 14.375C17.9159 14.967 17.5568 15.3707 17.1582 15.6738C16.7783 15.9627 16.2311 16.2587 15.5889 16.6055C15.5737 16.6137 15.5583 16.6216 15.543 16.6299L14.5762 17.1523C14.0849 17.4177 13.6652 17.6439 13.3369 17.7734C13.1675 17.8403 12.975 17.9015 12.7783 17.9141C12.5663 17.9276 12.3165 17.8851 12.0996 17.708C11.753 17.425 11.6552 17.0361 11.667 16.7012C11.6781 16.3866 11.7835 16.0781 11.8916 15.8281C12.0032 15.5703 12.1417 15.3233 12.2588 15.123C12.3063 15.0418 12.3465 14.9724 12.3818 14.9131C12.4432 14.8103 12.4876 14.7361 12.5186 14.6758C12.6207 14.4769 12.628 14.4036 12.6279 14.373C12.6278 14.3418 12.6194 14.2697 12.5186 14.0732C12.4876 14.0129 12.4431 13.9386 12.3818 13.8359C12.3465 13.7768 12.3061 13.7079 12.2588 13.627C12.1417 13.4266 12.0032 13.1789 11.8916 12.9209C11.7835 12.6709 11.6781 12.3624 11.667 12.0479C11.6553 11.713 11.7531 11.324 12.0996 11.041C12.3164 10.864 12.5663 10.8214 12.7783 10.835ZM12.9453 12.166C12.9648 12.2375 12.9954 12.3238 13.0391 12.4248C13.1201 12.612 13.2278 12.8077 13.3379 12.9961C13.3659 13.0441 13.3959 13.0957 13.4268 13.1475C13.503 13.2754 13.5816 13.4069 13.6309 13.5029C13.7647 13.7636 13.8768 14.0451 13.8779 14.3691C13.8789 14.6938 13.7682 14.9786 13.6309 15.2461C13.5816 15.3421 13.503 15.4746 13.4268 15.6025C13.3959 15.6543 13.3659 15.7059 13.3379 15.7539C13.2278 15.9422 13.12 16.1371 13.0391 16.3242C12.9955 16.425 12.9648 16.5116 12.9453 16.583C13.1903 16.4786 13.5276 16.2974 14.0205 16.0312L14.9492 15.5303C15.6505 15.1516 16.1086 14.9013 16.4014 14.6787C16.6725 14.4725 16.667 14.3902 16.666 14.376V14.373C16.667 14.3585 16.6718 14.276 16.4014 14.0703C16.1086 13.8477 15.6504 13.5974 14.9492 13.2188L14.0205 12.7178C13.5275 12.4515 13.1903 12.2704 12.9453 12.166ZM8.95801 5C9.30319 5 9.58301 5.27982 9.58301 5.625V8.69922L10.6504 9.76562C10.8945 10.0097 10.8945 10.4063 10.6504 10.6504C10.4063 10.8945 10.0097 10.8945 9.76562 10.6504L8.51562 9.40039C8.39841 9.28318 8.33301 9.12377 8.33301 8.95801V5.625C8.33301 5.27982 8.61283 5 8.95801 5Z",
  },
  feedback: {
    viewBox: "0 0 17.9199 17.9328",
    path: "M13.6455 7.51621H13.9287C15.6285 7.51621 16.5619 7.5167 17.2285 8.15C17.92 8.79998 17.9199 9.69168 17.9199 11.3082V11.8326C17.9199 12.666 17.9202 13.1335 17.7285 13.6002C17.5452 14.0667 17.2199 14.4167 16.6367 15.0416L14.3613 17.483C14.2781 17.5746 14.2369 17.6167 14.1953 17.65C13.7037 18.0667 12.9533 18.0166 12.5283 17.5416C12.5033 17.5166 12.47 17.4663 12.4033 17.3746C12.3036 17.2333 12.2618 17.175 12.2285 17.1168C11.8368 16.4918 11.7283 15.766 11.9033 15.066C11.92 14.9912 11.9448 14.9245 11.9863 14.7916L12.1367 14.3248C12.17 14.2249 12.2035 14.1249 12.2285 14.0416H11.6367C10.062 14.0416 9.20373 14.0414 8.67871 13.4C8.61204 13.325 8.56172 13.2411 8.51172 13.1578C8.09528 12.4246 8.45357 11.6581 9.12012 10.275C9.69505 9.07514 10.0035 8.4168 10.6533 7.9918C10.7116 7.95017 10.7781 7.90792 10.8447 7.87461C11.5114 7.49961 12.2705 7.49961 13.6455 7.49961V7.51621ZM13.6367 8.76621C12.437 8.76621 11.8287 8.76648 11.4453 8.98301C11.4121 8.99962 11.3702 9.02449 11.3369 9.04941C10.9869 9.27441 10.7618 9.73314 10.2451 10.8248C9.8785 11.5997 9.49487 12.3831 9.59473 12.5582C9.78639 12.7999 10.6451 12.7994 11.6367 12.7994H11.8613C12.3613 12.7994 12.6702 12.8002 12.9619 12.9752C13.2034 13.1252 13.3781 13.3503 13.4697 13.6168C13.5779 13.9583 13.4785 14.2582 13.3369 14.7164L13.1865 15.1832C13.1533 15.2913 13.1368 15.3413 13.1201 15.3912C13.0285 15.7494 13.0868 16.1327 13.2949 16.4576C13.3199 16.4993 13.3538 16.5413 13.4121 16.6246L13.4697 16.7037V16.6334L15.7285 14.191C16.2617 13.6246 16.4787 13.3828 16.5703 13.1412C16.6619 12.8996 16.6699 12.5907 16.6699 11.8326V11.3082C16.6699 9.94165 16.6617 9.32491 16.3701 9.0582C16.0535 8.76654 15.2949 8.76621 13.9199 8.76621H13.6367ZM3.72461 0.282812C4.21628 -0.133854 4.9666 -0.0837893 5.3916 0.391211C5.41656 0.41622 5.45017 0.465871 5.5166 0.557226C5.61656 0.698839 5.65808 0.757704 5.69141 0.816015C6.08305 1.44098 6.19156 2.16585 6.0166 2.86582C5.99993 2.94082 5.97526 3.00788 5.93359 3.14121L5.7832 3.60801C5.74991 3.70787 5.71637 3.80799 5.69141 3.89121H6.2832C7.8582 3.89121 8.71719 3.89115 9.24219 4.53281C9.30863 4.60765 9.35833 4.6909 9.4082 4.77402C9.82487 5.50736 9.46647 6.27448 8.7998 7.65781C8.22488 8.85766 7.91656 9.51604 7.2666 9.94102C7.20838 9.9826 7.14173 10.0239 7.0752 10.0572C6.40859 10.4322 5.65015 10.4322 4.27539 10.4322V10.4156H3.99121C2.2915 10.4156 1.35801 10.4161 0.691406 9.78281C-0.000158755 9.13286 6.34392e-09 8.24102 1.08547e-09 6.62461V6.09922C3.71719e-10 5.26598 -0.000215191 4.79924 0.191406 4.33262C0.37472 3.866 0.69999 3.51608 1.2832 2.89121L3.55859 0.448828C3.64149 0.357653 3.68311 0.316058 3.72461 0.282812ZM4.4502 1.29941L2.19141 3.74082C1.65823 4.30732 1.4413 4.54902 1.34961 4.79062C1.25795 5.03228 1.25 5.34093 1.25 6.09922V6.62461C1.25 7.99104 1.25816 8.60796 1.5498 8.87461C1.86651 9.16622 2.62509 9.16562 4 9.16562H4.2832C5.48307 9.16562 6.09127 9.16542 6.47461 8.94883C6.5079 8.93218 6.5497 8.90739 6.58301 8.88242C6.93296 8.65745 7.15828 8.19938 7.6748 7.10801C8.04124 6.3335 8.42452 5.55027 8.3252 5.37461C8.13353 5.13294 7.27487 5.13242 6.2832 5.13242H6.05859C5.55859 5.13242 5.24967 5.13262 4.95801 4.95762C4.7165 4.80764 4.54184 4.58254 4.4502 4.31602C4.3419 3.97448 4.44143 3.67445 4.58301 3.21641L4.7334 2.74961C4.76673 2.64128 4.78314 2.59062 4.7998 2.54062C4.89138 2.18236 4.83328 1.79914 4.625 1.47422C4.6 1.43257 4.5671 1.39053 4.50879 1.30723L4.4502 1.22812V1.29941Z",
  },
};

const TAB_LABEL: Record<InnerTab, string> = {
  preview: "Preview",
  dashboard: "Dashboard",
  schedule: "Schedule",
  feedback: "Feedback",
};

function SegmentedTabs({
  slug,
  active,
  onChange,
}: {
  slug: string;
  active: InnerTab;
  onChange: (t: InnerTab) => void;
}) {
  const tabs: { id: InnerTab; label: string }[] = availableTabs(slug).map(
    (id) => ({ id, label: TAB_LABEL[id] }),
  );
  return (
    <nav
      aria-label="Agent views"
      className="-mb-px flex shrink-0 items-center"
      data-testid="agent-header-tabs"
    >
      {tabs.map((t) => {
        const isActive = active === t.id;
        const icon = TAB_ICON[t.id];
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onChange(t.id)}
            aria-current={isActive ? "page" : undefined}
            className={`
              relative flex h-[38px] cursor-pointer items-center justify-center gap-2 whitespace-nowrap px-2 text-[13px] leading-[20px] tracking-[0.01px] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/20 motion-reduce:transition-none
              ${
                isActive
                  ? "font-semibold text-ink"
                  : "font-medium text-inkMuted hover:text-ink"
              }
            `}
          >
            <svg
              aria-hidden
              viewBox={icon.viewBox}
              fill="currentColor"
              className="h-5 w-5 shrink-0"
            >
              <path d={icon.path} />
            </svg>
            {t.label}
            {}
            {isActive && (
              <span
                aria-hidden
                className="absolute inset-x-0 bottom-0 h-[2px] rounded-t-[2px] bg-ink"
              />
            )}
          </button>
        );
      })}
    </nav>
  );
}

function AgentHeader({
  slug,
  innerTab,
  onChangeInnerTab,
}: {
  slug: string;
  innerTab: InnerTab;
  onChangeInnerTab: (t: InnerTab) => void;
}) {
  return (
    <header
      className="flex shrink-0 flex-col justify-center gap-2 bg-cream px-6 pt-2"
      style={{ borderBottom: "1px solid #f0f0f0" }}
    >
      {}
      <div className="flex min-w-0 items-center gap-2">
        <span className="relative inline-flex shrink-0">
          <AgentAvatar slug={slug} size="sm" />
          <span className="absolute bottom-0 right-0 h-[6px] w-[6px] rounded-full border-[1.5px] border-cream bg-[#22c55e]" />
        </span>
        {}
        <span className="truncate text-[16px] font-semibold leading-6 tracking-normal text-ink">
          {agentDisplayName(slug)}
        </span>
      </div>
      <SegmentedTabs slug={slug} active={innerTab} onChange={onChangeInnerTab} />
    </header>
  );
}
