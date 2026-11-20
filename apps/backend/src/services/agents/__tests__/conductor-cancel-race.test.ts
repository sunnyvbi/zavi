import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = {
  id: string;
  status: string;
  failure_class: string | null;
  failure_reason: string | null;
  goal_graph: unknown[];
};

type Child = { id: string; tenant_id: string; status: string; stop_requested: boolean };

const h = vi.hoisted(() => ({
  row: null as unknown as Row,
  statusReadError: false,
  children: [] as Child[],
}));

vi.mock("@/services/agents/a2a-dispatch", () => ({ a2aDispatch: vi.fn() }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      if (table === "agent_runs") {
        const filters: Array<(c: Child) => boolean> = [];
        let patch: Partial<Child> = {};
        const c: Record<string, unknown> = {
          update: (p: Partial<Child>) => ((patch = p), c),
          eq: (k: string, v: unknown) => (filters.push((r) => (r as Record<string, unknown>)[k] === v), c),
          in: (k: string, vs: unknown[]) =>
            (filters.push((r) => vs.includes((r as Record<string, unknown>)[k])), c),
          then: (resolve: (v: unknown) => void) => {
            h.children = h.children.map((r) => (filters.every((f) => f(r)) ? { ...r, ...patch } : r));
            resolve({ error: null });
          },
        };
        return c;
      }
      if (table !== "conductor_runs") throw new Error(`unexpected table ${table}`);
      const filters: Array<(r: Row) => boolean> = [];
      let patch: Record<string, unknown> | null = null;
      const matches = () => filters.every((f) => f(h.row));
      const b: Record<string, unknown> = {
        select: () => b,
        update: (p: Record<string, unknown>) => ((patch = p), b),
        eq: (k: string, v: unknown) => (filters.push((r) => (r as Record<string, unknown>)[k] === v), b),
        in: (k: string, vs: unknown[]) =>
          (filters.push((r) => vs.includes((r as Record<string, unknown>)[k])), b),
        maybeSingle: async () => {
          if (h.statusReadError) return { data: null, error: { message: "read blip" } };
          return { data: matches() ? { status: h.row.status } : null, error: null };
        },
        then: (resolve: (v: unknown) => void) => {
          if (patch && matches()) h.row = { ...h.row, ...(JSON.parse(JSON.stringify(patch)) as Partial<Row>) };
          resolve({ error: null });
        },
      };
      return b;
    },
  }),
}));

import { realConductorTickDeps } from "../conductor-driver";
import { conductorTick, type ConductorNode, type ConductorRow, type ConductorTickDeps } from "../conductor";

const RUN = "cr-cancel-race";

function cancel() {
  h.row = { ...h.row, status: "failed", failure_class: "user_cancelled", failure_reason: "Stopped by you." };
}

function seed(graph: ConductorNode[]) {
  h.row = { id: RUN, status: "active", failure_class: null, failure_reason: null, goal_graph: graph };
}

function load(): Promise<ConductorRow> {
  return Promise.resolve({
    id: RUN,
    tenant_id: "tnt",
    objective: "build",
    status: h.row.status as ConductorRow["status"],
    max_usd: 100,
    spend_usd: 0,
    kind: "build_app",
    goal_graph: JSON.parse(JSON.stringify(h.row.goal_graph)) as ConductorNode[],
  });
}

function deps(over: Partial<ConductorTickDeps>): ConductorTickDeps {
  return {
    load,
    childStatus: vi.fn(async () => "success" as const),
    consumeBudget: vi.fn(async () => "charged" as const),
    refundBudget: vi.fn(async () => {}),
    dispatch: vi.fn(async () => ({ ok: true as const, child_run_id: "child-new" })),
    saveGraph: realConductorTickDeps.saveGraph,
    setStatus: realConductorTickDeps.setStatus,
    isActive: realConductorTickDeps.isActive,
    stopChild: realConductorTickDeps.stopChild,
    now: () => Date.UTC(2026, 8, 30, 12, 0, 0),
    ...over,
  } as ConductorTickDeps;
}

const pendingSpec: ConductorNode = {
  id: "spec",
  status: "pending",
  target_agent_slug: "pm",
  payload: { stage: "spec" },
  estimate_usd: 2,
};

const dispatchedQa: ConductorNode = {
  id: "qa",
  status: "dispatched",
  target_agent_slug: "qa",
  payload: { stage: "qa" },
  estimate_usd: 1,
  child_run_id: "child-qa",
};

beforeEach(() => {
  h.statusReadError = false;
  h.children = [];
});

