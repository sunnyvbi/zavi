import { describe, it, expect, vi, type Mock } from "vitest";
import {
  refineProduct,
  OldSiteFrozen,
  SITE_FAST_EDIT_ESTIMATE_USD,
  type RefineProductDeps,
  type PriorRefineTurn,
} from "@/services/agents/refine-product";
import type { ConductorNode } from "@/services/agents/conductor";
import type { SiteRow } from "@/services/sites/contract";

const TENANT = "11111111-1111-4111-8111-111111111111";
const SESSION = "d130919a-bec1-48bc-9dbf-fba65217f05a";
const SITE_ID = "aaaaaaaa-0000-4000-8000-000000000001";

const SITE: SiteRow = {
  id: SITE_ID,
  tenant_id: TENANT,
  root_conductor_run_id: SESSION,
  started_by_user_id: null,
  owner_email: "owner@example.test",
  label: "alpha",
  hostname: "alpha.zaviagent.com",
  github_full_name: "praxis-built/alpha",
  supabase_project_ref: "ref",
  supabase_url: "https://ref.supabase.co",
  status: "live",
  live_url: "https://alpha.zaviagent.com",
  desired_sha: "1111111",
  live_sha: "1111111",
  live_deploy_id: "d00000000a-live0001",
  last_visit_at: null,
  last_edit_at: null,
  paused_at: null,
  last_error: null,
  created_at: "2026-09-30T00:00:00Z",
  updated_at: "2026-09-30T00:00:00Z",
};

type MockDeps = RefineProductDeps & { [K in keyof RefineProductDeps]: Mock };

function deps(over: Partial<RefineProductDeps> = {}): MockDeps {
  return {
    loadProvisionedTarget: vi.fn().mockResolvedValue(null),
    loadPriorRefines: vi.fn().mockResolvedValue([] as PriorRefineTurn[]),
    verifyConductorRunOwnership: vi.fn().mockResolvedValue(true),
    loadConductorRunKind: vi.fn().mockResolvedValue("build_app"),
    tryAcquireBuildSlot: vi.fn().mockResolvedValue("cr_refine_1"),
    updateConductorRunStatus: vi.fn().mockResolvedValue(undefined),
    resolveDailyCap: vi.fn().mockResolvedValue(0),
    loadRepoHeadSha: vi.fn().mockResolvedValue("1111111"),
    resolveRefineDirectMergeEnabled: vi.fn().mockResolvedValue(true),
    isFleetHalted: vi.fn().mockResolvedValue(false),
    loadAppPolicy: vi.fn().mockResolvedValue({ protected_globs: [], freeze: false, preview: "branch_preview" }),
    loadSiteForRun: vi.fn().mockResolvedValue({ ...SITE }),
    markSiteEdited: vi.fn().mockResolvedValue(undefined),
    resolveSiteFastEditNode: vi.fn().mockResolvedValue(true),
    resolveSiteEditTimingLog: vi.fn().mockResolvedValue(true),
    ...over,
  } as unknown as MockDeps;
}

function graphOf(d: MockDeps): ConductorNode[] {
  for (const call of d.updateConductorRunStatus.mock.calls) {
    const arg = call[0] as { goal_graph?: ConductorNode[] };
    if (arg.goal_graph) return arg.goal_graph;
  }
  throw new Error("no goal_graph written");
}

const SMALL = { tenant_id: TENANT, message: "change the hero title to Rent e-bikes fast", conductor_run_id: SESSION, small_edit: true };

