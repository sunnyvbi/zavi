
import { describe, it, expect, vi, beforeEach } from "vitest";
import { BUILD_INTERNAL_FAILURE } from "@zavi/shared";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  sessionsList: vi.fn(),
  rootMaybeSingle: vi.fn(),
  sessionRuns: vi.fn(),
  agentRunsList: vi.fn(),
  statusRunById: vi.fn(),
  statusLatest: vi.fn(),
  latestFresh: vi.fn(),
  resources: vi.fn(),
  ledger: vi.fn(),
}));

vi.mock("@/services/website/site-offline", () => ({ siteIsSuspended: async () => false }));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));

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
  api.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(terminal()).then(resolve, reject);
  api.calls = calls;
  return api as {
    calls: typeof calls;
    select: (...a: unknown[]) => unknown;
  };
}

vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({
    from: (table: string) => {
      if (table === "conductor_runs") {
        lastConductorChain = chain(() => {
          const c = current;
          if (c.mode === "sessions") return mocks.sessionsList();
          if (c.mode === "refines") {
            c.step += 1;
            return c.step === 1 ? mocks.rootMaybeSingle() : mocks.sessionRuns();
          }
          if (c.mode === "status") {
            c.step += 1;
            return c.step === 1
              ? c.byId
                ? mocks.statusRunById()
                : mocks.statusLatest()
              : mocks.latestFresh();
          }
          throw new Error("unexpected conductor_runs read");
        });
        return lastConductorChain;
      }
      if (table === "agent_runs") {
        const c = chain(() => mocks.agentRunsList());
        agentRunChains.push(c);
        return c;
      }
      if (table === "tenant_resources") return chain(() => mocks.resources());
      if (table === "autopilot_action_ledger") return chain(() => mocks.ledger());
      if (table === "tenant_credit_ledger") return chain(() => ({ data: [], error: null }));
      throw new Error(`unexpected table in mock: ${table}`);
    },
  }),
  serviceClient: () => ({
    from: () => chain(() => ({ data: null, error: null })),
    rpc: async () => ({ data: null, error: null }),
  }),
}));

import {
  getAutopilotBuildSessions,
  getAutopilotBuildStatus,
  getAutopilotRefines,
} from "../autopilot";

let lastConductorChain: unknown = null;
const agentRunChains: Array<{ calls: Array<[string, unknown[]]> }> = [];
const agentRunSelects = (): string[] =>
  agentRunChains.flatMap((c) => c.calls.filter(([m]) => m === "select").map(([, a]) => String(a[0])));

const current: { mode: "sessions" | "refines" | "status"; step: number; byId: boolean } = {
  mode: "sessions",
  step: 0,
  byId: false,
};

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

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const R1 = "33333333-3333-4333-8333-333333333333";
const R2 = "44444444-4444-4444-8444-444444444444";

function freshGraph() {
  return [
    { status: "done", payload: { stage: "provision" } },
    { status: "done", payload: { stage: "spec" } },
    { status: "done", payload: { stage: "scaffold" } },
    { status: "done", payload: { stage: "build" } },
    { status: "done", payload: { stage: "qa" } },
    { status: "done", payload: { stage: "deploy" } },
  ];
}

function refineGraph(parent: string | null) {
  return [
    {
      status: "done",
      child_run_id: null,
      payload: {
        stage: "build",
        refine_mode: true,
        ...(parent ? { parent_conductor_run_id: parent } : {}),
      },
    },
  ];
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.requireAuth.mockResolvedValue({
    tenant_id: "tnt-1",
    user_id: "user-1",
    access_token: "tok",
  });
  mocks.resources.mockResolvedValue({ data: [], error: null });
  mocks.ledger.mockResolvedValue({ data: [], error: null });
  mocks.agentRunsList.mockResolvedValue({ data: [], error: null });
  current.step = 0;
  current.byId = false;
  agentRunChains.length = 0;
});

