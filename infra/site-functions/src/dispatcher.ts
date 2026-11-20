
import {
  FN_KILL_ALL_KEY,
  INVOCATION_HEADER,
  MAX_FN_BODY_BYTES,
  fnSiteKey,
  readCapped,
  verifyInvocation,
  type FnSiteRecord,
  type InvocationMeta,
  type DataAccess,
  FN_NAME_RE,
} from "./shared";

export interface KVLike {
  get(key: string, type: "text"): Promise<string | null>;
}
export interface DispatchNamespaceLike {
  get(name: string, args?: Record<string, unknown>, options?: {
    limits?: { cpuMs?: number; subRequests?: number };
    outbound?: Record<string, unknown>;
  }): { fetch(req: Request): Promise<Response> };
}
export interface AnalyticsLike {
  writeDataPoint(p: { indexes?: string[]; blobs?: string[]; doubles?: number[] }): void;
}
export interface RateLimitLike {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

export interface DispatcherEnv {
  DISPATCH: DispatchNamespaceLike;
  HOSTS: KVLike;
  FN_DISPATCH_SECRET?: string;
  FN_METRICS?: AnalyticsLike;
  RL_FN_SITE?: RateLimitLike;
}

export interface DispatcherDeps {
  now: () => number;
  log: (line: Record<string, unknown>) => void;
}

export const DEFAULT_LIMITS = { cpu_ms: 50, subrequests: 50, wall_ms: 30_000 } as const;
export const MAX_LIMITS = { cpu_ms: 30_000, subrequests: 1_000, wall_ms: 60_000 } as const;
export const SCHEDULE_WALL_MS = 60_000;
const PRINCIPAL_RE = /^(anyone|signed_in|admin|role:[a-z][a-z0-9_]{0,31})$/;
const HOST_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

const DROP_REQUEST_HEADERS = new Set(["authorization", "cookie", "host", "content-length", "x-forwarded-for", "x-real-ip"]);
export const FD_METHOD_HEADER = "x-zavi-fd-method";

export class FnError extends Error {
  constructor(public status: number, public code: string) {
    super(code);
  }
}

function json(status: number, body: unknown, requestId: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-request-id": requestId },
  });
}

function fail(e: FnError, requestId: string): Response {
  return json(e.status, { error: { code: e.code, request_id: requestId } }, requestId);
}

export function parseSiteRecord(raw: string | null, siteId: string): FnSiteRecord | null {
  if (!raw) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (r.v !== 1 || r.site_id !== siteId || (r.status !== "active" && r.status !== "disabled")) return null;
  if (typeof r.script !== "string" || !/^[a-z0-9-]{1,63}$/.test(r.script)) return null;
  if (typeof r.generation !== "number" || !Number.isInteger(r.generation) || r.generation < 0) return null;
  const isData = (d: unknown): d is DataAccess => d === "function" || d === "admin";
  const endpoints: FnSiteRecord["endpoints"] = {};
  if (r.endpoints && typeof r.endpoints === "object" && !Array.isArray(r.endpoints)) {
    for (const [name, e] of Object.entries(r.endpoints as Record<string, unknown>)) {
      if (!FN_NAME_RE.test(name) || !e || typeof e !== "object") return null;
      const ep = e as Record<string, unknown>;
      if ((ep.type !== "http" && ep.type !== "webhook") || !isData(ep.data)) return null;
      const principals = Array.isArray(ep.principals) ? ep.principals : ["anyone"];
      if (!principals.every((p) => typeof p === "string" && PRINCIPAL_RE.test(p))) return null;
      endpoints[name] = { type: ep.type, data: ep.data, principals: principals as string[] };
    }
  } else return null;
  const schedules: FnSiteRecord["schedules"] = {};
  if (r.schedules && typeof r.schedules === "object" && !Array.isArray(r.schedules)) {
    for (const [name, s] of Object.entries(r.schedules as Record<string, unknown>)) {
      if (!FN_NAME_RE.test(name) || !s || typeof s !== "object" || !isData((s as { data?: unknown }).data)) return null;
      schedules[name] = { data: (s as { data: DataAccess }).data };
    }
  } else return null;
  const hosts = Array.isArray(r.allowed_hosts) ? r.allowed_hosts : [];
  if (!hosts.every((h) => typeof h === "string" && HOST_RE.test(h))) return null;
  const lim = r.limits && typeof r.limits === "object" ? (r.limits as Record<string, unknown>) : {};
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x > 0 ? Math.floor(x) : undefined);
  return {
    v: 1,
    site_id: siteId,
    status: r.status,
    generation: r.generation,
    script: r.script,
    test: r.test === true,
    endpoints,
    schedules,
    allowed_hosts: hosts as string[],
    limits: { cpu_ms: num(lim.cpu_ms), subrequests: num(lim.subrequests), wall_ms: num(lim.wall_ms) },
  };
}

