"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  Maximize2,
  MessageSquare,
  Minimize2,
  PanelRightClose,
  PanelRightOpen,
  X,
} from "lucide-react";
import { useResizablePane } from "@/hooks/useResizablePane";
import { useIsCompact } from "@/lib/responsive";
import { useChatThread } from "@/lib/workspace/useChatThread";
import { useInlineEdit } from "@/lib/workspace/useInlineEdit";
import { ChatThread } from "../ChatThread";
import { SideChatTypeContext } from "../sideChatType";
import { Composer } from "../Composer";
import { CreditWallNotice, type CreditWall } from "../CreditWallNotice";
import { InlineStatusRow } from "../InlineStatusRow";
import { LowCreditsWarning } from "../LowCreditsWarning";
import { notifyThreadsChanged } from "../useAgentThreads";
import { resolveInflight } from "../chatInflight";
import { apiFetch } from "@/lib/api";
import { useStoredFlag } from "../layout/workspacePrefs";
import { cx, FOCUS_RING } from "../layout/shared";
import { TeamNoteStrip } from "../chat/TeamNoteStrip";

export const SIDE_CHAT_MIN_PX = 340;
export const SIDE_CHAT_DEFAULT_PX = 460;
export const SIDE_CHAT_MAX_FRACTION = 0.55;
export const SIDE_CHAT_RAIL_PX = 48;

export const channelChatWidthKey = (channelSlug: string) => `zavi.channelChat.${channelSlug}.width`;

const falseDefault = () => false;
const NO_CHIPS: readonly string[] = [];

export function useSideChatState({
  storageKey,
  defaultOpen,
  compact: compactOverride,
}: {
  storageKey: string;
  defaultOpen: boolean;
  compact?: boolean;
}) {
  const [flag, setFlag] = useStoredFlag(storageKey, falseDefault);
  const open = defaultOpen ? !flag : flag;
  const setOpen = useCallback(
    (next: boolean) => setFlag(defaultOpen ? !next : next),
    [defaultOpen, setFlag],
  );
  const viewportCompact = useIsCompact();
  const compact = compactOverride ?? viewportCompact;
  const [compactOpen, setCompactOpen] = useState(false);
  const [everOpened, setEverOpened] = useState(false);
  const show = useCallback(() => {
    setEverOpened(true);
    if (compact) setCompactOpen(true);
    else setOpen(true);
  }, [compact, setOpen]);
  const hide = useCallback(() => {
    setEverOpened(true);
    if (compact) setCompactOpen(false);
    else setOpen(false);
  }, [compact, setOpen]);
  const reset = useCallback(() => {
    setEverOpened(false);
    setCompactOpen(false);
  }, []);
  useEffect(() => {
    if (!compact) setCompactOpen(false);
  }, [compact]);
  return {
    compact,
    open,
    compactOpen,
    mountColumn: everOpened || open,
    mountOverlay: everOpened || compactOpen,
    show,
    hide,
    reset,
  };
}

type Seed = { text: string; nonce: number; autoSend?: boolean; onStarted?: () => void };

export type SideChatProps = {
  agentSlug: string;
  tabId: string;
  thread: "fresh" | "latest";
  boundThreadId?: string | null;
  avatar: ReactNode;
  hideAvatarWhenEmpty?: boolean;
  title: string;
  contextLine?: string | null;
  contextBar?: ReactNode;
  ariaLabel: string;
  id?: string;
  open: boolean;
  onClose: () => void;
  widthKey: string;
  resizeLabel: string;
  containerRef?: RefObject<HTMLElement | null>;
  maxWidthPx?: number;
  defaultWidthPx?: number;
  fullBleed?: boolean;
  emptyStateName?: string;
  emptyState?: ReactNode;
  stickyChannels?: string[];
  channelActionId?: string;
  starterChips?: readonly string[];
  seed?: Seed;
  onBeforeSend?: (
    message: string,
    chat: { appendSystem: (text: string, opts?: { persists?: boolean }) => void },
  ) => Promise<{ handled: boolean; system?: string }>;
  optimisticPersists?: (text: string, attachments?: readonly { path: string }[]) => boolean;
  showTeamNoteStrip?: boolean;
  threadId?: string | null;
  onThreadIdChange?: (id: string | null) => void;
  resolvingThread?: boolean;
  headerActions?: ReactNode;
  escapeOwnedElsewhere?: boolean;
  pageChannel?: string;
  composerPlaceholder?: string;
  onRunFinished?: (runId: string, status: "success" | "error" | "failed" | "cancelled" | "unknown") => void;
};

