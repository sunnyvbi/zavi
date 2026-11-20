"use client";

import { useEffect, useRef } from "react";
import { stripChannelMention } from "@/lib/workspace/channelMention";
import { createPortal } from "react-dom";
import { relativeTime } from "@/lib/workspace/relativeTime";
import { cleanPreview, sortByRecency, type ThreadMeta } from "./threadHistory";
import IconBell from "./IconBell";

export function ThreadHistoryModal({
  threads,
  loading = false,
  currentThreadId,
  mainThreadId,
  onSelect,
  onDelete,
  onClose,
}: {
  threads: ThreadMeta[];
  loading?: boolean;
  currentThreadId?: string | null;
  mainThreadId: string | null;
  onSelect: (threadId: string) => void;
  onDelete?: (threadId: string) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const opener =
      typeof document !== "undefined"
        ? (document.activeElement as HTMLElement | null)
        : null;
    closeBtnRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        e.preventDefault();
        onCloseRef.current();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      if (opener && document.contains(opener)) opener.focus();
    };
  }, []);

  const onKeyDownTrap = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const root = dialogRef.current;
    if (!root) return;
    const focusables = root.querySelectorAll<HTMLElement>(
      'button:not([disabled]),input:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])',
    );
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const ordered = sortByRecency(threads);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="workspace-shell fixed inset-0 z-50 grid place-items-center overflow-auto bg-[rgba(11,11,12,.45)] p-4"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="thread-history-title"
        onKeyDown={onKeyDownTrap}
        className="m-auto flex max-h-[70vh] w-full max-w-[520px] flex-col overflow-hidden rounded-[18px] border border-rule bg-cream shadow-[0_30px_90px_-20px_rgba(0,0,0,.5)]"
      >
        {}
        <div className="relative shrink-0 border-b border-rule px-6 pb-4 pt-5">
          <button
            ref={closeBtnRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="absolute right-3 top-3 inline-flex h-10 w-10 cursor-pointer items-center justify-center rounded-full text-inkMuted transition-colors hover:bg-bone hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
          >
            <svg
              aria-hidden
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.25"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-5 w-5"
            >
              <path d="M6 6 18 18M18 6 6 18" />
            </svg>
          </button>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-inkMuted">
            History
          </div>
          <div
            id="thread-history-title"
            className="mt-1 text-[20px] font-bold tracking-[-.02em] text-ink"
          >
            Conversations
          </div>
        </div>

        {}
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {loading && ordered.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 px-4 py-12 text-center">
              <svg
                aria-hidden
                viewBox="0 0 24 24"
                className="h-6 w-6 animate-spin text-inkMuted"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
              >
                <path d="M21 12a9 9 0 1 1-6.2-8.55" />
              </svg>
              <span className="text-[13px] text-inkMuted">
                Loading conversations…
              </span>
            </div>
          ) : ordered.length === 0 ? (
            <div className="px-4 py-10 text-center text-[13px] text-inkMuted">
              No conversations yet.
            </div>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {ordered.map((t) => {
                const isActive = t.id === currentThreadId;
                const cleanTitle = stripChannelMention(t.title);
                const title =
                  cleanTitle.length > 0
                    ? cleanTitle
                    : t.id === mainThreadId
                      ? "Main thread"
                      : "Untitled thread";
                const ps = t.presentation_status;
                const running = ps
                  ? ps === "running"
                  : t.run_status === "running" || t.run_status === "queued";
                const failed = ps
                  ? ps === "failed"
                  : t.run_status === "failed" ||
                    t.run_status === "error" ||
                    t.run_status === "parse_failed" ||
                    t.run_status === "dispatch_error";
                const dotClass = t.pending
                  ? "bg-[#d8881e]"
                  : running
                    ? "bg-emerald-500"
                    : failed
                      ? "bg-coral"
                      : "bg-ink/25";
                const preview = stripChannelMention(
                  cleanPreview(t.last_message),
                );
                return (
                  <li key={t.id} className="group relative">
                    <button
                      type="button"
                      onClick={() => {
                        onSelect(t.id);
                        onClose();
                      }}
                      aria-current={isActive ? "true" : undefined}
                      title={title}
                      className={`flex w-full items-start gap-2.5 rounded-cta px-3 py-2.5 text-left transition-colors focus-visible:outline-none ${
                        isActive
                          ? "bg-bone ring-1 ring-inset ring-ink/10"
                          : "hover:bg-bone/60"
                      }`}
                    >
                      <span
                        className={`mt-1.5 inline-flex h-1.5 w-1.5 shrink-0 rounded-full ${dotClass}`}
                        aria-hidden
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline justify-between gap-2">
                          <span className="truncate text-[16px] font-semibold text-ink">
                            {title}
                          </span>
                          {}
                          {t.unread && !isActive && (
                            <span
                              className="shrink-0 self-center text-ink"
                              aria-label="Unread reply"
                              title="Unread reply"
                            >
                              <IconBell size={16} />
                            </span>
                          )}
                          {}
                          <span
                            className={`ml-auto shrink-0 text-[12px] text-inkMuted transition-opacity ${
                              onDelete
                                ? "group-hover:opacity-0 [@media(hover:none)]:opacity-0"
                                : ""
                            }`}
                          >
                            {relativeTime(t.last_message_at)}
                          </span>
                        </span>
                        {preview && (
                          <span className="mt-0.5 block truncate text-[13px] text-inkMuted">
                            {preview}
                          </span>
                        )}
                      </span>
                    </button>
                    {}
                    {onDelete && (
                      <button
                        type="button"
                        onClick={() => onDelete(t.id)}
                        aria-label={`Close ${title}`}
                        title="Close conversation"
                        className="pointer-events-none absolute right-2 top-2 inline-flex h-6 w-6 items-center justify-center rounded-full text-inkMuted opacity-0 transition-opacity hover:bg-bone hover:text-ink focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30 group-hover:pointer-events-auto group-hover:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100"
                      >
                        <svg
                          aria-hidden
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className="h-3.5 w-3.5"
                        >
                          <path d="M6 6 18 18M18 6 6 18" />
                        </svg>
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
