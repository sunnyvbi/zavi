import { useSyncExternalStore } from "react";

let slot: HTMLElement | null = null;
const listeners = new Set<() => void>();

export function setEmailRunSlot(el: HTMLElement | null): void {
  slot = el;
  listeners.forEach((notify) => notify());
}

function subscribe(notify: () => void): () => void {
  listeners.add(notify);
  return () => {
    listeners.delete(notify);
  };
}

export function useEmailRunSlot(): HTMLElement | null {
  return useSyncExternalStore(subscribe, () => slot, () => null);
}
