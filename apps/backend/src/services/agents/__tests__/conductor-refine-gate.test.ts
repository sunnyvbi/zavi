
import { describe, it, expect, vi } from "vitest";
import {
  conductorTick,
  type ConductorRow,
  type ConductorNode,
  type ConductorTickDeps,
  type ChildTerminalStatus,
} from "../conductor";

function node(over: Partial<ConductorNode> & { id: string }): ConductorNode {
  return {
    status: "pending",
    target_agent_slug: "engineer",
    payload: { task: "do" },
    estimate_usd: 1,
    child_run_id: null,
    ...over,
  };
}

function buildAppRow(over: Partial<ConductorRow> & { goal_graph: ConductorNode[] }): ConductorRow {
  return {
    id: "cond-1",
    tenant_id: "t1",
    objective: "[refine] make it sticky",
    status: "active",
    max_usd: 100,
    spend_usd: 0,
    kind: "build_app",
    ...over,
  };
}

function makeDeps(opts: {
  row: ConductorRow;
  childStatuses?: Record<string, ChildTerminalStatus>;
  resolveRefineGate?: ConductorTickDeps["resolveRefineGate"];
  cap?: "charged" | "over_cap";
}): ConductorTickDeps {
  const childStatuses = opts.childStatuses ?? {};
  return {
    load: vi.fn(async () => opts.row),
    childStatus: vi.fn(async (id: string) => childStatuses[id] ?? "running"),
    consumeBudget: vi.fn(async () => opts.cap ?? "charged"),
    dispatch: vi.fn(async () => ({ ok: true as const, child_run_id: "qa-child" })),
    saveGraph: vi.fn(async () => {}),
    setStatus: vi.fn(async () => {}),
    resolveRefineGate: opts.resolveRefineGate,
  };
}

function gateGraph(qaStatus: "dispatched"): ConductorNode[] {
  return [
    node({ id: "eng", status: "done", target_agent_slug: "engineer", child_run_id: "eng-child", payload: { stage: "build", defer_pr: true } }),
    node({
      id: "gate",
      status: qaStatus,
      target_agent_slug: "qa",
      child_run_id: "qa-child",
      payload: { stage: "refine_gate", refine_message: "make it sticky" },
    }),
  ];
}

describe("conductor refine_gate hook", () => {
  it("qa child success → resolveRefineGate called with engineer + qa child; node done; run completes", async () => {
    const resolveRefineGate = vi.fn(async (_input: unknown) => ({ resolved: true }));
    const deps = makeDeps({
      row: buildAppRow({ goal_graph: gateGraph("dispatched") }),
      childStatuses: { "qa-child": "success" },
      resolveRefineGate,
    });
    const r = await conductorTick("cond-1", deps);
    expect(resolveRefineGate).toHaveBeenCalledTimes(1);
    expect(resolveRefineGate.mock.calls[0][0]).toMatchObject({
      tenant_id: "t1",
      conductor_run_id: "cond-1",
      engineer_run_id: "eng-child",
      qa_run_id: "qa-child",
    });
    expect(r).toEqual({ action: "completed", final: "done" });
  });

  it("qa child FAILED still resolves the gate (a preview infra failure must not fail the refine)", async () => {
    const resolveRefineGate = vi.fn(async () => ({ resolved: true }));
    const deps = makeDeps({
      row: buildAppRow({ goal_graph: gateGraph("dispatched") }),
      childStatuses: { "qa-child": "failed" },
      resolveRefineGate,
    });
    const r = await conductorTick("cond-1", deps);
    expect(resolveRefineGate).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ action: "completed", final: "done" });
  });

  it("a resolver throw is swallowed — the gate node still completes", async () => {
    const resolveRefineGate = vi.fn(async () => {
      throw new Error("resolver blip");
    });
    const deps = makeDeps({
      row: buildAppRow({ goal_graph: gateGraph("dispatched") }),
      childStatuses: { "qa-child": "success" },
      resolveRefineGate,
    });
    const r = await conductorTick("cond-1", deps);
    expect(resolveRefineGate).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ action: "completed", final: "done" });
  });

  it("dispatching a PENDING refine_gate node consumes budget (not the no-dispatch deploy sentinel)", async () => {
    const graph = [
      node({ id: "eng", status: "done", target_agent_slug: "engineer", child_run_id: "eng-child", payload: { stage: "build", defer_pr: true } }),
      node({ id: "gate", status: "pending", target_agent_slug: "qa", estimate_usd: 1, payload: { stage: "refine_gate", refine_message: "x" } }),
    ];
    const deps = makeDeps({
      row: buildAppRow({ goal_graph: graph }),
      childStatuses: { "eng-child": "success" },
      resolveRefineGate: vi.fn(async () => ({ resolved: true })),
    });
    const r = await conductorTick("cond-1", deps);
    expect(deps.consumeBudget).toHaveBeenCalledWith("cond-1", 1);
    expect(deps.dispatch).toHaveBeenCalledTimes(1);
    const dispatchArg = (deps.dispatch as unknown as { mock: { calls: Array<[{ target_agent_slug: string }]> } }).mock.calls[0][0];
    expect(dispatchArg.target_agent_slug).toBe("qa");
    expect(r).toMatchObject({ action: "dispatched" });
  });
});
