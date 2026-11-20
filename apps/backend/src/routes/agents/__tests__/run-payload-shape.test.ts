
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  canUserAccessAgent: vi.fn(),
  enqueueAgentRun: vi.fn(),
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/services/auth/members", () => ({
  canUserAccessAgent: mocks.canUserAccessAgent,
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({}),
}));
vi.mock("@/services/agents/runner", () => ({
  enqueueAgentRun: mocks.enqueueAgentRun,
  AgentNotFoundError: class AgentNotFoundError extends Error {},
  SafetyGateError: class SafetyGateError extends Error {},
  BudgetExceededError: class BudgetExceededError extends Error {},
  FleetHaltedError: class FleetHaltedError extends Error {},
}));
vi.mock("@/services/agents/tenant", () => ({
  TenantConfigNotFoundError: class TenantConfigNotFoundError extends Error {},
}));

import { agentRun } from "../run";

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

function reqWith(body: unknown) {
  return { params: { slug: "engineer" }, body } as never;
}

beforeEach(() => {
  mocks.requireAuth.mockReset();
  mocks.canUserAccessAgent.mockReset();
  mocks.enqueueAgentRun.mockReset();
  mocks.requireAuth.mockResolvedValue({
    tenant_id: "tnt-1",
    user_id: "user-1",
    access_token: "tok",
  });
  mocks.canUserAccessAgent.mockResolvedValue(true);
  mocks.enqueueAgentRun.mockResolvedValue({ run_id: "run-abc" });
});

describe("agentRun — engineer payload-shape acceptance (F4)", () => {
  it("accepts the documented FLAT body and dispatches", async () => {
    const res = mockRes();
    await agentRun(reqWith({ task_description: "fix the login redirect bug" }), res as never);

    expect(res.statusCode).toBe(202);
    expect(res.body).toEqual({ run_id: "run-abc" });
    expect(mocks.enqueueAgentRun).toHaveBeenCalledTimes(1);
    const arg = mocks.enqueueAgentRun.mock.calls[0][0];
    expect(arg.agent_slug).toBe("engineer");
    expect(arg.payload).toMatchObject({
      task_description: "fix the login redirect bug",
      context_summary: "",
      source_agent: "manual",
    });
  });

  it("strips server-only provenance keys a caller tries to set (autopilot tracking T1)", async () => {
    const res = mockRes();
    await agentRun(
      reqWith({
        task_description: "fix it",
        source_decision_id: "11111111-1111-4111-8111-111111111111",
        origin_decision_id: "22222222-2222-4222-8222-222222222222",
        dispatched_by: "cgo",
        cgo_hire: { order_id: "x" },
        cgo_brief: { goal: "x" },
        goal_id: "33333333-3333-4333-8333-333333333333",
        goal_rev: "r",
        problem: "conversion",
        email_plan: { mode: "planned_draft", item_id: "44444444-4444-4444-8444-444444444444", version: 1 },
      }),
      res as never,
    );
    expect(res.statusCode).toBe(202);
    const payload = mocks.enqueueAgentRun.mock.calls[0][0].payload as Record<string, unknown>;
    expect(payload.task_description).toBe("fix it");
    for (const k of ["source_decision_id", "origin_decision_id", "dispatched_by", "cgo_hire", "cgo_brief", "goal_id", "goal_rev", "problem", "email_plan"]) {
      expect(payload, k).not.toHaveProperty(k);
    }
  });

  it("still accepts the NESTED payload envelope (no regression)", async () => {
    const res = mockRes();
    await agentRun(
      reqWith({ payload: { task_description: "refactor the auth guard" } }),
      res as never,
    );

    expect(res.statusCode).toBe(202);
    expect(mocks.enqueueAgentRun).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueAgentRun.mock.calls[0][0].payload).toMatchObject({
      task_description: "refactor the auth guard",
    });
  });

  it("accepts a full flat documented body with optional fields", async () => {
    const res = mockRes();
    await agentRun(
      reqWith({
        task_description: "add a health route",
        repo_hint: "rravi149/praxis",
        file_hints: ["apps/backend/src/routes/health.ts"],
        context_summary: "ctx",
        source_agent: "manual",
      }),
      res as never,
    );
    expect(res.statusCode).toBe(202);
    expect(mocks.enqueueAgentRun.mock.calls[0][0].payload).toMatchObject({
      task_description: "add a health route",
      repo_hint: "rravi149/praxis",
    });
  });

  it("400s a genuinely empty body (required field truly absent)", async () => {
    const res = mockRes();
    await agentRun(reqWith({}), res as never);
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe("input_invalid");
    expect(mocks.enqueueAgentRun).not.toHaveBeenCalled();
  });

  it("400s a flat body that omits the required field (validation intact)", async () => {
    const res = mockRes();
    await agentRun(reqWith({ context_summary: "ctx only", source_agent: "x" }), res as never);
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: { path?: unknown[] } }).error.path).toEqual([
      "task_description",
    ]);
    expect(mocks.enqueueAgentRun).not.toHaveBeenCalled();
  });
});
