
import { noteApiWrite } from "@/lib/workspace/apiWrites";
import { createBrowserSupabase } from "./supabase";
import { noticeTenantDisabled } from "./tenantDisabled";

const BACKEND_URL =
  (typeof process !== "undefined" && process.env.NEXT_PUBLIC_BACKEND_URL) ||
  "http://localhost:3001";

export function apiUrl(path: string): string {
  if (!path.startsWith("/")) {
    throw new Error(`apiUrl path must start with '/', got: ${path}`);
  }
  return `${BACKEND_URL}${path}`;
}

export type ApiFetchOptions = RequestInit & {
  retryOnNetworkError?: boolean;
  idempotent?: boolean;
};

export const IDEMPOTENCY_HEADER = "Idempotency-Key";

export function newIdempotencyKey(): string {
  const c = globalThis.crypto;
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

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function fetchWithTransientRetry(
  doFetch: () => Promise<Response>,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_FETCH_ATTEMPTS; attempt++) {
    try {
      return await doFetch();
    } catch (e) {
      lastError = e;
      if (!isTransientNetworkError(e) || attempt === MAX_FETCH_ATTEMPTS - 1) {
        throw e;
      }
      await sleep(RETRY_BACKOFF_MS[attempt] ?? 800);
    }
  }
  throw lastError;
}

let refreshInFlight: Promise<string | null> | null = null;

function refreshSessionOnce(
  supabase: ReturnType<typeof createBrowserSupabase>,
): Promise<string | null> {
  if (!refreshInFlight) {
    refreshInFlight = supabase.auth
      .refreshSession()
      .then(async ({ data, error }) => {
        if (!error) return data.session?.access_token ?? null;
        if (refreshRejected(error)) await endDeadSession(supabase);
        return null;
      })
      .catch(() => null);
    void refreshInFlight.finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

export function refreshRejected(error: unknown): boolean {
  const e = error as { name?: unknown; status?: unknown } | null;
  return e?.name === "AuthApiError" && typeof e.status === "number" && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429;
}

async function endDeadSession(supabase: ReturnType<typeof createBrowserSupabase>): Promise<void> {
  await supabase.auth.signOut({ scope: "local" }).catch(() => undefined);
  if (typeof window === "undefined" || window.location.pathname.startsWith("/login")) return;
  const next = `${window.location.pathname}${window.location.search}`;
  window.location.assign(`/login?next=${encodeURIComponent(next)}`);
}

function isReplayableBody(body: BodyInit | null | undefined): boolean {
  if (body == null) return true;
  return !(typeof ReadableStream !== "undefined" && body instanceof ReadableStream);
}

export async function apiFetch(path: string, opts: ApiFetchOptions = {}): Promise<Response> {
  const { headers: hdrs, retryOnNetworkError, idempotent = false, ...rest } = opts;
  const method = (rest.method ?? "GET").toUpperCase();
  const retryNetwork = retryOnNetworkError ?? (method === "GET" || method === "HEAD" || method === "OPTIONS" || idempotent);
  const supabase = createBrowserSupabase();
  const url = apiUrl(path);
  const idempotencyKey =
    idempotent && !new Headers(hdrs).has(IDEMPOTENCY_HEADER) ? newIdempotencyKey() : null;

  const attempt = async (freshToken?: string) => {
    const headers = new Headers(hdrs);
    if (idempotencyKey) headers.set(IDEMPOTENCY_HEADER, idempotencyKey);
    if (!headers.has("Content-Type") && rest.body && typeof rest.body === "string") {
      headers.set("Content-Type", "application/json");
    }
    const token = freshToken ?? (await supabase.auth.getSession()).data.session?.access_token;
    if (token) {
      headers.set("Authorization", `Bearer ${token}`);
    }
    return fetch(url, { ...rest, headers });
  };
  const send = (freshToken?: string) =>
    retryNetwork ? fetchWithTransientRetry(() => attempt(freshToken)) : attempt(freshToken);

  const settled = (r: Response) => {
    if (r.ok && !(method === "GET" || method === "HEAD" || method === "OPTIONS")) noteApiWrite(path);
    return r;
  };
  const res = await send();
  if (res.status === 403) await noticeTenantDisabled(res);
  if (res.status !== 401 || !isReplayableBody(rest.body)) return settled(res);
  const freshToken = await refreshSessionOnce(supabase);
  if (!freshToken) return res;
  const replay = await send(freshToken);
  if (replay.status === 403) await noticeTenantDisabled(replay);
  return settled(replay);
}
