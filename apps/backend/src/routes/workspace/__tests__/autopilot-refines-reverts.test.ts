import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  rootMaybeSingle: vi.fn(),
  sessionRuns: vi.fn(),
  agentRunsList: vi.fn(),
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));

let step = 0;
let lastSessionCalls: Array<[string, unknown[]]> = [];

function chain(terminal: () => unknown) {
  const calls: Array<[string, unknown[]]> = [];
  const api: Record<string, unknown> = {};
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, args]);
      return api;
    };
  for (const m of ["select", "eq", "in", "or", "gte", "is", "order"]) api[m] = record(m);
  api.limit = (...args: unknown[]) => {
    calls.push(["limit", args]);
    return terminal();
  };
  api.maybeSingle = () => terminal();
  api.calls = calls;
  return api as { calls: typeof calls };
}

vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({
    from: (table: string) => {
      if (table === "conductor_runs") {
        step += 1;
        if (step === 1) return chain(() => mocks.rootMaybeSingle());
        const c = chain(() => mocks.sessionRuns());
        lastSessionCalls = c.calls;
        return c;
      }
      if (table === "agent_runs") return chain(() => mocks.agentRunsList());
      throw new Error(`unexpected table in mock: ${table}`);
    },
  }),
  serviceClient: () => ({}),
}));

import { getAutopilotRefines } from "../autopilot";

const A = "0f1c1a5e-6a6e-4d5a-9a3a-1c0a2b3c4d01";
const B = "0f1c1a5e-6a6e-4d5a-9a3a-1c0a2b3c4d02";
const R1 = "0f1c1a5e-6a6e-4d5a-9a3a-1c0a2b3c4d11";
const R2 = "0f1c1a5e-6a6e-4d5a-9a3a-1c0a2b3c4d12";
const RB = "0f1c1a5e-6a6e-4d5a-9a3a-1c0a2b3c4d21";
const RESTORE_A = "0f1c1a5e-6a6e-4d5a-9a3a-1c0a2b3c4d31";
const RESTORE_ROOT = "0f1c1a5e-6a6e-4d5a-9a3a-1c0a2b3c4d32";
const UNDO_B = "0f1c1a5e-6a6e-4d5a-9a3a-1c0a2b3c4d33";
const UNDO_R1 = "0f1c1a5e-6a6e-4d5a-9a3a-1c0a2b3c4d34";

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

function freshGraph() {
  return [{ status: "done", child_run_id: null, payload: { stage: "build", refine_mode: false } }];
}

function refineGraph(parent: string | null, idea: string) {
  return [
    {
      status: "done",
      child_run_id: null,
      payload: { stage: "build", refine_mode: true, idea, parent_conductor_run_id: parent },
    },
  ];
}

function revertGraph(stage: "restore" | "undo", parent: string) {
  return [
    {
      id: `${stage}-x`,
      status: "done",
      payload: {
        stage,
        refine_mode: false,
        parent_conductor_run_id: parent,
        reverted_commit_sha: "a".repeat(40),
        new_commit_sha: "b".repeat(40),
        branch: "main",
      },
    },
  ];
}

function run(over: {
  id: string;
  kind: string;
  objective: string;
  goal_graph: unknown[];
  created_at: string;
  status?: string;
}) {
  return {
    id: over.id,
    objective: over.objective,
    status: over.status ?? "done",
    goal_graph: over.goal_graph,
    spend_usd: over.kind === "undo" ? 0 : 1,
    max_usd: over.kind === "undo" ? 0 : 5,
    created_at: over.created_at,
    updated_at: over.created_at,
    kind: over.kind,
  };
}

beforeEach(() => {
  step = 0;
  lastSessionCalls = [];
  mocks.requireAuth.mockReset();
  mocks.rootMaybeSingle.mockReset();
  mocks.sessionRuns.mockReset();
  mocks.agentRunsList.mockReset();
  mocks.requireAuth.mockResolvedValue({ tenant_id: "tnt-1", user_id: "user-1", access_token: "tok" });
  mocks.rootMaybeSingle.mockResolvedValue({ data: { id: A, created_at: "2026-09-01T10:00:00Z" }, error: null });
});

