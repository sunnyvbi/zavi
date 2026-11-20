import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  statusRun: vi.fn(),
  latestFresh: vi.fn(),
  sessionsList: vi.fn(),
  resources: vi.fn(),
  sandboxRow: vi.fn(),
  rpc: vi.fn(),
  kick: vi.fn(),
  selects: [] as string[],
  smokeGate: false as boolean | Error,
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/services/agents/conductor-driver", () => ({ kickSandboxPreview: mocks.kick }));
vi.mock("@/services/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/settings")>();
  return {
    ...actual,
    getBoolSetting: async (key: string, tenant?: string | null) => {
      if (key !== "build_smoke_gate") return actual.getBoolSetting(key as never, tenant);
      if (mocks.smokeGate instanceof Error) throw mocks.smokeGate;
      return mocks.smokeGate;
    },
  };
});

function chain(terminal: () => unknown) {
  const api: Record<string, unknown> = {};
  const self = () => api;
  for (const m of ["eq", "in", "is", "or", "gte", "order", "not"]) api[m] = self;
  api.select = (cols: string) => {
    mocks.selects.push(String(cols));
    return api;
  };
  api.limit = () => terminal();
  api.maybeSingle = () => terminal();
  api.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(terminal()).then(resolve, reject);
  return api;
}

let conductorStep = 0;
let mode: "status" | "sessions" = "status";

vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({
    from: (table: string) => {
      if (table === "conductor_runs") {
        return chain(() => {
          if (mode === "sessions") return mocks.sessionsList();
          conductorStep += 1;
          return conductorStep === 1 ? mocks.statusRun() : mocks.latestFresh();
        });
      }
      if (table === "agent_runs") return chain(() => ({ data: [], error: null }));
      if (table === "tenant_resources") return chain(() => mocks.resources());
      if (table === "autopilot_action_ledger") return chain(() => ({ data: [], error: null }));
      if (table === "tenant_credit_ledger") return chain(() => ({ data: [], error: null }));
      throw new Error(`unexpected table ${table}`);
    },
  }),
  serviceClient: () => ({
    from: (table: string) => {
      if (table === "tenant_sandbox") return chain(() => mocks.sandboxRow());
      return chain(() => ({ data: null, error: null }));
    },
    rpc: async (fn: string, args: unknown) => {
      mocks.rpc(fn, args);
      return { data: null, error: null };
    },
  }),
}));

import { getAutopilotBuildStatus, getAutopilotBuildSessions } from "../autopilot";
import { __resetPublishPreviewKicks } from "@/services/build/app-ready";

function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(c: number) {
      res.statusCode = c;
      return res;
    },
    json(b: unknown) {
      res.body = b;
      return res;
    },
  };
  return res;
}

const RUN = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ENQ = Date.parse("2026-09-29T10:00:00.000Z");
const HOSTING = "https://acme.onrender.com";

type Body = {
  app_ready: boolean;
  publish: { status: string; started_at: string | null; url: string | null; retryable: boolean };
  is_current: boolean;
};

function graph(build: string, deploy: string, deployExtra: Record<string, unknown> = {}) {
  return [
    { status: "done", payload: { stage: "provision" } },
    { status: "done", payload: { stage: "spec" } },
    { status: "done", payload: { stage: "scaffold" } },
    { status: build, payload: { stage: "build" } },
    { status: deploy, ...deployExtra, payload: { stage: "deploy", deploy_enqueued_at: ENQ } },
  ];
}

function runRow(status: string, g: unknown, failure_class: string | null = null, paused_at: string | null = null) {
  return {
    id: RUN,
    objective: "Build product: Acme — a CRM",
    status,
    failure_class,
    paused_at,
    goal_graph: g,
    spend_usd: 1,
    max_usd: 20,
    created_at: "2026-09-29T09:00:00Z",
    updated_at: "2026-09-29T10:00:00Z",
  };
}

