
import { createHash } from "node:crypto";
import { globalClient } from "@/services/tenant-client";
import { KNOWN_GATEKEEPER_FLAGS, type KnownGatekeeperFlag } from "./known-flags";

export type CachePolicy = "critical" | "standard";

export type GatekeeperFlag = {
  name: string;
  description: string;
  is_enabled: boolean;
  rollout_percentage: number;
  cache_policy: CachePolicy;
  whitelist: string[];
  created_at: string;
  updated_at: string;
  updated_by: string | null;
};

export type FlagInput = {
  description?: string;
  is_enabled?: boolean;
  rollout_percentage?: number;
  cache_policy?: CachePolicy;
  whitelist?: string[];
};

export const FLAG_NAME_RE = /^[a-z0-9][a-z0-9_.-]{0,79}$/;

const TABLE = "gatekeeper_flags";
const CACHE_TTL_MS: Record<CachePolicy, number> = {
  critical: 5 * 60 * 1000,
  standard: 30 * 60 * 1000,
};

const cache = new Map<string, { flag: GatekeeperFlag | null; expiresAt: number }>();
const CACHE_MAX_ENTRIES = 1000;

const generation = new Map<string, number>();

export function _resetGatekeeperCache(): void {
  cache.clear();
}

function invalidate(name: string): void {
  cache.delete(name);
  generation.set(name, (generation.get(name) ?? 0) + 1);
}

export function rolloutBucket(userId: string, name: string): number {
  const hash = createHash("md5").update(`${userId}:${name}`).digest("hex");
  return parseInt(hash.substring(0, 8), 16) % 100;
}

export type EvaluationReason =
  | "not_found"
  | "disabled"
  | "whitelisted"
  | "in_rollout"
  | "not_in_rollout"
  | "anonymous_not_full_rollout";

export function evaluateFlag(
  flag: GatekeeperFlag | null,
  userId: string | null,
): { enabled: boolean; reason: EvaluationReason } {
  if (!flag) return { enabled: false, reason: "not_found" };
  if (!flag.is_enabled) return { enabled: false, reason: "disabled" };
  if (!userId) {
    return flag.rollout_percentage >= 100
      ? { enabled: true, reason: "in_rollout" }
      : { enabled: false, reason: "anonymous_not_full_rollout" };
  }
  if (flag.whitelist.includes(userId)) return { enabled: true, reason: "whitelisted" };
  if (flag.rollout_percentage >= 100) return { enabled: true, reason: "in_rollout" };
  if (flag.rollout_percentage > 0 && rolloutBucket(userId, flag.name) < flag.rollout_percentage) {
    return { enabled: true, reason: "in_rollout" };
  }
  return { enabled: false, reason: "not_in_rollout" };
}

export async function getFlag(name: string): Promise<GatekeeperFlag | null> {
  const hit = cache.get(name);
  if (hit && hit.expiresAt > Date.now()) return hit.flag;

  const gen = generation.get(name) ?? 0;
  const { data, error } = await globalClient().from(TABLE).select("*").eq("name", name).maybeSingle();
  if (error) throw new Error(`gatekeeper getFlag(${name}): ${error.message}`);
  const flag = (data as GatekeeperFlag | null) ?? null;
  if ((generation.get(name) ?? 0) === gen) {
    const ttl = flag ? CACHE_TTL_MS[flag.cache_policy] ?? CACHE_TTL_MS.standard : CACHE_TTL_MS.critical;
    if (cache.size >= CACHE_MAX_ENTRIES) cache.clear();
    cache.set(name, { flag, expiresAt: Date.now() + ttl });
  }
  return flag;
}

export async function isFeatureEnabled(
  name: string,
  userId: string | null | undefined,
  opts: { autoRegister?: boolean } = {},
): Promise<boolean> {
  try {
    const flag = await getFlag(name);
    if (!flag && opts.autoRegister !== false && FLAG_NAME_RE.test(name)) {
      await ensureFlagExists(name);
    }
    return evaluateFlag(flag, userId ?? null).enabled;
  } catch (err) {
    console.warn(`[gatekeeper] ${name} failed closed: ${(err as Error).message}`);
    return false;
  }
}

function knownFlagRow(f: KnownGatekeeperFlag) {
  return {
    name: f.name,
    description: f.description,
    is_enabled: f.defaultEnabled,
    rollout_percentage: f.defaultEnabled ? 100 : 0,
    cache_policy: f.cachePolicy,
  };
}

async function ensureFlagExists(name: string): Promise<void> {
  const known = KNOWN_GATEKEEPER_FLAGS.find((f) => f.name === name);
  const { error } = await globalClient()
    .from(TABLE)
    .upsert([known ? knownFlagRow(known) : { name }] as Record<string, unknown>[], {
      onConflict: "name",
      ignoreDuplicates: true,
    });
  if (error) console.warn(`[gatekeeper] auto-register ${name}: ${error.message}`);
  invalidate(name);
}

export async function ensureKnownFlags(): Promise<void> {
  if (KNOWN_GATEKEEPER_FLAGS.length === 0) return;
  const rows = KNOWN_GATEKEEPER_FLAGS.map(knownFlagRow);
  const { error } = await globalClient()
    .from(TABLE)
    .upsert(rows, { onConflict: "name", ignoreDuplicates: true });
  if (error) console.warn(`[gatekeeper] ensureKnownFlags: ${error.message}`);
}

export async function listFlags(): Promise<GatekeeperFlag[]> {
  await ensureKnownFlags();
  const { data, error } = await globalClient()
    .from(TABLE)
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw new Error(`gatekeeper listFlags: ${error.message}`);
  return (data ?? []) as GatekeeperFlag[];
}

export async function createFlag(
  name: string,
  input: FlagInput,
  actor: string,
): Promise<GatekeeperFlag | null> {
  const { data, error } = await globalClient()
    .from(TABLE)
    .insert({ name, ...input, updated_by: actor })
    .select("*")
    .maybeSingle();
  if (error) {
    if (error.code === "23505") return null;
    throw new Error(`gatekeeper createFlag(${name}): ${error.message}`);
  }
  invalidate(name);
  return data as GatekeeperFlag;
}

export async function updateFlag(
  name: string,
  input: FlagInput,
  actor: string,
): Promise<GatekeeperFlag | null> {
  const { data, error } = await globalClient()
    .from(TABLE)
    .update({ ...input, updated_by: actor, updated_at: new Date().toISOString() })
    .eq("name", name)
    .select("*")
    .maybeSingle();
  if (error) throw new Error(`gatekeeper updateFlag(${name}): ${error.message}`);
  invalidate(name);
  return (data as GatekeeperFlag | null) ?? null;
}

export async function deleteFlag(name: string): Promise<boolean> {
  const { data, error } = await globalClient().from(TABLE).delete().eq("name", name).select("name");
  if (error) throw new Error(`gatekeeper deleteFlag(${name}): ${error.message}`);
  invalidate(name);
  return (data ?? []).length > 0;
}
