
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;

const mocks = vi.hoisted(() => ({
  runs: [] as Row[],
  resources: [] as Row[],
  sites: {} as Record<string, Row>,
  listTenants: [] as string[],
  listFails: false,
}));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async () => ({ tenant_id: "tnt-1", user_id: "u1", access_token: "tok" })),
}));
vi.mock("@/services/sites/store", () => ({
  siteStore: () => ({
    get: async (_t: string, id: string) => mocks.sites[id] ?? null,
    listForTenant: async (t: string) => {
      mocks.listTenants.push(t);
      if (mocks.listFails) throw new Error("sites read failed");
      return Object.values(mocks.sites);
    },
  }),
}));

function pathValue(row: Row, path: string): unknown {
  let v: unknown = row;
  for (const p of path.split(/->>|->/)) {
    if (v == null) return null;
    v = Array.isArray(v) ? v[Number(p)] : (v as Row)[p];
  }
  return v ?? null;
}
const isRefine = (r: Row) => pathValue(r, "goal_graph->0->payload->>refine_mode") === true;

function chain(table: string) {
  const eqs: Array<[string, unknown]> = [];
  const nulls: string[] = [];
  let freshOnly = false;
  let n = Infinity;
  const rows = (): Row[] => {
    if (table === "tenant_resources") return mocks.resources;
    if (table !== "conductor_runs") return [];
    return mocks.runs
      .filter((r) => eqs.every(([c, v]) => c === "tenant_id" || r[c] === v))
      .filter((r) => nulls.every((c) => pathValue(r, c) === null))
      .filter((r) => !freshOnly || !isRefine(r))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, n);
  };
  const api: Record<string, unknown> = {};
  api.select = () => api;
  api.in = () => api;
  api.order = () => api;
  api.eq = (c: string, v: unknown) => (eqs.push([c, v]), api);
  api.is = (c: string, v: null) => (v === null && nulls.push(c), api);
  api.or = () => ((freshOnly = true), api);
  api.limit = (k: number) => ((n = k), api);
  api.maybeSingle = async () => ({ data: rows()[0] ?? null, error: null });
  api.then = (res: (v: { data: Row[]; error: null }) => unknown) => res({ data: rows(), error: null });
  return api;
}

vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({ from: (t: string) => chain(t) }),
  serviceClient: () => ({ from: (t: string) => chain(t) }),
}));

import { getAutopilotRunDetail, getAutopilotRuns } from "../autopilot";
import { BUILD_FIXES_EXHAUSTED } from "@zavi/shared";

const SITE_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const OLD = "0f1c1a5e-6a6e-4d5a-9a3a-1c0a2b3c4c00";
const RUN_A = "0f1c1a5e-6a6e-4d5a-9a3a-1c0a2b3c4a00";

const build = (id: string, created_at: string, status: string, site: string | null): Row => ({
  id,
  kind: "build_app",
  objective: "Build product: X",
  status,
  created_at,
  updated_at: created_at,
  spend_usd: 1,
  max_usd: 5,
  goal_graph: [
    { status: "done", payload: { stage: "provision", ...(site ? { site_id: site } : {}) } },
    { status: status === "done" ? "done" : "pending", payload: { stage: "build", ...(site ? { site_id: site } : {}) } },
  ],
});

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

beforeEach(() => {
  mocks.listTenants = [];
  mocks.listFails = false;
  mocks.resources = [
    { resource_kind: "repo", status: "ready", external_ref: { repo_url: "https://github.com/praxis-build/old-app" }, updated_at: "2026-09-01T00:00:00Z" },
    { resource_kind: "hosting", status: "ready", external_ref: { url: "https://old-app.onrender.com" }, updated_at: "2026-09-01T00:00:00Z" },
  ];
  mocks.sites = {
    [SITE_A]: {
      id: SITE_A,
      tenant_id: "tnt-1",
      status: "live",
      hostname: "lucky-paws.zavi.site",
      live_url: "https://lucky-paws.zavi.site",
      live_deploy_id: "dep-1",
      github_full_name: "zavi-sites/lucky-paws",
    },
  };
  mocks.runs = [build(OLD, "2026-09-20T10:00:00Z", "done", null), build(RUN_A, "2026-10-01T10:00:00Z", "active", SITE_A)];
});

