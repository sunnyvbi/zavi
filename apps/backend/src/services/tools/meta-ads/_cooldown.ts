
import { AsyncLocalStorage } from "node:async_hooks";
import { ExpectedToolError } from "@/services/tools/types";
import { globalClient } from "@/services/tenant-client";

const TABLE = "meta_ad_account_cooldown";

export const PROBE_CALLERS: ReadonlySet<string> = new Set(["reconcile", "spend_controller"]);
export const DEFAULT_COOLDOWN_MINUTES = 5;
export const COOLDOWN_CACHE_MS = 30_000;

type CallerCtx = { caller: string; safety: boolean };
const callerStore = new AsyncLocalStorage<CallerCtx>();

export function withMetaCaller<T>(caller: string, fn: () => T, opts: { safety?: boolean } = {}): T {
  return callerStore.run({ caller, safety: opts.safety === true }, fn);
}

export function withMetaSafety<T>(fn: () => T): T {
  return withMetaCaller(callerStore.getStore()?.caller ?? "safety", fn, { safety: true });
}

export function metaCaller(explicit?: string): string {
  return explicit ?? callerStore.getStore()?.caller ?? "unknown";
}

export function metaSafetyActive(): boolean {
  return callerStore.getStore()?.safety === true;
}

const STOPPED = new Set(["PAUSED", "ARCHIVED", "DELETED"]);

export function isSpendReducingMetaChange(exec_class: string, body: unknown): boolean {
  const cls = exec_class.replace(/_review$/, "");
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if (cls === "meta_ads.set_status") return typeof b.status === "string" && STOPPED.has(b.status);
  if (cls === "meta_ads.update_ad_set_budget" || cls === "meta_ads.update_campaign_budget") {
    const next = Number(b.daily_budget_usd);
    const was = Number(b.expected_current_daily_budget_usd);
    return b.daily_budget_usd != null && b.expected_current_daily_budget_usd != null && Number.isFinite(next) && Number.isFinite(was) && next < was;
  }
  return false;
}

export function withMetaDecisionExec<T>(exec_class: string, body: unknown, fn: () => T): T {
  return withMetaCaller("decision_exec", fn, { safety: isSpendReducingMetaChange(exec_class, body) });
}

const RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);
const RATE_LIMIT_SUBCODES = new Set([2446079, 1487742, 1504022, 1504039]);

export function isMetaRateLimitCode(code: unknown, subcode?: unknown): boolean {
  const c = Number(code);
  if (RATE_LIMIT_CODES.has(c) || (c >= 80000 && c <= 80014)) return true;
  return RATE_LIMIT_SUBCODES.has(Number(subcode));
}

function hhmm(ms: number): string {
  return new Date(ms).toISOString().slice(11, 16);
}

export class MetaCoolingDownError extends ExpectedToolError {
  readonly until: number;
  constructor(ad_account: string, until: number, now: number = Date.now()) {
    const minutes = Math.max(1, Math.ceil((until - now) / 60_000));
    super("meta_ads_busy", `Meta is busy for ${minutes} min; try again after ${hhmm(until)} UTC`, {
      ad_account,
      cooling_until: new Date(until).toISOString(),
      retry_after_minutes: minutes,
      rate_limited: true,
      next_step: "retry_later",
    });
    this.until = until;
  }
}

export type CooldownRow = { until: number; probe_claimed: boolean };

export type CooldownStore = {
  read(ad_account: string): Promise<CooldownRow | null>;
  start(ad_account: string, until: number, reason: string, now: number): Promise<void>;
  claimProbe(ad_account: string, now: number): Promise<boolean>;
  clear(ad_account: string): Promise<void>;
};

const dbStore: CooldownStore = {
  async read(ad_account) {
    const { data, error } = await globalClient()
      .from(TABLE)
      .select("cooling_until, probe_claimed_at")
      .eq("ad_account", ad_account)
      .limit(1);
    if (error) throw new Error(error.message);
    const row = (data ?? [])[0] as { cooling_until?: string; probe_claimed_at?: string | null } | undefined;
    if (!row?.cooling_until) return null;
    const until = Date.parse(row.cooling_until);
    return Number.isFinite(until) ? { until, probe_claimed: row.probe_claimed_at != null } : null;
  },
  async start(ad_account, until, reason, now) {
    const live = await dbStore.read(ad_account);
    const iso = new Date(until).toISOString();
    if (live && live.until > now) {
      if (until <= live.until) return;
      const { error } = await globalClient().from(TABLE).update({ cooling_until: iso, reason, updated_at: new Date(now).toISOString() }).eq("ad_account", ad_account);
      if (error) throw new Error(error.message);
      return;
    }
    const { error } = await globalClient()
      .from(TABLE)
      .upsert({ ad_account, cooling_until: iso, probe_claimed_at: null, reason, updated_at: new Date(now).toISOString() }, { onConflict: "ad_account" });
    if (error) throw new Error(error.message);
  },
  async claimProbe(ad_account, now) {
    const iso = new Date(now).toISOString();
    const { data, error } = await globalClient()
      .from(TABLE)
      .update({ probe_claimed_at: iso, updated_at: iso })
      .eq("ad_account", ad_account)
      .is("probe_claimed_at", null)
      .gt("cooling_until", iso)
      .select("ad_account");
    if (error) throw new Error(error.message);
    return (data ?? []).length > 0;
  },
  async clear(ad_account) {
    const { error } = await globalClient().from(TABLE).delete().eq("ad_account", ad_account);
    if (error) throw new Error(error.message);
  },
};

