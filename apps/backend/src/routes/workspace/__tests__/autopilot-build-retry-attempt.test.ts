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
  ownerKey: true,
  offlineKey: true,
  retryKey: true as boolean | "throw",
  settingReads: [] as string[],
}));

vi.mock("@/services/settings", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/services/settings")>();
  return {
    ...real,
    getBoolSetting: async (key: string, tenantId?: string) => {
      mocks.settingReads.push(key);
      if (key === "build_auto_site_owner") return mocks.ownerKey;
      if (key === "build_site_offline_status") return mocks.offlineKey;
      if (key === "build_progress_shows_retries") {
        if (mocks.retryKey === "throw") throw new Error("settings down");
        return mocks.retryKey;
      }
      return real.getBoolSetting(key as never, tenantId as never);
    },
  };
});

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/services/agents/conductor-driver", () => ({ kickSandboxPreview: mocks.kick }));

function chain(terminal: () => unknown) {
  const api: Record<string, unknown> = {};
  const self = () => api;
  for (const m of ["eq", "in", "or", "gte", "order", "not"]) api[m] = self;
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
let mode = "status" as "status" | "sessions";

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

import { getAutopilotBuildStatus } from "../autopilot";
import { __resetPublishPreviewKicks } from "@/services/build/app-ready";
import { clearSignupProbeCache } from "@/services/website/site-signup";
import { clearSiteOfflineCache } from "@/services/website/site-offline";

const RUN = "11111111-1111-4111-8111-111111111111";
const HOSTING = "https://acme.onrender.com";

type Stage = { stage: string; status: string; retry_count: number; attempt?: number };

function graph(scaffoldAttempts: number | undefined) {
  return [
    { id: "n0", status: "done", payload: { stage: "provision" } },
    { id: "n1", status: "done", payload: { stage: "spec" } },
    {
      id: "n2",
      status: "dispatched",
      payload: { stage: "scaffold" },
      ...(scaffoldAttempts === undefined ? {} : { repair_attempts: scaffoldAttempts }),
      last_failure_signal: "Stage \"scaffold\" finished but no code reached the provisioned repo after 11 min.",
    },
    { id: "n3", status: "pending", payload: { stage: "build" } },
  ];
}

function run(scaffoldAttempts: number | undefined) {
  return {
    id: RUN,
    objective: "Build product: Paws & Suds — grooming bookings",
    status: "active",
    failure_class: null,
    paused_at: null,
    goal_graph: graph(scaffoldAttempts),
    spend_usd: 1,
    max_usd: 20,
    created_at: "2026-09-29T17:39:00Z",
    updated_at: "2026-09-29T17:52:00Z",
  };
}

async function call() {
  conductorStep = 0;
  let body: { run: { stages: Stage[] } } | undefined;
  const res = {
    status: () => res,
    json: (b: typeof body) => {
      body = b;
      return res;
    },
  };
  await getAutopilotBuildStatus({ query: {} } as never, res as never);
  return body!;
}

function scaffold(body: { run: { stages: Stage[] } }) {
  return body.run.stages.find((s) => s.stage === "scaffold")!;
}

beforeEach(() => {
  for (const k of ["requireAuth", "statusRun", "latestFresh", "resources", "sandboxRow", "rpc", "kick"] as const) mocks[k].mockReset();
  mocks.retryKey = true;
  mocks.settingReads.length = 0;
  clearSignupProbeCache();
  clearSiteOfflineCache();
  __resetPublishPreviewKicks();
  mocks.requireAuth.mockResolvedValue({ tenant_id: "tnt-1", user_id: "u-1", access_token: "tok" });
  mocks.statusRun.mockResolvedValue({ data: [run(1)], error: null });
  mocks.latestFresh.mockResolvedValue({ data: [{ id: RUN, status: "active", goal_graph: [], created_at: "2026-09-29T17:39:00Z" }], error: null });
  mocks.resources.mockResolvedValue({
    data: [
      { resource_kind: "repo", status: "ready", external_ref: { repo_url: "https://github.com/acme/app" } },
      { resource_kind: "hosting", status: "pending", external_ref: { url: HOSTING }, created_at: "2026-09-29T17:40:00Z" },
    ],
    error: null,
  });
  mocks.sandboxRow.mockResolvedValue({ data: null, error: null });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("no network in this test");
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /build-status names a retried build step (DEL-1323 B18/B19)", () => {
  it("a scaffold step re-run after 'no code reached the provisioned repo' carries attempt 2", async () => {
    const body = await call();
    expect(scaffold(body)).toMatchObject({ status: "running", retry_count: 1, attempt: 2 });
    expect(mocks.settingReads).toContain("build_progress_shows_retries");
  });

  it("the third try is attempt 3, and steps that never retried carry no attempt", async () => {
    mocks.statusRun.mockResolvedValue({ data: [run(2)], error: null });
    const body = await call();
    expect(scaffold(body).attempt).toBe(3);
    for (const s of body.run.stages.filter((x) => x.stage !== "scaffold")) {
      expect(s).not.toHaveProperty("attempt");
    }
  });

  it("a first try carries no attempt", async () => {
    mocks.statusRun.mockResolvedValue({ data: [run(undefined)], error: null });
    const body = await call();
    expect(scaffold(body)).not.toHaveProperty("attempt");
    expect(scaffold(body).retry_count).toBe(0);
  });

  it("key off: the stage rows are exactly the old shape, no attempt anywhere", async () => {
    mocks.retryKey = false;
    const body = await call();
    for (const s of body.run.stages) expect(s).not.toHaveProperty("attempt");
    expect(scaffold(body).retry_count).toBe(1);
  });

  it("a failed settings read falls back to the old shape instead of failing the status poll", async () => {
    mocks.retryKey = "throw";
    const body = await call();
    expect(body.run.stages).toHaveLength(4);
    for (const s of body.run.stages) expect(s).not.toHaveProperty("attempt");
  });
});
