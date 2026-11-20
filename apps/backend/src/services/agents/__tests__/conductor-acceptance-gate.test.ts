
import { describe, it, expect, vi } from "vitest";
import {
  conductorTick,
  type ConductorRow,
  type ConductorNode,
  type ConductorTickDeps,
  type ChildTerminalStatus,
} from "../conductor";

function buildNode(over: Partial<ConductorNode> = {}): ConductorNode {
  return {
    id: "b",
    status: "done",
    target_agent_slug: "engineer",
    payload: { stage: "build", idea: "a marketplace", company_name: "Acme", target: { github_full_name: "praxis-built/acme" } },
    estimate_usd: 3,
    child_run_id: "child-build",
    ...over,
  };
}
function deployNode(over: Partial<ConductorNode> = {}): ConductorNode {
  return {
    id: "d",
    status: "pending",
    target_agent_slug: "",
    payload: { stage: "deploy" },
    estimate_usd: 0,
    child_run_id: null,
    ...over,
  };
}
function row(graph: ConductorNode[], over: Partial<ConductorRow> = {}): ConductorRow {
  return {
    id: "cond-1",
    tenant_id: "t1",
    objective: "build product",
    status: "active",
    max_usd: 100,
    spend_usd: 0,
    kind: "build_app",
    goal_graph: graph,
    ...over,
  };
}

type Verdict = { mode: "shadow" | "enforce"; pass: boolean; signal: string };
type Harness = {
  deps: ConductorTickDeps;
  calls: { dispatchRepair: number; setStatus: string[]; probe: number };
  saved: () => ConductorNode[];
  node: (id: string) => ConductorNode;
};

function makeDeps(opts: {
  graph: ConductorNode[];
  hosting?: "ready" | "failed" | "provisioning" | "none";
  probe?: Verdict | (() => Promise<Verdict>);
  childStatus?: ChildTerminalStatus;
  dispatchRepairOk?: boolean;
  consume?: "charged" | "over_cap";
  acceptanceRepairMaxAttempts?: number;
  now?: number;
}): Harness {
  const calls = { dispatchRepair: 0, setStatus: [] as string[], probe: 0 };
  const r = row(opts.graph);
  let savedGraph: ConductorNode[] = opts.graph;
  const deps: ConductorTickDeps = {
    load: vi.fn(async () => r),
    childStatus: vi.fn(async () => opts.childStatus ?? "running"),
    consumeBudget: vi.fn(async () => opts.consume ?? "charged"),
    dispatch: vi.fn(async () => ({ ok: true as const, child_run_id: "x" })),
    saveGraph: vi.fn(async (_id: string, g: ConductorNode[]) => {
      savedGraph = g;
    }),
    setStatus: vi.fn(async (_id: string, s: string) => {
      calls.setStatus.push(s);
    }),
    hostingStatus: vi.fn(async () => opts.hosting ?? "ready"),
    dispatchRepair: vi.fn(async () => {
      calls.dispatchRepair++;
      return opts.dispatchRepairOk === false
        ? { ok: false as const, reason: "kill_switch" }
        : { ok: true as const, child_run_id: "fix-child" };
    }),
    now: opts.now !== undefined ? () => opts.now! : undefined,
  };
  if (opts.probe) {
    deps.acceptanceProbe = vi.fn(async () => {
      calls.probe++;
      return typeof opts.probe === "function" ? opts.probe() : opts.probe!;
    });
  }
  if (opts.acceptanceRepairMaxAttempts !== undefined) {
    deps.acceptanceRepairMaxAttempts = opts.acceptanceRepairMaxAttempts;
  }
  return {
    deps,
    calls,
    saved: () => savedGraph,
    node: (id: string) => {
      const n = savedGraph.find((x) => x.id === id);
      if (!n) throw new Error(`node ${id} not in saved graph`);
      return n;
    },
  };
}