describe("GET /build-sessions", () => {
  beforeEach(() => {
    current.mode = "sessions";
  });

  it("returns early when requireAuth fails", async () => {
    mocks.requireAuth.mockResolvedValueOnce(null);
    const res = mockRes();
    await getAutopilotBuildSessions({ query: {} } as never, res as never);
    expect(mocks.sessionsList).not.toHaveBeenCalled();
  });

  it("groups fresh builds + refines into sessions, newest activity first", async () => {
    mocks.sessionsList.mockResolvedValueOnce({
      data: [
        { id: R1, objective: "[refine] add filters", status: "done", created_at: "2026-09-03T10:00:00Z", updated_at: "2026-09-03T10:00:00Z", refine_mode: "true", parent_id: A },
        { id: B, objective: "Build product: Acme — an analytics dashboard", status: "active", created_at: "2026-09-02T10:00:00Z", updated_at: "2026-09-02T10:00:00Z", refine_mode: null, parent_id: null, p0_stage: "provision", p0_status: "done" },
        { id: A, objective: "Build product: Acme — a CRM", status: "done", created_at: "2026-09-01T10:00:00Z", updated_at: "2026-09-01T10:30:00Z", refine_mode: null, parent_id: null },
      ],
      error: null,
    });
    const res = mockRes();
    await getAutopilotBuildSessions({ query: {} } as never, res as never);
    expect(res.statusCode).toBe(200);
    const body = res.body as {
      sessions: Array<{ id: string; title: string; state: string; refine_count: number; is_current: boolean }>;
      current_session_id: string;
    };
    expect(body.current_session_id).toBe(B);
    expect(body.sessions.map((s) => s.id)).toEqual([A, B]);
    expect(body.sessions[0]).toMatchObject({ title: "CRM", state: "replaced", refine_count: 1, is_current: false });
    expect(body.sessions[1]).toMatchObject({ title: "Analytics dashboard", state: "building", is_current: true });
  });

  it("500s on a read error", async () => {
    mocks.sessionsList.mockResolvedValueOnce({ data: null, error: { message: "boom" } });
    const res = mockRes();
    await getAutopilotBuildSessions({ query: {} } as never, res as never);
    expect(res.statusCode).toBe(500);
  });

  it("fetches newest-first (so the cap drops old builds, never the current one)", async () => {
    mocks.sessionsList.mockResolvedValueOnce({
      data: [
        { id: B, objective: "Build product: Acme — a dashboard", status: "done", created_at: "2026-09-02T10:00:00Z", updated_at: "2026-09-02T10:00:00Z", refine_mode: null, parent_id: null },
        { id: A, objective: "Build product: Acme — a CRM", status: "done", created_at: "2026-09-01T10:00:00Z", updated_at: "2026-09-01T10:00:00Z", refine_mode: null, parent_id: null },
      ],
      error: null,
    });
    const res = mockRes();
    await getAutopilotBuildSessions({ query: {} } as never, res as never);
    const chainCalls = (lastConductorChain as { calls: Array<[string, unknown[]]> }).calls;
    expect(chainCalls).toContainEqual([
      "order",
      ["created_at", { ascending: false }],
    ]);
    const body = res.body as { current_session_id: string; sessions: Array<{ id: string }> };
    expect(body.current_session_id).toBe(B);
    expect(body.sessions.map((x) => x.id)).toEqual([B, A]);
  });

  it("keeps older sites listed when one site's edits fill the 400-run window", async () => {
    const SITE_A = "aaaaaaaa-0000-4000-8000-00000000000a";
    const SITE_B = "bbbbbbbb-0000-4000-8000-00000000000b";
    const OLD = "0f1c1a5e-6a6e-4d5a-9a3a-1c0a2b3c4c00";
    const ROOT_A = "0f1c1a5e-6a6e-4d5a-9a3a-1c0a2b3c4a00";
    const ROOT_B = "0f1c1a5e-6a6e-4d5a-9a3a-1c0a2b3c4b00";
    const rootRow = (id: string, site: string | null, day: string) => ({
      id, objective: `Build product: X — ${id}`, status: "done", created_at: day, updated_at: day,
      refine_mode: null, parent_id: null, s0: site, s1: site, s2: null,
    });
    const window = Array.from({ length: 400 }, (_, i) => {
      const t = new Date(Date.UTC(2026, 9, 1, 12, 0, 400 - i)).toISOString();
      return { id: `edit-${i}`, objective: "[refine] tweak", status: "done", created_at: t, updated_at: t, refine_mode: "true", parent_id: ROOT_B, s0: SITE_B, s1: null, s2: null };
    });
    mocks.sessionsList
      .mockResolvedValueOnce({ data: window, error: null })
      .mockResolvedValueOnce({
        data: [
          rootRow(ROOT_B, SITE_B, "2026-09-30T00:00:00Z"),
          rootRow(ROOT_A, SITE_A, "2026-09-20T00:00:00Z"),
          rootRow(OLD, null, "2026-09-10T00:00:00Z"),
        ],
        error: null,
      });
    const res = mockRes();
    await getAutopilotBuildSessions({ query: {} } as never, res as never);
    expect(res.statusCode).toBe(200);
    const ids = (res.body as { sessions: Array<{ id: string }> }).sessions.map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining([ROOT_A, ROOT_B, OLD]));
    const chainCalls = (lastConductorChain as { calls: Array<[string, unknown[]]> }).calls;
    expect(chainCalls.some(([m, a]) => m === "or" && String(a[0]).includes("refine_mode"))).toBe(true);
  });

  it("a workspace under the window makes no extra read", async () => {
    mocks.sessionsList.mockResolvedValueOnce({
      data: [{ id: A, objective: "Build product: Acme — a CRM", status: "done", created_at: "2026-09-01T10:00:00Z", updated_at: "2026-09-01T10:00:00Z", refine_mode: null, parent_id: null }],
      error: null,
    });
    const res = mockRes();
    await getAutopilotBuildSessions({ query: {} } as never, res as never);
    expect(mocks.sessionsList).toHaveBeenCalledTimes(1);
  });
});

