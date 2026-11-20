
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { JWTPayload } from "jose";
import type { Request, Response } from "express";

let verifyResult: { payload?: JWTPayload; throw?: boolean } = {};
let bearerToken: string | null = "fake.jwt.token";

vi.mock("../../services/auth/jwt", () => ({
  verifyJwt: vi.fn(async () => {
    if (verifyResult.throw) throw new Error("bad signature");
    return verifyResult.payload as JWTPayload;
  }),
  readBearerToken: vi.fn(() => bearerToken),
  customerJwksUrl: vi.fn(() => {
    if (!process.env.SUPABASE_URL) throw new Error("SUPABASE_URL missing");
    return "https://example.test/auth/v1/.well-known/jwks.json";
  }),
  customerExpectedIssuer: vi.fn(() => "https://example.test/auth/v1"),
}));

let gateResult: { data: { user_id: string } | null; error: { message: string } | null } = {
  data: null,
  error: null,
};
const insertSpy = vi.fn(async () => ({ error: null }));

vi.mock("@/services/supabase", () => ({
  serviceClient: vi.fn(() => ({
    from: vi.fn((table: string) => {
      if (table === "staff_users") {
        return {
          select: () => ({
            eq: () => ({ is: () => ({ maybeSingle: async () => gateResult }) }),
          }),
        };
      }
      return { insert: insertSpy };
    }),
  })),
}));

import {
  requireStaff,
  assertStaff,
  _clearStaffEnvForTests,
} from "../../services/auth/staff-middleware";

type Captured = { res: Response; status: () => number | null; body: () => unknown };

function mkRes(): Captured {
  let _status: number | null = null;
  let _body: unknown = null;
  const res = {
    status(c: number) { _status = c; return res; },
    json(b: unknown) { _body = b; return res; },
  } as unknown as Response;
  return { res, status: () => _status, body: () => _body };
}

function mkReq(): Request {
  return {
    headers: { authorization: "Bearer fake.jwt.token", "user-agent": "vitest" },
    ip: "127.0.0.1",
    method: "GET",
    path: "/funnel",
    originalUrl: "/api/admin/funnel",
  } as unknown as Request;
}

function errCode(body: unknown): string | undefined {
  return (body as { error?: { code?: string } })?.error?.code;
}

const STAFF_EMAIL = "ravi@upcar.ai";
const STAFF_SUB = "u-42";

function stageActiveStaff(sub = STAFF_SUB): void {
  gateResult = { data: { user_id: sub }, error: null };
}

