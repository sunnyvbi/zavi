import { b64urlDecode, importSigningKey, signEs256, type Jwk } from "../../src/jwt";

export interface KvReader {
  get(key: string, type: "text"): Promise<string | null>;
}

export interface SignerEnv {
  [secret: string]: unknown;
  SITE_SIGNER_KEK?: unknown;
  HOSTS?: unknown;
}

export const ANON_TTL_S = 120;
export const MINT_PATH = "/mint-anon";
export const MINT_FN_PATH = "/mint-fn";
export const FN_TTL_S = 60;
export const fnPrincipalKey = (siteId: string) => `fnprincipal:${siteId}`;
const FN_NAME = /^[a-z][a-z0-9-]{0,47}$/;
export const UNSEALED_TTL_MS = 5 * 60_000;
export const SEALED_ALG = "ECDH-ES+HKDF-SHA256+A256GCM";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHARD_ID = /^[a-z0-9]{20}$/;
const KID = /^[A-Za-z0-9._-]{1,128}$/;
const B64U = /^[A-Za-z0-9_-]+$/;

export function shardKeySecretName(shardId: string): string {
  return `SHARD_KEY_${shardId.toUpperCase()}`;
}
export const sealedShardKeyKey = (shardId: string) => `shardkey:${shardId}`;

function fail(status: number, code: string): Response {
  return new Response(JSON.stringify({ error: code }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

class KeyError extends Error {
  constructor(public status: number, public code: string) {
    super(code);
  }
}

type SigningKey = { key: CryptoKey; kid: string };

const enc = new TextEncoder();
const unsealed = new Map<string, { k: SigningKey; until: number; kekKid: string }>();
const kekCache = new Map<string, Promise<{ key: CryptoKey; kid: string }>>();

export function clearUnsealedCache(): void {
  unsealed.clear();
  kekCache.clear();
}

function stripMeta(j: Jwk): JsonWebKey {
  const { kid: _k, alg: _a, use: _u, key_ops: _o, ext: _e, ...clean } = j as Jwk & { ext?: boolean };
  return clean;
}

function importKek(text: string): Promise<{ key: CryptoKey; kid: string }> {
  let p = kekCache.get(text);
  if (!p) {
    p = (async () => {
      const j = JSON.parse(text) as Jwk;
      if (j.kty !== "EC" || j.crv !== "P-256" || typeof j.d !== "string" || typeof j.kid !== "string" || !KID.test(j.kid)) {
        throw new Error("kek must be a private EC P-256 JWK with a kid");
      }
      const key = await crypto.subtle.importKey("jwk", stripMeta(j), { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
      return { key, kid: j.kid };
    })();
    p.catch(() => kekCache.delete(text));
    kekCache.set(text, p);
  }
  return p;
}

async function importPrivateJwk(text: string): Promise<SigningKey> {
  let jwk: Jwk;
  try {
    jwk = JSON.parse(text) as Jwk;
  } catch {
    throw new KeyError(500, "key_misconfigured");
  }
  if (typeof jwk.kid !== "string" || !KID.test(jwk.kid)) throw new KeyError(500, "key_misconfigured");
  try {
    return { key: await importSigningKey(text), kid: jwk.kid };
  } catch {
    throw new KeyError(500, "key_misconfigured");
  }
}

async function openSealed(raw: string, ref: string, kek: { key: CryptoKey; kid: string }, now: number): Promise<SigningKey> {
  let rec: Record<string, unknown>;
  try {
    rec = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new KeyError(500, "key_misconfigured");
  }
  const epk = rec.epk as Record<string, unknown> | undefined;
  if (
    rec.v !== 1 || rec.alg !== SEALED_ALG || rec.kek_kid !== kek.kid ||
    !epk || epk.kty !== "EC" || epk.crv !== "P-256" || typeof epk.x !== "string" || typeof epk.y !== "string" ||
    typeof rec.iv !== "string" || !B64U.test(rec.iv) || typeof rec.ct !== "string" || !B64U.test(rec.ct) || rec.ct.length > 4096
  ) {
    throw new KeyError(500, "key_misconfigured");
  }
  let plain: string;
  try {
    const iv = b64urlDecode(rec.iv);
    const ct = b64urlDecode(rec.ct);
    if (iv.length !== 12 || ct.length <= 16) throw new Error("shape");
    const pub = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: epk.x, y: epk.y }, { name: "ECDH", namedCurve: "P-256" }, false, []);
    const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: pub }, kek.key, 256);
    const ikm = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
    const okm = await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode(`zavi-shard-key-v1|${kek.kid}|${ref}`) },
      ikm,
      256,
    );
    const aes = await crypto.subtle.importKey("raw", okm, { name: "AES-GCM" }, false, ["decrypt"]);
    const out = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: enc.encode(sealedShardKeyKey(ref)), tagLength: 128 },
      aes,
      ct,
    );
    plain = new TextDecoder().decode(out);
  } catch {
    throw new KeyError(500, "key_misconfigured");
  }
  let jwk: Jwk;
  try {
    jwk = JSON.parse(plain) as Jwk;
  } catch {
    throw new KeyError(500, "key_misconfigured");
  }
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.d !== "string" || typeof jwk.kid !== "string" || !KID.test(jwk.kid)) {
    throw new KeyError(500, "key_misconfigured");
  }
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey("jwk", stripMeta(jwk), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  } catch {
    throw new KeyError(500, "key_misconfigured");
  }
  const k = { key, kid: jwk.kid };
  unsealed.set(ref, { k, until: now + UNSEALED_TTL_MS, kekKid: kek.kid });
  return k;
}

