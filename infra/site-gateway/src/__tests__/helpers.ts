import { b64urlDecode, signEs256, type Jwk } from "../jwt";
import type { Env, RateLimitLike } from "../worker";
import { handleSigner } from "../../signer/src/signer";

export const HOST_A = "alpha.zaviagent.com";
export const HOST_B = "bravo.zaviagent.com";
export const SITE_A = "11111111-1111-4111-8111-111111111111";
export const SITE_B = "22222222-2222-4222-8222-222222222222";
export const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const REF = "abcdefghijklmnopqrst";
export const SHARD_URL = `https://${REF}.supabase.co`;
export const GW_KID = "gw-s001-2026-10";
export const SESSION_KID = "auth-s001";
export const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);
export const BROKER = "https://api.zaviagent.com/api/public/site-auth";

export function binding(site_id: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ deploy_id: "d1", spa: true, v: 1, site_id, shard_id: REF, shard_url: SHARD_URL, status: "active", binding_version: 1, manifest_hash: "h", ...extra });
}

export async function genKeyPair(): Promise<{ priv: Jwk; pub: Jwk; key: CryptoKey }> {
  const kp = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const priv = (await crypto.subtle.exportKey("jwk", kp.privateKey)) as Jwk;
  const pub = (await crypto.subtle.exportKey("jwk", kp.publicKey)) as Jwk;
  return { priv, pub, key: kp.privateKey };
}

export interface Keys {
  gw: Awaited<ReturnType<typeof genKeyPair>>;
  session: Awaited<ReturnType<typeof genKeyPair>>;
  rogue: Awaited<ReturnType<typeof genKeyPair>>;
}

let cached: Keys | null = null;
export async function keys(): Promise<Keys> {
  if (!cached) cached = { gw: await genKeyPair(), session: await genKeyPair(), rogue: await genKeyPair() };
  return cached;
}

export function fakeLimiter(max = Infinity): RateLimitLike & { calls: string[] } {
  const counts = new Map<string, number>();
  const calls: string[] = [];
  return {
    calls,
    async limit({ key }) {
      calls.push(key);
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return { success: n <= max };
    },
  };
}

export interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface Harness {
  env: Env;
  signerCalls: unknown[];
  calls: Captured[];
  fetch: typeof fetch;
  kv: Record<string, string>;
  setResponse(fn: (c: Captured) => Response | Promise<Response>): void;
  sessionChecks: Captured[];
  sessionValid: (c: Captured) => Response | Promise<Response>;
}

export async function harness(opts: { kv?: Record<string, string>; env?: Record<string, unknown>; turnstileOk?: boolean } = {}): Promise<Harness> {
  const k = await keys();
  const kv: Record<string, string> = {
    [`host:${HOST_A}`]: binding(SITE_A),
    [`host:${HOST_B}`]: binding(SITE_B),
    "shard:abcdefghijklmnopqrst": JSON.stringify({ apikey: "sb_publishable_test" }),
    ...(opts.kv ?? {}),
  };
  const calls: Captured[] = [];
  const h = {
    sessionChecks: [] as Captured[],
    sessionValid: () => new Response("true", { status: 200, headers: { "content-type": "application/json" } }),
  } as unknown as Harness;
  let responder: (c: Captured) => Response | Promise<Response> = () =>
    new Response(JSON.stringify({ items: [], next_cursor: null }), { status: 200, headers: { "content-type": "application/json" } });
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === `${SHARD_URL}/auth/v1/.well-known/jwks.json`) {
      return new Response(JSON.stringify({ keys: [{ ...k.session.pub, kid: SESSION_KID }, { ...stripPriv(k.gw.priv), kid: GW_KID }] }), { status: 200 });
    }
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, key) => (headers[key] = v));
    let body: unknown = init?.body;
    if (typeof body === "string") body = JSON.parse(body);
    if (body instanceof FormData) body = Object.fromEntries(body.entries());
    const c = { url, method: init?.method ?? "GET", headers, body };
    if (url === `${SHARD_URL}/rest/v1/rpc/session_valid` || url === `${SHARD_URL}/rest/v1/rpc/session_valid_for` || url === `${SHARD_URL}/rest/v1/rpc/site_active`) {
      h.sessionChecks.push(c);
      return h.sessionValid(c);
    }
    calls.push(c);
    return responder(c);
  }) as typeof fetch;
  const signerEnv: Record<string, unknown> = { SHARD_KEY_ABCDEFGHIJKLMNOPQRST: JSON.stringify({ ...k.gw.priv, kid: GW_KID }) };
  const signerCalls: unknown[] = [];
  const env: Env = {
    HOSTS: { async get(key: string) { return key in kv ? kv[key] : null; } },
    SIGNER: {
      async fetch(r: Request) {
        const clone = r.clone();
        signerCalls.push(await clone.json().catch(() => null));
        return handleSigner(r, signerEnv, () => NOW);
      },
    },
    RL_READ: fakeLimiter(),
    RL_WRITE: fakeLimiter(),
    RL_SITE: fakeLimiter(),
    AUTH_BROKER_URL: BROKER,
    BROKER_HMAC_SECRET: "broker-secret",
    STORAGE_PROXY_SECRET: "storage-proxy-secret",
    ...(opts.env ?? {}),
  } as Env;
  h.env = env;
  h.calls = calls;
  h.signerCalls = signerCalls;
  h.fetch = fetchFn;
  h.kv = kv;
  h.setResponse = (fn) => (responder = fn);
  return h;
}

function stripPriv(j: Jwk): Jwk {
  const { d: _d, ...pub } = j;
  return pub;
}

export function req(host: string, path: string, init: RequestInit = {}): Request {
  return new Request(`https://${host}${path}`, init);
}

export function jsonReq(host: string, path: string, method: string, body: unknown, headers: Record<string, string> = {}): Request {
  return req(host, path, { method, body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });
}

export function decodeForwarded(c: Captured): { header: Record<string, unknown>; payload: Record<string, unknown>; raw: string } {
  const raw = c.headers.authorization.replace(/^Bearer /, "");
  const [h, p] = raw.split(".");
  const dec = new TextDecoder();
  return { header: JSON.parse(dec.decode(b64urlDecode(h))), payload: JSON.parse(dec.decode(b64urlDecode(p))), raw };
}

export async function sessionToken(claims: Record<string, unknown>, opts: { kid?: string; key?: CryptoKey } = {}): Promise<string> {
  const k = await keys();
  const nowS = Math.floor(NOW / 1000);
  return signEs256(opts.key ?? k.session.key, opts.kid ?? SESSION_KID, {
    iss: `${SHARD_URL}/auth/v1`,
    aud: "authenticated",
    role: "authenticated",
    sub: USER_A,
    site_id: SITE_A,
    site_role: "admin",
    iat: nowS - 10,
    exp: nowS + 3600,
    session_started_at: nowS - 60,
    ...claims,
  });
}
