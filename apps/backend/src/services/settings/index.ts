
import { serviceClient } from "@/services/supabase";
import { applySecretListEditRpc, globalClient, StaleRevisionError } from "@/services/tenant-client";
import { seatLabelForToken } from "@/services/agents/seat-identity";
import {
  APP_SETTINGS,
  CONSENT_KEYS_PER_TENANT_ONLY,
  isSettingKey,
  type SettingDef,
  type SettingKey,
} from "./registry";

export const CONSENT_GLOBAL_WRITE_ERROR = "cannot_set_consent_globally";

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { value: unknown; expiresAt: number }>();
const rawCache = new Map<string, { value: unknown; expiresAt: number; degraded?: boolean }>();

function cacheKey(key: SettingKey, tenant_id?: string | null): string {
  return `${tenant_id ?? "global"}:${key}`;
}

export function _resetSettingsCache(): void {
  cache.clear();
  rawCache.clear();
}

export async function getAppSetting(
  key: SettingKey,
  tenant_id?: string | null,
  opts: { strict?: boolean } = {},
): Promise<unknown | undefined> {
  const strict = opts.strict === true;
  const def = APP_SETTINGS[key];
  const ck = cacheKey(key, def.scope === "per-tenant" ? tenant_id : null);
  const hit = rawCache.get(ck);
  if (hit && hit.expiresAt > Date.now() && !(strict && hit.degraded)) return hit.value;

  let resolved: unknown = undefined;
  let degraded = false;
  try {
    const sb = serviceClient();

    if (def.scope === "per-tenant" && tenant_id) {
      const { data: tRow, error: tErr } = await sb
        .from("tenant_app_setting")
        .select("value")
        .eq("tenant_id", tenant_id)
        .eq("key", key)
        .maybeSingle();
      if (tErr) {
        if (strict) throw new Error(`tenant_app_setting read failed for ${key}: ${tErr.message}`);
        degraded = true;
      }
      const tv = (tRow as { value: unknown } | null)?.value;
      if (!tErr && tv !== undefined && tv !== null) {
        rawCache.set(ck, { value: tv, expiresAt: Date.now() + CACHE_TTL_MS });
        return tv;
      }
    }

    if (CONSENT_KEYS_PER_TENANT_ONLY.has(key)) {
      rawCache.set(ck, { value: undefined, expiresAt: Date.now() + CACHE_TTL_MS, ...(degraded ? { degraded } : {}) });
      return undefined;
    }

    const { data: gRow, error: gErr } = await sb
      .from("app_setting")
      .select("value")
      .eq("key", key)
      .maybeSingle();
    if (gErr) throw new Error(`app_setting read failed for ${key}: ${gErr.message}`);
    const gv = (gRow as { value: unknown } | null)?.value;
    if (gv !== undefined && gv !== null) resolved = gv;
  } catch (e) {
    if (strict) throw e;
    resolved = undefined;
    degraded = true;
  }

  rawCache.set(ck, { value: resolved, expiresAt: Date.now() + CACHE_TTL_MS, ...(degraded ? { degraded } : {}) });
  return resolved;
}

export function coerceSettingValue(def: SettingDef, raw: unknown): unknown {
  switch (def.type) {
    case "boolean": {
      if (typeof raw === "boolean") return raw;
      if (typeof raw === "string") {
        if (raw.toLowerCase() === "true") return true;
        if (raw.toLowerCase() === "false") return false;
      }
      throw new Error(`expected boolean, got ${JSON.stringify(raw)}`);
    }
    case "number": {
      const n = Number(raw);
      if (Number.isNaN(n)) throw new Error(`expected number, got ${JSON.stringify(raw)}`);
      if (def.min !== undefined && n < def.min) throw new Error(`must be >= ${def.min}`);
      if (def.max !== undefined && n > def.max) throw new Error(`must be <= ${def.max}`);
      return n;
    }
    case "string": {
      if (typeof raw !== "string") throw new Error(`expected string, got ${typeof raw}`);
      return raw;
    }
    case "json":
      return raw;
    default:
      return raw;
  }
}