let sandboxSeq = 0;
function sandbox(status: string | null) {
  sandboxSeq += 1;
  return {
    data: { id: "sb-1", preview_url: `https://3000-sb${sandboxSeq}.e2b.app`, preview_status: status, preview_port: 3000 },
    error: null,
  };
}

let fetchStatus = 200;
const flush = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
};

async function call(query: Record<string, string> = {}) {
  conductorStep = 0;
  const res = mockRes();
  await getAutopilotBuildStatus({ query } as never, res as never);
  await flush();
  return res;
}

beforeEach(() => {
  for (const k of ["requireAuth", "statusRun", "latestFresh", "sessionsList", "resources", "sandboxRow", "rpc", "kick"] as const) {
    mocks[k].mockReset();
  }
  mocks.selects.length = 0;
  mocks.smokeGate = false;
  mode = "status";
  __resetPublishPreviewKicks();
  mocks.requireAuth.mockResolvedValue({ tenant_id: "tnt-1", user_id: "u-1", access_token: "tok" });
  mocks.latestFresh.mockResolvedValue({ data: [{ id: RUN, status: "active", goal_graph: [], created_at: "2026-09-29T09:00:00Z" }], error: null });
  mocks.resources.mockResolvedValue({
    data: [
      { resource_kind: "repo", status: "ready", external_ref: { repo_url: "https://github.com/acme/app" } },
      { resource_kind: "hosting", status: "ready", external_ref: { url: HOSTING }, created_at: "2026-09-29T09:30:00Z" },
      { resource_kind: "domain", status: "ready", external_ref: { hostname: "acme.zaviagent.com", status: "live" } },
    ],
    error: null,
  });
  mocks.sandboxRow.mockResolvedValue({ data: null, error: null });
  fetchStatus = 200;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ status: fetchStatus, text: async () => "<html></html>" })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("GET /build-status — app_ready + publish", () => {
  it("reads failure_class off the run row", async () => {
    mocks.statusRun.mockResolvedValue({ data: [runRow("active", graph("done", "pending"))], error: null });
    await call();
    expect(mocks.selects[0]).toContain("failure_class");
    expect(mocks.selects[0]).toContain("paused_at");
  });

  it("paused deploy_failed inside the continue window: retryable true", async () => {
    mocks.statusRun.mockResolvedValue({
      data: [runRow("paused", graph("done", "failed", { failure_class: "deploy_failed" }), "deploy_failed", new Date(Date.now() - 3600_000).toISOString())],
      error: null,
    });
    const body = (await call()).body as Body;
    expect(body.publish).toMatchObject({ status: "failed", retryable: true });
  });

  it("paused deploy_failed but paused 8 days ago: retryable false", async () => {
    mocks.statusRun.mockResolvedValue({
      data: [runRow("paused", graph("done", "failed", { failure_class: "deploy_failed" }), "deploy_failed", new Date(Date.now() - 8 * 86400_000).toISOString())],
      error: null,
    });
    const body = (await call()).body as Body;
    expect(body.publish).toMatchObject({ status: "failed", retryable: false });
  });

  it("status write not landed yet (active, deploy node done): still publishing, app_ready true", async () => {
    mocks.statusRun.mockResolvedValue({ data: [runRow("active", graph("done", "done"))], error: null });
    const body = (await call()).body as Body;
    expect(body.app_ready).toBe(true);
    expect(body.publish.status).toBe("publishing");
  });

  it("status write not landed yet (active, deploy node failed): still publishing, app_ready true", async () => {
    mocks.statusRun.mockResolvedValue({ data: [runRow("active", graph("done", "failed", { failure_class: "deploy_failed" }))], error: null });
    const body = (await call()).body as Body;
    expect(body.app_ready).toBe(true);
    expect(body.publish.status).toBe("publishing");
  });

  it("build done + deploy pending: app_ready true, publishing, started_at + domain url", async () => {
    mocks.statusRun.mockResolvedValue({ data: [runRow("active", graph("done", "pending"))], error: null });
    const res = await call();
    const body = res.body as Body;
    expect(body.app_ready).toBe(true);
    expect(body.publish).toEqual({
      status: "publishing",
      started_at: "2026-09-29T10:00:00.000Z",
      url: "https://acme.zaviagent.com",
      retryable: false,
    });
  });

  it("still building: app_ready false, publish none, no kick", async () => {
    mocks.statusRun.mockResolvedValue({ data: [runRow("active", graph("dispatched", "pending"))], error: null });
    const res = await call();
    const body = res.body as Body;
    expect(body.app_ready).toBe(false);
    expect(body.publish).toEqual({ status: "none", started_at: null, url: null, retryable: false });
    expect(mocks.kick).not.toHaveBeenCalled();
  });

  it("run done: app_ready false, publish live, no kick", async () => {
    mocks.statusRun.mockResolvedValue({ data: [runRow("done", graph("done", "done"))], error: null });
    const res = await call();
    const body = res.body as Body;
    expect(body.app_ready).toBe(false);
    expect(body.publish.status).toBe("live");
    expect(body.publish.url).toBe("https://acme.zaviagent.com");
    expect(mocks.kick).not.toHaveBeenCalled();
  });

  it("paused deploy_failed: app still ready, publish failed, no kick", async () => {
    mocks.statusRun.mockResolvedValue({
      data: [runRow("paused", graph("done", "failed", { failure_class: "deploy_failed" }), "deploy_failed")],
      error: null,
    });
    const res = await call();
    const body = res.body as Body;
    expect(body.app_ready).toBe(true);
    expect(body.publish.status).toBe("failed");
    expect(mocks.kick).not.toHaveBeenCalled();
  });

  it("superseded session: both fields present, none", async () => {
    mocks.statusRun.mockResolvedValue({ data: [runRow("active", graph("done", "pending"))], error: null });
    mocks.latestFresh.mockResolvedValue({ data: [{ id: OTHER, status: "active", goal_graph: [] }], error: null });
    const res = await call({ run_id: RUN });
    const body = res.body as Body;
    expect(body.is_current).toBe(false);
    expect(body.app_ready).toBe(false);
    expect(body.publish).toEqual({ status: "none", started_at: null, url: null, retryable: false });
    expect(mocks.kick).not.toHaveBeenCalled();
  });
});

