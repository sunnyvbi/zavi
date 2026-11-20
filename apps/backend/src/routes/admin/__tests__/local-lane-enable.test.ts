import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const state = vi.hoisted(() => ({
  staffThrows: false,
  tenantExists: true,
  rpcError: null as { message: string } | null,
  lastEnableArgs: null as Record<string, unknown> | null,
  tokenRows: [] as Array<{
    id: string;
    token_hash: string;
    token_salt: string;
    revoked_at: string | null;
  }>,
  auditRows: [] as Array<Record<string, unknown>>,
  masterOn: true,
}));

class FakeStaffError extends Error {
  status = 403;
  constructor() {
    super("not_staff");
  }
}

vi.mock("@/services/auth/staff-middleware", () => ({
  assertStaff: () => {
    if (state.staffThrows) throw new FakeStaffError();
    return { user_id: "staff-1", email: "ravi@upcar.ai" };
  },
}));

vi.mock("@/services/staff/audit", () => ({
  writeStaffAudit: async (row: Record<string, unknown>) => {
    state.auditRows.push(row);
  },
}));

vi.mock("@/services/settings", () => ({
  getBoolSetting: async () => state.masterOn,
}));

vi.mock("@/services/supabase", () => {
  function chain(table: string) {
    if (table === "tenants") {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: state.tenantExists ? { id: "t" } : null,
            }),
          }),
        }),
      };
    }
    if (table === "mac_worker_tokens") {
      return {
        select: () => ({
          eq: () => ({
            is: async () => ({ data: state.tokenRows, error: null }),
          }),
        }),
        update: () => ({ eq: async () => ({ data: null, error: null }) }),
      };
    }
    return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) };
  }
  return {
    serviceClient: () => ({
      from: (table: string) => chain(table),
      rpc: async (name: string, args: Record<string, unknown>) => {
        if (name === "enable_local_lane_for_tenant") {
          state.lastEnableArgs = args;
          if (state.rpcError) return { data: null, error: state.rpcError };
          state.tokenRows.push({
            id: "token-1",
            token_hash: args.p_token_hash as string,
            token_salt: args.p_token_salt as string,
            revoked_at: null,
          });
          return { data: "token-1", error: null };
        }
        return { data: null, error: null };
      },
    }),
  };
});

import { staffLocalLaneEnable } from "@/routes/admin/local-lane";
import { resolveMacWorkerToken } from "@/services/auth/mac-worker-token";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";

function mockReqRes(body: unknown) {
  const req = { body } as unknown as Request;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  return { req, res };
}

beforeEach(() => {
  state.staffThrows = false;
  state.tenantExists = true;
  state.rpcError = null;
  state.lastEnableArgs = null;
  state.tokenRows = [];
  state.auditRows = [];
  state.masterOn = true;
});

describe("POST /api/admin/local-lane/enable", () => {
  it("happy path → returns { ok, tenant_id, token_id, raw_token } ONCE", async () => {
    const { req, res } = mockReqRes({ tenant_id: TENANT });
    await staffLocalLaneEnable(req, res);
    const payload = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.ok).toBe(true);
    expect(payload.tenant_id).toBe(TENANT);
    expect(payload.token_id).toBe("token-1");
    expect(typeof payload.raw_token).toBe("string");
    expect(payload.raw_token).toMatch(/^zavi_mac_[0-9a-f]{64}$/);
  });

  it("the RPC receives HASH/SALT/PREFIX — never the raw token", async () => {
    const { req, res } = mockReqRes({ tenant_id: TENANT });
    await staffLocalLaneEnable(req, res);
    const raw = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0].raw_token as string;
    const args = state.lastEnableArgs!;
    expect(args.p_tenant_id).toBe(TENANT);
    expect(typeof args.p_token_hash).toBe("string");
    expect(typeof args.p_token_salt).toBe("string");
    expect(args.p_token_prefix).toBe(raw.slice(0, 21));
    expect(args.p_actor_user_id).toBe("staff-1");
    expect(args.p_actor_email).toBe("ravi@upcar.ai");
    expect(args.p_updated_by).toBeUndefined();
    for (const v of Object.values(args)) {
      expect(v).not.toBe(raw);
    }
  });

  it("the minted token VALIDATES through the unchanged resolveMacWorkerToken path", async () => {
    const { req, res } = mockReqRes({ tenant_id: TENANT });
    await staffLocalLaneEnable(req, res);
    const raw = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0].raw_token as string;
    const caller = await resolveMacWorkerToken(raw);
    expect(caller.token_id).toBe("token-1");
    expect(caller.owner).toBe("mac:token-1");
  });

  it("audit is delegated to the atomic RPC (not the swallow-prone TS writeStaffAudit)", async () => {
    const { req, res } = mockReqRes({ tenant_id: TENANT });
    await staffLocalLaneEnable(req, res);
    const raw = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0].raw_token as string;
    expect(state.auditRows).toHaveLength(0);
    const args = state.lastEnableArgs!;
    expect(args.p_actor_user_id).toBe("staff-1");
    expect(args.p_actor_email).toBe("ravi@upcar.ai");
    expect(args.p_token_prefix).toBe(raw.slice(0, 21));
  });

  it("staff-gated — assertStaff throwing prevents any mint", async () => {
    state.staffThrows = true;
    const { req, res } = mockReqRes({ tenant_id: TENANT });
    await expect(staffLocalLaneEnable(req, res)).rejects.toBeInstanceOf(FakeStaffError);
    expect(state.lastEnableArgs).toBeNull();
    expect(state.auditRows).toHaveLength(0);
  });

  it("rejects a non-uuid tenant_id (400, no mint)", async () => {
    const { req, res } = mockReqRes({ tenant_id: "not-a-uuid" });
    await staffLocalLaneEnable(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(state.lastEnableArgs).toBeNull();
  });

  it("404 when the tenant does not exist — before any mint", async () => {
    state.tenantExists = false;
    const { req, res } = mockReqRes({ tenant_id: TENANT });
    await staffLocalLaneEnable(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(state.lastEnableArgs).toBeNull();
  });

  it("500 on RPC error — no token returned, no audit row", async () => {
    state.rpcError = { message: "boom" };
    const { req, res } = mockReqRes({ tenant_id: TENANT });
    await staffLocalLaneEnable(req, res);
    expect(res.status).toHaveBeenCalledWith(500);
    const payload = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.error.code).toBe("rpc_failed");
    expect(payload.raw_token).toBeUndefined();
    expect(state.auditRows).toHaveLength(0);
  });
});
