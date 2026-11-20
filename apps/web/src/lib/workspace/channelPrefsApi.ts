import { apiFetch } from "@/lib/api";

export const POST_MODES = ["ask", "auto"] as const;
export type PostMode = (typeof POST_MODES)[number];

export const NOTIFY_KEYS = ["ready", "posted", "weekly"] as const;
export type NotifyKey = (typeof NOTIFY_KEYS)[number];

export const VOICE_MAX = 200;

export type ChannelPrefs = { mode: PostMode; voice: string; notify: readonly NotifyKey[] };

export const DEFAULT_PREFS: ChannelPrefs = { mode: "ask", voice: "", notify: ["ready", "posted"] };

export const PREF_FIELD = { mode: "post_mode", voice: "voice", notify: "notify_when" } as const;

type Row = { item?: unknown };

const items = (v: unknown): string[] =>
  Array.isArray(v) ? v.flatMap((r: Row | string) => {
    const item = typeof r === "string" ? r : r?.item;
    return typeof item === "string" ? [item] : [];
  }) : [];

const isMode = (v: string): v is PostMode => (POST_MODES as readonly string[]).includes(v);
const isNotify = (v: string): v is NotifyKey => (NOTIFY_KEYS as readonly string[]).includes(v);

export function prefsFrom(fields: Record<string, unknown> | null | undefined): ChannelPrefs {
  if (!fields) return DEFAULT_PREFS;
  const mode = items(fields[PREF_FIELD.mode])[0];
  const voice = items(fields[PREF_FIELD.voice])[0];
  const notify = fields[PREF_FIELD.notify];
  return {
    mode: mode && isMode(mode) ? mode : DEFAULT_PREFS.mode,
    voice: voice ?? DEFAULT_PREFS.voice,
    notify: notify === undefined ? DEFAULT_PREFS.notify : items(notify).filter(isNotify),
  };
}

export async function readChannelPrefs(slug: string): Promise<ChannelPrefs> {
  const res = await apiFetch(`/api/channels/${encodeURIComponent(slug)}/settings`);
  if (!res.ok) throw new Error("Zavi could not load these settings. Try again.");
  const body = (await res.json().catch(() => null)) as { fields?: Record<string, unknown> } | null;
  return prefsFrom(body?.fields);
}

export async function saveChannelPref(slug: string, field: (typeof PREF_FIELD)[keyof typeof PREF_FIELD], values: readonly string[]): Promise<void> {
  const res = await apiFetch(`/api/channels/${encodeURIComponent(slug)}/settings/${field}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items: values.map((v) => v.trim()).filter((v) => v.length > 0) }),
  });
  if (res.status === 403) throw new Error("Only a workspace owner or admin can change these settings.");
  if (!res.ok) throw new Error("That did not save. Try again.");
}
