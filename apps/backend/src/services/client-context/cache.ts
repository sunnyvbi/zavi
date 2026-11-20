type Entry = { expires_at: number; value: Promise<unknown> };

const store = new Map<string, Entry>();
const MAX_ENTRIES = 500;

function sweep(now: number): void {
  if (store.size < MAX_ENTRIES) return;
  for (const [key, entry] of store) if (entry.expires_at <= now) store.delete(key);
}

export function cachedSection<T>(
  key: string,
  ttlMs: number,
  fresh: boolean,
  work: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const hit = store.get(key);
  if (!fresh && hit && hit.expires_at > now) return hit.value as Promise<T>;
  sweep(now);
  const value = work();
  store.set(key, { expires_at: now + ttlMs, value });
  value.catch(() => {
    if (store.get(key)?.value === value) store.delete(key);
  });
  return value;
}

export function invalidateClientContext(tenant_id: string): void {
  for (const key of store.keys()) if (key.startsWith(`${tenant_id}:`)) store.delete(key);
}

export function clearClientContextCache(): void {
  store.clear();
}
