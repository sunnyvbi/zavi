
import type { Request } from "express";
import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTPayload } from "jose";

const CACHE_TTL_MS = 30 * 1000;

type CacheEntry = { payload: JWTPayload; expires_at: number };
const verifyCache = new Map<string, CacheEntry>();

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function jwksFor(jwksUrl: string): ReturnType<typeof createRemoteJWKSet> {
  let j = jwksCache.get(jwksUrl);
  if (!j) {
    j = createRemoteJWKSet(new URL(jwksUrl));
    jwksCache.set(jwksUrl, j);
  }
  return j;
}

function readBearer(req: Request): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  return m[1].trim() || null;
}

function gc(now: number): void {
  for (const [k, v] of verifyCache) {
    if (v.expires_at < now) verifyCache.delete(k);
  }
}

export type VerifyArgs = {
  token: string;
  jwksUrl: string;
  expectedIssuer?: string;
  expectedAudience?: string | string[];
};

export async function verifyJwt(args: VerifyArgs): Promise<JWTPayload> {
  const cacheKey = `${args.jwksUrl}::${args.token}`;
  const now = Date.now();
  gc(now);
  const cached = verifyCache.get(cacheKey);
  if (cached && cached.expires_at > now) return cached.payload;

  const { payload } = await jwtVerify(args.token, jwksFor(args.jwksUrl), {
    issuer: args.expectedIssuer,
    audience: args.expectedAudience,
  });
  verifyCache.set(cacheKey, { payload, expires_at: now + CACHE_TTL_MS });
  return payload;
}

export function customerJwksUrl(): string {
  const u = process.env.SUPABASE_URL;
  if (!u) throw new Error("SUPABASE_URL is required for auth");
  return `${u.replace(/\/$/, "")}/auth/v1/.well-known/jwks.json`;
}

export function customerExpectedIssuer(): string {
  const u = process.env.SUPABASE_URL;
  if (!u) throw new Error("SUPABASE_URL is required for auth");
  return `${u.replace(/\/$/, "")}/auth/v1`;
}

export type VerifiedBearer = {
  user_id: string;
  access_token: string;
  email: string | null;
  session_id: string | null;
  claim_tenant_id: string | null;
};

export class SignInCheckUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`sign-in check unavailable: ${String((cause as Error)?.message ?? cause)}`);
    this.name = "SignInCheckUnavailableError";
  }
}

export function signInCheckUnavailable(e: unknown): boolean {
  if (e instanceof joseErrors.JWKSTimeout || e instanceof joseErrors.JWKSInvalid) return true;
  if (!(e instanceof joseErrors.JOSEError)) return true;
  return (e as { code?: string }).code === "ERR_JOSE_GENERIC";
}

export async function verifyBearer(
  req: Request,
  opts: { throwWhenUnavailable?: boolean } = {},
): Promise<VerifiedBearer | null> {
  const token = readBearer(req);
  if (!token) return null;

  let payload: JWTPayload;
  try {
    payload = await verifyJwt({
      token,
      jwksUrl: customerJwksUrl(),
      expectedIssuer: customerExpectedIssuer(),
      expectedAudience: "authenticated",
    });
  } catch (e) {
    if (opts.throwWhenUnavailable && signInCheckUnavailable(e)) throw new SignInCheckUnavailableError(e);
    return null;
  }
  const user_id = typeof payload.sub === "string" ? payload.sub : null;
  const email = typeof payload.email === "string" ? payload.email : null;
  if (!user_id) return null;
  const rawSession = (payload as { session_id?: unknown }).session_id;
  const session_id =
    typeof rawSession === "string" && rawSession.length > 0 ? rawSession : null;
  const rawClaim = (payload as { app_metadata?: { active_tenant_id?: unknown } })
    .app_metadata?.active_tenant_id;
  const claim_tenant_id =
    typeof rawClaim === "string" && rawClaim.length > 0 ? rawClaim : null;
  return { user_id, access_token: token, email, session_id, claim_tenant_id };
}

export function readBearerToken(req: Request): string | null {
  return readBearer(req);
}

export function _clearTokenCacheForTests(): void {
  verifyCache.clear();
  jwksCache.clear();
}
