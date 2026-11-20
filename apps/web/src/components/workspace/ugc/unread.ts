"use client";

import { useEffect, useMemo, useState } from "react";
import { callJson } from "./useCards";
import type { BusinessThreadSummary } from "./types";

export const POLL_MS = 20_000;
const SEEN_EVENT = "zavi:ugc-thread-seen";
const key = (threadId: string) => `zavi.ugc.seen.${threadId}`;

let lastThreads: BusinessThreadSummary[] | null = null;
export function cachedThreads(): BusinessThreadSummary[] | null {
  return lastThreads;
}
export function rememberThreads(threads: BusinessThreadSummary[]): void {
  lastThreads = threads;
}

export function markThreadSeen(threadId: string, at: string): void {
  try {
    const prev = localStorage.getItem(key(threadId));
    if (!prev || prev < at) localStorage.setItem(key(threadId), at);
  } catch {
  }
  window.dispatchEvent(new Event(SEEN_EVENT));
}

export function unreadFor(t: BusinessThreadSummary): number {
  const n = t.unread_count ?? (t.last_message?.sender_kind === "creator" ? 1 : 0);
  if (n === 0 || !t.thread_id) return 0;
  const newest = t.last_message?.created_at;
  try {
    const seen = localStorage.getItem(key(t.thread_id));
    if (seen && newest && seen >= newest) return 0;
  } catch {
  }
  return n;
}

export function useCreatorUnread(): Record<string, number> {
  const [threads, setThreads] = useState<BusinessThreadSummary[]>([]);
  const [seenTick, setSeenTick] = useState(0);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (document.visibilityState !== "hidden") {
        const r = await callJson<{ threads: BusinessThreadSummary[] }>("/api/creators/threads");
        if (!alive) return;
        if (r.ok) {
          rememberThreads(r.data.threads);
          setThreads(r.data.threads);
        }
      }
      if (alive) timer = setTimeout(tick, POLL_MS);
    };
    const onSeen = () => setSeenTick((n) => n + 1);
    window.addEventListener(SEEN_EVENT, onSeen);
    void tick();
    return () => {
      alive = false;
      window.removeEventListener(SEEN_EVENT, onSeen);
      if (timer) clearTimeout(timer);
    };
  }, []);
  return useMemo(() => {
    const next: Record<string, number> = {};
    for (const t of threads) next[t.human_member_id] = unreadFor(t);
    return next;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threads, seenTick]);
}

export function useCreatorUnreadTotal(): number {
  const counts = useCreatorUnread();
  return Object.values(counts).reduce((a, n) => a + n, 0);
}
