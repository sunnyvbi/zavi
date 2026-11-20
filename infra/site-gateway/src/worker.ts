import { decodeJwt, findJwk, verifyEs256 } from "./jwt";
import {
  FN_ROUTE,
  dispatchRequest,
  functionToken,
  isFunctionAssertion,
  readFunctionAssertion,
  readInvocationBody,
  userFromToken,
  type FnHelpers,
  type FunctionsEnv,
} from "./functions";
import type { AssertionMeta } from "../../site-functions/src/shared";

export interface KVNamespaceLike {
  get(key: string, type: "text"): Promise<string | null>;
}

export interface RateLimitLike {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

export interface AnalyticsEngineLike {
  writeDataPoint(point: { indexes?: string[]; blobs?: Array<string | null>; doubles?: number[] }): void;
}

export interface FetcherLike {
  fetch(request: Request): Promise<Response>;
}

export interface Env extends FunctionsEnv {
  RL_HOOK?: RateLimitLike;
  HOSTS: KVNamespaceLike;
  SIGNER: FetcherLike;
  RL_READ?: RateLimitLike;
  RL_WRITE?: RateLimitLike;
  RL_SITE?: RateLimitLike;
  AUTH_BROKER_URL?: string;
  BROKER_HMAC_SECRET?: string;
  STORAGE_PROXY_SECRET?: string;
  TURNSTILE_SECRET?: string;
  TURNSTILE_SITE_KEY?: string;
  PREVIEW_DOMAIN?: string;
  PREVIEW_HMAC_SECRET?: string;
  SHARD_METRICS?: AnalyticsEngineLike;
}

export interface HostBinding {
  v: 1;
  site_id: string;
  shard_id: string;
  shard_url: string;
  status: string;
  binding_version?: number;
  manifest_hash?: string;
  turnstile?: boolean;
  turnstile_site_key?: string;
}

export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_LIST_LIMIT = 100;
export const MAX_FILTERS = 4;
export const SIGNED_URL_TTL_S = 300;
export const UPLOAD_TOKEN_TTL_S = 600;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_FILTER_PARAM = 4096;
export const MAX_IN_VALUES = 50;
export const UPLOAD_CONTENT_TYPES: ReadonlySet<string> = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif",
  "application/pdf", "text/plain", "text/csv", "application/json",
  "audio/mpeg", "audio/ogg", "audio/wav", "audio/webm", "video/mp4", "video/webm", "video/quicktime",
  "application/zip", "application/octet-stream",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);
const INLINE_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "application/pdf", "audio/mpeg", "audio/ogg", "audio/wav", "audio/webm", "video/mp4", "video/webm", "video/quicktime"]);
export const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
export const TURNSTILE_HEADER = "x-zavi-turnstile-token";
export const SIGNER_URL = "https://signer.internal/mint-anon";
export const BROKER_SKEW_S = 60;
export const AUTH_ACTIONS = ["signup", "login", "magic-link", "refresh", "logout", "recover", "password", "email", "delete", "callback", "confirm"] as const;
export type AuthAction = (typeof AUTH_ACTIONS)[number];
export const MEMBER_OPS = ["invite", "list", "set-role", "disable", "reenable", "remove", "reassign-owner", "delete-data"] as const;
export type MemberOp = (typeof MEMBER_OPS)[number];
export const TURNSTILE_SITE_KEY_RE = /^[0-9A-Za-z_-]{8,128}$/;
export const MAX_TRANSITION_TO = 64;
export const MAX_TRANSITION_FIELDS = 16;
function validTransitionFields(v: unknown): boolean {
  if (v === undefined) return true;
  if (!isPlainObject(v)) return false;
  const keys = Object.keys(v);
  return keys.length > 0 && keys.length <= MAX_TRANSITION_FIELDS && keys.every((k) => /^[a-z][a-z0-9_]{0,62}$/.test(k));
}
const AUTH_TURNSTILE: ReadonlySet<string> = new Set(["signup", "magic-link", "recover"]);
const AUTH_READ: ReadonlySet<string> = new Set(["refresh", "logout", "callback"]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const SHARD_ID = /^[a-z0-9]{20}$/;
const SHARD_URL = /^https:\/\/[a-z0-9]{20}\.supabase\.co$/;
const IDEM_KEY = /^[A-Za-z0-9_-]{16,128}$/;
const CURSOR = /^[0-9]{1,19}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type Op =
  | "list" | "get" | "create" | "update" | "delete"
  | "transition" | "action" | "aggregate"
  | "site"
  | "file_list" | "file_download" | "file_upload" | "file_delete" | "file_get_bytes" | "file_put_bytes"
  | `auth_${AuthAction}`
  | `member_${MemberOp}`;
const WRITE_OPS: ReadonlySet<string> = new Set([
  "create", "update", "delete", "transition", "action", "file_upload", "file_delete", "file_put_bytes",
  "member_invite", "member_set-role", "member_disable", "member_reenable", "member_remove", "member_reassign-owner", "member_delete-data",
]);

export interface Deps {
  now: () => number;
  fetch: typeof fetch;
}

const MESSAGES: Record<string, string> = {
  not_found: "Not found.",
  no_such_route: "No such API route.",
  site_not_found: "This site does not exist.",
  site_has_no_database: "This site has no database.",
  site_unavailable: "This site is not available right now.",
  shard_unavailable: "The site's database is not available right now.",
  cross_origin_forbidden: "Cross-origin requests are not allowed.",
  rate_limited: "Too many requests. Try again in a minute.",
  rate_limiter_unavailable: "Service temporarily unavailable.",
  invalid_session: "Your session is invalid or expired. Sign in again.",
  session_wrong_site: "This session belongs to another site. Sign in again.",
  sign_in_required: "Sign in to do this.",
  payload_too_large: "The request body is too large.",
  json_required: "Send a JSON body.",
  invalid_json: "The request body is not valid JSON.",
  turnstile_required: "Complete the verification challenge.",
  turnstile_failed: "The verification challenge failed.",
  quota_exceeded: "This site has reached a usage limit.",
  idempotency_key_required: "Send an Idempotency-Key header.",
  internal_error: "Something went wrong.",
  session_check_unavailable: "Sessions cannot be checked right now. Try again.",
  turnstile_unavailable: "The verification challenge cannot be checked right now. Try again.",
  invalid_reference: "A referenced record does not exist or is not available.",
  forbidden: "You are not allowed to do this.",
  action_not_allowed: "You are not allowed to run this action.",
  aggregate_not_allowed: "You are not allowed to read this aggregate.",
  unique_conflict: "A record with these values already exists.",
  transition_conflict: "The record is not in a state that allows this.",
  action_bound: "This action has reached its limit.",
  idempotency_conflict: "This Idempotency-Key was used for a different request.",
  aggregate_too_large: "Too many records to aggregate. Narrow the filter.",
  recipient_rate_limited: "Too many requests to this recipient. Try again later.",
  contract_building: "The site's data model is being updated. Try again shortly.",
  invalid_action_body: "Send {target_id, data} or {record_id}.",
  invalid_aggregate_body: "Send {filter}.",
  invalid_transition: "Send {to: <state>}.",
  invalid_member_body: "The request is not valid.",
  invalid_action_input: "The action input is not valid.",
  invalid_idempotency_key: "The Idempotency-Key is not valid.",
  field_not_writable: "A field in the request cannot be written here.",
  reference_restricted: "Other records still reference this record.",
  cascade_too_large: "Deleting this record would affect too many records.",
  index_building: "The site's data is being reindexed. Try again shortly.",
  sort_not_allowed: "Sorting by that field is not allowed.",
  system_field_immutable: "A system field cannot be changed.",
  owner_id_is_server_assigned: "The owner is assigned by the server.",
  preview_forbidden: "Open this preview from its signed link.",
  preview_expired: "This preview has expired.",
};

export class HttpError extends Error {
  constructor(public status: number, public code: string, public extra: Record<string, string> = {}) {
    super(code);
  }
}

export function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, "");
}

export interface ResolvedSite {
  hostname: string;
  binding: HostBinding;
  apikey: string;
}

