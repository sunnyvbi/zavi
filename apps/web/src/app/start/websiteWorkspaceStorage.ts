import { z } from "zod";

const KEY = "zavi.website-workspace.v1";
const INTENT_KEY = "zavi.website-activation-intent.v1";
const Workspace = z.object({
  userId: z.string(),
  host: z.string(),
  additional: z.boolean(),
  tenantId: z.string(),
  savedAt: z.number(),
});
type SavedWorkspace = z.infer<typeof Workspace>;
const ActivationIntent = Workspace.omit({ tenantId: true }).extend({ requestKey: z.string().optional() });
type SavedActivationIntent = z.infer<typeof ActivationIntent>;
const pending = new Map<string, SavedWorkspace>();
const pendingIntents = new Map<string, SavedActivationIntent>();
const keyFor = (userId: string, host: string, additional: boolean) => `${userId}:${host}:${additional}`;

function records(): SavedWorkspace[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = z.array(Workspace).safeParse(raw ? JSON.parse(raw) : []);
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

function intentRecords(): SavedActivationIntent[] {
  try {
    const raw = localStorage.getItem(INTENT_KEY);
    const parsed = z.array(ActivationIntent).safeParse(raw ? JSON.parse(raw) : []);
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

function liveIntent(userId: string, host: string, additional: boolean): SavedActivationIntent | undefined {
  const now = Date.now();
  return [...intentRecords(), pendingIntents.get(keyFor(userId, host, additional))].find((record) => record && keyFor(record.userId, record.host, record.additional) === keyFor(userId, host, additional) && record.savedAt <= now && now - record.savedAt < 24 * 60 * 60 * 1000);
}

export function hasWebsiteActivationIntent(userId: string, host: string, additional: boolean): boolean {
  return Boolean(liveIntent(userId, host, additional));
}

export function saveWebsiteActivationIntent(userId: string, host: string, additional: boolean): string {
  const requestKey = liveIntent(userId, host, additional)?.requestKey ?? newRequestKey();
  const intent = { userId, host, additional, savedAt: Date.now(), requestKey };
  pendingIntents.set(keyFor(userId, host, additional), intent);
  try {
    localStorage.setItem(INTENT_KEY, JSON.stringify([...intentRecords().filter((record) => keyFor(record.userId, record.host, record.additional) !== keyFor(userId, host, additional)), intent].slice(-3)));
  } catch {}
  return requestKey;
}

function newRequestKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `activate-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function clearWebsiteActivationIntent(userId: string, host: string, additional: boolean) {
  pendingIntents.delete(keyFor(userId, host, additional));
  try {
    localStorage.setItem(INTENT_KEY, JSON.stringify(intentRecords().filter((record) => keyFor(record.userId, record.host, record.additional) !== keyFor(userId, host, additional))));
  } catch {}
}

export function readWebsiteWorkspace(userId: string, host: string, additional: boolean): string | null {
  const now = Date.now();
  const saved = [...records(), pending.get(keyFor(userId, host, additional))].find((record) =>
    record?.userId === userId && record.host === host && record.additional === additional &&
    record.savedAt <= now && now - record.savedAt < 24 * 60 * 60 * 1000,
  );
  return saved?.tenantId ?? null;
}

export function saveWebsiteWorkspace(userId: string, host: string, additional: boolean, tenantId: string) {
  const saved = { userId, host, additional, tenantId, savedAt: Date.now() };
  pending.set(keyFor(userId, host, additional), saved);
  if (pending.size > 3) pending.delete(pending.keys().next().value ?? "");
  try {
    localStorage.setItem(KEY, JSON.stringify([...records().filter((record) => keyFor(record.userId, record.host, record.additional) !== keyFor(userId, host, additional)), saved].slice(-3)));
  } catch {}
}

export function clearWebsiteWorkspace(userId: string, host: string, additional: boolean) {
  pending.delete(keyFor(userId, host, additional));
  try {
    localStorage.setItem(KEY, JSON.stringify(records().filter((record) => keyFor(record.userId, record.host, record.additional) !== keyFor(userId, host, additional))));
  } catch {}
  clearWebsiteActivationIntent(userId, host, additional);
}
