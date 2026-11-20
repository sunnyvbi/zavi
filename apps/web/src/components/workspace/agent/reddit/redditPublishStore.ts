import { createBrowserSupabase } from "@/lib/supabase";
import { getActiveTenantId } from "@/lib/active-tenant-client";

export type RedditPublishState = {
  status: "idle" | "posting" | "posted" | "scheduled" | "unconfirmed" | "refused" | "approval_required";
  error: string | null;
  decisionId: string | null;
  targetKey?: string;
};

export const REDDIT_PUBLISH_IDLE: RedditPublishState = { status: "idle", error: null, decisionId: null };
export const REDDIT_PUBLISH_POSTED: RedditPublishState = { status: "posted", error: null, decisionId: null };

const PREFIX = "zavi:reddit-publish:v1:";
const states = new Map<string, RedditPublishState>();
const unpersisted = new Set<string>();
const listeners = new Set<() => void>();
let tenantId: string | null = null;
let restoring: Promise<void> | null = null;

function notify() {
  listeners.forEach((listener) => listener());
}

function storageKey(key: string) {
  if (!tenantId) throw new Error("Zavi could not identify your workspace. Refresh before posting.");
  return `${PREFIX}${tenantId}:${key}`;
}

function parse(value: string): RedditPublishState {
  const row: unknown = JSON.parse(value);
  if (!row || typeof row !== "object" || !("status" in row) || !("decisionId" in row)) {
    throw new Error("Zavi could not restore the Reddit submission. Check your Reddit account before posting.");
  }
  const { status, decisionId } = row;
  if (!["posting", "posted", "scheduled", "unconfirmed", "refused", "approval_required"].includes(String(status)) || typeof decisionId !== "string") {
    throw new Error("Zavi could not restore the Reddit submission. Check your Reddit account before posting.");
  }
  return {
    status: status === "posted" || status === "scheduled" || status === "refused" || status === "approval_required" ? status : "unconfirmed",
    decisionId,
    ...("targetKey" in row && typeof row.targetKey === "string" ? { targetKey: row.targetKey } : {}),
    error: "error" in row && typeof row.error === "string" ? row.error : null,
  };
}

export function redditPublishSnapshot(key: string): RedditPublishState | undefined {
  return states.get(key);
}

export function subscribeRedditPublish(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export async function restoreRedditPublishStates(): Promise<void> {
  if (tenantId) return;
  if (restoring) return restoring;
  restoring = (async () => {
    const resolved = await getActiveTenantId(createBrowserSupabase());
    if (!resolved) throw new Error("Zavi could not identify your workspace. Refresh before posting.");
    const prefix = `${PREFIX}${resolved}:`;
    const recovered = new Map<string, RedditPublishState>();
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(prefix)) continue;
      const value = localStorage.getItem(key);
      if (value) recovered.set(key.slice(prefix.length), parse(value));
    }
    tenantId = resolved;
    recovered.forEach((state, key) => { if (!states.has(key)) states.set(key, state); });
    notify();
  })().finally(() => { restoring = null; });
  return restoring;
}

export function readRedditPublishState(key: string): RedditPublishState {
  const memoryOnly = unpersisted.has(key) ? states.get(key) : undefined;
  if (memoryOnly) return memoryOnly;
  const value = localStorage.getItem(storageKey(key));
  return value ? parse(value) : states.get(key) ?? REDDIT_PUBLISH_IDLE;
}

export function writeRedditPublishState(key: string, state: RedditPublishState, persist = true) {
  states.set(key, state);
  notify();
  if (!persist) {
    unpersisted.add(key);
    return;
  }
  unpersisted.delete(key);
  if (state.decisionId) localStorage.setItem(storageKey(key), JSON.stringify(state));
  else localStorage.removeItem(storageKey(key));
}

export function writeRedditPublishStates(keys: Iterable<string>, state: RedditPublishState, persist = true) {
  let failure: unknown;
  for (const key of keys) {
    try { writeRedditPublishState(key, state, persist); } catch (error) { failure ??= error; }
  }
  if (failure) throw failure;
}

export function verifyRedditPublishStorage() {
  const probe = storageKey("storage-check");
  try {
    localStorage.setItem(probe, "");
    localStorage.removeItem(probe);
  } catch {
    throw new Error("Your browser could not save the Reddit submission status. Enable site storage before posting.");
  }
}

export function redditPublishLockName(key: string) {
  return storageKey(key);
}

export function resetRedditPublishStates(keepStored = false) {
  states.clear();
  unpersisted.clear();
  tenantId = null;
  restoring = null;
  if (!keepStored && typeof localStorage !== "undefined") {
    const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i));
    keys.forEach((key) => { if (key?.startsWith(PREFIX)) localStorage.removeItem(key); });
  }
  notify();
}