async function readJson(env: Env, key: string): Promise<Record<string, unknown> | null> {
  const raw = await env.HOSTS.get(key, "text");
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

export async function resolveSite(env: Env, hostname: string): Promise<ResolvedSite> {
  const rec = await readJson(env, `host:${hostname}`);
  if (!rec) throw new HttpError(404, "site_not_found");
  if (rec.v === undefined && rec.site_id === undefined) throw new HttpError(404, "site_has_no_database");
  if (
    rec.v !== 1 ||
    typeof rec.site_id !== "string" || !UUID.test(rec.site_id) ||
    typeof rec.shard_id !== "string" || !SHARD_ID.test(rec.shard_id) ||
    typeof rec.shard_url !== "string" || !SHARD_URL.test(rec.shard_url) ||
    rec.shard_url !== `https://${rec.shard_id}.supabase.co` ||
    typeof rec.status !== "string"
  ) {
    throw new HttpError(503, "site_unavailable");
  }
  if (rec.status !== "active") {
    const code = /^[a-z_]{1,32}$/.test(rec.status) ? `site_${rec.status}` : "site_unavailable";
    throw new HttpError(503, code, { "retry-after": "60" });
  }
  const shard = await readJson(env, `shard:${rec.shard_id}`);
  if (!shard || typeof shard.apikey !== "string" || !shard.apikey || shard.status === "offline") {
    throw new HttpError(503, "shard_unavailable");
  }
  return { hostname, binding: rec as unknown as HostBinding, apikey: shard.apikey };
}

export const PREVIEW_COOKIE = "__zavi_preview";
export const PREVIEW_MAX_TTL_S = 15 * 60;
const PREVIEW_SKEW_S = 60;
const PREVIEW_LABEL = /^[a-z2-7]{26}$/;
const PREVIEW_DOMAIN_RE = /^(?=.{4,200}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const DEPLOY_ID = /^d[0-9a-z]{9}-[0-9a-f]{8}$/;

export function previewDomainOf(env: Pick<Env, "PREVIEW_DOMAIN">): string | null {
  const d = String(env.PREVIEW_DOMAIN ?? "").trim().toLowerCase().replace(/\.$/, "");
  return PREVIEW_DOMAIN_RE.test(d) ? d : null;
}

export function hostKind(hostname: string, domain: string | null): "preview" | "reserved" | "site" {
  if (!domain) return "site";
  if (hostname === domain) return "reserved";
  if (!hostname.endsWith(`.${domain}`)) return "site";
  return PREVIEW_LABEL.test(hostname.slice(0, -(domain.length + 1))) ? "preview" : "reserved";
}

function readCookie(request: Request, name: string): string | null {
  const raw = request.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export async function verifyPreviewCookie(secret: string | undefined, request: Request, hostname: string, deployId: string, nowMs: number): Promise<boolean> {
  if (!secret) return false;
  const v = readCookie(request, PREVIEW_COOKIE);
  const m = v ? /^([A-Za-z0-9_-]{1,128})\.(\d{1,12})\.([0-9a-f]{64})$/.exec(v) : null;
  if (!m || m[1] !== deployId) return false;
  const exp = Number(m[2]);
  const nowS = Math.floor(nowMs / 1000);
  if (exp <= nowS || exp > nowS + PREVIEW_MAX_TTL_S + PREVIEW_SKEW_S) return false;
  return timingSafeEqual(await hmacHex(secret, `preview.${hostname}.${deployId}.${exp}`), m[3]);
}

export async function resolvePreviewSite(env: Env, hostname: string, request: Request, nowMs: number, opts: { functionCall?: boolean } = {}): Promise<ResolvedSite> {
  const rec = await readJson(env, `preview:${hostname}`);
  if (!rec) throw new HttpError(404, "site_not_found");
  if (
    rec.v !== 1 ||
    typeof rec.test_site_id !== "string" || !UUID.test(rec.test_site_id) ||
    typeof rec.deploy_id !== "string" || !DEPLOY_ID.test(rec.deploy_id) ||
    typeof rec.exp !== "number" || !Number.isSafeInteger(rec.exp) ||
    typeof rec.shard_id !== "string" || !SHARD_ID.test(rec.shard_id) ||
    typeof rec.shard_url !== "string" || rec.shard_url !== `https://${rec.shard_id}.supabase.co`
  ) {
    throw new HttpError(503, "site_unavailable");
  }
  if (rec.exp * 1000 <= nowMs) throw new HttpError(410, "preview_expired");
  if (!opts.functionCall && !(await verifyPreviewCookie(env.PREVIEW_HMAC_SECRET, request, hostname, rec.deploy_id, nowMs))) {
    throw new HttpError(403, "preview_forbidden");
  }
  const shard = await readJson(env, `shard:${rec.shard_id}`);
  if (!shard || typeof shard.apikey !== "string" || !shard.apikey || shard.status === "offline") {
    throw new HttpError(503, "shard_unavailable");
  }
  const binding: HostBinding = { v: 1, site_id: rec.test_site_id, shard_id: rec.shard_id, shard_url: rec.shard_url, status: "active", turnstile: false };
  return { hostname, binding, apikey: shard.apikey };
}

export async function resolveAnySite(env: Env, hostname: string, request: Request, nowMs: number, opts: { functionCall?: boolean } = {}): Promise<ResolvedSite> {
  const kind = hostKind(hostname, previewDomainOf(env));
  if (kind === "reserved") throw new HttpError(404, "site_not_found");
  if (kind === "preview") return resolvePreviewSite(env, hostname, request, nowMs, opts);
  return resolveSite(env, hostname);
}

export interface Principal {
  kind: "anon" | "user" | "function";
  sub?: string;
  startedAt?: number;
  token: string;
}

export async function verifyUserToken(token: string, site: ResolvedSite, deps: Deps): Promise<Principal> {
  const d = decodeJwt(token);
  if (!d || d.header.alg !== "ES256" || typeof d.header.kid !== "string") throw new HttpError(401, "invalid_session");
  const jwk = await findJwk(`${site.binding.shard_url}/auth/v1/.well-known/jwks.json`, d.header.kid, deps.now(), deps.fetch);
  if (!jwk || !(await verifyEs256(jwk, d))) throw new HttpError(401, "invalid_session");
  const p = d.payload;
  const nowS = Math.floor(deps.now() / 1000);
  if (
    typeof p.exp !== "number" || p.exp <= nowS ||
    (typeof p.nbf === "number" && p.nbf > nowS + 60) ||
    p.role !== "authenticated" ||
    typeof p.sub !== "string" || !UUID.test(p.sub) ||
    typeof p.session_started_at !== "number" || !Number.isFinite(p.session_started_at)
  ) {
    throw new HttpError(401, "invalid_session");
  }
  if (p.site_id !== site.binding.site_id) throw new HttpError(401, "session_wrong_site");
  if ("zfn" in p || "zfn_admin" in p) throw new HttpError(401, "invalid_session");
  return { kind: "user", sub: p.sub, token, startedAt: p.session_started_at as number };
}

const anonCache = new Map<string, { token: string; exp: number }>();
const ANON_CACHE_MAX = 5000;
const ANON_MIN_REMAINING_S = 30;

export function clearAnonCache(): void {
  anonCache.clear();
}

export async function anonToken(env: Env, site: ResolvedSite, nowMs: number): Promise<string> {
  const cacheKey = `${site.binding.shard_id}:${site.binding.site_id}`;
  const nowS = Math.floor(nowMs / 1000);
  const hit = anonCache.get(cacheKey);
  if (hit && hit.exp - nowS > ANON_MIN_REMAINING_S) return hit.token;
  if (!env.SIGNER) throw new HttpError(503, "shard_unavailable");
  let res: Response;
  try {
    res = await env.SIGNER.fetch(new Request(SIGNER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ shard_id: site.binding.shard_id, site_id: site.binding.site_id }),
    }));
  } catch {
    throw new HttpError(503, "shard_unavailable");
  }
  const body = (await res.json().catch(() => null)) as { token?: unknown; exp?: unknown } | null;
  if (!res.ok || !body || typeof body.token !== "string" || typeof body.exp !== "number") throw new HttpError(503, "shard_unavailable");
  const d = decodeJwt(body.token);
  if (!d || d.payload.role !== "anon" || d.payload.site_id !== site.binding.site_id || "sub" in d.payload) {
    throw new HttpError(503, "shard_unavailable");
  }
  if (anonCache.size >= ANON_CACHE_MAX) anonCache.clear();
  anonCache.set(cacheKey, { token: body.token, exp: body.exp });
  return body.token;
}

