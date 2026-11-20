"use client";

import { PickedElementChip, type PickedElementView } from "@/components/workspace/website/PickedElementChip";
import type { FileRef } from "@/lib/workspace/fileRefs";
import type { BuildSuggestion } from "@/lib/workspace/useBuildSuggestions";
import { BuildSuggestionsBar } from "./BuildSuggestionsBar";
import { BUILD_CHANGE_BUSY_MESSAGE } from "@/lib/workspace/useBuildSession";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AgentAvatar } from "../../AgentAvatar";
import { ChatThread, type ThreadTimelineItem } from "../../ChatThread";
import { Composer, type ExternalRetryControl, type ExternalStopControl } from "../../Composer";
import type { RepoChipScope } from "@/lib/workspace/siteRepoChip";
import { InlineStatusRow } from "../../InlineStatusRow";
import { ThreadBar } from "../../ThreadBar";
import { LowCreditsWarning } from "../../LowCreditsWarning";
import { useChatThread } from "@/lib/workspace/useChatThread";
import { useInlineEdit } from "@/lib/workspace/useInlineEdit";
import { notifyThreadsChanged } from "../../useAgentThreads";
import { resolveInflight } from "../../chatInflight";
import { ChatExpandButton } from "../../ChatExpandButton";
import { TeamNoteStrip } from "../../chat/TeamNoteStrip";
import type { SeparatorProps } from "@/hooks/useResizablePane";

const OPERATOR_SLUG = "operator";

export const CHIP_SEND_CUE = "Press Send to make this change. Picking another suggestion replaces it.";
export const CHIP_BUSY_HINT = "One change at a time. This one will be ready to send when the current change finishes.";
export const CHIPS_LOCKED_HINT = "One change at a time. Suggestions unlock when the current change finishes.";
const PANEL_TAB_ID = "home-calm-operator-panel";

export function shouldExpandChatOnEngagement(
  autoExpandOnEngagement: boolean,
  expanded: boolean,
): boolean {
  return autoExpandOnEngagement && !expanded;
}

