import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import {
  generateKeyPair,
  exportJWK,
  SignJWT,
  createLocalJWKSet,
  jwtVerify,
  type JWK,
} from "jose";

type JoseKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

const ISSUER = "https://proj.supabase.co/auth/v1";
const AUDIENCE = "authenticated";
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;

let priv: JoseKey;
let pubJwk: JWK;
let otherPriv: JoseKey;

let localKeySet: ReturnType<typeof createLocalJWKSet>;

vi.mock("jose", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jose")>();
  return {
    ...actual,
    createRemoteJWKSet: () => localKeySet,
  };
});

let staffGateResult: { data: { user_id: string } | null; error: { message: string } | null } = {
  data: null,
  error: null,
};
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) =>
      table === "staff_users"
        ? { select: () => ({ eq: () => ({ is: () => ({ maybeSingle: async () => staffGateResult }) }) }) }
        : { insert: async () => ({ error: null }) },
  }),
}));

import { verifyJwt, verifyBearer, _clearTokenCacheForTests } from "@/services/auth/jwt";
import { requireStaff, _clearStaffEnvForTests } from "@/services/auth/staff-middleware";

async function mint(
  signer: JoseKey,
  claims: Record<string, unknown>,
  opts: { issuer?: string; audience?: string; expSecondsFromNow?: number; sub?: string } = {},
): Promise<string> {
  const j = new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
    .setIssuer(opts.issuer ?? ISSUER)
    .setAudience(opts.audience ?? AUDIENCE)
    .setSubject(opts.sub ?? "user-123")
    .setIssuedAt();
  const exp = opts.expSecondsFromNow ?? 3600;
  j.setExpirationTime(Math.floor(Date.now() / 1000) + exp);
  return j.sign(signer);
}

beforeAll(async () => {
  const a = await generateKeyPair("RS256");
  priv = a.privateKey;
  pubJwk = await exportJWK(a.publicKey);
  pubJwk.kid = "test-key-1";
  pubJwk.alg = "RS256";
  pubJwk.use = "sig";

  const b = await generateKeyPair("RS256");
  otherPriv = b.privateKey;

  localKeySet = createLocalJWKSet({ keys: [pubJwk] });
});

beforeEach(() => {
  _clearTokenCacheForTests();
});

describe("verifyJwt — accepts a correctly-minted token", () => {
  it("returns the payload for a valid issuer/audience/sig/exp token", async () => {
    const tok = await mint(priv, { email: "ravi@upcar.ai", email_verified: true });
    const payload = await verifyJwt({
      token: tok,
      jwksUrl: JWKS_URL,
      expectedIssuer: ISSUER,
      expectedAudience: AUDIENCE,
    });
    expect(payload.sub).toBe("user-123");
    expect(payload.email).toBe("ravi@upcar.ai");
  });
});

describe("verifyJwt — rejects on every claim/sig failure", () => {
  it("rejects a WRONG-ISSUER token", async () => {
    const tok = await mint(priv, {}, { issuer: "https://evil.supabase.co/auth/v1" });
    await expect(
      verifyJwt({ token: tok, jwksUrl: JWKS_URL, expectedIssuer: ISSUER, expectedAudience: AUDIENCE }),
    ).rejects.toThrow();
  });

  it("rejects a WRONG-AUDIENCE token", async () => {
    const tok = await mint(priv, {}, { audience: "service_role" });
    await expect(
      verifyJwt({ token: tok, jwksUrl: JWKS_URL, expectedIssuer: ISSUER, expectedAudience: AUDIENCE }),
    ).rejects.toThrow();
  });

  it("rejects an EXPIRED token", async () => {
    const tok = await mint(priv, {}, { expSecondsFromNow: -60 });
    await expect(
      verifyJwt({ token: tok, jwksUrl: JWKS_URL, expectedIssuer: ISSUER, expectedAudience: AUDIENCE }),
    ).rejects.toThrow();
  });

  it("rejects a token signed by a DIFFERENT JWKS (cross-project key)", async () => {
    const tok = await mint(otherPriv, { email: "x@y.z", email_verified: true });
    await expect(
      verifyJwt({ token: tok, jwksUrl: JWKS_URL, expectedIssuer: ISSUER, expectedAudience: AUDIENCE }),
    ).rejects.toThrow();
  });

  it("rejects a tampered token (signature mismatch)", async () => {
    const tok = await mint(priv, { email_verified: true });
    const parts = tok.split(".");
    const tampered = `${parts[0]}.${parts[1].slice(0, -1)}${parts[1].slice(-1) === "A" ? "B" : "A"}.${parts[2]}`;
    await expect(
      verifyJwt({ token: tampered, jwksUrl: JWKS_URL, expectedIssuer: ISSUER, expectedAudience: AUDIENCE }),
    ).rejects.toThrow();
  });
});

