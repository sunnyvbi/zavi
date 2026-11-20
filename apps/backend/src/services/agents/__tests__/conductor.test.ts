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

function makeDeps(opts: {
  row: ConductorRow | null;
  childStatuses?: Record<string, ChildTerminalStatus>;
  cap?: "charged" | "over_cap";
  classCap?: "charged" | "over_cap" | "read_error";
  dispatchResult?: { ok: true; child_run_id: string } | { ok: false; reason: string };
  captureFailureSignal?: (child_run_id: string) => Promise<string | null>;
}) {
  const childStatuses = opts.childStatuses ?? {};
  const deps: ConductorTickDeps = {
    load: vi.fn(async () => opts.row),
    childStatus: vi.fn(async (id: string) => childStatuses[id] ?? "running"),
    consumeBudget: vi.fn(async () => opts.cap ?? "charged"),
    dispatch: vi.fn(async () => opts.dispatchResult ?? { ok: true as const, child_run_id: "child-1" }),
    saveGraph: vi.fn(async () => {}),
    setStatus: vi.fn(async () => {}),
    captureFailureSignal: opts.captureFailureSignal,
    now: () => Date.parse("2026-07-22T00:00:03.000Z"),
    ...(opts.classCap
      ? {
          consumeClassBudget: vi.fn(async () => opts.classCap!),
          decisionClassForStage: vi.fn(() => "build"),
        }
      : {}),
  };
  return deps;
}

function row(over: Partial<ConductorRow> & { goal_graph: ConductorNode[] }): ConductorRow {
  return {
    id: "cond-1",
    tenant_id: "t1",
    objective: "ship it",
    status: "active",
    max_usd: 100,
    spend_usd: 0,
    ...over,
  };
}

