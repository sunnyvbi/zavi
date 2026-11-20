import { describe, it, expect, vi } from "vitest";
import {
  conductorTick,
  type ConductorRow,
  type ConductorNode,
  type ConductorTickDeps,
} from "../conductor";
import { mapTickToLedger } from "../conductor-ledger";

function node(over: Partial<ConductorNode> & { id: string }): ConductorNode {
  return {
    status: "pending",
    target_agent_slug: "engineer",
    payload: { stage: "build", idea: "x" },
    estimate_usd: 5,
    child_run_id: null,
    ...over,
  };
}

function row(over: Partial<ConductorRow> & { goal_graph: ConductorNode[] }): ConductorRow {
  return {
    id: "cond-1",
    tenant_id: "t1",
    objective: "ship it",
    status: "active",
    max_usd: 100,
    spend_usd: 0,
    kind: "build_app",
    ...over,
  };
}

function makeDeps(opts: {
  row: ConductorRow | null;
  classVerdict?: "charged" | "over_cap";
  lifetimeVerdict?: "charged" | "over_cap";
  withClassDeps?: boolean;
}) {
  const consumeClassBudget = vi.fn(async () => opts.classVerdict ?? "charged");
  const consumeBudget = vi.fn(async () => opts.lifetimeVerdict ?? "charged");
  const decisionClassForStage = vi.fn((stage: string | null | undefined) =>
    stage === "build" ? "build" : stage === "qa" ? "qa" : null,
  );
  const deps: ConductorTickDeps = {
    load: vi.fn(async () => opts.row),
    childStatus: vi.fn(async () => "running"),
    consumeBudget,
    dispatch: vi.fn(async () => ({ ok: true as const, child_run_id: "child-1" })),
    saveGraph: vi.fn(async () => {}),
    setStatus: vi.fn(async () => {}),
    ...(opts.withClassDeps === false
      ? {}
      : { consumeClassBudget, decisionClassForStage }),
  };
  return { deps, consumeClassBudget, consumeBudget, decisionClassForStage };
}

describe("conductorTick — per-class spend cap (SLICE P0.1)", () => {
  it("UNDER the class cap → dispatches (class checked BEFORE lifetime charge)", async () => {
    const { deps, consumeClassBudget, consumeBudget } = makeDeps({
      row: row({ goal_graph: [node({ id: "n1" })] }),
      classVerdict: "charged",
      lifetimeVerdict: "charged",
    });
    const r = await conductorTick("cond-1", deps);
    expect(r).toEqual({ action: "dispatched", node_id: "n1", child_run_id: "child-1" });
    expect(consumeClassBudget).toHaveBeenCalledWith("t1", "build", 5);
    expect(consumeBudget).toHaveBeenCalledWith("cond-1", 5);
    expect(deps.dispatch).toHaveBeenCalledOnce();
  });

  it("OVER the class cap → class_over_cap, HALTS, does NOT dispatch, does NOT charge lifetime", async () => {
    const { deps, consumeClassBudget, consumeBudget } = makeDeps({
      row: row({ goal_graph: [node({ id: "n1" })] }),
      classVerdict: "over_cap",
    });
    const r = await conductorTick("cond-1", deps);
    expect(r).toEqual({ action: "class_over_cap", node_id: "n1", decision_class: "build" });
    expect(consumeClassBudget).toHaveBeenCalledOnce();
    expect(consumeBudget).not.toHaveBeenCalled();
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(deps.setStatus).toHaveBeenCalledWith(
      "cond-1",
      "halted",
      expect.objectContaining({
        failure_class: expect.any(String),
        failure_reason: expect.any(String),
      }),
    );
  });

  it("the class_over_cap result maps to a 'halted' over_cap ledger row (CHECK-safe)", () => {
    const entry = mapTickToLedger({
      action: "class_over_cap",
      node_id: "n1",
      decision_class: "build",
    });
    expect(entry.action).toBe("halted");
    expect(entry.outcome).toBe("over_cap");
    expect(entry.error).toBe("class_cap:build");
    expect(entry.node_id).toBe("n1");
  });

  it("no per-class deps wired (back-compat) → only the lifetime cap gates", async () => {
    const { deps, consumeBudget } = makeDeps({
      row: row({ goal_graph: [node({ id: "n1" })] }),
      lifetimeVerdict: "charged",
      withClassDeps: false,
    });
    const r = await conductorTick("cond-1", deps);
    expect(r).toEqual({ action: "dispatched", node_id: "n1", child_run_id: "child-1" });
    expect(consumeBudget).toHaveBeenCalledOnce();
    expect(deps.dispatch).toHaveBeenCalledOnce();
  });

  it("stage with no decision_class (deploy/unknown) → per-class check is skipped (charged)", async () => {
    const { deps, consumeClassBudget, consumeBudget } = makeDeps({
      row: row({ goal_graph: [node({ id: "n1", payload: { stage: "spec" } })] }),
    });
    const r = await conductorTick("cond-1", deps);
    expect(r).toEqual({ action: "dispatched", node_id: "n1", child_run_id: "child-1" });
    expect(consumeClassBudget).not.toHaveBeenCalled();
    expect(consumeBudget).toHaveBeenCalledOnce();
  });
});
