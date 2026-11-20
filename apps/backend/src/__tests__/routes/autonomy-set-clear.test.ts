import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const m = vi.hoisted(() => {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  let nextError: { message: string } | null = null;
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    calls.push({ fn, args });
    return { data: null, error: nextError };
  });
  const serverClientFromBearer = vi.fn(() => ({ rpc }));
  const requireAuth = vi.fn().mockResolvedValue({
    user_id: "10000000-0000-0000-0000-000000000001",
    tenant_id: "00000000-0000-0000-0000-000000000001",
    access_token: "fake-jwt",
  });
  return {
    calls,
    rpc,
    serverClientFromBearer,
    requireAuth,
    setNextError: (e: { message: string } | null) => {
      nextError = e;
    },
  };
});

vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: m.serverClientFromBearer,
}));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: m.requireAuth }));
vi.mock("@/services/auth/tenant-role", () => ({
  requireTenantRole: vi.fn().mockResolvedValue(true),
}));

import { autonomySet } from "../../routes/approvals/autonomy";

function mkRes(): { res: Response; status: () => number; body: () => unknown } {
  let _s = 200;
  let _b: unknown = null;
  const res = {
    status(c: number) {
      _s = c;
      return res;
    },
    json(b: unknown) {
      _b = b;
      return res;
    },
  } as unknown as Response;
  return { res, status: () => _s, body: () => _b };
}
const mkReq = (body: unknown) =>
  ({ params: {}, query: {}, body } as unknown as Request);

beforeEach(() => {
  m.calls.length = 0;
  m.rpc.mockClear();
  m.setNextError(null);
});

describe("POST /api/approvals/autonomy — inherit/clear vs set", () => {
  it("explicit null → calls clear_tenant_autonomy (NOT set_), returns ok", async () => {
    const { res, status, body } = mkRes();
    await autonomySet(mkReq({ decision_class: "pm.weekly-plan", autonomy: null }), res);
    expect(status()).toBe(200);
    expect((body() as { ok: boolean }).ok).toBe(true);
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0].fn).toBe("clear_tenant_autonomy");
    expect(m.calls[0].args).toEqual({
      p_tenant_id: "00000000-0000-0000-0000-000000000001",
      p_decision_class: "pm.weekly-plan",
    });
  });

  it("omitted autonomy key → 400, never clears (no rpc)", async () => {
    const { res, status, body } = mkRes();
    await autonomySet(mkReq({ decision_class: "pm.weekly-plan" }), res);
    expect(status()).toBe(400);
    expect((body() as { error: { message: string } }).error.message).toBe(
      "autonomy must be one of: auto, approval, forbidden",
    );
    expect(m.calls).toHaveLength(0);
  });

  it("invalid string → 400 (no rpc)", async () => {
    const { res, status } = mkRes();
    await autonomySet(mkReq({ decision_class: "pm.weekly-plan", autonomy: "banana" }), res);
    expect(status()).toBe(400);
    expect(m.calls).toHaveLength(0);
  });

  it("valid enum → calls set_tenant_autonomy with the value", async () => {
    const { res, status } = mkRes();
    await autonomySet(mkReq({ decision_class: "pm.weekly-plan", autonomy: "auto" }), res);
    expect(status()).toBe(200);
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0].fn).toBe("set_tenant_autonomy");
    expect(m.calls[0].args.p_autonomy).toBe("auto");
  });

  it("missing decision_class → 400 (no rpc)", async () => {
    const { res, status } = mkRes();
    await autonomySet(mkReq({ autonomy: null }), res);
    expect(status()).toBe(400);
    expect(m.calls).toHaveLength(0);
  });

  it("clear RPC error → 500 clear_autonomy_failed", async () => {
    m.setNextError({ message: "boom" });
    const { res, status, body } = mkRes();
    await autonomySet(mkReq({ decision_class: "pm.weekly-plan", autonomy: null }), res);
    expect(status()).toBe(500);
    expect((body() as { error: { code: string } }).error.code).toBe("clear_autonomy_failed");
  });
});