describe("conductorTick", () => {
  it("noop when the conductor is missing", async () => {
    const deps = makeDeps({ row: null });
    expect(await conductorTick("cond-1", deps)).toEqual({ action: "noop", reason: "missing" });
    expect(deps.consumeBudget).not.toHaveBeenCalled();
  });

  it("noop when the conductor is not active (halted/done)", async () => {
    const deps = makeDeps({ row: row({ status: "halted", goal_graph: [node({ id: "n1" })] }) });
    expect(await conductorTick("cond-1", deps)).toEqual({ action: "noop", reason: "halted" });
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it("dispatches the next pending node when the cap allows (charged)", async () => {
    const deps = makeDeps({
      row: row({ goal_graph: [node({ id: "n1" })] }),
      cap: "charged",
      dispatchResult: { ok: true, child_run_id: "child-9" },
    });
    const r = await conductorTick("cond-1", deps);
    expect(r).toEqual({ action: "dispatched", node_id: "n1", child_run_id: "child-9" });
    expect(deps.consumeBudget).toHaveBeenCalledWith("cond-1", 1);
    expect(deps.dispatch).toHaveBeenCalledOnce();
    expect(deps.saveGraph).toHaveBeenCalledWith(
      "cond-1",
      [expect.objectContaining({
        id: "n1",
        status: "dispatched",
        child_run_id: "child-9",
        started_at: "2026-07-22T00:00:03.000Z",
        error: null,
      })],
      0,
    );
  });

  it("HALTS without dispatching when the cap rejects (over_cap)", async () => {
    const deps = makeDeps({ row: row({ goal_graph: [node({ id: "n1" })] }), cap: "over_cap" });
    const r = await conductorTick("cond-1", deps);
    expect(r).toEqual({ action: "halted" });
    expect(deps.consumeBudget).toHaveBeenCalledOnce();
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it("class cap READ_ERROR → stays ACTIVE (no halt), no dispatch, retries next tick", async () => {
    const deps = makeDeps({ row: row({ goal_graph: [node({ id: "n1" })] }), classCap: "read_error" });
    const r = await conductorTick("cond-1", deps);
    expect(r).toEqual({ action: "class_read_error", node_id: "n1", decision_class: "build" });
    expect(deps.setStatus).not.toHaveBeenCalled();
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(deps.consumeBudget).not.toHaveBeenCalled();
    expect(deps.saveGraph).toHaveBeenCalledOnce();
  });

  it("class cap OVER_CAP (real breach) → HALTS (unchanged money-stop), no dispatch, no lifetime charge", async () => {
    const deps = makeDeps({ row: row({ goal_graph: [node({ id: "n1" })] }), classCap: "over_cap" });
    const r = await conductorTick("cond-1", deps);
    expect(r).toEqual({ action: "class_over_cap", node_id: "n1", decision_class: "build" });
    expect(deps.setStatus).toHaveBeenCalledWith(
      "cond-1",
      "halted",
      expect.objectContaining({
        failure_class: expect.any(String),
        failure_reason: expect.any(String),
      }),
    );
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(deps.consumeBudget).not.toHaveBeenCalled();
  });

  it("class cap CHARGED → proceeds to the lifetime cap + dispatches", async () => {
    const deps = makeDeps({
      row: row({ goal_graph: [node({ id: "n1" })] }),
      classCap: "charged",
      cap: "charged",
    });
    const r = await conductorTick("cond-1", deps);
    expect(r).toEqual({ action: "dispatched", node_id: "n1", child_run_id: "child-1" });
    expect(deps.consumeBudget).toHaveBeenCalledOnce();
    expect(deps.dispatch).toHaveBeenCalledOnce();
  });

  it("waits (no dispatch) while a node is still in flight (strict sequential)", async () => {
    const deps = makeDeps({
      row: row({ goal_graph: [node({ id: "n1", status: "dispatched", child_run_id: "c1" }), node({ id: "n2" })] }),
      childStatuses: { c1: "running" },
    });
    const r = await conductorTick("cond-1", deps);
    expect(r).toEqual({ action: "waiting", in_flight: 1 });
    expect(deps.consumeBudget).not.toHaveBeenCalled();
  });

  it("reconciles a finished child (success → done) then waits for the rest", async () => {
    const deps = makeDeps({
      row: row({ goal_graph: [node({ id: "n1", status: "dispatched", child_run_id: "c1" })] }),
      childStatuses: { c1: "success" },
    });
    const r = await conductorTick("cond-1", deps);
    expect(r).toEqual({ action: "completed", final: "done" });
    expect(deps.setStatus).toHaveBeenCalledWith("cond-1", "done");
    expect(deps.saveGraph).toHaveBeenCalled();
    expect(deps.saveGraph).toHaveBeenCalledWith(
      "cond-1",
      [expect.objectContaining({ finished_at: "2026-07-22T00:00:03.000Z", error: null })],
      0,
    );
  });

  it("captures a failed child reason and stage metadata before terminalizing", async () => {
    const deps = makeDeps({
      row: row({
        kind: "build_app",
        goal_graph: [node({
          id: "spec",
          status: "dispatched",
          child_run_id: "pm-1",
          target_agent_slug: "pm",
          payload: { stage: "spec" },
          started_at: "2026-07-22T00:00:00.000Z",
        })],
      }),
      childStatuses: { "pm-1": "failed" },
      captureFailureSignal: vi.fn(async () => "PRD parse failed at requirements"),
    });
    expect(await conductorTick("cond-1", deps)).toEqual({ action: "completed", final: "failed" });
    expect(deps.saveGraph).toHaveBeenCalledWith(
      "cond-1",
      [expect.objectContaining({
        id: "spec",
        error: "PRD parse failed at requirements",
        last_failure_signal: "PRD parse failed at requirements",
        failure_class: "stage_failed",
        finished_at: "2026-07-22T00:00:03.000Z",
      })],
      0,
    );
  });

  it("completes as 'done' when every node is done", async () => {
    const deps = makeDeps({
      row: row({ goal_graph: [node({ id: "n1", status: "done" }), node({ id: "n2", status: "done" })] }),
    });
    expect(await conductorTick("cond-1", deps)).toEqual({ action: "completed", final: "done" });
    expect(deps.setStatus).toHaveBeenCalledWith("cond-1", "done");
  });

  it("completes as 'failed' when no pending remain and a node failed", async () => {
    const deps = makeDeps({
      row: row({ goal_graph: [node({ id: "n1", status: "done" }), node({ id: "n2", status: "failed" })] }),
    });
    expect(await conductorTick("cond-1", deps)).toEqual({ action: "completed", final: "failed" });
    expect(deps.setStatus).toHaveBeenCalledWith(
      "cond-1",
      "failed",
      expect.objectContaining({
        failure_class: expect.any(String),
        failure_reason: expect.any(String),
      }),
    );
  });

  it("marks the node failed when a2aDispatch fails", async () => {
    const deps = makeDeps({
      row: row({ goal_graph: [node({ id: "n1" })] }),
      cap: "charged",
      dispatchResult: { ok: false, reason: "kill_switch" },
    });
    const r = await conductorTick("cond-1", deps);
    expect(r).toEqual({ action: "dispatch_failed", node_id: "n1", reason: "kill_switch" });
    expect(deps.saveGraph).toHaveBeenCalledWith(
      "cond-1",
      [expect.objectContaining({
        id: "n1",
        status: "failed",
        error: "kill_switch",
        failure_class: "dispatch_failed",
        finished_at: "2026-07-22T00:00:03.000Z",
      })],
      0,
    );
  });

  it("dispatches the FIRST pending node only (sequential), leaving later ones pending", async () => {
    const deps = makeDeps({
      row: row({ goal_graph: [node({ id: "n1", status: "done" }), node({ id: "n2" }), node({ id: "n3" })] }),
      cap: "charged",
      dispatchResult: { ok: true, child_run_id: "c2" },
    });
    const r = await conductorTick("cond-1", deps);
    expect(r).toEqual({ action: "dispatched", node_id: "n2", child_run_id: "c2" });
    expect(deps.dispatch).toHaveBeenCalledOnce();
  });

  it("silent-stall fix: a prior failed node + remaining pending → completed 'failed' (no dispatch)", async () => {
    const deps = makeDeps({
      row: row({
        goal_graph: [
          node({ id: "provision", status: "done" }),
          node({ id: "spec", status: "failed" }),
          node({ id: "scaffold" }),
          node({ id: "build" }),
          node({ id: "qa" }),
        ],
      }),
    });
    const r = await conductorTick("cond-1", deps);
    expect(r).toEqual({ action: "completed", final: "failed" });
    expect(deps.setStatus).toHaveBeenCalledWith(
      "cond-1",
      "failed",
      expect.objectContaining({
        failure_class: expect.any(String),
        failure_reason: expect.any(String),
      }),
    );
    expect(deps.consumeBudget).not.toHaveBeenCalled();
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it("silent-stall fix: all 5 work nodes terminal + ≥1 failed → completed 'failed'", async () => {
    const deps = makeDeps({
      row: row({
        goal_graph: [
          node({ id: "provision", status: "done" }),
          node({ id: "spec", status: "done" }),
          node({ id: "scaffold", status: "done" }),
          node({ id: "build", status: "failed" }),
          node({ id: "qa", status: "done" }),
        ],
      }),
    });
    const r = await conductorTick("cond-1", deps);
    expect(r).toEqual({ action: "completed", final: "failed" });
    expect(deps.setStatus).toHaveBeenCalledWith(
      "cond-1",
      "failed",
      expect.objectContaining({
        failure_class: expect.any(String),
        failure_reason: expect.any(String),
      }),
    );
  });

  it("silent-stall fix: all 5 work nodes failed → completed 'failed'", async () => {
    const deps = makeDeps({
      row: row({
        goal_graph: [
          node({ id: "provision", status: "failed" }),
          node({ id: "spec", status: "failed" }),
          node({ id: "scaffold", status: "failed" }),
          node({ id: "build", status: "failed" }),
          node({ id: "qa", status: "failed" }),
        ],
      }),
    });
    const r = await conductorTick("cond-1", deps);
    expect(r).toEqual({ action: "completed", final: "failed" });
    expect(deps.setStatus).toHaveBeenCalledWith(
      "cond-1",
      "failed",
      expect.objectContaining({
        failure_class: expect.any(String),
        failure_reason: expect.any(String),
      }),
    );
  });

  it("regression: all 5 work nodes done (no failures, no pending) → completed 'done' (unchanged)", async () => {
    const deps = makeDeps({
      row: row({
        goal_graph: [
          node({ id: "provision", status: "done" }),
          node({ id: "spec", status: "done" }),
          node({ id: "scaffold", status: "done" }),
          node({ id: "build", status: "done" }),
          node({ id: "qa", status: "done" }),
        ],
      }),
    });
    const r = await conductorTick("cond-1", deps);
    expect(r).toEqual({ action: "completed", final: "done" });
    expect(deps.setStatus).toHaveBeenCalledWith("cond-1", "done");
  });

  it("silent-stall fix: failed upstream + in-flight downstream → still waits (don't short-circuit while in-flight)", async () => {
    const deps = makeDeps({
      row: row({
        goal_graph: [
          node({ id: "n1", status: "failed" }),
          node({ id: "n2", status: "dispatched", child_run_id: "c2" }),
          node({ id: "n3" }),
        ],
      }),
      childStatuses: { c2: "running" },
    });
    const r = await conductorTick("cond-1", deps);
    expect(r).toEqual({ action: "waiting", in_flight: 1 });
    expect(deps.setStatus).not.toHaveBeenCalled();
  });

  it("[company_goal] reconcile path CALLS updateGoalProgress when a node settles 'success' with goal_id + current_value", async () => {
    const updateGoalProgress = vi.fn(async () => {});
    const deps: ConductorTickDeps = {
      load: vi.fn(async () =>
        row({
          kind: "company_goal",
          goal_graph: [
            node({
              id: "planner",
              status: "dispatched",
              child_run_id: "c-ceo-1",
              payload: { goal_id: "goal-uuid-1", current_value: 142, tenant_id: "t-other" },
            }),
          ],
        }),
      ),
      childStatus: vi.fn(async () => "success"),
      consumeBudget: vi.fn(async () => "charged"),
      dispatch: vi.fn(),
      saveGraph: vi.fn(async () => {}),
      setStatus: vi.fn(async () => {}),
      updateGoalProgress,
    };
    const r = await conductorTick("cond-1", deps);
    expect(r).toEqual({ action: "completed", final: "done" });
    expect(updateGoalProgress).toHaveBeenCalledWith("t1", "goal-uuid-1", 142);
  });

  it("[company_goal] also accepts payload.target_metric_after_reading as the current_value source", async () => {
    const updateGoalProgress = vi.fn(async () => {});
    const deps: ConductorTickDeps = {
      load: vi.fn(async () =>
        row({
          kind: "company_goal",
          goal_graph: [
            node({
              id: "planner",
              status: "dispatched",
              child_run_id: "c-ceo-2",
              payload: { goal_id: "goal-uuid-2", target_metric_after_reading: 7 },
            }),
          ],
        }),
      ),
      childStatus: vi.fn(async () => "success"),
      consumeBudget: vi.fn(async () => "charged"),
      dispatch: vi.fn(),
      saveGraph: vi.fn(async () => {}),
      setStatus: vi.fn(async () => {}),
      updateGoalProgress,
    };
    await conductorTick("cond-1", deps);
    expect(updateGoalProgress).toHaveBeenCalledWith("t1", "goal-uuid-2", 7);
  });

  it("[company_goal] SKIPS updateGoalProgress when goal_id is missing on the node payload (no crash)", async () => {
    const updateGoalProgress = vi.fn(async () => {});
    const deps: ConductorTickDeps = {
      load: vi.fn(async () =>
        row({
          kind: "company_goal",
          goal_graph: [
            node({
              id: "planner",
              status: "dispatched",
              child_run_id: "c-ceo-3",
              payload: { current_value: 99 },
            }),
          ],
        }),
      ),
      childStatus: vi.fn(async () => "success"),
      consumeBudget: vi.fn(async () => "charged"),
      dispatch: vi.fn(),
      saveGraph: vi.fn(async () => {}),
      setStatus: vi.fn(async () => {}),
      updateGoalProgress,
    };
    const r = await conductorTick("cond-1", deps);
    expect(r).toEqual({ action: "completed", final: "done" });
    expect(updateGoalProgress).not.toHaveBeenCalled();
  });

  it("[company_goal] swallows updateGoalProgress errors — never blocks the node-status flip / conductor completion", async () => {
    const updateGoalProgress = vi.fn(async () => {
      throw new Error("rpc boom");
    });
    const deps: ConductorTickDeps = {
      load: vi.fn(async () =>
        row({
          kind: "company_goal",
          goal_graph: [
            node({
              id: "planner",
              status: "dispatched",
              child_run_id: "c-ceo-4",
              payload: { goal_id: "g-x", current_value: 1 },
            }),
          ],
        }),
      ),
      childStatus: vi.fn(async () => "success"),
      consumeBudget: vi.fn(async () => "charged"),
      dispatch: vi.fn(),
      saveGraph: vi.fn(async () => {}),
      setStatus: vi.fn(async () => {}),
      updateGoalProgress,
    };
    const r = await conductorTick("cond-1", deps);
    expect(r).toEqual({ action: "completed", final: "done" });
    expect(updateGoalProgress).toHaveBeenCalledOnce();
  });

  it("[build_app] does NOT call updateGoalProgress even when the dep is wired (kind-gated)", async () => {
    const updateGoalProgress = vi.fn(async () => {});
    const deps: ConductorTickDeps = {
      load: vi.fn(async () =>
        row({
          kind: "build_app",
          goal_graph: [
            node({
              id: "build",
              status: "dispatched",
              child_run_id: "c-build-1",
              payload: { goal_id: "g-z", current_value: 5 },
            }),
          ],
        }),
      ),
      childStatus: vi.fn(async () => "success"),
      consumeBudget: vi.fn(async () => "charged"),
      dispatch: vi.fn(),
      saveGraph: vi.fn(async () => {}),
      setStatus: vi.fn(async () => {}),
      updateGoalProgress,
    };
    await conductorTick("cond-1", deps);
    expect(updateGoalProgress).not.toHaveBeenCalled();
  });

  it("[build_app] a 'held' child ADVANCES like success (build never freezes on needs_review)", async () => {
    const deps = makeDeps({
      row: row({ kind: "build_app", goal_graph: [node({ id: "spec", status: "dispatched", child_run_id: "c1" })] }),
      childStatuses: { c1: "held" },
    });
    const r = await conductorTick("cond-1", deps);
    expect(r).toEqual({ action: "completed", final: "done" });
    expect(deps.setStatus).toHaveBeenCalledWith("cond-1", "done");
  });

  it("[build_app] 'held' on an early node advances it AND dispatches the next pending stage", async () => {
    const deps = makeDeps({
      row: row({
        kind: "build_app",
        goal_graph: [
          node({ id: "spec", status: "dispatched", child_run_id: "c1" }),
          node({ id: "scaffold", status: "pending" }),
        ],
      }),
      childStatuses: { c1: "held" },
      cap: "charged",
      dispatchResult: { ok: true, child_run_id: "child-scaffold" },
    });
    const r = await conductorTick("cond-1", deps);
    expect(r).toEqual({ action: "dispatched", node_id: "scaffold", child_run_id: "child-scaffold" });
    expect(deps.dispatch).toHaveBeenCalledOnce();
  });

  it("[company_goal] a 'held' child STAYS held (grow autonomy review gate unchanged)", async () => {
    const deps = makeDeps({
      row: row({ kind: "company_goal", goal_graph: [node({ id: "n1", status: "dispatched", child_run_id: "c1" })] }),
      childStatuses: { c1: "held" },
    });
    const r = await conductorTick("cond-1", deps);
    expect(r).toEqual({ action: "waiting", in_flight: 1 });
    expect(deps.setStatus).not.toHaveBeenCalled();
  });

});

describe("conductorTick — startPreview fire-and-forget on scaffold done", () => {
  function scaffoldNode(over: Partial<ConductorNode> & { id: string }): ConductorNode {
    return {
      status: "dispatched",
      target_agent_slug: "engineer",
      payload: { stage: "scaffold", target: { github_full_name: "praxis-built/acme" } },
      estimate_usd: 1,
      child_run_id: "c1",
      ...over,
    };
  }

  it("fires startPreview ONCE when the scaffold node settles (build_app)", async () => {
    const startPreview = vi.fn();
    const deps = makeDeps({
      row: row({ kind: "build_app", goal_graph: [scaffoldNode({ id: "n1" })] }),
      childStatuses: { c1: "success" },
    });
    deps.startPreview = startPreview;
    await conductorTick("cond-1", deps);
    expect(startPreview).toHaveBeenCalledOnce();
    expect(startPreview).toHaveBeenCalledWith({
      tenant_id: "t1",
      node: expect.objectContaining({ id: "n1", status: "done" }),
    });
  });

  it("does NOT block the tick even if startPreview's work hangs (sync void return)", async () => {
    const neverResolves = new Promise<void>(() => {});
    const startPreview = vi.fn(() => {
      void neverResolves;
    });
    const deps = makeDeps({
      row: row({ kind: "build_app", goal_graph: [scaffoldNode({ id: "n1" })] }),
      childStatuses: { c1: "success" },
    });
    deps.startPreview = startPreview;
    const r = await conductorTick("cond-1", deps);
    expect(r).toEqual({ action: "completed", final: "done" });
    expect(startPreview).toHaveBeenCalledOnce();
  });

  it("does NOT fire on a non-scaffold stage (e.g. build) settling", async () => {
    const startPreview = vi.fn();
    const deps = makeDeps({
      row: row({
        kind: "build_app",
        goal_graph: [scaffoldNode({ id: "n1", payload: { stage: "build", target: { github_full_name: "x/y" } } })],
      }),
      childStatuses: { c1: "success" },
    });
    deps.startPreview = startPreview;
    await conductorTick("cond-1", deps);
    expect(startPreview).not.toHaveBeenCalled();
  });

  it("does NOT fire for a company_goal conductor (build-only feature)", async () => {
    const startPreview = vi.fn();
    const deps = makeDeps({
      row: row({ kind: "company_goal", goal_graph: [scaffoldNode({ id: "n1" })] }),
      childStatuses: { c1: "success" },
    });
    deps.startPreview = startPreview;
    await conductorTick("cond-1", deps);
    expect(startPreview).not.toHaveBeenCalled();
  });

  it("swallows a throw from startPreview — never affects orchestration", async () => {
    const startPreview = vi.fn(() => {
      throw new Error("boot kick failed");
    });
    const deps = makeDeps({
      row: row({ kind: "build_app", goal_graph: [scaffoldNode({ id: "n1" })] }),
      childStatuses: { c1: "success" },
    });
    deps.startPreview = startPreview;
    const r = await conductorTick("cond-1", deps);
    expect(r).toEqual({ action: "completed", final: "done" });
  });
});

describe("conductorTick — deploy gate (FIX A)", () => {
  function deployGateGraph(): ConductorNode[] {
    return [
      node({ id: "qa", status: "done", payload: { stage: "qa" }, child_run_id: "qa-child" }),
      node({
        id: "deploy",
        status: "pending",
        target_agent_slug: "",
        payload: { stage: "deploy" },
        estimate_usd: 0,
      }),
    ];
  }

  function deployDeps(opts: {
    hosting?: "ready" | "failed" | "provisioning" | "none";
    wireHosting?: boolean;
    kind?: "build_app" | "company_goal";
    graph?: ConductorNode[];
    throwHosting?: boolean;
  }) {
    const consumeBudget = vi.fn(async () => "charged" as const);
    const dispatch = vi.fn(async () => ({ ok: true as const, child_run_id: "x" }));
    const saveGraph = vi.fn(async () => {});
    const setStatus = vi.fn(async () => {});
    const clearInlineEditsOnRefine = vi.fn();
    const hostingStatus = vi.fn(async () => {
      if (opts.throwHosting) throw new Error("transient hosting read failure");
      return opts.hosting ?? "provisioning";
    });
    const deps: ConductorTickDeps = {
      load: vi.fn(async () =>
        row({ kind: opts.kind ?? "build_app", goal_graph: opts.graph ?? deployGateGraph() }),
      ),
      childStatus: vi.fn(async () => "running" as ChildTerminalStatus),
      consumeBudget,
      dispatch,
      saveGraph,
      setStatus,
      clearInlineEditsOnRefine,
      ...(opts.wireHosting === false ? {} : { hostingStatus }),
    };
    return { deps, consumeBudget, dispatch, saveGraph, setStatus, hostingStatus, clearInlineEditsOnRefine };
  }

  it("WAITS (run NOT done) while hosting is 'provisioning' — no dispatch, no budget", async () => {
    const { deps, consumeBudget, dispatch, setStatus, hostingStatus } = deployDeps({
      hosting: "provisioning",
    });
    const r = await conductorTick("cond-1", deps);
    expect(r).toEqual({ action: "waiting", in_flight: 0 });
    expect(hostingStatus).toHaveBeenCalledWith("t1", expect.objectContaining({ id: "deploy" }));
    expect(consumeBudget).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(setStatus).not.toHaveBeenCalled();
  });

  it("WAITS while hosting is 'none' (no hosting row yet) — no dispatch, no budget", async () => {
    const { deps, consumeBudget, dispatch, setStatus } = deployDeps({ hosting: "none" });
    const r = await conductorTick("cond-1", deps);
    expect(r).toEqual({ action: "waiting", in_flight: 0 });
    expect(consumeBudget).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(setStatus).not.toHaveBeenCalled();
  });

  it("a THROWING hostingStatus is caught → treated as 'provisioning' (WAITS, never crashes/completes)", async () => {
    const { deps, consumeBudget, dispatch, setStatus, hostingStatus } = deployDeps({
      throwHosting: true,
    });
    const r = await conductorTick("cond-1", deps);
    expect(r).toEqual({ action: "waiting", in_flight: 0 });
    expect(hostingStatus).toHaveBeenCalledWith("t1", expect.objectContaining({ id: "deploy" }));
    expect(consumeBudget).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(setStatus).not.toHaveBeenCalled();
  });

  it("flips the run 'done' on hosting='ready' — deploy node done, no dispatch/budget", async () => {
    const { deps, consumeBudget, dispatch, setStatus, saveGraph } = deployDeps({ hosting: "ready" });
    const r = await conductorTick("cond-1", deps);
    expect(r).toEqual({ action: "completed", final: "done" });
    expect(setStatus).toHaveBeenCalledWith("cond-1", "done");
    expect(consumeBudget).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    const savedGraph = (saveGraph as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1] as ConductorNode[];
    expect(savedGraph.find((n) => n.id === "deploy")!.status).toBe("done");
  });

  it("SLICE 1.5: a REFINE deploy node going 'ready' clears the tenant's stale inline overrides", async () => {
    const refineGraph: ConductorNode[] = [
      node({ id: "qa", status: "done", payload: { stage: "qa" }, child_run_id: "qa-child" }),
      node({
        id: "deploy",
        status: "pending",
        target_agent_slug: "",
        payload: {
          stage: "deploy",
          pre_refine_sha: "abc123",
          target: { github_full_name: "Praxis-build/x" },
        },
        estimate_usd: 0,
      }),
    ];
    const { deps, clearInlineEditsOnRefine } = deployDeps({ hosting: "ready", graph: refineGraph });
    const r = await conductorTick("cond-1", deps);
    expect(r).toEqual({ action: "completed", final: "done" });
    expect(clearInlineEditsOnRefine).toHaveBeenCalledWith("t1");
  });

  it("a SITE refine going live never clears the frozen old-flow app's inline overrides", async () => {
    const SITE = "aaaaaaaa-0000-4000-8000-000000000001";
    const refineGraph: ConductorNode[] = [
      node({ id: "qa", status: "done", payload: { stage: "qa", site_id: SITE }, child_run_id: "qa-child" }),
      node({
        id: "deploy",
        status: "pending",
        target_agent_slug: "",
        payload: { stage: "deploy", site_id: SITE, pre_refine_sha: "abc123", target: { github_full_name: "Praxis-build/x" } },
        estimate_usd: 0,
      }),
    ];
    const { deps, clearInlineEditsOnRefine } = deployDeps({ hosting: "ready", graph: refineGraph });
    await conductorTick("cond-1", deps);
    expect(clearInlineEditsOnRefine).not.toHaveBeenCalled();
  });

  it("SLICE 1.5: a NORMAL build deploy node (no pre_refine_sha) does NOT clear overrides", async () => {
    const { deps, clearInlineEditsOnRefine } = deployDeps({ hosting: "ready" });
    const r = await conductorTick("cond-1", deps);
    expect(r).toEqual({ action: "completed", final: "done" });
    expect(clearInlineEditsOnRefine).not.toHaveBeenCalled();
  });

  it("flips the run 'failed' on hosting='failed' — stamps last_failure_signal, no dispatch/budget", async () => {
    const { deps, consumeBudget, dispatch, setStatus, saveGraph } = deployDeps({ hosting: "failed" });
    const r = await conductorTick("cond-1", deps);
    expect(r).toEqual({ action: "completed", final: "failed" });
    expect(setStatus).toHaveBeenCalledWith(
      "cond-1",
      "failed",
      expect.objectContaining({
        failure_class: expect.any(String),
        failure_reason: expect.any(String),
      }),
    );
    expect(consumeBudget).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    const savedGraph = (saveGraph as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1] as ConductorNode[];
    const deployNode = savedGraph.find((n) => n.id === "deploy")!;
    expect(deployNode.status).toBe("failed");
    expect(typeof deployNode.last_failure_signal).toBe("string");
    expect(deployNode.last_failure_signal!.length).toBeGreaterThan(0);
  });

  it("NEVER calls consumeBudget or dispatch for the deploy node across all hosting states", async () => {
    for (const hosting of ["ready", "failed", "provisioning", "none"] as const) {
      const { deps, consumeBudget, dispatch } = deployDeps({ hosting });
      await conductorTick("cond-1", deps);
      expect(consumeBudget).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
    }
  });

  it("BACK-COMPAT: hostingStatus absent → deploy resolves 'done' immediately (nothing stalls)", async () => {
    const { deps, setStatus, consumeBudget, dispatch } = deployDeps({ wireHosting: false });
    const r = await conductorTick("cond-1", deps);
    expect(r).toEqual({ action: "completed", final: "done" });
    expect(setStatus).toHaveBeenCalledWith("cond-1", "done");
    expect(consumeBudget).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("NO-REGRESSION: a NORMAL build deploy node (no pre_refine_sha) is passed to hostingStatus unchanged + resolves on its base status", async () => {
    const { deps, setStatus, hostingStatus } = deployDeps({ hosting: "ready" });
    const r = await conductorTick("cond-1", deps);
    expect(r).toEqual({ action: "completed", final: "done" });
    expect(setStatus).toHaveBeenCalledWith("cond-1", "done");
    const passedNode = (hostingStatus as ReturnType<typeof vi.fn>).mock.calls[0][1] as ConductorNode;
    expect(passedNode.id).toBe("deploy");
    expect("pre_refine_sha" in (passedNode.payload as Record<string, unknown>)).toBe(false);
  });

  it("REFINE GATE shape: a deploy node CARRYING pre_refine_sha is passed through to hostingStatus (the impl applies the HEAD-advanced + bound overlay)", async () => {
    const refineGraph: ConductorNode[] = [
      node({ id: "build", status: "done", payload: { stage: "build" }, child_run_id: "c" }),
      node({
        id: "deploy",
        status: "pending",
        target_agent_slug: "",
        payload: {
          stage: "deploy",
          pre_refine_sha: "abc123def",
          refine_deploy_enqueued_at: Date.now(),
          target: { github_full_name: "praxis-built/acme", default_branch: "main" },
        },
        estimate_usd: 0,
      }),
    ];
    const { deps, hostingStatus, setStatus } = deployDeps({
      hosting: "provisioning",
      graph: refineGraph,
    });
    const r = await conductorTick("cond-1", deps);
    expect(r).toEqual({ action: "waiting", in_flight: 0 });
    expect(setStatus).not.toHaveBeenCalled();
    const passedNode = (hostingStatus as ReturnType<typeof vi.fn>).mock.calls[0][1] as ConductorNode;
    expect(passedNode.payload.pre_refine_sha).toBe("abc123def");
  });

  it("does NOT gate a company_goal run — a node payload stage='deploy' there dispatches normally", async () => {
    const graph: ConductorNode[] = [
      node({
        id: "deploy",
        status: "pending",
        target_agent_slug: "engineer",
        payload: { stage: "deploy" },
        estimate_usd: 1,
      }),
    ];
    const { deps, consumeBudget, dispatch, hostingStatus } = deployDeps({
      kind: "company_goal",
      graph,
    });
    const r = await conductorTick("cond-1", deps);
    expect(r).toMatchObject({ action: "dispatched", node_id: "deploy" });
    expect(consumeBudget).toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalled();
    expect(hostingStatus).not.toHaveBeenCalled();
  });
});

describe("conductorTick — refunds a charge that bought no work", () => {
  function withRefunds(deps: ConductorTickDeps, noWork = true, refundThrows = false) {
    deps.refundBudget = vi.fn(async () => {
      if (refundThrows) throw new Error("db blip");
    });
    deps.childDidNoWork = vi.fn(async () => noWork);
    return deps;
  }
  const savedGraph = (deps: ConductorTickDeps) =>
    (deps.saveGraph as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1] as ConductorNode[];

  it("refunds a dispatch that could not start, then fails the node as before", async () => {
    const deps = withRefunds(
      makeDeps({
        row: row({ goal_graph: [node({ id: "n1" })] }),
        dispatchResult: { ok: false, reason: "enqueue_failed" },
      }),
    );
    const r = await conductorTick("cond-1", deps);
    expect(r).toMatchObject({ action: "dispatch_failed", node_id: "n1" });
    expect(deps.refundBudget).toHaveBeenCalledWith("cond-1", 1, expect.stringMatching(/^tick:.+:n1$/));
    expect(savedGraph(deps)[0].last_charge_usd).toBe(0);
  });

  it("a lost step claim refunds and waits, leaving the graph to the tick that owns it", async () => {
    const deps = withRefunds(
      makeDeps({
        row: row({ goal_graph: [node({ id: "n1" })] }),
        dispatchResult: { ok: false, reason: "dispatch_in_flight" },
      }),
    );
    expect(await conductorTick("cond-1", deps)).toEqual({ action: "waiting", in_flight: 1 });
    expect(deps.refundBudget).toHaveBeenCalledOnce();
    expect(deps.saveGraph).not.toHaveBeenCalled();
    expect(deps.setStatus).not.toHaveBeenCalled();
  });

  it("a tick that adopted the winner's run refunds its own duplicate charge", async () => {
    const deps = withRefunds(
      makeDeps({
        row: row({ goal_graph: [node({ id: "n1", estimate_usd: 3 })] }),
        dispatchResult: { ok: true, child_run_id: "winner-run", adopted: true } as never,
      }),
    );
    expect(await conductorTick("cond-1", deps)).toEqual({
      action: "dispatched",
      node_id: "n1",
      child_run_id: "winner-run",
    });
    expect(deps.refundBudget).toHaveBeenCalledWith("cond-1", 3, expect.stringMatching(/^tick:.+:n1$/));
    expect(savedGraph(deps)[0]).toMatchObject({ status: "dispatched", last_charge_usd: 3 });
  });

  it("records the charge on a dispatched node", async () => {
    const deps = withRefunds(makeDeps({ row: row({ goal_graph: [node({ id: "n1", estimate_usd: 3 })] }) }));
    await conductorTick("cond-1", deps);
    expect(savedGraph(deps)[0]).toMatchObject({ status: "dispatched", last_charge_usd: 3 });
    expect(deps.refundBudget).not.toHaveBeenCalled();
  });

  it("refunds a child that died before any model call, keyed by the child run", async () => {
    const deps = withRefunds(
      makeDeps({
        row: row({
          goal_graph: [node({ id: "n1", status: "dispatched", child_run_id: "child-1", last_charge_usd: 1 })],
        }),
        childStatuses: { "child-1": "failed" },
      }),
    );
    await conductorTick("cond-1", deps);
    expect(deps.refundBudget).toHaveBeenCalledWith("cond-1", 1, "child:child-1");
  });

  it("does not refund a child that did real work", async () => {
    const deps = withRefunds(
      makeDeps({
        row: row({
          goal_graph: [node({ id: "n1", status: "dispatched", child_run_id: "child-1", last_charge_usd: 1 })],
        }),
        childStatuses: { "child-1": "failed" },
      }),
      false,
    );
    await conductorTick("cond-1", deps);
    expect(deps.refundBudget).not.toHaveBeenCalled();
  });

  it("keeps the charge recorded when the refund RPC fails (never zeroes an unrefunded charge)", async () => {
    const deps = withRefunds(
      makeDeps({
        row: row({ goal_graph: [node({ id: "n1" })] }),
        dispatchResult: { ok: false, reason: "enqueue_failed" },
      }),
      true,
      true,
    );
    await conductorTick("cond-1", deps);
    expect(savedGraph(deps)[0].last_charge_usd).toBe(1);
  });
});