export async function getSetting(key: SettingKey, tenant_id?: string | null): Promise<unknown> {
  const def = APP_SETTINGS[key];
  const ck = cacheKey(key, def.scope === "per-tenant" ? tenant_id : null);
  const hit = cache.get(ck);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  let resolved: unknown = def.defaultValue;
  try {
    const sb = serviceClient();

    if (def.scope === "per-tenant" && tenant_id) {
      const { data: tRow } = await sb
        .from("tenant_app_setting")
        .select("value")
        .eq("tenant_id", tenant_id)
        .eq("key", key)
        .maybeSingle();
      if (tRow && (tRow as { value: unknown }).value !== undefined && (tRow as { value: unknown }).value !== null) {
        resolved = (tRow as { value: unknown }).value;
        cache.set(ck, { value: resolved, expiresAt: Date.now() + CACHE_TTL_MS });
        return resolved;
      }
    }

    if (CONSENT_KEYS_PER_TENANT_ONLY.has(key)) {
      cache.set(ck, { value: def.defaultValue, expiresAt: Date.now() + CACHE_TTL_MS });
      return def.defaultValue;
    }

    const { data: gRow } = await sb
      .from("app_setting")
      .select("value")
      .eq("key", key)
      .maybeSingle();
    if (gRow && (gRow as { value: unknown }).value !== undefined && (gRow as { value: unknown }).value !== null) {
      resolved = (gRow as { value: unknown }).value;
    }
  } catch {
    resolved = def.defaultValue;
  }

  cache.set(ck, { value: resolved, expiresAt: Date.now() + CACHE_TTL_MS });
  return resolved;
}

export async function getBoolSetting(key: SettingKey, tenant_id?: string | null): Promise<boolean> {
  const v = await getSetting(key, tenant_id);
  return v === true;
}

export async function getBoolSettingStrictResolved(key: SettingKey, tenant_id: string): Promise<boolean> {
  const def = APP_SETTINGS[key];
  const sb = serviceClient();
  const present = (row: unknown) => {
    const v = row ? (row as { value: unknown }).value : undefined;
    return v === undefined || v === null ? undefined : v;
  };
  if (def.scope === "per-tenant") {
    const { data, error } = await sb.from("tenant_app_setting").select("value").eq("tenant_id", tenant_id).eq("key", key).maybeSingle();
    if (error) throw new Error(`strict setting read failed for ${key}: ${error.message}`);
    const v = present(data);
    if (v !== undefined) return v === true;
    if (CONSENT_KEYS_PER_TENANT_ONLY.has(key)) return def.defaultValue === true;
  }
  const { data, error } = await sb.from("app_setting").select("value").eq("key", key).maybeSingle();
  if (error) throw new Error(`strict setting read failed for ${key}: ${error.message}`);
  const v = present(data);
  return v !== undefined ? v === true : def.defaultValue === true;
}

export async function getBoolSettingStrict(key: SettingKey, tenant_id: string): Promise<boolean> {
  const def = APP_SETTINGS[key];
  const { data, error } = await serviceClient()
    .from("tenant_app_setting")
    .select("value")
    .eq("tenant_id", tenant_id)
    .eq("key", key)
    .maybeSingle();
  if (error) throw new Error(`strict setting read failed for ${key}: ${error.message}`);
  const raw = data ? (data as { value: unknown }).value : undefined;
  if (raw === undefined || raw === null) return def.defaultValue === true;
  return raw === true;
}

export async function getNumberSetting(key: SettingKey, tenant_id?: string | null): Promise<number> {
  const v = await getSetting(key, tenant_id);
  const n = Number(v);
  if (Number.isFinite(n)) return n;
  const def = APP_SETTINGS[key].defaultValue;
  return typeof def === "number" ? def : 0;
}

