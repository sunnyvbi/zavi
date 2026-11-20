import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

const setting = vi.hoisted(() => ({ value: true as boolean, reads: [] as string[] }));

vi.mock("@/services/settings", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    getBoolSetting: vi.fn(async (key: string) => {
      setting.reads.push(key);
      if (key === "refine_direct_merge_enabled") return setting.value;
      return false;
    }),
  };
});

import {
  refineProduct,
  realRefineProductDeps,
  type RefineProductDeps,
  type PriorRefineTurn,
} from "@/services/agents/refine-product";
import { resolveRefineDirectMerge } from "@/agents/engineer/post-run";
import { testSite } from "@/services/agents/__tests__/fixtures/refine-site";

type MockDeps = RefineProductDeps & { [K in keyof RefineProductDeps]: Mock };

function deps(): MockDeps {
  return {
    loadProvisionedTarget: vi.fn().mockResolvedValue(null),
    listSites: vi.fn().mockResolvedValue([testSite()]),
    loadPriorRefines: vi.fn().mockResolvedValue([] as PriorRefineTurn[]),
    verifyConductorRunOwnership: vi.fn().mockResolvedValue(true),
    loadConductorRunKind: vi.fn().mockResolvedValue("build_app"),
    tryAcquireBuildSlot: vi.fn().mockResolvedValue("cr_1"),
    updateConductorRunStatus: vi.fn().mockResolvedValue(undefined),
    resolveDailyCap: vi.fn().mockResolvedValue(0),
    loadRepoHeadSha: vi.fn().mockResolvedValue("sha_before"),
    resolveRefineDirectMergeEnabled: vi.fn(realRefineProductDeps.resolveRefineDirectMergeEnabled),
    isFleetHalted: vi.fn().mockResolvedValue(false),
    loadAppPolicy: vi
      .fn()
      .mockResolvedValue({ protected_globs: [], freeze: false, preview: "branch_preview" }),
  } as unknown as MockDeps;
}

type Node = { target_agent_slug: string; payload: Record<string, unknown> };

async function enqueue(d: MockDeps): Promise<Node[]> {
  await refineProduct({ tenant_id: "t1", message: "make the header sticky" }, d);
  const call = d.updateConductorRunStatus.mock.calls.find(
    (c) => (c[0] as { status: string }).status === "active",
  );
  return (call![0] as { goal_graph: Node[] }).goal_graph;
}

function directMergeReads(): number {
  return setting.reads.filter((k) => k === "refine_direct_merge_enabled").length;
}

beforeEach(() => {
  setting.reads = [];
});

describe("refine direct-merge is decided once, at enqueue", () => {
  it("setting flips OFF mid-run: post-run still pushes to main, so the deploy gate the graph waits on is fed", async () => {
    setting.value = true;
    const graph = await enqueue(deps());
    expect(graph.map((n) => n.payload.stage)).toEqual(["build", "deploy"]);
    expect(directMergeReads()).toBe(1);

    setting.value = false;
    await expect(resolveRefineDirectMerge(graph[0].payload, "t1")).resolves.toBe(true);
    expect(directMergeReads()).toBe(1);
  });

  it("setting flips ON mid-run: post-run still parks a PR, so a braked run never reports done before its deploy lands", async () => {
    setting.value = false;
    const graph = await enqueue(deps());
    expect(graph).toHaveLength(1);
    expect(graph[0].payload.direct_merge_enabled).toBe(false);

    setting.value = true;
    await expect(resolveRefineDirectMerge(graph[0].payload, "t1")).resolves.toBe(false);
    expect(directMergeReads()).toBe(1);
  });

  it("a refine enqueued before the stamp existed still reads the setting", async () => {
    setting.value = false;
    await expect(
      resolveRefineDirectMerge({ stage: "build", refine_mode: true }, "t1"),
    ).resolves.toBe(false);
    setting.value = true;
    await expect(
      resolveRefineDirectMerge({ stage: "build", refine_mode: true }, "t1"),
    ).resolves.toBe(true);
    expect(directMergeReads()).toBe(2);
  });
});
