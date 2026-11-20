import { AsyncLocalStorage } from "node:async_hooks";

const writes = new AsyncLocalStorage<() => void>();
export function withChatgptWriteTracking<T>(onWrite: () => void, run: () => Promise<T>): Promise<T> {
  const parent = writes.getStore();
  return writes.run(() => { parent?.(); onWrite(); }, run);
}
export function noteChatgptWriteAttempt(): void { writes.getStore()?.(); }