export async function getStringSetting(key: SettingKey, tenant_id?: string | null): Promise<string> {
  const v = await getSetting(key, tenant_id);
  if (typeof v === "string") return v;
  const def = APP_SETTINGS[key].defaultValue;
  return typeof def === "string" ? def : String(def);
}

export async function getStringSettingStrict(key: SettingKey, tenant_id: string): Promise<string> {
  const def = APP_SETTINGS[key];
  const sb = serviceClient();
  const present = (row: unknown) => {
    const v = row ? (row as { value: unknown }).value : undefined;
    return v === undefined || v === null ? undefined : v;
  };
  const asString = (v: unknown): string => {
    if (typeof v !== "string") throw new Error(`strict setting read for ${key}: stored value is not a string`);
    return v;
  };
  if (def.scope === "per-tenant") {
    const { data, error } = await sb.from("tenant_app_setting").select("value").eq("tenant_id", tenant_id).eq("key", key).maybeSingle();
    if (error) throw new Error(`strict setting read failed for ${key}: ${error.message}`);
    const v = present(data);
    if (v !== undefined) return asString(v);
    if (CONSENT_KEYS_PER_TENANT_ONLY.has(key)) return asString(def.defaultValue);
  }
  const { data, error } = await sb.from("app_setting").select("value").eq("key", key).maybeSingle();
  if (error) throw new Error(`strict setting read failed for ${key}: ${error.message}`);
  const v = present(data);
  return asString(v !== undefined ? v : def.defaultValue);
}

export async function setGlobalSetting(
  key: string,
  rawValue: unknown,
  updated_by: string,
): Promise<void> {
  if (!isSettingKey(key)) throw new Error(`unknown setting key: ${key}`);
  const def = APP_SETTINGS[key];
  if ((def as SettingDef).secretList) throw new Error(`${key} is a credential list; use editSecretList`);
  const value = coerceSettingValue(def, rawValue);
  const isGlobalEnable =
    value === true ||
    (Array.isArray(value) && value.length > 0) ||
    (def.type === "string" && typeof value === "string" && value.trim() !== "" && value.trim() !== def.defaultValue);
  if (CONSENT_KEYS_PER_TENANT_ONLY.has(key) && isGlobalEnable) {
    throw new Error(CONSENT_GLOBAL_WRITE_ERROR);
  }
  const { error } = await serviceClient()
    .from("app_setting")
    .upsert(
      { key, value, value_type: def.type, description: def.description, updated_by, updated_at: new Date().toISOString() },
      { onConflict: "key" },
    );
  if (error) throw new Error(`setGlobalSetting failed: ${error.message}`);
  cache.delete(cacheKey(key as SettingKey, null));
  rawCache.delete(cacheKey(key as SettingKey, null));
}

export async function setTenantSetting(
  tenant_id: string,
  key: string,
  rawValue: unknown,
  updated_by: string,
): Promise<void> {
  if (!isSettingKey(key)) throw new Error(`unknown setting key: ${key}`);
  const def = APP_SETTINGS[key];
  if (def.scope !== "per-tenant") throw new Error(`setting ${key} is global-only, no per-tenant override`);
  const sb = serviceClient();
  if (rawValue === null) {
    const { error } = await sb.from("tenant_app_setting").delete().eq("tenant_id", tenant_id).eq("key", key);
    if (error) throw new Error(`clear tenant setting failed: ${error.message}`);
  } else {
    const value = coerceSettingValue(def, rawValue);
    const { error } = await sb
      .from("tenant_app_setting")
      .upsert(
        { tenant_id, key, value, updated_by, updated_at: new Date().toISOString() },
        { onConflict: "tenant_id,key" },
      );
    if (error) throw new Error(`setTenantSetting failed: ${error.message}`);
  }
  cache.delete(cacheKey(key as SettingKey, tenant_id));
  rawCache.delete(cacheKey(key as SettingKey, tenant_id));
}

