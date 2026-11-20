import { describe, it, expect, vi } from "vitest";
import {
  conductorTick,
  type ConductorNode,
  type ConductorRow,
  type ConductorTickDeps,
  type SiteDeployDeps,
} from "@/services/agents/conductor";

const TENANT = "11111111-1111-4111-8111-111111111111";
const SITE_ID = "aaaaaaaa-0000-4000-8000-000000000001";

function editNode(over: Record<string, unknown> = {}): ConductorNode {
  return {
    id: "refine-1",
    status: "pending",
    target_agent_slug: "engineer",
    payload: { stage: "build", refine_mode: true, site_id: SITE_ID, stop_at_preview: true, ...over },
    estimate_usd: 3,
    child_run_id: null,
  };
}

function deployNode(): ConductorNode {
  return {
    id: "refine-deploy-1",
    status: "pending",
    target_agent_slug: "",
    payload: { stage: "deploy", site_id: SITE_ID, refine_deploy_enqueued_at: Date.now(), pre_refine_sha: "1111111" },
    estimate_usd: 0,
    child_run_id: null,
  };
}

function harness(start: ConductorNode[], over: Partial<ConductorTickDeps> = {}) {
  let graph = start.map((n) => ({ ...n, payload: { ...n.payload } }));
  let status: ConductorRow["status"] = "active";
  const statuses: string[] = [];
  const siteDeploy: SiteDeployDeps = {
    step: vi.fn(async () => ({ kind: "waiting" as const })),
    headSha: vi.fn(async () => "1111111"),
    ownsSite: vi.fn(async () => true),
    markDesired: vi.fn(async () => undefined),
    settle: vi.fn(async () => undefined),
    repairMaxAttempts: vi.fn(async () => 1),
  };
  const tick: ConductorTickDeps = {
    load: async () => ({
      id: "cr_refine_1",
      tenant_id: TENANT,
      objective: "[refine] change the footer tagline",
      status,
      max_usd: 5,
      spend_usd: 0,
      kind: "build_app",
      goal_graph: graph,
    }),
    childStatus: async () => "success",
    consumeBudget: vi.fn(async () => "charged" as const),
    dispatch: vi.fn(async () => ({ ok: true as const, child_run_id: "child-edit" })),
    verifyStagePush: vi.fn(async () => "missing" as const),
    saveGraph: async (_id, g) => {
      graph = g.map((n) => ({ ...n, payload: { ...n.payload } }));
    },
    setStatus: async (_id, next) => {
      statuses.push(next);
      status = next;
    },
    hostingStatus: vi.fn(async () => "ready" as const),
    siteDeploy,
    ...over,
  };
  return { tick, siteDeploy, statuses, graph: () => graph };
}

const fast = { fast_edit: true, small_edit: true, edit_routed: "auto", edit_size: "tweak" };

describe("a fast edit pass that declared a route miss", () => {
  it("is re-dispatched once as the full pass with fresh dispatch keys and the full estimate", async () => {
    let dispatched = 0;
    const dispatch = vi.fn(async (_input: { payload: Record<string, unknown> }) => ({ ok: true as const, child_run_id: ++dispatched === 1 ? "child-fast" : "child-full" }));
    const routeMiss = vi.fn(async ({ child_run_id }: { child_run_id: string }) => child_run_id === "child-fast");
    const h = harness([{ ...editNode(fast), estimate_usd: 0.4 }], {
      childDeclaredOutcome: async () => "refused" as const,
      childRouteMiss: routeMiss,
      dispatch,
    });
    expect(await conductorTick("cr_refine_1", h.tick)).toMatchObject({ action: "dispatched", child_run_id: "child-fast" });
    expect(await conductorTick("cr_refine_1", h.tick)).toMatchObject({ action: "dispatched", child_run_id: "child-full" });
    expect(h.statuses).toEqual([]);
    const [node] = h.graph();
    expect(node.status).toBe("dispatched");
    expect(node.estimate_usd).toBe(3);
    expect(node.payload).toMatchObject({ escalated_from_fast: true, resume_epoch: 1, edit_size: "section" });
    expect(node.payload.fast_edit).toBeUndefined();
    expect(node.payload.no_change).toBeUndefined();
    expect(h.tick.consumeBudget).toHaveBeenLastCalledWith("cr_refine_1", 3);
    expect(dispatch.mock.calls[1][0].payload).toMatchObject({ resume_epoch: 1 });

    expect(await conductorTick("cr_refine_1", h.tick)).toEqual({ action: "completed", final: "done" });
    expect(h.graph()[0].payload).toMatchObject({ no_change: true, declared_outcome: "refused" });
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(routeMiss).toHaveBeenCalledTimes(1);
  });

  it("an inline Apply that could not find the element escalates the same way", async () => {
    const h = harness([editNode({ fast_edit: true, small_edit: true, site_inline_edits: [{ id: "e1", updated_at: "t" }] })], {
      childDeclaredOutcome: async () => "refused" as const,
      childRouteMiss: async () => true,
    });
    await conductorTick("cr_refine_1", h.tick);
    await conductorTick("cr_refine_1", h.tick);
    expect(h.graph()[0].payload).toMatchObject({ escalated_from_fast: true, site_inline_edits: [{ id: "e1", updated_at: "t" }] });
    expect(h.tick.dispatch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["a plain answer from the fast pass", fast, false],
    ["a full pass", { edit_size: "page" }, true],
  ])("%s settles at once, no second run", async (_label, payload, miss) => {
    const h = harness([editNode(payload)], { childDeclaredOutcome: async () => "no_change" as const, childRouteMiss: async () => miss });
    await conductorTick("cr_refine_1", h.tick);
    expect(await conductorTick("cr_refine_1", h.tick)).toEqual({ action: "completed", final: "done" });
    expect(h.tick.dispatch).toHaveBeenCalledTimes(1);
    expect(h.graph()[0].payload.no_change).toBe(true);
  });

  it("an unreadable route-miss check settles the answer as before", async () => {
    const h = harness([editNode(fast)], {
      childDeclaredOutcome: async () => "refused" as const,
      childRouteMiss: async () => {
        throw new Error("db down");
      },
    });
    await conductorTick("cr_refine_1", h.tick);
    expect(await conductorTick("cr_refine_1", h.tick)).toEqual({ action: "completed", final: "done" });
    expect(h.tick.dispatch).toHaveBeenCalledTimes(1);
  });
});
