"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import type { ThreadFeedItem, ThreadFeedPage } from "./threadFeedTypes";

export type UseThreadsFeed = {
  threads: ThreadFeedItem[];
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  loadMore: () => void;
  reload: () => void;
};

const PAGE_SIZE = 30;

export function useThreadsFeed(agentSlug: string | null): UseThreadsFeed {
  const [threads, setThreads] = useState<ThreadFeedItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);

  const requestId = useRef(0);

  const fetchPage = useCallback(
    async (before: string | null, append: boolean) => {
      if (!agentSlug) return;
      const myId = ++requestId.current;
      if (append) setLoadingMore(true);
      else setLoading(true);
      try {
        const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
        if (before) params.set("before", before);
        const res = await apiFetch(
          `/api/agents/${encodeURIComponent(agentSlug)}/threads-feed?${params}`,
        );
        const body = (await res.json().catch(() => ({}))) as
          | (ThreadFeedPage & { error?: { message?: string } })
          | Record<string, never>;
        if (!res.ok) {
          throw new Error(
            (body as { error?: { message?: string } })?.error?.message ??
              `HTTP ${res.status}`,
          );
        }
        if (myId !== requestId.current) return;
        const page = (body as ThreadFeedPage).threads ?? [];
        setThreads((prev) => (append ? [...prev, ...page] : page));
        setCursor((body as ThreadFeedPage).next_before ?? null);
        setHasMore(Boolean((body as ThreadFeedPage).next_before));
        setError(null);
      } catch (e) {
        if (myId !== requestId.current) return;
        setError((e as Error).message);
        if (!append) {
          setThreads([]);
          setHasMore(false);
        }
      } finally {
        if (myId === requestId.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [agentSlug],
  );

  useEffect(() => {
    if (!agentSlug) {
      setThreads([]);
      setCursor(null);
      setHasMore(false);
      setError(null);
      return;
    }
    setThreads([]);
    setCursor(null);
    setHasMore(false);
    void fetchPage(null, false);
  }, [agentSlug, fetchPage]);

  const loadMore = useCallback(() => {
    if (!cursor || loadingMore || loading) return;
    void fetchPage(cursor, true);
  }, [cursor, loadingMore, loading, fetchPage]);

  const reload = useCallback(() => {
    setCursor(null);
    void fetchPage(null, false);
  }, [fetchPage]);

  return { threads, loading, loadingMore, error, hasMore, loadMore, reload };
}
