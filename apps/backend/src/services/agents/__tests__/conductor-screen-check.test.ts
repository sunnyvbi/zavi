
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  conductorTick,
  type ConductorRow,
  type ConductorNode,
  type ConductorTickDeps,
} from "../conductor";
import { buildProductGoalGraph } from "../product-pipeline";
import type { ScreenCheckRecord } from "@/services/qa/post-deploy-screen-check";

const SAVED_DEPLOY = process.env.BUILD_DEPLOY_STAGE_ENABLED;
afterEach(() => {
  if (SAVED_DEPLOY === undefined) delete process.env.BUILD_DEPLOY_STAGE_ENABLED;
  else process.env.BUILD_DEPLOY_STAGE_ENABLED = SAVED_DEPLOY;
});

function makeRow(goal_graph: ConductorNode[]): ConductorRow {
  return {
    id: "cond-1",
    tenant_id: "tenant-row",
    objective: "build product",
    status: "active",
    max_usd: 50,
    spend_usd: 0,
    kind: "build_app",
    goal_graph,
  };
}

function harness(initial: ConductorNode[], extra: Partial<ConductorTickDeps> = {}) {
  let row = makeRow(initial);
  const dispatched: string[] = [];
  const deps: ConductorTickDeps = {
    load: vi.fn(async () => row),
    childStatus: vi.fn(async () => "success" as const),
    consumeBudget: vi.fn(async () => "charged" as const),
    dispatch: vi.fn(async (input: { node_id: string; target_agent_slug: string }) => {
      dispatched.push(input.target_agent_slug);
      return { ok: true as const, child_run_id: `child-${input.node_id}` };
    }),
    saveGraph: vi.fn(async (_id: string, graph: ConductorNode[]) => {
      row = { ...row, goal_graph: JSON.parse(JSON.stringify(graph)) as ConductorNode[] };
    }),
    setStatus: vi.fn(async (_id: string, status: string) => {
      row = { ...row, status: status as ConductorRow["status"] };
    }),
    hostingStatus: vi.fn(async () => "ready" as const),
    ...extra,
  } as ConductorTickDeps;
  return { deps, dispatched, current: () => row };
}

async function runToEnd(deps: ConductorTickDeps, max = 20) {
  let last;
  for (let i = 0; i < max; i++) {
    last = await conductorTick("cond-1", deps);
    if (last.action === "completed" || last.action === "noop") break;
  }
  return last;
}

const passRecord: ScreenCheckRecord = {
  status: "pass",
  checked_at: "2026-09-26T00:00:00.000Z",
  url: "https://acme.onrender.com",
  fails: [],
};

describe("new builds: no qa stage", () => {
  it("a fresh build graph runs to done without ever dispatching qa", async () => {
    delete process.env.BUILD_DEPLOY_STAGE_ENABLED;
    const graph = buildProductGoalGraph(
      { tenant_id: "tenant-row", company_name: "Acme", idea: "a CRM" },
      { provisioned: { github_full_name: "Praxis-build/acme" } },
    );
    expect(graph.some((n) => n.payload.stage === "qa")).toBe(false);
    const { deps, dispatched, current } = harness(graph);
    const res = await runToEnd(deps);
    expect(res).toEqual({ action: "completed", final: "done" });
    expect(dispatched).toEqual(["pm", "engineer", "engineer"]);
    expect(dispatched).not.toContain("qa");
    expect(current().status).toBe("done");
  });
});