let store: CooldownStore = dbStore;

export function _setMetaCooldownStoreForTest(s: CooldownStore | null): void {
  store = s ?? dbStore;
  cache.clear();
}

export function _resetMetaCooldowns(): void {
  cache.clear();
}

export function _memoryCooldownStore(): CooldownStore & { rows: Map<string, CooldownRow> } {
  const rows = new Map<string, CooldownRow>();
  return {
    rows,
    async read(a) {
      return rows.get(a) ?? null;
    },
    async start(a, until, _reason, now) {
      const live = rows.get(a);
      if (live && live.until > now) rows.set(a, { until: Math.max(live.until, until), probe_claimed: live.probe_claimed });
      else rows.set(a, { until, probe_claimed: false });
    },
    async claimProbe(a, now) {
      const r = rows.get(a);
      if (!r || r.until <= now || r.probe_claimed) return false;
      rows.set(a, { ...r, probe_claimed: true });
      return true;
    },
    async clear(a) {
      rows.delete(a);
    },
  };
}

type CacheEntry = { row: CooldownRow | null; read_at: number };
const cache = new Map<string, CacheEntry>();

function warn(what: string, e: unknown): void {
  console.warn(`[meta-cooldown] ${what}: ${(e as Error)?.message ?? String(e)}`);
}

export async function readMetaCooldown(ad_account: string, now: number = Date.now()): Promise<CooldownRow | null> {
  const hit = cache.get(ad_account);
  let row: CooldownRow | null;
  if (hit && now - hit.read_at < COOLDOWN_CACHE_MS) {
    row = hit.row;
  } else {
    try {
      row = await store.read(ad_account);
      cache.set(ad_account, { row, read_at: now });
    } catch (e) {
      warn(`read ${ad_account}`, e);
      row = hit?.row ?? null;
      cache.set(ad_account, { row, read_at: now });
    }
  }
  return row && row.until > now ? row : null;
}

export async function startMetaCooldown(ad_account: string, until: number, reason: string, now: number = Date.now()): Promise<void> {
  const prev = cache.get(ad_account)?.row;
  const live = prev && prev.until > now ? prev : null;
  cache.set(ad_account, {
    row: live ? { until: Math.max(live.until, until), probe_claimed: live.probe_claimed } : { until, probe_claimed: false },
    read_at: now,
  });
  try {
    await store.start(ad_account, until, reason.slice(0, 200), now);
  } catch (e) {
    warn(`start ${ad_account}`, e);
  }
}

export async function clearMetaCooldown(ad_account: string, now: number = Date.now()): Promise<void> {
  cache.set(ad_account, { row: null, read_at: now });
  try {
    await store.clear(ad_account);
  } catch (e) {
    warn(`clear ${ad_account}`, e);
  }
}

async function claimProbe(ad_account: string, row: CooldownRow, now: number): Promise<boolean> {
  if (row.probe_claimed) return false;
  let won: boolean;
  try {
    won = await store.claimProbe(ad_account, now);
  } catch (e) {
    warn(`claim probe ${ad_account}`, e);
    won = true;
  }
  cache.set(ad_account, { row: { ...row, probe_claimed: true }, read_at: now });
  return won;
}

export async function gateMetaCall(ad_account: string, caller: string, now: number = Date.now()): Promise<{ probe: boolean }> {
  const row = await readMetaCooldown(ad_account, now);
  if (!row) return { probe: false };
  if (PROBE_CALLERS.has(caller) && (await claimProbe(ad_account, row, now))) return { probe: true };
  throw new MetaCoolingDownError(ad_account, row.until, now);
}

export async function metaCoolingUntil(ad_account: string, now: number = Date.now()): Promise<number | null> {
  return (await readMetaCooldown(ad_account, now))?.until ?? null;
}

export async function metaProbeAvailable(ad_account: string, caller: string, now: number = Date.now()): Promise<boolean> {
  const row = await readMetaCooldown(ad_account, now);
  return !row || (PROBE_CALLERS.has(caller) && !row.probe_claimed);
}