describe("GET /build-status — newer builds that failed at provisioning never replaced the live app", () => {
  const FAILED_A = "33333333-3333-4333-8333-333333333333";
  const FAILED_B = "44444444-4444-4444-8444-444444444444";
  const provFailed = (id: string) => ({ id, status: "failed", failure_class: "provision_failed", goal_graph: [] });

  it("the live build stays current, with its live address", async () => {
    mocks.statusRun.mockResolvedValue({ data: [runRow("done", graph("done", "done"))], error: null });
    mocks.latestFresh.mockResolvedValue({
      data: [provFailed(FAILED_B), provFailed(FAILED_A), { id: RUN, status: "done", failure_class: null, goal_graph: [] }],
      error: null,
    });
    const body = (await call({ run_id: RUN })).body as Body & { target: { live_url: string | null } };
    expect(body.is_current).toBe(true);
    expect(body.target.live_url).not.toBeNull();
  });

  it("the newest failed-at-provisioning build is current too, so it is not told a newer build replaced it", async () => {
    mocks.statusRun.mockResolvedValue({ data: [{ ...runRow("failed", graph("pending", "pending"), "provision_failed"), id: FAILED_B }], error: null });
    mocks.latestFresh.mockResolvedValue({
      data: [provFailed(FAILED_B), provFailed(FAILED_A), { id: RUN, status: "done", failure_class: null, goal_graph: [] }],
      error: null,
    });
    expect(((await call({ run_id: FAILED_B })).body as Body).is_current).toBe(true);
  });

  it("an older failed-at-provisioning build is not current", async () => {
    mocks.statusRun.mockResolvedValue({ data: [{ ...runRow("failed", graph("pending", "pending"), "provision_failed"), id: FAILED_A }], error: null });
    mocks.latestFresh.mockResolvedValue({
      data: [provFailed(FAILED_B), provFailed(FAILED_A), { id: RUN, status: "done", failure_class: null, goal_graph: [] }],
      error: null,
    });
    expect(((await call({ run_id: FAILED_A })).body as Body).is_current).toBe(false);
  });

  it("a newer build that got past provisioning, even cancelled, still replaces it", async () => {
    mocks.statusRun.mockResolvedValue({ data: [runRow("done", graph("done", "done"))], error: null });
    mocks.latestFresh.mockResolvedValue({
      data: [
        { id: OTHER, status: "failed", failure_class: "user_cancelled", goal_graph: [{ status: "done", payload: { stage: "provision" } }] },
        { id: RUN, status: "done", failure_class: null, goal_graph: [] },
      ],
      error: null,
    });
    expect(((await call({ run_id: RUN })).body as Body).is_current).toBe(false);
  });

  it.each(["user_cancelled", "stale_reaped", "unknown"])(
    "a newer build stopped as %s before its provision step finished never replaced it",
    async (failure_class) => {
      mocks.statusRun.mockResolvedValue({ data: [runRow("done", graph("done", "done"))], error: null });
      mocks.latestFresh.mockResolvedValue({
        data: [{ id: OTHER, status: "failed", failure_class, goal_graph: [] }, { id: RUN, status: "done", failure_class: null, goal_graph: [] }],
        error: null,
      });
      const body = (await call({ run_id: RUN })).body as Body & { target: { live_url: string | null } };
      expect(body.is_current).toBe(true);
      expect(body.target.live_url).not.toBeNull();
    },
  );

  it.each([
    ["after its provision step finished replaced the app, so the finished build claims no live address", true, false],
    ["before its provision step finished never replaced it, so the finished build keeps its live address", false, true],
  ])("under a newer site build, an old-flow build stopped %s", async (_name, provisioned, current) => {
    const SITE_RUN = "55555555-5555-4555-8555-555555555555";
    const SITE = "66666666-6666-4666-8666-666666666666";
    const oldFlow = [
      { id: OTHER, status: "failed", failure_class: "stale_reaped", created_at: "2026-09-29T11:00:00Z", p0_stage: provisioned ? "provision" : null, p0_status: provisioned ? "done" : null, s0: null, s1: null, s2: null },
      { id: RUN, status: "done", failure_class: null, created_at: "2026-09-29T09:00:00Z", p0_stage: "provision", p0_status: "done", s0: null, s1: null, s2: null },
    ];
    mocks.statusRun.mockResolvedValue({ data: [runRow("done", graph("done", "done"))], error: null });
    mocks.latestFresh
      .mockResolvedValueOnce({
        data: [{ id: SITE_RUN, status: "done", failure_class: null, goal_graph: [{ status: "done", payload: { stage: "provision", site_id: SITE } }], created_at: "2026-09-29T12:00:00Z" }],
        error: null,
      })
      .mockImplementationOnce(async () => {
        const cols = mocks.selects[mocks.selects.length - 1].split(",").map((c) => c.trim().split(":")[0]);
        return { data: oldFlow.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => cols.includes(k)))), error: null };
      });
    const body = (await call({ run_id: RUN })).body as Body & { target: { live_url: string | null } };
    expect(body.is_current).toBe(current);
    expect(body.target.live_url === null).toBe(!current);
  });
});

