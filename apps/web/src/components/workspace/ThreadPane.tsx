"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { RowRenderer, type ChatRow } from "./ChatThread";
import { lastTurnRowIndex } from "@/lib/workspace/threadTimeline";
import { turnCopyByRow } from "@/lib/workspace/replyCopy";
import { setThreadView } from "./onScreenThreads";
import { ThreadPaneComposer } from "./ThreadPaneComposer";
import { useResizablePane } from "@/hooks/useResizablePane";
import { SidePaneHeader } from "./SidePaneHeader";
import {
  THREAD_PANE_COLLAPSED_FRACTION,
  THREAD_PANE_DEFAULT_PX,
  THREAD_PANE_MAX_PX,
  THREAD_PANE_MIN_PX,
} from "./sidePaneSize";

export { THREAD_PANE_COLLAPSED_FRACTION, THREAD_PANE_DEFAULT_PX, THREAD_PANE_MAX_PX, THREAD_PANE_MIN_PX };

export const THREAD_PANE_DEFAULT_PCT = 27;
export const THREAD_PANE_MIN_PCT = 20;
export const THREAD_PANE_MAX_PCT = 80;

const ROW_CLASS =
  "rounded-lg p-2 transition-colors duration-150 hover:bg-[#f9f9f9] motion-reduce:transition-none";

function ThreadPaneSkeleton() {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className="px-2 py-1">
      <span className="sr-only">Loading thread…</span>
      {}
      <div className="flex gap-2">
        <div className="h-8 w-8 shrink-0 animate-pulse rounded-full bg-ink/10 motion-reduce:animate-none" />
        <div className="min-w-0 flex-1">
          <div className="h-3 w-20 animate-pulse rounded bg-ink/10 motion-reduce:animate-none" />
          <div className="mt-2.5 h-3 w-full animate-pulse rounded bg-ink/10 motion-reduce:animate-none" />
          <div className="mt-1.5 h-3 w-[78%] animate-pulse rounded bg-ink/10 motion-reduce:animate-none" />
        </div>
      </div>
      {}
      <div className="flex items-center gap-3 py-3">
        <div className="h-3 w-14 shrink-0 animate-pulse rounded bg-ink/10 motion-reduce:animate-none" />
        <span aria-hidden className="h-px flex-1 bg-ink/10" />
      </div>
      {}
      <div className="flex gap-2">
        <div className="h-7 w-7 shrink-0 animate-pulse rounded-full bg-ink/10 motion-reduce:animate-none" />
        <div className="min-w-0 flex-1">
          <div className="h-3 w-24 animate-pulse rounded bg-ink/10 motion-reduce:animate-none" />
          <div className="mt-2.5 h-3 w-full animate-pulse rounded bg-ink/10 motion-reduce:animate-none" />
          <div className="mt-1.5 h-3 w-full animate-pulse rounded bg-ink/10 motion-reduce:animate-none" />
          <div className="mt-1.5 h-3 w-[64%] animate-pulse rounded bg-ink/10 motion-reduce:animate-none" />
        </div>
      </div>
    </div>
  );
}

export function clampPaneWidthPct(pct: number): number {
  if (!Number.isFinite(pct)) return THREAD_PANE_DEFAULT_PCT;
  return Math.min(THREAD_PANE_MAX_PCT, Math.max(THREAD_PANE_MIN_PCT, pct));
}

export type ThreadPaneProps = {
  threadId: string;
  agentSlug: string;
  rootRow: ChatRow;
  replies?: ChatRow[];
  loading?: boolean;
  errorMsg?: string | null;
  streamingText?: string | null;
  onClose: () => void;
  returnFocusRef?: { current: HTMLElement | null };
  onWidthCommit?: (paneWidthPct: number) => void;
  initialWidthPct?: number | null;
  containerRef?: RefObject<HTMLElement | null>;
  onSendReply?: (text: string) => void | Promise<void>;
  sendingReply?: boolean;
  composer?: ReactNode;
  resizable?: boolean;
};

