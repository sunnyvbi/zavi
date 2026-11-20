
import { describe, it, expect, vi } from "vitest";
import {
  conductorTick,
  type ConductorRow,
  type ConductorNode,
  type ConductorTickDeps,
  type ChildTerminalStatus,
  type RepairConfig,
} from "../conductor";

function node(over: Partial<ConductorNode> & { id: string }): ConductorNode {
  return {
    status: "pending",
    target_agent_slug: "engineer",
    payload: { stage: "build" },
    estimate_usd: 3,
    child_run_id: null,
    ...over,
  };
}

function row(over: Partial<ConductorRow> & { goal_graph: ConductorNode[] }): ConductorRow {
  return {
    id: "cond-1",
    tenant_id: "t1",
    objective: "build product",
    status: "active",
    max_usd: 100,
    spend_usd: 0,
    kind: "build_app",
    ...over,
  };
}

const REPAIR_ON: RepairConfig = {
  enabled: true,
  maxAttempts: 3,
  repairableStages: ["scaffold", "build", "qa"],
};

type DepOverrides = Partial<ConductorTickDeps> & { row: ConductorRow | null };

function makeDeps(opts: DepOverrides): ConductorTickDeps {
  return {
    load: vi.fn(async () => opts.row),
    childStatus: opts.childStatus ?? vi.fn(async () => "running" as ChildTerminalStatus),
    consumeBudget: opts.consumeBudget ?? vi.fn(async () => "charged"),
    dispatch: opts.dispatch ?? vi.fn(async () => ({ ok: true as const, child_run_id: "child-x" })),
    saveGraph: opts.saveGraph ?? vi.fn(async () => {}),
    setStatus: opts.setStatus ?? vi.fn(async () => {}),
    repairConfig: opts.repairConfig,
    captureFailureSignal: opts.captureFailureSignal,
    dispatchRepair: opts.dispatchRepair,
  };
}

