"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { firstName, useUgcDrawer } from "./hub";
import { DrawerNote, SideDrawer, Thread, ThreadSkeleton, stamp, type ThreadItem } from "./ui";
import { callJson } from "./useCards";
import { cachedThreads, markThreadSeen, rememberThreads, unreadFor } from "./unread";
import type { BusinessThreadSummary, CreatorThreadMessageRow } from "./types";

const POLL_MS = 3_000;

function merge(prev: CreatorThreadMessageRow[], next: CreatorThreadMessageRow[]): CreatorThreadMessageRow[] {
  const newest = next.reduce((a, m) => (a > m.created_at ? a : m.created_at), "");
  return [...next, ...prev.filter((m) => m.created_at > newest && !next.some((x) => x.id === m.id))];
}

export function MessagesDrawerHost() {
  const { name } = useUgcDrawer();
  return name === "thread" ? <MessagesDrawer /> : null;
}

function MessagesDrawer() {
  const drawer = useUgcDrawer();
  const [threads, setThreads] = useState<BusinessThreadSummary[] | null>(cachedThreads);
  const [byThread, setByThread] = useState<Record<string, CreatorThreadMessageRow[]>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void callJson<{ threads: BusinessThreadSummary[] }>("/api/creators/threads").then((r) => {
      if (!alive) return;
      if (r.ok) {
        rememberThreads(r.data.threads);
        setThreads(r.data.threads);
      } else {
        setThreads((t) => t ?? []);
        setError(r.message);
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  const want = drawer.params.creator;
  const open = useMemo(
    () => threads?.find((t) => t.human_member_id === want) ?? threads?.[0] ?? null,
    [threads, want],
  );
  const threadId = open?.thread_id || null;

  useEffect(() => {
    if (!threadId) return;
    let alive = true;
    const read = () =>
      void callJson<{ messages: CreatorThreadMessageRow[] }>(`/api/creators/threads/${threadId}/messages`).then((r) => {
        if (alive && r.ok) setByThread((all) => ({ ...all, [threadId]: merge(all[threadId] ?? [], r.data.messages) }));
      });
    read();
    const every = window.setInterval(() => {
      if (document.visibilityState !== "hidden") read();
    }, POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(every);
    };
  }, [threadId]);

  useEffect(() => setError(null), [threadId]);

  const loaded = threadId ? byThread[threadId] : undefined;
  const newest = loaded?.reduce((a, m) => (a > m.created_at ? a : m.created_at), "") ?? "";
  useEffect(() => {
    if (threadId && newest) markThreadSeen(threadId, newest);
  }, [threadId, newest]);

  const send = useCallback(
    async (text: string): Promise<boolean> => {
      if (!threadId) return false;
      const r = await callJson<{ message: CreatorThreadMessageRow }>(`/api/creators/threads/${threadId}/messages`, {
        body: { body: text },
      });
      if (!r.ok) {
        setError(r.message);
        return false;
      }
      setError(null);
      setByThread((all) => {
        const prev = all[threadId] ?? [];
        return prev.some((m) => m.id === r.data.message.id) ? all : { ...all, [threadId]: [...prev, r.data.message] };
      });
      return true;
    },
    [threadId],
  );

  const name = open?.display_name || "the creator";
  const first = open?.display_name ? firstName(open.display_name) : "the creator";
  const items: ThreadItem[] = (loaded ?? []).map((m) => ({
    kind: "msg",
    key: m.id,
    from: m.sender_kind === "tenant" ? "me" : "them",
    text: m.body,
    at: stamp(m.created_at),
  }));

  return (
    <SideDrawer title={open?.display_name ? `Messages with ${open.display_name}` : "Messages"} onClose={drawer.close}>
      <div className="flex min-h-full flex-col">
        {threads && threads.length > 1 && (
          <nav aria-label="Conversations" className="-mx-1 mb-4 flex gap-2 overflow-x-auto px-1 pb-1">
            {threads.map((t) => {
              const on = t.thread_id === threadId;
              return (
                <button
                  key={t.thread_id}
                  type="button"
                  onClick={() => drawer.open("thread", { creator: t.human_member_id })}
                  aria-current={on ? "page" : undefined}
                  className={`inline-flex shrink-0 cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-[13px] ${on ? "border-ink bg-ink font-semibold text-cream" : "border-rule bg-cream font-medium text-inkSoft hover:bg-creamDeep"}`}
                >
                  {t.display_name || "Conversation"}
                  {!on && unreadFor(t) > 0 && (
                    <span
                      className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[#027bff] px-1 text-[11px] font-bold text-white"
                      aria-label={`${unreadFor(t)} new ${unreadFor(t) === 1 ? "message" : "messages"}`}
                    >
                      {unreadFor(t) > 99 ? "99+" : unreadFor(t)}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        )}
        {error && <p className="mb-3 rounded-lg bg-red-500/10 px-3 py-2 text-[13px] text-red-600">{error}</p>}
        {threads === null ? (
          <ThreadSkeleton />
        ) : !threadId ? (
          <DrawerNote>No conversations with creators on existing jobs.</DrawerNote>
        ) : (
          <div className="flex flex-1 flex-col">
            <p className="mb-3 text-[13px] text-inkMuted">
              Each new message emails {first}, at most one email per conversation every 15 minutes.
            </p>
            {!loaded ? (
              <div className="mb-4">
                <ThreadSkeleton />
              </div>
            ) : items.length === 0 ? (
              <p className="mb-4 rounded-xl border border-dashed border-rule px-4 py-6 text-center text-[14px] text-inkMuted">
                No messages with {first} yet.
              </p>
            ) : null}
            <Thread
              key={threadId}
              them={name}
              placeholder={`Message ${first}`}
              items={items}
              onSend={send}
              clearOnSend
              stickyComposer
              pending={!loaded}
            />
          </div>
        )}
      </div>
    </SideDrawer>
  );
}