export function effectiveLimits(rec: FnSiteRecord, kind: InvocationMeta["kind"]) {
  const pick = (v: number | undefined, d: number, max: number) => Math.min(v ?? d, max);
  const wallDefault = kind === "schedule" ? SCHEDULE_WALL_MS : DEFAULT_LIMITS.wall_ms;
  return {
    cpuMs: pick(rec.limits?.cpu_ms, DEFAULT_LIMITS.cpu_ms, MAX_LIMITS.cpu_ms),
    subRequests: pick(rec.limits?.subrequests, DEFAULT_LIMITS.subrequests, MAX_LIMITS.subrequests),
    wallMs: pick(rec.limits?.wall_ms, wallDefault, MAX_LIMITS.wall_ms),
  };
}

export function principalsAllow(principals: readonly string[], user: InvocationMeta["user"]): boolean {
  if (principals.includes("anyone")) return true;
  if (!user) return false;
  if (principals.includes("signed_in")) return true;
  if (user.role === "admin" && principals.includes("admin")) return true;
  return user.role !== null && principals.includes(`role:${user.role}`);
}

export function resolveTarget(rec: FnSiteRecord, meta: InvocationMeta): { data: DataAccess } {
  if (meta.kind === "schedule") {
    const s = rec.schedules[meta.name];
    if (!s) throw new FnError(404, "no_such_function");
    return { data: s.data };
  }
  const ep = rec.endpoints[meta.name];
  if (!ep || ep.type !== meta.kind) throw new FnError(404, "no_such_function");
  if (meta.kind === "http" && !principalsAllow(ep.principals, meta.user)) {
    throw new FnError(meta.user ? 403 : 401, meta.user ? "forbidden" : "sign_in_required");
  }
  return { data: ep.data };
}

export function userRequest(meta: InvocationMeta, originalHeaders: Headers, originalMethod: string, body: Uint8Array, invocationId: string, signal?: AbortSignal): Request {
  const headers = new Headers();
  if (meta.kind !== "schedule") {
    for (const [k, v] of originalHeaders) {
      const lk = k.toLowerCase();
      if (DROP_REQUEST_HEADERS.has(lk) || lk.startsWith("x-zavi-") || lk.startsWith("cf-")) continue;
      headers.set(k, v);
    }
  }
  headers.set(INVOCATION_HEADER, JSON.stringify({
    v: 1,
    type: meta.kind === "schedule" ? "schedule" : "request",
    kind: meta.kind,
    function: meta.name,
    site_id: meta.site_id,
    site_origin: `https://${meta.host}`,
    invocation_id: invocationId,
    user: meta.user,
    scheduled_time: meta.scheduled_time ?? null,
    idempotency_key: meta.idempotency_key ?? null,
    attempt: meta.attempt ?? null,
  }));
  const path = meta.kind === "schedule" ? `/__zavi/schedule/${meta.name}` : meta.public_path!;
  const method = meta.kind === "schedule" ? "POST" : originalMethod.toUpperCase();
  const init: RequestInit = { method, headers };
  if (signal) init.signal = signal;
  if (method !== "GET" && method !== "HEAD") init.body = body;
  return new Request(`https://${meta.host}${path}`, init);
}