export async function claimTenantFlag(tenant_id: string, key: SettingKey, updated_by: string): Promise<boolean> {
  const def = APP_SETTINGS[key];
  if (def.scope !== "per-tenant" || def.type !== "boolean") throw new Error(`setting ${key} is not a per-tenant boolean`);
  const { data, error } = await serviceClient()
    .from("tenant_app_setting")
    .upsert(
      { tenant_id, key, value: true, updated_by, updated_at: new Date().toISOString() },
      { onConflict: "tenant_id,key", ignoreDuplicates: true },
    )
    .select("key");
  if (error) throw new Error(`claimTenantFlag failed: ${error.message}`);
  cache.delete(cacheKey(key, tenant_id));
  rawCache.delete(cacheKey(key, tenant_id));
  return Array.isArray(data) && data.length > 0;
}

export type SettingListRow = {
  key: SettingKey;
  description: string;
  type: SettingDef["type"];
  scope: SettingDef["scope"];
  defaultValue: unknown;
  globalValue: unknown;
  tenantOverrides: Array<{ tenant_id: string; value: unknown }>;
  options?: readonly string[];
  secret?: boolean;
  secretItems?: string[];
  secretList?: boolean;
  secretEntries?: SecretListEntry[];
  notesAvailable?: boolean;
  secretRevision?: string | null;
};

export const REDACTED_SETTING_VALUE = "\u2022\u2022\u2022 set (hidden)";

function redactIfSecret(def: SettingDef, value: unknown): unknown {
  if (!def.secret) return value;
  return typeof value === "string" && value.trim() === "" ? "" : REDACTED_SETTING_VALUE;
}

export function parseSecretList(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

export function secretItemHint(item: string): string {
  return `…${item.slice(-4)}`;
}

export type SecretListEntry = {
  hint: string;
  seat: string | null;
  note: string | null;
  note_updated_by: string | null;
  note_updated_at: string | null;
};

export class SecretListError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 404 | 409 | 503,
    message: string,
  ) {
    super(message);
  }
}

export const SEAT_NOTE_MAX = 280;
const ADDED_TOKEN_RE = /^[A-Za-z0-9_-]{20,}$/;
const NOTE_BAD_CHARS = /[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁠-⁤⁦-⁩﻿]/;
const TOKEN_SHAPED = /sk-ant-[A-Za-z0-9_-]{16,}/i;
const SEAT_TARGET = /^seat_[0-9a-f]{12}$/;
const HINT_TARGET = /^\u2026[^\s,]{1,4}$/;

export function seatNotesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.SEAT_LABEL_SALT?.trim());
}

export function validateSeatNote(raw: string, poolTokens: readonly string[]): string {
  const note = raw.trim();
  if (note === "") return "";
  if (note.length > SEAT_NOTE_MAX) {
    throw new SecretListError("note_too_long", 400, `note is ${note.length} characters; the limit is ${SEAT_NOTE_MAX}`);
  }
  if (NOTE_BAD_CHARS.test(note)) {
    throw new SecretListError("note_invalid_chars", 400, "note has control or invisible characters; use one plain line");
  }
  if (TOKEN_SHAPED.test(note) || poolTokens.some((t) => note.includes(t))) {
    throw new SecretListError("note_contains_credential", 400, "that note contains a token; notes are not secret, so it was not saved");
  }
  return note;
}

function splitIncoming(raw: string): string[] {
  const out: string[] = [];
  for (const t of raw.split(/[\s,]+/)) if (t && !out.includes(t)) out.push(t);
  return out;
}

function assertAddable(tokens: readonly string[]): void {
  if (tokens.some((t) => /[•…]/.test(t))) {
    throw new SecretListError("redacted_placeholder_write", 400, "refusing to store the redaction placeholder — paste the real token");
  }
  const bad = tokens.find((t) => !ADDED_TOKEN_RE.test(t));
  if (bad !== undefined) {
    throw new SecretListError("invalid_token", 400, `${secretItemHint(bad)} does not look like a token (letters, digits, - and _ only, 20+ characters)`);
  }
}

