
const TTL_MS = 30 * 1000;

type Entry = { user_id: string; tenant_id: string; expires_at: number };

const cache = new Map<string, Entry>();

function keyFor(user_id: string, session_id: string | null): string {
  return session_id ? `s:${session_id}` : `u:${user_id}`;
}

function gc(now: number): void {
  for (const [k, v] of cache) {
    if (v.expires_at < now) cache.delete(k);
  }
}

export function getCachedTenant(
  user_id: string,
  session_id: string | null,
): string | null {
  const now = Date.now();
  gc(now);
  const hit = cache.get(keyFor(user_id, session_id));
  if (hit && hit.expires_at > now) return hit.tenant_id;
  return null;
}

export function setCachedTenant(
  user_id: string,
  session_id: string | null,
  tenant_id: string,
): void {
  cache.set(keyFor(user_id, session_id), {
    user_id,
    tenant_id,
    expires_at: Date.now() + TTL_MS,
  });
}

export function invalidateCachedTenant(user_id: string): void {
  for (const [k, v] of cache) {
    if (v.user_id === user_id) cache.delete(k);
  }
}

export function _clearTenantCacheForTests(): void {
  cache.clear();
}
