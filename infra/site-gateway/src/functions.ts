
import { decodeJwt } from "./jwt";
import {
  FA,
  MAX_FN_BODY_BYTES,
  readCapped,
  signInvocation,
  verifyAssertion,
  type AssertionMeta,
  type InvocationMeta,
} from "../../site-functions/src/shared";
import type { Env, FetcherLike, ResolvedSite } from "./worker";

export const FN_ROUTE = /^\/api\/(fn|hooks)\/([a-z][a-z0-9-]{0,47})$/;
export const DISPATCH_URL = "https://fn-dispatch.internal/v1/invoke";
export const FD_METHOD_HEADER = "x-zavi-fd-method";
export const SIGNER_FN_URL = "https://signer.internal/mint-fn";
export const FN_DATA_MAX_BODY = 64 * 1024;

const DROP_TO_DISPATCH = /^(authorization|cookie|host|content-length|connection|x-zavi-.*|x-forwarded-.*|x-real-ip|cf-.*)$/i;

export interface FunctionsEnv {
  FUNCTIONS?: FetcherLike;
  FN_DISPATCH_SECRET?: string;
  FN_ASSERTION_SECRET?: string;
}

export function isFunctionAssertion(request: Request): boolean {
  return request.headers.has(FA.sig) || request.headers.has(FA.meta) || request.headers.has(FA.ts);
}

export interface FnHelpers {
  HttpError: new (status: number, code: string, extra?: Record<string, string>) => Error;
  now: () => number;
}

export async function dispatchRequest(env: Env & FunctionsEnv, request: Request, site: ResolvedSite, kind: "http" | "webhook", name: string, body: Uint8Array, user: InvocationMeta["user"], requestId: string, url: URL, nowMs: number): Promise<Request> {
  const meta: InvocationMeta = {
    v: 1,
    site_id: site.binding.site_id,
    host: site.hostname,
    kind,
    name,
    request_id: /^[A-Za-z0-9:_.-]{1,128}$/.test(requestId) ? requestId : crypto.randomUUID(),
    user: kind === "http" ? user : null,
    public_path: url.pathname + url.search,
  };
  const method = request.method.toUpperCase();
  const headers = new Headers();
  request.headers.forEach((v, k) => {
    if (!DROP_TO_DISPATCH.test(k)) headers.set(k, v);
  });
  for (const [k, v] of Object.entries(await signInvocation(env.FN_DISPATCH_SECRET!, meta, method, body, nowMs))) headers.set(k, v);
  headers.set(FD_METHOD_HEADER, method);
  return new Request(DISPATCH_URL, { method: "POST", headers, body });
}

export function userFromToken(token: string, sub: string): { id: string; role: string | null } {
  const d = decodeJwt(token);
  const role = d && typeof d.payload.site_role === "string" && /^[a-z][a-z0-9_]{0,31}$/.test(d.payload.site_role) ? d.payload.site_role : null;
  return { id: sub, role };
}

const fnTokenCache = new Map<string, { token: string; exp: number; at: number }>();
export const FN_TOKEN_CACHE_S = 10;
const FN_CACHE_MAX = 5000;
export function clearFnTokenCache(): void {
  fnTokenCache.clear();
}

export async function functionToken(env: Env, site: ResolvedSite, a: AssertionMeta, h: FnHelpers): Promise<string> {
  const nowS = Math.floor(h.now() / 1000);
  const key = `${site.binding.shard_id}:${site.binding.site_id}:${a.fn}:${a.data}`;
  const hit = fnTokenCache.get(key);
  if (hit && hit.exp - nowS > 15 && nowS - hit.at < FN_TOKEN_CACHE_S) return hit.token;
  let res: Response;
  try {
    res = await env.SIGNER.fetch(new Request(SIGNER_FN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ shard_id: site.binding.shard_id, site_id: site.binding.site_id, fn: a.fn, principal: a.data }),
    }));
  } catch {
    throw new h.HttpError(503, "function_identity_unavailable");
  }
  const body = (await res.json().catch(() => null)) as { token?: unknown; exp?: unknown; error?: unknown } | null;
  if (res.status === 403) throw new h.HttpError(403, "admin_not_granted");
  if (res.status === 404) throw new h.HttpError(503, "functions_unavailable");
  if (!res.ok || !body || typeof body.token !== "string" || typeof body.exp !== "number") throw new h.HttpError(503, "function_identity_unavailable");
  const d = decodeJwt(body.token);
  if (!d || d.payload.role !== "authenticated" || d.payload.site_id !== site.binding.site_id || d.payload.zfn !== a.fn ||
      d.payload.zfn_admin !== (a.data === "admin") || "site_role" in d.payload) {
    throw new h.HttpError(503, "function_identity_unavailable");
  }
  if (fnTokenCache.size >= FN_CACHE_MAX) fnTokenCache.clear();
  fnTokenCache.set(key, { token: body.token, exp: body.exp, at: nowS });
  return body.token;
}

export async function readFunctionAssertion(env: FunctionsEnv, request: Request, url: URL, site: ResolvedSite, h: FnHelpers): Promise<{ meta: AssertionMeta; body: Uint8Array }> {
  const method = request.method.toUpperCase();
  const body = method === "GET" || method === "HEAD" ? new Uint8Array(0) : await readCapped(request, FN_DATA_MAX_BODY);
  if (body === null) throw new h.HttpError(413, "payload_too_large");
  const meta = await verifyAssertion(env.FN_ASSERTION_SECRET, request.headers, method, url.pathname + url.search, body, h.now());
  if (!meta) throw new h.HttpError(401, "invalid_function_assertion");
  if (meta.site_id !== site.binding.site_id || meta.host !== site.hostname) throw new h.HttpError(403, "function_wrong_site");
  return { meta, body };
}

export async function readInvocationBody(request: Request, h: FnHelpers): Promise<Uint8Array> {
  const method = request.method.toUpperCase();
  if (method === "GET") return new Uint8Array(0);
  const body = await readCapped(request, MAX_FN_BODY_BYTES);
  if (body === null) throw new h.HttpError(413, "payload_too_large");
  return body;
}
