
export type Jwk = JsonWebKey & { kid?: string; alg?: string; use?: string };

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64urlEncode(bytes: Uint8Array | string): string {
  const b = typeof bytes === "string" ? enc.encode(bytes) : bytes;
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("bad base64url");
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const signKeyCache = new Map<string, Promise<CryptoKey>>();

export function importSigningKey(jwkText: string): Promise<CryptoKey> {
  let p = signKeyCache.get(jwkText);
  if (!p) {
    p = (async () => {
      const jwk = JSON.parse(jwkText) as Jwk;
      if (jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.d !== "string") {
        throw new Error("signing key must be a private EC P-256 JWK");
      }
      const { kid: _kid, alg: _alg, use: _use, key_ops: _ops, ...clean } = jwk;
      return crypto.subtle.importKey("jwk", clean, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    })();
    p.catch(() => signKeyCache.delete(jwkText));
    signKeyCache.set(jwkText, p);
  }
  return p;
}

export async function signEs256(key: CryptoKey, kid: string, payload: Record<string, unknown>): Promise<string> {
  const header = b64urlEncode(JSON.stringify({ alg: "ES256", typ: "JWT", kid }));
  const body = b64urlEncode(JSON.stringify(payload));
  const input = `${header}.${body}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(input)));
  return `${input}.${b64urlEncode(sig)}`;
}

export interface DecodedJwt {
  header: { alg?: string; kid?: string; typ?: string };
  payload: Record<string, unknown>;
  signingInput: string;
  signature: Uint8Array;
}

export function decodeJwt(token: string): DecodedJwt | null {
  if (token.length > 8192) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(dec.decode(b64urlDecode(parts[0])));
    const payload = JSON.parse(dec.decode(b64urlDecode(parts[1])));
    if (!header || typeof header !== "object" || !payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    return { header, payload, signingInput: `${parts[0]}.${parts[1]}`, signature: b64urlDecode(parts[2]) };
  } catch {
    return null;
  }
}

export async function verifyEs256(publicJwk: Jwk, d: DecodedJwt): Promise<boolean> {
  if (publicJwk.kty !== "EC" || publicJwk.crv !== "P-256") return false;
  if (d.signature.length !== 64) return false;
  try {
    const { d: _priv, kid: _kid, alg: _alg, use: _use, key_ops: _ops, ...pub } = publicJwk;
    const key = await crypto.subtle.importKey("jwk", pub, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, d.signature, enc.encode(d.signingInput));
  } catch {
    return false;
  }
}

const jwksCache = new Map<string, { keys: Jwk[]; at: number }>();
export const JWKS_TTL_MS = 10 * 60 * 1000;
export const JWKS_MISS_REFETCH_MS = 30 * 1000;

export function clearJwksCache(): void {
  jwksCache.clear();
}

export async function findJwk(
  url: string,
  kid: string,
  nowMs: number,
  fetchFn: typeof fetch,
): Promise<Jwk | null> {
  const hit = jwksCache.get(url);
  const pick = (keys: Jwk[]) => keys.find((k) => k.kid === kid) ?? null;
  if (hit && nowMs - hit.at < JWKS_TTL_MS) {
    const k = pick(hit.keys);
    if (k || nowMs - hit.at < JWKS_MISS_REFETCH_MS) return k;
  }
  const fallback = () => (hit && nowMs - hit.at < JWKS_TTL_MS ? pick(hit.keys) : null);
  try {
    const res = await fetchFn(url, { headers: { accept: "application/json" } });
    if (!res.ok) return fallback();
    const body = (await res.json()) as { keys?: Jwk[] };
    const keys = Array.isArray(body?.keys) ? body.keys.filter((k) => k && typeof k === "object") : [];
    jwksCache.set(url, { keys, at: nowMs });
    return pick(keys);
  } catch {
    return fallback();
  }
}
