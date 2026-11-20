
import { describe, it, expect, vi } from "vitest";
import {
  conductorTick,
  PUSH_GATE_DEFAULT_MAX_WAIT_MS,
  type ConductorRow,
  type ConductorNode,
  type ConductorTickDeps,
  type ChildTerminalStatus,
  type RepairConfig,
} from "../conductor";

const TARGET = { github_full_name: "Praxis-build/couple-app-59683a96" };
const T0 = 1_757_000_000_000;

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

function captureSaved() {
  const saved: ConductorNode[][] = [];
  const saveGraph = vi.fn(async (_id: string, graph: ConductorNode[]) => {
    saved.push(JSON.parse(JSON.stringify(graph)) as ConductorNode[]);
  });
  const nodeById = (id: string): ConductorNode | undefined => {
    for (let i = saved.length - 1; i >= 0; i--) {
      const hit = saved[i].find((n) => n.id === id);
      if (hit) return hit;
    }
    return undefined;
  };
  return { saveGraph, nodeById };
}

function makeDeps(opts: DepOverrides): ConductorTickDeps {
  return {
    load: vi.fn(async () => opts.row),
    childStatus: opts.childStatus ?? vi.fn(async () => "success" as ChildTerminalStatus),
    consumeBudget: opts.consumeBudget ?? vi.fn(async () => "charged"),
    dispatch: opts.dispatch ?? vi.fn(async () => ({ ok: true as const, child_run_id: "child-x" })),
    saveGraph: opts.saveGraph ?? vi.fn(async () => {}),
    setStatus: opts.setStatus ?? vi.fn(async () => {}),
    now: opts.now,
    verifyStagePush: opts.verifyStagePush,
    childNoActionSignal: opts.childNoActionSignal,
    noChangeCheckpoint: opts.noChangeCheckpoint,
    startPreview: opts.startPreview,
    pushGateMaxWaitMs: opts.pushGateMaxWaitMs,
    repairConfig: opts.repairConfig,
    captureFailureSignal: opts.captureFailureSignal,
    dispatchRepair: opts.dispatchRepair,
  };
}

function buildNodeInFlight(payload: Record<string, unknown> = {}): ConductorNode {
  return node({
    id: "build",
    status: "dispatched",
    child_run_id: "engineer-child-1",
    payload: { stage: "build", target: TARGET, ...payload },
  });
}

