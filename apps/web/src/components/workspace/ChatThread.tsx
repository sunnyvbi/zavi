"use client";

import { Fragment, memo, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useMemo, type ReactNode } from "react";
import { setThreadView } from "./onScreenThreads";
import { FileText, Maximize2, Paperclip } from "lucide-react";
import type { ChatRow, ArtifactRow } from "@/lib/workspace/useChatThread";
import { staffModelLabel } from "@/lib/workspace/staffModelParam";
import { ArtifactViewer } from "./artifacts/ArtifactViewer";
import { artifactRenderMode, type ArtifactRenderMode } from "./artifacts/artifactRender";
import { useArtifactPreview } from "./artifacts/artifactPreviewContext";
import type { Artifact } from "./artifacts/types";
import { apiFetch } from "@/lib/api";
import { UI_BLOCK_MIME } from "@zavi/shared";
import { UiBlockArtifact, UiBlockSkeleton } from "./UiBlockArtifact";
import { SourcesFootnote, splitSources } from "./SourcesFootnote";
import { turnCopyByRow } from "@/lib/workspace/replyCopy";
import { pendingUiBlocks } from "@/lib/workspace/pendingUiBlocks";
import { shouldShowChatDayDivider } from "@/lib/workspace/dayLabels";
import { decisionRunsOf, hideCardsWhileFiling, interleaveByTime, lastTurnRowIndex } from "@/lib/workspace/threadTimeline";
import { ChatDecisionRun } from "@/components/agents/ChatDecisionRun";
import { findScrollParent } from "@/lib/workspace/scrollParent";
import { ChatBubble } from "./ChatBubble";
import { agentDisplayName, GROWTH_OFFICER_SLUG } from "@/lib/agentRegistry";
import { useWorkspace } from "./WorkspaceShell";
import { useSetupOptional } from "./setup/SetupProvider";
import { useAgentRun } from "@/lib/workspace/useAgentRun";
import { DayDivider } from "./DayDivider";
import { PrProposalDiff } from "./PrProposalDiff";
import { EngineerLivePreview } from "./EngineerLivePreview";
import { HtmlPreviewFrame } from "./HtmlPreviewFrame";
import { PrototypeLinkChip } from "./PrototypeLinkChip";
import { SharedPagesForRun, replyLinksAPage } from "./SharedPageCard";
import { LiveAppPreview } from "./LiveAppPreview";
import { AgentSetupCard, type SetupEnvelope } from "./chat/AgentSetupCard";
import { RunActivityFeed } from "./RunActivityFeed";
import { RunNarrative } from "./RunNarrative";
import { LiveFace } from "./LiveFace";
import { HandoffStream } from "./HandoffStream";
import { looksLikeNarration, type RunPanel as RunPanelModel } from "@zavi/shared";
import { asSettledPanel } from "@/lib/workspace/runNarrative";
import { useHandoffProgress } from "@/lib/workspace/useHandoffProgress";
import { useHandoffReplyRecovery } from "@/lib/workspace/useHandoffReplyRecovery";
import { EnvelopeCard } from "./EnvelopeCard";
import { SummonedSurface } from "./SummonedSurface";
import {
  ClarifyingQuestionsCard,
  type ClarifyEnvelope,
} from "./chat/ClarifyingQuestionsCard";
import { PausedOutOfCreditsCard } from "./chat/PausedOutOfCreditsCard";
import { BuildConfirmCard } from "./chat/BuildConfirmCard";
import { RuleSuggestionCard } from "./chat/RuleSuggestionCard";
import { ConnectorRequestCard } from "./chat/ConnectorRequestCard";
import { ConnectorOfflineNotice } from "./chat/ConnectorOfflineNotice";
import { ConnectDatabaseCard } from "./actions/ConnectDatabaseCard";
import { CustomAgentDraftCard } from "./chat/CustomAgentDraftCard";
import {
  ApprovalBlock,
  type DecisionBody,
} from "@/components/agents/ApprovalBlock";
import { ProposalCard, type DispatchProposal } from "./ProposalCard";
import { SuggestionChips } from "./chat/SuggestionChips";
import { ScheduleChip } from "./chat/ScheduleChip";
import { isStreamDraftLive, resolveInflight } from "./chatInflight";
import { useRunStreamDraft } from "@/lib/workspace/useRunStreamDraft";
import { isStreamTokensEnabled } from "@/lib/workspace/streamTokensFlag";
import { streamDraftPreview } from "@/lib/workspace/streamDraftPreview";
import { ZaviMascot } from "@/components/ZaviMascot";
import { RememberedPill } from "@/components/memory/RememberedPill";
import { memoryPillRowIndexes } from "@/lib/memory/pillRows";
import { startEditingMessage, stopEditingMessage, useEditingMessage } from "@/lib/workspace/editingMessage";
import type { EditMessage } from "@/lib/workspace/useInlineEdit";
import { InlineMessageEditor } from "./InlineMessageEditor";

export type { ChatRow } from "@/lib/workspace/useChatThread";

function settledHandoffPanels(
  runIds: (string | null | undefined)[],
  byRun: Map<string, RunPanelModel>,
): RunPanelModel[] | undefined {
  const seen = new Set<string>();
  const out: RunPanelModel[] = [];
  for (const id of runIds) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const p = byRun.get(id);
    if (p) out.push(asSettledPanel(p));
  }
  return out.length > 0 ? out : undefined;
}

export type ThreadTimelineItem = { id: string; at: string; node: ReactNode; repliesToTurn?: boolean };

const NO_TIMELINE_ITEMS: readonly ThreadTimelineItem[] = [];

