
import { apiFetch } from "@/lib/api";
import { registerSessionScopedCache } from "./sessionScopedCache";
import type { TabDescriptor } from "./types";

export type TabSessionState = {
  tabs: TabDescriptor[];
  active_tab_id: string | null;
};

export async function loadTabs(): Promise<TabSessionState> {
  try {
    const res = await apiFetch("/api/workspace/tabs-session");
    if (!res.ok) return { tabs: [], active_tab_id: null };
    return (await res.json()) as TabSessionState;
  } catch {
    return { tabs: [], active_tab_id: null };
  }
}

export const MAX_PERSISTED_TABS = 20;

export function capTabsForPersist<T extends { id: string; kind: string }>(
  tabs: T[],
  activeTabId: string | null,
  max: number = MAX_PERSISTED_TABS,
): T[] {
  if (tabs.length <= max) return tabs;
  const keep = new Set<number>();
  const home = tabs.findIndex((t) => t.kind === "home");
  if (home !== -1) keep.add(home);
  const active = activeTabId ? tabs.findIndex((t) => t.id === activeTabId) : -1;
  if (active !== -1 && keep.size < max) keep.add(active);
  for (let i = tabs.length - 1; i >= 0 && keep.size < max; i--) keep.add(i);
  return tabs.filter((_, i) => keep.has(i));
}

let pendingTimer: ReturnType<typeof setTimeout> | null = null;
let lastPayload: TabSessionState | null = null;

let lastSavedBody: string | null = null;
let saving = false;
let queuedBody: string | null = null;

function saveTabs(payload: TabSessionState, keepalive = false): void {
  sendTabs(JSON.stringify({ tabs: payload.tabs, active_tab_id: payload.active_tab_id }), keepalive);
}

function sendTabs(body: string, keepalive = false): void {
  registerSessionScopedCache(() => {
    lastSavedBody = null;
    queuedBody = null;
  });
  if (keepalive) queuedBody = null;
  else if (saving) {
    queuedBody = body;
    return;
  }
  if (body === lastSavedBody) return;
  saving = true;
  void apiFetch("/api/workspace/tabs-session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    ...(keepalive ? { keepalive: true } : {}),
  })
    .then((res) => {
      lastSavedBody = res?.ok ? body : null;
    })
    .catch(() => {
      lastSavedBody = null;
    })
    .finally(() => {
      saving = false;
      const next = queuedBody;
      queuedBody = null;
      if (next !== null) sendTabs(next);
    });
}

export function persistTabs(state: TabSessionState): void {
  lastPayload = state;
  if (pendingTimer) return;
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    const payload = lastPayload;
    lastPayload = null;
    if (!payload) return;
    saveTabs(payload);
  }, 500);
}

export function flushTabs(): void {
  if (!pendingTimer || !lastPayload) return;
  const payload = lastPayload;
  clearTimeout(pendingTimer);
  pendingTimer = null;
  lastPayload = null;
  saveTabs(payload, true);
}
