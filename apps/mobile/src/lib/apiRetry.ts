
export const IDEMPOTENCY_HEADER = "Idempotency-Key";

export function newIdempotencyKey(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string; getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const MAX_FETCH_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [300, 800];

export function isTransientNetworkError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if (e.name === "AbortError") return false;
  return e instanceof TypeError;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function fetchWithTransientRetry(
  doFetch: () => Promise<Response>,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_FETCH_ATTEMPTS; attempt++) {
    try {
      return await doFetch();
    } catch (e) {
      lastError = e;
      if (!isTransientNetworkError(e) || attempt === MAX_FETCH_ATTEMPTS - 1) throw e;
      await wait(RETRY_BACKOFF_MS[attempt] ?? 800);
    }
  }
  throw lastError;
}

export function retriesNetwork(method: string, idempotent: boolean): boolean {
  const m = method.toUpperCase();
  return m === "GET" || m === "HEAD" || m === "OPTIONS" || idempotent;
}

export function isRetryableStatus(status: number | undefined): boolean {
  return status !== undefined && (status >= 500 || status === 408 || status === 429);
}

export function readRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= 2) return false;
  const status = (error as { status?: number } | null)?.status;
  return status === undefined ? isTransientNetworkError(error) : isRetryableStatus(status);
}

export function readRetryDelay(attemptIndex: number): number {
  return attemptIndex === 0 ? 500 : 1500;
}
