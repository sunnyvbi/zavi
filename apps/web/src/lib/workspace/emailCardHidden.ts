import { useSyncExternalStore } from "react";

const KEY = "zavi_email_cards_hidden";
const CAP = 200;
const CHANGED = "zavi:email-card-hidden";
const EMPTY: ReadonlySet<string> = new Set();

let cachedRaw: string | null = null;
let cachedSet: ReadonlySet<string> = EMPTY;

let memory: string[] = [];

function readIds(): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return memory;
  }
}

function writeIds(ids: string[]): void {
  memory = ids;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(ids));
  } catch {
    memory = ids;
  }
  window.dispatchEvent(new Event(CHANGED));
}

const currentIds = readIds;

export function hiddenEmailCards(): ReadonlySet<string> {
  if (typeof window === "undefined") return EMPTY;
  const ids = currentIds();
  const raw = ids.join(",");
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedSet = new Set(ids);
  }
  return cachedSet;
}

export function hideEmailCard(id: string): void {
  if (typeof window === "undefined") return;
  const ids = currentIds();
  if (ids.includes(id)) return;
  writeIds([...ids, id].slice(-CAP));
}

export function unhideEmailCard(id: string): void {
  if (typeof window === "undefined") return;
  const ids = currentIds();
  if (!ids.includes(id)) return;
  writeIds(ids.filter((x) => x !== id));
}

function subscribe(listener: () => void): () => void {
  window.addEventListener(CHANGED, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(CHANGED, listener);
    window.removeEventListener("storage", listener);
  };
}

export function useHiddenEmailCards(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, hiddenEmailCards, () => EMPTY);
}

export function useEmailCardHidden(id: string): boolean {
  return useHiddenEmailCards().has(id);
}
