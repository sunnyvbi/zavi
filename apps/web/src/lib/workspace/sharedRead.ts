"use client";

import { apiFetch } from "@/lib/api";
import { registerSessionScopedCache } from "./sessionScopedCache";
import { TENANT_SWITCH_EVENT } from "./tenantSwitch";

export const SHARED_READ_JOIN_MS = 10_000;
const g = globalThis as { __zaviSharedReads?: Map<string, { read: Promise<unknown>; at: number }> };
const inflight = (g.__zaviSharedReads ??= new Map());
let registered = false;

function clearSharedReads(): void {
  inflight.clear();
}

export function sharedJson<T>(path: string, { fresh = false }: { fresh?: boolean } = {}): Promise<T | null> {
  if (!registered) {
    registered = true;
    registerSessionScopedCache(clearSharedReads);
    if (typeof window !== "undefined") window.addEventListener(TENANT_SWITCH_EVENT, clearSharedReads);
  }
  const running = fresh ? undefined : inflight.get(path);
  if (running && Date.now() - running.at < SHARED_READ_JOIN_MS) return running.read as Promise<T | null>;
  let read: Promise<T | null> | null = null;
  read = (async (): Promise<T | null> => {
    try {
      const res = await apiFetch(path);
      return res.ok ? ((await res.json()) as T) : null;
    } catch {
      return null;
    } finally {
      if (inflight.get(path)?.read === read) inflight.delete(path);
    }
  })();
  inflight.set(path, { read, at: Date.now() });
  return read;
}
