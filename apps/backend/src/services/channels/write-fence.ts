import { AsyncLocalStorage } from "node:async_hooks";

export type WriteFence = { wrote: boolean };

const fence = new AsyncLocalStorage<WriteFence>();

export const FENCED_PLATFORMS: ReadonlySet<string> = new Set(["meta_ads", "reddit_ads"]);

export function notePlatformWrite(): void {
  const state = fence.getStore();
  if (state) state.wrote = true;
}

export function runWithWriteFence<T>(state: WriteFence, fn: () => Promise<T>): Promise<T> {
  return fence.run(state, fn);
}
