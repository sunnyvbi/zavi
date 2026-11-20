import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  getAgentRunById: vi.fn(),
  canUserAccessAgentRun: vi.fn(),
  memory: { data: null as unknown, error: null as unknown } as { data: unknown; error: unknown } | "throw",
  memoryEq: [] as Array<[string, unknown]>,
  memoryReads: 0,
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/services/agents/runner", () => ({ getAgentRunById: mocks.getAgentRunById }));
vi.mock("@/services/auth/members", () => ({ canUserAccessAgentRun: mocks.canUserAccessAgentRun }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.in = () => q;
      q.lte = async () => ({ count: 1, error: null });
      return q;
    },
  }),
}));
vi.mock("@/services/onboarding/background-memory", () => ({
  readMemoryStatus: async (tid: string) => {
    mocks.memoryReads += 1;
    mocks.memoryEq.push(["tenant_id", tid]);
    const m = mocks.memory;
    if (m === "throw") throw new Error("db blip");
    if (m.error) throw new Error("read failed");
    return (m.data as { status?: string } | null)?.status ?? null;
  },
}));

import { agentRunStatus } from "../run-status";

function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
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
const run = (status: string) => ({ id: "run-1", tenant_id: "tnt-1", status, started_at: "2026-10-19T00:00:00Z" });

async function call(params: Record<string, string> = { run_id: "run-1" }) {
  const res = mockRes();
  await agentRunStatus({ params, query: { tenant_id: "evil" }, body: { tenant_id: "evil" } } as never, res as never);
  return res;
}

beforeEach(() => {
  mocks.requireAuth.mockReset().mockResolvedValue(AUTH);
  mocks.getAgentRunById.mockReset();
  mocks.canUserAccessAgentRun.mockReset().mockResolvedValue(true);
  mocks.memory = { data: null, error: null };
  mocks.memoryEq = [];
  mocks.memoryReads = 0;
});

describe("agentRunStatus — waiting_on memory", () => {
  it("queued run + pending onboarding memory → waiting_on:'memory', looked up by the authorized tenant", async () => {
    mocks.getAgentRunById.mockResolvedValueOnce(run("queued"));
    mocks.memory = { data: { status: "pending" }, error: null };
    const res = await call();
    expect(res.statusCode).toBe(200);
    expect((res.body as { waiting_on?: string }).waiting_on).toBe("memory");
    expect(mocks.memoryEq).toEqual([["tenant_id", "tnt-1"]]);
  });

  it.each([
    ["ready", { data: { status: "ready" }, error: null }],
    ["failed", { data: { status: "failed" }, error: null }],
    ["no row", { data: null, error: null }],
    ["read error", { data: null, error: { message: "x" } }],
    ["throw", "throw" as const],
  ])("queued run, memory %s → no waiting_on, still 200", async (_l, memory) => {
    mocks.getAgentRunById.mockResolvedValueOnce(run("queued"));
    mocks.memory = memory as never;
    const res = await call();
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toHaveProperty("waiting_on");
  });

  it("running run → no memory lookup, no waiting_on", async () => {
    mocks.getAgentRunById.mockResolvedValueOnce(run("running"));
    mocks.memory = { data: { status: "pending" }, error: null };
    const res = await call();
    expect(res.body).not.toHaveProperty("waiting_on");
    expect(mocks.memoryReads).toBe(0);
  });

  it("foreign run → 404 and no memory lookup", async () => {
    mocks.getAgentRunById.mockResolvedValueOnce(null);
    const res = await call({ run_id: "run-x" });
    expect(res.statusCode).toBe(404);
    expect(mocks.memoryReads).toBe(0);
  });
});