export type ChatThreadState = {
  rows: ChatRow[];
  activityRows: ChatRow[];
  activityByRun?: Map<string, ChatRow[]>;
  loading: boolean;
  errorMsg: string | null;
  activeRunId: string | null;
  activeTrigger: string | null;
  activeRunStartedAt: string | null;
  activeRunTurnStartedAt: string | null;
  pendingRunId: string | null;
};

const EMPTY_STATE_PROMPT: Readonly<Record<string, string>> = {
  cgo: "I read your data first, then tell you what I think is holding growth back. Start with one of these.",
};

function emptyStatePrompt(slug: string): string {
  return EMPTY_STATE_PROMPT[slug] ?? "What can I help you with?";
}

export function ChatThread({
  agentSlug,
  state,
  threadId,
  onRetry,
  hideEmptyState = false,
  leadingDayIso = null,
  timelineItems = NO_TIMELINE_ITEMS,
  emptyStateName,
  emptyState,
  onEditMessage,
  zaviFace,
}: {
  agentSlug: string;
  zaviFace?: ReactNode;
  timelineItems?: readonly ThreadTimelineItem[];
  onEditMessage?: EditMessage;
  state: ChatThreadState;
  hideEmptyState?: boolean;
  leadingDayIso?: string | null;
  emptyStateName?: string;
  emptyState?: ReactNode;
  threadId?: string | null;
  onRetry?: () => void | Promise<void>;
}) {
  const {
    rows,
    activityRows,
    activityByRun,
    loading,
    errorMsg,
    activeRunId,
    activeTrigger,
    activeRunStartedAt,
    activeRunTurnStartedAt,
    pendingRunId,
  } = state;
  const setupState = useSetupOptional()?.state;
  const strategyStatusShown =
    agentSlug === GROWTH_OFFICER_SLUG &&
    setupState?.enabled === true &&
    setupState.one_state === true &&
    setupState.done &&
    setupState.draft.status !== "none";
  const rootRef = useRef<HTMLDivElement | null>(null);
  const viewKey = useId();
  const hasBody = rows.length > 0 || timelineItems.length > 0;
  const bodyShown = hasBody && !errorMsg;
  useEffect(() => {
    if (typeof threadId !== "string") return;
    setThreadView(viewKey, { threadId, el: () => rootRef.current });
    return () => setThreadView(viewKey, null);
  }, [viewKey, threadId, bodyShown]);
  const scrollParentRef = useRef<HTMLElement | null>(null);
  const wasNearBottomRef = useRef(true);
  const didInitialPinRef = useRef(false);
  const pinnedThreadIdRef = useRef<string | null | undefined>(undefined);
  const settlingRef = useRef(false);

  const threadMounted = !loading && !errorMsg && hasBody;

  useLayoutEffect(() => {
    if (!threadMounted) return;
    const sp = findScrollParent(rootRef.current);
    scrollParentRef.current = sp;
    if (!sp) return;
    const onScroll = () => {
      const nearBottom = sp.scrollHeight - sp.scrollTop - sp.clientHeight < 100;
      wasNearBottomRef.current = nearBottom;
      if (!nearBottom) settlingRef.current = false;
    };
    sp.addEventListener("scroll", onScroll, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
      if (wasNearBottomRef.current && sp.offsetParent !== null && sp.clientHeight > 0) {
        sp.scrollTop = sp.scrollHeight;
      }
    });
    if (rootRef.current) observer?.observe(rootRef.current);
    return () => {
      sp.removeEventListener("scroll", onScroll);
      observer?.disconnect();
    };
  }, [threadMounted]);

  useLayoutEffect(() => {
    if (!threadMounted) return;
    let sp = scrollParentRef.current;
    if (!sp) {
      sp = findScrollParent(rootRef.current);
      scrollParentRef.current = sp;
    }
    if (!sp) return;
    if (sp.offsetParent === null || sp.clientHeight === 0) return;
    const spv = sp;
    const forceBottom =
      !didInitialPinRef.current || pinnedThreadIdRef.current !== threadId;
    pinnedThreadIdRef.current = threadId;
    if (forceBottom) {
      didInitialPinRef.current = true;
      settlingRef.current = true;
      const deadline = performance.now() + 450;
      const pin = () => {
        if (!settlingRef.current) return;
        if (spv.offsetParent === null || spv.clientHeight === 0) return;
        spv.scrollTop = spv.scrollHeight;
        wasNearBottomRef.current = true;
        if (performance.now() < deadline) {
          requestAnimationFrame(pin);
        } else {
          settlingRef.current = false;
        }
      };
      requestAnimationFrame(pin);
    } else if (wasNearBottomRef.current) {
      const pin = () => {
        spv.scrollTop = spv.scrollHeight;
        wasNearBottomRef.current = true;
      };
      requestAnimationFrame(() => {
        pin();
        requestAnimationFrame(pin);
      });
    }
  }, [
    threadMounted,
    loading,
    rows.length,
    timelineItems.length,
    activityRows.length,
    activeRunId,
    threadId,
  ]);

  const { show: showInflight, runId: displayedInflightRunId } = resolveInflight(
    {
      activeRunId,
      activeTrigger,
      pendingRunId,
      rows,
    },
  );

  const streamFlagOn = isStreamTokensEnabled();
  const inflightRunId = displayedInflightRunId;
  const streamDraft = useRunStreamDraft(
    streamFlagOn ? inflightRunId : null,
    streamFlagOn,
  );
  const draftPreview = streamDraftPreview(streamDraft.text);

  const [queueAhead, setQueueAhead] = useState<number | null>(null);
  const [waitingOnMemory, setWaitingOnMemory] = useState(false);
  const [runClaimed, setRunClaimed] = useState(false);
  const [statusRunStartedAt, setStatusRunStartedAt] = useState<string | null>(
    null,
  );
  useEffect(() => {
    setStatusRunStartedAt(null);
    setWaitingOnMemory(false);
    setRunClaimed(false);
    if (!displayedInflightRunId) {
      setQueueAhead(null);
      return;
    }
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const res = await apiFetch(
          `/api/agents/runs/${encodeURIComponent(displayedInflightRunId)}`,
        );
        if (cancelled) return;
        if (!res.ok) {
          setStatusRunStartedAt(null);
          return;
        }
        const body = (await res.json()) as {
          run?: { status?: string; started_at?: string | null };
          queue_ahead?: number | null;
          waiting_on?: string | null;
        };
        if (cancelled) return;
        setWaitingOnMemory(
          body.run?.status === "queued" && body.waiting_on === "memory",
        );
        if (body.run?.status === "queued") {
          setQueueAhead(
            typeof body.queue_ahead === "number" ? body.queue_ahead : 0,
          );
          setStatusRunStartedAt(null);
        } else {
          setQueueAhead(null);
          setRunClaimed(true);
          setStatusRunStartedAt(
            body.run?.status === "running"
              ? (body.run?.started_at ?? null)
              : null,
          );
          if (timer !== undefined) window.clearInterval(timer);
        }
      } catch {
        if (!cancelled) setStatusRunStartedAt(null);
      }
    };
    poll();
    timer = window.setInterval(poll, 8000);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [displayedInflightRunId]);

  const draftIsLive =
    streamFlagOn &&
    showInflight &&
    draftPreview.length > 0 &&
    isStreamDraftLive({
      runId: inflightRunId,
      status: streamDraft.status,
      rows,
    });

  const draftIsNarration =
    draftIsLive && streamDraft.status !== "complete" && looksLikeNarration(draftPreview);
  const showStreamDraft = draftIsLive && !draftIsNarration;

  const [heldThought, setHeldThought] = useState("");
  useEffect(() => {
    if (draftIsNarration) setHeldThought(draftPreview);
  }, [draftIsNarration, draftPreview]);
  useEffect(() => {
    setHeldThought("");
  }, [activityRows.length, inflightRunId]);
  const liveThought = draftIsNarration ? draftPreview : showStreamDraft ? "" : heldThought;

  const handoffRuns = useHandoffProgress(threadId, rows.length);
  const handoffPanelByRun = useMemo(() => {
    const m = new Map<string, RunPanelModel>();
    for (const r of handoffRuns) m.set(r.run_id, r.panel);
    return m;
  }, [handoffRuns]);
  const repliedRunIds = useMemo(
    () => new Set(
      rows.flatMap((r) => [r.agent_run_id, ...(r.childRunIds ?? [])]).filter((x): x is string => !!x),
    ),
    [rows],
  );
  const liveHandoffs = handoffRuns.filter(
    (r) => (r.panel.state === "running" || r.status === "success") && !repliedRunIds.has(r.run_id),
  );
  const replyRecovery = useHandoffReplyRecovery(threadId, handoffRuns, repliedRunIds, onRetry);
  const handoffParents = new Set(handoffRuns.flatMap(run => run.parent_run_id ? [run.parent_run_id] : []));

  if (loading && !hasBody) {
    return (
      <div role="status" aria-label="Loading thread" className="px-4 py-4">
        <div className="mx-auto max-w-[42rem] space-y-5">
          {[0, 1].map((i) => (
            <div key={i} className="space-y-5">
              {}
              <div className="flex justify-end">
                <div
                  className={`h-9 animate-pulse rounded-[20px] bg-ink/[0.06] ${
                    i === 0 ? "w-[45%]" : "w-[32%]"
                  }`}
                />
              </div>
              {}
              <div className="flex justify-start">
                <div className="w-full space-y-2.5">
                  <div className="h-3 w-24 animate-pulse rounded bg-ink/[0.06]" />
                  <div className="h-3 w-[92%] animate-pulse rounded bg-ink/[0.06]" />
                  <div className="h-3 w-[84%] animate-pulse rounded bg-ink/[0.06]" />
                  {i === 0 && (
                    <div className="h-3 w-[58%] animate-pulse rounded bg-ink/[0.06]" />
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }
  const errorBox = errorMsg ? (
    <div className="px-4 py-6">
      <div className="rounded-md border border-rose-300 bg-rose-50 p-3 text-[13px] text-rose-900">
        Couldn&apos;t load thread: {errorMsg}
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="ml-2 font-medium underline underline-offset-2 hover:text-rose-950"
          >
            Try again
          </button>
        )}
      </div>
    </div>
  ) : null;
  if (errorBox && timelineItems.length === 0) return errorBox;
  if (!hasBody) {
    if (hideEmptyState) return null;
    if (emptyState) {
      return (
        <div className="flex h-full flex-col items-center justify-center px-4 py-12">
          {emptyState}
        </div>
      );
    }
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-4 py-12 text-center">
        {}
        {}
        {agentSlug === "operator" || agentSlug === GROWTH_OFFICER_SLUG ? (
          <ZaviMascot size={96} className="mb-1" />
        ) : null}
        {!strategyStatusShown && (
          <p className="max-w-[236px] font-display text-[20px] font-semibold leading-[25px] text-ink">
            No messages yet with {emptyStateName ?? agentDisplayName(agentSlug)}.
          </p>
        )}
        <p className="max-w-[300px] text-[16px] text-ink">
          {emptyStatePrompt(agentSlug)}
        </p>
      </div>
    );
  }

  const userPromptByRun = new Map<string, string>();
  const sentAtByRun = new Map<string, string>();
  for (const r of rows) {
    if (r.kind === "chat_user" && r.agent_run_id) {
      sentAtByRun.set(r.agent_run_id, r.created_at);
      const t = (r.body as { text?: string })?.text;
      if (typeof t === "string" && t.trim().length > 0) {
        userPromptByRun.set(r.agent_run_id, t);
      }
    }
  }

  let askRow: ChatRow | undefined;
  let latestAsk: ChatRow | undefined;
  for (let k = rows.length - 1; k >= 0; k--) {
    const r = rows[k]!;
    if (r.kind !== "chat_user") continue;
    latestAsk ??= r;
    if (displayedInflightRunId && r.agent_run_id === displayedInflightRunId) {
      askRow = r;
      break;
    }
  }
  const askText = zaviFace
    ? undefined
    : ((askRow ?? latestAsk)?.body as { text?: string } | null)?.text;

  const filingSince = askRow?.created_at ?? (latestAsk && !latestAsk.agent_run_id ? latestAsk.created_at : null);
  const shownRows = hideCardsWhileFiling(
    rows,
    showInflight && displayedInflightRunId ? { run_id: displayedInflightRunId, since: filingSince } : null,
  );

  const followedByUser: boolean[] = new Array(shownRows.length).fill(false);
  const followedByAssistant: boolean[] = new Array(shownRows.length).fill(false);
  let nextSpeaker: ChatRow["kind"] | null = null;
  let assistantAfter = false;
  for (let i = shownRows.length - 1; i >= 0; i--) {
    followedByUser[i] = nextSpeaker === "chat_user";
    followedByAssistant[i] = assistantAfter;
    const kind = shownRows[i]!.kind;
    if (kind === "chat_user" || kind === "chat_assistant") nextSpeaker = kind;
    if (kind === "chat_assistant") assistantAfter = true;
  }

  const memoryPillRows = memoryPillRowIndexes(shownRows);
  const timeline = interleaveByTime(errorBox ? [] : shownRows, timelineItems);
  const decisionRuns = decisionRunsOf(timeline);
  const lastReplyRow = lastTurnRowIndex(shownRows);
  const turnCopy = turnCopyByRow(shownRows);

  return (
    <div
      ref={rootRef}
      role="log"
      aria-live="polite"
      aria-atomic="false"
      aria-label={`${agentDisplayName(agentSlug)} thread`}
      className="px-4 py-4"
    >
      <div className="mx-auto max-w-[42rem] space-y-5">
        {timeline.map((entry, k) => {
          const run = decisionRuns.get(k);
          if (run === null) return null;
          if (run) {
            return (
              <ChatDecisionRun
                key={`decisions:${run[0]!.row.id}`}
                items={run.map(({ row: r, index: i }) => ({
                  body: r.body as DecisionBody,
                  node: (
                    <RowRenderer
                      row={r}
                      agentSlug={agentSlug}
                      threadId={threadId}
                      isLast={i === lastReplyRow}
                      followedByUserRow={followedByUser[i]}
                      followedByAssistantRow={followedByAssistant[i]}
                    />
                  ),
                }))}
              />
            );
          }
          const divider = ((entry.kind === "extra" && !entry.item.repliesToTurn) ||
            shouldShowChatDayDivider(k === 0 ? leadingDayIso ?? undefined : timeline[k - 1]!.at, entry.at)) && (
            <DayDivider iso={entry.at} withTime={entry.kind === "extra"} />
          );
          if (entry.kind === "extra") {
            return (
              <Fragment key={`timeline:${entry.item.id}`}>
                {divider}
                {entry.item.node}
              </Fragment>
            );
          }
          const { row: r, index: i } = entry;
          return (
            <Fragment key={r.id}>
              {divider}
              <RowRenderer
                row={r}
                agentSlug={agentSlug}
                threadId={threadId}
                isLast={i === lastReplyRow}
                followedByUserRow={followedByUser[i]}
                followedByAssistantRow={followedByAssistant[i]}
                runActivity={
                  r.agent_run_id ? activityByRun?.get(r.agent_run_id) : undefined
                }
                handoffRequest={!!r.agent_run_id && handoffParents.has(r.agent_run_id) && !r.childRunIds?.length && !r.fromAgentSlug}
                handoffSettled={handoffRuns.filter(run => run.parent_run_id === r.agent_run_id)
                  .every(run => repliedRunIds.has(run.run_id))}
                handoffPanels={settledHandoffPanels(
                  [r.agent_run_id, ...(r.childRunIds ?? [])],
                  handoffPanelByRun,
                )}
                originalPrompt={
                  r.agent_run_id ? userPromptByRun.get(r.agent_run_id) : undefined
                }
                sentAt={r.agent_run_id ? sentAtByRun.get(r.agent_run_id) : undefined}
                memoryPill={memoryPillRows.has(i)}
                onEditMessage={onEditMessage}
                copyMarkdown={turnCopy.get(r.id)}
              />
            </Fragment>
          );
        })}
        {errorBox}
        {!errorBox && liveHandoffs.map((h) => (
          <div key={h.run_id} className="py-1">
            <LiveFace face={zaviFace}>
              <HandoffStream run={h} recoveryExhausted={replyRecovery.exhausted} onReload={onRetry ? replyRecovery.reload : undefined} />
            </LiveFace>
          </div>
        ))}
        {!errorBox && showInflight && (
          <>
            {}
            <RunActivityFeed
              rows={activityRows}
              agentSlug={agentSlug}
              face={zaviFace}
              startedAt={
                activeRunId === displayedInflightRunId
                  ? (activeRunStartedAt ?? statusRunStartedAt)
                  : statusRunStartedAt
              }
              turnStartedAt={
                activeRunId === displayedInflightRunId
                  ? activeRunTurnStartedAt
                  : null
              }
              queueAhead={queueAhead}
              waitingOnMemory={waitingOnMemory}
              askText={askText}
              askClaimed={runClaimed}
              drafting={showStreamDraft}
              liveThought={liveThought || undefined}
            />
            {showStreamDraft && (
              <ChatBubble
                role="assistant"
                text={draftPreview}
                agentSlug={agentSlug}
                isStreaming
              />
            )}
            {}
            {pendingUiBlocks(activityRows).map((b) => (
              <div key={b.key} className="pl-3">
                <UiBlockSkeleton kind={b.kind} title={b.title} />
              </div>
            ))}
            {}
          </>
        )}
      </div>
    </div>
  );
}

const GO_DEEPER_AGENTS = new Set(["research"]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RowRendererProps = {
  row: ChatRow;
  agentSlug: string;
  threadId?: string | null;
  isLast?: boolean;
  followedByUserRow?: boolean;
  followedByAssistantRow?: boolean;
  originalPrompt?: string;
  sentAt?: string;
  variant?: "bubble" | "flat";
  runActivity?: ChatRow[];
  handoffPanels?: RunPanelModel[];
  handoffRequest?: boolean;
  handoffSettled?: boolean;
  memoryPill?: boolean;
  onEditMessage?: EditMessage;
  copyMarkdown?: string | null;
};

export const RowRenderer = memo(function RowRenderer({
  row,
  agentSlug,
  threadId,
  isLast,
  followedByUserRow,
  followedByAssistantRow,
  originalPrompt,
  sentAt,
  variant = "bubble",
  runActivity,
  handoffPanels,
  handoffRequest = false,
  handoffSettled = false,
  memoryPill = false,
  onEditMessage,
  copyMarkdown,
}: RowRendererProps) {
  const { seedComposer, openAgentTab, openTab, role, tenantId } = useWorkspace();
  const [htmlPreviewReady, setHtmlPreviewReady] = useState(false);
  const { send: sendDeeper, inflight: goDeeperBusy } = useAgentRun();
  const { send: sendAction } = useAgentRun();
  const [goDeeperError, setGoDeeperError] = useState<string | null>(null);
  const messageId = row.id.startsWith("m:") ? row.id.slice(2) : row.id;
  const editing = useEditingMessage(row.kind === "chat_user" ? messageId : null);
  if (row.kind === "chat_user") {
    const b = row.body as { text: string };
    const canEdit =
      !!onEditMessage &&
      UUID_PATTERN.test(messageId) &&
      !row.attachments?.length &&
      !followedByUserRow;
    if (canEdit && editing) {
      return (
        <InlineMessageEditor
          originalText={b.text}
          draft={editing.draft}
          error={editing.error}
          onCancel={() => stopEditingMessage(messageId)}
          onSubmit={(text) => void onEditMessage(messageId, text)}
        />
      );
    }
    const bubble = (
      <ChatBubble
        role="user"
        text={b.text}
        createdAt={row.created_at}
        variant={variant}
        attachments={row.attachments}
        runIds={row.agent_run_id ? [row.agent_run_id] : []}
        onEdit={canEdit ? () => startEditingMessage(messageId) : undefined}
      />
    );
    if (!row.viaEmail) return bubble;
    return (
      <div className="flex flex-col">
        {bubble}
        <span className={`mt-0.5 text-[11px] text-inkMuted ${variant === "flat" ? "self-start pl-11" : "self-end"}`}>
          via email
        </span>
      </div>
    );
  }
  if (row.kind === "chat_system") {
    const b = row.body as { text: string };
    return <ChatBubble role="system" text={b.text} />;
  }
  if (row.kind === "chat_assistant") {
    const b = row.body as {
      text: string;
      envelope?: unknown;
      fullReplyMarkdown?: string;
    };
    const env = b.envelope as
      | {
          envelope_kind?: string;
          pending_pr_proposal?: boolean;
          kind?: string;
          title?: string;
          summary?: string;
          html?: string;
          version?: number;
          state?: string;
          preview_id?: string;
        }
      | undefined;
    if (env?.envelope_kind === "paused_out_of_credits") {
      return (
        <PausedOutOfCreditsCard
          envelope={b.envelope}
          fallbackAgentName={agentDisplayName(agentSlug)}
        />
      );
    }
    const isSetupRequired = env?.envelope_kind === "setup_required";
    const isHtmlPreview =
      env?.kind === "html_preview" &&
      (typeof env?.html === "string" ||
        (env?.version === 2 &&
          env?.state === "html_preview_ready" &&
          typeof env?.preview_id === "string"));
    const isPendingPr = env?.pending_pr_proposal === true;
    const isResearchEnvelope =
      agentSlug === "research" &&
      !!env &&
      !isSetupRequired &&
      (env.kind === "report" || env.kind === "clarification");
    const isClarify = env?.envelope_kind === "clarifying_questions";
    const pmStatus = (env as { status?: string } | undefined)?.status;
    const isPmEnvelope =
      agentSlug === "pm" &&
      !!env &&
      !isSetupRequired &&
      !isClarify &&
      (pmStatus === "actionable" || pmStatus === "strategy_memo");
    const dispatchProposals = (
      Array.isArray(
        (env as { dispatch_proposals?: unknown } | undefined)
          ?.dispatch_proposals,
      )
        ? ((env as { dispatch_proposals: unknown[] })
            .dispatch_proposals as unknown[])
        : []
    )
      .filter(
        (p): p is DispatchProposal =>
          !!p &&
          typeof p === "object" &&
          typeof (p as DispatchProposal).agent_slug === "string" &&
          typeof (p as DispatchProposal).brief === "string" &&
          typeof (p as DispatchProposal).why === "string",
      )
      .filter((p) => p.agent_slug !== "engineer");
    const canGoDeeper =
      GO_DEEPER_AGENTS.has(agentSlug) &&
      row.pickedDepth === "light" &&
      !!originalPrompt &&
      !row.suggestions?.length;
    const onGoDeeper = canGoDeeper
      ? async () => {
          setGoDeeperError(null);
          const res = await sendDeeper(agentSlug, originalPrompt!, null, {
            depth: "deep",
          });
          if (res && res.kind === "queued") {
            await openAgentTab(agentSlug, { threadId: res.thread_id });
          } else if (!res || res.kind === "error") {
            setGoDeeperError(
              (res?.kind === "error" && res.message) ||
                "Couldn't start a deeper run.",
            );
          }
        }
      : undefined;
    const lead = splitSources(b.text);
    const full = b.fullReplyMarkdown ? splitSources(b.fullReplyMarkdown) : null;
    const replyText = lead.body;
    const fullReplyText = full ? full.body : b.fullReplyMarkdown;
    const sources = full?.sources ?? lead.sources;
    const staffLabel = staffModelLabel(row.staffModelKey, row.modelUsed);
    const compactRequest = handoffRequest && looksLikeNarration(replyText)
      && !/[?\[\]`]/.test(replyText) && !fullReplyText && !sources
      && !row.artifacts?.length && !row.suggestions?.length && !env;
    return (
      <div className="flex flex-col">
        {compactRequest ? (handoffSettled || !!runActivity?.length ? (
          <details className="my-1">
            <summary className="cursor-pointer py-1 text-[14px] leading-relaxed text-ink/75 hover:text-ink">{handoffSettled ? "Request details" : replyText}</summary>
            {handoffSettled && <p className="py-1 text-[14px] text-ink/75">{replyText}</p>}
            {runActivity && runActivity.length > 0 && <div className="mt-1 border-l border-ink/15 pl-4">
              <RunNarrative rows={runActivity} agentSlug={agentSlug} state="finished" startedAt={sentAt} endedAt={row.created_at} />
            </div>}
          </details>
        ) : <p className="my-1 py-1 text-[14px] leading-relaxed text-ink/75">{replyText}</p>) : <>
        {}
        {runActivity && runActivity.length > 0 && (
          <RunNarrative rows={runActivity} agentSlug={agentSlug} state="finished" startedAt={sentAt} endedAt={row.created_at} />
        )}
        {handoffPanels?.map((p, i) => (
          <RunNarrative key={i} model={p} agentSlug={agentSlug} compact />
        ))}
        <ChatBubble
          role="assistant"
          text={replyText}
          fullReplyMarkdown={fullReplyText}
          agentSlug={row.fromAgentSlug ?? agentSlug}
          fromAgentSlug={row.fromAgentSlug}
          viaEmail={row.viaEmail}
          trigger={row.trigger}
          createdAt={row.created_at}
          tools={row.tools ?? []}
          citations={row.citations}
          brainProvenance={row.brainProvenance ?? null}
          figureReceipts={row.figureReceipts}
          unverifiedFigures={row.unverifiedFigures}
          onAskAction={async (title) => {
            const res = await sendAction(agentSlug, title, threadId ?? null);
            return !!res && res.kind !== "error";
          }}
          onGoDeeper={onGoDeeper}
          goDeeperBusy={goDeeperBusy}
          teamNoteFlag={row.teamNoteFlag ?? null}
          copyMarkdown={copyMarkdown}
          feedbackRunId={typeof copyMarkdown === "string" && role !== "viewer" ? row.agent_run_id ?? undefined : undefined}
          runIds={[
            ...(row.agent_run_id ? [row.agent_run_id] : []),
            ...(row.childRunIds ?? []),
          ]}
          variant={variant}
        />
        </>}
        {staffLabel && <span className="mt-1 text-xs text-neutral-500">{staffLabel}</span>}
        {goDeeperError && (
          <p role="alert" className="mt-1 text-[13px] text-coral">
            {goDeeperError}
          </p>
        )}
        {memoryPill && row.agent_run_id && (
          <RememberedPill runId={row.agent_run_id} />
        )}
        {isLast && row.suggestions && row.suggestions.length > 0 && (
          <SuggestionChips
            agentSlug={agentSlug}
            threadId={threadId}
            suggestions={row.suggestions}
          />
        )}
        {}
        {row.standingOrder && (
          <ScheduleChip slug={row.fromAgentSlug ?? agentSlug} />
        )}
        {}
        {row.summonedSurface && (
          <SummonedSurface surface={row.summonedSurface} />
        )}
        {row.customAgentCard && (
          <CustomAgentDraftCard card={row.customAgentCard} originRunId={row.agent_run_id ?? null} />
        )}
        {row.buildConfirm && (
          <BuildConfirmCard card={row.buildConfirm} threadId={threadId} />
        )}
        {row.ruleSuggestion && <RuleSuggestionCard card={row.ruleSuggestion} />}
        {row.connectorOffline && (
          <ConnectorOfflineNotice info={row.connectorOffline} agentSlug={agentSlug || null} isLast={!!isLast} />
        )}
        {row.dbNotConnected && !row.connectorOffline && <ConnectDatabaseCard />}
        {row.connectorRequest && (
          <ConnectorRequestCard
            request={row.connectorRequest}
            companyId={tenantId}
            threadId={threadId}
            followedByAssistantRow={followedByAssistantRow}
          />
        )}
        {isSetupRequired && agentSlug && (
          <AgentSetupCard
            agentSlug={agentSlug}
            envelope={b.envelope as SetupEnvelope}
          />
        )}
        {isPendingPr && <PrProposalDiff envelope={b.envelope} />}
        {}
        {isPendingPr && agentSlug === "engineer" && row.agent_run_id && (
          <EngineerLivePreview runId={row.agent_run_id} />
        )}
        {isHtmlPreview && (
          <div className="flex flex-col">
            <HtmlPreviewFrame
              title={env?.title ?? "Proposed design"}
              summary={env?.summary ?? ""}
              html={env?.html}
              previewId={env?.preview_id}
              onReadyChange={setHtmlPreviewReady}
            />
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() =>
                  seedComposer({ agentSlug, text: "build it", autoSend: true })
                }
                disabled={!htmlPreviewReady}
                className="inline-flex items-center rounded-cta bg-ink px-3 py-1.5 text-xs font-medium text-cream hover:bg-inkSoft"
              >
                Looks good, build it
              </button>
              <button
                type="button"
                onClick={() =>
                  seedComposer({
                    agentSlug,
                    text: "",
                    placeholderHint: "Describe what to change…",
                  })
                }
                className="inline-flex items-center rounded-cta border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
              >
                Change&hellip;
              </button>
              {}
              {row.agent_run_id && (
                <PrototypeLinkChip runId={row.agent_run_id} />
              )}
            </div>
          </div>
        )}
        {isClarify && (
          <ClarifyingQuestionsCard
            envelope={b.envelope as ClarifyEnvelope}
            agentSlug={agentSlug}
            threadId={threadId}
          />
        )}
        {isResearchEnvelope && (
          <div className="mt-1 rounded-lg border border-ink/10 bg-white/70 p-4">
            <EnvelopeCard agentSlug={agentSlug} envelope={b.envelope} />
          </div>
        )}
        {isPmEnvelope && (
          <div className="mt-1 rounded-lg border border-ink/10 bg-white/70 p-4">
            <EnvelopeCard agentSlug={agentSlug} envelope={b.envelope} />
          </div>
        )}
        {dispatchProposals.length > 0 && (
          <div className="mt-1.5 flex flex-col gap-2">
            {dispatchProposals.map((p, i) => (
              <ProposalCard key={`${p.agent_slug}-${i}`} proposal={p} />
            ))}
          </div>
        )}
        {row.artifacts && row.artifacts.length > 0 && (
          <ArtifactChips
            artifacts={row.artifacts}
            createdAt={row.created_at}
            report={{ summary: fullReplyText ?? replyText, sources, createdAt: row.created_at, threadId: threadId ?? null }}
            autoOpenReport={shouldAutoOpenReport({ isLast: !!isLast })}
            allowAnalysis={variant !== "flat"}
          />
        )}
        {sources && <SourcesFootnote sources={sources} />}
        {}
        {row.agent_run_id && replyLinksAPage(b.text) && (
          <SharedPagesForRun runId={row.agent_run_id} autoOpen={isLast} />
        )}
        {}
        {isLast && <LiveAppPreview activity={runActivity} threadId={threadId} />}
        {}
      </div>
    );
  }
  if (row.kind === "decision") {
    return (
      <ApprovalBlock
        body={row.body as DecisionBody}
        viewerRole={role ?? null}
        onReview={(decisionId) =>
          openTab({
            kind: "needs-you",
            title: "Needs you",
            payload: { kind: "needs-you", ...(decisionId ? { decision: decisionId } : {}) },
            dirty: false,
            pinned: false,
          })
        }
      />
    );
  }
  return null;
});

async function signArtifactUrl(id: string): Promise<string | null> {
  try {
    const res = await apiFetch(`/api/run-artifacts/${id}/url`);
    if (!res.ok) return null;
    const { signed_url } = (await res.json()) as { signed_url?: string };
    return signed_url ?? null;
  } catch {
    return null;
  }
}

function previewArtifactType(mode: ArtifactRenderMode): Artifact["type"] {
  switch (mode) {
    case "image":
      return "image";
    case "video":
      return "video";
    case "csv":
      return "spreadsheet";
    case "html":
      return "website";
    case "ui-block":
      return "dashboard";
    case "pdf":
    case "markdown":
    case "text":
      return "document";
    default:
      return "file";
  }
}

function toPreviewArtifact(a: ArtifactRow, createdAt: string): Artifact {
  return {
    id: a.id,
    run_id: "",
    title: a.title || a.filename,
    filename: a.filename,
    mime: a.mime,
    type: previewArtifactType(artifactRenderMode(a.mime, a.filename)),
    bytes: a.bytes,
    created_at: createdAt,
    updated_at: createdAt,
    preview_url: null,
    source: { kind: "chat", id: "", title: "", href: "" },
  };
}

async function downloadChatArtifact(a: ArtifactRow): Promise<void> {
  try {
    const res = await apiFetch(
      `/api/run-artifacts/${encodeURIComponent(a.id)}/url?download=1`,
    );
    if (!res.ok) return;
    const { signed_url } = (await res.json()) as { signed_url?: string };
    if (!signed_url) return;
    const link = document.createElement("a");
    link.href = signed_url;
    link.download = a.filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } catch {
  }
}

function ImageArtifact({
  artifact,
  createdAt,
}: {
  artifact: ArtifactRow;
  createdAt: string;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const closePreview = useCallback(() => setPreviewOpen(false), []);
  useEffect(() => {
    let alive = true;
    void signArtifactUrl(artifact.id).then((url) => {
      if (!alive) return;
      if (url) setSrc(url);
      else setFailed(true);
    });
    return () => {
      alive = false;
    };
  }, [artifact.id]);

  if (failed) return <ArtifactDownloadChip artifact={artifact} />;
  if (!src) {
    return (
      <div
        className="h-20 w-32 animate-pulse rounded-md border border-ink/15 bg-ink/5"
        aria-label={`Loading ${artifact.filename}`}
      />
    );
  }
  return (
    <>
      <button
        type="button"
        onClick={() => setPreviewOpen(true)}
        aria-label={`Open ${artifact.filename} preview`}
        title={artifact.filename}
        className="rounded-cta focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={artifact.filename}
          className="max-h-40 w-auto rounded-md border border-ink/15 hover:opacity-90"
        />
      </button>
      {previewOpen && (
        <ArtifactViewer
          artifact={toPreviewArtifact(artifact, createdAt)}
          onClose={closePreview}
          onDownload={() => void downloadChatArtifact(artifact)}
        />
      )}
    </>
  );
}

function VideoArtifact({
  artifact,
  createdAt,
}: {
  artifact: ArtifactRow;
  createdAt: string;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const closePreview = useCallback(() => setPreviewOpen(false), []);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    let alive = true;
    void signArtifactUrl(artifact.id).then((url) => {
      if (!alive) return;
      if (url) setSrc(url);
      else setFailed(true);
    });
    return () => {
      alive = false;
    };
  }, [artifact.id]);

  if (failed) return <ArtifactDownloadChip artifact={artifact} />;
  if (!src) {
    return (
      <div
        className="h-40 w-24 animate-pulse rounded-md border border-ink/15 bg-ink/5"
        aria-label={`Loading ${artifact.filename}`}
      />
    );
  }
  return (
    <>
      <div className="relative inline-block">
        <video
          ref={videoRef}
          src={src}
          controls
          preload="metadata"
          playsInline
          aria-label={artifact.filename}
          className="max-h-72 w-auto rounded-md border border-ink/15"
          onError={() => setFailed(true)}
        />
        <button
          type="button"
          onClick={() => {
            videoRef.current?.pause();
            setPreviewOpen(true);
          }}
          aria-label={`Open ${artifact.filename} in preview`}
          title="Open in preview"
          className="absolute right-1.5 top-1.5 inline-flex h-8 w-8 items-center justify-center rounded-cta bg-black/55 text-white hover:bg-black/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
        >
          <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
      {previewOpen && (
        <ArtifactViewer
          artifact={toPreviewArtifact(artifact, createdAt)}
          onClose={closePreview}
          onDownload={() => void downloadChatArtifact(artifact)}
        />
      )}
    </>
  );
}

function ArtifactDownloadChip({ artifact: a }: { artifact: ArtifactRow }) {
  async function open() {
    const url = await signArtifactUrl(a.id);
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  }
  return (
    <button
      type="button"
      onClick={() => void open()}
      className="flex w-full items-center gap-2 rounded-cta border border-rule bg-cream px-2.5 py-1 text-left text-xs text-inkMuted hover:bg-creamDeep hover:text-ink"
      title={`${a.filename} · ${Math.round(a.bytes / 1024)} KB`}
    >
      <Paperclip className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 truncate font-medium">{a.filename}</span>
    </button>
  );
}

function DocumentCard({
  artifact,
  createdAt,
}: {
  artifact: ArtifactRow;
  createdAt: string;
}) {
  const { canDock, openArtifact } = useArtifactPreview();
  const [modalOpen, setModalOpen] = useState(false);
  const closeModal = useCallback(() => setModalOpen(false), []);
  const mode = artifactRenderMode(artifact.mime, artifact.filename);
  const download = useCallback(
    () => void downloadChatArtifact(artifact),
    [artifact],
  );

  if (mode === "unsupported") return <ArtifactDownloadChip artifact={artifact} />;

  const label = mode === "pdf" ? "Open" : "View";
  const open = () => {
    const shaped = toPreviewArtifact(artifact, createdAt);
    if (canDock) openArtifact({ artifact: shaped, onDownload: download });
    else setModalOpen(true);
  };

  return (
    <>
      <div className="flex w-full items-center gap-2.5 rounded-[16px] border border-rule bg-cream px-4 py-3">
        <FileText className="h-4 w-4 shrink-0 text-inkMuted" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink" title={artifact.filename}>
          {artifact.title || artifact.filename}
        </span>
        <button
          type="button"
          onClick={open}
          className="shrink-0 rounded-cta border border-rule bg-white px-3 py-1.5 text-xs font-medium text-ink transition-colors hover:bg-creamDeep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
        >
          {label}
        </button>
      </div>
      {}
      {modalOpen && (
        <ArtifactViewer
          artifact={toPreviewArtifact(artifact, createdAt)}
          onClose={closeModal}
          onDownload={download}
        />
      )}
    </>
  );
}

export function shouldAutoOpenReport(
  { isLast }: { isLast: boolean },
  search: string = typeof window !== "undefined" ? window.location.search : "",
): boolean {
  if (new URLSearchParams(search).has("report")) return false;
  return isLast;
}

function ArtifactChips({
  artifacts,
  createdAt,
  allowAnalysis = true,
  report,
  autoOpenReport = false,
}: {
  artifacts: ArtifactRow[];
  createdAt: string;
  allowAnalysis?: boolean;
  report?: { summary: string; sources: string | null; createdAt: string; threadId?: string | null };
  autoOpenReport?: boolean;
}) {
  const { canDock, open, openArtifact } = useArtifactPreview();
  return (
    <div className="mt-1 flex flex-wrap items-start gap-2">
      {artifacts.map((a) => {
        if (a.mime === UI_BLOCK_MIME)
          return (
            <UiBlockArtifact
              key={a.id}
              artifact={a}
              fallback={<ArtifactDownloadChip artifact={a} />}
              autoOpen={autoOpenReport && allowAnalysis}
              paneOpen={open !== null}
              onOpenAnalysis={
                canDock && allowAnalysis
                  ? (title, auto) =>
                      openArtifact({
                        artifact: { ...toPreviewArtifact(a, createdAt), title },
                        onDownload: () => void downloadChatArtifact(a),
                        report,
                        autoOpened: !!auto,
                      })
                  : undefined
              }
            />
          );
        if (a.mime.startsWith("image/"))
          return <ImageArtifact key={a.id} artifact={a} createdAt={createdAt} />;
        if (a.mime.startsWith("video/"))
          return <VideoArtifact key={a.id} artifact={a} createdAt={createdAt} />;
        return <DocumentCard key={a.id} artifact={a} createdAt={createdAt} />;
      })}
    </div>
  );
}