describe("GET /build-status — preview comes back during publishing", () => {
  beforeEach(() => {
    mocks.statusRun.mockResolvedValue({ data: [runRow("active", graph("done", "pending"))], error: null });
  });

  it("no sandbox preview row: kicks exactly once across repeated polls inside the window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-29T10:05:00Z"));
    await call();
    await call();
    await call();
    expect(mocks.kick).toHaveBeenCalledTimes(1);
    expect(mocks.kick).toHaveBeenCalledWith({
      tenant_id: "tnt-1",
      node: { payload: { target: { github_full_name: "acme/app" } } },
    });
    vi.setSystemTime(new Date("2026-09-29T10:05:59Z"));
    await call();
    expect(mocks.kick).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date("2026-09-29T10:06:01Z"));
    await call();
    expect(mocks.kick).toHaveBeenCalledTimes(2);
  });

  it("row says live but the probe finds it dead: clears the row and kicks once", async () => {
    fetchStatus = 502;
    mocks.sandboxRow.mockImplementation(async () => sandbox("live"));
    await call();
    await call();
    expect(mocks.rpc).toHaveBeenCalledWith("clear_sandbox_preview", { p_id: "sb-1", p_final_status: "dead" });
    expect(mocks.kick).toHaveBeenCalledTimes(1);
  });

  it("dead row status: kicks", async () => {
    mocks.sandboxRow.mockImplementation(async () => sandbox("dead"));
    await call();
    expect(mocks.kick).toHaveBeenCalledTimes(1);
  });

  it("live and serving: no kick", async () => {
    mocks.sandboxRow.mockImplementation(async () => sandbox("live"));
    const res = await call();
    expect((res.body as { preview: { kind: string } }).preview.kind).toBe("instant");
    expect(mocks.kick).not.toHaveBeenCalled();
  });

  it("starting: no kick (a boot is already in flight)", async () => {
    mocks.sandboxRow.mockImplementation(async () => sandbox("starting"));
    await call();
    expect(mocks.kick).not.toHaveBeenCalled();
  });

  it("dedupe is per run: another run still gets its kick", async () => {
    await call();
    mocks.statusRun.mockResolvedValue({ data: [{ ...runRow("active", graph("done", "pending")), id: OTHER }], error: null });
    mocks.latestFresh.mockResolvedValue({ data: [{ id: OTHER, status: "active", goal_graph: [] }], error: null });
    await call();
    expect(mocks.kick).toHaveBeenCalledTimes(2);
  });

  it("kick that throws never breaks the status read", async () => {
    mocks.kick.mockImplementation(() => {
      throw new Error("boom");
    });
    const res = await call();
    expect(res.statusCode).toBe(200);
    expect((res.body as Body).publish.status).toBe("publishing");
  });
});

