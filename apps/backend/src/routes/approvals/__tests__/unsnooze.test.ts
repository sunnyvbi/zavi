import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ID = "33333333-3333-4333-8333-333333333333";
const s = vi.hoisted(() => ({
  auth: { tenant_id: "t-1", user_id: "u-1", access_token: "tok" } as null | Record<string, string>,
  visible: true,
  rpc: [] as Array<{ tid: string; fn: string; args: Record<string, unknown> }>,
  result: { data: true as unknown, error: null as null | { message: string } },
}));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async (_req: Request, res: Response) => {
    if (s.auth) return s.auth;
    res.status(401).json({});
    return null;
  }),
}));
vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => {
    const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: s.visible ? { id: ID } : null, error: null }) };
    return { from: () => q };
  },
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantRpc: async (tid: string, fn: string, args: Record<string, unknown>) => {
    s.rpc.push({ tid, fn, args });
    return s.result;
  },
}));

import { approvalsUnsnooze } from "../close";

function mockRes() {
  const res: Record<string, unknown> = { statusCode: 200, body: null };
  res.status = vi.fn((c: number) => {
    res.statusCode = c;
    return res;
  });
  res.json = vi.fn((b: unknown) => {
    res.body = b;
    return res;
  });
  return res as unknown as Response & { statusCode: number; body: any };
}
const call = async (id = ID) => {
  const res = mockRes();
  await approvalsUnsnooze({ params: { decision_id: id }, body: { tenant_id: "evil" } } as unknown as Request, res);
  return res;
};

beforeEach(() => {
  s.visible = true;
  s.rpc.length = 0;
  s.result = { data: true, error: null };
});

describe("POST /api/approvals/:decision_id/unsnooze", () => {
  it("un-snoozes through the RPC with the session's tenant", async () => {
    const res = await call();
    expect(res.body).toEqual({ ok: true, changed: true });
    expect(s.rpc).toEqual([{ tid: "t-1", fn: "unsnooze_decision", args: { p_decision_id: ID } }]);
  });

  it("a decision the caller cannot see is 404 and writes nothing", async () => {
    s.visible = false;
    expect((await call()).statusCode).toBe(404);
    expect(s.rpc).toHaveLength(0);
  });

  it("nothing to un-snooze is ok, changed false; a bad id is 400", async () => {
    s.result = { data: false, error: null };
    expect((await call()).body).toEqual({ ok: true, changed: false });
    expect((await call("nope")).statusCode).toBe(400);
  });
});