export function SideChat({
  agentSlug,
  tabId,
  thread,
  boundThreadId,
  avatar,
  hideAvatarWhenEmpty = false,
  title,
  contextLine,
  contextBar,
  ariaLabel,
  id,
  open,
  onClose,
  widthKey,
  resizeLabel,
  containerRef,
  maxWidthPx,
  defaultWidthPx = SIDE_CHAT_DEFAULT_PX,
  fullBleed = false,
  emptyStateName,
  emptyState,
  stickyChannels,
  channelActionId,
  starterChips,
  seed,
  onBeforeSend,
  optimisticPersists,
  showTeamNoteStrip = true,
  threadId: controlledThreadId,
  onThreadIdChange,
  resolvingThread = false,
  headerActions,
  escapeOwnedElsewhere = false,
  pageChannel,
  composerPlaceholder,
  onRunFinished,
}: SideChatProps) {
  const onRunFinishedRef = useRef(onRunFinished);
  onRunFinishedRef.current = onRunFinished;
  const finishedRunsRef = useRef(new Set<string>());
  const repliedRunsRef = useRef(new Set<string>());
  const [ownThreadId, setOwnThreadId] = useState<string | null | undefined>(
    thread === "fresh" ? null : undefined,
  );
  const controlled = onThreadIdChange !== undefined;
  const threadId = controlled ? (controlledThreadId ?? null) : ownThreadId;
  const setThreadId = useCallback(
    (id: string | null) => {
      if (onThreadIdChange) onThreadIdChange(id);
      else setOwnThreadId(id);
    },
    [onThreadIdChange],
  );
  const [pendingRunId, setPendingRunId] = useState<string | null>(null);
  const [boundThreadId, setBoundThreadId] = useState(threadId);
  if (boundThreadId !== threadId) {
    setBoundThreadId(threadId);
    if (typeof boundThreadId === "string" && pendingRunId) setPendingRunId(null);
  }
  const [creditWall, setCreditWall] = useState<CreditWall | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const [droppedFiles, setDroppedFiles] = useState<{ files: File[]; nonce: number } | null>(
    null,
  );
  const dragDepthRef = useRef(0);
  const [expandedState, setExpandedState] = useState(false);
  if (expandedState && (!open || fullBleed)) setExpandedState(false);
  const expanded = expandedState && open && !fullBleed;

  const maxFn = useMemo(
    () => (maxWidthPx === undefined ? undefined : (container: number) => Math.min(container * SIDE_CHAT_MAX_FRACTION, maxWidthPx)),
    [maxWidthPx],
  );
  const { sizePx, dragging, startResize, separatorProps } = useResizablePane({
    anchor: "right",
    containerRef,
    storageKey: widthKey,
    min: SIDE_CHAT_MIN_PX,
    maxFraction: SIDE_CHAT_MAX_FRACTION,
    maxFn,
    defaultPx: defaultWidthPx,
    resetTo: defaultWidthPx,
    keyboard: true,
    ariaLabel: resizeLabel,
  });
  const width = Math.max(SIDE_CHAT_MIN_PX, Math.min(sizePx ?? defaultWidthPx, maxWidthPx ?? Infinity));

  const onThreadLoaded = useCallback(
    (loaded: { id: string }) => {
      if (!controlled) setOwnThreadId((cur) => cur ?? loaded.id);
    },
    [controlled],
  );
  const chat = useChatThread(agentSlug, threadId, onThreadLoaded);
  const onEditMessage = useInlineEdit(chat, agentSlug, threadId);

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
    [pendingRunId, chat],
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

  const asideRef = useRef<HTMLElement | null>(null);
  const escapeOwnedRef = useRef(escapeOwnedElsewhere);
  escapeOwnedRef.current = escapeOwnedElsewhere;
  useEffect(() => {
    if (!stopRunId && !expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (escapeOwnedRef.current) return;
      const el = asideRef.current;
      if (!el || el.hidden || el.closest('[aria-hidden="true"]')) return;
      const dialogOnScreen = Array.from(document.querySelectorAll('[aria-modal="true"]')).some(
        (d) => !d.closest('[hidden], [aria-hidden="true"]'),
      );
      if (dialogOnScreen) return;
      if (!stopRunId) {
        setExpandedState(false);
        return;
      }
      void apiFetch(`/api/agents/runs/${encodeURIComponent(stopRunId)}/cancel`, {
        method: "POST",
      }).catch(() => {});
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [stopRunId, expanded]);

  const appendSystem = chat.appendOptimisticSystem;
  const composerBeforeSend = useMemo(
    () =>
      onBeforeSend
        ? (message: string) => onBeforeSend(message, { appendSystem })
        : undefined,
    [onBeforeSend, appendSystem],
  );

  useEffect(() => {
    if (!pendingRunId) return;
    const replied = chat.rows.some(
      (r) => r.kind === "chat_assistant" && r.agent_run_id === pendingRunId,
    );
    if (!replied) return;
    if (!finishedRunsRef.current.has(pendingRunId) && !repliedRunsRef.current.has(pendingRunId)) {
      repliedRunsRef.current.add(pendingRunId);
      onRunFinishedRef.current?.(pendingRunId, "unknown");
    }
    const t = window.setTimeout(() => setPendingRunId(null), 2000);
    return () => window.clearTimeout(t);
  }, [chat.rows, pendingRunId]);

  return (
    <>
      {open && !fullBleed && !expanded && (
        <div
          {...separatorProps}
          onMouseDown={startResize}
          data-testid="side-chat-resizer"
          className={cx(
            "group relative w-px shrink-0 cursor-col-resize bg-rule",
            "after:absolute after:inset-y-0 after:-left-2 after:-right-2 after:content-['']",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/20",
          )}
        >
          <div
            aria-hidden="true"
            className={cx(
              "absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors",
              dragging ? "bg-ink/40" : "bg-transparent group-hover:bg-ink/20",
            )}
          />
        </div>
      )}
      <aside
        ref={asideRef}
        id={id}
        hidden={!open}
        aria-label={ariaLabel}
        style={open && !fullBleed && !expanded ? { width } : undefined}
        className={cx(
          "min-h-0 flex-col bg-cream",
          fullBleed ? "h-full w-full min-w-0" : expanded ? "absolute inset-0 z-30" : "shrink-0",
          open ? "flex" : "hidden",
          fullBleed || dragging ? "" : "transition-[width] duration-150",
        )}
      >
        <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-rule px-3">
          {!(hideAvatarWhenEmpty && chat.rows.length === 0 && !pendingRunId) && avatar}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[16px] font-semibold leading-5 text-ink">
              {title}
            </span>
            {contextLine && (
              <span className="block truncate text-[13px] leading-4 text-inkMuted">
                {contextLine}
              </span>
            )}
          </span>
          {headerActions}
          {!fullBleed && (
            <button
              type="button"
              onClick={() => setExpandedState((v) => !v)}
              aria-pressed={expanded}
              aria-label={expanded ? "Exit full screen" : "Full screen"}
              title={expanded ? "Exit full screen" : "Full screen"}
              className={cx(
                "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-cta text-inkLight hover:bg-bone hover:text-ink",
                FOCUS_RING,
              )}
            >
              {expanded ? (
                <Minimize2 className="h-[18px] w-[18px]" aria-hidden />
              ) : (
                <Maximize2 className="h-[18px] w-[18px]" aria-hidden />
              )}
            </button>
          )}
          {}
          <button
            type="button"
            onClick={onClose}
            aria-label={fullBleed ? "Close the chat" : "Hide the chat"}
            title={fullBleed ? "Close the chat" : "Hide the chat"}
            className={cx(
              "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-cta text-inkLight hover:bg-bone hover:text-ink",
              fullBleed && "h-10 w-10 text-ink",
              FOCUS_RING,
            )}
          >
            {fullBleed ? (
              <X className="h-5 w-5" aria-hidden />
            ) : (
              <PanelRightClose className="h-[18px] w-[18px]" aria-hidden />
            )}
          </button>
        </div>

        {contextBar}

        <div
          className="relative flex min-h-0 flex-1 flex-col"
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
            setDroppedFiles((cur) => ({ files, nonce: (cur?.nonce ?? 0) + 1 }));
          }}
        >
          {dropActive && (
            <div className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-xl border-2 border-dashed border-ink/30 bg-cream/80">
              <span className="rounded-full bg-ink px-3 py-1.5 text-[13px] font-medium text-cream">
                Drop files to attach
              </span>
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto focus:outline-none">
            {}
            <SideChatTypeContext.Provider value={!expanded}>
              <ChatThread
                agentSlug={agentSlug}
                onEditMessage={onEditMessage}
                threadId={threadId ?? null}
                onRetry={chat.refetch}
                emptyStateName={emptyStateName}
                emptyState={emptyState}
                state={{
                  rows: chat.rows,
                  activityRows: chat.activityRows,
                  activityByRun: chat.activityByRun,
                  loading: chat.loading || (resolvingThread && chat.rows.length === 0),
                  errorMsg: chat.errorMsg,
                  activeRunId: chat.activeRunId,
                  activeTrigger: chat.activeTrigger,
                  activeRunStartedAt: chat.activeRunStartedAt,
                  activeRunTurnStartedAt: chat.activeRunTurnStartedAt,
                  pendingRunId,
                }}
              />
            </SideChatTypeContext.Provider>
            {creditWall && <CreditWallNotice wall={creditWall} />}
            {pendingRunId && (
              <div className="px-3">
                <InlineStatusRow
                  key={pendingRunId}
                  agentSlug={agentSlug}
                  runId={pendingRunId}
                  headless
                  onComplete={(status) => {
                    const completedRunId = pendingRunId;
                    if (!finishedRunsRef.current.has(completedRunId)) {
                      finishedRunsRef.current.add(completedRunId);
                      onRunFinishedRef.current?.(completedRunId, status);
                    }
                    setTimeout(
                      () => setPendingRunId((cur) => (cur === completedRunId ? null : cur)),
                      2000,
                    );
                    void chat.refetch();
                    notifyThreadsChanged();
                  }}
                />
              </div>
            )}
          </div>

          <LowCreditsWarning />

          <div className={cx("w-full shrink-0", fullBleed && "compact-safe-bottom")}>
            {showTeamNoteStrip && (
              <TeamNoteStrip
                threadId={threadId ?? null}
                teamNote={chat.offeredTeamNote}
                turnKey={chat.teamNoteTurnKey}
                replying={!!chat.activeRunId || !!pendingRunId}
                visible={open}
              />
            )}
            <Composer
              agentSlug={agentSlug}
              tabId={tabId}
              threadId={threadId}
              latestRunId={latestRunId}
              stopRunId={stopRunId}
              onStopRun={handleStopRun}
              onCreditWall={setCreditWall}
              onSent={(runId) => {
                setCreditWall(null);
                setPendingRunId(runId);
              }}
              onNonRunHandled={() => {
                void chat.refetch();
              }}
              onOptimistic={(text, attachments) =>
                optimisticPersists
                  ? chat.appendOptimisticUser(text, attachments, {
                      persists: optimisticPersists(text, attachments),
                    })
                  : chat.appendOptimisticUser(text, attachments)
              }
              onSystem={chat.appendOptimisticSystem}
              onThreadBound={setThreadId}
              onBeforeSend={composerBeforeSend}
              seed={seed}
              droppedFiles={droppedFiles ?? undefined}
              stickyChannels={stickyChannels}
              channelActionId={channelActionId}
              starterChips={chat.rows.length > 0 || resolvingThread ? NO_CHIPS : starterChips}
              pageChannel={pageChannel}
              placeholder={composerPlaceholder}
            />
          </div>
        </div>
      </aside>
    </>
  );
}

export function SideChatRail({ onOpen, label }: { onOpen: () => void; label: string }) {
  return (
    <aside
      aria-label={label}
      style={{ width: SIDE_CHAT_RAIL_PX }}
      className="flex h-full shrink-0 flex-col items-center border-l border-rule bg-cream pt-3 compact:hidden"
    >
      <button
        type="button"
        onClick={onOpen}
        aria-expanded={false}
        aria-label="Show the chat"
        title="Show the chat"
        className={cx(
          "inline-flex h-8 w-8 items-center justify-center rounded-cta text-inkLight hover:bg-bone hover:text-ink",
          FOCUS_RING,
        )}
      >
        <PanelRightOpen className="h-[18px] w-[18px]" aria-hidden />
      </button>
    </aside>
  );
}

export function SideChatFab({ onOpen, label }: { onOpen: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={label}
      className={cx(
        "channel-chat-fab absolute bottom-[calc(1rem+env(safe-area-inset-bottom,0px))] right-4 z-30 inline-flex h-12 w-12 items-center justify-center rounded-full border border-inkLight bg-creamDeep text-ink shadow-menu",
        FOCUS_RING,
      )}
    >
      <MessageSquare className="h-5 w-5" aria-hidden />
    </button>
  );
}

export function SideChatOverlay({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div
      className={cx(
        "fixed inset-0 z-40 bg-cream",
        open ? "flex animate-slide-in-right motion-reduce:animate-none" : "hidden",
      )}
    >
      {children}
    </div>
  );
}