describe("older graphs: pending qa passes through", () => {
  const oldGraph = (): ConductorNode[] => [
    { id: "b", status: "done", target_agent_slug: "engineer", payload: { stage: "build" }, estimate_usd: 3, child_run_id: "c-b" },
    { id: "q", status: "pending", target_agent_slug: "qa", payload: { stage: "qa" }, estimate_usd: 0.5, child_run_id: null },
    { id: "d", status: "pending", target_agent_slug: "", payload: { stage: "deploy" }, estimate_usd: 0, child_run_id: null },
  ];

  it("settles qa done with no dispatch and no charge, then completes via deploy", async () => {
    const consumeClassBudget = vi.fn(async () => "charged" as const);
    const { deps, current } = harness(oldGraph(), {
      consumeClassBudget,
      decisionClassForStage: (s: string | null | undefined) => (s === "qa" ? "build.qa" : null),
    });
    const res = await conductorTick("cond-1", deps);
    expect(res).toEqual({ action: "completed", final: "done" });
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(deps.consumeBudget).not.toHaveBeenCalled();
    expect(consumeClassBudget).not.toHaveBeenCalled();
    const qa = current().goal_graph.find((n) => n.id === "q")!;
    expect(qa.status).toBe("done");
    expect(qa.child_run_id).toBeNull();
    expect(qa.last_charge_usd).toBeUndefined();
  });

  it("does not pass qa through while an earlier stage is still in flight", async () => {
    const g = oldGraph();
    g[0] = { ...g[0], status: "dispatched" };
    const { deps, current } = harness(g, { childStatus: vi.fn(async () => "running" as const) });
    const res = await conductorTick("cond-1", deps);
    expect(res).toEqual({ action: "waiting", in_flight: 1 });
    expect(current().goal_graph.find((n) => n.id === "q")!.status).toBe("pending");
  });
});

