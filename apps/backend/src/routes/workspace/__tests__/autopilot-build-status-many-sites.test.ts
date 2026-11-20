
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;

const mocks = vi.hoisted(() => ({
  runs: [] as Row[],
  sites: {} as Record<string, Row>,
  limits: [] as number[],
}));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async () => ({ tenant_id: "tnt-1", user_id: "u1", access_token: "tok" })),
}));
vi.mock("@/services/sites/store", () => ({
  siteStore: () => ({ get: async (_t: string, id: string) => mocks.sites[id] ?? null }),
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
    if (table !== "conductor_runs") return [];
    return mocks.runs
      .filter((r) => eqs.every(([c, v]) => r[c] === v))
      .filter((r) => nulls.every((c) => pathValue(r, c) === null))
      .filter((r) => !freshOnly || !isRefine(r))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, n);
  };
  const api: Record<string, unknown> = {};
  api.select = () => api;
  api.in = () => api;
  api.order = () => api;
  api.is = (c: string, v: null) => (v === null && nulls.push(c), api);
  api.eq = (c: string, v: unknown) => (eqs.push([c, v]), api);
  api.or = () => ((freshOnly = true), api);
  api.limit = (k: number) => (table === "conductor_runs" && mocks.limits.push(k), (n = k), api);
  api.maybeSingle = async () => ({ data: rows()[0] ?? null, error: null });
  api.then = (res: (v: { data: Row[]; error: null }) => unknown) => res({ data: rows(), error: null });
  return api;
}

vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({ from: (t: string) => chain(t) }),
  serviceClient: () => ({ from: (t: string) => chain(t) }),
}));

import { getAutopilotBuildStatus } from "../autopilot";

const SITE_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const SITE_B = "bbbbbbbb-0000-4000-8000-00000000000b";
let clock = 0;
const at = () => new Date(Date.UTC(2026, 9, 1) + (clock += 60_000)).toISOString();

const fresh = (id: string, site: string | null): Row => ({
  id,
  tenant_id: "tnt-1",
  kind: "build_app",
  objective: "Build product: X",
  status: "active",
  created_at: at(),
  updated_at: at(),
  spend_usd: 0,
  max_usd: 5,
  goal_graph: [
    { status: "done", payload: { stage: "provision", ...(site ? { site_id: site } : {}) } },
    { status: "running", payload: { stage: "build", ...(site ? { site_id: site } : {}) } },
  ],
});
const refine = (id: string, site: string): Row => ({
  id,
  tenant_id: "tnt-1",
  kind: "build_app",
  objective: `[refine] ${id}`,
  status: "done",
  created_at: at(),
  updated_at: at(),
  goal_graph: [{ status: "done", payload: { stage: "build", refine_mode: true, site_id: site } }],
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
  clock = 0;
  mocks.limits = [];
  const site = (id: string): Row => ({ id, tenant_id: "tnt-1", status: "building", hostname: `${id.slice(0, 4)}.zavi.site`, live_url: null, live_deploy_id: null, github_full_name: null });
  mocks.sites = { [SITE_A]: site(SITE_A), [SITE_B]: site(SITE_B) };
});

describe("build-status default (no run_id) with many sites", () => {
  it("finds the latest fresh build behind 8 newer edits across two sites", async () => {
    mocks.runs = [fresh("site-a-root", SITE_A), fresh("site-b-root", SITE_B)];
    for (let i = 0; i < 4; i++) mocks.runs.push(refine(`a-edit-${i}`, SITE_A), refine(`b-edit-${i}`, SITE_B));
    const res = mockRes();
    await getAutopilotBuildStatus({ query: {} } as never, res as never);
    expect(res.statusCode).toBe(200);
    expect((res.body as { run: { id: string } | null }).run?.id).toBe("site-b-root");
    expect(mocks.limits[0]).toBe(1);
  });

  it("answers no build only when there is none", async () => {
    mocks.runs = [];
    const res = mockRes();
    await getAutopilotBuildStatus({ query: {} } as never, res as never);
    expect(res.body).toMatchObject({ run: null });
  });
});

describe("build-status ?app=workspace (Home: the workspace app only)", () => {
  it("returns the old-flow build, never a newer site build of either of two sites", async () => {
    mocks.runs = [fresh("old-root", null), fresh("site-a-root", SITE_A), fresh("site-b-root", SITE_B)];
    for (let i = 0; i < 3; i++) mocks.runs.push(refine(`a-edit-${i}`, SITE_A), refine(`b-edit-${i}`, SITE_B));
    const res = mockRes();
    await getAutopilotBuildStatus({ query: { app: "workspace" } } as never, res as never);
    expect(res.statusCode).toBe(200);
    expect((res.body as { run: { id: string } | null }).run?.id).toBe("old-root");
    expect((res.body as { site?: unknown }).site).toBeUndefined();
    expect(mocks.limits[0]).toBe(1);
  });

  it("a site-only workspace has no workspace build", async () => {
    mocks.runs = [fresh("site-a-root", SITE_A), fresh("site-b-root", SITE_B)];
    const res = mockRes();
    await getAutopilotBuildStatus({ query: { app: "workspace" } } as never, res as never);
    expect(res.body).toMatchObject({ run: null });
  });

  it("refuses an unknown app value", async () => {
    const res = mockRes();
    await getAutopilotBuildStatus({ query: { app: "site" } } as never, res as never);
    expect(res.statusCode).toBe(400);
  });
});
