
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const db: { conductor_runs: Row[]; agent_runs: Row[] } = { conductor_runs: [], agent_runs: [] };

function pathValue(row: Row, path: string): unknown {
  let v: unknown = row;
  for (const p of path.split(/->>|->/)) {
    if (v == null) return null;
    v = Array.isArray(v) ? v[Number(p)] : (v as Row)[p];
  }
  if (v === undefined || v === null) return null;
  return path.includes("->>") && typeof v !== "string" ? JSON.stringify(v) : v;
}

function builder(table: keyof typeof db) {
  const filters: Array<(r: Row) => boolean> = [];
  let order: { col: string; asc: boolean } | null = null;
  let limit = Infinity;
  let single = false;
  const q = {
    select: () => q,
    eq: (col: string, val: unknown) => (filters.push((r) => String(pathValue(r, col)) === String(val)), q),
    is: (col: string, val: null) => (filters.push((r) => pathValue(r, col) === val), q),
    gt: (col: string, val: string) => (filters.push((r) => String(r[col]) > val), q),
    gte: (col: string, val: string) => (filters.push((r) => String(r[col]) >= val), q),
    in: (col: string, vals: unknown[]) => (filters.push((r) => vals.includes(r[col])), q),
    or: (expr: string) => {
      const alts = expr.split(",").map((a) => {
        const m = a.match(/^(.*)\.(is|neq|eq)\.(.*)$/)!;
        return (r: Row) => {
          const v = pathValue(r, m[1]);
          if (m[2] === "is") return v === null;
          if (m[2] === "neq") return v === null ? false : String(v) !== m[3];
          return String(v) === m[3];
        };
      });
      filters.push((r) => alts.some((f) => f(r)));
      return q;
    },
    order: (col: string, o?: { ascending?: boolean }) => ((order = { col, asc: o?.ascending !== false }), q),
    limit: (n: number) => ((limit = n), q),
    maybeSingle: () => ((single = true), q),
    then(resolve: (v: { data: unknown; error: null }) => unknown) {
      let rows = db[table].filter((r) => filters.every((f) => f(r)));
      if (order) {
        const { col, asc } = order;
        rows = [...rows].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (asc ? 1 : -1));
      }
      rows = rows.slice(0, limit);
      return Promise.resolve({ data: single ? rows[0] ?? null : rows, error: null }).then(resolve);
    },
  };
  return q;
}

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ from: (t: keyof typeof db) => builder(t) }),
}));
vi.mock("@/services/sites/store", () => ({
  siteStore: () => {
    throw new Error("sites table unreachable");
  },
}));

type RefineProductMod = typeof import("@/services/agents/refine-product");
type RefineUndoMod = typeof import("@/services/agents/refine-undo");
let realRefineProductDeps: RefineProductMod["realRefineProductDeps"];
let realRefineUndoDeps: RefineUndoMod["realRefineUndoDeps"];
beforeAll(async () => {
  ({ realRefineProductDeps } = await import("@/services/agents/refine-product"));
  ({ realRefineUndoDeps } = await import("@/services/agents/refine-undo"));
});

const T = "11111111-1111-4111-8111-111111111111";
const OTHER_T = "22222222-2222-4222-8222-222222222222";
const SITE_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const SITE_B = "bbbbbbbb-0000-4000-8000-00000000000b";
let clock = 0;
const at = () => new Date(Date.UTC(2026, 8, 1) + (clock += 60_000)).toISOString();

function fresh(id: string, site: string | null, extra: Row = {}, tenant = T): Row {
  const p = site ? { site_id: site } : {};
  return {
    id, tenant_id: tenant, kind: "build_app", status: "done", created_at: at(), objective: `Build ${id}`,
    goal_graph: [{ payload: { stage: "provision", ...p } }, { payload: { stage: "build", ...p } }],
    ...extra,
  };
}
function refine(id: string, site: string | null, extra: { status?: string; pre?: string; tenant?: string } = {}): Row {
  return {
    id, tenant_id: extra.tenant ?? T, kind: "build_app", status: extra.status ?? "done", created_at: at(), updated_at: at(),
    objective: `[refine] ${id}`,
    goal_graph: [{
      child_run_id: `ar-${id}`,
      payload: { refine_mode: true, ...(site ? { site_id: site } : {}), ...(extra.pre ? { pre_refine_sha: extra.pre } : {}) },
    }],
  };
}

