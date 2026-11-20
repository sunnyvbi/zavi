"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Plus } from "lucide-react";
import { ZaviMascot } from "@/components/ZaviMascot";
import { channelChatWidthKey, SideChat } from "../sidechat/SideChat";
import { PastChatsPopover } from "../sidechat/PastChatsPopover";
import { listChannelThreads, type ChannelThread } from "@/lib/workspace/channelThreadsApi";
import { cx, FOCUS_RING } from "./shared";
import { getChannel } from "@zavi/shared";
import { announceChannelActionsChanged } from "../actions/topActions/api";
import { ANSWER_PLACEHOLDER, type ChannelChatPin } from "../actions/channelChat";

const PANEL_TAB_ID = "channel-action-chat-panel";

const CONTEXT_LINE = {
  ask: "On this action",
  redo: "Running this again",
  answer: "Zavi asked you this",
} as const;

export function askSeedText(actionTitle: string, channelName: string): string {
  return `About this action on ${channelName}: "${actionTitle}". `;
}

export function channelStarterChips(channelName: string): readonly string[] {
  return [
    `How is ${channelName} doing?`,
    `What should I do next on ${channelName}?`,
    `What's holding ${channelName} back?`,
  ];
}

export function ChannelActionChat({
  pin,
  channelSlug,
  channelName,
  open,
  onClose,
  containerRef,
  maxWidthPx,
  fullBleed = false,
  linkedActionId = null,
  onAct,
}: {
  pin: ChannelChatPin;
  linkedActionId?: string | null;
  onAct?: () => void;
  channelSlug: string;
  channelName: string;
  open: boolean;
  onClose: () => void;
  containerRef?: RefObject<HTMLElement | null>;
  maxWidthPx?: number;
  fullBleed?: boolean;
}) {
  const onAction = pin.target === "action";
  const isRedo = onAction && pin.mode === "redo";
  const isAnswer = isRedo && pin.answer === true;
  const askMode = onAction && !isRedo;
  const pinnedActionId = onAction ? pin.action.id : null;
  const pinnedActionTitle = onAction ? pin.action.title : null;
  const linkedId = !onAction ? linkedActionId : null;
  const lookupActionId = pinnedActionId ?? linkedId;
  const agentSlug = getChannel(channelSlug)?.executor ?? channelSlug;

  const pinnedCard = useMemo(
    () =>
      pinnedActionId && pinnedActionTitle !== null
        ? { id: pinnedActionId, title: pinnedActionTitle }
        : null,
    [pinnedActionId, pinnedActionTitle],
  );
  const [threadId, setThreadId] = useState<string | null>(null);
  const linkedCard = useMemo(
    () => (linkedId ? { id: linkedId, title: "This action" } : null),
    [linkedId],
  );
  const baseCard = pinnedCard ?? linkedCard;
  const [card, setCard] = useState<{ id: string; title: string } | null>(baseCard);
  const [resolving, setResolving] = useState(!isRedo);
  const [seedNonce, setSeedNonce] = useState(0);
  const actRef = useRef(0);
  const [pastOpen, setPastOpen] = useState(false);

  const cardOf = useCallback(
    (row: ChannelThread) =>
      row.channel_action_id
        ? {
            id: row.channel_action_id,
            title:
              row.card_title ??
              (row.channel_action_id === pinnedCard?.id ? pinnedCard.title : "This action"),
          }
        : null,
    [pinnedCard],
  );

  const onActRef = useRef(onAct);
  onActRef.current = onAct;
  const acted = useCallback(() => {
    actRef.current += 1;
    onActRef.current?.();
  }, []);

  const cardRef = useRef(card);
  cardRef.current = card;
  const pinRef = useRef(pin);
  const forceRef = useRef(false);
  const [askTick, setAskTick] = useState(0);
  useEffect(() => {
    if (pinRef.current === pin) return;
    pinRef.current = pin;
    if (pin.target !== "action" || pin.mode === "redo") return;
    if (cardRef.current?.id === pin.action.id) return;
    forceRef.current = true;
    setAskTick((t) => t + 1);
  }, [pin]);

  const lookedUpRef = useRef(false);
  useEffect(() => {
    if (isRedo) return;
    if (lookedUpRef.current) {
      if (forceRef.current) {
        forceRef.current = false;
        actRef.current += 1;
      } else if (actRef.current !== 0) return;
      setResolving(true);
      setThreadId(null);
      setCard(baseCard);
      setSeedNonce(0);
    }
    lookedUpRef.current = true;
    const token = actRef.current;
    let live = true;
    const current = () => live && actRef.current === token;
    listChannelThreads(channelSlug, lookupActionId)
      .then(
        (rows) => {
          if (!current()) return;
          const latest = linkedId ? rows.find((r) => r.channel_action_id === linkedId) : rows[0];
          if (latest) {
            setThreadId(latest.id);
            setCard(cardOf(latest));
          } else if (askMode) {
            setSeedNonce(1);
          }
        },
        (e: unknown) => {
          console.warn(`[channel chat] could not look up past chats: ${(e as Error)?.message ?? e}`);
          if (current() && askMode) setSeedNonce(1);
        },
      )
      .finally(() => {
        if (live) setResolving(false);
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelSlug, lookupActionId, isRedo, askTick]);

  const onThreadIdChange = useCallback(
    (id: string | null) => {
      acted();
      setThreadId(id);
    },
    [acted],
  );
  const openPast = useCallback(
    (row: ChannelThread) => {
      acted();
      setResolving(false);
      setThreadId(row.id);
      setCard(cardOf(row));
    },
    [cardOf, acted],
  );
  const loadPast = useCallback(() => listChannelThreads(channelSlug), [channelSlug]);
  const newChat = useCallback(() => {
    acted();
    setResolving(false);
    setThreadId(null);
    setCard(null);
  }, [acted]);

  const contextLine = card ? CONTEXT_LINE[isAnswer ? "answer" : isRedo ? "redo" : "ask"] : null;
  const actionSeed = useMemo(
    () =>
      askMode && seedNonce > 0 && pinnedActionTitle !== null
        ? { text: askSeedText(pinnedActionTitle, channelName), nonce: seedNonce, autoSend: false }
        : null,
    [askMode, seedNonce, pinnedActionTitle, channelName],
  );
  const channelDraft = pin.draft;
  const seed = channelDraft ?? actionSeed;
  const starterChips = useMemo(
    () => (isRedo ? [] : channelStarterChips(channelName)),
    [isRedo, channelName],
  );
  const redoSentRef = useRef(false);
  const [redoSent, setRedoSent] = useState(false);
  const showHistoryControls = !isRedo || redoSent;
  const redoInFlightRef = useRef(false);
  const redoSwallowExplainedRef = useRef(false);
  const onBeforeSend = useCallback(
    async (
      message: string,
      chat: { appendSystem: (text: string, opts?: { persists?: boolean }) => void },
    ) => {
      if (pin.target !== "action" || !isRedo || redoSentRef.current) {
        return { handled: false };
      }
      if (redoInFlightRef.current) {
        if (!redoSwallowExplainedRef.current) {
          redoSwallowExplainedRef.current = true;
          chat.appendSystem(`Still sending your ${isAnswer ? "answer" : "note"}. This one did not send it again.`, {
            persists: false,
          });
        }
        return { handled: true };
      }
      redoInFlightRef.current = true;
      let started = false;
      try {
        started = (await pin.onRedo(message)) !== false;
      } catch {
        started = false;
      } finally {
        redoInFlightRef.current = false;
        redoSwallowExplainedRef.current = false;
      }
      if (!started) {
        chat.appendSystem("Zavi could not start that run. The note above your cards says why.", {
          persists: false,
        });
        return { handled: true };
      }
      redoSentRef.current = true;
      setRedoSent(true);
      chat.appendSystem(
        isAnswer ? "Sent. Zavi is working with your answer." : "Zavi is running this channel again with your note.",
        { persists: false },
      );
      return { handled: true };
    },
    [isRedo, isAnswer, pin],
  );

  const announcedRunsRef = useRef(new Set<string>());
  const onRunFinished = useCallback(
    (runId: string) => {
      if (announcedRunsRef.current.has(runId)) return;
      announcedRunsRef.current.add(runId);
      announceChannelActionsChanged(channelSlug);
    },
    [channelSlug],
  );

  return (
    <SideChat
      onRunFinished={onRunFinished}
      agentSlug={agentSlug}
      tabId={PANEL_TAB_ID}
      thread="fresh"
      threadId={threadId}
      onThreadIdChange={onThreadIdChange}
      resolvingThread={resolving}
      pageChannel={channelSlug}
      escapeOwnedElsewhere={pastOpen}
      headerActions={
        showHistoryControls && (
          <>
            <PastChatsPopover
              load={loadPast}
              placeName={channelName}
              currentThreadId={threadId}
              onPick={openPast}
              onOpenChange={setPastOpen}
              fullBleed={fullBleed}
            />
            <button
              type="button"
              onClick={newChat}
              disabled={threadId === null}
              aria-label="New chat"
              title="New chat"
              className={cx(
                "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-cta text-inkLight hover:bg-bone hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent",
                fullBleed && "h-10 w-10 text-ink",
                FOCUS_RING,
              )}
            >
              <Plus className="h-[18px] w-[18px]" aria-hidden />
            </button>
          </>
        )
      }
      avatar={<ZaviMascot size={28} className="shrink-0" />}
      title={channelName}
      contextLine={contextLine}
      ariaLabel={
        onAction ? "Chat with Zavi about this action" : "Chat with Zavi about this channel"
      }
      open={open}
      onClose={onClose}
      widthKey={channelChatWidthKey(channelSlug)}
      resizeLabel={`Resize the ${channelName} conversation`}
      containerRef={containerRef}
      maxWidthPx={maxWidthPx}
      fullBleed={fullBleed}
      channelActionId={card ? card.id : undefined}
      starterChips={starterChips}
      seed={seed ?? undefined}
      onBeforeSend={onBeforeSend}
      composerPlaceholder={isAnswer && !redoSent ? ANSWER_PLACEHOLDER : undefined}
      optimisticPersists={(text, attachments) =>
        !(
          pin.target === "action" &&
          isRedo &&
          !redoSentRef.current &&
          Boolean(text.trim()) &&
          !attachments?.length
        )
      }
      contextBar={
        card && (
          <div className="shrink-0 border-b border-rule bg-creamDeep px-3 py-2">
            <p className="text-[13px] font-semibold leading-4 text-ink">{card.title}</p>
            {isAnswer && !redoSent && (
              <p className="mt-1.5 text-[13px] text-inkMuted">
                Type what this card asks for. Zavi takes your answer and does the next step.
              </p>
            )}
            {isRedo && !isAnswer && !redoSent && (
              <>
                <p className="mt-1.5 text-[16px] font-semibold text-ink">
                  What should Zavi do differently?
                </p>
                <p className="mt-0.5 text-[13px] text-inkMuted">
                  Zavi runs this channel again with your note and replaces this action. Nothing
                  is posted or changed until you say so.
                </p>
              </>
            )}
          </div>
        )
      }
    />
  );
}