export const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

export function boundedBody(body: ReadableStream<Uint8Array> | null, deadlineMs: number, now: () => number, abort: () => void): ReadableStream<Uint8Array> | null {
  if (!body) return null;
  const reader = body.getReader();
  let sent = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  const stop = (ctrl: ReadableStreamDefaultController<Uint8Array> | null, err: unknown) => {
    if (finished) return;
    finished = true;
    if (timer) clearTimeout(timer);
    abort();
    reader.cancel().catch(() => undefined);
    if (ctrl) {
      try {
        ctrl.error(err);
      } catch {
      }
    }
  };
  return new ReadableStream<Uint8Array>({
    start(ctrl) {
      const left = deadlineMs - now();
      if (left <= 0) {
        stop(ctrl, new FnError(504, "function_timeout"));
        return;
      }
      timer = setTimeout(() => stop(ctrl, new FnError(504, "function_timeout")), left);
    },
    async pull(ctrl) {
      if (finished) return;
      if (deadlineMs - now() <= 0) {
        stop(ctrl, new FnError(504, "function_timeout"));
        return;
      }
      try {
        const r = await reader.read();
        if (finished) return;
        if (r.done) {
          finished = true;
          if (timer) clearTimeout(timer);
          ctrl.close();
          return;
        }
        sent += r.value.byteLength;
        if (sent > MAX_RESPONSE_BYTES) {
          stop(ctrl, new FnError(502, "function_response_too_large"));
          return;
        }
        ctrl.enqueue(r.value);
      } catch (e) {
        stop(ctrl, e);
      }
    },
    cancel() {
      stop(null, null);
    },
  });
}

export function sanitizeResponse(res: Response, requestId: string, body: ReadableStream<Uint8Array> | null = res.body): Response {
  const headers = new Headers(res.headers);
  headers.delete("set-cookie");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-request-id", requestId);
  if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
  const ct = (headers.get("content-type") ?? "").toLowerCase();
  if (!ct || /html|xml|svg|javascript|ecmascript/.test(ct)) {
    headers.set("content-security-policy", "default-src 'none'; sandbox");
  }
  headers.delete("content-length");
  return new Response(body, { status: res.status, statusText: res.statusText, headers });
}

let killCache: { at: number; on: boolean } | null = null;
export function resetKillCache(): void {
  killCache = null;
}
async function killedAll(env: DispatcherEnv, nowMs: number): Promise<boolean> {
  if (killCache && nowMs - killCache.at < 15_000) return killCache.on;
  const v = await env.HOSTS.get(FN_KILL_ALL_KEY, "text");
  killCache = { at: nowMs, on: v !== null };
  return killCache.on;
}

export function classifyFailure(e: unknown): FnError {
  const msg = String((e as Error)?.message ?? e ?? "").toLowerCase();
  if (e instanceof FnError) return e;
  if (msg.includes("worker not found") || msg.includes("script not found") || msg.includes("no such worker")) return new FnError(503, "function_not_deployed");
  if (msg.includes("cpu") || msg.includes("exceeded") || msg.includes("subrequest") || msg.includes("limit")) return new FnError(503, "function_limit_exceeded");
  return new FnError(500, "function_error");
}

