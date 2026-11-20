import { describe, it, expect, vi } from "vitest";
import {
  conductorTick,
  type ConductorRow,
  type ConductorNode,
  type ConductorTickDeps,
  type StaticPublishPlan,
} from "../conductor";

const SHA = "a".repeat(40);
const SHA2 = "b".repeat(40);

function graph(deployPayload: Record<string, unknown> = {}, refine = false): ConductorNode[] {
  return [
    {
      id: "b",
      status: "done",
      target_agent_slug: "engineer",
      payload: { stage: "build", ...(refine ? { refine_mode: true } : {}) },
      estimate_usd: 3,
      child_run_id: "c-b",
    },
    { id: "d", status: "pending", target_agent_slug: "", payload: { stage: "deploy", ...deployPayload }, estimate_usd: 0, child_run_id: null },
  ];
}

function harness(
  initial: ConductorNode[],
  opts: {
    hs?: () => Promise<"ready" | "failed" | "provisioning" | "none">;
    sha?: () => Promise<string | null>;
    plan?: (i: { tenant_id: string; refine: boolean }) => Promise<StaticPublishPlan>;
    request?: (i: unknown) => Promise<unknown>;
    staticOff?: boolean;
  } = {},
) {
  let row: ConductorRow = {
    id: "cond-1",
    tenant_id: "tenant-row",
    objective: "build",
    status: "active",
    max_usd: 50,
    spend_usd: 0,
    kind: "build_app",
    goal_graph: initial,
  };
  const saves: ConductorNode[][] = [];
  const sha = opts.sha ?? (async () => SHA);
  const plan = vi.fn(
    opts.plan ??
      (async (): Promise<StaticPublishPlan> => {
        const s = await sha();
        return s ? { action: "publish", sha: s } : { action: "none" };
      }),
  );
  const request = vi.fn(opts.request ?? (async () => undefined));
  const rollback = vi.fn(async () => undefined);
  const hostingStatus = vi.fn(opts.hs ?? (async () => "provisioning" as const));
  const deps = {
    load: vi.fn(async () => row),
    childStatus: vi.fn(async () => "success" as const),
    consumeBudget: vi.fn(async () => "charged" as const),
    dispatch: vi.fn(async () => ({ ok: true as const, child_run_id: "x" })),
    saveGraph: vi.fn(async (_id: string, g: ConductorNode[]) => {
      saves.push(JSON.parse(JSON.stringify(g)));
      row = { ...row, goal_graph: JSON.parse(JSON.stringify(g)) as ConductorNode[] };
    }),
    setStatus: vi.fn(async (_id: string, status: string) => {
      row = { ...row, status: status as ConductorRow["status"] };
    }),
    hostingStatus,
    ...(opts.staticOff ? {} : { staticPublish: { plan, request, rollback } }),
  } as unknown as ConductorTickDeps;
  return { deps, plan, request, rollback, hostingStatus, saves, current: () => row };
}

const deployPayload = (h: { current: () => ConductorRow }) =>
  h.current().goal_graph.find((n) => n.id === "d")!.payload as Record<string, unknown>;