describe("conductorTick — code-landed gate", () => {
  it("definitive no-action child → fails immediately instead of waiting for a push that cannot arrive", async () => {
    const verifyStagePush = vi.fn(async () => "missing" as const);
    const childNoActionSignal = vi.fn(async () =>
      "I need real customer quotes before I can add testimonials.",
    );
    const consumeBudget = vi.fn(async () => "charged" as const);
    const dispatchRepair = vi.fn(async () => ({
      ok: true as const,
      child_run_id: "repair-1",
    }));
    const setStatus = vi.fn(async () => {});
    const { saveGraph, nodeById } = captureSaved();
    const graphNode = buildNodeInFlight({ refine_mode: true });
    const deps = makeDeps({
      row: row({
        objective: "Add customer testimonials",
        goal_graph: [graphNode],
      }),
      verifyStagePush,
      childNoActionSignal,
      consumeBudget,
      repairConfig: REPAIR_ON,
      dispatchRepair,
      setStatus,
      now: () => T0,
      saveGraph,
    });

    const r = await conductorTick("cond-1", deps);

    expect(childNoActionSignal).toHaveBeenCalledWith({
      tenant_id: "t1",
      child_run_id: "engineer-child-1",
    });
    expect(verifyStagePush).not.toHaveBeenCalled();
    expect(consumeBudget).not.toHaveBeenCalled();
    expect(dispatchRepair).not.toHaveBeenCalled();
    expect(nodeById(graphNode.id)?.status).toBe("failed");
    expect(nodeById(graphNode.id)?.error).toContain("real customer quotes");
    expect(nodeById(graphNode.id)?.payload.push_check_started_at).toBeUndefined();
    expect(setStatus).toHaveBeenCalledWith(
      "cond-1",
      "failed",
      expect.objectContaining({
        failure_class: "stage_failed",
        failure_reason: expect.stringContaining("real customer quotes"),
      }),
    );
    expect(r).toEqual({ action: "completed", final: "failed" });
  });

  it("a fresh build's no-action child on code this build already landed passes as a verified no-change, no push wait, no repair", async () => {
    const verifyStagePush = vi.fn(async () => "missing" as const);
    const childNoActionSignal = vi.fn(async () => "Nothing new to push. Home Rentals v1 is already on main.");
    const noChangeCheckpoint = vi.fn(async () => ({ commit_sha: "b3911a3" }));
    const consumeBudget = vi.fn(async () => "charged" as const);
    const dispatchRepair = vi.fn(async () => ({ ok: true as const, child_run_id: "repair-1" }));
    const setStatus = vi.fn(async () => {});
    const { saveGraph, nodeById } = captureSaved();
    const scaffold = node({
      id: "scaffold",
      status: "done",
      child_run_id: "engineer-child-0",
      payload: { stage: "scaffold", target: TARGET },
      checkpoint: { kind: "pushed", commit_sha: null, verified_at: "2026-09-28T11:43:48.314Z" },
    });
    const graphNode = buildNodeInFlight();
    const deploy = node({ id: "deploy", target_agent_slug: "", payload: { stage: "deploy" }, estimate_usd: 0 });
    const deps = makeDeps({
      row: row({ goal_graph: [scaffold, graphNode, deploy] }),
      verifyStagePush,
      childNoActionSignal,
      noChangeCheckpoint,
      consumeBudget,
      repairConfig: REPAIR_ON,
      dispatchRepair,
      now: () => T0,
      setStatus,
      saveGraph,
    });

    await conductorTick("cond-1", deps);

    expect(noChangeCheckpoint).toHaveBeenCalledWith({
      tenant_id: "t1",
      conductor_run_id: "cond-1",
      child_run_id: "engineer-child-1",
      earlier_stage_landed: true,
    });
    expect(verifyStagePush).not.toHaveBeenCalled();
    expect(dispatchRepair).not.toHaveBeenCalled();
    const settled = nodeById(graphNode.id);
    expect(settled?.status).toBe("done");
    expect(settled?.error).toBeNull();
    expect(settled?.checkpoint).toEqual({ kind: "no_change", commit_sha: "b3911a3", verified_at: expect.any(String) });
    expect(settled?.payload.push_check_started_at).toBeUndefined();
    expect(setStatus).not.toHaveBeenCalledWith("cond-1", "failed", expect.anything());
  });

  it("a fresh build's no-action child WITHOUT no-change evidence fails the stage now, with the child's own words, and B2 repair runs in the same tick", async () => {
    const verifyStagePush = vi.fn(async () => "missing" as const);
    const childNoActionSignal = vi.fn(async () => "Nothing new to push. Home Rentals v1 is already on main.");
    const noChangeCheckpoint = vi.fn(async () => null);
    const consumeBudget = vi.fn(async () => "charged" as const);
    const dispatchRepair = vi.fn(async () => ({ ok: true as const, child_run_id: "repair-1" }));
    const setStatus = vi.fn(async () => {});
    const { saveGraph, nodeById } = captureSaved();
    const graphNode = buildNodeInFlight();
    const deps = makeDeps({
      row: row({ goal_graph: [graphNode] }),
      verifyStagePush,
      childNoActionSignal,
      noChangeCheckpoint,
      consumeBudget,
      repairConfig: REPAIR_ON,
      dispatchRepair,
      captureFailureSignal: vi.fn(async () => null),
      now: () => T0,
      setStatus,
      saveGraph,
    });

    const r = await conductorTick("cond-1", deps);

    expect(verifyStagePush).not.toHaveBeenCalled();
    expect(nodeById(graphNode.id)?.payload.push_check_started_at).toBeUndefined();
    expect(dispatchRepair).toHaveBeenCalledWith(
      expect.objectContaining({
        node_id: "build",
        attempt: 1,
        failure_signal: expect.stringContaining("Nothing new to push"),
      }),
    );
    expect(r).toEqual({ action: "repair_dispatched", node_id: "build", child_run_id: "repair-1", attempt: 1 });
    expect(setStatus).not.toHaveBeenCalledWith("cond-1", "failed", expect.anything());
  });

  it("nothing landed yet, INSIDE the bound → node stays in flight, no false fail", async () => {
    const verifyStagePush = vi.fn(async () => "missing" as const);
    const setStatus = vi.fn(async () => {});
    const { saveGraph, nodeById } = captureSaved();
    const graphNode = buildNodeInFlight();
    const deps = makeDeps({
      row: row({ goal_graph: [graphNode] }),
      verifyStagePush,
      now: () => T0,
      setStatus,
      saveGraph,
    });

    const r = await conductorTick("cond-1", deps);

    expect(nodeById(graphNode.id)?.payload.push_check_started_at).toBe(T0);
    expect(nodeById(graphNode.id)?.status).toBe("dispatched");
    expect(nodeById(graphNode.id)?.status).not.toBe("done");
    expect(r).toEqual({ action: "waiting", in_flight: 1 });
    expect(setStatus).not.toHaveBeenCalledWith("cond-1", "failed", expect.anything());
  });

  it("still nothing landed PAST the bound → stage fails with the cause, and B2 repair re-dispatches it", async () => {
    const verifyStagePush = vi.fn(async () => "missing" as const);
    const dispatchRepair = vi.fn(async () => ({ ok: true as const, child_run_id: "repair-1" }));
    const { saveGraph, nodeById } = captureSaved();
    const graphNode = buildNodeInFlight({
      push_check_started_at: T0 - PUSH_GATE_DEFAULT_MAX_WAIT_MS - 1000,
    });
    const deps = makeDeps({
      row: row({ goal_graph: [graphNode] }),
      verifyStagePush,
      now: () => T0,
      repairConfig: REPAIR_ON,
      dispatchRepair,
      captureFailureSignal: vi.fn(async () => null),
      saveGraph,
    });

    const r = await conductorTick("cond-1", deps);

    expect(nodeById(graphNode.id)?.status).not.toBe("done");
    expect(dispatchRepair).toHaveBeenCalledWith(
      expect.objectContaining({
        node_id: "build",
        attempt: 1,
        failure_signal: expect.stringContaining("no code reached the provisioned repo"),
      }),
    );
    const repairArg = (dispatchRepair.mock.calls as unknown as Array<[{ failure_signal: string }]>)[0][0];
    expect(repairArg.failure_signal).toContain("Praxis-build/couple-app-59683a96");
    expect(r).toEqual({
      action: "repair_dispatched",
      node_id: "build",
      child_run_id: "repair-1",
      attempt: 1,
    });
  });

  it("a refused push stops immediately without charging or dispatching code repairs", async () => {
    const verifyStagePush = vi.fn(async () => "refused" as const);
    const dispatchRepair = vi.fn(async () => ({ ok: true as const, child_run_id: "repair-1" }));
    const { saveGraph, nodeById } = captureSaved();
    const graphNode = buildNodeInFlight();
    const consumeBudget = vi.fn(async () => "charged" as const);
    const deps = makeDeps({
      row: row({ goal_graph: [graphNode] }),
      verifyStagePush,
      now: () => T0,
      repairConfig: REPAIR_ON,
      dispatchRepair,
      consumeBudget,
      captureFailureSignal: vi.fn(async () => null),
      saveGraph,
    });

    const r = await conductorTick("cond-1", deps);

    expect(nodeById(graphNode.id)?.status).not.toBe("done");
    expect(dispatchRepair).not.toHaveBeenCalled();
    expect(consumeBudget).not.toHaveBeenCalled();
    expect(nodeById(graphNode.id)?.failure_class).toBe("dispatch_failed");
    expect(nodeById(graphNode.id)?.error).toContain("could not be pushed to the provisioned repo");
    expect(r).toMatchObject({ action: "completed", final: "failed" });
  });

  it("a fresh build whose push was diverted to a PR did not land: the stage fails now", async () => {
    const dispatchRepair = vi.fn(async () => ({ ok: true as const, child_run_id: "repair-1" }));
    const { saveGraph, nodeById } = captureSaved();
    const graphNode = buildNodeInFlight();
    const deps = makeDeps({
      row: row({ goal_graph: [graphNode] }),
      verifyStagePush: vi.fn(async () => "diverted" as const),
      now: () => T0,
      repairConfig: REPAIR_ON,
      dispatchRepair,
      captureFailureSignal: vi.fn(async () => null),
      saveGraph,
    });
    await conductorTick("cond-1", deps);
    expect(nodeById(graphNode.id)?.status).not.toBe("done");
    expect(dispatchRepair).not.toHaveBeenCalled();
  });

  it("a re-tick of a persisted refused push still cannot charge a repair", async () => {
    const consumeBudget = vi.fn(async () => "charged" as const);
    const dispatchRepair = vi.fn(async () => ({ ok: true as const, child_run_id: "repair-1" }));
    const failed = node({ id: "build", status: "failed", failure_class: "dispatch_failed", error: "The push was refused." });
    const deps = makeDeps({ row: row({ goal_graph: [failed] }), consumeBudget, dispatchRepair, repairConfig: REPAIR_ON });
    expect(await conductorTick("cond-1", deps)).toMatchObject({ action: "completed", final: "failed" });
    expect(consumeBudget).not.toHaveBeenCalled();
    expect(dispatchRepair).not.toHaveBeenCalled();
    expect(deps.setStatus).toHaveBeenCalledWith("cond-1", "failed", expect.objectContaining({
      failure_class: "dispatch_failed", failure_reason: "The push was refused.",
    }));
  });

  it("a refine whose protected change was parked in a PR for review settles as before", async () => {
    const { saveGraph, nodeById } = captureSaved();
    const graphNode = buildNodeInFlight({ refine_mode: true });
    const deps = makeDeps({
      row: row({ goal_graph: [graphNode] }),
      verifyStagePush: vi.fn(async () => "diverted" as const),
      now: () => T0,
      saveGraph,
    });
    await conductorTick("cond-1", deps);
    expect(nodeById(graphNode.id)?.status).toBe("done");
  });

  it("a repair re-dispatch clears the push clock, so the retry gets its own window", async () => {
    const verifyStagePush = vi.fn(async () => "missing" as const);
    const dispatchRepair = vi.fn(async () => ({ ok: true as const, child_run_id: "repair-1" }));
    const { saveGraph, nodeById } = captureSaved();
    const graphNode = buildNodeInFlight({
      push_check_started_at: T0 - PUSH_GATE_DEFAULT_MAX_WAIT_MS - 1000,
    });
    const deps = makeDeps({
      row: row({ goal_graph: [graphNode] }),
      verifyStagePush,
      now: () => T0,
      repairConfig: REPAIR_ON,
      dispatchRepair,
      captureFailureSignal: vi.fn(async () => null),
      saveGraph,
    });

    await conductorTick("cond-1", deps);

    const repaired = nodeById(graphNode.id);
    expect(repaired?.status).toBe("dispatched");
    expect(repaired?.child_run_id).toBe("repair-1");
    expect(repaired?.payload.push_check_started_at).toBeUndefined();
  });

  it("code landed → node settles 'done' exactly as before", async () => {
    const verifyStagePush = vi.fn(async () => "landed" as const);
    const { saveGraph, nodeById } = captureSaved();
    const graphNode = buildNodeInFlight();
    const deps = makeDeps({
      row: row({ goal_graph: [graphNode] }),
      verifyStagePush,
      now: () => T0,
      saveGraph,
    });

    await conductorTick("cond-1", deps);

    expect(nodeById(graphNode.id)?.status).toBe("done");
    expect(nodeById(graphNode.id)?.error).toBeNull();
    expect(verifyStagePush).toHaveBeenCalledWith({
      tenant_id: "t1",
      child_run_id: "engineer-child-1",
      repo_full_name: "Praxis-build/couple-app-59683a96",
    });
  });

  it("unreadable receipt → fails OPEN (a read blip never fails a real build)", async () => {
    const verifyStagePush = vi.fn(async () => "unknown" as const);
    const { saveGraph, nodeById } = captureSaved();
    const graphNode = buildNodeInFlight({
      push_check_started_at: T0 - PUSH_GATE_DEFAULT_MAX_WAIT_MS - 1000,
    });
    const deps = makeDeps({
      row: row({ goal_graph: [graphNode] }),
      verifyStagePush,
      now: () => T0,
      saveGraph,
    });

    await conductorTick("cond-1", deps);

    expect(nodeById(graphNode.id)?.status).toBe("done");
  });

  it("a throwing dep fails OPEN too", async () => {
    const verifyStagePush = vi.fn(async () => {
      throw new Error("supabase unreachable");
    });
    const { saveGraph, nodeById } = captureSaved();
    const graphNode = buildNodeInFlight({
      push_check_started_at: T0 - PUSH_GATE_DEFAULT_MAX_WAIT_MS - 1000,
    });
    const deps = makeDeps({
      row: row({ goal_graph: [graphNode] }),
      verifyStagePush: verifyStagePush as unknown as ConductorTickDeps["verifyStagePush"],
      now: () => T0,
      saveGraph,
    });

    await conductorTick("cond-1", deps);

    expect(nodeById(graphNode.id)?.status).toBe("done");
  });

  it("dep absent → SAFE-INERT, the stage settles exactly as today", async () => {
    const { saveGraph, nodeById } = captureSaved();
    const graphNode = buildNodeInFlight();
    const deps = makeDeps({ row: row({ goal_graph: [graphNode] }), now: () => T0, saveGraph });

    await conductorTick("cond-1", deps);

    expect(nodeById(graphNode.id)?.status).toBe("done");
    expect(nodeById(graphNode.id)?.payload.push_check_started_at).toBeUndefined();
  });

  it("non-pushing stages are untouched — a qa node never consults the gate", async () => {
    const verifyStagePush = vi.fn(async () => "missing" as const);
    const { saveGraph, nodeById } = captureSaved();
    const graphNode = node({
      id: "qa",
      status: "dispatched",
      child_run_id: "qa-child-1",
      target_agent_slug: "qa",
      payload: { stage: "qa", target: TARGET },
    });
    const deps = makeDeps({
      row: row({ goal_graph: [node({ id: "build", status: "done" }), graphNode] }),
      verifyStagePush,
      now: () => T0,
      saveGraph,
    });

    await conductorTick("cond-1", deps);

    expect(verifyStagePush).not.toHaveBeenCalled();
    expect(nodeById(graphNode.id)?.status).toBe("done");
  });

  it("a non-build_app run (company_goal) is untouched", async () => {
    const verifyStagePush = vi.fn(async () => "missing" as const);
    const { saveGraph, nodeById } = captureSaved();
    const graphNode = buildNodeInFlight();
    const deps = makeDeps({
      row: row({ kind: "company_goal", goal_graph: [graphNode] }),
      verifyStagePush,
      now: () => T0,
      saveGraph,
    });

    await conductorTick("cond-1", deps);

    expect(verifyStagePush).not.toHaveBeenCalled();
    expect(nodeById(graphNode.id)?.status).toBe("done");
  });
});