async function shardKey(env: SignerEnv, ref: string, now: number): Promise<SigningKey> {
  const secret = env[shardKeySecretName(ref)];
  if (typeof secret === "string" && secret) return importPrivateJwk(secret);
  const kek = env.SITE_SIGNER_KEK;
  const kv = env.HOSTS as KvReader | undefined;
  if (typeof kek !== "string" || !kek || !kv || typeof kv.get !== "function") throw new KeyError(404, "unknown_shard");
  let k: { key: CryptoKey; kid: string };
  try {
    k = await importKek(kek);
  } catch {
    throw new KeyError(500, "key_misconfigured");
  }
  const cached = unsealed.get(ref);
  if (cached && cached.until > now && cached.kekKid === k.kid) return cached.k;
  let raw: string | null;
  try {
    raw = await kv.get(sealedShardKeyKey(ref), "text");
  } catch {
    throw new KeyError(503, "key_store_unavailable");
  }
  if (!raw) throw new KeyError(404, "unknown_shard");
  return openSealed(raw, ref, k, now);
}

export async function fnSub(siteId: string, fn: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(`zavi-fn-v1|${siteId}|${fn}`))).slice(0, 16);
  h[6] = (h[6] & 0x0f) | 0x40;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = Array.from(h, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

async function mintFn(body: Record<string, unknown>, env: SignerEnv, now: () => number): Promise<Response> {
  if (Object.keys(body).sort().join(",") !== "fn,principal,shard_id,site_id") return fail(400, "invalid_request");
  const { shard_id, site_id, fn, principal } = body;
  if (typeof shard_id !== "string" || !SHARD_ID.test(shard_id)) return fail(400, "invalid_request");
  if (typeof site_id !== "string" || !UUID.test(site_id)) return fail(400, "invalid_request");
  if (typeof fn !== "string" || !FN_NAME.test(fn)) return fail(400, "invalid_request");
  if (principal !== "function" && principal !== "admin") return fail(400, "invalid_request");
  const kv = env.HOSTS as KvReader | undefined;
  if (!kv || typeof kv.get !== "function") return fail(503, "principal_store_unavailable");
  let raw: string | null;
  try {
    raw = await kv.get(fnPrincipalKey(site_id), "text");
  } catch {
    return fail(503, "principal_store_unavailable");
  }
  let rec: Record<string, unknown> | null = null;
  try {
    const v = raw ? JSON.parse(raw) : null;
    rec = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    rec = null;
  }
  if (!rec || rec.v !== 1 || rec.shard_id !== shard_id) return fail(404, "functions_not_active");
  if (principal === "admin") {
    const fns = Array.isArray(rec.admin_fns) ? rec.admin_fns : [];
    if (!fns.includes(fn)) return fail(403, "admin_not_granted");
  }
  const sub = await fnSub(site_id, fn);
  let k: SigningKey;
  try {
    k = await shardKey(env, shard_id, now());
  } catch (e) {
    if (e instanceof KeyError) return fail(e.status, e.code);
    return fail(500, "key_misconfigured");
  }
  const iat = Math.floor(now() / 1000);
  const exp = iat + FN_TTL_S;
  const token = await signEs256(k.key, k.kid, {
    role: "authenticated", sub, site_id, zfn: fn, zfn_admin: principal === "admin", iat, exp, jti: crypto.randomUUID(),
  });
  return new Response(JSON.stringify({ token, exp }), { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export async function handleSigner(request: Request, env: SignerEnv, now: () => number = Date.now): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "POST" && url.pathname === MINT_FN_PATH && url.search === "") {
    const t = await request.text();
    if (t.length > 512) return fail(400, "invalid_request");
    let b: unknown;
    try {
      b = JSON.parse(t);
    } catch {
      return fail(400, "invalid_request");
    }
    if (!b || typeof b !== "object" || Array.isArray(b)) return fail(400, "invalid_request");
    return mintFn(b as Record<string, unknown>, env, now);
  }
  if (request.method !== "POST" || url.pathname !== MINT_PATH || url.search !== "") return fail(404, "not_found");
  const text = await request.text();
  if (text.length > 256) return fail(400, "invalid_request");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return fail(400, "invalid_request");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return fail(400, "invalid_request");
  const keys = Object.keys(body).sort();
  if (keys.length !== 2 || keys[0] !== "shard_id" || keys[1] !== "site_id") return fail(400, "invalid_request");
  const { shard_id, site_id } = body as { shard_id: unknown; site_id: unknown };
  if (typeof shard_id !== "string" || !SHARD_ID.test(shard_id)) return fail(400, "invalid_request");
  if (typeof site_id !== "string" || !UUID.test(site_id)) return fail(400, "invalid_request");

  let k: SigningKey;
  try {
    k = await shardKey(env, shard_id, now());
  } catch (e) {
    if (e instanceof KeyError) return fail(e.status, e.code);
    return fail(500, "key_misconfigured");
  }
  const iat = Math.floor(now() / 1000);
  const exp = iat + ANON_TTL_S;
  const token = await signEs256(k.key, k.kid, { role: "anon", site_id, iat, exp, jti: crypto.randomUUID() });
  return new Response(JSON.stringify({ token, exp }), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export default {
  fetch(request: Request, env: SignerEnv): Promise<Response> {
    return handleSigner(request, env);
  },
};
