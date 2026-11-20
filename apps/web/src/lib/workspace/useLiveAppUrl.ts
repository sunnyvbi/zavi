"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import type { BuildPreviewKind } from "@/lib/workspace/useBuildPreview";
import { registerSessionScopedCache } from "@/lib/workspace/sessionScopedCache";

export type LiveAppUrl = { url: string | null };

export const LIVE_APP_URL_TTL_MS = 60_000;
export const LIVE_APP_URL_RETRY_MS = 15_000;

export function readShippedAppUrl(
  preview: { url?: string | null; kind?: BuildPreviewKind } | null | undefined,
): string | null {
  if (!preview || preview.kind !== "final") return null;
  const u = preview.url;
  return typeof u === "string" && u.length > 0 ? u : null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function liveAppStatusPath(threadId: string | null | undefined): string {
  return typeof threadId === "string" && UUID_RE.test(threadId)
    ? `/api/workspace/autopilot/build-status?thread_id=${encodeURIComponent(threadId)}`
    : "/api/workspace/autopilot/build-status?app=workspace";
}

type Entry = {
  value: LiveAppUrl | null;
  at: number;
  failedAt: number;
  inflight: Promise<void> | null;
};

const entries = new Map<string, Entry>();
let generation = 0;
const listeners = new Set<() => void>();

function entryFor(path: string): Entry {
  let e = entries.get(path);
  if (!e) {
    e = { value: null, at: 0, failedAt: 0, inflight: null };
    entries.set(path, e);
  }
  return e;
}

function shouldSkip(e: Entry): boolean {
  const now = Date.now();
  if (e.value !== null && now - e.at < LIVE_APP_URL_TTL_MS) return true;
  if (e.value === null && e.failedAt !== 0 && now - e.failedAt < LIVE_APP_URL_RETRY_MS) return true;
  return false;
}

function notify(): void {
  for (const l of Array.from(listeners)) l();
}

function load(path: string, key: string): Promise<void> {
  registerSessionScopedCache(__resetLiveAppUrlCache);
  const e = entryFor(key);
  if (e.inflight) return e.inflight;
  if (shouldSkip(e)) return Promise.resolve();
  const gen = generation;
  const p = (async () => {
    let value: LiveAppUrl | null = null;
    try {
      const res = await apiFetch(path);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as {
        preview?: { url?: string | null; kind?: BuildPreviewKind } | null;
      };
      value = { url: readShippedAppUrl(body.preview) };
    } catch {
      value = null;
    }
    if (gen !== generation) return;
    if (value) {
      e.value = value;
      e.at = Date.now();
      e.failedAt = 0;
    } else {
      e.failedAt = Date.now();
    }
    e.inflight = null;
    notify();
  })();
  e.inflight = p;
  return p;
}

export function useLiveAppUrl(
  enabled: boolean,
  threadId?: string | null,
  runId?: string | null,
): LiveAppUrl | null {
  const path = liveAppStatusPath(threadId);
  const key = runId ? `${path}#${runId}` : path;
  const [, bump] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const l = () => bump((n) => n + 1);
    listeners.add(l);
    void load(path, key);
    return () => {
      listeners.delete(l);
    };
  }, [enabled, path, key]);
  return enabled ? (entries.get(key)?.value ?? null) : null;
}

export function __resetLiveAppUrlCache(): void {
  generation += 1;
  entries.clear();
  notify();
}
