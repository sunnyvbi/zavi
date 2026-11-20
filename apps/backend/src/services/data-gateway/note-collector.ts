import { AsyncLocalStorage } from "node:async_hooks";
import type { AccessNote } from "./types";

const store = new AsyncLocalStorage<AccessNote[]>();

export async function collectAccessNotes<T>(fn: () => Promise<T>): Promise<{ result: T; notes: AccessNote[] }> {
  const notes: AccessNote[] = [];
  try {
    const result = await store.run(notes, fn);
    return { result, notes };
  } catch (e) {
    if (e && typeof e === "object") {
      try {
        Object.defineProperty(e, "access_notes", { value: notes, enumerable: false, configurable: true });
      } catch {
      }
    }
    throw e;
  }
}

export function pushAccessNote(note: AccessNote): void {
  const list = store.getStore();
  if (list && list.length < 100) list.push(note);
}
