import { useSyncExternalStore } from "react";

export type EditingMessage = { id: string; draft: string | null; error: string | null };

let editing: EditingMessage | null = null;
const listeners = new Set<() => void>();

function set(next: EditingMessage | null) {
  editing = next;
  listeners.forEach((listener) => listener());
}

export function startEditingMessage(id: string) {
  set({ id, draft: null, error: null });
}

export function failEditingMessage(id: string, draft: string, error: string) {
  set({ id, draft, error });
}

export function stopEditingMessage(id: string) {
  if (editing?.id === id) set(null);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useEditingMessage(id: string | null) {
  return useSyncExternalStore(
    subscribe,
    () => (id !== null && editing?.id === id ? editing : null),
    () => null,
  );
}