beforeEach(() => {
  db.conductor_runs = [];
  db.agent_runs = [];
  clock = 0;
});

describe("prior refines threaded into an edit are THIS app's, filtered before the limit", () => {
  it("site A's priors survive 30 newer edits of site B and of the old app", async () => {
    db.conductor_runs.push(fresh("a-root", SITE_A), refine("a-edit-1", SITE_A), refine("a-edit-2", SITE_A));
    for (let i = 0; i < 15; i++) db.conductor_runs.push(refine(`b-edit-${i}`, SITE_B), refine(`old-edit-${i}`, null));
    const priors = await realRefineProductDeps.loadPriorRefines(T, 3, SITE_A);
    expect(priors.map((p) => p.message ?? p)).toHaveLength(2);
    expect(JSON.stringify(priors)).toContain("a-edit-2");
    expect(JSON.stringify(priors)).not.toMatch(/b-edit|old-edit/);
  });

  it("site B's priors never include site A's, and the old app's never include either site's", async () => {
    db.conductor_runs.push(refine("a-edit", SITE_A), refine("b-edit", SITE_B), refine("old-edit", null));
    expect(JSON.stringify(await realRefineProductDeps.loadPriorRefines(T, 3, SITE_B))).toMatch(/b-edit/);
    expect(JSON.stringify(await realRefineProductDeps.loadPriorRefines(T, 3, SITE_B))).not.toMatch(/a-edit|old-edit/);
    const old = JSON.stringify(await realRefineProductDeps.loadPriorRefines(T, 3, null));
    expect(old).toMatch(/old-edit/);
    expect(old).not.toMatch(/a-edit|b-edit/);
  });

  it("another tenant's edits of the same site id are never read", async () => {
    db.conductor_runs.push(refine("foreign-edit", SITE_A, { tenant: OTHER_T }));
    expect(await realRefineProductDeps.loadPriorRefines(T, 3, SITE_A)).toEqual([]);
  });
});

describe("old-flow version restore never reads site rows", () => {
  it("the earliest shipped refine is the old app's, not an older site edit, behind any number of site runs", async () => {
    db.conductor_runs.push(fresh("site-a", SITE_A), refine("a-edit", SITE_A), refine("b-edit", SITE_B));
    for (let i = 0; i < 210; i++) db.conductor_runs.push(refine(`b-more-${i}`, SITE_B));
    db.conductor_runs.push(fresh("old-root", null), refine("old-edit", null));
    const earliest = await realRefineUndoDeps.loadEarliestShippedRefine!(T);
    expect(earliest?.conductor_run_id).toBe("old-edit");
  });

  it("the build checkpoint fallback reads the old app's next refine, not a site edit in between", async () => {
    const SITE_SHA = "1111111111111111111111111111111111111111";
    const OLD_SHA = "2222222222222222222222222222222222222222";
    db.conductor_runs.push(fresh("old-root", null));
    db.conductor_runs.push(refine("a-edit", SITE_A, { pre: SITE_SHA }));
    db.conductor_runs.push(fresh("site-b", SITE_B));
    db.conductor_runs.push(refine("old-edit", null, { pre: OLD_SHA }));
    expect(await realRefineUndoDeps.loadBuildCheckpointSha!(T, "old-root")).toBe(OLD_SHA);
  });

  it("the old app's branch-lookup window is not cut short by a newer site build", async () => {
    db.conductor_runs.push(fresh("old-root", null), refine("old-edit", null));
    db.conductor_runs.push(fresh("site-a", SITE_A), fresh("site-b", SITE_B));
    const next = fresh("old-root-2", null);
    db.conductor_runs.push(next);
    const earliest = await realRefineUndoDeps.loadEarliestShippedRefine!(T);
    expect(earliest?.next_started_at).toBe(next.created_at);
  });

  it("an old-flow-only tenant is unchanged", async () => {
    const PRE = "3333333333333333333333333333333333333333";
    db.conductor_runs.push(fresh("old-root", null), refine("old-edit", null, { pre: PRE }));
    expect(await realRefineUndoDeps.loadBuildCheckpointSha!(T, "old-root")).toBe(PRE);
    expect((await realRefineUndoDeps.loadEarliestShippedRefine!(T))?.conductor_run_id).toBe("old-edit");
  });
});