describe("GET /refines?session_id= with reverts", () => {
  it("shows this session's restore and undo rows, keeps the feed newest-first, excludes another session's revert", async () => {
    mocks.sessionRuns.mockResolvedValueOnce({
      data: [
        run({ id: A, kind: "build_app", objective: "Build product: Acme — a CRM", goal_graph: freshGraph(), created_at: "2026-09-01T10:00:00Z" }),
        run({ id: R1, kind: "build_app", objective: "[refine] Darker hero", goal_graph: refineGraph(A, "Darker hero"), created_at: "2026-09-01T11:00:00Z" }),
        run({ id: R2, kind: "build_app", objective: "[refine] Bigger logo", goal_graph: refineGraph(A, "Bigger logo"), created_at: "2026-09-01T12:00:00Z" }),
        run({ id: RESTORE_A, kind: "undo", objective: "[restore] Darker hero", goal_graph: revertGraph("restore", R1), created_at: "2026-09-01T13:00:00Z" }),
        run({ id: B, kind: "build_app", objective: "Build product: Acme — a dashboard", goal_graph: freshGraph(), created_at: "2026-09-02T10:00:00Z" }),
        run({ id: RB, kind: "build_app", objective: "[refine] Blue buttons", goal_graph: refineGraph(B, "Blue buttons"), created_at: "2026-09-02T11:00:00Z" }),
        run({ id: UNDO_B, kind: "undo", objective: "[undo] revert bbbbbbb", goal_graph: revertGraph("undo", RB), created_at: "2026-09-02T12:00:00Z" }),
        run({ id: UNDO_R1, kind: "undo", objective: "[undo] revert aaaaaaa", goal_graph: revertGraph("undo", R2), created_at: "2026-09-02T13:00:00Z" }),
        run({ id: RESTORE_ROOT, kind: "undo", objective: "[restore] the original build", goal_graph: revertGraph("restore", A), created_at: "2026-09-02T14:00:00Z" }),
      ],
      error: null,
    });
    const res = mockRes();
    await getAutopilotRefines({ query: { session_id: A } } as never, res as never);
    expect(res.statusCode).toBe(200);
    const body = res.body as {
      refines: Array<{
        id: string;
        message: string;
        kind: string;
        status: string;
        created_at: string;
        parent_conductor_run_id?: string | null;
      }>;
    };
    expect(body.refines.map((r) => r.id)).toEqual([RESTORE_ROOT, UNDO_R1, RESTORE_A, R2, R1]);
    expect(body.refines.map((r) => r.id)).not.toContain(UNDO_B);
    expect(body.refines.map((r) => r.id)).not.toContain(RB);

    const restore = body.refines.find((r) => r.id === RESTORE_A)!;
    expect(restore).toEqual({
      id: RESTORE_A,
      message: "Reverted to Darker hero",
      status: "done",
      failure_message: null,
      no_ship_reason: null,
      awaiting_review: false,
      retry_of: null,
      spend_usd: 0,
      max_usd: 0,
      created_at: "2026-09-01T13:00:00Z",
      updated_at: "2026-09-01T13:00:00Z",
      finished_at: "2026-09-01T13:00:00Z",
      summary: null,
      pr_url: null,
      pr_head_branch: null,
      files: [],
      gate_evidence: null,
      preview_url: null,
      engineer_run_id: null,
      preview_path: null,
      kind: "restore",
      parent_conductor_run_id: R1,
      panel: null,
      draft: false,
    });

    const undo = body.refines.find((r) => r.id === UNDO_R1)!;
    expect(undo.message).toBe("Undid the last change");
    expect(undo.kind).toBe("undo");
    expect(undo.parent_conductor_run_id).toBe(R2);

    const rootRestore = body.refines.find((r) => r.id === RESTORE_ROOT)!;
    expect(rootRestore.message).toBe("Reverted to the original build");
    expect(rootRestore.kind).toBe("restore");
    expect(rootRestore.parent_conductor_run_id).toBe(A);

    for (const id of [R1, R2]) {
      expect(body.refines.find((r) => r.id === id)!.kind).toBe("change");
    }

    const times = body.refines.map((r) => Date.parse(r.created_at));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it("reads undo rows in the same session query, scoped to the tenant and the root's created_at", async () => {
    mocks.sessionRuns.mockResolvedValueOnce({
      data: [run({ id: A, kind: "build_app", objective: "Build product: Acme", goal_graph: freshGraph(), created_at: "2026-09-01T10:00:00Z" })],
      error: null,
    });
    const res = mockRes();
    await getAutopilotRefines({ query: { session_id: A } } as never, res as never);
    expect(res.statusCode).toBe(200);
    expect((res.body as { refines: unknown[] }).refines).toEqual([]);
    expect(lastSessionCalls).toContainEqual(["in", ["kind", ["build_app", "undo"]]]);
    expect(lastSessionCalls).toContainEqual(["eq", ["tenant_id", "tnt-1"]]);
    expect(lastSessionCalls).toContainEqual(["gte", ["created_at", "2026-09-01T10:00:00Z"]]);
  });

  it("keeps a restore of an earlier restore row, and never a restore chained off another session", async () => {
    const RESTORE_2 = "0f1c1a5e-6a6e-4d5a-9a3a-1c0a2b3c4d11";
    const FOREIGN_CHAIN = "0f1c1a5e-6a6e-4d5a-9a3a-1c0a2b3c4d12";
    mocks.sessionRuns.mockResolvedValueOnce({
      data: [
        run({ id: A, kind: "build_app", objective: "Build product: Acme", goal_graph: freshGraph(), created_at: "2026-09-01T10:00:00Z" }),
        run({ id: R1, kind: "build_app", objective: "[refine] Darker hero", goal_graph: refineGraph(A, "Darker hero"), created_at: "2026-09-01T11:00:00Z" }),
        run({ id: RESTORE_A, kind: "undo", objective: "[restore] Darker hero", goal_graph: revertGraph("restore", R1), created_at: "2026-09-01T12:00:00Z" }),
        run({ id: RESTORE_2, kind: "undo", objective: "[restore] Darker hero", goal_graph: revertGraph("restore", RESTORE_A), created_at: "2026-09-01T13:00:00Z" }),
        run({ id: B, kind: "build_app", objective: "Build product: Other", goal_graph: freshGraph(), created_at: "2026-09-02T10:00:00Z" }),
        run({ id: UNDO_B, kind: "undo", objective: "[restore] other", goal_graph: revertGraph("restore", B), created_at: "2026-09-02T11:00:00Z" }),
        run({ id: FOREIGN_CHAIN, kind: "undo", objective: "[restore] other", goal_graph: revertGraph("restore", UNDO_B), created_at: "2026-09-02T12:00:00Z" }),
      ],
      error: null,
    });
    const res = mockRes();
    await getAutopilotRefines({ query: { session_id: A } } as never, res as never);
    const body = res.body as { refines: Array<{ id: string }> };
    expect(body.refines.map((r) => r.id)).toEqual([RESTORE_2, RESTORE_A, R1]);
  });

  it("a revert whose parent is unknown to this session never leaks in", async () => {
    mocks.sessionRuns.mockResolvedValueOnce({
      data: [
        run({ id: A, kind: "build_app", objective: "Build product: Acme", goal_graph: freshGraph(), created_at: "2026-09-01T10:00:00Z" }),
        run({ id: R1, kind: "build_app", objective: "[refine] Darker hero", goal_graph: refineGraph(A, "Darker hero"), created_at: "2026-09-01T11:00:00Z" }),
        run({ id: UNDO_B, kind: "undo", objective: "[undo] revert bbbbbbb", goal_graph: revertGraph("undo", "0f1c1a5e-6a6e-4d5a-9a3a-1c0a2b3c4d99"), created_at: "2026-09-01T12:00:00Z" }),
      ],
      error: null,
    });
    const res = mockRes();
    await getAutopilotRefines({ query: { session_id: A } } as never, res as never);
    const body = res.body as { refines: Array<{ id: string }> };
    expect(body.refines.map((r) => r.id)).toEqual([R1]);
  });
});