export function HomeChatPanel({
  greeting,
  pulse,
  suggestions,
  expanded,
  onExpandedChange,
  width,
  dragging,
  separatorProps,
  initialThreadId,
  composerSeed,
  composerSuggestions,
  composerSuggestionsLoading = false,
  onMoreSuggestions,
  composerSuggestionsLoadingMore = false,
  composerSuggestionsMoreFailed = false,
  externalStop,
  externalRetry,
  autoExpandOnEngagement = true,
  onRunCompleted,
  onBeforeSend,
  scopeChip = null,
  onRemoveScopeChip,
  onBuildSuggestionSend,
  fullWidthBelowLg = false,
  narrowHidden = false,
  side = "right",
  surface = "flush",
  showExpand = true,
  showThreadBar = true,
  title,
  narrowLeading,
  narrowTrailing,
  onThreadChange,
  prelude,
  headerActions,
  hidden = false,
  overlay,
  preludeLastAt = null,
  timelineItems,
  timelineStartAt = null,
  sendBlockedNotice = null,
  composerHints,
  buildSessionId = null,
  repoChipScope,
}: {
  greeting: string;
  pulse: React.ReactNode;
  suggestions: string[];
  initialThreadId?: string | null;
  composerSeed?: { text: string; nonce: number; files?: FileRef[] };
  composerSuggestions?: readonly BuildSuggestion[];
  composerSuggestionsLoading?: boolean;
  onMoreSuggestions?: () => void;
  composerSuggestionsLoadingMore?: boolean;
  composerSuggestionsMoreFailed?: boolean;
  composerHints?: string[];
  buildSessionId?: string | null;
  repoChipScope?: RepoChipScope;
  externalStop?: ExternalStopControl;
  externalRetry?: ExternalRetryControl;
  autoExpandOnEngagement?: boolean;
  onRunCompleted?: (runId: string) => void;
  onBeforeSend?: (message: string, imagePaths?: string[]) => Promise<{ handled: boolean; system?: string; consumed?: boolean }>;
  scopeChip?: PickedElementView | null;
  onRemoveScopeChip?: () => void;
  onBuildSuggestionSend?: (message: string) => Promise<{ handled: boolean; system?: string; consumed?: boolean }>;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  width: number;
  dragging: boolean;
  separatorProps: SeparatorProps;
  title?: React.ReactNode;
  showThreadBar?: boolean;
  showExpand?: boolean;
  side?: "left" | "right";
  surface?: "flush" | "card";
  fullWidthBelowLg?: boolean;
  narrowHidden?: boolean;
  narrowLeading?: React.ReactNode;
  narrowTrailing?: React.ReactNode;
  onThreadChange?: (threadId: string | null) => void;
  prelude?: React.ReactNode;
  headerActions?: React.ReactNode;
  hidden?: boolean;
  overlay?: React.ReactNode;
  preludeLastAt?: string | null;
  timelineItems?: readonly ThreadTimelineItem[];
  timelineStartAt?: string | null;
  sendBlockedNotice?: string | null;
}) {
  const [threadId, setThreadId] = useState<string | null | undefined>(initialThreadId);
  const onThreadChangeRef = useRef(onThreadChange);
  onThreadChangeRef.current = onThreadChange;
  useEffect(() => {
    if (typeof threadId === "undefined") return;
    const bound = threadId;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) onThreadChangeRef.current?.(bound);
    });
    return () => {
      cancelled = true;
    };
  }, [threadId]);
  useEffect(() => {
    if (initialThreadId === undefined) return;
    setThreadId((cur) => (cur === initialThreadId ? cur : initialThreadId));
  }, [initialThreadId]);
  const [pendingRunId, setPendingRunId] = useState<string | null>(null);
  const [pendingThreadId, setPendingThreadId] = useState(threadId);
  if (pendingThreadId !== threadId) {
    setPendingThreadId(threadId);
    if (typeof pendingThreadId === "string") setPendingRunId(null);
  }
  const lastOptimisticId = useRef<string | null>(null);
  const [seed, setSeed] = useState<{ text: string; nonce: number; autoSend: boolean; files?: FileRef[] } | null>(null);
  const seedCounterRef = useRef(0);
  const pendingBuildSuggestionRef = useRef<string | null>(null);
  const [chipPrompt, setChipPrompt] = useState<string | null>(null);
  const [sendInFlight, setSendInFlight] = useState(false);
  const completedRunIdsRef = useRef(new Set<string>());
  const fireSeed = useCallback((text: string, autoSend: boolean, files?: FileRef[]) => {
    seedCounterRef.current += 1;
    setSeed({ text, autoSend, nonce: seedCounterRef.current, ...(files && files.length > 0 ? { files } : {}) });
  }, []);

  useEffect(() => {
    if (!composerSeed) return;
    pendingBuildSuggestionRef.current = null;
    setChipPrompt(null);
    fireSeed(composerSeed.text, false, composerSeed.files);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composerSeed?.nonce]);

  const onThreadLoaded = useCallback((thread: { id: string }) => {
    setThreadId((cur) => (typeof cur === "string" ? cur : thread.id));
  }, []);
  const chat = useChatThread(OPERATOR_SLUG, threadId, onThreadLoaded);
  const onEditMessage = useInlineEdit(chat, OPERATOR_SLUG, threadId);
  const removeOptimisticUser = chat.removeOptimisticUser;
  const appendOptimisticSystem = chat.appendOptimisticSystem;
  const sendBlockedRef = useRef(sendBlockedNotice);
  sendBlockedRef.current = sendBlockedNotice;
  const beforeSend = useMemo(
    () =>
      onBeforeSend || onBuildSuggestionSend
        ? async (message: string, imagePaths?: string[]) => {
            if (sendBlockedRef.current) {
              if (lastOptimisticId.current) {
                removeOptimisticUser(lastOptimisticId.current);
                lastOptimisticId.current = null;
              }
              fireSeed(message, false);
              return { handled: true };
            }
            const selectedSuggestion = pendingBuildSuggestionRef.current;
            pendingBuildSuggestionRef.current = null;
            setChipPrompt(null);
            const fromChip = !imagePaths?.length && selectedSuggestion?.trim() === message.trim();
            const intercept =
              fromChip && onBuildSuggestionSend
                ? onBuildSuggestionSend
                : onBeforeSend;
            if (!intercept) return { handled: false };
            setSendInFlight(true);
            let result: Awaited<ReturnType<typeof intercept>>;
            try {
              result = imagePaths?.length && !fromChip ? await intercept(message, imagePaths) : await intercept(message);
            } finally {
              setSendInFlight(false);
            }
            if (result.handled && !result.consumed && result.system === BUILD_CHANGE_BUSY_MESSAGE) {
              if (lastOptimisticId.current) {
                removeOptimisticUser(lastOptimisticId.current);
                lastOptimisticId.current = null;
              }
              appendOptimisticSystem(BUILD_CHANGE_BUSY_MESSAGE, { persists: false });
              if (fromChip) {
                pendingBuildSuggestionRef.current = selectedSuggestion;
                setChipPrompt(message);
              }
              fireSeed(message, false);
              return { handled: true };
            }
            if (result.handled && result.consumed && lastOptimisticId.current) {
              removeOptimisticUser(lastOptimisticId.current);
              lastOptimisticId.current = null;
            }
            return result;
          }
        : undefined,
    [onBeforeSend, onBuildSuggestionSend, removeOptimisticUser, appendOptimisticSystem, fireSeed],
  );
  const changeBusy = Boolean(externalStop) || sendInFlight;
  const chipsShown = !composerSuggestionsLoading && (composerSuggestions?.length ?? 0) > 0;
  const sendBlocked = Boolean(sendBlockedNotice);
  const chipHint = sendBlocked
    ? null
    : chipPrompt
    ? changeBusy
      ? CHIP_BUSY_HINT
      : CHIP_SEND_CUE
    : changeBusy && chipsShown
      ? CHIPS_LOCKED_HINT
      : null;

  const expand = useCallback(() => {
    if (shouldExpandChatOnEngagement(autoExpandOnEngagement, expanded)) {
      onExpandedChange(true);
    }
  }, [autoExpandOnEngagement, expanded, onExpandedChange]);

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

  useEffect(() => {
    if (!pendingRunId) return;
    const replied = chat.rows.some(
      (r) => r.kind === "chat_assistant" && r.agent_run_id === pendingRunId,
    );
    if (!replied) return;
    if (!completedRunIdsRef.current.has(pendingRunId)) {
      completedRunIdsRef.current.add(pendingRunId);
      onRunCompleted?.(pendingRunId);
    }
    const id = window.setTimeout(() => setPendingRunId(null), 2000);
    return () => window.clearTimeout(id);
  }, [chat.rows, pendingRunId, onRunCompleted]);

  const onLeft = side === "left";
  const showWelcome =
    !prelude &&
    !chat.loading &&
    chat.rows.length === 0 &&
    !pendingRunId &&
    !chat.errorMsg;
  const hasPrelude = !!prelude;
  const feedRef = useRef<HTMLDivElement>(null);
  const preludeNearBottomRef = useRef(true);
  const preludePinnedRef = useRef(false);
  const preludeSettlingRef = useRef(false);

  useLayoutEffect(() => {
    if (!hasPrelude) {
      preludeNearBottomRef.current = true;
      preludePinnedRef.current = false;
      preludeSettlingRef.current = false;
      return;
    }
    const feed = feedRef.current;
    if (!feed) return;
    const onScroll = () => {
      const nearBottom =
        feed.scrollHeight - feed.scrollTop - feed.clientHeight < 100;
      preludeNearBottomRef.current = nearBottom;
      if (!nearBottom) preludeSettlingRef.current = false;
    };
    feed.addEventListener("scroll", onScroll, { passive: true });
    return () => feed.removeEventListener("scroll", onScroll);
  }, [hasPrelude]);

  useLayoutEffect(() => {
    if (!hasPrelude || !preludeLastAt) return;
    const feed = feedRef.current;
    if (!feed || feed.offsetParent === null || feed.clientHeight === 0) return;
    const firstPin = !preludePinnedRef.current;
    if (!firstPin && !preludeNearBottomRef.current) return;

    preludePinnedRef.current = true;
    preludeSettlingRef.current = firstPin;
    const deadline = performance.now() + 450;
    let frame = 0;
    const pin = () => {
      if (firstPin && !preludeSettlingRef.current) return;
      if (feed.offsetParent === null || feed.clientHeight === 0) return;
      feed.scrollTop = feed.scrollHeight;
      preludeNearBottomRef.current = true;
      if (firstPin && performance.now() < deadline) {
        frame = window.requestAnimationFrame(pin);
      } else {
        preludeSettlingRef.current = false;
      }
    };
    frame = window.requestAnimationFrame(pin);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [hasPrelude, preludeLastAt]);

  return (
    <aside
      aria-label="Chat with your team"
      className={`absolute flex-col border-[#f0f0f0] ${
        surface === "card"
          ? `build-chat-card inset-y-0 ${onLeft ? "left-0" : "right-0"} overflow-hidden rounded-2xl border-ink/[0.08] bg-white shadow-sm lg:border compact:rounded-none compact:shadow-none`
          : `inset-y-0 ${onLeft ? "left-0 border-r" : "right-0 border-l"} h-full bg-white`
      } ${
        fullWidthBelowLg
          ? `${narrowHidden ? "hidden" : "flex"} w-full max-lg:inset-x-0 max-lg:w-auto ${onLeft ? "max-lg:border-r-0" : "max-lg:border-l-0"} lg:flex lg:w-[var(--home-chat-w)]`
          : "hidden lg:flex"
      } ${dragging ? "" : "transition-[width] duration-300 ease-in-out"}${hidden ? " lg:!hidden" : ""}`}
      style={
        fullWidthBelowLg
          ? ({ "--home-chat-w": expanded ? "100%" : `${width}px` } as React.CSSProperties)
          : { width: expanded ? "100%" : width }
      }
    >
      {overlay && (
        <div className={`absolute inset-x-0 bottom-0 z-30 ${(title || headerActions) && !showThreadBar ? "top-12" : "top-0"}`}>
          {overlay}
        </div>
      )}
      {}
      {!expanded && (
        <div
          {...separatorProps}
          className={`group absolute inset-y-0 ${onLeft ? "right-0" : "left-0"} z-10 w-3 cursor-col-resize items-center justify-center focus-visible:outline-none${fullWidthBelowLg ? " hidden lg:flex" : " flex"}`}
          title="Drag to resize · double-click to reset"
        >
          <div
            className={`absolute inset-y-0 ${onLeft ? "right-0 -mr-px" : "left-0 -ml-px"} w-px transition-colors ${dragging ? "bg-[#c9a24b]" : "bg-ink/10"} group-hover:bg-[#c9a24b] group-focus-visible:bg-[#c9a24b]`}
          />
          <span
            aria-hidden
            className={`relative h-8 w-1 rounded-full transition-colors ${dragging ? "bg-[#c9a24b]" : "bg-ink/25"} group-hover:bg-[#c9a24b] group-focus-visible:bg-[#c9a24b]`}
          />
        </div>
      )}
      {}
      {}
      {}
      {(title || headerActions) && !showThreadBar && (
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-ink/10 bg-white px-2 lg:px-4">
          {fullWidthBelowLg && narrowLeading && (
            <div className="flex shrink-0 items-center gap-1 lg:hidden">{narrowLeading}</div>
          )}
          {title}
          {headerActions && (
            <div className="ml-auto flex shrink-0 items-center gap-1">{headerActions}</div>
          )}
          {fullWidthBelowLg && narrowTrailing && (
            <div
              className={`${headerActions ? "" : "ml-auto "}flex shrink-0 items-center gap-1 lg:hidden`}
            >
              {narrowTrailing}
            </div>
          )}
        </div>
      )}
      {(showThreadBar ||
        showExpand ||
        (fullWidthBelowLg &&
          (narrowLeading || narrowTrailing) &&
          !((title || headerActions) && !showThreadBar))) && (
      <div
        className={`flex shrink-0 items-stretch border-b border-[#f0f0f0] [&>div>div]:border-b-0${
          !showThreadBar && !showExpand ? " lg:hidden" : ""
        }`}
      >
        {fullWidthBelowLg && narrowLeading && (
          <div className="flex shrink-0 items-center gap-1 pl-2 lg:hidden">{narrowLeading}</div>
        )}
        {}
        {showThreadBar && (
        <div className="min-w-0 flex-1 overflow-hidden">
          <ThreadBar
            slug={OPERATOR_SLUG}
            currentThreadId={threadId}
            onSelectThread={(id) => {
              setThreadId(id);
              expand();
            }}
            onNewThread={() => setThreadId(null)}
          />
        </div>
        )}
        {}
        {showExpand && (
          <div className="flex shrink-0 items-stretch gap-2 bg-white pl-2 pr-3">
            <ChatExpandButton
              expanded={expanded}
              onExpandedChange={onExpandedChange}
            />
          </div>
        )}
        {fullWidthBelowLg && narrowTrailing && (
          <div className="ml-auto flex shrink-0 items-center gap-1 pr-2 lg:hidden">
            {narrowTrailing}
          </div>
        )}
      </div>
      )}

      {}
      <div
        ref={feedRef}
        data-testid={surface === "card" ? "build-chat-feed" : undefined}
        className={
          showWelcome
            ? "flex min-h-0 flex-1 flex-col items-center justify-end gap-6 px-6 pb-8 text-center"
            : "min-h-0 flex-1 overflow-y-auto focus:outline-none"
        }
      >
        {showWelcome ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element -- local static svg */}
            <img src="/zavi-black.svg" alt="Zavi" className="theme-logo h-[30px] w-auto" />
            <div className="flex flex-col items-center gap-3">
              <p className="text-[24px] font-bold leading-[34px] text-[#1f1f1f]">
                {greeting}
              </p>
              <p className="text-[16px] leading-5 text-[#1f1f1f]">{pulse}</p>
            </div>
          </>
        ) : (
          <>
            {prelude && (
              <div className="mx-auto max-w-[42rem] px-4 pb-3 pt-5">{prelude}</div>
            )}
            <ChatThread
              agentSlug={OPERATOR_SLUG}
              zaviFace={buildSessionId ? <AgentAvatar slug="operator" size="sm" /> : undefined}
              onEditMessage={onEditMessage}
              threadId={threadId}
              hideEmptyState={!!prelude}
              leadingDayIso={prelude ? (timelineItems ? timelineStartAt : preludeLastAt) : null}
              timelineItems={timelineItems}
              onRetry={chat.refetch}
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
            {pendingRunId && (
              <div className="mx-auto max-w-3xl px-4">
                <InlineStatusRow
                  key={pendingRunId}
                  agentSlug={OPERATOR_SLUG}
                  runId={pendingRunId}
                  headless
                  onComplete={() => {
                    const completedRunId = pendingRunId;
                    setTimeout(
                      () =>
                        setPendingRunId((cur) =>
                          cur === completedRunId ? null : cur,
                        ),
                      2000,
                    );
                    void chat.refetch();
                    notifyThreadsChanged();
                  }}
                />
              </div>
            )}
          </>
        )}
      </div>

      <LowCreditsWarning />

      {}
      <div
        className={
          surface === "card"
            ? "build-chat-composer w-full shrink-0 border-t border-rule/70 bg-white [&>div]:!bg-white"
            : "w-full shrink-0 [&>div]:!bg-white"
        }
      >
        {(composerSuggestionsLoading || (composerSuggestions?.length ?? 0) > 0) && (
          <BuildSuggestionsBar
            suggestions={composerSuggestions ?? []}
            loading={!!composerSuggestionsLoading}
            loadingMore={composerSuggestionsLoadingMore}
            moreFailed={composerSuggestionsMoreFailed}
            disabled={changeBusy || sendBlocked}
            describedBy={chipHint ? "build-chip-hint" : undefined}
            onPick={(suggestion) => {
              pendingBuildSuggestionRef.current = suggestion.prompt;
              setChipPrompt(suggestion.prompt);
              fireSeed(suggestion.prompt, false);
            }}
            onMore={onMoreSuggestions}
          />
        )}
        {chipHint && (
          <p
            id="build-chip-hint"
            role="status"
            aria-live="polite"
            className="border-b border-rule/60 bg-white px-4 py-2 text-[13px] font-medium text-inkSoft"
          >
            {chipHint}
          </p>
        )}
        {sendBlockedNotice && (
          <p
            role="status"
            data-testid="build-publish-blocks-changes"
            className="border-b border-rule/60 bg-white px-4 py-2 text-[13px] font-medium text-inkSoft"
          >
            {sendBlockedNotice}
          </p>
        )}
        {scopeChip && (
          <div
            data-testid="composer-scope-chip"
            className="flex items-center gap-2 border-b border-rule/60 bg-white px-4 py-2"
          >
            <span className="shrink-0 text-[12px] font-medium text-inkMuted">Changing</span>
            <PickedElementChip pick={scopeChip} onRemove={onRemoveScopeChip} className="min-w-0" />
          </div>
        )}
        {}
        <TeamNoteStrip
          threadId={threadId ?? null}
          teamNote={chat.offeredTeamNote}
          turnKey={chat.teamNoteTurnKey}
          replying={!!chat.activeRunId || !!pendingRunId}
          visible={!hidden}
        />
        <Composer
          agentSlug={OPERATOR_SLUG}
          tabId={PANEL_TAB_ID}
          threadId={threadId}
          latestRunId={latestRunId}
          stopRunId={stopRunId}
          onStopRun={handleStopRun}
          externalStop={externalStop}
          externalRetry={externalRetry}
          onSent={(runId) => {
            setPendingRunId(runId);
            expand();
          }}
          onNonRunHandled={() => {
            void chat.refetch();
          }}
          onOptimistic={(text, attachments) => {
            expand();
            const id = chat.appendOptimisticUser(text, attachments);
            lastOptimisticId.current = id ?? null;
            return id;
          }}
          onSystem={chat.appendOptimisticSystem}
          onThreadBound={setThreadId}
          seed={seed ?? undefined}
          onBeforeSend={beforeSend}
          beforeSendTakesImages={!!onBeforeSend}
          buildSessionId={buildSessionId}
          hideStarterChips
          placeholderHints={composerHints}
          repoChipScope={repoChipScope}
          disabled={sendBlocked}
        />
      </div>

      {}
      <div
        className={
          showWelcome
            ? "flex min-h-0 flex-1 flex-col items-center px-6 pt-1"
            : "hidden"
        }
      >
        <div
          className={`flex items-center justify-center gap-3 ${
            expanded ? "flex-row flex-wrap" : "flex-col"
          }`}
        >
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => fireSeed(s, true)}
              className="rounded-full border border-[#d9d9d9] px-3.5 py-2 text-[12px] font-medium text-[#0e0f11] transition-colors hover:border-ink/40 hover:bg-[#f9f9f9]"
            >
              {s}
            </button>
          ))}
        </div>
      </div>
    </aside>
  );
}
