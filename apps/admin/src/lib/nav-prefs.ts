
import { useSyncExternalStore } from "react";
import { DEFAULT_PINS, NAV_GROUPS_KEY, NAV_PINS_KEY, parseStoredGroups, parseStoredPins, togglePin } from "@/lib/admin-nav";

export type NavPrefs = {
  pins: ReadonlyArray<string>;
  openGroups: Readonly<Record<string, boolean>>;
};

const SERVER_PREFS: NavPrefs = { pins: DEFAULT_PINS, openGroups: {} };

let current: NavPrefs | null = null;
const listeners = new Set<() => void>();

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function read(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown) {
  try {
    storage()?.setItem(key, JSON.stringify(value));
  } catch {}
}

function load(): NavPrefs {
  return { pins: parseStoredPins(read(NAV_PINS_KEY)), openGroups: parseStoredGroups(read(NAV_GROUPS_KEY)) };
}

function emit(next: NavPrefs) {
  current = next;
  for (const l of listeners) l();
}

function onStorage(e: StorageEvent) {
  if (e.key === null || e.key === NAV_PINS_KEY || e.key === NAV_GROUPS_KEY) emit(load());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

export function getNavPrefs(): NavPrefs {
  if (current === null) current = typeof window === "undefined" ? SERVER_PREFS : load();
  return current;
}

export function useNavPrefs(): NavPrefs {
  return useSyncExternalStore(subscribe, getNavPrefs, () => SERVER_PREFS);
}

export function toggleNavPin(href: string) {
  const prev = getNavPrefs();
  const pins = togglePin(prev.pins, href);
  write(NAV_PINS_KEY, pins);
  emit({ ...prev, pins });
}

export function setNavGroupOpen(key: string, open: boolean) {
  const prev = getNavPrefs();
  const openGroups = { ...prev.openGroups, [key]: open };
  write(NAV_GROUPS_KEY, openGroups);
  emit({ ...prev, openGroups });
}

export function openOnlyNavGroup(key: string) {
  const prev = getNavPrefs();
  const openGroups: Record<string, boolean> = {};
  for (const k of Object.keys(prev.openGroups)) openGroups[k] = false;
  openGroups[key] = true;
  write(NAV_GROUPS_KEY, openGroups);
  emit({ ...prev, openGroups });
}

export function resetNavPrefsForTest() {
  current = null;
}