function credentialListDef(key: string): SettingDef {
  if (!isSettingKey(key)) throw new SecretListError("unknown_key", 400, `unknown setting key: ${key}`);
  const def = APP_SETTINGS[key] as SettingDef;
  if (!def.secret || !def.secretList || def.type !== "string" || def.scope !== "global") {
    throw new SecretListError("not_a_credential_list", 400, `${key} is not a global credential list`);
  }
  return def;
}

export type SecretListEdit =
  | { op: "set"; tokens: string; expectedRevision: string | null }
  | { op: "append"; tokens: string; note?: string }
  | { op: "remove"; target: string }
  | { op: "replace"; target: string; token: string; expectedRevision: string | null }
  | { op: "note"; target: string; note: string; expectedRevision: string | null };

export type SecretListEditResult = { count: number; changed: number; revision: string | null; seat?: string };

export type SecretListDeps = {
  readSnapshot: (key: string) => Promise<{ value: unknown; revision: string | null }>;
  readNotes: (seats: string[]) => Promise<Map<string, string>>;
  apply: typeof applySecretListEditRpc;
  seatOf: (token: string) => string;
  notesEnabled: () => boolean;
};

const defaultSecretListDeps: SecretListDeps = {
  async readSnapshot(key) {
    const { data, error } = await serviceClient()
      .from("app_setting")
      .select("value, updated_at")
      .eq("key", key)
      .maybeSingle();
    if (error) throw new SecretListError("storage_unavailable", 503, `read ${key} failed: ${error.message}`);
    const row = data as { value?: unknown; updated_at?: string } | null;
    return { value: row?.value, revision: row?.updated_at ?? null };
  },
  async readNotes(seats) {
    if (seats.length === 0) return new Map();
    const { data, error } = await globalClient()
      .from("agent_auth_seat_note")
      .select("seat, note")
      .in("seat", seats);
    if (error) throw new SecretListError("notes_unavailable", 503, `seat notes read failed: ${error.message}`);
    return new Map(((data ?? []) as Array<{ seat: string; note: string }>).map((r) => [r.seat, r.note]));
  },
  apply: (args) => applySecretListEditRpc(args),
  seatOf: (t) => seatLabelForToken(t),
  notesEnabled: () => seatNotesEnabled(),
};

