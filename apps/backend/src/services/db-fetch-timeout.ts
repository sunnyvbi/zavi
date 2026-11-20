
export const DEFAULT_DB_FETCH_TIMEOUT_MS = 30_000;
export const LONG_DB_FETCH_TIMEOUT_MS = 190_000;
export const STORAGE_FETCH_TIMEOUT_MS = 600_000;

export function dbFetchTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SUPABASE_FETCH_TIMEOUT_MS;
  if (raw === undefined || raw === "") return DEFAULT_DB_FETCH_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DB_FETCH_TIMEOUT_MS;
}

export function timeoutForRequest(url: string, ms: number): number {
  return url.includes("/storage/v1/") ? Math.max(ms, STORAGE_FETCH_TIMEOUT_MS) : ms;
}

export function fetchWithTimeout(ms: number, baseFetch: typeof fetch = fetch): typeof fetch {
  if (ms <= 0) return baseFetch;
  return (input, init = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const bound = timeoutForRequest(url, ms);
    const caller = init.signal ?? (input instanceof Request ? input.signal : undefined);
    const controller = new AbortController();
    const onCallerAbort = () => controller.abort(caller?.reason);
    if (caller?.aborted) controller.abort(caller.reason);
    else caller?.addEventListener("abort", onCallerAbort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Error(`database request timed out after ${bound}ms`)),
      bound,
    );
    return baseFetch(input, { ...init, signal: controller.signal }).finally(() => {
      clearTimeout(timer);
      caller?.removeEventListener("abort", onCallerAbort);
    });
  };
}