describe("refineProduct: a small edit to a new-flow site gets the fast edit node", () => {
  it("stamps fast_edit with the low estimate on the engineer node and refine_requested_at on both nodes", async () => {
    const before = Date.now();
    const d = deps();
    await refineProduct(SMALL, d);
    const after = Date.now();
    const [engineer, deploy] = graphOf(d);
    expect(engineer.target_agent_slug).toBe("engineer");
    expect(engineer.payload).toMatchObject({ fast_edit: true, small_edit: true, refine_mode: true, site_id: SITE_ID, stage: "build" });
    expect(engineer.estimate_usd).toBe(SITE_FAST_EDIT_ESTIMATE_USD);
    expect(SITE_FAST_EDIT_ESTIMATE_USD).toBeLessThan(1);
    expect(deploy.payload).toMatchObject({ stage: "deploy", site_id: SITE_ID });
    expect(deploy.payload).not.toHaveProperty("fast_edit");
    for (const n of [engineer, deploy]) {
      const at = Date.parse(String((n.payload as Record<string, unknown>).refine_requested_at));
      expect(at).toBeGreaterThanOrEqual(before - 1);
      expect(at).toBeLessThanOrEqual(after + 1);
    }
    expect(d.resolveSiteFastEditNode).toHaveBeenCalledWith(TENANT);
  });

  it("site_fast_edit_node off: the full refine node and estimate", async () => {
    const d = deps({ resolveSiteFastEditNode: vi.fn().mockResolvedValue(false) });
    await refineProduct(SMALL, d);
    const [engineer] = graphOf(d);
    expect(engineer.payload).not.toHaveProperty("fast_edit");
    expect(engineer.estimate_usd).toBe(3.0);
    expect(d.resolveSiteFastEditNode).toHaveBeenCalledWith(TENANT);
  });

  it("a setting read error is OFF, never a fast node", async () => {
    const d = deps({ resolveSiteFastEditNode: vi.fn().mockRejectedValue(new Error("db down")) });
    await refineProduct(SMALL, d);
    expect(graphOf(d)[0].payload).not.toHaveProperty("fast_edit");
    expect(d.resolveSiteFastEditNode).toHaveBeenCalledTimes(1);
  });

  it("a structural edit to a site (no small_edit) keeps the full node", async () => {
    const d = deps();
    await refineProduct({ ...SMALL, small_edit: false }, d);
    expect(graphOf(d)[0].payload).not.toHaveProperty("fast_edit");
    expect(graphOf(d)[0].estimate_usd).toBe(3.0);
  });

  it("an old-flow small edit is refused (frozen), so it never gets a node at all", async () => {
    const d = deps({
      loadSiteForRun: vi.fn().mockResolvedValue(null),
      loadProvisionedTarget: vi.fn().mockResolvedValue({ github_full_name: "praxis-build/acme", repo_url: "https://github.com/praxis-build/acme", default_branch: "main" }),
    });
    await expect(refineProduct(SMALL, d)).rejects.toBeInstanceOf(OldSiteFrozen);
    expect(d.updateConductorRunStatus).not.toHaveBeenCalled();
  });

  it("stamps the site's backend from its sites row on the engineer node (pooled, kernel, dedicated)", async () => {
    const cases: Array<[Partial<SiteRow>, string]> = [
      [{ backend_mode: "pooled", shard_id: "sh1" }, "pooled"],
      [{ backend_mode: "static" }, "pooled"],
      [{ backend_mode: "dedicated", kernel_shard_id: "k1" }, "pooled"],
      [{ backend_mode: "dedicated" }, "dedicated"],
    ];
    for (const [patch, want] of cases) {
      for (const small_edit of [true, false]) {
        const d = deps({ loadSiteForRun: vi.fn().mockResolvedValue({ ...SITE, ...patch }) });
        await refineProduct({ ...SMALL, small_edit }, d);
        expect(graphOf(d)[0].payload).toMatchObject({ site_id: SITE_ID, site_backend: want });
      }
    }
  });

  it("a row with no known backend stamps nothing (the worker resolves it or fails typed; never a default)", async () => {
    const d = deps({ loadSiteForRun: vi.fn().mockResolvedValue({ ...SITE, backend_mode: undefined }) });
    await refineProduct(SMALL, d);
    expect(graphOf(d)[0].payload).not.toHaveProperty("site_backend");
  });

  it("site_edit_timing_log off: no refine_requested_at stamp", async () => {
    const d = deps({ resolveSiteEditTimingLog: vi.fn().mockResolvedValue(false) });
    await refineProduct(SMALL, d);
    for (const n of graphOf(d)) expect(n.payload).not.toHaveProperty("refine_requested_at");
    expect(d.resolveSiteEditTimingLog).toHaveBeenCalledWith(TENANT);
    expect(graphOf(d)[0].payload).toMatchObject({ fast_edit: true });
  });
});

describe("refineProduct: an Apply refine carries the drafts it applies", () => {
  it("stamps only well-formed draft refs on the engineer node, never on the deploy node", async () => {
    const d = deps();
    const refs = [
      { id: "e1", updated_at: "2026-10-02T09:00:01.000Z" },
      { id: "e2", updated_at: "2026-10-02T09:00:02.000Z" },
    ];
    await refineProduct({ ...SMALL, site_inline_edits: [...refs, { id: "", updated_at: "x" }, { id: "e3" } as never, null as never] }, d);
    const [engineer, deploy] = graphOf(d);
    expect((engineer.payload as Record<string, unknown>).site_inline_edits).toEqual(refs);
    expect(deploy.payload).not.toHaveProperty("site_inline_edits");
  });

  it("a chat refine carries no drafts", async () => {
    const d = deps();
    await refineProduct(SMALL, d);
    expect(graphOf(d)[0].payload).not.toHaveProperty("site_inline_edits");
  });
});
