
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = {
  id: string;
  objective: string;
  status: string;
  goal_graph: unknown[];
  spend_usd: number;
  max_usd: number;
  created_at: string;
  updated_at: string;
  kind: string;
};

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  root: null as Record<string, unknown> | null,
  rows: [] as Row[],
  reads: [] as Array<Array<[string, unknown]>>,
}));

vi.mock("@/services/settings", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/services/settings")>();
  return { ...real, getBoolSetting: async (key: string) => key === "build_edit_undo" };
});
vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));

function pathValue(row: Record<string, unknown>, path: string): unknown {
  let v: unknown = row;
  for (const p of path.split(/->>|->/)) {
    if (v == null) return null;
    v = Array.isArray(v) ? v[Number(p)] : (v as Record<string, unknown>)[p];
  }
  return v ?? null;
}

let step = 0;
function conductorChain() {
  step += 1;
  const isRoot = step === 1;
  const filters: Array<[string, unknown]> = [];
  let ascending = true;
  const api: Record<string, unknown> = {};
  for (const m of ["select", "in", "or", "gte"]) api[m] = () => api;
  api.eq = (col: string, v: unknown) => (filters.push([col, v]), api);
  api.is = (col: string, v: null) => (filters.push([col, v]), api);
  api.order = (_c: string, o?: { ascending?: boolean }) => ((ascending = o?.ascending !== false), api);
  const run = () => {
    mocks.reads.push(filters);
    let rows = mocks.rows.filter((r) =>
      filters.every(([col, v]) =>
        col === "tenant_id" || (v === null ? pathValue(r as never, col) === null : String(pathValue(r as never, col)) === String(v)),
      ),
    );
    if (!ascending) rows = [...rows].reverse();
    return { data: limit === undefined ? rows : rows.slice(0, limit), error: null };
  };
  let limit: number | undefined;
  api.limit = async (n: number) => ((limit = n), run());
  api.maybeSingle = async () => (isRoot ? { data: mocks.root, error: null } : { data: run().data[0] ?? null, error: null });
  return api;
}

vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({
    from: (table: string) => {
      if (table === "conductor_runs") return conductorChain();
      if (table === "agent_runs") return { select: () => ({ eq: () => ({ in: async () => ({ data: [], error: null }) }) }) };
      throw new Error(`unexpected table ${table}`);
    },
  }),
  serviceClient: () => ({
    from: () => {
      const b = { select: () => b, eq: () => b, maybeSingle: async () => ({ data: { role: "owner" }, error: null }) };
      return b;
    },
  }),
}));

import { getAutopilotRefines } from "../autopilot";

const SA = "aaaaaaaa-0000-4000-8000-000000000001";
const SB = "bbbbbbbb-0000-4000-8000-000000000002";
const ROOT_A = "0f1c1a5e-6a6e-4d5a-9a3a-1c0a2b3c4a00";
const ROOT_B = "0f1c1a5e-6a6e-4d5a-9a3a-1c0a2b3c4b00";
const ROOT_OLD = "0f1c1a5e-6a6e-4d5a-9a3a-1c0a2b3c4c00";

let minute = 0;
const at = () => new Date(Date.UTC(2026, 8, 29, 10, (minute += 1))).toISOString();

function root(id: string, site: string | null): Row {
  const t = at();
  const p = site ? { site_id: site } : {};
  return { id, objective: "Build product: X", status: "done", goal_graph: [{ status: "done", payload: { stage: "provision", ...p } }, { status: "done", payload: { stage: "build", ...p } }], spend_usd: 1, max_usd: 5, created_at: t, updated_at: t, kind: "build_app" };
}
function edit(id: string, parent: string, site: string | null, status = "done"): Row {
  const t = at();
  return { id, objective: `[refine] ${id}`, status, goal_graph: [{ status, child_run_id: null, payload: { stage: "build", refine_mode: true, parent_conductor_run_id: parent, ...(site ? { site_id: site } : {}) } }], spend_usd: 1, max_usd: 5, created_at: t, updated_at: t, kind: "build_app" };
}

function mockRes() {
  const res = { statusCode: 200, body: undefined as unknown, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; } };
  return res;
}
async function undoable(session: string, siteOfRoot: string | null): Promise<string[]> {
  mocks.root = { id: session, created_at: "2026-09-29T10:00:00Z", s0: siteOfRoot, s1: siteOfRoot, s2: null };
  const res = mockRes();
  await getAutopilotRefines({ query: { session_id: session } } as never, res as never);
  expect(res.statusCode).toBe(200);
  return (res.body as { refines: Array<Record<string, unknown>> }).refines.filter((r) => r.undoable === true).map((r) => r.id as string);
}

