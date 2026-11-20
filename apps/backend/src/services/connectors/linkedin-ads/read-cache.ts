import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const linkedinReads = new Map<string, { expires: number; value: Promise<unknown>; pending?: boolean }>();
export const linkedinBusyUntil = new Map<string, number>();
export const linkedinBusyStrikes = new Map<string, { n: number; at: number }>();
export type LinkedInAccountListEntry = { caller: string; fetched_at: number; accounts: Array<{ id: string; name: string; currency: string | null; status: string | null; billing_hold?: true }> };
export const linkedinAccountLists = new Map<string, LinkedInAccountListEntry>();
export const linkedinAccountListsInFlight = new Map<string, Promise<LinkedInAccountListEntry>>();
const kept = new Map<string, { expires: number; value: unknown }>();
let loadedFrom: string | null = null;
let saving: ReturnType<typeof setTimeout> | null = null;

function storeFile(): string | null {
  const configured = process.env.LINKEDIN_ADS_CACHE_FILE;
  if (configured) return configured;
  return process.env.VITEST ? null : join(tmpdir(), "zavi-linkedin-ads-cache.json");
}

export function loadLinkedInAdsStore(): void {
  const file = storeFile();
  if (!file || loadedFrom === file) return;
  loadedFrom = file;
  let saved: { busy?: Array<[string, number]>; reads?: Array<[string, { expires: number; value: unknown }]>; lists?: Array<[string, LinkedInAccountListEntry]> };
  try {
    saved = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return;
  }
  const now = Date.now();
  for (const [k, until] of saved.busy ?? []) {
    if (typeof until === "number" && until > now && until > (linkedinBusyUntil.get(k) ?? 0)) linkedinBusyUntil.set(k, until);
  }
  for (const [k, entry] of saved.reads ?? []) {
    if (!entry || typeof entry.expires !== "number" || entry.expires <= now || linkedinReads.has(k)) continue;
    kept.set(k, entry);
    linkedinReads.set(k, { expires: entry.expires, value: Promise.resolve(entry.value) });
  }
  for (const [k, entry] of saved.lists ?? []) {
    if (!entry || typeof entry.caller !== "string" || typeof entry.fetched_at !== "number" || !Array.isArray(entry.accounts)) continue;
    if ((linkedinAccountLists.get(k)?.fetched_at ?? -1) < entry.fetched_at) linkedinAccountLists.set(k, entry);
  }
}

export function keepLinkedInRead(key: string, expires: number, value: unknown): void {
  kept.delete(key);
  kept.set(key, { expires, value });
  if (kept.size > 500) kept.delete(kept.keys().next().value!);
  saveLinkedInAdsStore();
}

export function forgetLinkedInReads(matches: (key: string) => boolean): void {
  let changed = false;
  for (const key of [...linkedinReads.keys()]) {
    if (!matches(key)) continue;
    linkedinReads.delete(key);
    kept.delete(key);
    changed = true;
  }
  if (changed) saveLinkedInAdsStore();
}

export function saveLinkedInAdsStore(): void {
  const file = storeFile();
  if (!file || saving) return;
  saving = setTimeout(() => {
    saving = null;
    const now = Date.now();
    const busy = [...linkedinBusyUntil].filter(([, until]) => until > now);
    const reads = [...kept].filter(([k, e]) => e.expires > now && linkedinReads.has(k));
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(`${file}.tmp`, JSON.stringify({ busy, reads, lists: [...linkedinAccountLists] }), { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
    } catch {
      return;
    }
  }, 500);
  saving.unref?.();
}

export function resetLinkedInAdsReadCache(): void {
  linkedinReads.clear();
  linkedinBusyUntil.clear();
  linkedinBusyStrikes.clear();
  linkedinAccountLists.clear();
  linkedinAccountListsInFlight.clear();
  kept.clear();
  loadedFrom = null;
  if (saving) clearTimeout(saving);
  saving = null;
}
