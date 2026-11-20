import { isCreatorVideoChannel } from "@zavi/shared";

export const CREATOR_HIDDEN_KEY = "zavi.creatorCards.hidden";
export type CreatorDismissal = string | { id: string; until: number };
export const dismissalId = (entry: CreatorDismissal) => typeof entry === "string" ? entry : entry.id;
export const activeDismissals = (entries: CreatorDismissal[], now = Date.now()) =>
  entries.filter(entry => typeof entry === "string" || entry.until > now);

export function parseCreatorDismissals(raw: string | null, now = Date.now()): CreatorDismissal[] {
  try {
    const values: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(values)) return [];
    const entries: CreatorDismissal[] = [];
    for (const value of values) {
      if (typeof value === "string") {
        const suffix = "-get-creator-video";
        if (value.endsWith(suffix) && isCreatorVideoChannel(value.slice(0, -suffix.length))) continue;
        entries.push(value);
      } else if (value && typeof value.id === "string" && typeof value.until === "number" && Number.isFinite(value.until)) {
        entries.push({ id: value.id, until: value.until });
      }
    }
    return activeDismissals(entries, now).slice(-200);
  } catch { return []; }
}

export function dismissCreatorCard(entries: CreatorDismissal[], id: string, days?: number, now = Date.now()): CreatorDismissal[] {
  return [...activeDismissals(entries, now).filter(entry => dismissalId(entry) !== id),
    days ? { id, until: now + days * 86_400_000 } : id].slice(-200);
}

export const creatorDismissalsKey = (tenantId: string) => `${CREATOR_HIDDEN_KEY}:${tenantId}`;

export function readCreatorDismissals(tenantId: string | null): CreatorDismissal[] {
  if (!tenantId) return [];
  try {
    const key = creatorDismissalsKey(tenantId);
    const own = window.localStorage.getItem(key);
    if (own !== null) return parseCreatorDismissals(own);
    const legacy = window.localStorage.getItem(CREATOR_HIDDEN_KEY);
    if (legacy === null) return [];
    const adopted = parseCreatorDismissals(legacy);
    window.localStorage.setItem(key, JSON.stringify(adopted));
    window.localStorage.removeItem(CREATOR_HIDDEN_KEY);
    return adopted;
  } catch { return []; }
}

export function storeCreatorDismissal(tenantId: string | null, current: CreatorDismissal[], id: string, days?: number, now = Date.now()): CreatorDismissal[] {
  if (!tenantId) return dismissCreatorCard(current, id, days, now);
  const key = creatorDismissalsKey(tenantId);
  let base = current;
  try {
    const stored = parseCreatorDismissals(window.localStorage.getItem(key), now);
    const seen = new Set(stored.map(dismissalId));
    base = [...stored, ...current.filter(entry => !seen.has(dismissalId(entry)))];
  } catch { base = current; }
  const next = dismissCreatorCard(base, id, days, now);
  try { window.localStorage.setItem(key, JSON.stringify(next)); }
  catch { return next; }
  return next;
}

export function restoreCreatorDismissal(tenantId: string | null, current: CreatorDismissal[], id: string): CreatorDismissal[] {
  const next = current.filter((entry) => dismissalId(entry) !== id);
  if (!tenantId) return next;
  try {
    const key = creatorDismissalsKey(tenantId);
    const stored = parseCreatorDismissals(window.localStorage.getItem(key)).filter((entry) => dismissalId(entry) !== id);
    window.localStorage.setItem(key, JSON.stringify(stored));
  } catch {
    return next;
  }
  return next;
}