function selfOrigin(hostname: string): string {
  return `https://${hostname}`;
}

function checkOrigin(request: Request, hostname: string, url: URL): void {
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== selfOrigin(hostname)) throw new HttpError(403, "cross_origin_forbidden");
  if (request.method.toUpperCase() === "GET" && url.pathname === "/api/auth/callback") return;
  const sfs = request.headers.get("sec-fetch-site");
  if (sfs === "cross-site" || sfs === "same-site") throw new HttpError(403, "cross_origin_forbidden");
}

async function rateLimit(env: Env, siteId: string, ip: string, op: Op): Promise<void> {
  const write = WRITE_OPS.has(op) || (op.startsWith("auth_") && !AUTH_READ.has(op.slice(5)));
  const perIp = write ? env.RL_WRITE : env.RL_READ;
  const perSite = env.RL_SITE;
  if (!perIp || !perSite) throw new HttpError(503, "rate_limiter_unavailable");
  const [a, b] = await Promise.all([
    perIp.limit({ key: `${siteId}:${ip}:${op}` }),
    perSite.limit({ key: siteId }),
  ]);
  if (!a.success || !b.success) throw new HttpError(429, "rate_limited", { "retry-after": "60" });
}

async function readBody(request: Request, requireJson: boolean): Promise<Uint8Array> {
  const ct = (request.headers.get("content-type") ?? "").toLowerCase();
  if (requireJson && !ct.startsWith("application/json")) throw new HttpError(415, "json_required");
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
    throw new HttpError(413, "payload_too_large");
  }
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new HttpError(413, "payload_too_large");
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return buf;
}

