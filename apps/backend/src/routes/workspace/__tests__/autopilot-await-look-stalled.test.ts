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

const SITE_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const PARKED = "0f1c1a5e-6a6e-4d5a-9a3a-1c0a2b3c4a01";
const STUCK = "0f1c1a5e-6a6e-4d5a-9a3a-1c0a2b3c4a02";
const LONG_AGO = "2026-01-01T10:00:00Z";

const run = (id: string, awaitLook: boolean): Row => ({
  id,
  kind: "build_app",
  objective: "Build product: X",
  status: "active",
  created_at: LONG_AGO,
  updated_at: LONG_AGO,
  spend_usd: 0,
  max_usd: 5,
  goal_graph: [
    { status: "done", payload: { stage: "provision", site_id: SITE_A } },
    { status: "pending", payload: { stage: "build", site_id: SITE_A, ...(awaitLook ? { await_look: true } : {}) } },
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
  mocks.resources = [];
  mocks.sites = { [SITE_A]: { id: SITE_A, tenant_id: "tnt-1", status: "building", hostname: "a.zavi.site", live_url: null } };
  mocks.runs = [run(PARKED, true), run(STUCK, false)];
});

describe("a build waiting for the founder's look is never reported stalled", () => {
  it("runs list: the parked build is not stalled, an equally old build with no progress is", async () => {
    const res = mockRes();
    await getAutopilotRuns({ query: {} } as never, res as never);
    expect(res.statusCode).toBe(200);
    const runs = (res.body as { runs: Array<{ id: string; stalled: boolean }> }).runs;
    expect(Object.fromEntries(runs.map((r) => [r.id, r.stalled]))).toEqual({ [PARKED]: false, [STUCK]: true });
  });

  it("run detail: the parked build is not stalled, the stuck one is", async () => {
    for (const [id, stalled] of [[PARKED, false], [STUCK, true]] as const) {
      const res = mockRes();
      await getAutopilotRunDetail({ params: { id } } as never, res as never);
      expect(res.statusCode).toBe(200);
      expect((res.body as { run: { stalled: boolean } }).run.stalled).toBe(stalled);
    }
  });
});