export async function handleDispatch(request: Request, env: DispatcherEnv, partial: Partial<DispatcherDeps> = {}): Promise<Response> {
  const deps: DispatcherDeps = { now: partial.now ?? Date.now, log: partial.log ?? ((l) => console.log(JSON.stringify(l))) };
  const started = deps.now();
  const url = new URL(request.url);
  let requestId = request.headers.get("cf-ray") ?? crypto.randomUUID();
  let meta: InvocationMeta | null = null;
  let outcome = "error";
  let status = 500;
  try {
    if (request.method.toUpperCase() !== "POST" || url.pathname !== "/v1/invoke") throw new FnError(404, "not_found");
    const body = await readCapped(request, MAX_FN_BODY_BYTES);
    if (body === null) throw new FnError(413, "payload_too_large");
    const origMethod = (request.headers.get(FD_METHOD_HEADER) ?? "POST").toUpperCase();
    if (!/^(GET|POST|PUT|PATCH|DELETE)$/.test(origMethod)) throw new FnError(400, "invalid_method");
    meta = await verifyInvocation(env.FN_DISPATCH_SECRET, request.headers, origMethod, body, deps.now());
    if (!meta) throw new FnError(401, "unauthorized");
    requestId = meta.request_id;
    if (meta.kind !== "http" && origMethod !== "POST") throw new FnError(405, "method_not_allowed");
    if (await killedAll(env, deps.now())) throw new FnError(503, "functions_disabled");
    if (!env.RL_FN_SITE) throw new FnError(503, "rate_limiter_unavailable");
    if (!(await env.RL_FN_SITE.limit({ key: meta.site_id })).success) throw new FnError(429, "rate_limited");

    const rec = parseSiteRecord(await env.HOSTS.get(fnSiteKey(meta.site_id), "text"), meta.site_id);
    if (!rec) throw new FnError(404, "no_functions");
    if (rec.status !== "active") throw new FnError(503, "functions_disabled");
    const target = resolveTarget(rec, meta);
    const limits = effectiveLimits(rec, meta.kind);
    const invocationId = meta.kind === "schedule" ? meta.idempotency_key! : `${meta.request_id}`;

    const worker = env.DISPATCH.get(rec.script, {}, {
      limits: { cpuMs: limits.cpuMs, subRequests: limits.subRequests },
      outbound: {
        zfn: {
          v: 1,
          site_id: meta.site_id,
          host: meta.host,
          fn: meta.name,
          data: target.data,
          invocation_id: invocationId,
          allowed_hosts: rec.allowed_hosts,
        },
      },
    });
    const ac = new AbortController();
    const deadline = deps.now() + limits.wallMs;
    const forwarded = userRequest(meta, request.headers, origMethod, body, invocationId, ac.signal);
    const again = parseSiteRecord(await env.HOSTS.get(fnSiteKey(meta.site_id), "text"), meta.site_id);
    if (!again || again.status !== "active" || again.script !== rec.script) throw new FnError(503, "functions_disabled");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, rej) => {
      timer = setTimeout(() => { ac.abort(); rej(new FnError(504, "function_timeout")); }, limits.wallMs);
    });
    let res: Response;
    try {
      res = await Promise.race([worker.fetch(forwarded), timeout]);
    } catch (e) {
      ac.abort();
      throw classifyFailure(e);
    } finally {
      if (timer) clearTimeout(timer);
    }
    status = res.status;
    outcome = res.status >= 500 ? "fn_5xx" : "ok";
    return sanitizeResponse(res, requestId, boundedBody(res.body, deadline, deps.now, () => ac.abort()));
  } catch (e) {
    const err = e instanceof FnError ? e : classifyFailure(e);
    status = err.status;
    outcome = err.code;
    return fail(err, requestId);
  } finally {
    const ms = deps.now() - started;
    const line = {
      evt: "site_fn_invoke",
      request_id: requestId,
      site_id: meta?.site_id ?? null,
      fn: meta?.name ?? null,
      kind: meta?.kind ?? null,
      attempt: meta?.attempt ?? null,
      status,
      outcome,
      ms,
    };
    try {
      deps.log(line);
      env.FN_METRICS?.writeDataPoint({
        indexes: [meta?.site_id ?? "unknown"],
        blobs: [meta?.name ?? "", meta?.kind ?? "", outcome],
        doubles: [ms, status],
      });
    } catch {
    }
  }
}

export default {
  fetch(request: Request, env: DispatcherEnv): Promise<Response> {
    return handleDispatch(request, env);
  },
};
