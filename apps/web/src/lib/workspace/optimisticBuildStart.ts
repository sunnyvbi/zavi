"use client";

import { useSyncExternalStore } from "react";

const STORAGE_KEY = "zavi.buildStartingAt";
const MAX_AGE_MS = 2 * 60 * 1000;

let startedAt: number | null = null;
const listeners = new Set<() => void>();

function storedStartedAt(): number | null {
  if (typeof window === "undefined") return null;
  try {
    const value = Number(window.sessionStorage.getItem(STORAGE_KEY));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function currentStartedAt(): number | null {
  const value = startedAt ?? storedStartedAt();
  if (value === null) return null;
  if (Date.now() - value <= MAX_AGE_MS) {
    startedAt = value;
    return value;
  }
  startedAt = null;
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
  }
  return null;
}

function emit(): void {
  for (const listener of listeners) listener();
}

export function markOptimisticBuildStart(): void {
  startedAt = Date.now();
  try {
    window.sessionStorage.setItem(STORAGE_KEY, String(startedAt));
  } catch {
  }
  emit();
}

export function clearOptimisticBuildStart(): void {
  const hadSignal = startedAt !== null || storedStartedAt() !== null;
  startedAt = null;
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
  }
  if (hadSignal) emit();
}

export function hasOptimisticBuildStart(): boolean {
  return currentStartedAt() !== null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useOptimisticBuildStart(): boolean {
  return useSyncExternalStore(subscribe, hasOptimisticBuildStart, () => false);
}