export function ThreadPane({
  threadId,
  agentSlug,
  rootRow,
  replies = [],
  loading = false,
  errorMsg = null,
  streamingText = null,
  onClose,
  returnFocusRef,
  onWidthCommit,
  initialWidthPct = null,
  containerRef,
  onSendReply,
  sendingReply = false,
  composer,
  resizable = true,
}: ThreadPaneProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const turnCopy = turnCopyByRow([rootRow, ...replies]);
  const paneRef = useRef<HTMLElement | null>(null);
  const viewKey = useId();
  const contentShown = !loading && !errorMsg;
  useEffect(() => {
    if (!contentShown) return;
    setThreadView(viewKey, { threadId, el: () => paneRef.current });
    return () => setThreadView(viewKey, null);
  }, [viewKey, threadId, contentShown]);
  const rowsRef = useRef<HTMLDivElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  const startPct = initialWidthPct ?? THREAD_PANE_DEFAULT_PCT;
  const handleCommit = useCallback(
    (pct: number) => {
      onWidthCommit?.(clampPaneWidthPct(pct));
    },
    [onWidthCommit],
  );
  const { sizePx, dragging, separatorProps } = useResizablePane({
    containerRef,
    min: THREAD_PANE_MIN_PX,
    maxFn: (vw) =>
      Math.max(
        THREAD_PANE_MIN_PX,
        Math.min(THREAD_PANE_MAX_PX, vw - THREAD_PANE_MIN_PX),
      ),
    round: "result",
    defaultFn: (vw) =>
      initialWidthPct != null
        ? (vw * startPct) / 100
        : THREAD_PANE_DEFAULT_PX,
    resetTo: () => THREAD_PANE_DEFAULT_PX,
    keyboard: true,
    ariaLabel: "Resize thread pane",
    onCommit: handleCommit,
  });

  const openerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (typeof document !== "undefined") {
      const active = document.activeElement;
      openerRef.current =
        active instanceof HTMLElement && active !== document.body ? active : null;
    }
    headingRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const closeAndRestore = useCallback(() => {
    const target = returnFocusRef?.current ?? openerRef.current;
    onClose();
    if (!target || typeof target.focus !== "function") return;
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => target.focus());
    } else {
      target.focus();
    }
  }, [onClose, returnFocusRef]);

  const [measurable, setMeasurable] = useState(false);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const read = () => {
      setMeasurable(el.offsetParent !== null && el.clientHeight > 0);
    };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [loading, errorMsg]);

  const wasNearBottomRef = useRef(true);
  useLayoutEffect(() => {
    const sp = scrollRef.current;
    if (!sp) return;
    const onScroll = () => {
      wasNearBottomRef.current =
        sp.scrollHeight - sp.scrollTop - sp.clientHeight < 100;
    };
    sp.addEventListener("scroll", onScroll, { passive: true });
    return () => sp.removeEventListener("scroll", onScroll);
  }, [loading, errorMsg]);

  const didInitialPinRef = useRef(false);
  const lastThreadIdRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (lastThreadIdRef.current !== threadId) {
      lastThreadIdRef.current = threadId;
      didInitialPinRef.current = false;
    }
    const sp = scrollRef.current;
    if (!sp) return;
    if (sp.offsetParent === null || sp.clientHeight === 0) return;

    if (!didInitialPinRef.current) {
      didInitialPinRef.current = true;
      sp.scrollTop = sp.scrollHeight;
      wasNearBottomRef.current = true;
      return;
    }
    if (wasNearBottomRef.current) {
      sp.scrollTop = sp.scrollHeight;
    }
  }, [
    threadId,
    measurable,
    loading,
    errorMsg,
    replies.length,
    streamingText,
  ]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      closeAndRestore();
    },
    [closeAndRestore],
  );

  const width = !resizable
    ? `${THREAD_PANE_COLLAPSED_FRACTION * 100}%`
    : sizePx === null
      ? `${THREAD_PANE_DEFAULT_PX}px`
      : `${sizePx}px`;

  return (
    <aside
      ref={paneRef}
      role="complementary"
      aria-label="Thread"
      onKeyDown={onKeyDown}
      style={{ width, transition: dragging ? "none" : undefined }}
      className="relative z-0 flex h-full min-h-0 min-w-0 max-w-full shrink-0 animate-slide-in-right border-l border-[#f0f0f0] bg-white shadow-[-6px_1px_20px_rgba(16,18,20,0.08)] motion-reduce:animate-none"
      data-testid="thread-pane"
    >
      {}
      {resizable && (
        <div
          {...separatorProps}
          className="w-1 shrink-0 cursor-col-resize bg-ink/5 hover:bg-ink/20 focus:bg-ink/30 focus:outline-none"
          data-testid="thread-pane-resizer"
        />
      )}

      <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
        {}
        <SidePaneHeader
          title="Thread"
          headingRef={headingRef}
          closeLabel="Close thread"
          onClose={closeAndRestore}
        />

        {}
        <div
          ref={scrollRef}
          className="min-h-0 flex-1 overflow-y-auto"
          data-testid="thread-pane-scroller"
        >
          {}
          <div ref={rowsRef} className="px-4 py-2" data-testid="thread-pane-rows">
            {}
            <div className="w-full">
              {errorMsg ? (
                <p className="text-[16px] text-red-600">{errorMsg}</p>
              ) : loading ? (
                <ThreadPaneSkeleton />
              ) : (
                <>
                  {}
                  <div className={ROW_CLASS} data-testid="thread-pane-root">
                    <RowRenderer
                      row={rootRow}
                      agentSlug={agentSlug}
                      threadId={threadId}
                      copyMarkdown={turnCopy.get(rootRow.id)}
                      variant="flat"
                    />
                  </div>

                  {}
                  {replies.length > 0 && (
                    <div
                      className="flex items-center gap-3 px-2 pb-3 pt-3"
                      data-testid="thread-pane-reply-count"
                    >
                      {}
                      <span className="shrink-0 text-[13px] font-normal leading-[19.5px] tracking-[-0.0762px] text-inkMuted">
                        {replies.length === 1
                          ? "1 reply"
                          : `${replies.length} replies`}
                      </span>
                      <span aria-hidden className="h-px flex-1 bg-ink/10" />
                    </div>
                  )}

                  {replies.map((r, i) => (
                    <div key={r.id} className={ROW_CLASS}>
                      <RowRenderer
                        row={r}
                        agentSlug={agentSlug}
                        threadId={threadId}
                        isLast={i === lastTurnRowIndex(replies)}
                        copyMarkdown={turnCopy.get(r.id)}
                        variant="flat"
                      />
                    </div>
                  ))}
                </>
              )}

              {}
              <div
                role="log"
                aria-live="polite"
                aria-atomic="false"
                aria-label="Streaming reply"
                data-testid="thread-pane-live"
                className="px-2"
              >
                {streamingText ? (
                  <p className="whitespace-pre-wrap text-[14px] leading-[22px] text-ink">
                    {streamingText}
                  </p>
                ) : null}
              </div>
            </div>
          </div>
        </div>

        {composer ?? (
          <ThreadPaneComposer
            onSend={onSendReply}
            sending={sendingReply}
            agentSlug={agentSlug}
          />
        )}
      </div>
    </aside>
  );
}
