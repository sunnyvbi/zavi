import { describe, it, expect, vi } from "vitest";
import {
  conductorTick,
  type ConductorNode,
  type ConductorRow,
  type ConductorTickDeps,
  type SiteDeployDeps,
} from "@/services/agents/conductor";
import { declaredRefineOutcome, isDeclaredNoChange } from "@/services/agents/refine-no-change";
import { unpublishedSiteChanges } from "@/services/sites/site-pending";

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

describe("a refine whose engineer found nothing to change", () => {
  it("does not claim a reported preview error is fixed when the engineer changed nothing", async () => {
    const h = harness([editNode({ idea: 'Fix this error in the preview: Failed to resolve import "lucide-react"' })], { childDeclaredOutcome: async () => "no_change" as const });
    await conductorTick("cr_refine_1", h.tick);
    const outcome = await conductorTick("cr_refine_1", h.tick);
    expect(outcome).not.toMatchObject({ action: "completed", final: "done" });
    expect(h.graph()[0].payload.no_change).not.toBe(true);
  });
  it("settles done at once, marked no_change, without waiting on the push gate", async () => {
    const declared = vi.fn(async () => "no_change" as const);
    const h = harness([editNode()], { childDeclaredOutcome: declared });
    expect(await conductorTick("cr_refine_1", h.tick)).toMatchObject({ action: "dispatched", child_run_id: "child-edit" });
    expect(await conductorTick("cr_refine_1", h.tick)).toEqual({ action: "completed", final: "done" });
    expect(h.statuses).toEqual(["done"]);
    const [node] = h.graph();
    expect(node.status).toBe("done");
    expect(node.payload.no_change).toBe(true);
    expect(node.checkpoint?.kind).toBe("no_change");
    expect(declared).toHaveBeenCalledWith({ tenant_id: TENANT, child_run_id: "child-edit" });
    expect(h.tick.verifyStagePush).not.toHaveBeenCalled();
  });

  it("also settles the refine's deploy gate: there is no new commit to publish", async () => {
    const h = harness([editNode({ stop_at_preview: undefined }), deployNode()], { childDeclaredOutcome: async () => "no_change" as const });
    await conductorTick("cr_refine_1", h.tick);
    expect(await conductorTick("cr_refine_1", h.tick)).toEqual({ action: "completed", final: "done" });
    expect(h.graph().map((n) => n.status)).toEqual(["done", "done"]);
    expect(h.siteDeploy.markDesired).not.toHaveBeenCalled();
    expect(h.siteDeploy.step).not.toHaveBeenCalled();
  });

  it("before the fix the same run stayed in flight on the push gate (the reported hang)", async () => {
    const h = harness([editNode()]);
    await conductorTick("cr_refine_1", h.tick);
    expect(await conductorTick("cr_refine_1", h.tick)).toEqual({ action: "waiting", in_flight: 1 });
    expect(h.graph()[0].status).toBe("dispatched");
    expect(h.statuses).toEqual([]);
  });

  it("a real change (no declared no_change) still goes through the push gate", async () => {
    const h = harness([editNode()], { childDeclaredOutcome: async () => null });
    await conductorTick("cr_refine_1", h.tick);
    expect(await conductorTick("cr_refine_1", h.tick)).toEqual({ action: "waiting", in_flight: 1 });
    expect(h.tick.verifyStagePush).toHaveBeenCalled();
  });

  it("a read that throws takes the normal path, never a guessed no-op", async () => {
    const h = harness([editNode()], { childDeclaredOutcome: async () => { throw new Error("db down"); } });
    await conductorTick("cr_refine_1", h.tick);
    expect(await conductorTick("cr_refine_1", h.tick)).toEqual({ action: "waiting", in_flight: 1 });
  });

  it("a fresh build's build stage is never settled this way", async () => {
    const declared = vi.fn(async () => "no_change" as const);
    const h = harness([editNode({ refine_mode: undefined, stop_at_preview: undefined })], { childDeclaredOutcome: declared });
    await conductorTick("cr_refine_1", h.tick);
    await conductorTick("cr_refine_1", h.tick);
    expect(declared).not.toHaveBeenCalled();
  });
});

describe("a refine whose engineer asked a question or refused also finishes at once (round 9)", () => {
  it.each(["needs_input", "refused"] as const)("%s settles done with its outcome recorded, no push gate, no deploy", async (outcome) => {
    const h = harness([editNode({ stop_at_preview: undefined }), deployNode()], { childDeclaredOutcome: async () => outcome });
    await conductorTick("cr_refine_1", h.tick);
    expect(await conductorTick("cr_refine_1", h.tick)).toEqual({ action: "completed", final: "done" });
    const [node, deploy] = h.graph();
    expect(node.status).toBe("done");
    expect(node.payload).toMatchObject({ no_change: true, declared_outcome: outcome });
    expect(deploy.status).toBe("done");
    expect(h.tick.verifyStagePush).not.toHaveBeenCalled();
    expect(h.siteDeploy.markDesired).not.toHaveBeenCalled();
  });
});

