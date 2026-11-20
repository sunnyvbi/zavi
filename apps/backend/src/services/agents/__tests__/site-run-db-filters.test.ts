
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const db: { conductor_runs: Row[]; tenant_resources: Row[]; agent_runs: Row[] } = { conductor_runs: [], tenant_resources: [], agent_runs: [] };

function pathValue(row: Row, path: string): unknown {
  const parts = path.split(/->>|->/);
  let v: unknown = row;
  for (const p of parts) {
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
  let aliases: Array<[string, string]> = [];
  const q = {
    select: (cols = "*") => {
      aliases = cols.split(",").map((c) => c.trim()).filter((c) => /^\w+:/.test(c)).map((c) => c.split(":") as [string, string]);
      return q;
    },
    eq: (col: string, val: unknown) => (filters.push((r) => String(pathValue(r, col)) === String(val)), q),
    neq: (col: string, val: unknown) => (filters.push((r) => String(pathValue(r, col)) !== String(val)), q),
    is: (col: string, val: null) => (filters.push((r) => pathValue(r, col) === val), q),
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
      rows = rows.slice(0, limit).map((r) => ({ ...r, ...Object.fromEntries(aliases.map(([a, p]) => [a, pathValue(r, p)])) }));
      return Promise.resolve({ data: single ? rows[0] ?? null : rows, error: null }).then(resolve);
    },
  };
  return q;
}

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ from: (t: keyof typeof db) => builder(t) }),
}));

type RefineProductMod = typeof import("@/services/agents/refine-product");
type RefineUndoMod = typeof import("@/services/agents/refine-undo");
let realLoadBuildRetired: RefineProductMod["realLoadBuildRetired"];
let realLoadLatestShippedRefineForSite: RefineUndoMod["realLoadLatestShippedRefineForSite"];
let realRefineUndoDeps: RefineUndoMod["realRefineUndoDeps"];
let refineUndo: RefineUndoMod["refineUndo"];
vi.mock("@/services/sites/store", () => ({
  siteStore: () => {
    throw new Error("sites table unreachable");
  },
}));
beforeAll(async () => {
  ({ realLoadBuildRetired } = await import("@/services/agents/refine-product"));
  ({ realLoadLatestShippedRefineForSite, realRefineUndoDeps, refineUndo } = await import("@/services/agents/refine-undo"));
});

const T = "11111111-1111-4111-8111-111111111111";
const SITE = "aaaaaaaa-0000-4000-8000-000000000001";
let clock = 0;
const at = () => new Date(Date.UTC(2026, 8, 1) + (clock += 60_000)).toISOString();

function oldBuild(id: string): Row {
  return { id, tenant_id: T, kind: "build_app", status: "done", created_at: at(), goal_graph: [{ payload: { stage: "provision" } }, { payload: { stage: "build" } }] };
}
function siteBuild(id: string): Row {
  return {
    id, tenant_id: T, kind: "build_app", status: "done", created_at: at(),
    goal_graph: [{ payload: { stage: "provision", site_id: SITE } }, { payload: { stage: "build", site_id: SITE } }, { payload: { stage: "deploy", site_id: SITE } }],
  };
}
function siteRefine(id: string, status: string): Row {
  return { id, tenant_id: T, kind: "build_app", status, created_at: at(), objective: `[refine] ${id}`, updated_at: at(), goal_graph: [{ child_run_id: null, payload: { refine_mode: true, site_id: SITE } }] };
}

beforeEach(() => {
  db.conductor_runs = [];
  db.tenant_resources = [];
  db.agent_runs = [];
  clock = 0;
});

