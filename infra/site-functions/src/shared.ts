
export const SKEW_S = 60;
export const FN_NAME_RE = /^[a-z][a-z0-9-]{0,47}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
export const DATA_ORIGIN = "https://data.zavi.internal";
export const FD = { ts: "x-zavi-fd-ts", meta: "x-zavi-fd-meta", sig: "x-zavi-fd-sig" } as const;
export const FA = { ts: "x-zavi-fa-ts", meta: "x-zavi-fa-meta", sig: "x-zavi-fa-sig" } as const;
export const FL = { ts: "x-zavi-fl-ts", sig: "x-zavi-fl-sig" } as const;
export const INVOCATION_HEADER = "x-zavi-invocation";

export const MAX_FN_BODY_BYTES = 1024 * 1024;

export type InvocationKind = "http" | "webhook" | "schedule";
export type DataAccess = "function" | "admin";

export interface InvocationMeta {
  v: 1;
  site_id: string;
  host: string;
  kind: InvocationKind;
  name: string;
  request_id: string;
  user: { id: string; role: string | null } | null;
  public_path?: string;
  scheduled_time?: string;
  idempotency_key?: string;
  attempt?: number;
}

export interface AssertionMeta {
  v: 1;
  site_id: string;
  host: string;
  fn: string;
  data: DataAccess;
  invocation_id: string;
}

export interface FnSiteRecord {
  v: 1;
  site_id: string;
  status: "active" | "disabled";
  generation: number;
  script: string;
  test?: boolean;
  endpoints: Record<string, { type: "http" | "webhook"; principals: string[]; data: DataAccess }>;
  schedules: Record<string, { data: DataAccess }>;
  allowed_hosts: string[];
  limits?: { cpu_ms?: number; subrequests?: number; wall_ms?: number };
}

export interface FnPrincipalRecord {
  v: 1;
  shard_id: string;
  function_uid?: string;
  admin_uid?: string;
  admin_fns?: string[];
}

export const fnSiteKey = (siteId: string) => `fnsite:${siteId}`;
export const fnPrincipalKey = (siteId: string) => `fnprincipal:${siteId}`;
export const FN_KILL_ALL_KEY = "fn:kill_all";

const enc = new TextEncoder();

export function hex(bytes: ArrayBuffer | Uint8Array): string {
  return Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(bytes: Uint8Array | string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", typeof bytes === "string" ? enc.encode(bytes) : bytes));
}

const keyCache = new Map<string, Promise<CryptoKey>>();
function hmacKey(secret: string): Promise<CryptoKey> {
  let k = keyCache.get(secret);
  if (!k) {
    if (keyCache.size > 16) keyCache.clear();
    k = crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    keyCache.set(secret, k);
  }
  return k;
}

export async function hmacHex(secret: string, message: string): Promise<string> {
  return hex(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(message)));
}

