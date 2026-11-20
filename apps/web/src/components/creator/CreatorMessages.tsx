"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, MessageSquare, Search } from "lucide-react";
import { CREATOR_MARKETPLACE_ENABLED } from "@zavi/shared";
import { creatorApi, CreatorApiError, type CreatorThreadSummary } from "@/lib/creator/api";
import { Bone, ErrorNote, RING } from "./areaUi";
import { CreatorThreadView, MESSAGES_POLL_MS, ThreadInfo, ThreadSkeleton, initials, stamp } from "./CreatorThread";
import { markCreatorThreadSeen, readAlerts, threadAlertIds, threadLine, waitingSince } from "./CreatorInbox";

const LG = "(min-width: 1024px)";

function EmptyMessages() {
  return (
    <div className="flex flex-col items-center text-center text-muted">
      <MessageSquare className="h-8 w-8" aria-hidden="true" />
      <p className="mt-3 text-[14px]">No messages yet.</p>
    </div>
  );
}

export function CreatorMessages() {
  const params = useSearchParams();
  const router = useRouter();
  const threadId = params?.get("thread") ?? null;
  const [threads, setThreads] = useState<CreatorThreadSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    creatorApi
      .threads()
      .then((v) => setThreads(v.threads))
      .catch((e: unknown) => setError(e instanceof CreatorApiError ? e.message : "Your messages did not load."));
  }, []);

  useEffect(() => {
    let alive = true;
    const every = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      creatorApi
        .threads()
        .then((v) => {
          if (alive) setThreads(v.threads);
        })
        .catch(() => undefined);
    }, MESSAGES_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(every);
    };
  }, []);

  const open = threadId ? threads?.find((x) => x.thread_id === threadId) : undefined;
  const seeNewest = useCallback((at: string) => {
    if (threadId) markCreatorThreadSeen(threadId, at);
  }, [threadId]);
  const openSince = open ? waitingSince(open) : null;

  useEffect(() => {
    if (threadId || !threads || threads.length === 0) return;
    if (typeof window !== "undefined" && window.matchMedia(LG).matches) {
      router.replace(`/creator/messages?thread=${encodeURIComponent(threads[0].thread_id)}`);
    }
  }, [threadId, threads, router]);

  useEffect(() => {
    if (!threadId) return;
    let live = true;
    creatorApi
      .inbox()
      .then((i) => {
        if (live) void readAlerts(threadAlertIds(i.alerts, threadId));
      })
      .catch(() => {
      });
    return () => {
      live = false;
    };
  }, [threadId, openSince]);

  useEffect(() => {
    if (threadId && openSince) markCreatorThreadSeen(threadId, openSince);
  }, [threadId, openSince]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!threads || !needle) return threads ?? [];
    return threads.filter((t) => t.business_name.toLowerCase().includes(needle) || threadLine(t).line.toLowerCase().includes(needle));
  }, [threads, q]);

  const name = open?.business_name ?? null;

  return (
    <div className="grid gap-5 lg:h-[calc(100vh-128px)] lg:grid-cols-[300px_minmax(0,1fr)] xl:grid-cols-[300px_minmax(0,1fr)_300px]">
      {}
      <aside className={`${threadId ? "hidden lg:flex" : "flex"} min-h-0 flex-col rounded-2xl bg-[#f6f7f9] p-4`}>
        <h1 className="px-1 text-[28px] font-bold tracking-[-0.02em] text-foreground">Messages</h1>
        <label className="relative mt-4 block">
          <Search className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden="true" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search"
            aria-label="Search messages"
            className="h-11 w-full rounded-full border border-black/[0.1] bg-white pr-3 pl-10 text-[14px] text-foreground outline-none placeholder:text-muted focus:border-foreground/40"
          />
        </label>
        <div className="mt-4 min-h-0 flex-1 overflow-y-auto">
          {error ? (
            <ErrorNote message={error} />
          ) : !threads ? (
            <div role="status" aria-live="polite">
              <span className="sr-only">Loading messages.</span>
              <ul aria-hidden="true" className="space-y-1">
                {[0, 1, 2].map((i) => (
                  <li key={i} className="flex items-start gap-3 px-3 py-3">
                    <Bone className="size-11 shrink-0 rounded-full" />
                    <span className="min-w-0 flex-1 pt-1">
                      <Bone className="h-4 w-2/3 rounded-full" />
                      <Bone className="mt-2 h-3 w-1/2 rounded-full" />
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : threads.length === 0 ? (
            <p className="px-1 text-[14px] leading-relaxed text-muted">
              {CREATOR_MARKETPLACE_ENABLED
                ? "No messages yet. A business can message you from Find creators or from a brief you applied to."
                : "No messages yet."}
            </p>
          ) : shown.length === 0 ? (
            <p className="px-1 text-[14px] text-muted">No conversation matches &ldquo;{q}&rdquo;.</p>
          ) : (
            <ul className="space-y-1">
              {shown.map((t) => {
                const { line, tag } = threadLine(t);
                const on = t.thread_id === threadId;
                return (
                  <li key={t.thread_id}>
                    <Link
                      href={`/creator/messages?thread=${encodeURIComponent(t.thread_id)}`}
                      aria-current={on ? "page" : undefined}
                      className={`${RING} flex items-start gap-3 rounded-xl px-3 py-3 transition-colors ${on ? "bg-white shadow-[0_1px_3px_rgba(16,18,20,0.1)]" : "hover:bg-white/70"}`}
                    >
                      <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-[#e7e9ee] text-[14px] font-bold text-foreground">
                        {initials(t.business_name)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline justify-between gap-2">
                          <span className="truncate text-[14px] font-semibold text-foreground">{t.business_name}</span>
                          <span className="shrink-0 text-[12px] text-muted">{stamp(t.last_message_at)}</span>
                        </span>
                        {tag ? <span className="mt-0.5 block text-[12px] font-semibold text-[#946300]">{tag}</span> : null}
                        <span className="mt-0.5 block truncate text-[13px] text-muted">{line}</span>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </aside>

      {}
      <section className={`${threadId ? "flex" : "hidden lg:flex"} min-h-0 flex-col`}>
        {threadId ? (
          <>
            <Link href="/creator/messages" className="mb-3 inline-flex items-center gap-2 text-[14px] font-semibold text-muted hover:text-foreground lg:hidden">
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              All messages
            </Link>
            {}
            {!threads && !error ? <ThreadSkeleton /> : <CreatorThreadView key={threadId} threadId={threadId} name={name} onSeen={seeNewest} />}
          </>
        ) : threads && threads.length === 0 ? (
          <div className="flex flex-1 items-center justify-center rounded-2xl bg-[#f6f7f9]">
            <EmptyMessages />
          </div>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center text-center text-muted">
            <MessageSquare className="h-8 w-8" aria-hidden="true" />
            <p className="mt-3 text-[14px]">Pick a conversation to read it here.</p>
          </div>
        )}
      </section>

      {}
      {threadId ? (
        <aside className="hidden min-h-0 overflow-y-auto rounded-2xl bg-[#f6f7f9] p-4 xl:block">
          <ThreadInfo name={name} />
        </aside>
      ) : null}
    </div>
  );
}
