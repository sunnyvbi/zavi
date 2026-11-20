import { describe, it, expect, vi, type Mock } from "vitest";
import {
  refineProduct,
  type RefineProductDeps,
  type PriorRefineTurn,
} from "@/services/agents/refine-product";
import type { ProvisionedTarget } from "@/services/agents/autopilot-pipeline-contract";
import type { ConductorNode } from "@/services/agents/conductor";
import { testSite } from "./fixtures/refine-site";

const TARGET: ProvisionedTarget = {
  repo_url: "https://github.com/praxis-build/acme",
  github_full_name: "praxis-build/acme",
  default_branch: "main",
  neon_project_id: "np_123",
};

type MockDeps = RefineProductDeps & { [K in keyof RefineProductDeps]: Mock };
function deps(over: Partial<RefineProductDeps> = {}): MockDeps {
  return {
    loadProvisionedTarget: vi.fn().mockResolvedValue(null),
    loadPriorRefines: vi.fn().mockResolvedValue([] as PriorRefineTurn[]),
    verifyConductorRunOwnership: vi.fn().mockResolvedValue(true),
    listSites: vi.fn().mockResolvedValue([testSite({ tenant_id: "t1" })]),
    loadConductorRunKind: vi.fn().mockResolvedValue("build_app"),
    tryAcquireBuildSlot: vi.fn().mockResolvedValue("cr_refine_1"),
    updateConductorRunStatus: vi.fn().mockResolvedValue(undefined),
    resolveDailyCap: vi.fn().mockResolvedValue(0),
    loadRepoHeadSha: vi.fn().mockResolvedValue("presha"),
    resolveRefineDirectMergeEnabled: vi.fn().mockResolvedValue(true),
    isFleetHalted: vi.fn().mockResolvedValue(false),
    loadAppPolicy: vi.fn().mockResolvedValue({ protected_globs: [], freeze: false, preview: "branch_preview" }),
    ...over,
  } as unknown as MockDeps;
}

function graphFromUpdate(d: MockDeps): ConductorNode[] {
  for (const call of d.updateConductorRunStatus.mock.calls) {
    const arg = call[0] as { goal_graph?: ConductorNode[] };
    if (arg.goal_graph) return arg.goal_graph;
  }
  throw new Error("no goal_graph written");
}

const BASE = { tenant_id: "t1", message: "change the hero title to Rent bikes fast" };

describe("refineProduct small_edit", () => {
  it("stamps small_edit on the engineer node only, never on the gate node", async () => {
    const d = deps();
    await refineProduct({ ...BASE, small_edit: true }, d);
    const g = graphFromUpdate(d);
    expect(g.length).toBeGreaterThan(1);
    const engineer = g.find((n) => n.target_agent_slug === "engineer");
    expect((engineer?.payload as Record<string, unknown>).small_edit).toBe(true);
    for (const n of g.filter((x) => x.target_agent_slug !== "engineer")) {
      expect((n.payload as Record<string, unknown>).small_edit).toBeUndefined();
    }
  });

  it("leaves the key absent for an ordinary refine", async () => {
    const d = deps();
    await refineProduct(BASE, d);
    for (const n of graphFromUpdate(d)) {
      expect(n.payload as Record<string, unknown>).not.toHaveProperty("small_edit");
    }
  });

  it("ignores a truthy non-boolean flag", async () => {
    const d = deps();
    await refineProduct({ ...BASE, small_edit: "yes" as unknown as boolean }, d);
    for (const n of graphFromUpdate(d)) {
      expect(n.payload as Record<string, unknown>).not.toHaveProperty("small_edit");
    }
  });
});
