import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  patches: [] as Array<Record<string, unknown>>,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  pausedRow: null as Record<string, unknown> | null,
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      h.rpcCalls.push({ fn, args });
      return { data: "resumed", error: null };
    },
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      let mode: "select" | "update" = "select";
      q.select = () => q;
      q.update = (p: Record<string, unknown>) => {
        mode = "update";
        h.patches.push(p);
        return q;
      };
      for (const m of ["eq", "neq", "lt", "gt", "in"]) q[m] = () => q;
      q.maybeSingle = async () => ({ data: table === "conductor_runs" ? h.pausedRow : null, error: null });
      q.then = (res: (v: { data: unknown; error: null }) => unknown) =>
        res({ data: mode === "update" ? [{ id: "run-1" }] : [], error: null });
      return q;
    },
  }),
}));

import { realStartProductBuildDeps } from "../start-product-build";
import { realActivateReserved, realRefineProductDeps } from "../refine-product";
import { continueBuild } from "../continue-build";
import type { ConductorNode } from "../conductor";

const node = (id: string, status: ConductorNode["status"], payload: Record<string, unknown> = {}): ConductorNode => ({
  id,
  status,
  target_agent_slug: "engineer",
  payload: { stage: id, ...payload },
  estimate_usd: 1,
  child_run_id: null,
});

const ownerOf = (graph: unknown) => ((graph as ConductorNode[])[0].payload as Record<string, unknown>).owner_worker;

beforeEach(() => {
  vi.stubEnv("PRAXIS_CONTAINER_ROLE", "");
  vi.stubEnv("HOSTNAME", "laptop");
  h.patches.length = 0;
  h.rpcCalls.length = 0;
  h.pausedRow = null;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("every build_app creator stamps the owner on node 0", () => {
  it("new build and fast-build activation (start-product-build)", async () => {
    await realStartProductBuildDeps.updateConductorRunStatus({
      conductor_run_id: "run-1",
      status: "active",
      goal_graph: [node("provision", "done"), node("build", "pending")],
    });
    expect(ownerOf(h.patches[0].goal_graph)).toBe("dev:laptop");
    expect((h.patches[0].goal_graph as ConductorNode[])[1].payload).not.toHaveProperty("owner_worker");
  });

  it("a Publish press's reserved republish run is stamped when it goes active, so another laptop's ticker skips it", async () => {
    const result = await realActivateReserved({
      conductor_run_id: "run-1",
      goal_graph: [node("site-republish", "pending", { republish: true, publish_request: true }), node("next", "pending")],
    });
    expect(result).toBe("activated");
    const patch = h.patches.find((p) => p.status === "active");
    expect(patch).toBeDefined();
    expect(ownerOf(patch!.goal_graph)).toBe("dev:laptop");
    expect((patch!.goal_graph as ConductorNode[])[1].payload).not.toHaveProperty("owner_worker");
    expect(((patch!.goal_graph as ConductorNode[])[0].payload as Record<string, unknown>).republish).toBe(true);
  });

  it("a republish run already owned by another worker keeps its owner on activation", async () => {
    await realActivateReserved({
      conductor_run_id: "run-1",
      goal_graph: [node("site-republish", "pending", { owner_worker: "prod:api-1" })],
    });
    expect(ownerOf(h.patches.find((p) => p.status === "active")!.goal_graph)).toBe("prod:api-1");
  });

  it("refine and site republish activation (refine-product)", async () => {
    await realRefineProductDeps.updateConductorRunStatus({
      conductor_run_id: "run-1",
      status: "active",
      goal_graph: [node("refine-x", "pending", { refine_mode: true })],
    });
    expect(ownerOf(h.patches[0].goal_graph)).toBe("dev:laptop");
  });

  it("the canonical container stamps 'canonical'", async () => {
    vi.stubEnv("PRAXIS_CONTAINER_ROLE", "canonical");
    await realRefineProductDeps.updateConductorRunStatus({
      conductor_run_id: "run-1",
      status: "active",
      goal_graph: [node("refine-x", "pending")],
    });
    expect(ownerOf(h.patches[0].goal_graph)).toBe("canonical");
  });

  it("a failure write never touches the graph", async () => {
    await realRefineProductDeps.updateConductorRunStatus({ conductor_run_id: "run-1", status: "failed" });
    expect(h.patches[0]).not.toHaveProperty("goal_graph");
  });

  it("a resumed build is re-stamped to the worker that resumed it", async () => {
    const NOW = Date.parse("2026-10-02T10:00:00Z");
    const site = "dddddddd-0000-4000-8000-00000000000d";
    h.pausedRow = {
      id: "run-1",
      tenant_id: "t1",
      kind: "build_app",
      status: "paused",
      created_at: new Date(NOW - 3_600_000).toISOString(),
      updated_at: new Date(NOW - 60_000).toISOString(),
      paused_at: new Date(NOW - 60_000).toISOString(),
      goal_graph: [
        node("build", "done", { site_id: site, owner_worker: "canonical" }),
        node("deploy", "failed", { site_id: site }),
      ],
    };
    await continueBuild("t1", "run-1", NOW);
    expect(ownerOf(h.rpcCalls[0].args.p_goal_graph)).toBe("dev:laptop");
  });
});