describe("conductorTick — B2 bounded repair loop", () => {
  it("a failed qa node triggers a fix+rebuild repair dispatch (gated by the cap), converging within cap", async () => {
    const consumeBudget = vi.fn(async () => "charged" as const);
    const captureFailureSignal = vi.fn(async () => "assertion failed: expected 200 got 500 on /api/health");
    const dispatchRepair = vi.fn(async () => ({ ok: true as const, child_run_id: "repair-1" }));
    const saveGraph = vi.fn(async () => {});
    const deps = makeDeps({
      row: row({
        goal_graph: [
          node({ id: "build", status: "done", payload: { stage: "build" } }),
          node({ id: "qa", status: "failed", child_run_id: "qa-child-1", payload: { stage: "qa" } }),
        ],
      }),
      repairConfig: REPAIR_ON,
      captureFailureSignal,
      dispatchRepair,
      consumeBudget,
      saveGraph,
    });

    const r = await conductorTick("cond-1", deps);

    expect(r).toEqual({
      action: "repair_dispatched",
      node_id: "qa",
      child_run_id: "repair-1",
      attempt: 1,
    });
    expect(consumeBudget).toHaveBeenCalledWith("cond-1", 3);
    expect(dispatchRepair).toHaveBeenCalledWith(
      expect.objectContaining({
        failure_signal: expect.stringContaining("expected 200 got 500"),
        node_id: "qa",
        attempt: 1,
        payload: expect.objectContaining({ refine_mode: true, repair_mode: true, repair_attempt: 1 }),
      }),
    );
    expect(saveGraph).toHaveBeenCalledWith(
      "cond-1",
      [
        expect.objectContaining({ id: "build", status: "done" }),
        expect.objectContaining({
          id: "qa",
          status: "dispatched",
          child_run_id: "repair-1",
          repair_attempts: 1,
          last_failure_signal: expect.stringContaining("expected 200 got 500"),
        }),
      ],
      0,
    );
    expect(deps.setStatus).not.toHaveBeenCalled();
  });

  it("enriches a qa-node repair payload with the product idea/company_name from a sibling (qa payload has no idea of its own)", async () => {
    const dispatchRepair = vi.fn(async () => ({ ok: true as const, child_run_id: "repair-qa" }));
    const deps = makeDeps({
      row: row({
        goal_graph: [
          node({
            id: "build",
            status: "done",
            payload: { stage: "build", idea: "a recipe app", company_name: "ChefBot", target: { github_full_name: "praxis-built/chefbot" } },
          }),
          node({
            id: "qa",
            status: "failed",
            child_run_id: "qa-c1",
            payload: { stage: "qa", target: { github_full_name: "praxis-built/chefbot" } },
          }),
        ],
      }),
      repairConfig: REPAIR_ON,
      captureFailureSignal: vi.fn(async () => "qa: GET /recipes returned 500"),
      dispatchRepair,
    });

    const r = await conductorTick("cond-1", deps);
    expect((r as { action: string }).action).toBe("repair_dispatched");
    expect(dispatchRepair).toHaveBeenCalledWith(
      expect.objectContaining({
        node_id: "qa",
        payload: expect.objectContaining({
          stage: "qa",
          refine_mode: true,
          repair_mode: true,
          idea: "a recipe app",
          company_name: "ChefBot",
          failure_signal: expect.stringContaining("returned 500"),
        }),
      }),
    );
  });

  it("a repaired stage that comes back 'success' reconciles to done and the pipeline continues (convergence)", async () => {
    const deps = makeDeps({
      row: row({
        goal_graph: [
          node({ id: "build", status: "done", payload: { stage: "build" } }),
          node({
            id: "qa",
            status: "dispatched",
            child_run_id: "repair-1",
            repair_attempts: 1,
            payload: { stage: "qa", refine_mode: true },
          }),
        ],
      }),
      repairConfig: REPAIR_ON,
      childStatus: vi.fn(async () => "success" as ChildTerminalStatus),
      dispatchRepair: vi.fn(),
    });

    const r = await conductorTick("cond-1", deps);
    expect(r).toEqual({ action: "completed", final: "done" });
    expect(deps.setStatus).toHaveBeenCalledWith("cond-1", "done");
  });

  it("exhausting the cap fails CLEANLY with the captured root-cause", async () => {
    const captureFailureSignal = vi.fn(async () => "TypeError: cannot read property 'map' of undefined at Page.tsx:42");
    const dispatchRepair = vi.fn();
    const deps = makeDeps({
      row: row({
        goal_graph: [
          node({ id: "spec", status: "done", payload: { stage: "spec" } }),
          node({
            id: "build",
            status: "failed",
            child_run_id: "build-child-4",
            repair_attempts: 3,
            payload: { stage: "build" },
          }),
          node({ id: "qa", status: "pending", payload: { stage: "qa" } }),
        ],
      }),
      repairConfig: REPAIR_ON,
      captureFailureSignal,
      dispatchRepair,
    });

    const r = await conductorTick("cond-1", deps);
    expect(r).toEqual({
      action: "completed_after_repair_exhausted",
      node_id: "build",
      root_cause: expect.stringContaining("TypeError: cannot read property 'map'"),
      attempts: 3,
    });
    expect(deps.setStatus).toHaveBeenCalledWith(
      "cond-1",
      "failed",
      expect.objectContaining({
        failure_class: expect.any(String),
        failure_reason: expect.any(String),
      }),
    );
    expect(dispatchRepair).not.toHaveBeenCalled();
    expect(deps.consumeBudget).not.toHaveBeenCalled();
  });

  it("budget cap respected — an over_cap repair HALTS and never dispatches the fix", async () => {
    const consumeBudget = vi.fn(async () => "over_cap" as const);
    const dispatchRepair = vi.fn();
    const deps = makeDeps({
      row: row({
        goal_graph: [
          node({ id: "build", status: "failed", child_run_id: "bc-1", payload: { stage: "build" } }),
        ],
      }),
      repairConfig: REPAIR_ON,
      captureFailureSignal: vi.fn(async () => "out of memory"),
      dispatchRepair,
      consumeBudget,
    });

    const r = await conductorTick("cond-1", deps);
    expect(r).toEqual({ action: "halted" });
    expect(consumeBudget).toHaveBeenCalledOnce();
    expect(dispatchRepair).not.toHaveBeenCalled();
    expect(deps.setStatus).not.toHaveBeenCalled();
  });

  it("counts attempts across multiple failures (1 → 2 → 3) before exhausting", async () => {
    const dispatchRepair = vi.fn(async () => ({ ok: true as const, child_run_id: "repair-2" }));
    const deps = makeDeps({
      row: row({
        goal_graph: [
          node({
            id: "build",
            status: "failed",
            child_run_id: "bc-2",
            repair_attempts: 1,
            payload: { stage: "build" },
          }),
        ],
      }),
      repairConfig: REPAIR_ON,
      captureFailureSignal: vi.fn(async () => "lint error"),
      dispatchRepair,
    });

    const r = await conductorTick("cond-1", deps);
    expect(r).toEqual({
      action: "repair_dispatched",
      node_id: "build",
      child_run_id: "repair-2",
      attempt: 2,
    });
    expect(dispatchRepair).toHaveBeenCalledWith(expect.objectContaining({ attempt: 2 }));
  });

  it("a repair dispatch FAILURE fails the run clean with the dispatch reason (no infinite loop)", async () => {
    const dispatchRepair = vi.fn(async () => ({ ok: false as const, reason: "kill_switch" }));
    const deps = makeDeps({
      row: row({
        goal_graph: [
          node({ id: "build", status: "failed", child_run_id: "bc-3", payload: { stage: "build" } }),
        ],
      }),
      repairConfig: REPAIR_ON,
      captureFailureSignal: vi.fn(async () => "build error"),
      dispatchRepair,
    });

    const r = await conductorTick("cond-1", deps);
    expect(r).toMatchObject({
      action: "completed_after_repair_exhausted",
      node_id: "build",
      attempts: 1,
    });
    expect((r as { root_cause: string }).root_cause).toContain("kill_switch");
    expect(deps.setStatus).toHaveBeenCalledWith(
      "cond-1",
      "failed",
      expect.objectContaining({
        failure_class: expect.any(String),
        failure_reason: expect.any(String),
      }),
    );
  });

  it("falls back to a generic signal when captureFailureSignal returns null / throws", async () => {
    const dispatchRepair = vi.fn(async () => ({ ok: true as const, child_run_id: "repair-9" }));
    const deps = makeDeps({
      row: row({
        goal_graph: [
          node({ id: "scaffold", status: "failed", child_run_id: "sc-1", payload: { stage: "scaffold" } }),
        ],
      }),
      repairConfig: REPAIR_ON,
      captureFailureSignal: vi.fn(async () => {
        throw new Error("read boom");
      }),
      dispatchRepair,
    });

    const r = await conductorTick("cond-1", deps);
    expect((r as { action: string }).action).toBe("repair_dispatched");
    expect(dispatchRepair).toHaveBeenCalledWith(
      expect.objectContaining({ failure_signal: 'stage "scaffold" failed' }),
    );
  });

  it("does NOT repair a failed provision/spec node — falls through to the original fail-fast short-circuit", async () => {
    const dispatchRepair = vi.fn();
    const deps = makeDeps({
      row: row({
        goal_graph: [
          node({ id: "spec", status: "failed", child_run_id: "spec-1", payload: { stage: "spec" } }),
          node({ id: "scaffold", status: "pending", payload: { stage: "scaffold" } }),
        ],
      }),
      repairConfig: REPAIR_ON,
      captureFailureSignal: vi.fn(async () => "spec parse error"),
      dispatchRepair,
    });

    const r = await conductorTick("cond-1", deps);
    expect(r).toEqual({ action: "completed", final: "failed" });
    expect(dispatchRepair).not.toHaveBeenCalled();
    expect(deps.setStatus).toHaveBeenCalledWith(
      "cond-1",
      "failed",
      expect.objectContaining({
        failure_class: expect.any(String),
        failure_reason: expect.any(String),
      }),
    );
  });

  it("does NOT repair while a node is still in flight (waits for it to settle first)", async () => {
    const dispatchRepair = vi.fn();
    const deps = makeDeps({
      row: row({
        goal_graph: [
          node({ id: "build", status: "failed", child_run_id: "bc-4", payload: { stage: "build" } }),
          node({ id: "qa", status: "dispatched", child_run_id: "qa-c", payload: { stage: "qa" } }),
        ],
      }),
      repairConfig: REPAIR_ON,
      childStatus: vi.fn(async () => "running" as ChildTerminalStatus),
      captureFailureSignal: vi.fn(async () => "x"),
      dispatchRepair,
    });

    const r = await conductorTick("cond-1", deps);
    expect(r).toEqual({ action: "waiting", in_flight: 1 });
    expect(dispatchRepair).not.toHaveBeenCalled();
  });

  it("repair config absent → original silent-stall short-circuit fires (no behavior change)", async () => {
    const dispatchRepair = vi.fn();
    const deps = makeDeps({
      row: row({
        goal_graph: [
          node({ id: "build", status: "failed", payload: { stage: "build" } }),
          node({ id: "qa", status: "pending", payload: { stage: "qa" } }),
        ],
      }),
      dispatchRepair,
    });
    const r = await conductorTick("cond-1", deps);
    expect(r).toEqual({ action: "completed", final: "failed" });
    expect(dispatchRepair).not.toHaveBeenCalled();
  });

  it("repair config {enabled:false} → inert, original short-circuit fires", async () => {
    const dispatchRepair = vi.fn();
    const deps = makeDeps({
      row: row({
        goal_graph: [node({ id: "build", status: "failed", payload: { stage: "build" } })],
      }),
      repairConfig: { enabled: false, maxAttempts: 3, repairableStages: ["build"] },
      dispatchRepair,
    });
    const r = await conductorTick("cond-1", deps);
    expect(r).toEqual({ action: "completed", final: "failed" });
    expect(dispatchRepair).not.toHaveBeenCalled();
  });

  it("regression: happy-path 5-node graph (all done) still completes 'done' with repair enabled", async () => {
    const deps = makeDeps({
      row: row({
        goal_graph: [
          node({ id: "provision", status: "done", payload: { stage: "provision" } }),
          node({ id: "spec", status: "done", payload: { stage: "spec" } }),
          node({ id: "scaffold", status: "done", payload: { stage: "scaffold" } }),
          node({ id: "build", status: "done", payload: { stage: "build" } }),
          node({ id: "qa", status: "done", payload: { stage: "qa" } }),
        ],
      }),
      repairConfig: REPAIR_ON,
      dispatchRepair: vi.fn(),
    });
    const r = await conductorTick("cond-1", deps);
    expect(r).toEqual({ action: "completed", final: "done" });
  });
});

