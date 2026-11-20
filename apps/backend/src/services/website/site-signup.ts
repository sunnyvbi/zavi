const TTL_MS = 60_000;
const TIMEOUT_MS = 5_000;
const cache = new Map<string, { at: number; value: boolean }>();

export async function siteHasSignupPage(
  siteUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean | null> {
  let url: string;
  try {
    url = new URL("/signup", siteUrl).toString();
  } catch {
    return null;
  }
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  try {
    const res = await fetchImpl(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    const value = res.status === 404 ? false : res.status < 400 ? true : null;
    if (value !== null) cache.set(url, { at: Date.now(), value });
    return value;
  } catch {
    return null;
  }
}

export function clearSignupProbeCache(): void {
  cache.clear();
}
