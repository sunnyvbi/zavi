import { describe, expect, it, vi } from "vitest";
import { conductorTick, type ConductorNode, type ConductorRow, type ConductorTickDeps } from "../conductor";

const SITE = "aaaaaaaa-0000-4000-8000-000000000001";
const STARTED = "2026-10-02T10:00:00.000Z";

function engineer(over: Partial<ConductorNode> = {}): ConductorNode {
  return {
    id: "refine-1",
    status: "done",
    target_agent_slug: "engineer",
    payload: { stage: "build", refine_mode: true, site_id: SITE, idea: "make the title bigger" },
    estimate_usd: 3,
    child_run_id: "child-1",
    started_at: STARTED,
    finished_at: "2026-10-02T10:01:00.000Z",
    ...over,
  };
}

function deployNode(over: Partial<ConductorNode> = {}): ConductorNode {
  return {
    id: "refine-deploy-1",
    status: "pending",
    target_agent_slug: "",
    payload: { stage: "deploy", site_id: SITE, site_sha: "a".repeat(40), site_desired_sha: "a".repeat(40) },
    estimate_usd: 0,
    child_run_id: null,
    ...over,
  };
}

function deps(graph: ConductorNode[], live = true) {
  const row: ConductorRow = {
    id: "cond-1",
    tenant_id: "t1",
    objective: "[refine] x",
    status: "active",
    max_usd: 5,
    spend_usd: 0,
    kind: "build_app",
    goal_graph: graph,
  };
  const clearSiteInlineEditsOnRefine = vi.fn();
  const setStatus = vi.fn(async () => {});
  const d: ConductorTickDeps = {
    load: vi.fn(async () => row),
    childStatus: vi.fn(async () => "success" as const),
    consumeBudget: vi.fn(async () => "charged" as const),
    dispatch: vi.fn(async () => ({ ok: true as const, child_run_id: "x" })),
    saveGraph: vi.fn(async () => {}),
    setStatus,
    clearSiteInlineEditsOnRefine,
    now: () => Date.parse("2026-10-02T10:05:00.000Z"),
    siteDeploy: {
      repairMaxAttempts: async () => 2,
      step: vi.fn(async () =>
        live ? { kind: "live" as const, url: "https://x.zavi.site", verified_at: "2026-10-02T10:04:00.000Z" } : { kind: "waiting" as const },
      ),
      headSha: vi.fn(async () => "a".repeat(40)),
      markDesired: vi.fn(async () => {}),
    },
  };
  return { d, clearSiteInlineEditsOnRefine, setStatus };
}

const CARRIED = [
  { id: "e1", updated_at: "2026-10-02T09:59:00.000Z" },
  { id: "e2", updated_at: "2026-10-02T09:59:30.000Z" },
];

function applyEngineer(over: Partial<ConductorNode> = {}): ConductorNode {
  return engineer({
    payload: { stage: "build", refine_mode: true, site_id: SITE, idea: "Apply these exact edits", site_inline_edits: CARRIED },
    ...over,
  });
}

describe("an Apply refine clears only the drafts it carried, once it succeeds", () => {
  it("a refine that stops at the preview clears exactly the carried rows", async () => {
    const { d, clearSiteInlineEditsOnRefine, setStatus } = deps([applyEngineer()]);
    expect(await conductorTick("cond-1", d)).toEqual({ action: "completed", final: "done" });
    expect(setStatus).toHaveBeenCalledWith("cond-1", "done");
    expect(clearSiteInlineEditsOnRefine).toHaveBeenCalledTimes(1);
    expect(clearSiteInlineEditsOnRefine).toHaveBeenCalledWith({ tenant_id: "t1", site_id: SITE, rows: CARRIED });
  });

  it("a refine that publishes clears them once the site is live", async () => {
    const { d, clearSiteInlineEditsOnRefine } = deps([applyEngineer(), deployNode()]);
    expect(await conductorTick("cond-1", d)).toEqual({ action: "completed", final: "done" });
    expect(clearSiteInlineEditsOnRefine).toHaveBeenCalledWith({ tenant_id: "t1", site_id: SITE, rows: CARRIED });
  });

  it("nothing is cleared while the publish is still in flight", async () => {
    const { d, clearSiteInlineEditsOnRefine } = deps([applyEngineer(), deployNode()], false);
    await conductorTick("cond-1", d);
    expect(clearSiteInlineEditsOnRefine).not.toHaveBeenCalled();
  });

  it("a plain chat refine of the site deletes no drafts at all", async () => {
    const { d, clearSiteInlineEditsOnRefine } = deps([engineer(), deployNode()]);
    expect(await conductorTick("cond-1", d)).toEqual({ action: "completed", final: "done" });
    expect(clearSiteInlineEditsOnRefine).not.toHaveBeenCalled();
  });

  it("a publish or undo republish (no code change) keeps the drafts", async () => {
    const { d, clearSiteInlineEditsOnRefine } = deps([
      deployNode({ payload: { stage: "deploy", refine_mode: true, site_id: SITE, site_sha: "a".repeat(40), site_desired_sha: "a".repeat(40), site_inline_edits: CARRIED } }),
    ]);
    expect(await conductorTick("cond-1", d)).toEqual({ action: "completed", final: "done" });
    expect(clearSiteInlineEditsOnRefine).not.toHaveBeenCalled();
  });

  it("a failed Apply refine keeps every carried draft", async () => {
    const { d, clearSiteInlineEditsOnRefine } = deps([applyEngineer({ status: "failed" })]);
    await conductorTick("cond-1", d);
    expect(clearSiteInlineEditsOnRefine).not.toHaveBeenCalled();
  });

  it("an Apply refine whose publish fails keeps every carried draft", async () => {
    const { d, clearSiteInlineEditsOnRefine } = deps([applyEngineer(), deployNode()]);
    d.siteDeploy!.step = vi.fn(async () => ({ kind: "failed" as const, reason: "verify failed" }));
    await conductorTick("cond-1", d);
    expect(clearSiteInlineEditsOnRefine).not.toHaveBeenCalled();
  });

  it("malformed carried rows are dropped and an all-malformed list clears nothing", async () => {
    const bad = applyEngineer({
      payload: { stage: "build", refine_mode: true, site_id: SITE, site_inline_edits: [{ id: 1 }, null, "x", { id: "e9" }] },
    });
    const { d, clearSiteInlineEditsOnRefine } = deps([bad]);
    await conductorTick("cond-1", d);
    expect(clearSiteInlineEditsOnRefine).not.toHaveBeenCalled();
  });

  it("a refine of the old-flow app (no site) never calls the site clear", async () => {
    const { d, clearSiteInlineEditsOnRefine } = deps([
      engineer({ payload: { stage: "build", refine_mode: true, idea: "x", site_inline_edits: CARRIED } }),
    ]);
    await conductorTick("cond-1", d);
    expect(clearSiteInlineEditsOnRefine).not.toHaveBeenCalled();
  });

  it("a throwing clear never changes the run's outcome", async () => {
    const { d, setStatus } = deps([applyEngineer()]);
    d.clearSiteInlineEditsOnRefine = () => {
      throw new Error("db down");
    };
    expect(await conductorTick("cond-1", d)).toEqual({ action: "completed", final: "done" });
    expect(setStatus).toHaveBeenCalledWith("cond-1", "done");
  });
});
