"use client";

import { useCallback, useSyncExternalStore } from "react";
import { apiFetch } from "@/lib/api";

export type AppReadiness = "checking" | "ready" | "suspended" | "slow";

export const READINESS_POLL_MS = 2500;
export const READINESS_SLOW_AFTER_MS = 180_000;
export const READINESS_SLOW_POLL_MS = 10_000;
export const READY_CACHE_MS = 600_000;

const GATED_HOST_SUFFIXES = [".onrender.com", ".zaviagent.com", ".e2b.app", ".e2b.dev"];
const SANDBOX_HOST_SUFFIXES = [".e2b.app", ".e2b.dev"];

function isSandboxKey(key: string): boolean {
  try {
    const host = new URL(key).hostname.toLowerCase();
    return SANDBOX_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
  } catch {
    return false;
  }
}

type Stream = {
  key: string;
  state: AppReadiness;
  listeners: Set<() => void>;
  startedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  controller: AbortController | null;
  stopped: boolean;
};

const readyUntil = new Map<string, number>();
const streams = new Map<string, Stream>();

export function readinessKey(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (parsed.protocol !== "https:") return null;
    if (!GATED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function cachedReady(key: string): boolean {
  const until = readyUntil.get(key);
  return until !== undefined && until > Date.now();
}

function snapshot(key: string | null): AppReadiness {
  if (!key) return "ready";
  const stream = streams.get(key);
  if (stream) return stream.state;
  return cachedReady(key) ? "ready" : "checking";
}

function publish(stream: Stream, state: AppReadiness) {
  if (stream.stopped || stream.state === state) return;
  stream.state = state;
  for (const listener of Array.from(stream.listeners)) listener();
}

function clearPending(stream: Stream) {
  if (stream.timer) clearTimeout(stream.timer);
  stream.timer = null;
  stream.controller?.abort();
  stream.controller = null;
}

async function probe(stream: Stream) {
  if (stream.stopped) return;
  const controller = new AbortController();
  stream.controller = controller;
  const sandbox = isSandboxKey(stream.key);
  let answer: string | null = null;
  try {
    const res = await apiFetch(
      `/api/workspace/app-preview/readiness?url=${encodeURIComponent(stream.key)}`,
      { signal: controller.signal },
    );
    if (res.ok) {
      const body = (await res.json().catch(() => null)) as { state?: unknown } | null;
      answer = typeof body?.state === "string" ? body.state : null;
    } else if (sandbox && res.status !== 400) {
      answer = "waking";
    }
  } catch {
    answer = sandbox ? "waking" : null;
  }
  if (stream.stopped || stream.controller !== controller) return;
  stream.controller = null;

  if (answer === "ready") {
    if (!sandbox) readyUntil.set(stream.key, Date.now() + READY_CACHE_MS);
    publish(stream, "ready");
    return;
  }
  if (answer === "suspended") {
    publish(stream, "suspended");
    return;
  }
  if (answer !== "waking") {
    publish(stream, "ready");
    return;
  }
  const slow = Date.now() - stream.startedAt >= READINESS_SLOW_AFTER_MS;
  if (slow) publish(stream, "slow");
  stream.timer = setTimeout(() => {
    stream.timer = null;
    void probe(stream);
  }, slow ? READINESS_SLOW_POLL_MS : READINESS_POLL_MS);
}

function subscribe(key: string, listener: () => void): () => void {
  let stream = streams.get(key);
  if (!stream) {
    const ready = cachedReady(key);
    stream = {
      key,
      state: ready ? "ready" : "checking",
      listeners: new Set(),
      startedAt: Date.now(),
      timer: null,
      controller: null,
      stopped: false,
    };
    streams.set(key, stream);
    if (!ready) void probe(stream);
  }
  const owned = stream;
  owned.listeners.add(listener);
  return () => {
    owned.listeners.delete(listener);
    if (owned.listeners.size > 0) return;
    owned.stopped = true;
    clearPending(owned);
    if (streams.get(key) === owned) streams.delete(key);
  };
}

function recheck(key: string) {
  const stream = streams.get(key);
  if (!stream || stream.stopped || stream.state === "ready") return;
  clearPending(stream);
  stream.startedAt = Date.now();
  publish(stream, "checking");
  void probe(stream);
}

const noop = () => {};

export function useAppReadiness(url: string | null | undefined): {
  state: AppReadiness;
  retry: () => void;
} {
  const key = readinessKey(url);
  const subscribeKey = useCallback(
    (listener: () => void) => (key ? subscribe(key, listener) : noop),
    [key],
  );
  const read = useCallback(() => snapshot(key), [key]);
  const state = useSyncExternalStore(subscribeKey, read, read);
  const retry = useCallback(() => {
    if (key) recheck(key);
  }, [key]);
  return { state, retry };
}