describe("post-deploy screen check", () => {
  const liveGraph = (): ConductorNode[] => [
    { id: "b", status: "done", target_agent_slug: "engineer", payload: { stage: "build" }, estimate_usd: 3, child_run_id: "c-b" },
    { id: "d", status: "pending", target_agent_slug: "", payload: { stage: "deploy", tenant_id: "evil" }, estimate_usd: 0, child_run_id: null },
  ];

  it("runs after deploy with the row's tenant and records the result on the deploy node", async () => {
    const screenCheck = vi.fn(async () => passRecord);
    const { deps, current } = harness(liveGraph(), { screenCheck });
    const res = await conductorTick("cond-1", deps);
    expect(res).toEqual({ action: "completed", final: "done" });
    expect(screenCheck).toHaveBeenCalledTimes(1);
    expect(screenCheck).toHaveBeenCalledWith({ tenant_id: "tenant-row" });
    const deploy = current().goal_graph.find((n) => n.id === "d")!;
    expect(deploy.status).toBe("done");
    expect(deploy.screen_check).toEqual(passRecord);
  });

  it("stamps hosting_verified_at only when the hosting read said ready", async () => {
    const live = harness(liveGraph());
    await conductorTick("cond-1", live.deps);
    expect(typeof live.current().goal_graph.find((n) => n.id === "d")!.hosting_verified_at).toBe("string");
    const passThrough = harness(liveGraph(), { hostingStatus: undefined });
    expect(await conductorTick("cond-1", passThrough.deps)).toEqual({ action: "completed", final: "done" });
    const d = passThrough.current().goal_graph.find((n) => n.id === "d")!;
    expect(d.status).toBe("done");
    expect(d.hosting_verified_at).toBeUndefined();
  });

  it("does not run until hosting is ready", async () => {
    const screenCheck = vi.fn(async () => passRecord);
    const { deps } = harness(liveGraph(), {
      screenCheck,
      hostingStatus: vi.fn(async () => "provisioning" as const),
    });
    await conductorTick("cond-1", deps);
    expect(screenCheck).not.toHaveBeenCalled();
  });

  it("a FAIL verdict is report-only: the build still completes done", async () => {
    const fail: ScreenCheckRecord = { ...passRecord, status: "fail", fails: ["[mobile/] horizontal overflow 600>375"] };
    const { deps, current } = harness(liveGraph(), { screenCheck: vi.fn(async () => fail) });
    const res = await conductorTick("cond-1", deps);
    expect(res).toEqual({ action: "completed", final: "done" });
    expect(current().goal_graph.find((n) => n.id === "d")!.screen_check?.status).toBe("fail");
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it("a skipped check (e.g. no Anchor key) is recorded and the build is unaffected", async () => {
    const skip: ScreenCheckRecord = { status: "skipped", checked_at: "x", reason: "ANCHOR_API_KEY not set" };
    const { deps, current } = harness(liveGraph(), { screenCheck: vi.fn(async () => skip) });
    const res = await conductorTick("cond-1", deps);
    expect(res).toEqual({ action: "completed", final: "done" });
    expect(current().goal_graph.find((n) => n.id === "d")!.screen_check).toEqual(skip);
  });

  it("a throwing check is recorded as skipped and the build still completes done", async () => {
    const { deps, current } = harness(liveGraph(), {
      screenCheck: vi.fn(async () => {
        throw new Error("anchor 503");
      }),
    });
    const res = await conductorTick("cond-1", deps);
    expect(res).toEqual({ action: "completed", final: "done" });
    const rec = current().goal_graph.find((n) => n.id === "d")!.screen_check!;
    expect(rec.status).toBe("skipped");
    expect(rec.reason).toContain("anchor 503");
  });
});

describe("post-deploy screen check handed off to its own worker", () => {
  const liveGraph = (): ConductorNode[] => [
    { id: "b", status: "done", target_agent_slug: "engineer", payload: { stage: "build" }, estimate_usd: 3, child_run_id: "c-b" },
    { id: "d", status: "pending", target_agent_slug: "", payload: { stage: "deploy", tenant_id: "evil" }, estimate_usd: 0, child_run_id: null },
  ];

  it("completes the build without awaiting the check, then requests it once the run is saved done", async () => {
    const screenCheck = vi.fn(() => new Promise<ScreenCheckRecord>(() => {}));
    const order: string[] = [];
    const requestScreenCheck = vi.fn(async () => {
      order.push("request");
    });
    const { deps, current } = harness(liveGraph(), { screenCheck, requestScreenCheck });
    const save = deps.saveGraph as ReturnType<typeof vi.fn>;
    const status = deps.setStatus as ReturnType<typeof vi.fn>;
    const origSave = save.getMockImplementation()!;
    const origStatus = status.getMockImplementation()!;
    save.mockImplementation(async (...a: unknown[]) => {
      order.push("save");
      return (origSave as (...x: unknown[]) => Promise<void>)(...a);
    });
    status.mockImplementation(async (...a: unknown[]) => {
      order.push("status");
      return (origStatus as (...x: unknown[]) => Promise<void>)(...a);
    });

    const res = await conductorTick("cond-1", deps);

    expect(res).toEqual({ action: "completed", final: "done" });
    expect(screenCheck).not.toHaveBeenCalled();
    expect(requestScreenCheck).toHaveBeenCalledTimes(1);
    expect(requestScreenCheck).toHaveBeenCalledWith({
      tenant_id: "tenant-row",
      conductor_run_id: "cond-1",
      node_id: "d",
    });
    expect(order).toEqual(["save", "status", "request"]);
    const deploy = current().goal_graph.find((n) => n.id === "d")!;
    expect(deploy.status).toBe("done");
    expect(deploy.screen_check).toBeUndefined();
  });

  it("a request that throws or rejects never changes the build outcome", async () => {
    for (const requestScreenCheck of [
      vi.fn(() => {
        throw new Error("sync boom");
      }),
      vi.fn(async () => {
        throw new Error("async boom");
      }),
    ]) {
      const { deps, current } = harness(liveGraph(), { requestScreenCheck });
      expect(await conductorTick("cond-1", deps)).toEqual({ action: "completed", final: "done" });
      expect(current().status).toBe("done");
    }
  });

  it("no request while hosting is still provisioning or failed", async () => {
    for (const hs of ["provisioning", "none", "failed"] as const) {
      const requestScreenCheck = vi.fn(async () => undefined);
      const { deps } = harness(liveGraph(), {
        requestScreenCheck,
        hostingStatus: vi.fn(async () => hs),
      });
      await conductorTick("cond-1", deps);
      expect(requestScreenCheck).not.toHaveBeenCalled();
    }
  });
});
