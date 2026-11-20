
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { JWTPayload } from "jose";

const MEMBER_1 = "11111111-1111-4111-8111-111111111111";

let jwtPayload: JWTPayload | null = { sub: "user-not-staff", email: "stranger@example.com" };
let gateResult: { data: { user_id: string } | null; error: { message: string } | null } = { data: null, error: null };

vi.mock("@/services/auth/jwt", () => ({
  verifyJwt: vi.fn(async () => {
    if (!jwtPayload) throw new Error("bad signature");
    return jwtPayload;
  }),
  readBearerToken: vi.fn(() => "fake.jwt.token"),
  customerJwksUrl: vi.fn(() => "https://example.test/auth/v1/.well-known/jwks.json"),
  customerExpectedIssuer: vi.fn(() => "https://example.test/auth/v1"),
  verifyBearer: vi.fn(async () => null),
}));

const auditInsert = vi.fn(async () => ({ error: null }));
vi.mock("@/services/supabase", () => ({
  serviceClient: vi.fn(() => ({
    from: vi.fn((table: string) => {
      if (table === "staff_users") {
        return { select: () => ({ eq: () => ({ is: () => ({ maybeSingle: async () => gateResult }) }) }) };
      }
      return { insert: auditInsert };
    }),
  })),
}));

vi.mock("@/services/tenant-client", () => ({
  globalClient: vi.fn(() => {
    throw new Error("data layer reached by a NON-STAFF caller — the gate failed open");
  }),
}));

import { staffMiddleware } from "@/services/auth/staff-middleware";
import { staffHumanQueue, staffHumanDetail, staffHumanSetVetting } from "../humans";

function mockRes() {
  const res = {
    statusCode: 200,
    payload: undefined as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.payload = body;
      return this;
    },
  };
  return res as any;
}

const ROUTES: Array<[string, (req: any, res: any) => Promise<void>, any]> = [
  ["GET /api/admin/human", staffHumanQueue, { query: {}, params: {} }],
  ["GET /api/admin/human/:id", staffHumanDetail, { query: {}, params: { id: MEMBER_1 } }],
  ["PATCH /api/admin/human/:id/vetting", staffHumanSetVetting, { query: {}, params: { id: MEMBER_1 }, body: { state: "approved" } }],
];

beforeEach(() => {
  process.env.SUPABASE_URL = "https://example.test";
  jwtPayload = { sub: "user-not-staff", email: "stranger@example.com" };
  gateResult = { data: null, error: null };
  auditInsert.mockClear();
});

describe("non-staff callers on the human console", () => {
  it.each(ROUTES)("%s answers the existing not_staff shape and never runs the handler", async (_name, handler, reqShape) => {
    const req = { ...reqShape, headers: { authorization: "Bearer fake.jwt.token" }, body: reqShape.body ?? {}, path: "/humans" } as any;
    const res = mockRes();
    const next = vi.fn();

    await staffMiddleware()(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.payload.error.code).toBe("not_staff");
    expect(req.staff).toBeUndefined();

    await expect(handler(req, res)).rejects.toThrow(/assertStaff/);
  });

  it("does NOT invent a new denial code anywhere in the human console source", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "..", "humans.ts"), "utf8");
    expect(src).not.toMatch(/code:\s*"not_staff"/);
    expect(src).not.toMatch(/code:\s*"forbidden"/);
    expect(src).toMatch(/assertStaff/);
  });
});