export async function editSecretList(
  key: string,
  edit: SecretListEdit,
  updated_by: string,
  deps: SecretListDeps = defaultSecretListDeps,
): Promise<SecretListEditResult> {
  const def = credentialListDef(key);
  const userRevision = "expectedRevision" in edit ? edit.expectedRevision : undefined;
  const wantsNotes = edit.op === "note" || (edit.op === "append" && edit.note !== undefined && edit.note.trim() !== "");
  if (wantsNotes && !deps.notesEnabled()) {
    throw new SecretListError("notes_unavailable", 503, "seat notes need SEAT_LABEL_SALT on this server");
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const snap = await deps.readSnapshot(key);
    const current = parseSecretList(snap.value);
    const seats = current.map(deps.seatOf);
    let next = current;
    const noteUpserts: Array<{ seat: string; note: string }> = [];
    const noteDeletes: string[] = [];
    let changed = 0;
    let seat: string | undefined;

    const resolve = (target: string): number => {
      const t = target.trim();
      if (SEAT_TARGET.test(t)) {
        if (!deps.notesEnabled()) {
          throw new SecretListError("seat_labels_unstable", 400, "seat labels change per process on this server; target the masked hint instead");
        }
        return seats.indexOf(t);
      }
      if (!HINT_TARGET.test(t)) {
        throw new SecretListError("invalid_target", 400, "target must be a seat label (seat_…) or a masked hint (…abcd)");
      }
      const hits = current.flatMap((tok, i) => (secretItemHint(tok) === t ? [i] : []));
      if (hits.length > 1) {
        throw new SecretListError("ambiguous_hint", 400, `${t} matches ${hits.length} entries — remove by seat instead`);
      }
      return hits.length === 1 ? hits[0] : -1;
    };

    switch (edit.op) {
      case "set": {
        const incoming = splitIncoming(edit.tokens);
        assertAddable(incoming.filter((t) => !current.includes(t)));
        next = incoming;
        for (let i = 0; i < current.length; i++) if (!next.includes(current[i])) noteDeletes.push(seats[i]);
        changed = noteDeletes.length + next.filter((t) => !current.includes(t)).length;
        break;
      }
      case "append": {
        const incoming = splitIncoming(edit.tokens);
        if (incoming.length === 0) throw new SecretListError("nothing_to_add", 400, "nothing to add");
        const added = incoming.filter((t) => !current.includes(t));
        assertAddable(added);
        next = [...current, ...added];
        changed = added.length;
        if (wantsNotes) {
          if (incoming.length !== 1) {
            throw new SecretListError("note_needs_one_token", 400, "add one token at a time when giving it a note");
          }
          seat = deps.seatOf(incoming[0]);
          noteUpserts.push({ seat, note: validateSeatNote(edit.note ?? "", next) });
        }
        break;
      }
      case "remove": {
        const i = resolve(edit.target);
        if (i < 0) {
          if (SEAT_TARGET.test(edit.target.trim())) return { count: current.length, changed: 0, revision: snap.revision };
          throw new SecretListError("not_found", 404, `no entry matches ${edit.target}`);
        }
        seat = seats[i];
        next = current.filter((_, j) => j !== i);
        noteDeletes.push(seat);
        changed = 1;
        break;
      }
      case "replace": {
        const i = resolve(edit.target);
        if (i < 0) throw new SecretListError("not_found", 404, `no entry matches ${edit.target}`);
        const incoming = splitIncoming(edit.token);
        if (incoming.length !== 1) throw new SecretListError("replace_needs_one_token", 400, "paste exactly one replacement token");
        const token = incoming[0];
        if (token === current[i]) return { count: current.length, changed: 0, revision: snap.revision, seat: seats[i] };
        if (current.includes(token)) throw new SecretListError("duplicate_token", 400, "that token is already in the pool");
        assertAddable([token]);
        next = current.map((t, j) => (j === i ? token : t));
        seat = deps.seatOf(token);
        noteDeletes.push(seats[i]);
        if (deps.notesEnabled()) {
          const old = (await deps.readNotes([seats[i]])).get(seats[i]);
          if (old) noteUpserts.push({ seat, note: validateSeatNote(old, next) });
        }
        changed = 1;
        break;
      }
      case "note": {
        const i = resolve(edit.target);
        if (i < 0) throw new SecretListError("not_found", 404, `no entry matches ${edit.target}`);
        seat = seats[i];
        const note = validateSeatNote(edit.note, current);
        if (note === "") noteDeletes.push(seat);
        else noteUpserts.push({ seat, note });
        changed = 1;
        break;
      }
    }

    if (changed === 0 && noteUpserts.length === 0 && noteDeletes.length === 0) {
      return { count: next.length, changed: 0, revision: snap.revision, ...(seat ? { seat } : {}) };
    }

    try {
      const revision = await deps.apply({
        key,
        expectedRevision: userRevision !== undefined ? userRevision : snap.revision,
        value: next.join(","),
        description: def.description,
        noteUpserts,
        noteDeletes,
        actor: updated_by,
      });
      cache.delete(cacheKey(key as SettingKey, null));
      rawCache.delete(cacheKey(key as SettingKey, null));
      return { count: next.length, changed, revision, ...(seat ? { seat } : {}) };
    } catch (e) {
      if (!(e instanceof StaleRevisionError)) {
        if (e instanceof SecretListError) throw e;
        if ((e as Error).message?.includes("note_contains_credential")) {
          throw new SecretListError("note_contains_credential", 400, "that note contains a token; notes are not secret, so it was not saved");
        }
        throw new SecretListError("storage_unavailable", 503, `write ${key} failed: ${(e as Error).message}`);
      }
      if (userRevision !== undefined) {
        throw new SecretListError("stale_revision", 409, "the pool changed since you loaded this page — reload and try again");
      }
    }
  }
  throw new SecretListError("stale_revision", 409, "the pool kept changing — reload and try again");
}

