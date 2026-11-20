import { describe, it, expect, vi, beforeEach } from "vitest";

const { requireAuthMock, state } = vi.hoisted(() => {
  const s = {
    auth: { user_id: "u-1", tenant_id: "t-1", access_token: "tok-1" } as
      | { user_id: string; tenant_id: string; access_token: string }
      | null,
  };
  return { requireAuthMock: vi.fn(async (_req: unknown, _res: unknown) => s.auth), state: s };
});
vi.mock("@/services/auth/middleware", () => ({ requireAuth: requireAuthMock }));

const { enqueueMock } = vi.hoisted(() => ({
  enqueueMock: vi.fn(async (_i: { agent_slug: string; trigger: string; payload: unknown }) => ({
    run_id: "run-xyz",
  })),
}));
vi.mock("@/services/agents/runner", () => ({ enqueueAgentRun: enqueueMock }));

const { fromMock, queryState } = vi.hoisted(() => {
  const qs = {
    eqArgs: [] as Array<[string, unknown]>,
    filterArgs: [] as Array<[string, string, unknown]>,
    rows: [] as unknown[],
  };
  const builder: Record<string, unknown> = {};
  builder.select = () => builder;
  builder.eq = (col: string, val: unknown) => {
    qs.eqArgs.push([col, val]);
    return builder;
  };
  builder.filter = (col: string, op: string, val: unknown) => {
    qs.filterArgs.push([col, op, val]);
    return builder;
  };
  builder.order = () => Promise.resolve({ data: qs.rows, error: null });
  return { fromMock: vi.fn(() => builder), queryState: qs };
});
vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: vi.fn(() => ({ from: fromMock })),
}));

import { getPlaybooks, launchPlaybook, getPlaybookTrail } from "../playbooks";

function makeRes() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(p: unknown) {
      this.body = p;
      return this;
    },
  };
}
type Res = ReturnType<typeof makeRes>;

beforeEach(() => {
  enqueueMock.mockClear();
  fromMock.mockClear();
  queryState.eqArgs = [];
  queryState.filterArgs = [];
  queryState.rows = [];
  state.auth = { user_id: "u-1", tenant_id: "t-1", access_token: "tok-1" };
});

describe("GET /api/playbooks", () => {
  it("returns the catalog", async () => {
    const res = makeRes();
    await getPlaybooks({} as never, res as never);
    const body = res.body as { playbooks: Array<{ slug: string }> };
    expect(body.playbooks.length).toBeGreaterThanOrEqual(2);
    expect(body.playbooks.map((p) => p.slug)).toContain("recover-stalled-sellers");
  });
  it("401s when unauthenticated", async () => {
    state.auth = null;
    const res = makeRes();
    await getPlaybooks({} as never, res as never);
    expect(res.body).toBeUndefined();
  });
});

describe("POST /api/playbooks/:slug/launch", () => {
  it("enqueues the agent with trigger='playbook' + a fresh playbook_run_id in payload", async () => {
    const res = makeRes();
    await launchPlaybook({ params: { slug: "campaigns-over-cac" } } as never, res as never);

    expect(enqueueMock).toHaveBeenCalledTimes(1);
    const arg = enqueueMock.mock.calls[0][0] as {
      agent_slug: string;
      tenant_id: string;
      trigger: string;
      payload: { playbook_run_id: string; playbook_slug: string };
    };
    expect(arg.trigger).toBe("playbook");
    expect(arg.agent_slug).toBe("performance-marketer");
    expect(arg.tenant_id).toBe("t-1");
    expect(arg.payload.playbook_slug).toBe("campaigns-over-cac");
    expect(arg.payload.playbook_run_id).toMatch(/^[0-9a-f-]{36}$/);

    const body = res.body as { playbook_run_id: string; run_id: string };
    expect(body.run_id).toBe("run-xyz");
    expect(body.playbook_run_id).toBe(arg.payload.playbook_run_id);
  });

  it("404s an unknown playbook without enqueuing", async () => {
    const res = makeRes();
    await launchPlaybook({ params: { slug: "nope" } } as never, res as never);
    expect(res.statusCode).toBe(404);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("returns a clean 500 when enqueue throws (never an unhandled rejection that crashes the server)", async () => {
    enqueueMock.mockRejectedValueOnce(new Error("agent_runs_trigger_check violation"));
    const res = makeRes();
    await expect(
      launchPlaybook({ params: { slug: "recover-stalled-sellers" } } as never, res as never),
    ).resolves.toBeUndefined();
    expect(res.statusCode).toBe(500);
    const body = res.body as { error: { code: string; message: string } };
    expect(body.error.code).toBe("launch_failed");
    expect(body.error.message).not.toContain("agent_runs_trigger_check");
  });
});

describe("GET /api/playbooks/runs/:id/trail", () => {
  it("filters by AUTH tenant_id AND the path playbook_run_id, returns an honest summary", async () => {
    queryState.rows = [
      { decision_class: "outbound.send", status: "acted", dispatch_error: null },
      { decision_class: "outbound.send", status: "proposed", dispatch_error: null },
    ];
    const res = makeRes();
    await getPlaybookTrail({ params: { id: "pr-1" } } as never, res as never);

    expect(queryState.eqArgs).toContainEqual(["tenant_id", "t-1"]);
    expect(queryState.filterArgs).toContainEqual(["body->>playbook_run_id", "eq", "pr-1"]);

    const body = res.body as { summary: { acted: number; proposed: number; total: number } };
    expect(body.summary.total).toBe(2);
    expect(body.summary.acted).toBe(1);
    expect(body.summary.proposed).toBe(1);
  });
});
