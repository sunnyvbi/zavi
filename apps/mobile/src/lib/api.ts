import { supabase } from "./supabase";
import { decodeActiveTenantClaim } from "./tenant-claim";
import { noticeTenantDisabled } from "./tenantDisabled";
import {
  IDEMPOTENCY_HEADER,
  fetchWithTransientRetry,
  newIdempotencyKey,
  retriesNetwork,
} from "./apiRetry";

const BACKEND_URL =
  process.env.EXPO_PUBLIC_BACKEND_URL || "https://api.zaviagent.com";

export function apiUrl(path: string): string {
  if (!path.startsWith("/")) {
    throw new Error(`apiUrl path must start with '/', got: ${path}`);
  }
  return `${BACKEND_URL}${path}`;
}

export type ApiError = { code: string; message: string };

export type ApiFetchOptions = RequestInit & {
  retryOnNetworkError?: boolean;
  idempotent?: boolean;
  timeoutMs?: number;
};

export class ApiFetchError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiFetchError";
    this.status = status;
    this.code = code;
  }
}

type FreshSession = { token: string; userId: string };
let refreshInFlight: Promise<FreshSession | null> | null = null;

function refreshSessionOnce(): Promise<FreshSession | null> {
  if (!refreshInFlight) {
    refreshInFlight = supabase.auth
      .refreshSession()
      .then(({ data, error }) => {
        const s = data.session;
        return error || !s?.access_token || !s.user?.id ? null : { token: s.access_token, userId: s.user.id };
      })
      .catch(() => null);
    void refreshInFlight.finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

export async function apiFetch(path: string, opts: ApiFetchOptions = {}): Promise<Response> {
  const { headers: hdrs, retryOnNetworkError, idempotent = false, timeoutMs, ...rest } = opts;
  const method = (rest.method ?? "GET").toUpperCase();
  const retryNetwork = retryOnNetworkError ?? retriesNetwork(method, idempotent);
  const idempotencyKey = idempotent && !new Headers(hdrs).has(IDEMPOTENCY_HEADER) ? newIdempotencyKey() : null;

  const initial = (await supabase.auth.getSession()).data.session;
  const attempt = async (token: string | undefined) => {
    const headers = new Headers(hdrs);
    if (idempotencyKey) headers.set(IDEMPOTENCY_HEADER, idempotencyKey);
    if (!headers.has("Content-Type") && rest.body && typeof rest.body === "string") {
      headers.set("Content-Type", "application/json");
    }
    if (token) headers.set("Authorization", `Bearer ${token}`);
    if (!timeoutMs) return fetch(apiUrl(path), { ...rest, headers });
    const ctrl = new AbortController();
    const outer = rest.signal;
    if (outer?.aborted) ctrl.abort();
    else outer?.addEventListener("abort", () => ctrl.abort(), { once: true });
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetch(apiUrl(path), { ...rest, headers, signal: ctrl.signal });
    } catch (e) {
      if (ctrl.signal.aborted && !outer?.aborted) {
        throw new ApiFetchError(0, "timeout", "This took too long. Check your connection and try again.");
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  };
  const send = (token: string | undefined) =>
    retryNetwork ? fetchWithTransientRetry(() => attempt(token)) : attempt(token);

  const res = await send(initial?.access_token);
  if (res.status === 403) await noticeTenantDisabled(res);
  if (res.status !== 401 || !initial?.access_token) return res;
  const fresh = await refreshSessionOnce();
  if (
    !fresh ||
    fresh.userId !== initial.user?.id ||
    decodeActiveTenantClaim(fresh.token) !== decodeActiveTenantClaim(initial.access_token)
  ) {
    return res;
  }
  const replay = await send(fresh.token);
  if (replay.status === 403) await noticeTenantDisabled(replay);
  return replay;
}

export async function apiJson<T>(path: string, opts: ApiFetchOptions = {}): Promise<T> {
  const res = await apiFetch(path, opts);
  const text = await res.text();
  let body: unknown = undefined;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
  }
  if (!res.ok) {
    const err = (body as { error?: ApiError } | undefined)?.error;
    throw new ApiFetchError(
      res.status,
      err?.code || `http_${res.status}`,
      err?.message || `Request failed (${res.status})`,
    );
  }
  return body as T;
}