async function secretListView(raw: unknown): Promise<{ entries: SecretListEntry[]; notesAvailable: boolean }> {
  const tokens = parseSecretList(raw);
  const stableSeats = seatNotesEnabled();
  const seats = tokens.map((t) => seatLabelForToken(t));
  let notes = new Map<string, { note: string; updated_by: string | null; updated_at: string | null }>();
  let notesAvailable = stableSeats;
  if (notesAvailable && seats.length > 0) {
    try {
      const { data, error } = await globalClient()
        .from("agent_auth_seat_note")
        .select("seat, note, updated_by, updated_at")
        .in("seat", seats);
      if (error) throw new Error(error.message);
      notes = new Map(
        ((data ?? []) as Array<{ seat: string; note: string; updated_by: string | null; updated_at: string | null }>).map(
          (r) => [r.seat, { note: r.note, updated_by: r.updated_by, updated_at: r.updated_at }],
        ),
      );
    } catch (e) {
      console.warn(`[settings] seat notes unavailable, listing without them: ${(e as Error).message}`);
      notesAvailable = false;
    }
  }
  return {
    notesAvailable,
    entries: tokens.map((t, i) => {
      const n = notes.get(seats[i]);
      return {
        hint: secretItemHint(t),
        seat: stableSeats ? seats[i] : null,
        note: n?.note ?? null,
        note_updated_by: n?.updated_by ?? null,
        note_updated_at: n?.updated_at ?? null,
      };
    }),
  };
}

export async function listSettings(): Promise<SettingListRow[]> {
  const sb = serviceClient();
  const [globalsRes, overridesRes] = await Promise.all([
    sb.from("app_setting").select("key, value, updated_at"),
    sb.from("tenant_app_setting").select("tenant_id, key, value"),
  ]);
  if (globalsRes.error) throw new Error(`app_setting read failed: ${globalsRes.error.message}`);
  if (overridesRes.error) throw new Error(`tenant_app_setting read failed: ${overridesRes.error.message}`);
  const globalByKey = new Map<string, unknown>();
  const revisionByKey = new Map<string, string | null>();
  for (const r of (globalsRes.data ?? []) as Array<{ key: string; value: unknown; updated_at?: string | null }>) {
    globalByKey.set(r.key, r.value);
    revisionByKey.set(r.key, r.updated_at ?? null);
  }
  const overridesByKey = new Map<string, Array<{ tenant_id: string; value: unknown }>>();
  for (const r of (overridesRes.data ?? []) as Array<{ tenant_id: string; key: string; value: unknown }>) {
    const arr = overridesByKey.get(r.key) ?? [];
    arr.push({ tenant_id: r.tenant_id, value: r.value });
    overridesByKey.set(r.key, arr);
  }

  return Promise.all(
    (Object.keys(APP_SETTINGS) as SettingKey[]).map(async (key): Promise<SettingListRow> => {
      const def = APP_SETTINGS[key] as SettingDef;
      const row: SettingListRow = {
        key,
        description: def.description,
        type: def.type,
        scope: def.scope,
        defaultValue: def.defaultValue,
        globalValue: redactIfSecret(def, globalByKey.has(key) ? globalByKey.get(key) : def.defaultValue),
        tenantOverrides:
          def.scope === "per-tenant"
            ? (overridesByKey.get(key) ?? []).map((o) => ({
                tenant_id: o.tenant_id,
                value: redactIfSecret(def, o.value),
              }))
            : [],
        options: def.options,
        secret: def.secret,
      };
      if (def.secret) row.secretItems = parseSecretList(globalByKey.get(key)).map(secretItemHint);
      if (def.secretList) {
        const view = await secretListView(globalByKey.get(key));
        row.secretList = true;
        row.secretEntries = view.entries;
        row.notesAvailable = view.notesAvailable;
        row.secretRevision = revisionByKey.get(key) ?? null;
      }
      return row;
    }),
  );
}
