
export const WEB_SERVER_DB_TIMEOUT_MS = 8_000;
export const WEB_BROWSER_DB_TIMEOUT_MS = 20_000;
const STORAGE_TIMEOUT_MS = 600_000;

export function fetchWithTimeout(ms: number, baseFetch: typeof fetch = fetch): typeof fetch {
  if (ms <= 0) return baseFetch;
  return (input, init = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const bound = url.includes("/storage/v1/") ? Math.max(ms, STORAGE_TIMEOUT_MS) : ms;
    const caller = init.signal ?? (input instanceof Request ? input.signal : undefined);
    const controller = new AbortController();
    const onCallerAbort = () => controller.abort(caller?.reason);
    if (caller?.aborted) controller.abort(caller.reason);
    else caller?.addEventListener("abort", onCallerAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error(`request timed out after ${bound}ms`)), bound);
    return baseFetch(input, { ...init, signal: controller.signal }).finally(() => {
      clearTimeout(timer);
      caller?.removeEventListener("abort", onCallerAbort);
    });
  };
}