describe("singleton database retirement check (S5 F6)", () => {
  it("compares the teardown time against the latest NON-site build, not a newer site build", async () => {
    db.conductor_runs.push(oldBuild("old-1"));
    const tornDownAt = at();
    db.conductor_runs.push(siteBuild("site-1"));
    db.tenant_resources.push({ tenant_id: T, resource_kind: "db", status: "torn_down", updated_at: tornDownAt });
    expect(await realLoadBuildRetired(T)).toBe(true);
  });

  it("a newer OLD build after the teardown still means not retired", async () => {
    db.conductor_runs.push(oldBuild("old-1"));
    db.tenant_resources.push({ tenant_id: T, resource_kind: "db", status: "torn_down", updated_at: at() });
    db.conductor_runs.push(oldBuild("old-2"));
    expect(await realLoadBuildRetired(T)).toBe(false);
  });
});

describe("latest shipped refine of a site (S5 F5)", () => {
  it("is found behind 12 newer failed/active refines", async () => {
    db.conductor_runs.push(siteRefine("shipped", "done"));
    for (let i = 0; i < 12; i++) db.conductor_runs.push(siteRefine(`bad-${i}`, i % 2 ? "failed" : "active"));
    const r = await realLoadLatestShippedRefineForSite(T, SITE);
    expect(r?.conductor_run_id).toBe("shipped");
  });
});

describe("old-flow undo is decoupled from new-flow sites (parity)", () => {
  function oldRefine(id: string): Row {
    return { id, tenant_id: T, kind: "build_app", status: "done", created_at: at(), objective: `[refine] ${id}`, updated_at: at(), goal_graph: [{ child_run_id: `ar-${id}`, payload: { refine_mode: true } }] };
  }

  it("the old-flow latest shipped refine is found behind 40 newer site refines (filtered before the limit)", async () => {
    db.conductor_runs.push(oldRefine("old-edit"));
    for (let i = 0; i < 40; i++) db.conductor_runs.push(siteRefine(`site-edit-${i}`, "done"));
    const latest = await realRefineUndoDeps.loadLatestShippedRefine(T);
    expect(latest?.conductor_run_id).toBe("old-edit");
  });

  it("a site undo row does not count as an undo of the old app", async () => {
    db.conductor_runs.push(oldRefine("old-edit"));
    db.conductor_runs.push({ id: "site-undo", tenant_id: T, kind: "undo", status: "done", created_at: at(), goal_graph: [{ payload: { stage: "undo", site_id: SITE, parent_conductor_run_id: "x" } }] });
    expect((await realRefineUndoDeps.loadLatestShippedRefine(T))?.conductor_run_id).toBe("old-edit");
  });

  it("loadSiteOfRun on an old-flow run returns null without touching the (throwing) site store", async () => {
    db.conductor_runs.push(oldRefine("old-edit"));
    expect(await realRefineUndoDeps.loadSiteOfRun!(T, "old-edit")).toBeNull();
  });

  it("an old-flow pinned undo is refused as frozen while the site store throws", async () => {
    db.conductor_runs.push(oldRefine("old-edit"));
    const SHA = "abc1234def5678901234567890123456789abcde";
    const out = refineUndo(
      { tenant_id: T, conductor_run_id: "old-edit" },
      {
        loadSiteOfRun: realRefineUndoDeps.loadSiteOfRun,
        loadLatestShippedRefine: vi.fn().mockResolvedValue({ conductor_run_id: "old-edit", child_run_id: null, output_text: null, parsed: { commit_sha: SHA } }),
        loadProvisionedTarget: vi.fn().mockResolvedValue({ github_full_name: "Praxis-build/singleton", default_branch: "main" }),
        assertProvisionedRepo: { loadRepoResource: vi.fn().mockResolvedValue({ mode: "provisioned", external_ref: { github_full_name: "Praxis-build/singleton" } }) },
        resolveInstallation: vi.fn().mockResolvedValue(-1),
        readBranchHeadSha: vi.fn(),
        listRecentCommits: vi.fn(),
        revertOnMain: vi.fn().mockResolvedValue({ reverted: true, branch: "main", new_commit_sha: "fff1234" }),
        insertUndoRun: vi.fn().mockResolvedValue("undo-1"),
      } as never,
    );
    await expect(out).rejects.toMatchObject({ name: "OldSiteFrozen", code: "old_site_frozen" });
  });
});
