"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import type { MemoryApi, MemoryWriteItem, MemoryWrites } from "./writesApi";

export const POLL_DELAYS_MS = [2_000, 4_000, 8_000, 15_000, 30_000] as const;

const CACHE_MAX = 500;
const cache = new Map<string, MemoryWrites | null>();
const inflight = new Map<string, Promise<MemoryWrites | null>>();

function remember(runId: string, value: MemoryWrites | null) {
  cache.delete(runId);
  cache.set(runId, value);
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

export function __resetMemoryWritesCache(): void {
  cache.clear();
  inflight.clear();
}

export function dropCachedItem(runId: string, noteId: string): void {
  const hit = cache.get(runId);
  if (!hit) return;
  remember(runId, { ...hit, items: hit.items.filter((i) => i.note_id !== noteId) });
}

export function dropCachedNote(noteId: string): void {
  const runs = [...cache].filter(([, hit]) => hit?.items.some((i) => i.note_id === noteId)).map(([r]) => r);
  for (const runId of runs) dropCachedItem(runId, noteId);
}

function load(api: MemoryApi, runId: string): Promise<MemoryWrites | null> {
  const running = inflight.get(runId);
  if (running) return running;
  const p = api
    .getWrites({ runId })
    .then((v) => {
      if (!v || v.status === "done") remember(runId, v);
      return v;
    })
    .finally(() => inflight.delete(runId));
  inflight.set(runId, p);
  return p;
}

export type MemoryWritesState =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "done"; items: MemoryWriteItem[] }
  | { status: "none" };

export function useMemoryWrites(
  runId: string | null | undefined,
  api: MemoryApi,
  enabled: boolean,
): MemoryWritesState {
  const cached = runId ? cache.get(runId) : undefined;
  const [state, setState] = useState<MemoryWritesState>(() =>
    cached === undefined ? { status: "idle" } : cached ? { status: "done", items: cached.items } : { status: "none" },
  );

  useEffect(() => {
    if (!runId || !enabled) return;
    const hit = cache.get(runId);
    if (hit !== undefined) {
      setState(hit ? { status: "done", items: hit.items } : { status: "none" });
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = (n: number) => {
      load(api, runId).then(
        (v) => {
          if (cancelled) return;
          if (!v) return setState({ status: "none" });
          if (v.status === "done") return setState({ status: "done", items: v.items });
          if (n >= POLL_DELAYS_MS.length) return setState({ status: "none" });
          setState({ status: "pending" });
          timer = setTimeout(() => attempt(n + 1), POLL_DELAYS_MS[n]);
        },
        () => {
          if (!cancelled) setState({ status: "none" });
        },
      );
    };
    attempt(0);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [runId, api, enabled]);

  return state;
}

export function useSeenOnce(ref: RefObject<Element | null>): boolean {
  const [seen, setSeen] = useState(false);
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      done.current = true;
      setSeen(true);
      return;
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        done.current = true;
        setSeen(true);
        io.disconnect();
      }
    });
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return seen;
}