async function readJsonBody(request: Request): Promise<unknown> {
  const buf = await readBody(request, true);
  try {
    return JSON.parse(new TextDecoder().decode(buf));
  } catch {
    throw new HttpError(400, "invalid_json");
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

async function checkTurnstile(request: Request, env: Env, site: ResolvedSite, ip: string, deps: Deps): Promise<string> {
  if (!env.TURNSTILE_SECRET || site.binding.turnstile === false) return "skipped-not-configured";
  const token = request.headers.get(TURNSTILE_HEADER);
  if (!token || token.length > 2048) throw new HttpError(403, "turnstile_required");
  if (hasCustomWidget(site)) {
    if (!(await brokerTurnstileVerify(env, site, token, ip, deps))) throw new HttpError(403, "turnstile_failed");
    return "verified";
  }
  const form = new FormData();
  form.set("secret", env.TURNSTILE_SECRET);
  form.set("response", token);
  if (ip !== "unknown") form.set("remoteip", ip);
  let ok = false;
  try {
    const res = await deps.fetch(TURNSTILE_VERIFY_URL, { method: "POST", body: form });
    const body = (await res.json()) as { success?: boolean; hostname?: string };
    ok = res.ok && body?.success === true && body.hostname === site.hostname;
  } catch {
    ok = false;
  }
  if (!ok) throw new HttpError(403, "turnstile_failed");
  return "verified";
}

function hasCustomWidget(site: ResolvedSite): boolean {
  const k = site.binding.turnstile_site_key;
  return typeof k === "string" && TURNSTILE_SITE_KEY_RE.test(k);
}

async function brokerTurnstileVerify(env: Env, site: ResolvedSite, token: string, ip: string, deps: Deps): Promise<boolean> {
  const base = env.AUTH_BROKER_URL;
  if (!base || !/^https:\/\//.test(base) || !env.BROKER_HMAC_SECRET) throw new HttpError(503, "turnstile_unavailable");
  const body = new TextEncoder().encode(JSON.stringify({ token, ip }));
  const ts = Math.floor(deps.now() / 1000);
  const requestId = crypto.randomUUID();
  const action = "turnstile-verify";
  const sig = await hmacHex(env.BROKER_HMAC_SECRET, brokerSigningString({
    ts, request_id: requestId, site_id: site.binding.site_id, host: site.hostname, shard_id: site.binding.shard_id,
    method: "POST", action, query: "", client_ip: ip, body_sha256: await sha256Hex(body),
  }));
  let res: Response;
  try {
    res = await deps.fetch(`${base.replace(/\/+$/, "")}/${action}`, {
      method: "POST",
      headers: {
        "x-zavi-gw-ts": String(ts), "x-zavi-gw-request-id": requestId, "x-zavi-gw-site-id": site.binding.site_id,
        "x-zavi-gw-host": site.hostname, "x-zavi-gw-shard-id": site.binding.shard_id, "x-zavi-gw-client-ip": ip,
        "x-zavi-gw-sig": sig, "content-type": "application/json", accept: "application/json",
      },
      body,
    });
  } catch {
    throw new HttpError(503, "turnstile_unavailable");
  }
  const out = (await res.json().catch(() => null)) as { data?: { success?: unknown } } | null;
  if (res.status >= 500) throw new HttpError(503, "turnstile_unavailable");
  return res.ok && out?.data?.success === true;
}

export interface Route {
  op: Op;
  collection?: string;
  id?: string;
  area?: string;
  name?: string;
  action?: AuthAction;
  member?: MemberOp;
  fn?: string;
}

export function matchRoute(method: string, pathname: string): Route | null {
  const parts = pathname.split("/");
  if (parts[0] !== "" || parts[1] !== "api") return null;
  const rest = parts.slice(2);
  if (rest.length === 0 || rest.some((s) => s === "")) return null;

  if (rest[0] === "data" && rest.length === 4 && rest[3] === "transition") {
    const collection = rest[1];
    const id = rest[2].toLowerCase();
    if (!NAME.test(collection) || !UUID.test(id)) return null;
    return method === "POST" ? { op: "transition", collection, id } : null;
  }

  if ((rest[0] === "actions" || rest[0] === "aggregates") && rest.length === 2) {
    if (!NAME.test(rest[1]) || method !== "POST") return null;
    return { op: rest[0] === "actions" ? "action" : "aggregate", fn: rest[1] };
  }

  if (rest[0] === "members" && rest.length === 2) {
    const m = rest[1] as MemberOp;
    if (!(MEMBER_OPS as readonly string[]).includes(m)) return null;
    if (m === "list" ? method !== "GET" : method !== "POST") return null;
    return { op: `member_${m}`, member: m };
  }

  if (rest[0] === "data" && (rest.length === 2 || rest.length === 3)) {
    const collection = rest[1];
    if (!NAME.test(collection)) return null;
    if (rest.length === 2) {
      if (method === "GET") return { op: "list", collection };
      if (method === "POST") return { op: "create", collection };
      return null;
    }
    const id = rest[2].toLowerCase();
    if (!UUID.test(id)) return null;
    if (method === "GET") return { op: "get", collection, id };
    if (method === "PATCH") return { op: "update", collection, id };
    if (method === "DELETE") return { op: "delete", collection, id };
    return null;
  }

  if (rest.length === 1 && rest[0] === "site") return method === "GET" ? { op: "site" } : null;

  if (rest[0] === "storage" && rest.length === 4 && rest[2] === "object") {
    const area = rest[1];
    if (!NAME.test(area) || !FILE.test(rest[3])) return null;
    if (method === "GET") return { op: "file_get_bytes", area, name: rest[3] };
    if (method === "PUT") return { op: "file_put_bytes", area, name: rest[3] };
    return null;
  }

  if (rest[0] === "storage" && rest.length === 3) {
    const area = rest[1];
    if (!NAME.test(area)) return null;
    if (method === "DELETE") {
      let name: string;
      try {
        name = decodeURIComponent(rest[2]);
      } catch {
        return null;
      }
      return FILE.test(name) ? { op: "file_delete", area, name } : null;
    }
    if (rest[2] === "list" && method === "GET") return { op: "file_list", area };
    if (rest[2] === "download-url" && method === "POST") return { op: "file_download", area };
    if (rest[2] === "upload-url" && method === "POST") return { op: "file_upload", area };
    return null;
  }

  if (rest[0] === "auth" && rest.length === 2) {
    const action = rest[1] as AuthAction;
    if (!(AUTH_ACTIONS as readonly string[]).includes(action)) return null;
    if (action === "callback" ? method !== "GET" : method !== "POST") return null;
    return { op: `auth_${action}`, action };
  }
  return null;
}

const FILTER_OPS = new Set(["eq", "in", "gt", "gte", "lt", "lte", "prefix"]);
const SORT = /^-?[a-z][a-z0-9_]{0,62}$/;
const CURSOR_B64 = /^[A-Za-z0-9+/]{1,1024}={0,2}$/;

function isScalar(v: unknown): boolean {
  return (typeof v === "string" && v.length <= 512) || (typeof v === "number" && Number.isFinite(v)) || typeof v === "boolean";
}

export function checkFilter(f: unknown): Record<string, unknown> {
  if (!isPlainObject(f)) throw new HttpError(400, "invalid_filter");
  const fields = Object.keys(f);
  if (fields.length > MAX_FILTERS) throw new HttpError(400, "too_many_filters");
  for (const field of fields) {
    if (!NAME.test(field)) throw new HttpError(400, "invalid_filter");
    const cond = f[field];
    if (isScalar(cond)) continue;
    if (!isPlainObject(cond) || Object.keys(cond).length === 0) throw new HttpError(400, "invalid_filter");
    for (const [op, ov] of Object.entries(cond)) {
      if (!FILTER_OPS.has(op)) throw new HttpError(400, "invalid_filter");
      if (op === "in") {
        if (!Array.isArray(ov) || ov.length === 0 || ov.length > MAX_IN_VALUES || !ov.every(isScalar)) throw new HttpError(400, "invalid_filter");
      } else if (op === "prefix") {
        if (typeof ov !== "string" || ov.length === 0 || ov.length > 512) throw new HttpError(400, "invalid_filter");
      } else if (!isScalar(ov)) {
        throw new HttpError(400, "invalid_filter");
      }
    }
  }
  return f;
}

export function parseListQuery(url: URL): { p_filter: Record<string, unknown>; p_limit: number; p_cursor: string | null; p_sort: string | null } {
  let filter: Record<string, unknown> = {};
  let limit = 50;
  let cursor: string | null = null;
  let sort: string | null = null;
  const seen = new Set<string>();
  for (const [k, v] of url.searchParams) {
    if (seen.has(k)) throw new HttpError(400, "duplicate_query_param");
    seen.add(k);
    if (k === "limit") {
      if (!/^\d{1,3}$/.test(v) || Number(v) < 1 || Number(v) > MAX_LIST_LIMIT) throw new HttpError(400, "invalid_limit");
      limit = Number(v);
    } else if (k === "cursor") {
      if (!CURSOR_B64.test(v)) throw new HttpError(400, "invalid_cursor");
      cursor = v;
    } else if (k === "sort") {
      if (!SORT.test(v)) throw new HttpError(400, "invalid_sort");
      sort = v;
    } else if (k === "filter") {
      if (v.length > MAX_FILTER_PARAM) throw new HttpError(400, "invalid_filter");
      let f: unknown;
      try {
        f = JSON.parse(v);
      } catch {
        throw new HttpError(400, "invalid_filter");
      }
      filter = checkFilter(f);
    } else {
      throw new HttpError(400, "unknown_query_param");
    }
  }
  return { p_filter: filter, p_limit: limit, p_cursor: cursor, p_sort: sort };
}

const KNOWN_DB_ERRORS = new Set([
  "unknown_collection", "invalid_filter", "filter_not_allowed", "invalid_cursor", "idempotency_key_required",
  "idempotency_conflict", "anonymous_write_forbidden", "invalid_patch", "not_found", "no_site",
  "quota_exceeded", "validation_failed",
]);

export const KERNEL_ERRORS: Readonly<Record<string, { state: string; status: number; retry?: string }>> = {
  invalid_reference: { state: "22023", status: 400 },
  invalid_action_input: { state: "22023", status: 400 },
  invalid_idempotency_key: { state: "22023", status: 400 },
  idempotency_key_required: { state: "22023", status: 400 },
  sort_not_allowed: { state: "22023", status: 400 },
  idempotency_conflict: { state: "22023", status: 409 },
  not_found: { state: "P0002", status: 404 },
  action_not_allowed: { state: "42501", status: 403 },
  aggregate_not_allowed: { state: "42501", status: 403 },
  field_not_writable: { state: "42501", status: 403 },
  field_not_readable: { state: "42501", status: 403 },
  invalid_transition: { state: "22023", status: 400 },
  system_field_immutable: { state: "42501", status: 403 },
  owner_id_is_server_assigned: { state: "42501", status: 403 },
  unique_conflict: { state: "23505", status: 409 },
  transition_conflict: { state: "55000", status: 409 },
  action_bound: { state: "55000", status: 409 },
  reference_restricted: { state: "55000", status: 409 },
  index_building: { state: "55000", status: 503, retry: "5" },
  aggregate_too_large: { state: "54000", status: 422 },
  cascade_too_large: { state: "54000", status: 422 },
  recipient_rate_limited: { state: "53400", status: 429, retry: "60" },
  quota_exceeded: { state: "53400", status: 429, retry: "60" },
  contract_building: { state: "55000", status: 503, retry: "5" },
};
export const CONTRACT_ERRORS: Readonly<Record<string, number>> = Object.fromEntries(
  Object.entries(KERNEL_ERRORS).map(([k, v]) => [k, v.status]),
);

export function mapDbError(status: number, body: unknown): HttpError {
  const b = isPlainObject(body) ? body : {};
  const code = typeof b.code === "string" ? b.code : "";
  const message = typeof b.message === "string" ? b.message : "";
  const head = message.split(":")[0].trim();
  const known = KNOWN_DB_ERRORS.has(head) ? head : null;
  const k = Object.prototype.hasOwnProperty.call(KERNEL_ERRORS, head) ? KERNEL_ERRORS[head] : null;
  if (k && k.state === code) return new HttpError(k.status, head, k.retry ? { "retry-after": k.retry } : {});
  if (code === "P0002") return new HttpError(404, "not_found");
  if (known === "quota_exceeded" || code === "53400") return new HttpError(429, "quota_exceeded");
  if (code === "42501") return new HttpError(403, known ?? "forbidden");
  if (code === "22023" || code === "23514" || code === "22P02") return new HttpError(400, known ?? "invalid_request");
  if (code === "23505") return new HttpError(409, "conflict");
  if (status >= 500) return new HttpError(502, "shard_error");
  return new HttpError(status >= 400 && status < 500 ? status : 502, known ?? "request_failed");
}

function shardHeaders(site: ResolvedSite, principal: Principal): Record<string, string> {
  return {
    apikey: site.apikey,
    authorization: `Bearer ${principal.token}`,
    "content-type": "application/json",
    accept: "application/json",
  };
}

async function callRpc(site: ResolvedSite, principal: Principal, fn: string, args: Record<string, unknown>, deps: Deps): Promise<unknown> {
  let res: Response;
  try {
    res = await deps.fetch(`${site.binding.shard_url}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: { ...shardHeaders(site, principal), "content-profile": "api", "accept-profile": "api" },
      body: JSON.stringify(args),
    });
  } catch {
    throw new HttpError(502, "shard_unreachable");
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw mapDbError(res.status, body);
  return body;
}

export async function checkSession(site: ResolvedSite, principal: Principal, deps: Deps): Promise<void> {
  if (principal.kind !== "user") return;
  let res: Response;
  try {
    res = await deps.fetch(`${site.binding.shard_url}/rest/v1/rpc/session_valid`, {
      method: "POST",
      headers: { ...shardHeaders(site, principal), "content-profile": "api", "accept-profile": "api" },
      body: "{}",
    });
  } catch {
    throw new HttpError(503, "session_check_unavailable");
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new HttpError(res.status === 401 ? 401 : 503, res.status === 401 ? "invalid_session" : "session_check_unavailable");
  if (body !== true) throw new HttpError(401, "invalid_session");
}

async function guarded<T>(site: ResolvedSite, principal: Principal, deps: Deps, write: boolean, fn: () => Promise<T>): Promise<T> {
  if (principal.kind !== "user") return fn();
  if (write) {
    await checkSession(site, principal, deps);
    return fn();
  }
  const work = fn();
  work.catch(() => undefined);
  await checkSession(site, principal, deps);
  return work;
}

const BUCKET = "site-files";

async function callStorage(site: ResolvedSite, principal: Principal, path: string, method: string, body: unknown, deps: Deps, extraHeaders?: Record<string, string>): Promise<unknown> {
  let res: Response;
  try {
    res = await deps.fetch(`${site.binding.shard_url}/storage/v1/${path}`, {
      method,
      headers: { ...shardHeaders(site, principal), ...(extraHeaders ?? {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new HttpError(502, "shard_unreachable");
  }
  const out = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = isPlainObject(out) ? String(out.message ?? out.error ?? "") : "";
    if (res.status === 404 || /not.?found/i.test(msg)) throw new HttpError(404, "not_found");
    if (res.status === 401 || res.status === 403 || /row-level security|unauthorized/i.test(msg)) throw new HttpError(403, "forbidden");
    if (res.status === 413 || /too large/i.test(msg)) throw new HttpError(413, "payload_too_large");
    throw new HttpError(res.status >= 500 ? 502 : 400, "storage_error");
  }
  return out;
}

function objectPath(site: ResolvedSite, area: string, name: string): string {
  return `${site.binding.site_id}/${area}/${name}`;
}

export interface ProxyClaims {
  o: "u" | "d";
  s: string;
  p: string;
  e: number;
  t: string;
  ct?: string;
  n?: number;
  x?: boolean;
  u?: string;
  ss?: number;
}

function b64url(s: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(s: string): string {
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export async function signProxyToken(secret: string, c: ProxyClaims): Promise<string> {
  const body = b64url(JSON.stringify(c));
  return `${body}.${await hmacHex(secret, `zavi-storage-v1.${body}`)}`;
}

export async function verifyProxyToken(secret: string, token: string, nowMs: number): Promise<ProxyClaims | null> {
  const m = /^([A-Za-z0-9_-]{1,4096})\.([0-9a-f]{64})$/.exec(token);
  if (!m) return null;
  if (!timingSafeEqual(await hmacHex(secret, `zavi-storage-v1.${m[1]}`), m[2])) return null;
  try {
    const c = JSON.parse(unb64url(m[1])) as ProxyClaims;
    if (!c || typeof c.e !== "number" || c.e <= Math.floor(nowMs / 1000)) return null;
    return c;
  } catch {
    return null;
  }
}

function shardUrlToken(rel: unknown): string {
  if (typeof rel !== "string") throw new HttpError(502, "storage_error");
  const q = rel.indexOf("?");
  const t = q < 0 ? null : new URLSearchParams(rel.slice(q + 1)).get("token");
  if (!t || !/^[A-Za-z0-9_.-]{1,4096}$/.test(t)) throw new HttpError(502, "storage_error");
  return t;
}

function userBinding(principal: Principal): { u?: string; ss?: number } {
  return principal.kind === "user" ? { u: principal.sub, ss: principal.startedAt } : {};
}

function proxyPath(area: string, name: string, token: string): string {
  return `/api/storage/${area}/object/${name}?t=${encodeURIComponent(token)}`;
}

function proxySecret(env: Env): string {
  if (!env.STORAGE_PROXY_SECRET) throw new HttpError(503, "storage_unavailable");
  return env.STORAGE_PROXY_SECRET;
}

async function proxyClaims(env: Env, site: ResolvedSite, route: Route, url: URL, op: "u" | "d", deps: Deps): Promise<ProxyClaims> {
  const t = url.searchParams.get("t");
  if (!t || [...url.searchParams].length !== 1) throw new HttpError(403, "invalid_file_token");
  const c = await verifyProxyToken(proxySecret(env), t, deps.now());
  if (!c || c.o !== op || c.s !== site.binding.site_id || c.p !== objectPath(site, route.area!, route.name!)) {
    throw new HttpError(403, "invalid_file_token");
  }
  return c;
}

async function checkCapabilitySession(env: Env, site: ResolvedSite, c: ProxyClaims, deps: Deps): Promise<void> {
  if (c.u === undefined) return;
  if (typeof c.u !== "string" || !UUID.test(c.u) || typeof c.ss !== "number") throw new HttpError(403, "invalid_file_token");
  const anon: Principal = { kind: "anon", token: await anonToken(env, site, deps.now()) };
  let ok: unknown;
  try {
    ok = await callRpc(site, anon, "session_valid_for", { p_sub: c.u, p_started: c.ss }, deps);
  } catch {
    throw new HttpError(503, "session_check_unavailable");
  }
  if (ok !== true) throw new HttpError(403, "invalid_file_token");
}

async function checkSiteActive(env: Env, site: ResolvedSite, deps: Deps): Promise<void> {
  const anon: Principal = { kind: "anon", token: await anonToken(env, site, deps.now()) };
  let ok: unknown;
  try {
    ok = await callRpc(site, anon, "site_active", {}, deps);
  } catch {
    throw new HttpError(503, "site_unavailable", { "retry-after": "60" });
  }
  if (ok !== true) throw new HttpError(503, "site_unavailable", { "retry-after": "60" });
}

async function putBytes(request: Request, env: Env, site: ResolvedSite, route: Route, url: URL, deps: Deps): Promise<unknown> {
  const c = await proxyClaims(env, site, route, url, "u", deps);
  await checkCapabilitySession(env, site, c, deps);
  await checkSiteActive(env, site, deps);
  const ct = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (ct !== c.ct) throw new HttpError(415, "content_type_mismatch");
  const size = c.n ?? 0;
  const declared = request.headers.get("content-length");
  if (declared !== null && declared !== String(size)) throw new HttpError(413, "size_mismatch");
  if (!request.body) throw new HttpError(400, "size_mismatch");
  const reader = request.body.getReader();
  const buf = new Uint8Array(size);
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > size) {
      await reader.cancel().catch(() => undefined);
      throw new HttpError(413, "size_mismatch");
    }
    buf.set(value, total);
    total += value.byteLength;
  }
  if (total !== size) throw new HttpError(400, "size_mismatch");
  let res: Response;
  try {
    res = await deps.fetch(`${site.binding.shard_url}/storage/v1/object/upload/sign/${BUCKET}/${c.p}?token=${encodeURIComponent(c.t)}`, {
      method: "PUT",
      headers: { apikey: site.apikey, "content-type": c.ct!, "x-upsert": c.x ? "true" : "false" },
      body: buf,
    });
  } catch {
    throw new HttpError(502, "shard_unreachable");
  }
  if (!res.ok) {
    const out = await res.json().catch(() => null);
    const msg = isPlainObject(out) ? String(out.message ?? out.error ?? "") : "";
    if (res.status === 409 || /exists|duplicate/i.test(msg)) throw new HttpError(409, "file_exists");
    if (/row-level security|unauthorized|signature|expired/i.test(msg) || res.status === 401 || res.status === 403) throw new HttpError(403, "forbidden");
    throw new HttpError(res.status >= 500 ? 502 : 400, "storage_error");
  }
  return { name: route.name };
}

async function getBytes(env: Env, site: ResolvedSite, route: Route, url: URL, requestId: string, deps: Deps): Promise<Response> {
  const c = await proxyClaims(env, site, route, url, "d", deps);
  await checkCapabilitySession(env, site, c, deps);
  let res: Response;
  try {
    res = await deps.fetch(`${site.binding.shard_url}/storage/v1/object/sign/${BUCKET}/${c.p}?token=${encodeURIComponent(c.t)}`, { method: "GET" });
  } catch {
    throw new HttpError(502, "shard_unreachable");
  }
  if (res.status === 404 || res.status === 400) throw new HttpError(404, "not_found");
  if (!res.ok) throw new HttpError(res.status === 401 || res.status === 403 ? 403 : 502, res.status === 401 || res.status === 403 ? "forbidden" : "storage_error");
  const len = res.headers.get("content-length");
  if (len !== null && Number(len) > MAX_UPLOAD_BYTES) throw new HttpError(502, "storage_error");
  const upstream = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const type = UPLOAD_CONTENT_TYPES.has(upstream) ? upstream : "application/octet-stream";
  const headers: Record<string, string> = {
    "content-type": type,
    "content-disposition": INLINE_TYPES.has(type) ? "inline" : `attachment; filename="${route.name}"`,
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
    "cross-origin-resource-policy": "same-origin",
    "cache-control": "private, max-age=300",
    "x-request-id": requestId,
  };
  if (len !== null) headers["content-length"] = len;
  return new Response(res.body, { status: 200, headers });
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function brokerSigningString(f: {
  ts: number; request_id: string; site_id: string; host: string; shard_id: string;
  method: string; action: string; query: string; client_ip: string; body_sha256: string;
}): string {
  return ["zavi-gw-v1", f.ts, f.request_id, f.site_id, f.host, f.shard_id, f.method, f.action, f.query, f.client_ip, f.body_sha256].join("\n");
}

async function proxyAuth(request: Request, env: Env, site: ResolvedSite, route: Route, url: URL, ip: string, requestId: string, deps: Deps, preread?: Uint8Array): Promise<Response> {
  const base = env.AUTH_BROKER_URL;
  if (!base || !/^https:\/\//.test(base) || !env.BROKER_HMAC_SECRET) throw new HttpError(503, "auth_unavailable");
  const action = route.member ? `members-${route.member}` : route.action!;
  const method = route.action === "callback" || route.member === "list" ? "GET" : "POST";
  let body: Uint8Array = new Uint8Array(0);
  let contentType = "application/json";
  if (method === "POST") {
    if (preread) {
      body = preread;
    } else if (route.action === "confirm") {
      const ct = (request.headers.get("content-type") ?? "").toLowerCase();
      const form = ct.startsWith("application/x-www-form-urlencoded");
      if (!form && !ct.startsWith("application/json")) throw new HttpError(415, "json_required");
      body = await readBody(request, false);
      if (form) contentType = "application/x-www-form-urlencoded";
    } else {
      body = await readBody(request, true);
    }
  }
  if (url.search.length > 2048) throw new HttpError(400, "invalid_request");
  const ts = Math.floor(deps.now() / 1000);
  const fields = {
    ts, request_id: requestId, site_id: site.binding.site_id, host: site.hostname, shard_id: site.binding.shard_id,
    method, action, query: url.search, client_ip: ip, body_sha256: await sha256Hex(body),
  };
  const headers: Record<string, string> = {
    "x-zavi-gw-ts": String(ts),
    "x-zavi-gw-request-id": requestId,
    "x-zavi-gw-site-id": fields.site_id,
    "x-zavi-gw-host": fields.host,
    "x-zavi-gw-shard-id": fields.shard_id,
    "x-zavi-gw-client-ip": ip,
    "x-zavi-gw-sig": await hmacHex(env.BROKER_HMAC_SECRET, brokerSigningString(fields)),
    accept: "application/json",
  };
  if (method === "POST") headers["content-type"] = contentType;
  const authz = request.headers.get("authorization");
  if (authz && /^Bearer [A-Za-z0-9_.-]{1,8192}$/.test(authz)) headers.authorization = authz;
  let res: Response;
  try {
    res = await deps.fetch(`${base.replace(/\/+$/, "")}/${action}${url.search}`, {
      method,
      headers,
      body: method === "POST" ? body : undefined,
      redirect: "manual",
    });
  } catch {
    throw new HttpError(502, "auth_unreachable");
  }
  const out = new Headers({
    "cache-control": "no-store", "x-content-type-options": "nosniff", "x-request-id": requestId, vary: "Origin",
    "referrer-policy": "no-referrer",
  });
  const ct = res.headers.get("content-type");
  if (ct) out.set("content-type", ct);
  const csp = res.headers.get("content-security-policy");
  if (csp) out.set("content-security-policy", csp);
  if (res.headers.get("referrer-policy") === "strict-origin") out.set("referrer-policy", "strict-origin");
  const loc = res.headers.get("location");
  if (loc && res.status >= 300 && res.status < 400) {
    let ok = false;
    try {
      const target = new URL(loc, selfOrigin(site.hostname));
      ok = target.origin === selfOrigin(site.hostname);
      if (ok) out.set("location", target.pathname + target.search + target.hash);
    } catch {
      ok = false;
    }
    if (!ok) throw new HttpError(502, "auth_bad_redirect");
  }
  const origin = request.headers.get("origin");
  if (origin === selfOrigin(site.hostname)) out.set("access-control-allow-origin", origin);
  return new Response(res.body, { status: res.status, headers: out });
}

const ROLE = /^[a-z][a-z0-9_]{0,31}$/;
const MEMBER_BODY_MAX = 2048;

async function memberBody(request: Request, op: MemberOp): Promise<Uint8Array> {
  const buf = await readBody(request, true);
  if (buf.byteLength > MEMBER_BODY_MAX) throw new HttpError(413, "payload_too_large");
  let b: unknown;
  try {
    b = JSON.parse(new TextDecoder().decode(buf));
  } catch {
    throw new HttpError(400, "invalid_json");
  }
  if (!isPlainObject(b)) throw new HttpError(400, "invalid_member_body");
  const keys = Object.keys(b).sort().join();
  const uid = (v: unknown) => typeof v === "string" && UUID.test(v);
  const ok =
    op === "invite" ? keys === "email,role" && typeof b.email === "string" && b.email.length >= 3 && b.email.length <= 320 && typeof b.role === "string" && ROLE.test(b.role)
    : op === "set-role" ? keys === "role,user_id" && uid(b.user_id) && typeof b.role === "string" && ROLE.test(b.role)
    : op === "reassign-owner" ? keys === "collection,id,to_user_id" && typeof b.collection === "string" && NAME.test(b.collection)
        && uid(b.id) && uid(b.to_user_id)
    : op === "delete-data" ? keys === "confirm,user_id" && uid(b.user_id) && b.confirm === true
    : keys === "user_id" && uid(b.user_id);
  if (!ok) throw new HttpError(400, "invalid_member_body");
  return buf;
}

function checkMemberListQuery(url: URL): void {
  const seen = new Set<string>();
  for (const [k, v] of url.searchParams) {
    if (seen.has(k)) throw new HttpError(400, "duplicate_query_param");
    seen.add(k);
    if (k === "limit") {
      if (!/^\d{1,3}$/.test(v) || Number(v) < 1 || Number(v) > MAX_LIST_LIMIT) throw new HttpError(400, "invalid_limit");
    } else if (k === "cursor") {
      if (!UUID.test(v)) throw new HttpError(400, "invalid_cursor");
    } else {
      throw new HttpError(400, "unknown_query_param");
    }
  }
}

export function turnstileSiteKey(env: Env, site: ResolvedSite): string | null {
  if (!env.TURNSTILE_SECRET || site.binding.turnstile === false) return null;
  const own = site.binding.turnstile_site_key;
  if (typeof own === "string" && TURNSTILE_SITE_KEY_RE.test(own)) return own;
  const dflt = env.TURNSTILE_SITE_KEY;
  return typeof dflt === "string" && TURNSTILE_SITE_KEY_RE.test(dflt) ? dflt : null;
}

function respond(status: number, payload: unknown, hostname: string, request: Request, extra: Record<string, string>, requestId: string): Response {
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-request-id": requestId,
    vary: "Origin",
    ...extra,
  };
  const origin = request.headers.get("origin");
  if (origin === selfOrigin(hostname)) headers["access-control-allow-origin"] = origin;
  return new Response(JSON.stringify(payload), { status, headers });
}

function preflight(request: Request, hostname: string): Response {
  const origin = request.headers.get("origin");
  if (origin !== selfOrigin(hostname)) {
    return new Response(null, { status: 403, headers: { vary: "Origin", "cache-control": "no-store" } });
  }
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET, POST, PATCH, PUT, DELETE",
      "access-control-allow-headers": `authorization, content-type, idempotency-key, ${TURNSTILE_HEADER}`,
      "access-control-max-age": "600",
      vary: "Origin",
      "cache-control": "no-store",
    },
  });
}

function fnHelpers(deps: Deps): FnHelpers {
  return { HttpError, now: deps.now };
}

async function invokeFunction(
  request: Request, env: Env, deps: Deps, url: URL, hostname: string, requestId: string,
  kind: "http" | "webhook", name: string,
): Promise<Response> {
  const method = request.method.toUpperCase();
  if (kind === "webhook" ? method !== "POST" : method !== "GET" && method !== "POST") throw new HttpError(405, "method_not_allowed");
  if (isFunctionAssertion(request)) throw new HttpError(403, "function_route_forbidden");
  if (!env.FUNCTIONS || !env.FN_DISPATCH_SECRET) throw new HttpError(503, "functions_unavailable");
  const site = await resolveAnySite(env, hostname, request, deps.now());
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const limiter = kind === "webhook" ? env.RL_HOOK : method === "GET" ? env.RL_READ : env.RL_WRITE;
  if (!limiter || !env.RL_SITE) throw new HttpError(503, "rate_limiter_unavailable");
  const [a, b] = await Promise.all([
    limiter.limit({ key: kind === "webhook" ? `${site.binding.site_id}:hook:${name}` : `${site.binding.site_id}:${ip}:fn` }),
    env.RL_SITE.limit({ key: site.binding.site_id }),
  ]);
  if (!a.success || !b.success) throw new HttpError(429, "rate_limited", { "retry-after": "60" });

  let user: { id: string; role: string | null } | null = null;
  const authz = request.headers.get("authorization");
  if (kind === "http" && authz !== null) {
    const m = /^Bearer ([A-Za-z0-9_.-]{1,8192})$/.exec(authz);
    if (!m) throw new HttpError(401, "invalid_session");
    const p = await verifyUserToken(m[1], site, deps);
    await checkSession(site, p, deps);
    user = userFromToken(m[1], p.sub!);
  }
  const body = await readInvocationBody(request, fnHelpers(deps));
  const dreq = await dispatchRequest(env, request, site, kind, name, body, user, requestId, url, deps.now());
  let res: Response;
  try {
    res = await env.FUNCTIONS.fetch(dreq);
  } catch {
    throw new HttpError(502, "functions_unreachable");
  }
  const headers = new Headers(res.headers);
  headers.delete("set-cookie");
  headers.set("vary", "Origin");
  headers.set("x-request-id", requestId);
  const origin = request.headers.get("origin");
  if (origin === selfOrigin(hostname)) headers.set("access-control-allow-origin", origin);
  return new Response(res.body, { status: res.status, headers });
}

export type OnSite = (shardRef: string, siteId: string) => void;

export async function handle(request: Request, env: Env, partial: Partial<Deps> & { onSite?: OnSite } = {}): Promise<Response> {
  const deps: Deps = { now: partial.now ?? Date.now, fetch: partial.fetch ?? ((...a) => fetch(...a)) };
  const method = request.method.toUpperCase();
  const url = new URL(request.url);
  const hostname = normalizeHost(url.hostname);
  const requestId = request.headers.get("cf-ray") ?? crypto.randomUUID();
  const extra: Record<string, string> = {};
  try {
    if (!url.pathname.startsWith("/api/")) throw new HttpError(404, "not_found");
    if (method === "OPTIONS") return preflight(request, hostname);
    checkOrigin(request, hostname, url);

    const fnRoute = FN_ROUTE.exec(url.pathname);
    if (fnRoute) {
      return await invokeFunction(request, env, deps, url, hostname, requestId, fnRoute[1] === "hooks" ? "webhook" : "http", fnRoute[2]);
    }

    const route = matchRoute(method, url.pathname);
    if (!route) throw new HttpError(404, "no_such_route");

    const fnCall = isFunctionAssertion(request);
    const site = await resolveAnySite(env, hostname, request, deps.now(), { functionCall: fnCall });
    let fnAssertion: AssertionMeta | null = null;
    if (fnCall) {
      if (route.action || route.member) throw new HttpError(403, "function_route_forbidden");
      const r = await readFunctionAssertion(env, request, url, site, fnHelpers(deps));
      fnAssertion = r.meta;
      request = new Request(request.url, { method: request.method, headers: request.headers, body: r.body.byteLength ? r.body : undefined });
    }
    const ip = fnAssertion ? `fn:${fnAssertion.fn}` : (request.headers.get("cf-connecting-ip") ?? "unknown");
    partial.onSite?.(site.binding.shard_id, site.binding.site_id);
    await rateLimit(env, site.binding.site_id, ip, route.op);

    if (route.op === "site") {
      return respond(200, { data: { site_id: site.binding.site_id, turnstile_site_key: turnstileSiteKey(env, site) } }, hostname, request, { "cache-control": "public, max-age=60" }, requestId);
    }
    if (route.op === "file_get_bytes") return await getBytes(env, site, route, url, requestId, deps);
    if (route.op === "file_put_bytes") {
      return respond(200, { data: await putBytes(request, env, site, route, url, deps) }, hostname, request, extra, requestId);
    }

    if (route.action) {
      if (AUTH_TURNSTILE.has(route.action)) extra["x-zavi-turnstile"] = await checkTurnstile(request, env, site, ip, deps);
      const res = await proxyAuth(request, env, site, route, url, ip, requestId, deps);
      for (const [k, v] of Object.entries(extra)) res.headers.set(k, v);
      return res;
    }

    if (route.member) {
      const m = /^Bearer ([A-Za-z0-9_.-]{1,8192})$/.exec(request.headers.get("authorization") ?? "");
      if (!m) throw new HttpError(401, "sign_in_required");
      await verifyUserToken(m[1], site, deps);
      const body = route.member === "list" ? undefined : await memberBody(request, route.member);
      if (route.member === "list") checkMemberListQuery(url);
      return await proxyAuth(request, env, site, route, url, ip, requestId, deps, body);
    }

    const authz = request.headers.get("authorization");
    let principal: Principal;
    if (fnAssertion) {
      const t = await functionToken(env, site, fnAssertion, fnHelpers(deps));
      principal = { kind: "function", sub: String(decodeJwt(t)?.payload.sub ?? ""), token: t };
    } else if (authz !== null) {
      const m = /^Bearer ([A-Za-z0-9_.-]{1,8192})$/.exec(authz);
      if (!m) throw new HttpError(401, "invalid_session");
      principal = await verifyUserToken(m[1], site, deps);
    } else {
      if (["update", "delete", "file_delete", "transition", "aggregate"].includes(route.op)) throw new HttpError(401, "sign_in_required");
      if (route.op === "create" || route.op === "file_upload" || route.op === "action") {
        extra["x-zavi-turnstile"] = await checkTurnstile(request, env, site, ip, deps);
      }
      principal = { kind: "anon", token: await anonToken(env, site, deps.now()) };
    }
    const ok = (status: number, data: unknown) => respond(status, { data }, hostname, request, extra, requestId);
    const write = WRITE_OPS.has(route.op);
    const rpc = (fn: string, args: Record<string, unknown>) => guarded(site, principal, deps, write, () => callRpc(site, principal, fn, args, deps));
    const storage = (path: string, method: string, body: unknown, extraHeaders?: Record<string, string>) =>
      guarded(site, principal, deps, write, () => callStorage(site, principal, path, method, body, deps, extraHeaders));

    switch (route.op) {
      case "list":
        return ok(200, await rpc("list_records", { p_collection: route.collection, ...parseListQuery(url) }));
      case "get": {
        if (url.search) throw new HttpError(400, "unknown_query_param");
        const rec = await rpc("get_record", { p_collection: route.collection, p_id: route.id });
        if (rec === null) throw new HttpError(404, "not_found");
        return ok(200, rec);
      }
      case "create": {
        const body = await readJsonBody(request);
        if (!isPlainObject(body) || Object.keys(body).join() !== "data" || !isPlainObject(body.data)) throw new HttpError(400, "invalid_document");
        const data = body.data;
        const key = request.headers.get("idempotency-key");
        if (key !== null && !IDEM_KEY.test(key)) throw new HttpError(400, "invalid_idempotency_key");
        if (principal.kind === "anon" && key === null) throw new HttpError(400, "idempotency_key_required");
        const out = await rpc("create_record", { p_collection: route.collection, p_data: data, p_idempotency_key: key });
        return ok(isPlainObject(out) && out.replayed === true ? 200 : 201, out);
      }
      case "update": {
        const body = await readJsonBody(request);
        if (!isPlainObject(body) || Object.keys(body).join() !== "patch" || !isPlainObject(body.patch)) throw new HttpError(400, "invalid_patch");
        const patch = body.patch;
        return ok(200, await rpc("update_record", { p_collection: route.collection, p_id: route.id, p_patch: patch }));
      }
      case "delete":
        return ok(200, await rpc("delete_record", { p_collection: route.collection, p_id: route.id }));
      case "file_list": {
        let limit = 100;
        let offset = 0;
        for (const [k, v] of url.searchParams) {
          if (k === "limit" && /^\d{1,3}$/.test(v) && Number(v) >= 1 && Number(v) <= MAX_LIST_LIMIT) limit = Number(v);
          else if (k === "offset" && /^\d{1,6}$/.test(v)) offset = Number(v);
          else throw new HttpError(400, "invalid_query");
        }
        const rows = await storage(`object/list/${BUCKET}`, "POST", {
          prefix: `${site.binding.site_id}/${route.area}/`, limit, offset, sortBy: { column: "created_at", order: "desc" },
        });
        const items = Array.isArray(rows)
          ? rows.filter((r) => isPlainObject(r) && typeof r.name === "string" && FILE.test(r.name))
              .map((r) => {
                const meta = isPlainObject(r.metadata) ? r.metadata : {};
                return { name: r.name, size: typeof meta.size === "number" ? meta.size : 0, content_type: typeof meta.mimetype === "string" ? meta.mimetype : null, created_at: r.created_at ?? null };
              })
          : [];
        return ok(200, { items });
      }
      case "file_download": {
        const body = await readJsonBody(request);
        if (!isPlainObject(body) || Object.keys(body).join() !== "name" || typeof body.name !== "string" || !FILE.test(body.name)) throw new HttpError(400, "invalid_name");
        const secret = proxySecret(env);
        const p = objectPath(site, route.area!, body.name);
        const out = await storage(`object/sign/${BUCKET}/${p}`, "POST", { expiresIn: SIGNED_URL_TTL_S });
        const t = shardUrlToken(isPlainObject(out) ? out.signedURL ?? out.signedUrl : undefined);
        const exp = Math.floor(deps.now() / 1000) + SIGNED_URL_TTL_S;
        const token = await signProxyToken(secret, { o: "d", s: site.binding.site_id, p, e: exp, t, ...userBinding(principal) });
        return ok(200, { url: proxyPath(route.area!, body.name, token), expires_in: SIGNED_URL_TTL_S });
      }
      case "file_upload": {
        const body = await readJsonBody(request);
        if (!isPlainObject(body)) throw new HttpError(400, "invalid_request");
        const extraKeys = Object.keys(body).filter((k) => !["name", "content_type", "size", "upsert"].includes(k));
        if (extraKeys.length) throw new HttpError(400, "invalid_request");
        if (typeof body.name !== "string" || !FILE.test(body.name)) throw new HttpError(400, "invalid_name");
        const ct = typeof body.content_type === "string" ? body.content_type.toLowerCase() : "";
        if (!UPLOAD_CONTENT_TYPES.has(ct)) throw new HttpError(415, "content_type_not_allowed");
        if (typeof body.size !== "number" || !Number.isInteger(body.size) || body.size < 1 || body.size > MAX_UPLOAD_BYTES) {
          throw new HttpError(413, "file_too_large");
        }
        if (body.upsert !== undefined && typeof body.upsert !== "boolean") throw new HttpError(400, "invalid_request");
        const upsert = body.upsert === true;
        if (upsert && principal.kind === "anon") throw new HttpError(401, "sign_in_required");
        const secret = proxySecret(env);
        const p = objectPath(site, route.area!, body.name);
        const out = await storage(`object/upload/sign/${BUCKET}/${p}`, "POST", undefined,
          upsert ? { "x-upsert": "true" } : undefined);
        const t = shardUrlToken(isPlainObject(out) ? out.url : undefined);
        const exp = Math.floor(deps.now() / 1000) + UPLOAD_TOKEN_TTL_S;
        const token = await signProxyToken(secret, { o: "u", s: site.binding.site_id, p, e: exp, t, ct, n: body.size, x: upsert, ...userBinding(principal) });
        return ok(200, { url: proxyPath(route.area!, body.name, token), method: "PUT", headers: { "content-type": ct }, expires_in: UPLOAD_TOKEN_TTL_S });
      }
      case "file_delete":
        await storage(`object/${BUCKET}/${objectPath(site, route.area!, route.name!)}`, "DELETE", undefined);
        return ok(200, { name: route.name, deleted: true });
      case "transition": {
        if (url.search) throw new HttpError(400, "unknown_query_param");
        const body = await readJsonBody(request);
        if (!isPlainObject(body) || Object.keys(body).some((k) => k !== "to" && k !== "expect" && k !== "set") ||
            typeof body.to !== "string" ||
            body.to.length === 0 || body.to.length > MAX_TRANSITION_TO || /[\u0000-\u001f]/.test(body.to) ||
            !validTransitionFields(body.expect) || !validTransitionFields(body.set)) {
          throw new HttpError(400, "invalid_transition");
        }
        const args: Record<string, unknown> = { p_collection: route.collection, p_id: route.id, p_to: body.to };
        if (body.expect !== undefined) args.p_expect = body.expect;
        if (body.set !== undefined) args.p_set = body.set;
        return ok(200, await rpc("transition_record", args));
      }
      case "action": {
        if (url.search) throw new HttpError(400, "unknown_query_param");
        const key = request.headers.get("idempotency-key");
        if (key === null) throw new HttpError(400, "idempotency_key_required");
        if (!IDEM_KEY.test(key)) throw new HttpError(400, "invalid_idempotency_key");
        const body = await readJsonBody(request);
        if (!isPlainObject(body)) throw new HttpError(400, "invalid_action_body");
        const keys = Object.keys(body).sort().join();
        let args: Record<string, unknown>;
        if ((keys === "target_id" || keys === "data,target_id") && typeof body.target_id === "string" && UUID.test(body.target_id.toLowerCase())) {
          if (body.data !== undefined && !isPlainObject(body.data)) throw new HttpError(400, "invalid_action_body");
          args = { p_action: route.fn, p_target_id: body.target_id.toLowerCase(), p_record_id: null, p_data: body.data ?? {}, p_idempotency_key: key };
        } else if (keys === "record_id" && typeof body.record_id === "string" && UUID.test(body.record_id.toLowerCase())) {
          args = { p_action: route.fn, p_target_id: null, p_record_id: body.record_id.toLowerCase(), p_data: {}, p_idempotency_key: key };
        } else {
          throw new HttpError(400, "invalid_action_body");
        }
        return ok(200, await rpc("run_action", args));
      }
      case "aggregate": {
        if (url.search) throw new HttpError(400, "unknown_query_param");
        const body = await readJsonBody(request);
        if (!isPlainObject(body) || !(Object.keys(body).length === 0 || Object.keys(body).join() === "filter")) {
          throw new HttpError(400, "invalid_aggregate_body");
        }
        const filter = body.filter === undefined ? {} : checkFilter(body.filter);
        return ok(200, await rpc("aggregate", { p_name: route.fn, p_filter: filter }));
      }
      default:
        throw new HttpError(404, "no_such_route");
    }
  } catch (e) {
    const err = e instanceof HttpError ? e : new HttpError(500, "internal_error");
    return respond(err.status, { error: { code: err.code, message: MESSAGES[err.code] ?? "Request failed.", request_id: requestId } }, hostname, request, { ...extra, ...err.extra }, requestId);
  }
}

export async function handleWithMetrics(request: Request, env: Env, partial: Partial<Deps> = {}): Promise<Response> {
  const now = partial.now ?? Date.now;
  const baseFetch: typeof fetch = partial.fetch ?? ((...a) => fetch(...a));
  const t0 = now();
  const seen: { shard: string | null; site: string } = { shard: null, site: "" };
  let upstreamMs = 0;
  let upstreamCalls = 0;
  const timed = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!seen.shard || !url.startsWith(`https://${seen.shard}.supabase.co/`)) return baseFetch(input, init);
    const started = now();
    try {
      return await baseFetch(input, init);
    } finally {
      upstreamMs += Math.max(0, now() - started);
      upstreamCalls++;
    }
  }) as typeof fetch;
  const res = await handle(request, env, { ...partial, fetch: timed, onSite: (ref, id) => { seen.shard = ref; seen.site = id; } });
  if (seen.shard && env.SHARD_METRICS) {
    try {
      env.SHARD_METRICS.writeDataPoint({
        indexes: [seen.shard],
        blobs: [seen.shard, `${Math.floor(res.status / 100)}xx`, seen.site],
        doubles: [Math.max(0, now() - t0), upstreamMs, upstreamCalls],
      });
    } catch {
    }
  }
  return res;
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleWithMetrics(request, env);
  },
};
