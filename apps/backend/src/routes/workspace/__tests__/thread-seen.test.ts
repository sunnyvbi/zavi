import { describe, it, expect, vi, beforeEach } from "vitest";

const { rpcMock } = vi.hoisted(() => ({
  rpcMock: vi.fn(async (_fn: string, _args: unknown) => ({ error: null as { message: string } | null })),
}));
vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async () => ({ user_id: "u-1", tenant_id: "t-1", access_token: "tok-1" })),
}));
vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: vi.fn(() => ({ rpc: rpcMock })),
}));

import { workspaceThreadSeen } from "../thread-seen";

type FakeRes = {
  statusCode: number;
  status: (code: number) => FakeRes;
  json: (...args: unknown[]) => FakeRes;
  end: (...args: unknown[]) => FakeRes;
};

function makeRes(): FakeRes {
  const res: FakeRes = {
    statusCode: 200,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json: vi.fn(() => res),
    end: vi.fn(() => res),
  };
  return res;
}

const THREAD = "11111111-1111-4111-8111-111111111111";

describe("POST /api/workspace/thread-seen", () => {
  beforeEach(() => {
    rpcMock.mockClear();
  });

  it("returns 204 when the marker is written", async () => {
    const res = makeRes();
    await workspaceThreadSeen({ body: { thread_id: THREAD } } as never, res as never);
    expect(rpcMock).toHaveBeenCalledWith("mark_thread_seen", { p_thread_id: THREAD });
    expect(res.statusCode).toBe(204);
  });

  it("returns 500 when the RPC fails, so the client knows to retry", async () => {
    rpcMock.mockResolvedValueOnce({ error: { message: "boom" } });
    const res = makeRes();
    await workspaceThreadSeen({ body: { thread_id: THREAD } } as never, res as never);
    expect(res.statusCode).toBe(500);
    expect(res.end).not.toHaveBeenCalled();
  });
});