describe("acceptance gate OFF (dep absent) — byte-identical to before", () => {
  it("deploy-ready completes 'done' with NO probe", async () => {
    const h = makeDeps({ graph: [buildNode(), deployNode()], hosting: "ready" });
    const res = await conductorTick("cond-1", h.deps);
    expect(res).toEqual({ action: "completed", final: "done" });
    expect(h.node("d").status).toBe("done");
    expect(h.deps.acceptanceProbe).toBeUndefined();
  });
});

describe("acceptance gate SHADOW — runs but never blocks", () => {
  it("a FAIL verdict in shadow still completes the run 'done'", async () => {
    const h = makeDeps({
      graph: [buildNode(), deployNode()],
      hosting: "ready",
      probe: { mode: "shadow", pass: false, signal: "NO_FORGED_SESSION: forged accepted" },
    });
    const res = await conductorTick("cond-1", h.deps);
    expect(res).toEqual({ action: "completed", final: "done" });
    expect(h.node("d").status).toBe("done");
    expect(h.calls.probe).toBe(1);
    expect(h.calls.dispatchRepair).toBe(0);
    expect(h.calls.setStatus).toEqual(["done"]);
  });
});

describe("acceptance gate ENFORCE", () => {
  it("PASS → run 'done'", async () => {
    const h = makeDeps({
      graph: [buildNode(), deployNode()],
      hosting: "ready",
      probe: { mode: "enforce", pass: true, signal: "" },
    });
    const res = await conductorTick("cond-1", h.deps);
    expect(res).toEqual({ action: "completed", final: "done" });
    expect(h.node("d").status).toBe("done");
  });

  it("FAIL, then cancelled while the repair was being dispatched → the repair child is stopped and the charge refunded", async () => {
    const h = makeDeps({
      graph: [buildNode(), deployNode()],
      hosting: "ready",
      probe: { mode: "enforce", pass: false, signal: "AUTH_ROUNDTRIP: login loops" },
      acceptanceRepairMaxAttempts: 2,
    });
    const stopChild = vi.fn(async () => undefined);
    const refundBudget = vi.fn(async () => undefined);
    h.deps.isActive = vi.fn(async () => h.calls.dispatchRepair === 0);
    h.deps.stopChild = stopChild;
    h.deps.refundBudget = refundBudget;
    const res = await conductorTick("cond-1", h.deps);
    expect(res).toEqual({ action: "noop", reason: "stopped" });
    expect(stopChild).toHaveBeenCalledWith(expect.anything(), "fix-child");
    expect(refundBudget).toHaveBeenCalledWith("cond-1", 3, expect.any(String));
  });

  it("FAIL (attempts<cap) → bounded auto-repair dispatched, NOT reported LIVE", async () => {
    const h = makeDeps({
      graph: [buildNode(), deployNode()],
      hosting: "ready",
      probe: { mode: "enforce", pass: false, signal: "AUTH_ROUNDTRIP: login loops" },
      acceptanceRepairMaxAttempts: 2,
    });
    const res = await conductorTick("cond-1", h.deps);
    expect(res.action).toBe("acceptance_repair_dispatched");
    if (res.action === "acceptance_repair_dispatched") {
      expect(res.attempt).toBe(1);
      expect(res.child_run_id).toBe("fix-child");
    }
    const d = h.node("d");
    expect(d.status).toBe("dispatched");
    expect(d.child_run_id).toBe("fix-child");
    expect(d.acceptance_attempts).toBe(1);
    expect(d.acceptance_reprobe_pending).toBe(true);
    expect(h.calls.dispatchRepair).toBe(1);
    expect(h.calls.setStatus).not.toContain("done");
    expect(h.deps.consumeBudget).toHaveBeenCalledWith("cond-1", 3);
  });

  it("FAIL (cap exhausted) → run FAILED clean with the evidence", async () => {
    const h = makeDeps({
      graph: [buildNode(), deployNode({ acceptance_attempts: 2 })],
      hosting: "ready",
      probe: { mode: "enforce", pass: false, signal: "REAL_APP: still seed" },
      acceptanceRepairMaxAttempts: 2,
    });
    const res = await conductorTick("cond-1", h.deps);
    expect(res).toEqual({ action: "completed", final: "paused" });
    expect(h.node("d").status).toBe("failed");
    expect(h.node("d").last_failure_signal).toContain("REAL_APP");
    expect(h.calls.dispatchRepair).toBe(0);
    expect(h.calls.setStatus).toEqual(["paused"]);
  });

  it("FAIL + repair-dispatch itself fails → run FAILED clean", async () => {
    const h = makeDeps({
      graph: [buildNode(), deployNode()],
      hosting: "ready",
      probe: { mode: "enforce", pass: false, signal: "PROTECTED_GATING: open" },
      dispatchRepairOk: false,
    });
    const res = await conductorTick("cond-1", h.deps);
    expect(res).toEqual({ action: "completed", final: "paused" });
    expect(h.node("d").status).toBe("failed");
  });

  it("FAIL but over the lifetime cap → halted (never dispatches the repair)", async () => {
    const h = makeDeps({
      graph: [buildNode(), deployNode()],
      hosting: "ready",
      probe: { mode: "enforce", pass: false, signal: "REAL_APP: seed" },
      consume: "over_cap",
    });
    const res = await conductorTick("cond-1", h.deps);
    expect(res).toEqual({ action: "halted" });
    expect(h.calls.dispatchRepair).toBe(0);
  });

  it("a probe THROW is fail-safe → run 'done' (a gate bug never wedges a build)", async () => {
    const h = makeDeps({
      graph: [buildNode(), deployNode()],
      hosting: "ready",
      probe: () => Promise.reject(new Error("boom")),
    });
    const res = await conductorTick("cond-1", h.deps);
    expect(res).toEqual({ action: "completed", final: "done" });
    expect(h.node("d").status).toBe("done");
  });
});