describe("GET /build-sessions — publishing statuses", () => {
  it("reads the slot columns, reports publishing for the current build and never publish_failed for a superseded one", async () => {
    mode = "sessions";
    mocks.sessionsList.mockResolvedValue({
      data: [
        { id: OTHER, objective: "Build product: Acme — a dashboard", status: "active", created_at: "2026-09-02T10:00:00Z", updated_at: "2026-09-02T10:00:00Z", refine_mode: null, parent_id: null, failure_class: null, g3_stage: "build", g3_status: "done", g4_stage: "deploy", g4_status: "pending", p0_stage: "provision", p0_status: "done" },
        { id: RUN, objective: "Build product: Acme — a CRM", status: "paused", created_at: "2026-09-01T10:00:00Z", updated_at: "2026-09-01T10:00:00Z", refine_mode: null, parent_id: null, failure_class: "deploy_failed", g3_stage: "build", g3_status: "done", g4_stage: "deploy", g4_status: "failed", p0_stage: "provision", p0_status: "done" },
      ],
      error: null,
    });
    const res = mockRes();
    await getAutopilotBuildSessions({ query: {} } as never, res as never);
    const body = res.body as { sessions: Array<{ id: string; state: string }> };
    expect(new Map(body.sessions.map((s) => [s.id, s.state]))).toEqual(
      new Map([
        [OTHER, "publishing"],
        [RUN, "failed"],
      ]),
    );
    expect(mocks.selects[0]).toContain("g3_status:goal_graph->3->>status");
    expect(mocks.selects[0]).toContain("failure_class");
    expect(mocks.selects[0]).toContain("p0_stage:goal_graph->0->payload->>stage");
    expect(mocks.selects[0]).toContain("p1_status:goal_graph->1->>status");
  });
});

