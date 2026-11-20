import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const db = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  filters: [] as Array<[string, string, unknown]>,
  error: null as { message: string } | null,
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      if (table !== "conductor_runs") throw new Error(`unexpected table ${table}`);
      const api: Record<string, unknown> = {};
      api.select = () => api;
      api.eq = (k: string, v: unknown) => {
        db.filters.push(["eq", k, v]);
        return api;
      };
      api.gte = (k: string, v: unknown) => {
        db.filters.push(["gte", k, v]);
        return api;
      };
      api.limit = async () => {
        if (db.error) return { data: null, error: db.error };
        const eqs = db.filters.filter((f) => f[0] === "eq");
        const since = db.filters.find((f) => f[0] === "gte" && f[1] === "created_at")?.[2] as string | undefined;
        return {
          data: db.rows.filter(
            (r) => eqs.every(([, k, v]) => r[k] === v) && (!since || String(r.created_at) >= since),
          ),
          error: null,
        };
      };
      return api;
    },
    rpc: async () => ({ data: false, error: null }),
  }),
}));

import {
  refineProduct,
  realRefineProductDeps,
  UndoInProgress,
  type RefineProductDeps,
  type PriorRefineTurn,
} from "@/services/agents/refine-product";
import { UNDO_CLAIM_STALE_MS } from "@/services/agents/refine-undo";
import { testSite } from "./fixtures/refine-site";

const TARGET = {
  repo_url: "https://github.com/praxis-built/yoga-flow",
  github_full_name: "praxis-built/yoga-flow",
  default_branch: "main",
  neon_project_id: "np_1",
};

function deps(over: Partial<RefineProductDeps> = {}) {
  return {
    loadProvisionedTarget: vi.fn().mockResolvedValue(null),
    loadPriorRefines: vi.fn().mockResolvedValue([] as PriorRefineTurn[]),
    verifyConductorRunOwnership: vi.fn().mockResolvedValue(true),
    listSites: vi.fn().mockResolvedValue([testSite({ tenant_id: "tnt-yoga" })]),
    loadConductorRunKind: vi.fn().mockResolvedValue("build_app"),
    tryAcquireBuildSlot: vi.fn().mockResolvedValue("cr_refine_1"),
    updateConductorRunStatus: vi.fn().mockResolvedValue(undefined),
    resolveDailyCap: vi.fn().mockResolvedValue(0),
    loadRepoHeadSha: vi.fn().mockResolvedValue("presha"),
    resolveRefineDirectMergeEnabled: vi.fn().mockResolvedValue(false),
    isFleetHalted: vi.fn().mockResolvedValue(false),
    loadAppPolicy: vi.fn().mockResolvedValue({ protected_globs: [], freeze: false, preview: "branch_preview" }),
    hasPendingUndoClaim: realRefineProductDeps.hasPendingUndoClaim,
    ...over,
  } as unknown as RefineProductDeps & { tryAcquireBuildSlot: Mock; updateConductorRunStatus: Mock };
}

const EDIT = { tenant_id: "tnt-yoga", message: "make the booking button sage green" };

function claimRow(over: Record<string, unknown> = {}) {
  return {
    id: "undo-claim-1",
    tenant_id: "tnt-yoga",
    kind: "undo",
    status: "proposed",
    created_at: new Date(Date.now() - 60_000).toISOString(),
    goal_graph: [{ payload: { stage: "undo", undo_claim: true } }],
    ...over,
  };
}

beforeEach(() => {
  db.rows = [];
  db.filters = [];
  db.error = null;
});

describe("DEL-1323 B29 review: an edit cannot start while an undo is in flight", () => {
  it("a live undo claim refuses the edit before any build slot or conductor row exists", async () => {
    db.rows = [claimRow()];
    const d = deps();
    await expect(refineProduct(EDIT, d)).rejects.toBeInstanceOf(UndoInProgress);
    expect(d.tryAcquireBuildSlot).not.toHaveBeenCalled();
    expect(d.updateConductorRunStatus).not.toHaveBeenCalled();
    expect(db.filters).toEqual(
      expect.arrayContaining([
        ["eq", "tenant_id", "tnt-yoga"],
        ["eq", "kind", "undo"],
        ["eq", "status", "proposed"],
      ]),
    );
  });

  it("a claim older than UNDO_CLAIM_STALE_MS, a settled undo, another tenant's claim or a non-claim row do not block", async () => {
    db.rows = [
      claimRow({ created_at: new Date(Date.now() - UNDO_CLAIM_STALE_MS - 60_000).toISOString() }),
      claimRow({ status: "done" }),
      claimRow({ tenant_id: "tnt-other" }),
      claimRow({ goal_graph: [{ payload: { stage: "undo" } }] }),
    ];
    const d = deps();
    await expect(refineProduct(EDIT, d)).resolves.toBeTruthy();
    expect(d.tryAcquireBuildSlot).toHaveBeenCalledTimes(1);
  });

  it("an unreadable claim state fails closed: no edit starts", async () => {
    db.error = { message: "connection reset" };
    const d = deps();
    await expect(refineProduct(EDIT, d)).rejects.toThrow(/undo claim read failed/);
    expect(d.tryAcquireBuildSlot).not.toHaveBeenCalled();
  });
});