describe("acceptance gate ENFORCE — reprobe reset + grace", () => {
  it("the fix child settling flips the deploy node back to 'pending' to re-probe", async () => {
    const h = makeDeps({
      graph: [
        buildNode(),
        deployNode({
          status: "dispatched",
          child_run_id: "fix-child",
          acceptance_attempts: 1,
          acceptance_reprobe_pending: true,
        }),
      ],
      childStatus: "success",
      probe: { mode: "enforce", pass: true, signal: "" },
      now: 1_000_000,
    });
    const res = await conductorTick("cond-1", h.deps);
    const d = h.node("d");
    expect(d.status).toBe("pending");
    expect(d.child_run_id).toBeNull();
    expect(d.acceptance_reprobe_pending).toBe(false);
    expect(typeof d.acceptance_reprobe_after).toBe("number");
    expect(d.acceptance_reprobe_after!).toBeGreaterThan(1_000_000);
    expect(res.action).toBe("waiting");
  });

  it("during the grace window the deploy gate WAITS (no hosting read, no probe)", async () => {
    const h = makeDeps({
      graph: [buildNode(), deployNode({ acceptance_reprobe_after: 2_000_000 })],
      hosting: "ready",
      probe: { mode: "enforce", pass: true, signal: "" },
      now: 1_000_000,
    });
    const res = await conductorTick("cond-1", h.deps);
    expect(res.action).toBe("waiting");
    expect(h.deps.hostingStatus).not.toHaveBeenCalled();
    expect(h.calls.probe).toBe(0);
  });

  it("after the grace window elapses the gate re-probes", async () => {
    const h = makeDeps({
      graph: [buildNode(), deployNode({ acceptance_reprobe_after: 500_000 })],
      hosting: "ready",
      probe: { mode: "enforce", pass: true, signal: "" },
      now: 1_000_000,
    });
    const res = await conductorTick("cond-1", h.deps);
    expect(h.calls.probe).toBe(1);
    expect(res).toEqual({ action: "completed", final: "done" });
  });
});
