export const SIGN_TTL_SECONDS = 3600;
export const MIN_REMAINING_SECONDS = 600;
const MAX_ENTRIES = 5000;

type Entry = { url: string; expiresAt: number };

const cache = new Map<string, Entry>();

export function signedUrlCacheKey(
  bucket: string,
  path: string,
  options: unknown,
): string {
  return `${bucket}|${path}|${options === undefined ? "" : JSON.stringify(options)}`;
}

export function readSignedUrl(key: string, now: number = Date.now()): string | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt - now < MIN_REMAINING_SECONDS * 1000) {
    cache.delete(key);
    return null;
  }
  return hit.url;
}

export function storeSignedUrl(
  key: string,
  url: string,
  ttlSeconds: number,
  now: number = Date.now(),
): void {
  if (ttlSeconds <= MIN_REMAINING_SECONDS) return;
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.delete(key);
  cache.set(key, { url, expiresAt: now + ttlSeconds * 1000 });
}

export function clearSignedUrlCache(): void {
  cache.clear();
}

export function signedUrlCacheSize(): number {
  return cache.size;
}