beforeEach(() => {
  step = 0;
  minute = 0;
  mocks.reads = [];
  mocks.requireAuth.mockResolvedValue({ tenant_id: "tnt-1", user_id: "u1", access_token: "tok" });
});

describe("undoable per site / session", () => {
  const EA = "0f1c1a5e-6a6e-4d5a-9a3a-1c0a2b3c4a01";
  const EB = "0f1c1a5e-6a6e-4d5a-9a3a-1c0a2b3c4b01";
  const EO = "0f1c1a5e-6a6e-4d5a-9a3a-1c0a2b3c4c01";

  it("site B's newer edit does not hide site A's undo, and the site read is filtered by site in the query", async () => {
    mocks.rows = [root(ROOT_A, SA), root(ROOT_B, SB), edit(EA, ROOT_A, SA), edit(EB, ROOT_B, SB)];
    expect(await undoable(ROOT_A, SA)).toEqual([EA]);
    expect(mocks.reads.some((f) => f.some(([c, v]) => c === "goal_graph->0->payload->>site_id" && v === SA))).toBe(true);
  });

  it("site B's own session offers B's latest edit", async () => {
    mocks.rows = [root(ROOT_A, SA), root(ROOT_B, SB), edit(EB, ROOT_B, SB), edit(EA, ROOT_A, SA)];
    expect(await undoable(ROOT_B, SB)).toEqual([EB]);
  });

  it("an old-flow session ignores newer site edits", async () => {
    mocks.rows = [root(ROOT_OLD, null), edit(EO, ROOT_OLD, null), root(ROOT_A, SA), edit(EA, ROOT_A, SA)];
    expect(await undoable(ROOT_OLD, null)).toEqual([EO]);
  });

  it("an in-flight edit on the same site still hides the undo", async () => {
    mocks.rows = [root(ROOT_A, SA), edit(EA, ROOT_A, SA), edit("0f1c1a5e-6a6e-4d5a-9a3a-1c0a2b3c4a02", ROOT_A, SA, "active")];
    expect(await undoable(ROOT_A, SA)).toEqual([]);
  });
});

describe("session feed with an old-flow app and a site", () => {
  const LOOSE = "0f1c1a5e-6a6e-4d5a-9a3a-1c0a2b3c4c09";
  const looseEdit = (): Row => {
    const t = at();
    return { id: LOOSE, objective: "[refine] fix the footer", status: "done", goal_graph: [{ status: "done", child_run_id: null, payload: { stage: "build", refine_mode: true } }], spend_usd: 1, max_usd: 5, created_at: t, updated_at: t, kind: "build_app" };
  };
  async function feed(session: string, siteOfRoot: string | null): Promise<string[]> {
    step = 0;
    mocks.root = { id: session, created_at: "2026-09-29T10:00:00Z", s0: siteOfRoot, s1: siteOfRoot, s2: null };
    const res = mockRes();
    await getAutopilotRefines({ query: { session_id: session } } as never, res as never);
    expect(res.statusCode).toBe(200);
    return (res.body as { refines: Array<Record<string, unknown>> }).refines.map((r) => r.id as string);
  }

  it("a parent-less, site-less edit belongs to the old-flow app, not to the newer site", async () => {
    mocks.rows = [root(ROOT_OLD, null), root(ROOT_A, SA), looseEdit()];
    expect(await feed(ROOT_A, SA)).toEqual([]);
    expect(await feed(ROOT_OLD, null)).toEqual([LOOSE]);
  });

  it("site A's edit stays in its thread behind 220 newer runs of site B (filtered before the 200-row page)", async () => {
    const EA = "0f1c1a5e-6a6e-4d5a-9a3a-1c0a2b3c4a77";
    mocks.rows = [root(ROOT_A, SA), root(ROOT_B, SB)];
    for (let i = 0; i < 220; i++) {
      mocks.rows.push(edit(`0f1c1a5e-6a6e-4d5a-9a3a-${String(i).padStart(12, "0")}`, ROOT_B, SB));
    }
    mocks.rows.push(edit(EA, ROOT_A, SA));
    expect(await feed(ROOT_A, SA)).toEqual([EA]);
  });

  it("a site root marked only on node 1 still owns its edits", async () => {
    const EA = "0f1c1a5e-6a6e-4d5a-9a3a-1c0a2b3c4a88";
    const r = root(ROOT_A, null);
    (r.goal_graph as Array<{ payload: Record<string, unknown> }>)[1].payload.site_id = SA;
    mocks.rows = [r, edit(EA, ROOT_A, SA)];
    const res = mockRes();
    step = 0;
    mocks.root = { id: ROOT_A, created_at: "2026-09-29T10:00:00Z", s0: null, s1: SA, s2: null };
    await getAutopilotRefines({ query: { session_id: ROOT_A } } as never, res as never);
    expect((res.body as { refines: Array<{ id: string }> }).refines.map((x) => x.id)).toEqual([EA]);
  });

  it("the old-flow app's edit stays in its thread behind 220 newer site runs", async () => {
    const EO = "0f1c1a5e-6a6e-4d5a-9a3a-1c0a2b3c4c77";
    mocks.rows = [root(ROOT_OLD, null), root(ROOT_A, SA)];
    for (let i = 0; i < 220; i++) {
      mocks.rows.push(edit(`0f1c1a5e-6a6e-4d5a-9a3a-${String(i).padStart(12, "0")}`, ROOT_A, SA));
    }
    mocks.rows.push(edit(EO, ROOT_OLD, null));
    expect(await feed(ROOT_OLD, null)).toEqual([EO]);
  });
});

