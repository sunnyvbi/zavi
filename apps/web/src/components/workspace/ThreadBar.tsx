"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { stripChannelMention } from "@/lib/workspace/channelMention";
import { useWorkspace } from "./WorkspaceShell";
import { apiFetch } from "@/lib/api";
import { Tooltip } from "./Tooltip";
import { ThreadHistoryModal } from "./ThreadHistoryModal";
import { Skeleton } from "./Skeleton";
import {
  liveUnreadThreadIds,
  OPEN_THREAD_HISTORY_EVENT,
  threadRunning,
  threadsNeedPoll,
  type ThreadMeta,
} from "./threadHistory";
import IconBell from "./IconBell";

type AgentPayload = { kind: "agent"; slug: string; threadId?: string | null };

export function ThreadBar({
  slug,
  currentThreadId,
  onSelectThread,
  onNewThread,
}: {
  slug: string;
  currentThreadId?: string | null;
  onSelectThread?: (threadId: string) => void;
  onNewThread?: () => void;
}) {
  const {
    tabs,
    openAgentTab,
    closeTab,
    refreshTree,
    unreadTabIds,
    clearTabUnread,
  } = useWorkspace();
  const [threads, setThreads] = useState<ThreadMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(false);
  const pendingHistoryAtRef = useRef<number | null>(null);
  useEffect(() => {
    function onOpenHistory(e: Event) {
      const detail = (e as CustomEvent<{ slug?: unknown }>).detail;
      if (detail?.slug !== slug) return;
      const el = scrollerRef.current;
      if (el && el.offsetParent !== null) {
        setHistoryOpen(true);
        return;
      }
      pendingHistoryAtRef.current = Date.now();
    }
    window.addEventListener(OPEN_THREAD_HISTORY_EVENT, onOpenHistory);
    return () =>
      window.removeEventListener(OPEN_THREAD_HISTORY_EVENT, onOpenHistory);
  }, [slug]);
  useEffect(() => {
    const at = pendingHistoryAtRef.current;
    if (at === null) return;
    if (Date.now() - at > 5000) {
      pendingHistoryAtRef.current = null;
      return;
    }
    const el = scrollerRef.current;
    if (el && el.offsetParent !== null) {
      pendingHistoryAtRef.current = null;
      setHistoryOpen(true);
    }
  }, [threads]);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const activePillRef = useRef<HTMLDivElement | null>(null);
  const deletedIdsRef = useRef<Set<string>>(new Set());

  const [pollSeq, setPollSeq] = useState(0);
  const fetchingRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    fetchingRef.current = true;
    void (async () => {
      try {
        const res = await apiFetch(
          `/api/agents/${encodeURIComponent(slug)}/threads`,
        );
        if (cancelled) return;
        setLoading(false);
        if (!res.ok) return;
        const data = (await res.json()) as { threads: ThreadMeta[] };
        if (cancelled) return;
        setThreads((prev) => {
          const incoming = data.threads ?? [];
          if (deletedIdsRef.current.size > 0) {
            const incomingIds = new Set(incoming.map((t) => t.id));
            for (const id of [...deletedIdsRef.current]) {
              if (!incomingIds.has(id)) deletedIdsRef.current.delete(id);
            }
          }
          const tombstoned = deletedIdsRef.current;
          if (prev.length === 0) {
            return incoming.filter((t) => !tombstoned.has(t.id));
          }
          const byId = new Map(incoming.map((t) => [t.id, t]));
          const kept = prev
            .filter((t) => byId.has(t.id))
            .map((t) => byId.get(t.id)!);
          const keptIds = new Set(kept.map((t) => t.id));
          const added = incoming.filter(
            (t) => !keptIds.has(t.id) && !tombstoned.has(t.id),
          );
          return [...added, ...kept];
        });
      } catch {
        if (!cancelled) setLoading(false);
      } finally {
        if (!cancelled) fetchingRef.current = false;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug, currentThreadId, pollSeq]);

  const needPoll = threadsNeedPoll(threads);
  useEffect(() => {
    if (!needPoll) return;
    const id = window.setInterval(() => {
      if (document.hidden || fetchingRef.current) return;
      setPollSeq((n) => n + 1);
    }, 10_000);
    return () => window.clearInterval(id);
  }, [needPoll]);

  const activePresent = threads.some((t) => t.id === currentThreadId);
  useEffect(() => {
    const el = activePillRef.current;
    if (!el) return;
    el.scrollIntoView({ inline: "nearest", block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentThreadId, threads.length, activePresent]);

  const wheelCleanupRef = useRef<(() => void) | null>(null);
  const setScrollerRef = useCallback((el: HTMLDivElement | null) => {
    scrollerRef.current = el;
    wheelCleanupRef.current?.();
    wheelCleanupRef.current = null;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY === 0 || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      if (el.scrollWidth <= el.clientWidth) return;
      el.scrollLeft += e.deltaY;
      e.preventDefault();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    wheelCleanupRef.current = () => el.removeEventListener("wheel", onWheel);
  }, []);

  const selectThread = useCallback(
    (threadId: string) => {
      if (onSelectThread) {
        for (const tid of [threadId, currentThreadId]) {
          const bound = tabs.find((t) => {
            const p = t.payload as { slug?: unknown; threadId?: unknown };
            return t.kind === "agent" && p.slug === slug && p.threadId === tid;
          });
          if (bound && unreadTabIds[bound.id]) clearTabUnread(bound.id);
        }
        onSelectThread(threadId);
        return;
      }
      void openAgentTab(slug, { threadId, push: true });
    },
    [
      onSelectThread,
      slug,
      openAgentTab,
      tabs,
      unreadTabIds,
      clearTabUnread,
      currentThreadId,
    ],
  );

  const liveUnread = useMemo(
    () => liveUnreadThreadIds(tabs, unreadTabIds, slug),
    [tabs, unreadTabIds, slug],
  );

  const startNewThread = useCallback(() => {
    if (onNewThread) onNewThread();
    else void openAgentTab(slug, { newThread: true, push: true });
  }, [onNewThread, openAgentTab, slug]);

  const deleteThread = useCallback(
    (threadId: string) => {
      const remaining = threads.filter((t) => t.id !== threadId);
      const boundTab = tabs.find(
        (t) =>
          t.kind === "agent" &&
          (t.payload as AgentPayload).slug === slug &&
          (t.payload as AgentPayload).threadId === threadId,
      );
      if (threadId === currentThreadId) {
        if (remaining[0]) selectThread(remaining[0].id);
        else startNewThread();
      }
      if (boundTab) closeTab(boundTab.id);
      deletedIdsRef.current.add(threadId);
      setThreads(remaining);
      void apiFetch(
        `/api/agents/${encodeURIComponent(slug)}/threads/${threadId}`,
        { method: "DELETE" },
      )
        .then(() => refreshTree())
        .catch(() => {});
    },
    [
      threads,
      tabs,
      slug,
      currentThreadId,
      selectThread,
      startNewThread,
      closeTab,
      refreshTree,
    ],
  );

  const mainThreadId = useMemo(() => {
    let oldest: ThreadMeta | null = null;
    for (const t of threads) {
      if (!t.created_at) continue;
      if (!oldest || t.created_at < oldest.created_at!) oldest = t;
    }
    return oldest?.id ?? threads[0]?.id ?? null;
  }, [threads]);

  const onFresh = currentThreadId === null;

  if (loading && threads.length === 0 && !onFresh) {
    return (
      <div
        role="status"
        aria-busy="true"
        aria-label="Loading conversations"
        className="shrink-0 border-b border-[#f0f0f0] bg-white"
      >
        <div className="flex h-14 items-center gap-2 overflow-hidden">
          {}
          <span className="flex h-14 shrink-0 items-center gap-2 pl-3 pr-2">
            <Skeleton className="h-8 w-8" rounded="rounded-[16px]" />
            <Skeleton className="h-8 w-8" rounded="rounded-[16px]" />
          </span>
          {}
          <Skeleton className="h-8 w-40 shrink-0" rounded="rounded-[16px]" />
          <Skeleton className="h-8 w-32 shrink-0" rounded="rounded-[16px]" />
          <Skeleton className="h-8 w-24 shrink-0" rounded="rounded-[16px]" />
        </div>
      </div>
    );
  }

  if (threads.length === 0 && !onFresh) return null;

  return (
    <>
      <div className="shrink-0 border-b border-[#f0f0f0] bg-white">
        <div
          ref={setScrollerRef}
          className="flex h-14 items-center gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {}
          {}
          <span className="sticky left-0 z-10 flex h-14 shrink-0 items-center gap-2 bg-white pl-3 pr-2">
            {}
            <Tooltip label="New thread">
              <button
                type="button"
                onClick={startNewThread}
                aria-label={`New ${slug} thread`}
                className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-[16px] text-[#1f1f1f] transition-colors duration-150 hover:bg-[rgba(25,25,25,.05)] focus-visible:outline-none"
              >
                <svg
                  aria-hidden
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="h-6 w-6"
                >
                  <path d="M12 3.5v17M3.5 12h17" />
                </svg>
              </button>
            </Tooltip>
            <Tooltip label="Conversation history">
              <button
                type="button"
                onClick={() => setHistoryOpen(true)}
                aria-haspopup="dialog"
                aria-label="Conversation history"
                className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-[16px] text-[#1f1f1f] transition-colors duration-150 hover:bg-[rgba(25,25,25,.05)] focus-visible:outline-none"
              >
                <svg
                  aria-hidden
                  viewBox="0 0 21.5003 21.5001"
                  fill="currentColor"
                  className="h-[21px] w-[21px] shrink-0"
                >
                  <path d="M8.01777 0.370143C13.4267 -1.07389 18.9789 1.83031 20.9143 6.9385C20.9986 7.16134 20.9713 7.41127 20.842 7.61135C20.7125 7.81133 20.4958 7.9377 20.258 7.95217L17.7482 8.10549C17.3348 8.13066 16.9795 7.81578 16.9543 7.40237C16.9291 6.98909 17.2432 6.63385 17.6564 6.60842L19.0891 6.52053C17.1367 2.72739 12.7211 0.666862 8.40449 1.81936C3.43711 3.14571 0.493655 8.22039 1.81855 13.1485C3.14396 18.0777 8.24168 21.0073 13.2102 19.6807C16.8968 18.6962 19.4708 15.6453 20.009 12.1211C20.0716 11.7118 20.4542 11.4308 20.8635 11.4932C21.2729 11.5557 21.5539 11.9382 21.4914 12.3477C20.8658 16.4439 17.876 19.9873 13.5969 21.1299C7.83652 22.668 1.91161 19.2738 0.369334 13.5381C-1.17295 7.80152 2.25658 1.90845 8.01777 0.370143ZM10.7502 6.00003C11.1644 6.00003 11.5002 6.33581 11.5002 6.75003V10.4395L13.2805 12.2198C13.5734 12.5126 13.5734 12.9874 13.2805 13.2803C12.9876 13.5732 12.5128 13.5732 12.2199 13.2803L10.2199 11.2803C10.0793 11.1396 10.0002 10.9489 10.0002 10.75V6.75003C10.0002 6.33581 10.336 6.00003 10.7502 6.00003Z" />
                </svg>
              </button>
            </Tooltip>
          </span>
          {}
          {onFresh && (
            <span
              aria-current="page"
              className="flex h-8 shrink-0 items-center rounded-[16px] border border-[#f0f0f0] bg-[#f9f9f9] px-3 text-[16px] font-semibold leading-5 tracking-[0.01px] text-[#1f1f1f] shadow-[0px_1px_2px_0px_rgba(16,24,40,0.05)]"
            >
              New thread
            </span>
          )}
          {threads.map((t) => {
            const isActive = t.id === currentThreadId;
            const cleanTitle = stripChannelMention(t.title);
            const title =
              cleanTitle.length > 0
                ? cleanTitle
                : t.id === mainThreadId
                  ? "Main thread"
                  : "Untitled thread";
            const status = t.run_status;
            const ps = t.presentation_status;
            const running = threadRunning(t);
            const failed = ps
              ? ps === "failed"
              : status === "failed" ||
                status === "error" ||
                status === "parse_failed" ||
                status === "dispatch_error";
            return (
              <div
                key={t.id}
                ref={isActive ? activePillRef : undefined}
                className={`group relative flex h-8 shrink-0 items-center rounded-[16px] transition-[max-width,background-color] duration-150 ${
                  isActive
                    ? "max-w-[340px] border border-[#f0f0f0] bg-[#f9f9f9] shadow-[0px_1px_2px_0px_rgba(16,24,40,0.05)]"
                    : "max-w-[240px] hover:bg-[rgba(25,25,25,.05)]"
                }`}
              >
                <button
                  type="button"
                  onClick={() => selectThread(t.id)}
                  aria-current={isActive ? "page" : undefined}
                  title={title}
                  className={`flex h-8 min-w-0 cursor-pointer items-center gap-2 rounded-[16px] px-3 py-1.5 text-[16px] leading-5 focus-visible:outline-none group-hover:pr-7 ${
                    isActive
                      ? "font-semibold tracking-[0.01px] text-[#1f1f1f]"
                      : "font-medium tracking-[0.14px] text-[#454545] group-hover:text-ink"
                  }`}
                >
                  {}
                  {(running || failed || t.pending) && (
                    <span
                      className="relative inline-flex h-1.5 w-1.5 shrink-0 items-center justify-center"
                      aria-hidden
                    >
                      {running && (
                        <span className="absolute inline-flex h-1.5 w-1.5 animate-ping rounded-full bg-emerald-400 opacity-70" />
                      )}
                      <span
                        className={`relative inline-flex h-1.5 w-1.5 rounded-full ${
                          t.pending
                            ? "bg-[#2563eb]"
                            : running
                              ? "bg-emerald-500"
                              : "bg-coral"
                        }`}
                      />
                    </span>
                  )}
                  <span className="truncate">{title}</span>
                  {}
                  {(t.unread || liveUnread.has(t.id)) && !isActive && (
                    <span
                      className="shrink-0 text-[#1f1f1f]"
                      aria-label="Unread reply"
                      title="Unread reply"
                    >
                      <IconBell size={18} />
                    </span>
                  )}
                </button>
                {}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteThread(t.id);
                  }}
                  aria-label={`Close ${title}`}
                  title="Close thread"
                  className="absolute right-1 inline-flex h-5 w-5 items-center justify-center rounded-full text-[#8a8a8a] opacity-0 transition-opacity hover:bg-ink/10 hover:text-ink focus-visible:opacity-100 focus-visible:outline-none group-hover:opacity-100"
                >
                  <svg
                    aria-hidden
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="h-3 w-3"
                  >
                    <path d="M6 6 18 18M18 6 6 18" />
                  </svg>
                </button>
              </div>
            );
          })}

          {}
          <span className="shrink-0 pr-3" aria-hidden />
        </div>
      </div>
      {historyOpen && (
        <ThreadHistoryModal
          threads={threads}
          loading={loading}
          currentThreadId={currentThreadId}
          mainThreadId={mainThreadId}
          onSelect={selectThread}
          onDelete={deleteThread}
          onClose={() => setHistoryOpen(false)}
        />
      )}
    </>
  );
}
