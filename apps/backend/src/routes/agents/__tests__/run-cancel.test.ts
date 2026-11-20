
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  getAgentRunById: vi.fn(),
  canUserAccessAgentRun: vi.fn(),
  updatePayload: undefined as Record<string, unknown> | undefined,
  updatePayloads: [] as Record<string, unknown>[],
  updateSelect: vi.fn(),
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/services/agents/runner", () => ({
  getAgentRunById: mocks.getAgentRunById,
}));
vi.mock("@/services/auth/members", () => ({
  canUserAccessAgentRun: mocks.canUserAccessAgentRun,
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => ({
      update: (payload: Record<string, unknown>) => {
        mocks.updatePayload = payload;
        mocks.updatePayloads.push(payload);
        return {
          eq: () => ({
            eq: () => ({
              eq: () => ({ select: mocks.updateSelect }),
            }),
          }),
        };
      },
    }),
  }),
}));

import { agentRunCancel } from "../run-cancel";

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

const AUTH = { tenant_id: "tnt-1", user_id: "user-1", access_token: "tok" };

beforeEach(() => {
  mocks.requireAuth.mockReset();
  mocks.getAgentRunById.mockReset();
  mocks.canUserAccessAgentRun.mockReset();
  mocks.updateSelect.mockReset();
  mocks.updatePayload = undefined;
  mocks.updatePayloads = [];
  mocks.requireAuth.mockResolvedValue(AUTH);
  mocks.canUserAccessAgentRun.mockResolvedValue(true);
});

describe("agentRunCancel", () => {
  it("returns early when requireAuth fails (no DB calls)", async () => {
    mocks.requireAuth.mockResolvedValueOnce(null);
    const res = mockRes();
    await agentRunCancel({ params: { run_id: "run-1" } } as never, res as never);
    expect(mocks.getAgentRunById).not.toHaveBeenCalled();
    expect(mocks.updateSelect).not.toHaveBeenCalled();
  });

  it("400s a missing run_id", async () => {
    const res = mockRes();
    await agentRunCancel({ params: {} } as never, res as never);
    expect(res.statusCode).toBe(400);
    expect(mocks.getAgentRunById).not.toHaveBeenCalled();
  });

  it("404s a FOREIGN-TENANT run and NEVER writes (cross-tenant guard)", async () => {
    mocks.getAgentRunById.mockResolvedValueOnce(null);
    const res = mockRes();
    await agentRunCancel(
      { params: { run_id: "run-foreign" } } as never,
      res as never,
    );
    expect(mocks.getAgentRunById).toHaveBeenCalledWith(AUTH.tenant_id, "run-foreign");
    expect(res.statusCode).toBe(404);
    expect((res.body as { error: { code: string } }).error.code).toBe("not_found");
    expect(mocks.canUserAccessAgentRun).not.toHaveBeenCalled();
    expect(mocks.updateSelect).not.toHaveBeenCalled();
  });

  it("404s a missing run (getAgentRunById null)", async () => {
    mocks.getAgentRunById.mockResolvedValueOnce(null);
    const res = mockRes();
    await agentRunCancel({ params: { run_id: "nope" } } as never, res as never);
    expect(res.statusCode).toBe(404);
    expect(mocks.updateSelect).not.toHaveBeenCalled();
  });

  it("404s a NON-MEMBER caller (canUserAccessAgentRun false) and NEVER writes", async () => {
    mocks.getAgentRunById.mockResolvedValueOnce({
      tenant_id: "tnt-1",
      status: "running",
    });
    mocks.canUserAccessAgentRun.mockResolvedValueOnce(false);
    const res = mockRes();
    await agentRunCancel({ params: { run_id: "run-1" } } as never, res as never);
    expect(res.statusCode).toBe(404);
    expect(mocks.updateSelect).not.toHaveBeenCalled();
  });

  it("200 + cancelling:true + stop_requested=true on a RUNNING run", async () => {
    mocks.getAgentRunById.mockResolvedValueOnce({
      tenant_id: "tnt-1",
      status: "running",
    });
    mocks.updateSelect.mockResolvedValueOnce({ data: [], error: null });
    mocks.updateSelect.mockResolvedValueOnce({ data: [{ id: "run-1" }], error: null });
    const res = mockRes();
    await agentRunCancel({ params: { run_id: "run-1" } } as never, res as never);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, cancelling: true });
    expect(mocks.updatePayload).toEqual({ stop_requested: true });
  });

  it("200 + flips a QUEUED run terminal (cancelled + needs_run_end_emit)", async () => {
    mocks.getAgentRunById.mockResolvedValueOnce({
      tenant_id: "tnt-1",
      status: "queued",
    });
    mocks.updateSelect.mockResolvedValueOnce({ data: [{ id: "run-1" }], error: null });
    const res = mockRes();
    await agentRunCancel({ params: { run_id: "run-1" } } as never, res as never);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, cancelling: true });
    expect(mocks.updatePayload).toMatchObject({
      stop_requested: true,
      status: "cancelled",
      needs_run_end_emit: true,
    });
    expect(mocks.updatePayload?.finished_at).toBeTruthy();
  });

  it("200 + already_terminal:true with NO write on an already-terminal run", async () => {
    mocks.getAgentRunById.mockResolvedValueOnce({
      tenant_id: "tnt-1",
      status: "success",
    });
    const res = mockRes();
    await agentRunCancel({ params: { run_id: "run-1" } } as never, res as never);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, already_terminal: true });
    expect(mocks.updateSelect).not.toHaveBeenCalled();
  });

  it("200 + already_terminal when the CAS write matches 0 rows (terminal race)", async () => {
    mocks.getAgentRunById.mockResolvedValueOnce({
      tenant_id: "tnt-1",
      status: "running",
    });
    mocks.updateSelect.mockResolvedValueOnce({ data: [], error: null });
    mocks.updateSelect.mockResolvedValueOnce({ data: [], error: null });
    const res = mockRes();
    await agentRunCancel({ params: { run_id: "run-1" } } as never, res as never);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, already_terminal: true });
  });

  it("queued→running race: stop_requested ONLY on the running fallback, never terminalizes a live run", async () => {
    mocks.getAgentRunById.mockResolvedValueOnce({
      tenant_id: "tnt-1",
      status: "queued",
    });
    mocks.updateSelect
      .mockResolvedValueOnce({ data: [], error: null })
      .mockResolvedValueOnce({ data: [{ id: "run-1" }], error: null });
    const res = mockRes();
    await agentRunCancel({ params: { run_id: "run-1" } } as never, res as never);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, cancelling: true });
    expect(mocks.updatePayloads).toHaveLength(2);
    expect(mocks.updatePayloads[0]).toMatchObject({ status: "cancelled" });
    expect(mocks.updatePayloads[1]).toEqual({ stop_requested: true });
  });

  it("also accepts the legacy :id param", async () => {
    mocks.getAgentRunById.mockResolvedValueOnce({
      tenant_id: "tnt-1",
      status: "running",
    });
    mocks.updateSelect.mockResolvedValueOnce({ data: [{ id: "run-1" }], error: null });
    const res = mockRes();
    await agentRunCancel({ params: { id: "run-1" } } as never, res as never);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, cancelling: true });
  });
});
