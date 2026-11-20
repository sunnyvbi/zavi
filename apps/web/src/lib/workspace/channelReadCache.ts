"use client";

import { createBrowserSupabase } from "@/lib/supabase";
import { getActiveTenantId } from "@/lib/active-tenant-client";
import { registerSessionScopedCache } from "./sessionScopedCache";
import { TENANT_SWITCH_EVENT } from "./tenantSwitch";

type Entry = { data: unknown; at: number };
export type ChannelCacheHit<T> = { data: T; at: number };

const STORAGE_PREFIX = "zavi:channel-read:v1:";
export const CHANNEL_READ_MAX_AGE_MS = 30 * 60 * 1000;
const MAX_PERSIST_CHARS = 400_000;

const g = globalThis as { __zaviChannelReadCache?: Map<string, Entry> };
const memory = (g.__zaviChannelReadCache ??= new Map<string, Entry>());
const TENANT_TAG_KEY = `${STORAGE_PREFIX}__tenant`;
let registered = false;
let tenantId: string | null = null;
let generation = 0;
let lookupStarted = false;
let offUntilReload = false;

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

function register(): void {
  startTenantLookup();
  if (registered) return;
  registered = true;
  registerSessionScopedCache(endChannelReadCache);
  if (typeof window !== "undefined") window.addEventListener(TENANT_SWITCH_EVENT, endChannelReadCache);
}

function startTenantLookup(): void {
  if (offUntilReload || lookupStarted || tenantId !== null) return;
  lookupStarted = true;
  void resolveTenant();
}

async function resolveTenant(): Promise<void> {
  const gen = generation;
  let id: string | null = null;
  try {
    id = await getActiveTenantId(createBrowserSupabase());
  } catch {
    id = null;
  }
  if (gen !== generation) return;
  if (!id) {
    lookupStarted = false;
    return;
  }
  tenantId = id;
  const store = storage();
  if (!store) return;
  try {
    if (store.getItem(TENANT_TAG_KEY) !== id) {
      clearPersisted(store);
      store.setItem(TENANT_TAG_KEY, id);
    }
  } catch {
  }
}

function scoped(key: string): string | null {
  return tenantId === null ? null : `${tenantId}:${key}`;
}

export function readChannelCacheEntry<T>(
  key: string,
  maxAgeMs = CHANNEL_READ_MAX_AGE_MS,
): ChannelCacheHit<T> | null {
  register();
  const full = scoped(key);
  if (full === null) return null;
  let entry = memory.get(full);
  if (!entry) {
    try {
      const raw = storage()?.getItem(STORAGE_PREFIX + full);
      if (raw) {
        const parsed = JSON.parse(raw) as Entry;
        if (parsed && typeof parsed.at === "number") {
          entry = parsed;
          memory.set(full, parsed);
        }
      }
    } catch {
    }
  }
  if (!entry || Date.now() - entry.at >= maxAgeMs) return null;
  return { data: entry.data as T, at: entry.at };
}

export function readChannelCache<T>(key: string, maxAgeMs = CHANNEL_READ_MAX_AGE_MS): T | null {
  return readChannelCacheEntry<T>(key, maxAgeMs)?.data ?? null;
}

export function channelCacheAge(key: string): number | null {
  const full = scoped(key);
  const entry = full === null ? undefined : memory.get(full);
  return entry ? Date.now() - entry.at : null;
}

export function writeChannelCache(key: string, data: unknown): void {
  register();
  const full = scoped(key);
  if (full === null) return;
  const entry: Entry = { data, at: Date.now() };
  memory.set(full, entry);
  const store = storage();
  if (!store) return;
  try {
    const raw = JSON.stringify(entry);
    if (raw.length > MAX_PERSIST_CHARS) {
      store.removeItem(STORAGE_PREFIX + full);
      return;
    }
    store.setItem(STORAGE_PREFIX + full, raw);
  } catch {
    clearPersisted(store);
  }
}

function clearPersisted(store: Storage): void {
  try {
    const mine: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (k?.startsWith(STORAGE_PREFIX)) mine.push(k);
    }
    for (const k of mine) store.removeItem(k);
  } catch {
  }
}

export function clearChannelReadCache(): void {
  offUntilReload = false;
  memory.clear();
  tenantId = null;
  lookupStarted = false;
  generation++;
  const store = storage();
  if (store) clearPersisted(store);
}

export function endChannelReadCache(): void {
  clearChannelReadCache();
  offUntilReload = true;
}

if (typeof window !== "undefined") register();