describe("two apps in one workspace: the old-flow app and a site", () => {
  it("runs list: a newer in-flight site build does not hide the old app's live link", async () => {
    const res = mockRes();
    await getAutopilotRuns({ query: {} } as never, res as never);
    expect(res.statusCode).toBe(200);
    expect((res.body as { target: { live_url: string | null } }).target.live_url).toBe("https://old-app.onrender.com");
  });

  it("run detail of the old-flow run keeps the old app's repo and live link", async () => {
    const res = mockRes();
    await getAutopilotRunDetail({ params: { id: OLD } } as never, res as never);
    expect(res.statusCode).toBe(200);
    expect((res.body as { target: unknown }).target).toEqual({
      repo_url: "https://github.com/praxis-build/old-app",
      live_url: "https://old-app.onrender.com",
    });
  });

  it("run detail of a site run shows ITS site's repo and live address, never the old app's", async () => {
    const res = mockRes();
    await getAutopilotRunDetail({ params: { id: RUN_A } } as never, res as never);
    expect(res.statusCode).toBe(200);
    expect((res.body as { target: unknown }).target).toEqual({
      repo_url: "https://github.com/zavi-sites/lucky-paws",
      live_url: "https://lucky-paws.zavi.site",
    });
  });

  it("run detail shows founder copy for a failed step, never the gate's raw text", async () => {
    const RAW = "The site's smoke check failed: journey checkout returned 500\nEvidence: POST /api/data/orders -> 500";
    const run = build(RUN_A, "2026-10-01T10:00:00Z", "failed", SITE_A);
    (run.goal_graph as Row[])[1] = { status: "failed", failure_class: "repair_exhausted", error: RAW, payload: { stage: "build", site_id: SITE_A } };
    mocks.runs = [run];
    const res = mockRes();
    await getAutopilotRunDetail({ params: { id: RUN_A } } as never, res as never);
    expect(res.statusCode).toBe(200);
    const body = res.body as { run: { goal_graph: Array<{ error: string | null }> } };
    expect(body.run.goal_graph[1].error).toBe(BUILD_FIXES_EXHAUSTED);
    expect(JSON.stringify(res.body)).not.toMatch(/smoke check|journey|Evidence/);
  });

  it("a site that is not serving (failed) has no live address in its run detail", async () => {
    mocks.sites[SITE_A] = { ...mocks.sites[SITE_A], status: "failed" };
    const res = mockRes();
    await getAutopilotRunDetail({ params: { id: RUN_A } } as never, res as never);
    expect((res.body as { target: { live_url: string | null } }).target.live_url).toBeNull();
  });

  it("old-flow-only workspace: a newer old-flow build still decides (in flight = no live link)", async () => {
    mocks.runs = [build(OLD, "2026-09-20T10:00:00Z", "done", null), build("0f1c1a5e-6a6e-4d5a-9a3a-1c0a2b3c4c01", "2026-10-01T10:00:00Z", "active", null)];
    const res = mockRes();
    await getAutopilotRuns({ query: {} } as never, res as never);
    expect((res.body as { target: { live_url: string | null } }).target.live_url).toBeNull();
  });

  it("runs list: each of two sites' runs carries ITS site's session, repo and address; the old run keeps none", async () => {
    const SITE_B = "bbbbbbbb-0000-4000-8000-00000000000b";
    const RUN_B = "0f1c1a5e-6a6e-4d5a-9a3a-1c0a2b3c4b00";
    mocks.sites[SITE_A] = { ...mocks.sites[SITE_A], root_conductor_run_id: RUN_A };
    mocks.sites[SITE_B] = {
      id: SITE_B,
      tenant_id: "tnt-1",
      status: "building",
      hostname: "gym-c3d4.zavi.site",
      live_url: null,
      live_deploy_id: null,
      github_full_name: "zavi-sites/gym",
      root_conductor_run_id: RUN_B,
    };
    mocks.sites.foreign = { id: "foreign", tenant_id: "tnt-2", status: "live", hostname: "x.zavi.site", root_conductor_run_id: "r" };
    mocks.runs.push(build(RUN_B, "2026-10-01T11:00:00Z", "active", SITE_B));
    const res = mockRes();
    await getAutopilotRuns({ query: {} } as never, res as never);
    const runs = (res.body as { runs: Array<{ id: string; site_id: string | null; site: Record<string, unknown> | null }> }).runs;
    const byId = Object.fromEntries(runs.map((r) => [r.id, r]));
    expect(byId[RUN_A].site).toEqual({
      id: SITE_A,
      hostname: "lucky-paws.zavi.site",
      session_id: RUN_A,
      repo_url: "https://github.com/zavi-sites/lucky-paws",
      live_url: "https://lucky-paws.zavi.site",
    });
    expect(byId[RUN_B].site).toEqual({
      id: SITE_B,
      hostname: "gym-c3d4.zavi.site",
      session_id: RUN_B,
      repo_url: "https://github.com/zavi-sites/gym",
      live_url: null,
    });
    expect(byId[OLD]).toMatchObject({ site_id: null, site: null });
    expect(mocks.listTenants).toEqual(["tnt-1"]);
  });

  it("runs list: a sites read failure leaves the site run without links, and an old-flow-only page never reads sites", async () => {
    mocks.listFails = true;
    const res = mockRes();
    await getAutopilotRuns({ query: {} } as never, res as never);
    const runs = (res.body as { runs: Array<{ id: string; site_id: string | null; site: unknown }> }).runs;
    expect(runs.find((r) => r.id === RUN_A)).toMatchObject({ site_id: SITE_A, site: null });

    mocks.listTenants = [];
    mocks.runs = [build(OLD, "2026-09-20T10:00:00Z", "done", null)];
    await getAutopilotRuns({ query: {} } as never, mockRes() as never);
    expect(mocks.listTenants).toEqual([]);
  });

  it("runs list ?app=workspace (Home): only the workspace app's runs, never a site's", async () => {
    mocks.runs.push(build("0f1c1a5e-6a6e-4d5a-9a3a-1c0a2b3c4b00", "2026-10-01T11:00:00Z", "active", "bbbbbbbb-0000-4000-8000-00000000000b"));
    const res = mockRes();
    await getAutopilotRuns({ query: { app: "workspace" } } as never, res as never);
    expect((res.body as { runs: Array<{ id: string }> }).runs.map((r) => r.id)).toEqual([OLD]);
    const bad = mockRes();
    await getAutopilotRuns({ query: { app: "x" } } as never, bad as never);
    expect(bad.statusCode).toBe(400);
  });
});
