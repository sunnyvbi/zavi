
import { serviceClient } from "@/services/supabase";

export const STAFF_CONSOLE_ALLOWED_SLUG = "operator";

export const STAFF_CONSOLE_MAX_MESSAGE_CHARS = 32000;

export async function isStaffOrInternalTenant(tenant_id: string): Promise<boolean> {
  try {
    const sb = serviceClient();
    const { data: members, error } = await sb
      .from("tenant_users")
      .select("user_id")
      .eq("tenant_id", tenant_id);
    if (error) throw new Error(error.message);
    const ids = (members ?? [])
      .map((m) => (m as { user_id: string | null }).user_id)
      .filter((v): v is string => typeof v === "string" && v.length > 0);
    if (ids.length === 0) return false;
    const { data: staff, error: sErr } = await sb
      .from("staff_users")
      .select("user_id")
      .in("user_id", ids)
      .is("revoked_at", null)
      .limit(1);
    if (sErr) throw new Error(sErr.message);
    return (staff ?? []).length > 0;
  } catch (e) {
    console.warn(
      `[staff-console] isStaffOrInternalTenant read failed for ${tenant_id}; denying: ${(e as Error).message}`,
    );
    return true;
  }
}

type IdempEntry = { at: number; pending: boolean; result?: unknown };
const IDEMP_TTL_MS = 15 * 60 * 1000;
const idempCache = new Map<string, IdempEntry>();

function purgeIdemp(now: number): void {
  for (const [k, v] of idempCache) {
    if (now - v.at > IDEMP_TTL_MS) idempCache.delete(k);
  }
}

export function idempotencyClaim(
  key: string,
): { fresh: true } | { fresh: false; entry: IdempEntry } {
  const now = Date.now();
  purgeIdemp(now);
  const existing = idempCache.get(key);
  if (existing) return { fresh: false, entry: existing };
  idempCache.set(key, { at: now, pending: true });
  return { fresh: true };
}

export function idempotencyResolve(key: string, result: unknown): void {
  idempCache.set(key, { at: Date.now(), pending: false, result });
}

export function idempotencyRelease(key: string): void {
  idempCache.delete(key);
}

export function _resetIdempotencyForTests(): void {
  idempCache.clear();
}

const RL_WINDOW_MS = 60 * 1000;
const RL_MAX = 30;
const rlCache = new Map<string, number[]>();

export function rateLimitExceeded(staff_user_id: string, tenant_id: string): boolean {
  const key = `${staff_user_id}:${tenant_id}`;
  const now = Date.now();
  const hits = (rlCache.get(key) ?? []).filter((t) => now - t < RL_WINDOW_MS);
  if (hits.length >= RL_MAX) {
    rlCache.set(key, hits);
    return true;
  }
  hits.push(now);
  rlCache.set(key, hits);
  return false;
}

export function _resetRateLimitForTests(): void {
  rlCache.clear();
}
