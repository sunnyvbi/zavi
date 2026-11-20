"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";

export const MAIN_AGENT_SLUGS: string[] = [
  "operator",
  "pm",
  "engineer",
  "cgo",
];

export function isMainAgent(slug: string): boolean {
  return MAIN_AGENT_SLUGS.includes(slug);
}

let cached: string[] | null = null;
let loaded = false;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of Array.from(listeners)) l();
}

export function __resetAgentPinsCache(): void {
  cached = null;
  loaded = false;
  inflight = null;
  writeSeq = 0;
  writeChain = Promise.resolve();
}

function coerceExtras(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw.filter(
        (s): s is string => typeof s === "string" && !isMainAgent(s),
      )
    : [];
}

function load(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await apiFetch("/api/workspace/agent-pins");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { pinned_slugs?: unknown };
      cached = coerceExtras(body.pinned_slugs);
      loaded = true;
    } catch {
      cached = [];
      loaded = true;
    } finally {
      inflight = null;
      notify();
    }
  })();
  return inflight;
}

let writeSeq = 0;
let writeChain: Promise<void> = Promise.resolve();

function persist(next: string[], prev: string[]): Promise<void> {
  cached = next;
  notify();
  const seq = ++writeSeq;

  writeChain = writeChain.then(async () => {
    if (seq !== writeSeq) return;
    try {
      const res = await apiFetch("/api/workspace/agent-pins", {
        method: "PUT",
        body: JSON.stringify({ pinned_slugs: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch {
      if (seq === writeSeq) {
        cached = prev;
        notify();
      }
    }
  });
  return writeChain;
}

export type UseAgentPins = {
  pins: string[] | null;
  isPinned: (slug: string) => boolean;
  togglePin: (slug: string) => void;
};

export function useAgentPins(): UseAgentPins {
  const [, bump] = useState(0);
  useEffect(() => {
    const l = () => bump((n) => n + 1);
    listeners.add(l);
    void load();
    return () => {
      listeners.delete(l);
    };
  }, []);

  const isPinned = useCallback(
    (slug: string) => (cached ?? []).includes(slug),
    [],
  );

  const togglePin = useCallback((slug: string) => {
    if (cached === null) return;
    if (isMainAgent(slug)) return;
    const prev = cached;
    const next = prev.includes(slug)
      ? prev.filter((s) => s !== slug)
      : [...prev, slug];
    void persist(next, prev);
  }, []);

  return { pins: cached, isPinned, togglePin };
}