describe("requireStaff — behavioral gate (DB-backed staff_users)", () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = "https://example.test";
    _clearStaffEnvForTests();
    verifyResult = {};
    bearerToken = "fake.jwt.token";
    gateResult = { data: null, error: null };
    insertSpy.mockClear();
  });

  afterEach(() => {
    _clearStaffEnvForTests();
  });

  it("no Bearer token -> 401 unauthenticated", async () => {
    bearerToken = null;
    const { res, status, body } = mkRes();
    const session = await requireStaff(mkReq(), res);
    expect(session).toBeNull();
    expect(status()).toBe(401);
    expect(errCode(body())).toBe("unauthenticated");
  });

  it("SUPABASE_URL missing -> 500 staff_misconfigured (never 200/401)", async () => {
    delete process.env.SUPABASE_URL;
    _clearStaffEnvForTests();
    const { res, status, body } = mkRes();
    const session = await requireStaff(mkReq(), res);
    expect(session).toBeNull();
    expect(status()).toBe(500);
    expect(errCode(body())).toBe("staff_misconfigured");
  });

  it("bad signature (verifyJwt throws) -> 401 invalid_jwt", async () => {
    verifyResult = { throw: true };
    const { res, status, body } = mkRes();
    const session = await requireStaff(mkReq(), res);
    expect(session).toBeNull();
    expect(status()).toBe(401);
    expect(errCode(body())).toBe("invalid_jwt");
  });

  it("no sub claim -> 401 invalid_jwt", async () => {
    verifyResult = { payload: { email: STAFF_EMAIL } as JWTPayload };
    const { res, status, body } = mkRes();
    const session = await requireStaff(mkReq(), res);
    expect(session).toBeNull();
    expect(status()).toBe(401);
    expect(errCode(body())).toBe("invalid_jwt");
  });

  it("no email claim -> 401 invalid_jwt (email required for the audit identity)", async () => {
    verifyResult = { payload: { sub: STAFF_SUB } as JWTPayload };
    const { res, status, body } = mkRes();
    const session = await requireStaff(mkReq(), res);
    expect(session).toBeNull();
    expect(status()).toBe(401);
    expect(errCode(body())).toBe("invalid_jwt");
  });

  it("staff_users read ERRORS -> 503 staff_check_unavailable (FAIL CLOSED, never open)", async () => {
    verifyResult = { payload: { sub: STAFF_SUB, email: STAFF_EMAIL } as JWTPayload };
    gateResult = { data: null, error: { message: "connection reset" } };
    const { res, status, body } = mkRes();
    const session = await requireStaff(mkReq(), res);
    expect(session).toBeNull();
    expect(status()).toBe(503);
    expect(errCode(body())).toBe("staff_check_unavailable");
  });

  it("authentic JWT but NO active staff_users row -> 401 not_staff", async () => {
    verifyResult = { payload: { sub: "nobody-1", email: "nobody@upcar.ai" } as JWTPayload };
    gateResult = { data: null, error: null };
    const { res, status, body } = mkRes();
    const session = await requireStaff(mkReq(), res);
    expect(session).toBeNull();
    expect(status()).toBe(401);
    expect(errCode(body())).toBe("not_staff");
  });

  it("app_metadata.role is NOT consulted — role=staff JWT with no DB row is still 401", async () => {
    verifyResult = {
      payload: { sub: "forged-1", email: "forged@evil.test", app_metadata: { role: "staff" } } as unknown as JWTPayload,
    };
    gateResult = { data: null, error: null };
    const { res, status, body } = mkRes();
    const session = await requireStaff(mkReq(), res);
    expect(session).toBeNull();
    expect(status()).toBe(401);
    expect(errCode(body())).toBe("not_staff");
  });

  it("happy path: active staff_users row -> session, req.staff attached, no reject", async () => {
    verifyResult = { payload: { sub: STAFF_SUB, email: STAFF_EMAIL } as JWTPayload };
    stageActiveStaff(STAFF_SUB);
    const { res, status, body } = mkRes();
    const req = mkReq();
    const session = await requireStaff(req, res);
    expect(session).toEqual({ user_id: STAFF_SUB, email: STAFF_EMAIL });
    expect(req.staff).toEqual({ user_id: STAFF_SUB, email: STAFF_EMAIL });
    expect(status()).toBeNull();
    expect(body()).toBeNull();
  });

  it("email is normalized (trimmed + lowercased) on the session", async () => {
    verifyResult = { payload: { sub: "u-7", email: "  RAVI@UPCAR.AI " } as JWTPayload };
    stageActiveStaff("u-7");
    const { res, status } = mkRes();
    const req = mkReq();
    const session = await requireStaff(req, res);
    expect(session).toEqual({ user_id: "u-7", email: "ravi@upcar.ai" });
    expect(status()).toBeNull();
  });

  it("writes an audit row on every hit (a failure AND a success)", async () => {
    bearerToken = null;
    await requireStaff(mkReq(), mkRes().res);
    expect(insertSpy).toHaveBeenCalledTimes(1);
    bearerToken = "fake.jwt.token";
    verifyResult = { payload: { sub: STAFF_SUB, email: STAFF_EMAIL } as JWTPayload };
    stageActiveStaff(STAFF_SUB);
    await requireStaff(mkReq(), mkRes().res);
    expect(insertSpy).toHaveBeenCalledTimes(2);
  });
});

describe("assertStaff — belt-and-suspenders", () => {
  it("throws when req.staff is missing (handler not under guard)", () => {
    const req = {} as unknown as Request;
    expect(() => assertStaff(req)).toThrow(/req\.staff missing/);
  });

  it("returns the session when req.staff is present", () => {
    const req = { staff: { user_id: "u-1", email: "ravi@upcar.ai" } } as unknown as Request;
    expect(assertStaff(req)).toEqual({ user_id: "u-1", email: "ravi@upcar.ai" });
  });
});
