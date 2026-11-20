const TTL_MS = 60_000;
const TIMEOUT_MS = 5_000;
const SUSPENDED_BODY = /service has been suspended|<title>\s*service suspended\s*<\/title>/i;
const cache = new Map<string, { at: number; value: boolean }>();

export async function siteIsSuspended(
  siteUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean | null> {
  let url: string;
  try {
    url = new URL("/", siteUrl).toString();
  } catch {
    return null;
  }
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  try {
    const res = await fetchImpl(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status !== 503) await res.body?.cancel().catch(() => undefined);
    const value = res.status === 503 ? SUSPENDED_BODY.test((await res.text()).slice(0, 20_000)) : false;
    cache.set(url, { at: Date.now(), value });
    return value;
  } catch {
    return null;
  }
}

export function clearSiteOfflineCache(): void {
  cache.clear();
}
