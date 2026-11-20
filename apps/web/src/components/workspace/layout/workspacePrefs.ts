"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

const PREF_CHANGED_EVENT = "zavi:pref-changed";

export function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {}
}

export function useStoredFlag(key: string, autoDefault: () => boolean) {
  const [value, setValue] = useState(false);
  useEffect(() => {
    const stored = readStored(key);
    setValue(stored === null ? autoDefault() : stored === "1");
  }, [key, autoDefault]);
  const set = useCallback(
    (next: boolean) => {
      setValue(next);
      writeStored(key, next ? "1" : "0");
    },
    [key],
  );
  return [value, set] as const;
}

function subscribe(onChange: () => void) {
  window.addEventListener(PREF_CHANGED_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(PREF_CHANGED_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

