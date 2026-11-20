"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { History } from "lucide-react";
import { useDismissableMenu } from "@/hooks/useDismissableMenu";
import type { ChannelThread } from "@/lib/workspace/channelThreadsApi";
import { relativeTime } from "@/lib/workspace/relativeTime";
import { stripChannelMention } from "@/lib/workspace/channelMention";
import { cx, FOCUS_RING } from "../layout/shared";

type Load =
  | { state: "loading" }
  | { state: "error" }
  | { state: "ready"; threads: ChannelThread[] };

export function PastChatsPopover({
  load: loadChats,
  placeName,
  currentThreadId,
  onPick,
  onOpenChange,
  fullBleed = false,
}: {
  load: () => Promise<ChannelThread[]>;
  placeName: string;
  currentThreadId: string | null | undefined;
  onPick: (thread: ChannelThread) => void;
  onOpenChange?: (open: boolean) => void;
  fullBleed?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { open, toggle, close } = useDismissableMenu(rootRef, triggerRef);
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const reqRef = useRef(0);

  const loadRef = useRef(loadChats);
  loadRef.current = loadChats;
  const fetchList = useCallback(() => {
    const req = ++reqRef.current;
    setLoad({ state: "loading" });
    loadRef.current().then(
      (threads) => {
        if (reqRef.current === req) setLoad({ state: "ready", threads });
      },
      () => {
        if (reqRef.current === req) setLoad({ state: "error" });
      },
    );
  }, []);

  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  useEffect(() => {
    onOpenChangeRef.current?.(open);
  }, [open]);
  useEffect(() => {
    if (open) fetchList();
  }, [open, fetchList]);

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        aria-label="Past chats"
        title="Past chats"
        aria-haspopup="dialog"
        aria-expanded={open}
        className={cx(
          "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-cta text-inkLight hover:bg-bone hover:text-ink",
          fullBleed && "h-10 w-10 text-ink",
          open && "bg-bone text-ink",
          FOCUS_RING,
        )}
      >
        <History className="h-[18px] w-[18px]" aria-hidden />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={`Past chats on ${placeName}`}
          className={cx(
            "z-30 max-h-[420px] overflow-y-auto rounded-xl border border-rule bg-cream py-1 shadow-lg",
            fullBleed ? "fixed inset-x-4 top-16" : "absolute right-0 top-full mt-2 w-[320px]",
          )}
        >
          <p className="px-3 pb-1 pt-2 text-[12px] font-semibold uppercase tracking-wide text-inkMuted">
            Past chats
          </p>
          {load.state === "loading" && (
            <p className="px-3 py-3 text-[13px] text-inkMuted">Loading…</p>
          )}
          {load.state === "error" && (
            <div className="flex items-center justify-between gap-2 px-3 py-3 text-[13px] text-inkMuted">
              <span>Couldn&apos;t load your past chats.</span>
              <button
                type="button"
                onClick={fetchList}
                className={cx("rounded-cta px-2 py-1 font-medium text-ink hover:bg-bone", FOCUS_RING)}
              >
                Retry
              </button>
            </div>
          )}
          {load.state === "ready" && load.threads.length === 0 && (
            <p className="px-3 py-3 text-[13px] text-inkMuted">
              No earlier chats on {placeName} yet.
            </p>
          )}
          {load.state === "ready" && load.threads.length > 0 && (
            <ul>
              {load.threads.map((t) => {
                const current = t.id === currentThreadId;
                const title =
                  stripChannelMention(t.title?.trim() ?? null) || t.preview || "Untitled chat";
                return (
                  <li key={t.id}>
                    <button
                      type="button"
                      aria-current={current ? "true" : undefined}
                      onClick={() => {
                        onPick(t);
                        close(false);
                      }}
                      className={cx(
                        "block w-full px-3 py-2 text-left hover:bg-bone",
                        current && "bg-creamDeep",
                        FOCUS_RING,
                      )}
                    >
                      <span className="flex items-baseline gap-2">
                        <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">
                          {title}
                        </span>
                        {t.from_home && (
                          <span className="shrink-0 rounded-full bg-creamDeep px-2 py-0.5 text-[11px] font-medium text-inkMuted">
                            from Home
                          </span>
                        )}
                        {t.from_email && (
                          <span className="shrink-0 rounded-full bg-creamDeep px-2 py-0.5 text-[11px] font-medium text-inkMuted">
                            Email
                          </span>
                        )}
                        {current ? (
                          <span className="shrink-0 rounded-full bg-ink px-2 py-0.5 text-[11px] font-medium text-white">
                            Current
                          </span>
                        ) : (
                          <span className="shrink-0 text-[12px] text-inkMuted">
                            {relativeTime(t.last_message_at)}
                          </span>
                        )}
                      </span>
                      {t.card_title && (
                        <span className="mt-0.5 block truncate text-[11px] font-medium text-inkMuted">
                          {t.card_title}
                        </span>
                      )}
                      {t.preview && (
                        <span className="mt-0.5 block truncate text-[13px] text-inkMuted">
                          {t.preview}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
