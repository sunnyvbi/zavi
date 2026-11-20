"use client";

import { useCallback, useSyncExternalStore } from "react";

import { COMPACT_VIEWPORT_MAX_PX } from "@/components/workspace/layout/columnLayout";

export const COMPACT_MAX_PX = COMPACT_VIEWPORT_MAX_PX;

export const COMPACT_QUERY = `(max-width: ${COMPACT_MAX_PX}px)`;

const hasMatchMedia = () =>
  typeof window !== "undefined" && typeof window.matchMedia === "function";

const serverSnapshot = () => false;

export function useMediaMatch(query: string) {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!hasMatchMedia()) return () => {};
      const media = window.matchMedia(query);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    [query],
  );
  const getSnapshot = useCallback(
    () => (hasMatchMedia() ? window.matchMedia(query).matches : false),
    [query],
  );
  return useSyncExternalStore(subscribe, getSnapshot, serverSnapshot);
}

export function useIsCompact() {
  return useMediaMatch(COMPACT_QUERY);
}
