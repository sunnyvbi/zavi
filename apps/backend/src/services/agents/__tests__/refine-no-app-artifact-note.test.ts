import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

const mocks = vi.hoisted(() => ({
  writeNote: vi.fn(),
  hostingReads: 0,
}));

vi.mock("@/services/memory", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, writeNote: mocks.writeNote };
});

vi.mock("@/services/supabase", () => ({
  serviceClient: () => {
    const q: Record<string, unknown> = {};
    for (const m of ["from", "select", "eq", "order"]) q[m] = () => q;
    q.limit = async () => {
      mocks.hostingReads += 1;
      return { data: [{ external_ref: { url: "https://acme.zaviagent.com" } }], error: null };
    };
    return q;
  },
}));

vi.mock("@/services/settings", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    getBoolSetting: vi.fn(async (key: string) => key === "refine_direct_merge_enabled"),
  };
});

import { ingestAppArtifact } from "@/services/agents/conductor-driver";
import {
  refineProduct,
  realRefineProductDeps,
  type RefineProductDeps,
  type PriorRefineTurn,
} from "@/services/agents/refine-product";
import type { ConductorNode } from "@/services/agents/conductor";
import { testSite } from "./fixtures/refine-site";

type MockDeps = RefineProductDeps & { [K in keyof RefineProductDeps]: Mock };

function refineDeps(): MockDeps {
  return {
    loadProvisionedTarget: vi.fn().mockResolvedValue(null),
    listSites: vi.fn().mockResolvedValue([testSite()]),
    loadPriorRefines: vi.fn().mockResolvedValue([] as PriorRefineTurn[]),
    verifyConductorRunOwnership: vi.fn().mockResolvedValue(true),
    loadConductorRunKind: vi.fn().mockResolvedValue("build_app"),
    tryAcquireBuildSlot: vi.fn().mockResolvedValue("cr_refine"),
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

async function refineGraph(): Promise<ConductorNode[]> {
  const d = refineDeps();
  await refineProduct({ tenant_id: "t1", message: "make the header sticky" }, d);
  const call = d.updateConductorRunStatus.mock.calls.find(
    (c) => (c[0] as { status: string }).status === "active",
  );
  return (call![0] as { goal_graph: ConductorNode[] }).goal_graph;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  mocks.writeNote.mockReset();
  mocks.writeNote.mockResolvedValue({ id: "note_1" });
  mocks.hostingReads = 0;
  delete process.env.BUILD_APP_ARTIFACT_INGEST_ENABLED;
});

describe("a shipped refine does not write an app-artifact memory note", () => {
  it("direct-merge refine deploy node going live writes no 'your product' note", async () => {
    const graph = await refineGraph();
    const deploy = graph.find((n) => (n.payload as { stage?: string }).stage === "deploy");
    expect(deploy).toBeDefined();

    ingestAppArtifact({ tenant_id: "t1", graph, deploy_node: deploy! });
    await settle();

    expect(mocks.writeNote).not.toHaveBeenCalled();
    expect(mocks.hostingReads).toBe(0);
  });

  it("a first build going live still writes the real app note", async () => {
    const graph = [
      {
        id: "scaffold",
        status: "done",
        target_agent_slug: "engineer",
        payload: {
          stage: "scaffold",
          company_name: "Acme Rentals",
          idea: "peer to peer camera rentals",
          target: {
            repo_url: "https://github.com/praxis-build/acme",
            github_full_name: "praxis-build/acme",
            default_branch: "main",
          },
        },
      },
      { id: "deploy", status: "pending", target_agent_slug: "engineer", payload: { stage: "deploy" } },
    ] as unknown as ConductorNode[];

    ingestAppArtifact({ tenant_id: "t1", graph, deploy_node: graph[1] });
    await settle();

    expect(mocks.writeNote).toHaveBeenCalledTimes(1);
    const [tenant, note] = mocks.writeNote.mock.calls[0] as [string, { title: string; body_markdown: string }];
    expect(tenant).toBe("t1");
    expect(note.title).toBe("Acme Rentals — built app");
    expect(note.title).not.toContain("your product");
  });
});