describe("conductor deploy node: static publish request", () => {
  it("eligible build sends exactly one event across repeated ticks and persists the sha in the same save", async () => {
    const h = harness(graph());
    for (let i = 0; i < 4; i++) {
      expect(await conductorTick("cond-1", h.deps)).toEqual({ action: "waiting", in_flight: 0 });
    }
    expect(h.request).toHaveBeenCalledTimes(1);
    expect(h.request).toHaveBeenCalledWith({ tenant_id: "tenant-row", conductor_run_id: "cond-1", sha: SHA });
    expect(h.saves[0].find((n) => n.id === "d")!.payload).toMatchObject({
      static_publish_requested_sha: SHA,
      deploy_enqueued_at: expect.any(Number),
    });
    expect(h.plan).toHaveBeenCalledWith({ tenant_id: "tenant-row", refine: false });
  });

  it("requests once more when the pushed sha moves, then dedupes again", async () => {
    let sha = SHA;
    const h = harness(graph(), { sha: async () => sha });
    await conductorTick("cond-1", h.deps);
    await conductorTick("cond-1", h.deps);
    sha = SHA2;
    await conductorTick("cond-1", h.deps);
    await conductorTick("cond-1", h.deps);
    expect(h.request.mock.calls.map((c) => (c[0] as { sha: string }).sha)).toEqual([SHA, SHA2]);
    expect(deployPayload(h).static_publish_requested_sha).toBe(SHA2);
  });

  it("not eligible sends nothing and leaves the payload untouched", async () => {
    const h = harness(graph(), { sha: async () => null });
    await conductorTick("cond-1", h.deps);
    await conductorTick("cond-1", h.deps);
    expect(h.request).not.toHaveBeenCalled();
    expect(deployPayload(h)).not.toHaveProperty("static_publish_requested_sha");
  });

  it("dep absent (flag off wiring) sends nothing and the gate sees the same node as before", async () => {
    const h = harness(graph(), { staticOff: true });
    await conductorTick("cond-1", h.deps);
    expect(Object.keys(deployPayload(h)).sort()).toEqual(["deploy_enqueued_at", "stage"]);
  });

  it("a failed send is not recorded, so the next tick retries", async () => {
    let fail = true;
    const h = harness(graph(), {
      request: async () => {
        if (fail) throw new Error("inngest down");
      },
    });
    expect(await conductorTick("cond-1", h.deps)).toEqual({ action: "waiting", in_flight: 0 });
    expect(deployPayload(h)).not.toHaveProperty("static_publish_requested_sha");
    fail = false;
    await conductorTick("cond-1", h.deps);
    await conductorTick("cond-1", h.deps);
    expect(h.request).toHaveBeenCalledTimes(2);
    expect(deployPayload(h).static_publish_requested_sha).toBe(SHA);
  });

  it("a throwing eligibility read never wedges the gate", async () => {
    const h = harness(graph(), {
      sha: async () => {
        throw new Error("boom");
      },
      hs: async () => "ready",
    });
    expect(await conductorTick("cond-1", h.deps)).toEqual({ action: "completed", final: "done" });
    expect(h.request).not.toHaveBeenCalled();
  });

  it("a refine deploy node asks for a refine plan and requests exactly one publish for the pushed sha", async () => {
    let head = SHA2;
    const h = harness(graph({ pre_refine_sha: SHA2 }, true), { sha: async () => head });
    await conductorTick("cond-1", h.deps);
    await conductorTick("cond-1", h.deps);
    expect(h.request).not.toHaveBeenCalled();
    expect(deployPayload(h)).not.toHaveProperty("static_publish_requested_sha");
    head = SHA;
    for (let i = 0; i < 3; i++) await conductorTick("cond-1", h.deps);
    expect(h.plan).toHaveBeenCalledWith({ tenant_id: "tenant-row", refine: true });
    expect(h.request).toHaveBeenCalledTimes(1);
    expect(h.request).toHaveBeenCalledWith({ tenant_id: "tenant-row", conductor_run_id: "cond-1", sha: SHA });
    expect(deployPayload(h).static_publish_requested_sha).toBe(SHA);
  });

  it("a refine_mode graph without pre_refine_sha is still a refine plan", async () => {
    const h = harness(graph({}, true));
    await conductorTick("cond-1", h.deps);
    expect(h.plan).toHaveBeenCalledWith({ tenant_id: "tenant-row", refine: true });
    expect(h.request).toHaveBeenCalledTimes(1);
  });

  it("a rollback plan rolls the host back and records no request", async () => {
    const h = harness(graph({ pre_refine_sha: SHA2 }, true), { plan: async () => ({ action: "rollback" }) });
    await conductorTick("cond-1", h.deps);
    expect(h.rollback).toHaveBeenCalledWith({ tenant_id: "tenant-row" });
    expect(h.request).not.toHaveBeenCalled();
    expect(deployPayload(h)).not.toHaveProperty("static_publish_requested_sha");
  });

  it("the request goes out before the gate reads hosting, and a ready gate still completes with the sha saved", async () => {
    const order: string[] = [];
    const h = harness(graph(), {
      request: async () => {
        order.push("request");
      },
      hs: async () => {
        order.push("hosting");
        return "ready";
      },
    });
    expect(await conductorTick("cond-1", h.deps)).toEqual({ action: "completed", final: "done" });
    expect(order).toEqual(["request", "hosting"]);
    expect(deployPayload(h).static_publish_requested_sha).toBe(SHA);
    expect((h.hostingStatus.mock.calls[0] as unknown[])[1]).toMatchObject({ payload: { static_publish_requested_sha: SHA } });
  });
});