describe("declared outcomes: drafts and repairs", () => {
  it("a repair attempt's declaration is not trusted (an earlier attempt may have pushed late): the normal gate runs", async () => {
    const declared = vi.fn(async () => "no_change" as const);
    const h = harness([{ ...editNode(), status: "dispatched", child_run_id: "child-repair", repair_attempts: 1 }], { childDeclaredOutcome: declared });
    expect(await conductorTick("cr_refine_1", h.tick)).toEqual({ action: "waiting", in_flight: 1 });
    expect(declared).not.toHaveBeenCalled();
    expect(h.tick.verifyStagePush).toHaveBeenCalled();
  });

  it.each([
    ["needs_input", false],
    ["refused", false],
    ["no_change", false],
  ] as const)("Apply edits answered %s: drafts cleared = %s", async (outcome, cleared) => {
    const clear = vi.fn();
    const h = harness([editNode({ site_inline_edits: [{ id: "e1", updated_at: "2026-10-02T10:00:00Z" }] })], {
      childDeclaredOutcome: async () => outcome,
      clearSiteInlineEditsOnRefine: clear,
    });
    await conductorTick("cr_refine_1", h.tick);
    expect(await conductorTick("cr_refine_1", h.tick)).toEqual({ action: "completed", final: "done" });
    expect(clear.mock.calls.length > 0).toBe(cleared);
  });
});

describe("an Apply whose engineer answered no_change keeps the founder's text", () => {
  it("keeps the drafts so the pill comes back and the founder can send again, while the run still settles as a no-op", async () => {
    const clear = vi.fn();
    const carried = [{ id: "e1", updated_at: "2026-10-02T10:00:00Z" }, { id: "e2", updated_at: "2026-10-02T10:00:05Z" }];
    const h = harness([editNode({ site_inline_edits: carried })], { childDeclaredOutcome: async () => "no_change" as const, clearSiteInlineEditsOnRefine: clear });
    await conductorTick("cr_refine_1", h.tick);
    expect(await conductorTick("cr_refine_1", h.tick)).toEqual({ action: "completed", final: "done" });
    expect(clear).not.toHaveBeenCalled();
    expect(h.graph()[0].payload).toMatchObject({ no_change: true, declared_outcome: "no_change" });
    expect(h.statuses).toEqual(["done"]);
  });

  it("an Apply that did change the code still clears exactly the carried drafts", async () => {
    const clear = vi.fn();
    const carried = [{ id: "e1", updated_at: "2026-10-02T10:00:00Z" }];
    const h = harness([editNode({ site_inline_edits: carried })], {
      childDeclaredOutcome: async () => null,
      verifyStagePush: vi.fn(async () => "landed" as const),
      clearSiteInlineEditsOnRefine: clear,
    });
    await conductorTick("cr_refine_1", h.tick);
    await conductorTick("cr_refine_1", h.tick);
    expect(clear).toHaveBeenCalledWith({ tenant_id: TENANT, site_id: SITE_ID, rows: carried });
  });
});

describe("declaredRefineOutcome", () => {
  it("maps each declared answer", () => {
    expect(declaredRefineOutcome({ parsed: { refused: true, reason_code: "no_change", customer_summary: "x" } })).toBe("no_change");
    expect(declaredRefineOutcome({ parsed: { refused: true, reason_code: "needs_input", customer_summary: "Which footer?" } })).toBe("needs_input");
    expect(declaredRefineOutcome({ parsed: { refused: true, reason_code: "blocked" } })).toBe("refused");
    expect(declaredRefineOutcome({ parsed: { refused: true, reason_code: "wrong_repo" } })).toBe("refused");
    expect(declaredRefineOutcome({ parsed: { refused: true } })).toBe("refused");
    expect(declaredRefineOutcome({ outcome: { side_effect: { kind: "refused", reason_code: "needs_input" } } })).toBe("needs_input");
  });
  it("is null for a change, or a refusal that is not the engineer's declared answer", () => {
    expect(declaredRefineOutcome({ parsed: { refused: true, reason_code: "needs_input", commit_sha: "abc1234" } })).toBeNull();
    expect(declaredRefineOutcome({ outcome: { side_effect: { kind: "refused", reason: "empty_diff" } } })).toBeNull();
    expect(declaredRefineOutcome({ parsed: { summary: "Changed the footer" } })).toBeNull();
    expect(declaredRefineOutcome({})).toBeNull();
  });
});

describe("isDeclaredNoChange", () => {
  it("reads the engineer's declared no_change refusal", () => {
    expect(isDeclaredNoChange({ parsed: { refused: true, reason_code: "no_change", customer_summary: "It already says that." } })).toBe(true);
    expect(isDeclaredNoChange({ parsed: null, outcome: { side_effect: { kind: "refused", reason_code: "no_change" } } })).toBe(true);
  });
  it("is false for anything else", () => {
    expect(isDeclaredNoChange({ parsed: { refused: true, reason_code: "blocked" } })).toBe(false);
    expect(isDeclaredNoChange({ parsed: { reason_code: "no_change" } })).toBe(false);
    expect(isDeclaredNoChange({ parsed: { refused: true, reason_code: "no_change", commit_sha: "abc1234" } })).toBe(false);
    expect(isDeclaredNoChange({ parsed: { refused: true, reason_code: "no_change", pr_url: "https://x/pr/1" } })).toBe(false);
    expect(isDeclaredNoChange({})).toBe(false);
  });
});

describe("a no-change edit is not a change", () => {
  const edit = (id: string, at: string, extra: Record<string, unknown> = {}) => ({
    id,
    kind: "build_app",
    status: "done",
    created_at: at,
    goal_graph: [{ payload: { stage: "build", refine_mode: true, stop_at_preview: true, site_id: SITE_ID, ...extra } }],
  });

  it("is not listed as waiting for Publish", () => {
    const rows = [edit("e1", "2026-10-02T10:00:00Z"), edit("e2", "2026-10-02T11:00:00Z", { no_change: true })];
    expect(unpublishedSiteChanges(rows).map((c) => c.id)).toEqual(["e1"]);
  });
});
