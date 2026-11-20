import { useSyncExternalStore } from "react";

export type StartAgainEntry = { status: "starting" } | { status: "started"; id: string };

const entries = new Map<string, StartAgainEntry>();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function startAgainEntry(runId: string | null | undefined): StartAgainEntry | null {
  return runId ? (entries.get(runId) ?? null) : null;
}

export function claimStartAgain(runId: string): boolean {
  if (entries.has(runId)) return false;
  entries.set(runId, { status: "starting" });
  emit();
  return true;
}

export function settleStartAgain(runId: string, newId: string | null) {
  if (newId) entries.set(runId, { status: "started", id: newId });
  else entries.delete(runId);
  emit();
}

export function useStartAgainEntry(runId: string | null | undefined): StartAgainEntry | null {
  return useSyncExternalStore(
    subscribe,
    () => startAgainEntry(runId),
    () => null,
  );
}

export function _resetStartAgainGuardForTests() {
  entries.clear();
  emit();
}
