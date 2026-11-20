
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  getAgentRunById: vi.fn(),
  canUserAccessAgentRun: vi.fn(),
  countResult: undefined as unknown,
  countCalls: 0,
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
      select: () => ({
        in: () => ({
          lte: () => {
            mocks.countCalls += 1;
            return mocks.countResult as Promise<unknown>;
          },
        }),
      }),
    }),
  }),
}));

import { agentRunStatus } from "../run-status";

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
  mocks.countResult = Promise.resolve({ count: 3, error: null });
  mocks.countCalls = 0;
  mocks.requireAuth.mockResolvedValue(AUTH);
  mocks.canUserAccessAgentRun.mockResolvedValue(true);
});

describe("agentRunStatus — queue position", () => {
  it("queued run → queue_position (1-based) + queue_ahead present", async () => {
    mocks.getAgentRunById.mockResolvedValueOnce({
      id: "run-1",
      tenant_id: "tnt-1",
      status: "queued",
      started_at: "2026-06-19T00:00:00Z",
    });
    const res = mockRes();
    await agentRunStatus({ params: { run_id: "run-1" } } as never, res as never);
    expect(res.statusCode).toBe(200);
    const body = res.body as { queue_position: number; queue_ahead: number };
    expect(body.queue_position).toBe(3);
    expect(body.queue_ahead).toBe(2);
    expect(mocks.countCalls).toBe(1);
  });

  it("running run → no queue hint + count query NEVER issued", async () => {
    mocks.getAgentRunById.mockResolvedValueOnce({
      id: "run-1",
      tenant_id: "tnt-1",
      status: "running",
      enqueued_at: "2026-06-19T00:00:00Z",
      started_at: "2026-06-19T00:00:05Z",
    });
    const res = mockRes();
    await agentRunStatus({ params: { run_id: "run-1" } } as never, res as never);
    expect(res.statusCode).toBe(200);
    const body = res.body as { queue_position: number | null; queue_ahead: number | null };
    expect(body.queue_position).toBeNull();
    expect(body.queue_ahead).toBeNull();
    expect(mocks.countCalls).toBe(0);
  });

  it("count error → fail-open (null hint), still 200", async () => {
    mocks.getAgentRunById.mockResolvedValueOnce({
      id: "run-1",
      tenant_id: "tnt-1",
      status: "queued",
      started_at: "2026-06-19T00:00:00Z",
    });
    mocks.countResult = Promise.reject(new Error("db blip"));
    const res = mockRes();
    await agentRunStatus({ params: { run_id: "run-1" } } as never, res as never);
    expect(res.statusCode).toBe(200);
    const body = res.body as { queue_position: number | null; queue_ahead: number | null };
    expect(body.queue_position).toBeNull();
    expect(body.queue_ahead).toBeNull();
  });

  it("foreign-tenant run → 404 + no count query (cross-tenant guard)", async () => {
    mocks.getAgentRunById.mockResolvedValueOnce(null);
    const res = mockRes();
    await agentRunStatus({ params: { run_id: "run-x" } } as never, res as never);
    expect(mocks.getAgentRunById).toHaveBeenCalledWith(AUTH.tenant_id, "run-x");
    expect(res.statusCode).toBe(404);
    expect(mocks.countCalls).toBe(0);
    expect(mocks.canUserAccessAgentRun).not.toHaveBeenCalled();
  });
});