describe("a cancel that lands while a tick is running", () => {
  it("is not overwritten to done when the tick finishes the last node", async () => {
    seed([dispatchedQa]);
    const d = deps({
      childStatus: vi.fn(async () => {
        cancel();
        return "success" as const;
      }),
    });

    await conductorTick(RUN, d);

    expect(h.row.status).toBe("failed");
    expect(h.row.failure_class).toBe("user_cancelled");
    expect((h.row.goal_graph[0] as ConductorNode).status).toBe("dispatched");
  });

  it("is not overwritten to paused or relabelled when the tick fails the last node", async () => {
    seed([
      { id: "build", status: "done", target_agent_slug: "engineer", payload: { stage: "build" }, estimate_usd: 3 },
      { ...dispatchedQa },
    ]);
    const d = deps({
      childStatus: vi.fn(async () => {
        cancel();
        return "failed" as const;
      }),
    });

    await conductorTick(RUN, d);

    expect(h.row.status).toBe("failed");
    expect(h.row.failure_class).toBe("user_cancelled");
    expect(h.row.failure_reason).toBe("Stopped by you.");
  });

  it("does not dispatch a charged run and gives the charge back when the cancel lands after the charge", async () => {
    seed([{ ...pendingSpec }]);
    const dispatch = vi.fn(async () => ({ ok: true as const, child_run_id: "child-new" }));
    const refundBudget = vi.fn(async () => {});
    const d = deps({
      dispatch,
      refundBudget,
      consumeBudget: vi.fn(async () => {
        cancel();
        return "charged" as const;
      }),
    });

    const r = await conductorTick(RUN, d);

    expect(dispatch).not.toHaveBeenCalled();
    expect(refundBudget).toHaveBeenCalledWith(RUN, 2, expect.any(String));
    expect(r).toEqual({ action: "noop", reason: "stopped" });
    expect(h.row.status).toBe("failed");
    expect((h.row.goal_graph[0] as ConductorNode).status).toBe("pending");
  });

  it("stops the child and gives the charge back when the cancel lands while the dispatch is in flight", async () => {
    seed([{ ...pendingSpec }]);
    const refundBudget = vi.fn(async () => {});
    const dispatch = vi.fn(async () => {
      h.children.push({ id: "child-new", tenant_id: "tnt", status: "queued", stop_requested: false });
      cancel();
      return { ok: true as const, child_run_id: "child-new" };
    });
    h.children.push({ id: "child-other", tenant_id: "tnt", status: "queued", stop_requested: false });

    const r = await conductorTick(RUN, deps({ dispatch, refundBudget }));

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(h.children.find((c) => c.id === "child-new")?.stop_requested).toBe(true);
    expect(h.children.find((c) => c.id === "child-other")?.stop_requested).toBe(false);
    expect(refundBudget).toHaveBeenCalledTimes(1);
    expect(refundBudget).toHaveBeenCalledWith(RUN, 2, expect.any(String));
    expect(r).toEqual({ action: "noop", reason: "stopped" });
    expect(h.row.status).toBe("failed");
    expect(h.row.failure_class).toBe("user_cancelled");
  });

  it("an adopted child dispatched across a cancel is stopped and refunded once", async () => {
    seed([{ ...pendingSpec }]);
    const refundBudget = vi.fn(async () => {});
    h.children.push({ id: "child-won", tenant_id: "tnt", status: "running", stop_requested: false });
    const dispatch = vi.fn(async () => {
      cancel();
      return { ok: true as const, child_run_id: "child-won", adopted: true };
    });

    await conductorTick(RUN, deps({ dispatch, refundBudget }));

    expect(h.children[0].stop_requested).toBe(true);
    expect(refundBudget).toHaveBeenCalledTimes(1);
  });

  it("a status read blip after the dispatch keeps the child and records it", async () => {
    seed([{ ...pendingSpec }]);
    let reads = 0;
    const isActive = vi.fn(async () => {
      reads += 1;
      if (reads > 1) throw new Error("read blip");
      return true;
    });
    h.children.push({ id: "child-new", tenant_id: "tnt", status: "queued", stop_requested: false });
    const r = await conductorTick(RUN, deps({ isActive }));

    expect(r).toMatchObject({ action: "dispatched", child_run_id: "child-new" });
    expect(h.children[0].stop_requested).toBe(false);
    expect((h.row.goal_graph[0] as ConductorNode).status).toBe("dispatched");
  });

  it("does not dispatch when the status re-read fails", async () => {
    seed([{ ...pendingSpec }]);
    const dispatch = vi.fn(async () => ({ ok: true as const, child_run_id: "child-new" }));
    const d = deps({
      dispatch,
      consumeBudget: vi.fn(async () => {
        h.statusReadError = true;
        return "charged" as const;
      }),
    });

    await conductorTick(RUN, d);

    expect(dispatch).not.toHaveBeenCalled();
    expect(h.row.status).toBe("active");
  });
});

describe("with no cancel the tick still moves the build", () => {
  it("dispatches the next node and saves the graph", async () => {
    seed([{ ...pendingSpec }]);
    const dispatch = vi.fn(async () => ({ ok: true as const, child_run_id: "child-new" }));
    await conductorTick(RUN, deps({ dispatch }));

    expect(dispatch).toHaveBeenCalledTimes(1);
    const node = h.row.goal_graph[0] as ConductorNode;
    expect(node.status).toBe("dispatched");
    expect(node.child_run_id).toBe("child-new");
    expect(h.children).toEqual([]);
  });

  it("finishes a build as done", async () => {
    seed([dispatchedQa]);
    await conductorTick(RUN, deps({}));
    expect(h.row.status).toBe("done");
  });

  it("still records the node error after the budget RPC halts the row", async () => {
    seed([{ ...pendingSpec }]);
    const d = deps({
      consumeBudget: vi.fn(async () => {
        h.row = { ...h.row, status: "halted" };
        return "over_cap" as const;
      }),
    });

    await conductorTick(RUN, d);

    expect(h.row.status).toBe("halted");
    expect((h.row.goal_graph[0] as ConductorNode).failure_class).toBe("budget_halted");
  });
});
