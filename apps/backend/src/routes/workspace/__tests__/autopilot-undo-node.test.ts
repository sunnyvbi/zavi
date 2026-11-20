
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  ownershipMaybeSingle: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));

vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: mocks.ownershipMaybeSingle,
          }),
        }),
      }),
    }),
  }),
  serviceClient: () => ({ rpc: mocks.rpc }),
}));

vi.mock("@/services/auth/tenant-role", async (orig) => ({
  ...(await orig<typeof import("@/services/auth/tenant-role")>()),
  requireTenantRole: async () => true,
}));

import { postAutopilotUndoNode } from "../autopilot";

function mockRes() {
  const res: {
    statusCode: number;
    body: unknown;
    status: (c: number) => typeof res;
    json: (b: unknown) => typeof res;
  } = {
    statusCode: 200,
    body: undefined,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
  return res;
}

beforeEach(() => {
  mocks.requireAuth.mockReset();
  mocks.ownershipMaybeSingle.mockReset();
  mocks.rpc.mockReset();
  mocks.requireAuth.mockResolvedValue({
    tenant_id: "tnt-1",
    user_id: "user-1",
    access_token: "tok",
  });
});

describe("postAutopilotUndoNode", () => {
  it("returns early when requireAuth fails (no DB calls)", async () => {
    mocks.requireAuth.mockResolvedValueOnce(null);
    const res = mockRes();
    await postAutopilotUndoNode(
      { params: { run_id: "run-1", node_id: "node-a" } } as never,
      res as never,
    );
    expect(mocks.ownershipMaybeSingle).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("400s a missing run_id", async () => {
    const res = mockRes();
    await postAutopilotUndoNode(
      { params: { run_id: "", node_id: "node-a" } } as never,
      res as never,
    );
    expect(res.statusCode).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("400s a missing node_id", async () => {
    const res = mockRes();
    await postAutopilotUndoNode(
      { params: { run_id: "run-1", node_id: "" } } as never,
      res as never,
    );
    expect(res.statusCode).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("404s when the conductor_run isn't owned by this tenant (RLS probe empty) and NEVER calls the RPC", async () => {
    mocks.ownershipMaybeSingle.mockResolvedValueOnce({ data: null, error: null });
    const res = mockRes();
    await postAutopilotUndoNode(
      { params: { run_id: "run-foreign", node_id: "node-a" } } as never,
      res as never,
    );
    expect(res.statusCode).toBe(404);
    expect((res.body as { error: { code: string } }).error.code).toBe(
      "conductor_run_not_found",
    );
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("409s a 'not_dispatched' node", async () => {
    mocks.ownershipMaybeSingle.mockResolvedValueOnce({
      data: { id: "run-1" },
      error: null,
    });
    mocks.rpc.mockResolvedValueOnce({
      data: { ok: false, reason: "not_dispatched", status: "done" },
      error: null,
    });
    const res = mockRes();
    await postAutopilotUndoNode(
      { params: { run_id: "run-1", node_id: "node-done" } } as never,
      res as never,
    );
    expect(res.statusCode).toBe(409);
    expect((res.body as { error: { code: string } }).error.code).toBe("not_dispatched");
  });

  it("410s a 'window_expired' undo (with elapsed + window in the body)", async () => {
    mocks.ownershipMaybeSingle.mockResolvedValueOnce({
      data: { id: "run-1" },
      error: null,
    });
    mocks.rpc.mockResolvedValueOnce({
      data: {
        ok: false,
        reason: "window_expired",
        elapsed_minutes: 47,
        window_minutes: 15,
      },
      error: null,
    });
    const res = mockRes();
    await postAutopilotUndoNode(
      { params: { run_id: "run-1", node_id: "node-old" } } as never,
      res as never,
    );
    expect(res.statusCode).toBe(410);
    const body = res.body as {
      error: { code: string; elapsed_minutes: number; window_minutes: number };
    };
    expect(body.error.code).toBe("window_expired");
    expect(body.error.elapsed_minutes).toBe(47);
    expect(body.error.window_minutes).toBe(15);
  });

  it("200s the happy path and returns {ok:true, ledger_id}", async () => {
    mocks.ownershipMaybeSingle.mockResolvedValueOnce({
      data: { id: "run-1" },
      error: null,
    });
    mocks.rpc.mockResolvedValueOnce({
      data: { ok: true, ledger_id: "ledger-xyz" },
      error: null,
    });
    const res = mockRes();
    await postAutopilotUndoNode(
      { params: { run_id: "run-1", node_id: "node-live" } } as never,
      res as never,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, ledger_id: "ledger-xyz" });

    expect(mocks.rpc).toHaveBeenCalledWith("undo_dispatched_node", {
      p_tenant_id: "tnt-1",
      p_conductor_run_id: "run-1",
      p_node_id: "node-live",
    });
  });

  it("500s an RPC error without leaking RPC details into the message body shape", async () => {
    mocks.ownershipMaybeSingle.mockResolvedValueOnce({
      data: { id: "run-1" },
      error: null,
    });
    mocks.rpc.mockResolvedValueOnce({
      data: null,
      error: { message: "internal RPC failure" },
    });
    const res = mockRes();
    await postAutopilotUndoNode(
      { params: { run_id: "run-1", node_id: "node-a" } } as never,
      res as never,
    );
    expect(res.statusCode).toBe(500);
    expect((res.body as { error: { code: string } }).error.code).toBe("undo_failed");
  });
});
