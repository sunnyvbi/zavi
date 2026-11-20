import { useSyncExternalStore } from "react";
import type { RangeKey } from "./model";

let current: RangeKey = "30d";
const listeners = new Set<() => void>();

export function setAnalyticsRange(next: RangeKey) {
  if (next === current) return;
  current = next;
  listeners.forEach((l) => l());
}

export function useAnalyticsRange(): RangeKey {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}
