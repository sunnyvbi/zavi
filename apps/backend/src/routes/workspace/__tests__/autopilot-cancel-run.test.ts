
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  ownershipMaybeSingle: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));

const held = vi.hoisted(() => ({ drop: vi.fn(async (..._a: unknown[]) => 0) }));
vi.mock("@/services/sites/queued-change", () => ({ dropHeldChanges: held.drop }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));

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

import { postAutopilotCancelRun } from "../autopilot";

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

describe("postAutopilotCancelRun", () => {
  it("returns early when requireAuth fails (no DB calls)", async () => {
    mocks.requireAuth.mockResolvedValueOnce(null);
    const res = mockRes();
    await postAutopilotCancelRun(
      { params: { run_id: "run-1" } } as never,
      res as never,
    );
    expect(mocks.ownershipMaybeSingle).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("400s a missing run_id", async () => {
    const res = mockRes();
    await postAutopilotCancelRun(
      { params: { run_id: "" } } as never,
      res as never,
    );
    expect(res.statusCode).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("404s when the conductor_run isn't owned by this tenant (RLS probe empty) and NEVER calls the RPC", async () => {
    mocks.ownershipMaybeSingle.mockResolvedValueOnce({ data: null, error: null });
    const res = mockRes();
    await postAutopilotCancelRun(
      { params: { run_id: "run-foreign" } } as never,
      res as never,
    );
    expect(res.statusCode).toBe(404);
    expect((res.body as { error: { code: string } }).error.code).toBe(
      "conductor_run_not_found",
    );
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("200s the happy path with cancelled:true and surfaces prior_status + ledger_id", async () => {
    mocks.ownershipMaybeSingle.mockResolvedValueOnce({
      data: { id: "run-1" },
      error: null,
    });
    mocks.rpc.mockResolvedValueOnce({
      data: {
        ok: true,
        cancelled: true,
        prior_status: "active",
        ledger_id: "ledger-xyz",
      },
      error: null,
    });
    const res = mockRes();
    await postAutopilotCancelRun(
      { params: { run_id: "run-1" } } as never,
      res as never,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      cancelled: true,
      prior_status: "active",
      ledger_id: "ledger-xyz",
    });

    expect(mocks.rpc).toHaveBeenCalledWith("cancel_conductor_run", {
      p_tenant_id: "tnt-1",
      p_conductor_run_id: "run-1",
      p_reason: "user_cancel",
    });
  });

  it("Stop drops the changes held on that run, and a failed drop does not fail the Stop", async () => {
    held.drop.mockClear();
    held.drop.mockRejectedValueOnce(new Error("db down"));
    mocks.ownershipMaybeSingle.mockResolvedValueOnce({ data: { id: "run-1" }, error: null });
    mocks.rpc.mockResolvedValueOnce({ data: { ok: true, cancelled: true, prior_status: "active" }, error: null });
    const res = mockRes();
    await postAutopilotCancelRun({ params: { run_id: "run-1" } } as never, res as never);
    expect(held.drop).toHaveBeenCalledWith(expect.any(String), "run-1");
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, cancelled: true });
  });

  it("a Stop on a finished run drops nothing", async () => {
    held.drop.mockClear();
    mocks.ownershipMaybeSingle.mockResolvedValueOnce({ data: { id: "run-1" }, error: null });
    mocks.rpc.mockResolvedValueOnce({ data: { ok: true, cancelled: false, prior_status: "done" }, error: null });
    await postAutopilotCancelRun({ params: { run_id: "run-1" } } as never, mockRes() as never);
    expect(held.drop).not.toHaveBeenCalled();
  });

  it("200s with cancelled:false when the run is already terminal (idempotent Stop press)", async () => {
    mocks.ownershipMaybeSingle.mockResolvedValueOnce({
      data: { id: "run-1" },
      error: null,
    });
    mocks.rpc.mockResolvedValueOnce({
      data: { ok: true, cancelled: false, prior_status: "done" },
      error: null,
    });
    const res = mockRes();
    await postAutopilotCancelRun(
      { params: { run_id: "run-1" } } as never,
      res as never,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      cancelled: false,
      prior_status: "done",
      ledger_id: null,
    });
  });

  it("404s when the RPC returns ok:false (defensive race fallback)", async () => {
    mocks.ownershipMaybeSingle.mockResolvedValueOnce({
      data: { id: "run-1" },
      error: null,
    });
    mocks.rpc.mockResolvedValueOnce({
      data: { ok: false, reason: "conductor_run_not_found" },
      error: null,
    });
    const res = mockRes();
    await postAutopilotCancelRun(
      { params: { run_id: "run-1" } } as never,
      res as never,
    );
    expect(res.statusCode).toBe(404);
    expect((res.body as { error: { code: string } }).error.code).toBe(
      "conductor_run_not_found",
    );
  });

  it("500s an RPC error", async () => {
    mocks.ownershipMaybeSingle.mockResolvedValueOnce({
      data: { id: "run-1" },
      error: null,
    });
    mocks.rpc.mockResolvedValueOnce({
      data: null,
      error: { message: "internal RPC failure" },
    });
    const res = mockRes();
    await postAutopilotCancelRun(
      { params: { run_id: "run-1" } } as never,
      res as never,
    );
    expect(res.statusCode).toBe(500);
    expect((res.body as { error: { code: string } }).error.code).toBe("cancel_failed");
  });
});