describe("verifyBearer — extracts user_id only from a valid customer JWT", () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = "https://proj.supabase.co";
    _clearTokenCacheForTests();
  });

  function reqWith(token: string | null) {
    return {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    } as unknown as import("express").Request;
  }

  it("returns {user_id} for a valid token", async () => {
    const tok = await mint(priv, { email: "u@v.w" });
    const res = await verifyBearer(reqWith(tok));
    expect(res?.user_id).toBe("user-123");
  });

  it("returns null for a missing Bearer header", async () => {
    expect(await verifyBearer(reqWith(null))).toBeNull();
  });

  it("returns null for a cross-JWKS token (verify fails)", async () => {
    const tok = await mint(otherPriv, { email: "u@v.w" });
    expect(await verifyBearer(reqWith(tok))).toBeNull();
  });
});

describe("requireStaff — the DB-backed staff_users gate (real minted JWTs)", () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = "https://proj.supabase.co";
    _clearStaffEnvForTests();
    _clearTokenCacheForTests();
    staffGateResult = { data: null, error: null };
  });

  function mockRes() {
    const r: { statusCode?: number; body?: unknown; status: (n: number) => typeof r; json: (b: unknown) => typeof r } = {
      status(n: number) { r.statusCode = n; return r; },
      json(b: unknown) { r.body = b; return r; },
    };
    return r;
  }

  function reqWith(token: string) {
    return {
      headers: { authorization: `Bearer ${token}` },
      originalUrl: "/api/admin/tenants",
      method: "GET",
      path: "/tenants",
      ip: "127.0.0.1",
    } as unknown as import("express").Request;
  }

  it("rejects (401 not_staff) a valid token whose sub has NO active staff_users row", async () => {
    const tok = await mint(priv, { email: "ravi@upcar.ai" }, { sub: "nobody-1" });
    staffGateResult = { data: null, error: null };
    const res = mockRes();
    const session = await requireStaff(reqWith(tok), res as unknown as import("express").Response);
    expect(session).toBeNull();
    expect(res.statusCode).toBe(401);
    expect((res.body as { error: { code: string } }).error.code).toBe("not_staff");
  });

  it("app_metadata.role is NOT trusted — role=staff with no DB row is still 401 not_staff", async () => {
    const tok = await mint(priv, { email: "forged@evil.test", app_metadata: { role: "staff" } }, { sub: "forged-1" });
    staffGateResult = { data: null, error: null };
    const res = mockRes();
    const session = await requireStaff(reqWith(tok), res as unknown as import("express").Response);
    expect(session).toBeNull();
    expect(res.statusCode).toBe(401);
    expect((res.body as { error: { code: string } }).error.code).toBe("not_staff");
  });

  it("rejects a WRONG-ISSUER token even when the sub HAS an active staff_users row", async () => {
    const tok = await mint(priv, { email: "ravi@upcar.ai" }, { sub: "user-123", issuer: "https://evil.supabase.co/auth/v1" });
    staffGateResult = { data: { user_id: "user-123" }, error: null };
    const res = mockRes();
    const session = await requireStaff(reqWith(tok), res as unknown as import("express").Response);
    expect(session).toBeNull();
    expect(res.statusCode).toBe(401);
    expect((res.body as { error: { code: string } }).error.code).toBe("invalid_jwt");
  });

  it("staff_users read ERROR → 503 staff_check_unavailable (FAIL CLOSED)", async () => {
    const tok = await mint(priv, { email: "ravi@upcar.ai" }, { sub: "user-123" });
    staffGateResult = { data: null, error: { message: "connection reset" } };
    const res = mockRes();
    const session = await requireStaff(reqWith(tok), res as unknown as import("express").Response);
    expect(session).toBeNull();
    expect(res.statusCode).toBe(503);
    expect((res.body as { error: { code: string } }).error.code).toBe("staff_check_unavailable");
  });

  it("ACCEPTS a correctly-issued token whose sub HAS an active staff_users row", async () => {
    const tok = await mint(priv, { email: "ravi@upcar.ai" }, { sub: "user-123" });
    staffGateResult = { data: { user_id: "user-123" }, error: null };
    const res = mockRes();
    const session = await requireStaff(reqWith(tok), res as unknown as import("express").Response);
    expect(session).not.toBeNull();
    expect(session?.email).toBe("ravi@upcar.ai");
  });
});
