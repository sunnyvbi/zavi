import { beforeEach } from "vitest";

if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

if (typeof Element !== "undefined" && typeof Element.prototype.animate !== "function") {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Element.prototype as any).animate = () => ({
    cancel: () => {},
    finish: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  });
}

(globalThis as { __ZAVI_READ_BACKOFF_MS__?: number[] }).__ZAVI_READ_BACKOFF_MS__ = [0, 0];

if (typeof navigator !== "undefined" && !navigator.locks) {
  const locks = new Map<string, Promise<unknown>>();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: <T>(name: string, optionsOrRun: LockOptions | ((lock: Lock | null) => T | Promise<T>), callback?: (lock: Lock | null) => T | Promise<T>): Promise<T> => {
        const run = typeof optionsOrRun === "function" ? optionsOrRun : callback;
        if (!run) throw new Error("A lock callback is required.");
        const mode = typeof optionsOrRun === "function" ? "exclusive" : optionsOrRun.mode ?? "exclusive";
        const previous = locks.get(name) ?? Promise.resolve();
        const next = previous.catch(() => undefined).then(() => run({ name, mode }));
        locks.set(name, next);
        return next.finally(() => { if (locks.get(name) === next) locks.delete(name); });
      },
    },
  });
}

beforeEach(() => {
  (globalThis as { __zaviChannelReadCache?: Map<string, unknown> }).__zaviChannelReadCache?.clear();
  (globalThis as { __zaviSharedReads?: Map<string, unknown> }).__zaviSharedReads?.clear();
  (globalThis as { __zaviHistoryReads?: Map<string, unknown> }).__zaviHistoryReads?.clear();
  (globalThis as { __zaviForgetEmailTestLists?: () => void }).__zaviForgetEmailTestLists?.();
  try {
    if (typeof window === "undefined") return;
    const store = window.sessionStorage;
    const mine: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (k?.startsWith("zavi:channel-read:")) mine.push(k);
    }
    for (const k of mine) store.removeItem(k);
  } catch {
  }
});