describe("GET /refines?session_id=", () => {
  beforeEach(() => {
    current.mode = "refines";
  });

  it("400s on a non-uuid session id without touching the DB", async () => {
    const res = mockRes();
    await getAutopilotRefines({ query: { session_id: "nope" } } as never, res as never);
    expect(res.statusCode).toBe(400);
    expect(mocks.rootMaybeSingle).not.toHaveBeenCalled();
  });

  it("404s when the session root is not owned by the tenant", async () => {
    mocks.rootMaybeSingle.mockResolvedValueOnce({ data: null, error: null });
    const res = mockRes();
    await getAutopilotRefines({ query: { session_id: A } } as never, res as never);
    expect(res.statusCode).toBe(404);
    expect(mocks.sessionRuns).not.toHaveBeenCalled();
  });

  it("returns only the refines attributed to the session, newest first", async () => {
    mocks.rootMaybeSingle.mockResolvedValueOnce({
      data: { id: A, created_at: "2026-09-01T10:00:00Z" },
      error: null,
    });
    mocks.sessionRuns.mockResolvedValueOnce({
      data: [
        { id: A, objective: "Build product: Acme — a CRM", status: "done", goal_graph: freshGraph(), spend_usd: 1, max_usd: 20, created_at: "2026-09-01T10:00:00Z", updated_at: "2026-09-01T10:00:00Z" },
        { id: R1, objective: "[refine] legacy refine, no parent", status: "done", goal_graph: refineGraph(null), spend_usd: 1, max_usd: 5, created_at: "2026-09-01T11:00:00Z", updated_at: "2026-09-01T11:00:00Z" },
        { id: B, objective: "Build product: Acme — a dashboard", status: "done", goal_graph: freshGraph(), spend_usd: 1, max_usd: 20, created_at: "2026-09-02T10:00:00Z", updated_at: "2026-09-02T10:00:00Z" },
        { id: R2, objective: "[refine] explicit parent A", status: "active", goal_graph: refineGraph(A), spend_usd: 1, max_usd: 5, created_at: "2026-09-02T11:00:00Z", updated_at: "2026-09-02T11:00:00Z" },
      ],
      error: null,
    });
    const res = mockRes();
    await getAutopilotRefines({ query: { session_id: A } } as never, res as never);
    expect(res.statusCode).toBe(200);
    const body = res.body as { refines: Array<{ id: string; message: string }> };
    expect(body.refines.map((r) => r.id)).toEqual([R2, R1]);
    expect(body.refines[1].message).toBe("legacy refine, no parent");
  });
});