export function timingSafeEqualHex(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export function b64urlEncodeJson(v: unknown): string {
  const bytes = enc.encode(JSON.stringify(v));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecodeJson(s: string): unknown {
  if (!/^[A-Za-z0-9_-]{1,8192}$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

export const invokeSigningString = (ts: number, meta: string, method: string, bodySha: string) =>
  ["zavi-fd-v1", ts, meta, method.toUpperCase(), bodySha].join("\n");
export const assertionSigningString = (ts: number, meta: string, method: string, pathAndQuery: string, bodySha: string) =>
  ["zavi-fa-v1", ts, meta, method.toUpperCase(), pathAndQuery, bodySha].join("\n");
export const logSigningString = (ts: number, bodySha: string) => ["zavi-fl-v1", ts, bodySha].join("\n");

export async function signInvocation(secret: string, meta: InvocationMeta, method: string, body: Uint8Array, nowMs: number): Promise<Record<string, string>> {
  const ts = Math.floor(nowMs / 1000);
  const m = b64urlEncodeJson(meta);
  return { [FD.ts]: String(ts), [FD.meta]: m, [FD.sig]: await hmacHex(secret, invokeSigningString(ts, m, method, await sha256Hex(body))) };
}

export async function signAssertion(secret: string, meta: AssertionMeta, method: string, pathAndQuery: string, body: Uint8Array, nowMs: number): Promise<Record<string, string>> {
  const ts = Math.floor(nowMs / 1000);
  const m = b64urlEncodeJson(meta);
  return { [FA.ts]: String(ts), [FA.meta]: m, [FA.sig]: await hmacHex(secret, assertionSigningString(ts, m, method, pathAndQuery, await sha256Hex(body))) };
}

export async function signLogBatch(secret: string, body: Uint8Array, nowMs: number): Promise<Record<string, string>> {
  const ts = Math.floor(nowMs / 1000);
  return { [FL.ts]: String(ts), [FL.sig]: await hmacHex(secret, logSigningString(ts, await sha256Hex(body))) };
}

function tsFresh(raw: string | null, nowMs: number): number | null {
  if (!raw || !/^\d{1,12}$/.test(raw)) return null;
  const ts = Number(raw);
  return Math.abs(Math.floor(nowMs / 1000) - ts) <= SKEW_S ? ts : null;
}

export function isInvocationMeta(v: unknown): v is InvocationMeta {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const m = v as Record<string, unknown>;
  if (m.v !== 1 || typeof m.site_id !== "string" || !UUID_RE.test(m.site_id)) return false;
  if (typeof m.host !== "string" || !/^[a-z0-9.-]{1,253}$/.test(m.host)) return false;
  if (m.kind !== "http" && m.kind !== "webhook" && m.kind !== "schedule") return false;
  if (typeof m.name !== "string" || !FN_NAME_RE.test(m.name)) return false;
  if (typeof m.request_id !== "string" || !/^[A-Za-z0-9:_.-]{1,128}$/.test(m.request_id)) return false;
  if (m.user !== null) {
    if (m.kind !== "http" || !m.user || typeof m.user !== "object") return false;
    const u = m.user as Record<string, unknown>;
    if (typeof u.id !== "string" || !UUID_RE.test(u.id)) return false;
    if (u.role !== null && (typeof u.role !== "string" || !/^[a-z][a-z0-9_]{0,31}$/.test(u.role))) return false;
  }
  if (m.kind === "schedule") {
    if (typeof m.scheduled_time !== "string" || Number.isNaN(Date.parse(m.scheduled_time))) return false;
    if (typeof m.idempotency_key !== "string" || !/^[A-Za-z0-9:_.-]{8,200}$/.test(m.idempotency_key)) return false;
    if (typeof m.attempt !== "number" || !Number.isInteger(m.attempt) || m.attempt < 1 || m.attempt > 100) return false;
  } else if (typeof m.public_path !== "string" || !m.public_path.startsWith("/api/") || m.public_path.length > 4096) {
    return false;
  }
  return true;
}

export function isAssertionMeta(v: unknown): v is AssertionMeta {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const m = v as Record<string, unknown>;
  return m.v === 1 && typeof m.site_id === "string" && UUID_RE.test(m.site_id) &&
    typeof m.host === "string" && /^[a-z0-9.-]{1,253}$/.test(m.host) &&
    typeof m.fn === "string" && FN_NAME_RE.test(m.fn) &&
    (m.data === "function" || m.data === "admin") &&
    typeof m.invocation_id === "string" && /^[A-Za-z0-9:_.-]{1,128}$/.test(m.invocation_id);
}

export async function verifyInvocation(secret: string | undefined, headers: Headers, method: string, body: Uint8Array, nowMs: number): Promise<InvocationMeta | null> {
  if (!secret) return null;
  const ts = tsFresh(headers.get(FD.ts), nowMs);
  const m = headers.get(FD.meta) ?? "";
  const sig = headers.get(FD.sig) ?? "";
  if (ts === null || !m || !/^[0-9a-f]{64}$/.test(sig)) return null;
  const want = await hmacHex(secret, invokeSigningString(ts, m, method, await sha256Hex(body)));
  if (!timingSafeEqualHex(want, sig)) return null;
  const meta = b64urlDecodeJson(m);
  return isInvocationMeta(meta) ? meta : null;
}

export async function verifyAssertion(secret: string | undefined, headers: Headers, method: string, pathAndQuery: string, body: Uint8Array, nowMs: number): Promise<AssertionMeta | null> {
  if (!secret) return null;
  const ts = tsFresh(headers.get(FA.ts), nowMs);
  const m = headers.get(FA.meta) ?? "";
  const sig = headers.get(FA.sig) ?? "";
  if (ts === null || !m || !/^[0-9a-f]{64}$/.test(sig)) return null;
  const want = await hmacHex(secret, assertionSigningString(ts, m, method, pathAndQuery, await sha256Hex(body)));
  if (!timingSafeEqualHex(want, sig)) return null;
  const meta = b64urlDecodeJson(m);
  return isAssertionMeta(meta) ? meta : null;
}

export async function verifyLogBatch(secret: string | undefined, headers: { get(n: string): string | null }, body: Uint8Array, nowMs: number): Promise<boolean> {
  if (!secret) return false;
  const ts = tsFresh(headers.get(FL.ts), nowMs);
  const sig = headers.get(FL.sig) ?? "";
  if (ts === null || !/^[0-9a-f]{64}$/.test(sig)) return false;
  return timingSafeEqualHex(await hmacHex(secret, logSigningString(ts, await sha256Hex(body))), sig);
}

export async function readCapped(req: Request, max: number): Promise<Uint8Array | null> {
  const declared = req.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > max)) return null;
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

export function redactSecrets(s: string): string {
  return s
    .replace(/\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{8,}\b/g, "[redacted]")
    .replace(/\bwhsec_[A-Za-z0-9+/=]{8,}\b/g, "[redacted]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, "[redacted]")
    .replace(/\b[A-Fa-f0-9]{40,}\b/g, "[redacted]")
    .replace(/\b[A-Za-z0-9+/_-]{48,}={0,2}/g, "[redacted]");
}
