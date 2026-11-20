
import {
  DATA_ORIGIN,
  FA,
  readCapped,
  signAssertion,
  type AssertionMeta,
  type DataAccess,
  FN_NAME_RE,
  UUID_RE,
} from "./shared";

export interface FetcherLike {
  fetch(request: Request): Promise<Response>;
}
export interface RateLimitLike {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}
export interface AnalyticsLike {
  writeDataPoint(p: { indexes?: string[]; blobs?: string[]; doubles?: number[] }): void;
}

export interface ZfnParams {
  v: 1;
  site_id: string;
  host: string;
  fn: string;
  data: DataAccess;
  invocation_id: string;
  allowed_hosts: string[];
}

export interface KVLike {
  get(key: string, type: "text"): Promise<string | null>;
}

export interface OutboundEnv {
  zfn?: unknown;
  GATEWAY: FetcherLike;
  HOSTS?: KVLike;
  FN_ASSERTION_SECRET?: string;
  RL_EGRESS?: RateLimitLike;
  FN_METRICS?: AnalyticsLike;
  PLATFORM_ALLOWED_HOSTS?: string;
}

export const PLATFORM_ALLOWED_HOSTS = ["api.stripe.com"];
const DATA_PATH = /^\/api\/(data|actions|aggregates|storage)\/[^?#]*$|^\/api\/site$/;
const MAX_DATA_BODY = 64 * 1024;
const DENY_SUFFIXES = [
  ".zaviagent.com", "zaviagent.com", ".supabase.co", ".supabase.in", ".workers.dev", ".pages.dev",
  ".internal", ".local", ".localhost", "localhost", ".lan", ".home", ".corp", ".intranet",
  "metadata.google.internal", ".cloudflareclient.com",
];
const HOST_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function parseParams(raw: unknown): ZfnParams | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  if (p.v !== 1 || typeof p.site_id !== "string" || !UUID_RE.test(p.site_id)) return null;
  if (typeof p.host !== "string" || !HOST_RE.test(p.host)) return null;
  if (typeof p.fn !== "string" || !FN_NAME_RE.test(p.fn)) return null;
  if (p.data !== "function" && p.data !== "admin") return null;
  if (typeof p.invocation_id !== "string" || !/^[A-Za-z0-9:_.-]{1,128}$/.test(p.invocation_id)) return null;
  if (!Array.isArray(p.allowed_hosts) || !p.allowed_hosts.every((h) => typeof h === "string")) return null;
  return { v: 1, site_id: p.site_id, host: p.host, fn: p.fn, data: p.data, invocation_id: p.invocation_id, allowed_hosts: p.allowed_hosts as string[] };
}

function deny(status: number, code: string): Response {
  return new Response(JSON.stringify({ error: { code } }), { status, headers: { "content-type": "application/json", "x-zavi-egress": code } });
}

const isIpLiteral = (h: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":") || /^\[/.test(h) || /^0x[0-9a-f]+$/i.test(h) || /^\d+$/.test(h);

export function isDeniedHost(h: string, siteHost: string): boolean {
  if (isIpLiteral(h) || !HOST_RE.test(h)) return true;
  if (h === siteHost) return true;
  return DENY_SUFFIXES.some((s) => (s.startsWith(".") ? h.endsWith(s) || h === s.slice(1) : h === s));
}

export function hostAllowed(h: string, allowed: readonly string[]): boolean {
  for (const a of allowed) {
    const x = a.toLowerCase();
    if (x.startsWith("*.")) {
      const suffix = x.slice(1);
      if (h.endsWith(suffix) && h.length > suffix.length) return true;
    } else if (h === x) return true;
  }
  return false;
}

function metric(env: OutboundEnv, p: ZfnParams, kind: string, host: string, status: number): void {
  try {
    env.FN_METRICS?.writeDataPoint({ indexes: [p.site_id], blobs: [p.fn, kind, host], doubles: [status] });
  } catch {
  }
}

const STRIP_TO_GATEWAY = /^(authorization|cookie|origin|referer|host|sec-fetch-.*|cf-.*|x-zavi-.*|x-forwarded-.*|x-real-ip|content-length)$/i;

async function toGateway(request: Request, url: URL, p: ZfnParams, env: OutboundEnv, now: number): Promise<Response> {
  if (!DATA_PATH.test(url.pathname)) return deny(403, "data_path_not_allowed");
  if (!env.FN_ASSERTION_SECRET) return deny(503, "function_identity_unavailable");
  const body = request.method === "GET" || request.method === "HEAD" ? new Uint8Array(0) : await readCapped(request, MAX_DATA_BODY);
  if (body === null) return deny(413, "payload_too_large");
  const pathAndQuery = url.pathname + url.search;
  const meta: AssertionMeta = { v: 1, site_id: p.site_id, host: p.host, fn: p.fn, data: p.data, invocation_id: p.invocation_id };
  const headers = new Headers();
  for (const [k, v] of request.headers) if (!STRIP_TO_GATEWAY.test(k)) headers.set(k, v);
  for (const [k, v] of Object.entries(await signAssertion(env.FN_ASSERTION_SECRET, meta, request.method, pathAndQuery, body, now))) headers.set(k, v);
  const init: RequestInit = { method: request.method, headers, redirect: "manual" };
  if (body.byteLength) init.body = body;
  const res = await env.GATEWAY.fetch(new Request(`https://${p.host}${pathAndQuery}`, init));
  metric(env, p, "data", "gateway", res.status);
  return res;
}

export async function handleOutbound(request: Request, env: OutboundEnv, now: () => number = Date.now): Promise<Response> {
  const p = parseParams(env.zfn);
  if (!p) return deny(503, "egress_unconfigured");
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return deny(400, "invalid_url");
  }
  if (url.origin === DATA_ORIGIN) return toGateway(request, url, p, env, now());
  if (url.protocol !== "https:") return deny(403, "https_required");
  if (url.port && url.port !== "443") return deny(403, "port_not_allowed");
  if (url.username || url.password) return deny(403, "credentials_in_url");
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (isDeniedHost(host, p.host)) return deny(403, "host_not_allowed");
  const platform = (env.PLATFORM_ALLOWED_HOSTS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!hostAllowed(host, [...(platform.length ? platform : PLATFORM_ALLOWED_HOSTS), ...p.allowed_hosts])) return deny(403, "host_not_allowed");
  if (!env.HOSTS) return deny(503, "egress_unconfigured");
  try {
    const [h, pv] = await Promise.all([env.HOSTS.get(`host:${host}`, "text"), env.HOSTS.get(`preview:${host}`, "text")]);
    if (h !== null || pv !== null) return deny(403, "host_not_allowed");
  } catch {
    return deny(503, "egress_unconfigured");
  }
  if (!env.RL_EGRESS) return deny(503, "rate_limiter_unavailable");
  if (!(await env.RL_EGRESS.limit({ key: p.site_id })).success) return deny(429, "egress_rate_limited");
  const out = new Request(request, { redirect: "manual" });
  out.headers.delete(FA.ts);
  out.headers.delete(FA.meta);
  out.headers.delete(FA.sig);
  let res: Response;
  try {
    res = await fetch(out);
  } catch {
    metric(env, p, "egress", host, 0);
    return deny(502, "egress_failed");
  }
  metric(env, p, "egress", host, res.status);
  return res;
}

export default {
  fetch(request: Request, env: OutboundEnv): Promise<Response> {
    return handleOutbound(request, env);
  },
};