describe("GET /build-status — build_smoke_gate holds 'Your app is ready' until the live smoke passes (DEL-1323 B2)", () => {
  it("deploy pending or being acceptance-repaired: app_ready false, still reported as publishing, preview kick unchanged", async () => {
    mocks.smokeGate = true;
    for (const g of [graph("done", "pending"), graph("done", "dispatched", { acceptance_reprobe_pending: true, acceptance_attempts: 1 })]) {
      __resetPublishPreviewKicks();
      mocks.kick.mockClear();
      mocks.statusRun.mockResolvedValue({ data: [runRow("active", g)], error: null });
      const body = (await call()).body as Body;
      expect(body.app_ready).toBe(false);
      expect(body.publish.status).toBe("publishing");
      expect(mocks.kick).toHaveBeenCalledTimes(1);
    }
  });

  it("the gate failed the run (acceptance_failed): app_ready false, publish failed", async () => {
    mocks.smokeGate = true;
    mocks.statusRun.mockResolvedValue({
      data: [runRow("failed", graph("done", "failed", { failure_class: "acceptance_failed" }), "acceptance_failed")],
      error: null,
    });
    const body = (await call()).body as Body;
    expect(body.app_ready).toBe(false);
    expect(body.publish.status).toBe("failed");
  });

  it("the gate passed (run done): publish live, as before", async () => {
    mocks.smokeGate = true;
    mocks.statusRun.mockResolvedValue({ data: [runRow("done", graph("done", "done"))], error: null });
    const body = (await call()).body as Body;
    expect(body.app_ready).toBe(false);
    expect(body.publish.status).toBe("live");
  });

  it("key off: the same failed acceptance run still reports app_ready true, unchanged", async () => {
    mocks.smokeGate = false;
    mocks.statusRun.mockResolvedValue({
      data: [runRow("failed", graph("done", "failed", { failure_class: "acceptance_failed" }), "acceptance_failed")],
      error: null,
    });
    const body = (await call()).body as Body;
    expect(body.app_ready).toBe(true);
    expect(body.publish.status).toBe("failed");
  });

  it("a plain Render deploy_failed is not held: app_ready true with Retry publish", async () => {
    mocks.smokeGate = true;
    mocks.statusRun.mockResolvedValue({
      data: [runRow("paused", graph("done", "failed", { failure_class: "deploy_failed" }), "deploy_failed", new Date(Date.now() - 3600_000).toISOString())],
      error: null,
    });
    const body = (await call()).body as Body;
    expect(body.app_ready).toBe(true);
    expect(body.publish).toMatchObject({ status: "failed", retryable: true });
  });

  it("a deploy that failed after an acceptance repair is still held", async () => {
    mocks.smokeGate = true;
    mocks.statusRun.mockResolvedValue({
      data: [runRow("paused", graph("done", "failed", { failure_class: "dispatch_failed", acceptance_attempts: 1 }), "deploy_failed", new Date(Date.now() - 3600_000).toISOString())],
      error: null,
    });
    const body = (await call()).body as Body;
    expect(body.app_ready).toBe(false);
    expect(body.publish.status).toBe("failed");
  });

  it("a settings read error keeps the key-off behaviour", async () => {
    mocks.smokeGate = new Error("db down");
    mocks.statusRun.mockResolvedValue({ data: [runRow("active", graph("done", "pending"))], error: null });
    const body = (await call()).body as Body;
    expect(body.app_ready).toBe(true);
  });
});
