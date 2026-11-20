
type View = { threadId: string; el: () => HTMLElement | null };

const views = new Map<string, View>();

const listeners = new Set<() => void>();
let resizeFrame = 0;
function onResize() {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(notify);
}
function notify() {
  for (const fn of listeners) fn();
}

export function onThreadViewsChanged(fn: () => void): () => void {
  listeners.add(fn);
  if (listeners.size === 1 && typeof window !== "undefined") {
    window.addEventListener("resize", onResize);
  }
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0 && typeof window !== "undefined") {
      window.removeEventListener("resize", onResize);
    }
  };
}

export function setThreadView(key: string, view: View | null): void {
  if (view === null) views.delete(key);
  else views.set(key, view);
  notify();
}

function rendered(el: HTMLElement | null): el is HTMLElement {
  return el !== null && el.isConnected && el.getClientRects().length > 0;
}

export function isThreadOnScreen(threadId: string | null): boolean {
  if (threadId === null) return false;
  for (const v of views.values()) {
    if (v.threadId === threadId && rendered(v.el())) return true;
  }
  return false;
}

export function tabShowingThread(threadId: string): string | null {
  for (const v of views.values()) {
    if (v.threadId !== threadId) continue;
    const el = v.el();
    const tab = el?.closest<HTMLElement>("[data-tab-id]");
    if (!el || !tab?.dataset.tabId) continue;
    if (shownWithin(el, tab)) return tab.dataset.tabId;
  }
  return null;
}

function shownWithin(el: HTMLElement, tab: HTMLElement): boolean {
  for (let n: HTMLElement | null = el; n && n !== tab; n = n.parentElement) {
    if (getComputedStyle(n).display === "none") return false;
  }
  return true;
}

const paneRequests = new Map<string, string>();
const paneListeners = new Set<(tabId: string) => void>();

export function requestThreadPane(tabId: string, threadId: string): void {
  paneRequests.set(tabId, threadId);
  for (const fn of paneListeners) fn(tabId);
}

export function takeThreadPaneRequest(tabId: string): string | null {
  const threadId = paneRequests.get(tabId) ?? null;
  paneRequests.delete(tabId);
  return threadId;
}

export function onThreadPaneRequest(fn: (tabId: string) => void): () => void {
  paneListeners.add(fn);
  return () => paneListeners.delete(fn);
}
