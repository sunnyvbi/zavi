"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { registerSessionScopedCache } from "@/lib/workspace/sessionScopedCache";
import { apiFetch } from "@/lib/api";
import {
  sortByRecency,
  threadsNeedPoll,
  type ThreadMeta,
} from "./threadHistory";

const THREADS_CHANGED = "zavi:threads-changed";

export type WorkspaceThreadMeta = ThreadMeta & { agent_slug: string };

export function notifyThreadsChanged() {
  window.dispatchEvent(new Event(THREADS_CHANGED));
}

function useThreadsChangedSignal(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const bump = () => setVersion((v) => v + 1);
    const onVisible = () => {
      if (document.visibilityState === "visible") bump();
    };
    window.addEventListener(THREADS_CHANGED, bump);
    window.addEventListener("focus", bump);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener(THREADS_CHANGED, bump);
      window.removeEventListener("focus", bump);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return version;
}

export function useAgentThreads(
  slug: string | null,
  refreshKey: string | null | undefined,
) {
  const [threads, setThreads] = useState<ThreadMeta[]>([]);
  const version = useThreadsChangedSignal();
  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    void apiFetch(`/api/agents/${encodeURIComponent(slug)}/threads`)
      .then(async (res) => {
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { threads?: ThreadMeta[] };
        if (!cancelled) setThreads(sortByRecency(data.threads ?? []));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [slug, refreshKey, version]);
  return threads;
}

export type WorkspaceThreadsSnapshot = {
  threads: WorkspaceThreadMeta[];
  loaded: boolean;
};

const EMPTY_WORKSPACE_THREADS: WorkspaceThreadsSnapshot = {
  threads: [],
  loaded: false,
};
const REFOCUS_COALESCE_MS = 3_000;
const LIVE_STATUS_POLL_MS = 10_000;

let wsSnapshot: WorkspaceThreadsSnapshot = EMPTY_WORKSPACE_THREADS;
let wsInflight: Promise<void> | null = null;
let wsFollowUp = false;
let wsLastStartedAt = 0;
let wsGeneration = 0;
const wsListeners = new Set<() => void>();

function emitWorkspaceThreads(): void {
  for (const listener of wsListeners) listener();
}

function resetWorkspaceThreads(): void {
  wsGeneration += 1;
  wsSnapshot = EMPTY_WORKSPACE_THREADS;
  wsInflight = null;
  wsFollowUp = false;
  wsLastStartedAt = 0;
  emitWorkspaceThreads();
}

export function __resetWorkspaceThreadsForTest(): void {
  resetWorkspaceThreads();
}

function refreshWorkspaceThreads(opts: { coalesce?: boolean } = {}): void {
  if (wsInflight) {
    if (!opts.coalesce) wsFollowUp = true;
    return;
  }
  if (opts.coalesce && Date.now() - wsLastStartedAt < REFOCUS_COALESCE_MS) {
    return;
  }
  const generation = wsGeneration;
  wsLastStartedAt = Date.now();
  wsInflight = (async () => {
    try {
      const res = await apiFetch("/api/workspace/threads");
      if (!res.ok || generation !== wsGeneration) return;
      const data = (await res.json()) as { threads?: WorkspaceThreadMeta[] };
      if (generation !== wsGeneration) return;
      wsSnapshot = {
        threads: sortByRecency(data.threads ?? []) as WorkspaceThreadMeta[],
        loaded: true,
      };
      registerSessionScopedCache(resetWorkspaceThreads);
      emitWorkspaceThreads();
    } catch {
    }
  })().finally(() => {
    if (generation !== wsGeneration) return;
    wsInflight = null;
    if (wsFollowUp) {
      wsFollowUp = false;
      refreshWorkspaceThreads();
    }
  });
}

const onThreadsChanged = () => refreshWorkspaceThreads();
const onRefocus = () => refreshWorkspaceThreads({ coalesce: true });
const onVisibility = () => {
  if (document.visibilityState === "visible") onRefocus();
};

function subscribeWorkspaceThreads(listener: () => void): () => void {
  if (wsListeners.size === 0) {
    window.addEventListener(THREADS_CHANGED, onThreadsChanged);
    window.addEventListener("focus", onRefocus);
    document.addEventListener("visibilitychange", onVisibility);
  }
  wsListeners.add(listener);
  return () => {
    wsListeners.delete(listener);
    if (wsListeners.size === 0) {
      window.removeEventListener(THREADS_CHANGED, onThreadsChanged);
      window.removeEventListener("focus", onRefocus);
      document.removeEventListener("visibilitychange", onVisibility);
    }
  };
}

export function useWorkspaceThreads(): {
  threads: WorkspaceThreadMeta[];
  loaded: boolean;
  refresh: () => void;
} {
  const snapshot = useSyncExternalStore(
    subscribeWorkspaceThreads,
    () => wsSnapshot,
    () => EMPTY_WORKSPACE_THREADS,
  );
  useEffect(() => {
    refreshWorkspaceThreads({ coalesce: true });
  }, []);
  const needPoll = threadsNeedPoll(snapshot.threads);
  useEffect(() => {
    if (!needPoll) return;
    const id = window.setInterval(() => {
      if (!document.hidden) refreshWorkspaceThreads();
    }, LIVE_STATUS_POLL_MS);
    return () => window.clearInterval(id);
  }, [needPoll]);
  const refresh = useCallback(() => refreshWorkspaceThreads(), []);
  return { threads: snapshot.threads, loaded: snapshot.loaded, refresh };
}