describe("GET /build-status?run_id=", () => {
  beforeEach(() => {
    current.mode = "status";
  });

  it("400s on a non-uuid run id", async () => {
    const res = mockRes();
    await getAutopilotBuildStatus({ query: { run_id: "nope" } } as never, res as never);
    expect(res.statusCode).toBe(400);
  });

  it("404s when the run is unknown (never falls back to the latest build)", async () => {
    current.byId = true;
    mocks.statusRunById.mockResolvedValueOnce({ data: [], error: null });
    const res = mockRes();
    await getAutopilotBuildStatus({ query: { run_id: A } } as never, res as never);
    expect(res.statusCode).toBe(404);
    expect(mocks.statusLatest).not.toHaveBeenCalled();
  });

  it("reports a superseded session with no preview and no live url", async () => {
    current.byId = true;
    mocks.statusRunById.mockResolvedValueOnce({
      data: [{ id: A, objective: "Build product: Acme — a CRM", status: "done", goal_graph: freshGraph(), spend_usd: 1, max_usd: 20, created_at: "2026-09-01T10:00:00Z", updated_at: "2026-09-01T10:30:00Z" }],
      error: null,
    });
    mocks.latestFresh.mockResolvedValueOnce({
      data: [{ id: B, status: "done", goal_graph: freshGraph() }],
      error: null,
    });
    mocks.resources.mockResolvedValueOnce({
      data: [{ resource_kind: "hosting", status: "ready", external_ref: { url: "https://acme.onrender.com" } }],
      error: null,
    });
    const res = mockRes();
    await getAutopilotBuildStatus({ query: { run_id: A } } as never, res as never);
    expect(res.statusCode).toBe(200);
    const body = res.body as {
      run: { id: string; stages: Array<{ stage: string; status: string }> };
      target: { live_url: string | null };
      preview: { kind: string; url: string | null };
      is_current: boolean;
    };
    expect(body.run.id).toBe(A);
    expect(body.run.stages).toHaveLength(4);
    expect(body.is_current).toBe(false);
    expect(body.target.live_url).toBeNull();
    expect(body.preview).toEqual({ url: null, kind: "none" });
  });

  it("fails closed (is_current=false, no urls) when the current build is unreadable", async () => {
    current.byId = true;
    mocks.statusRunById.mockResolvedValueOnce({
      data: [{ id: A, objective: "Build product: Acme — a CRM", status: "done", goal_graph: freshGraph(), spend_usd: 1, max_usd: 20, created_at: "2026-09-01T10:00:00Z", updated_at: "2026-09-01T10:30:00Z" }],
      error: null,
    });
    mocks.latestFresh.mockResolvedValueOnce({ data: null, error: { message: "db down" } });
    mocks.resources.mockResolvedValueOnce({
      data: [{ resource_kind: "hosting", status: "ready", external_ref: { url: "https://acme.onrender.com" } }],
      error: null,
    });
    const res = mockRes();
    await getAutopilotBuildStatus({ query: { run_id: A } } as never, res as never);
    expect(res.statusCode).toBe(200);
    const body = res.body as {
      target: { live_url: string | null };
      preview: { url: string | null };
      is_current: boolean;
    };
    expect(body.is_current).toBe(false);
    expect(body.target.live_url).toBeNull();
    expect(body.preview.url).toBeNull();
  });

  it("keeps the current session live-capable", async () => {
    current.byId = true;
    mocks.statusRunById.mockResolvedValueOnce({
      data: [{ id: B, objective: "Build product: Acme — a dashboard", status: "done", goal_graph: freshGraph(), spend_usd: 1, max_usd: 20, created_at: "2026-09-02T10:00:00Z", updated_at: "2026-09-02T10:30:00Z" }],
      error: null,
    });
    mocks.latestFresh.mockResolvedValueOnce({
      data: [{ id: B, status: "done", goal_graph: freshGraph() }],
      error: null,
    });
    mocks.resources.mockResolvedValueOnce({
      data: [{ resource_kind: "hosting", status: "ready", external_ref: { url: "https://acme.onrender.com" } }],
      error: null,
    });
    const res = mockRes();
    await getAutopilotBuildStatus({ query: { run_id: B } } as never, res as never);
    expect(res.statusCode).toBe(200);
    const body = res.body as { target: { live_url: string | null }; is_current: boolean };
    expect(body.is_current).toBe(true);
    expect(body.target.live_url).toBe("https://acme.onrender.com");
  });

  it("issues every read that needs only the build row before any of them answers", async () => {
    current.byId = true;
    const graph = freshGraph().map((node, i) => (i === 3 ? { ...node, child_run_id: R1 } : node));
    mocks.statusRunById.mockResolvedValueOnce({
      data: [{ id: B, objective: "Build product: Acme — a dashboard", status: "done", goal_graph: graph, spend_usd: 1, max_usd: 20, created_at: "2026-09-02T10:00:00Z", updated_at: "2026-09-02T10:30:00Z" }],
      error: null,
    });
    const gates: Array<() => void> = [];
    const held = <T,>(value: T) => () =>
      new Promise<T>((resolve) => {
        gates.push(() => resolve(value));
      });
    mocks.resources.mockImplementationOnce(
      held({ data: [{ resource_kind: "hosting", status: "ready", external_ref: { url: "https://acme.onrender.com" } }], error: null }),
    );
    mocks.agentRunsList
      .mockImplementationOnce(held({ data: [{ id: R1, agent_slug: "engineer", status: "success" }], error: null }));
    mocks.ledger.mockImplementationOnce(held({ data: [], error: null }));
    mocks.latestFresh.mockImplementationOnce(held({ data: [{ id: B, status: "done", goal_graph: freshGraph() }], error: null }));

    const res = mockRes();
    const pending = getAutopilotBuildStatus({ query: { run_id: B } } as never, res as never);
    for (let i = 0; i < 20; i += 1) await Promise.resolve();

    expect(mocks.resources).toHaveBeenCalledTimes(1);
    expect(mocks.agentRunsList).toHaveBeenCalledTimes(1);
    expect(mocks.ledger).toHaveBeenCalledTimes(1);
    expect(mocks.latestFresh).toHaveBeenCalledTimes(1);
    expect(gates).toHaveLength(4);
    expect(res.body).toBeUndefined();

    for (const open of gates.reverse()) open();
    await pending;
    expect(res.statusCode).toBe(200);
    const body = res.body as {
      run: { used_usd: number | null; used_credits: number | null; stages: Array<{ stage: string; agent_status: string | null }> };
      target: { live_url: string | null };
      is_current: boolean;
    };
    expect(body.is_current).toBe(true);
    expect(body.target.live_url).toBe("https://acme.onrender.com");
    expect(body.run.used_usd).toBeNull();
    expect(body.run.used_credits).toBeNull();
    expect(body.run.stages.find((s) => s.stage === "build")?.agent_status).toBe("success");
  });

  it("reads child runs without output_text while nothing failed", async () => {
    current.byId = true;
    const graph = freshGraph().map((node, i) => (i === 3 ? { ...node, status: "running", child_run_id: R1 } : node));
    mocks.statusRunById.mockResolvedValueOnce({
      data: [{ id: B, objective: "Build product: Acme", status: "active", goal_graph: graph, spend_usd: 1, max_usd: 20, created_at: "2026-09-02T10:00:00Z", updated_at: "2026-09-02T10:30:00Z" }],
      error: null,
    });
    mocks.latestFresh.mockResolvedValueOnce({ data: [{ id: B, status: "active", goal_graph: graph }], error: null });
    mocks.agentRunsList.mockResolvedValueOnce({ data: [{ id: R1, agent_slug: "engineer", status: "running" }], error: null });
    const res = mockRes();
    await getAutopilotBuildStatus({ query: { run_id: B } } as never, res as never);
    expect(res.statusCode).toBe(200);
    expect(mocks.agentRunsList).toHaveBeenCalledTimes(1);
    expect(agentRunSelects().some((cols) => cols.includes("output_text"))).toBe(false);
  });

  it("fetches output_text only for a failed child that left no error, and uses it as the failure", async () => {
    current.byId = true;
    const graph = freshGraph().map((node, i) =>
      i === 2 ? { ...node, child_run_id: R2 } : i === 3 ? { ...node, status: "failed", child_run_id: R1 } : node,
    );
    mocks.statusRunById.mockResolvedValueOnce({
      data: [{ id: B, objective: "Build product: Acme", status: "failed", goal_graph: graph, spend_usd: 1, max_usd: 20, created_at: "2026-09-02T10:00:00Z", updated_at: "2026-09-02T10:30:00Z" }],
      error: null,
    });
    mocks.latestFresh.mockResolvedValueOnce({ data: [{ id: B, status: "failed", goal_graph: graph }], error: null });
    mocks.agentRunsList
      .mockResolvedValueOnce({
        data: [
          { id: R1, agent_slug: "engineer", status: "failed", error: null, parse_error: null },
          { id: R2, agent_slug: "engineer", status: "success" },
        ],
        error: null,
      })
      .mockResolvedValueOnce({ data: [{ id: R1, output_text: "npm run build exited 1" }], error: null });
    const res = mockRes();
    await getAutopilotBuildStatus({ query: { run_id: B } } as never, res as never);
    expect(res.statusCode).toBe(200);
    expect(mocks.agentRunsList).toHaveBeenCalledTimes(2);
    expect(agentRunSelects().filter((cols) => cols.includes("output_text"))).toEqual(["id, output_text"]);
    const outputRead = agentRunChains.find((c) => c.calls.some(([m, a]) => m === "select" && a[0] === "id, output_text"));
    expect(outputRead?.calls.find(([m]) => m === "in")?.[1]).toEqual(["id", [R1]]);
    const body = res.body as {
      run: { failure: { message: string; code: string; class: string } | null; stages: Array<{ stage: string; error: string | null }> };
    };
    expect(body.run.failure?.code).toBe("internal");
    expect(body.run.failure?.message).toBe(BUILD_INTERNAL_FAILURE);
    expect(body.run.failure?.class).toBe("stage_failed");
    expect(JSON.stringify(body)).not.toContain("npm run build exited 1");
    expect(body.run.stages.find((s) => s.stage === "build")?.error).toBe(BUILD_INTERNAL_FAILURE);
  });

  it("reuses the tenant build's usage for a few seconds instead of re-reading costs every poll", async () => {
    current.byId = false;
    const C = "55555555-5555-4555-8555-555555555555";
    const row = { id: C, objective: "Build product: Acme", status: "active", goal_graph: freshGraph(), spend_usd: 1, max_usd: 20, created_at: "2026-09-02T10:00:00Z", updated_at: "2026-09-02T10:30:00Z" };
    mocks.statusLatest.mockResolvedValue({ data: [row], error: null });
    mocks.latestFresh.mockResolvedValue({ data: [{ id: C, status: "active", goal_graph: freshGraph() }], error: null });
    mocks.agentRunsList.mockResolvedValue({ data: [{ id: "cost-1", cost_usd: 0.42 }], error: null });
    const first = mockRes();
    await getAutopilotBuildStatus({ query: {} } as never, first as never);
    current.step = 0;
    const second = mockRes();
    await getAutopilotBuildStatus({ query: {} } as never, second as never);
    const costReads = agentRunSelects().filter((cols) => cols === "id, cost_usd");
    expect(costReads).toHaveLength(1);
    expect((first.body as { run: { used_usd: number } }).run.used_usd).toBeCloseTo(0.42);
    expect((second.body as { run: { used_usd: number } }).run.used_usd).toBeCloseTo(0.42);
  });

  describe("early Render preview during a build", () => {
    const inFlight = (scaffold: string) => [
      { status: "done", payload: { stage: "provision" } },
      { status: "done", payload: { stage: "spec" } },
      { status: scaffold, payload: { stage: "scaffold" } },
      { status: "pending", payload: { stage: "build" } },
      { status: "pending", payload: { stage: "deploy" } },
    ];
    const probe = vi.fn(async () => ({ status: 200 }));

    beforeEach(async () => {
      const { __resetEarlyProbeCache } = await import("../autopilot");
      __resetEarlyProbeCache();
      probe.mockClear();
      vi.stubGlobal("fetch", probe);
    });

    async function statusFor(scaffold: string, hostingCreatedAt: string) {
      current.byId = true;
      const run = {
        id: B,
        objective: "Build product: Spoke — a bike rental landing page",
        status: "active",
        goal_graph: inFlight(scaffold),
        spend_usd: 1,
        max_usd: 20,
        created_at: "2026-09-28T05:41:51Z",
        updated_at: "2026-09-28T05:49:00Z",
      };
      mocks.statusRunById.mockResolvedValueOnce({ data: [run], error: null });
      mocks.latestFresh.mockResolvedValueOnce({
        data: [{ id: B, status: "active", goal_graph: inFlight(scaffold), created_at: run.created_at }],
        error: null,
      });
      mocks.resources.mockResolvedValueOnce({
        data: [
          {
            resource_kind: "hosting",
            status: "ready",
            external_ref: { url: "https://acme.onrender.com" },
            created_at: hostingCreatedAt,
            updated_at: "2026-09-28T05:45:06Z",
          },
        ],
        error: null,
      });
      const res = mockRes();
      await getAutopilotBuildStatus({ query: { run_id: B } } as never, res as never);
      expect(res.statusCode).toBe(200);
      return (res.body as { preview: { url: string | null; kind: string } }).preview;
    }

    it("does not frame the previous build's app on a Render service that predates this build", async () => {
      const preview = await statusFor("done", "2026-09-24T06:55:44Z");
      expect(preview).toEqual({ url: null, kind: "none" });
      expect(probe).not.toHaveBeenCalled();
    });

    it("waits for the app structure before framing a Render service this build created", async () => {
      const preview = await statusFor("running", "2026-09-28T05:42:30Z");
      expect(preview).toEqual({ url: null, kind: "none" });
      expect(probe).not.toHaveBeenCalled();
    });

    it("frames this build's own Render service once the scaffold is done and serving", async () => {
      const preview = await statusFor("done", "2026-09-28T05:42:30Z");
      expect(preview).toEqual({ url: "https://acme.onrender.com", kind: "early" });
      expect(probe).toHaveBeenCalledWith("https://acme.onrender.com", expect.anything());
    });
  });
});
