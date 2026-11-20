"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Bell, CalendarClock, MessageSquare, Sparkles } from "lucide-react";
import { creatorApi, type CreatorAlert, type CreatorJob, type CreatorThreadSummary } from "@/lib/creator/api";
import { RING } from "./areaUi";
import { INBOX_CHANGED, messagesWaiting, threadLine, unreadUpdates } from "./CreatorInbox";
import { initials, stamp } from "./CreatorThread";

export type BellFeed = { requests: CreatorJob[]; changes: CreatorJob[]; alerts: CreatorAlert[]; threads: CreatorThreadSummary[] };

function waitingThreads(threads: CreatorThreadSummary[]): CreatorThreadSummary[] {
  return threads.filter((t) => messagesWaiting([t]) > 0);
}

export function bellCount(feed: BellFeed): number {
  return messagesWaiting(feed.threads) + feed.requests.length + feed.changes.length + unreadUpdates(feed.alerts).length;
}

export function CreatorBell({ feed }: { feed: BellFeed | null }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const count = feed ? bellCount(feed) : 0;
  const threads = feed ? waitingThreads(feed.threads) : [];
  const alerts = feed ? unreadUpdates(feed.alerts) : [];
  const requests = feed?.requests ?? [];
  const changes = feed?.changes ?? [];

  const readAlert = (id: string) => {
    creatorApi
      .markAlertRead(id)
      .then(() => window.dispatchEvent(new Event(INBOX_CHANGED)))
      .catch(() => {
      });
    setOpen(false);
  };

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={count > 0 ? `Notifications, ${count} new` : "Notifications"}
        className={`${RING} relative flex size-10 items-center justify-center rounded-full text-[#0e0f11] transition-colors hover:bg-[#0e0f11]/[0.05]`}
      >
        <Bell className="size-[20px]" aria-hidden="true" />
        {count > 0 && (
          <span
            aria-hidden="true"
            className="absolute -top-0.5 -right-0.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[#e5484d] px-1 text-[11px] font-bold leading-none text-white ring-2 ring-white"
          >
            {count > 99 ? "99+" : count}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Notifications"
          className="absolute top-12 right-0 z-[60] w-[min(380px,calc(100vw-24px))] overflow-hidden rounded-2xl border border-black/[0.08] bg-white shadow-[0_24px_60px_-20px_rgba(16,18,20,0.35)]"
        >
          <div className="flex items-center justify-between border-b border-black/[0.06] px-4 py-3">
            <p className="text-[14px] font-semibold text-[#0e0f11]">Notifications</p>
            {count > 0 && <span className="text-[12px] text-[#595959]">{count} new</span>}
          </div>
          <div className="max-h-[420px] overflow-y-auto py-1.5">
            {!feed ? (
              <p className="px-4 py-6 text-center text-[14px] text-[#595959]">Loading…</p>
            ) : count === 0 ? (
              <p className="px-4 py-8 text-center text-[14px] text-[#595959]">You are all caught up.</p>
            ) : (
              <>
                {threads.map((t) => (
                  <Link
                    key={t.thread_id}
                    href={`/creator/messages?thread=${encodeURIComponent(t.thread_id)}`}
                    onClick={() => setOpen(false)}
                    className="flex items-start gap-3 px-4 py-2.5 hover:bg-[#0e0f11]/[0.03]"
                  >
                    <span className="relative flex size-9 shrink-0 items-center justify-center rounded-full bg-[#e7e9ee] text-[12px] font-bold text-[#0e0f11]">
                      {initials(t.business_name)}
                      <MessageSquare className="absolute -right-1 -bottom-1 size-4 rounded-full bg-white p-0.5 text-[#0e0f11]" aria-hidden="true" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-[14px] font-semibold text-[#0e0f11]">{t.business_name}</span>
                        <span className="shrink-0 text-[11px] text-[#595959]">{stamp(t.last_message_at)}</span>
                      </span>
                      <span className="mt-0.5 block truncate text-[13px] text-[#595959]">{threadLine(t).line}</span>
                    </span>
                  </Link>
                ))}
                {requests.length > 0 && (
                  <Link href="/creator" onClick={() => setOpen(false)} className="flex items-center gap-3 px-4 py-2.5 hover:bg-[#0e0f11]/[0.03]">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[#fbeccb] text-[#946300]">
                      <CalendarClock className="size-4" aria-hidden="true" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[14px] font-semibold text-[#0e0f11]">
                        {requests.length === 1 ? "1 booking to answer" : `${requests.length} bookings to answer`}
                      </span>
                      <span className="block text-[13px] text-[#595959]">You have 72 hours to accept or pass.</span>
                    </span>
                  </Link>
                )}
                {changes.length > 0 && (
                  <Link href="/creator" onClick={() => setOpen(false)} className="flex items-center gap-3 px-4 py-2.5 hover:bg-[#0e0f11]/[0.03]">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[#fbeccb] text-[#946300]">
                      <CalendarClock className="size-4" aria-hidden="true" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[14px] font-semibold text-[#0e0f11]">
                        {changes.length === 1 ? "1 job with changes asked" : `${changes.length} jobs with changes asked`}
                      </span>
                    </span>
                  </Link>
                )}
                {alerts.map((a) => {
                  const inner = (
                    <>
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[#0e0f11] text-white">
                        <Sparkles className="size-4" aria-hidden="true" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline justify-between gap-2">
                          <span className="truncate text-[14px] font-semibold text-[#0e0f11]">{a.title}</span>
                          <span className="shrink-0 text-[11px] text-[#595959]">{stamp(a.created_at)}</span>
                        </span>
                        {a.body && <span className="mt-0.5 block truncate text-[13px] text-[#595959]">{a.body}</span>}
                      </span>
                    </>
                  );
                  const cls = "flex w-full items-start gap-3 px-4 py-2.5 text-left hover:bg-[#0e0f11]/[0.03]";
                  return a.link_path ? (
                    <Link key={a.id} href={a.link_path} onClick={() => readAlert(a.id)} className={cls}>
                      {inner}
                    </Link>
                  ) : (
                    <button key={a.id} type="button" onClick={() => readAlert(a.id)} className={cls}>
                      {inner}
                    </button>
                  );
                })}
              </>
            )}
          </div>
          <Link
            href="/creator/messages"
            onClick={() => setOpen(false)}
            className="block border-t border-black/[0.06] px-4 py-3 text-center text-[14px] font-semibold text-[#0e0f11] hover:bg-[#0e0f11]/[0.03]"
          >
            Open Messages
          </Link>
        </div>
      )}
    </div>
  );
}