describe("Home feed (no session): the workspace app only", () => {
  it("shows only the old-flow app's edits, behind newer edits of two sites, filtered in the query", async () => {
    const EO = "0f1c1a5e-6a6e-4d5a-9a3a-1c0a2b3c4c66";
    mocks.rows = [root(ROOT_OLD, null), root(ROOT_A, SA), root(ROOT_B, SB), edit(EO, ROOT_OLD, null)];
    for (let i = 0; i < 20; i++) {
      mocks.rows.push(edit(`0f1c1a5e-6a6e-4d5a-9a3a-a${String(i).padStart(11, "0")}`, ROOT_A, SA));
      mocks.rows.push(edit(`0f1c1a5e-6a6e-4d5a-9a3a-b${String(i).padStart(11, "0")}`, ROOT_B, SB));
    }
    const res = mockRes();
    await getAutopilotRefines({ query: { limit: "5" } } as never, res as never);
    expect(res.statusCode).toBe(200);
    expect((res.body as { refines: Array<{ id: string }> }).refines.map((r) => r.id)).toEqual([EO]);
    const read = mocks.reads[0];
    for (const n of [0, 1, 2]) {
      expect(read).toContainEqual([`goal_graph->${n}->payload->>site_id`, null]);
    }
  });
});

describe("publishing runs in the background, never as a chat turn", () => {
  const EA = "0f1c1a5e-6a6e-4d5a-9a3a-1c0a2b3c4a11";
  const PUB = "0f1c1a5e-6a6e-4d5a-9a3a-1c0a2b3c4a12";
  function republish(id: string, status: string): Row {
    const t = at();
    return {
      id,
      objective: "[refine] republish tv-rentals-4b5ad1a6-0e2a3d-dev.zaviagent.com",
      status,
      goal_graph: [{ status: status === "done" ? "done" : "pending", child_run_id: null, payload: { stage: "deploy", refine_mode: true, republish: true, publish_request: true, site_id: SA, parent_conductor_run_id: ROOT_A } }],
      spend_usd: 0,
      max_usd: 5,
      created_at: t,
      updated_at: t,
      kind: "build_app",
    };
  }
  async function feed(): Promise<string[]> {
    mocks.root = { id: ROOT_A, created_at: "2026-09-29T10:00:00Z", s0: SA, s1: SA, s2: null };
    const res = mockRes();
    await getAutopilotRefines({ query: { session_id: ROOT_A } } as never, res as never);
    expect(res.statusCode).toBe(200);
    return (res.body as { refines: Array<Record<string, unknown>> }).refines.map((r) => r.id as string);
  }

  it.each(["active", "done", "failed"])("a %s publish of the site is left out of the session's chat feed", async (status) => {
    mocks.rows = [root(ROOT_A, SA), edit(EA, ROOT_A, SA), republish(PUB, status)];
    const ids = await feed();
    expect(ids).toEqual([EA]);
    expect(ids).not.toContain(PUB);
  });
  it("after a Publish the last real edit is still undoable", async () => {
    mocks.rows = [root(ROOT_A, SA), edit(EA, ROOT_A, SA), republish(PUB, "done")];
    expect(await undoable(ROOT_A, SA)).toEqual([EA]);
  });

  it("an edit made after a Publish is the one undoable", async () => {
    const EB = "0f1c1a5e-6a6e-4d5a-9a3a-1c0a2b3c4a13";
    mocks.rows = [root(ROOT_A, SA), edit(EA, ROOT_A, SA), republish(PUB, "done"), edit(EB, ROOT_A, SA)];
    expect(await undoable(ROOT_A, SA)).toEqual([EB]);
  });
});