describe("conductorTick — a repair that loses its step claim (2026-09-22)", () => {
  it("refunds the repair charge and waits; the build is not failed", async () => {
    const refundBudget = vi.fn(async () => {});
    const saveGraph = vi.fn(async () => {});
    const setStatus = vi.fn(async () => {});
    const deps = makeDeps({
      row: row({
        goal_graph: [
          node({ id: "build", status: "done", payload: { stage: "build" } }),
          node({ id: "qa", status: "failed", child_run_id: "qa-child-1", payload: { stage: "qa" } }),
        ],
      }),
      repairConfig: REPAIR_ON,
      captureFailureSignal: vi.fn(async () => "boom"),
      dispatchRepair: vi.fn(async () => ({ ok: false as const, reason: "dispatch_in_flight" })),
      saveGraph,
      setStatus,
    });
    deps.refundBudget = refundBudget;

    expect(await conductorTick("cond-1", deps)).toEqual({ action: "waiting", in_flight: 1 });
    expect(refundBudget).toHaveBeenCalledWith("cond-1", 3, expect.stringMatching(/^tick:.+:qa$/));
    expect(setStatus).not.toHaveBeenCalled();
    expect(saveGraph).not.toHaveBeenCalled();
  });

  it("a repair that fails to start still fails as before, with its charge refunded", async () => {
    const refundBudget = vi.fn(async () => {});
    const setStatus = vi.fn(async () => {});
    const deps = makeDeps({
      row: row({
        goal_graph: [
          node({ id: "build", status: "done", payload: { stage: "build" } }),
          node({ id: "qa", status: "failed", child_run_id: "qa-child-1", payload: { stage: "qa" } }),
        ],
      }),
      repairConfig: REPAIR_ON,
      captureFailureSignal: vi.fn(async () => "boom"),
      dispatchRepair: vi.fn(async () => ({ ok: false as const, reason: "enqueue_failed" })),
      setStatus,
    });
    deps.refundBudget = refundBudget;

    expect(await conductorTick("cond-1", deps)).toMatchObject({ action: "completed_after_repair_exhausted" });
    expect(refundBudget).toHaveBeenCalledOnce();
    expect(setStatus).toHaveBeenCalledWith("cond-1", "paused", expect.anything());
  });
});
