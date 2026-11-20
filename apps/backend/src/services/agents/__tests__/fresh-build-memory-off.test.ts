import { describe, it, expect, vi } from "vitest";
import {
  conductorTick,
  type ConductorRow,
  type ConductorNode,
  type ConductorTickDeps,
  type ChildTerminalStatus,
} from "../conductor";
import { buildProductGoalGraph } from "../product-pipeline";
import { readMemoryMode, memoryOff } from "../memory-mode";

const TARGET = {
  github_full_name: "zavi-apps/bikes-t1",
  repo_url: "https://github.com/zavi-apps/bikes-t1",
};

function freshGraph(): ConductorNode[] {
  return buildProductGoalGraph(
    { idea: "A booking site for renting road bikes by the hour", company_name: "Laptop Rentals", tenant_id: "t1" },
    { provisioned: TARGET as never },
  );
}

function row(goal_graph: ConductorNode[]): ConductorRow {
  return {
    id: "cond-new",
    tenant_id: "t1",
    objective: "A booking site for renting road bikes by the hour",
    status: "active",
    max_usd: 100,
    spend_usd: 0,
    kind: "build_app",
    goal_graph,
  };
}

function deps(r: ConductorRow, over: Partial<ConductorTickDeps> = {}): ConductorTickDeps {
  return {
    load: vi.fn(async () => r),
    childStatus: vi.fn(async () => "running" as ChildTerminalStatus),
    consumeBudget: vi.fn(async () => "charged" as const),
    dispatch: vi.fn(async () => ({ ok: true as const, child_run_id: "child-1" })),
    saveGraph: vi.fn(async () => {}),
    setStatus: vi.fn(async () => {}),
    ...over,
  };
}

describe("a fresh build runs its agents with no memory of earlier builds", () => {
  it("the spec agent is dispatched with memory off", async () => {
    const r = row(freshGraph());
    const d = deps(r);
    await conductorTick("cond-new", d);
    const dispatched = (d.dispatch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(dispatched?.payload?.stage).toBe("spec");
    expect(readMemoryMode(dispatched.payload)).toBe("off");
    expect(memoryOff({ memory_mode: readMemoryMode(dispatched.payload) })).toBe(true);
  });

  it("the scaffold and build agents are dispatched with memory off", async () => {
    for (const stage of ["scaffold", "build"]) {
      const graph = freshGraph();
      const idx = graph.findIndex((n) => n.payload.stage === stage);
      graph.forEach((n, i) => {
        if (i < idx) {
          n.status = "done";
          n.child_run_id = null;
        }
      });
      const r = row(graph);
      const d = deps(r);
      await conductorTick("cond-new", d);
      const dispatched = (d.dispatch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      expect(dispatched?.payload?.stage).toBe(stage);
      expect(dispatched.payload.idea).toBe("A booking site for renting road bikes by the hour");
      expect(readMemoryMode(dispatched.payload)).toBe("off");
    }
  });

  it("a repair of a failed scaffold keeps memory off", async () => {
    const graph = freshGraph();
    const idx = graph.findIndex((n) => n.payload.stage === "scaffold");
    graph.forEach((n, i) => {
      if (i < idx) n.status = "done";
    });
    graph[idx].status = "failed";
    graph[idx].child_run_id = "scaffold-child";
    const dispatchRepair = vi.fn(async () => ({ ok: true as const, child_run_id: "repair-1" }));
    const d = deps(row(graph), {
      repairConfig: { enabled: true, maxAttempts: 3, repairableStages: ["scaffold", "build", "qa"] },
      captureFailureSignal: vi.fn(async () => "tsc: Cannot find module './Bikes'"),
      dispatchRepair,
    });
    await conductorTick("cond-new", d);
    expect(dispatchRepair).toHaveBeenCalledTimes(1);
    const repair = (dispatchRepair.mock.calls[0] as unknown as [{ payload: Record<string, unknown> }])[0];
    expect(repair.payload.repair_mode).toBe(true);
    expect(readMemoryMode(repair.payload)).toBe("off");
  });

  it("every node carries memory off, so a deploy acceptance repair that spreads the deploy payload does too", () => {
    for (const n of freshGraph()) expect(readMemoryMode(n.payload)).toBe("off");
  });
});
