
import { describe, it, expect, vi } from "vitest";
import {
  conductorTick,
  type ConductorRow,
  type ConductorNode,
  type ConductorTickDeps,
  type ChildTerminalStatus,
} from "../conductor";

const TARGET = { github_full_name: "Praxis-build/app-1" };

function node(over: Partial<ConductorNode> & { id: string }): ConductorNode {
  return {
    status: "pending",
    target_agent_slug: "engineer",
    payload: { stage: "build", target: TARGET },
    estimate_usd: 3,
    child_run_id: null,
    ...over,
  };
}

function row(goal_graph: ConductorNode[], over: Partial<ConductorRow> = {}): ConductorRow {
  return {
    id: "cond-1",
    tenant_id: "t1",
    objective: "build product",
    status: "active",
    max_usd: 50,
    spend_usd: 0,
    kind: "build_app",
    goal_graph,
    ...over,
  };
}

function captureSaved() {
  const saved: ConductorNode[][] = [];
  const saveGraph = vi.fn(async (_id: string, graph: ConductorNode[]) => {
    saved.push(JSON.parse(JSON.stringify(graph)) as ConductorNode[]);
  });
  const nodeById = (id: string) => {
    for (let i = saved.length - 1; i >= 0; i--) {
      const hit = saved[i].find((n) => n.id === id);
      if (hit) return hit;
    }
    return undefined;
  };
  return { saveGraph, nodeById };
}

function makeDeps(opts: Partial<ConductorTickDeps> & { row: ConductorRow }): ConductorTickDeps {
  return {
    load: vi.fn(async () => opts.row),
    childStatus: opts.childStatus ?? vi.fn(async () => "failed" as ChildTerminalStatus),
    consumeBudget: vi.fn(async () => "charged" as const),
    dispatch: vi.fn(async () => ({ ok: true as const, child_run_id: "next-child" })),
    saveGraph: opts.saveGraph ?? vi.fn(async () => {}),
    setStatus: vi.fn(async () => {}),
    now: () => Date.parse("2026-09-22T20:00:00Z"),
    noChangeCheckpoint: opts.noChangeCheckpoint,
    stageCommitSha: opts.stageCommitSha,
    verifyStagePush: opts.verifyStagePush,
    startPreview: opts.startPreview,
  };
}

const scaffoldDone = () =>
  node({
    id: "scaffold",
    status: "done",
    payload: { stage: "scaffold", target: TARGET },
    checkpoint: { kind: "pushed", commit_sha: "30bd5f3", verified_at: "2026-09-22T19:00:00.000Z" },
  });
const buildInFlight = (payload: Record<string, unknown> = {}) =>
  node({ id: "build", status: "dispatched", child_run_id: "eng-build-1", payload: { stage: "build", target: TARGET, ...payload } });
const qaPending = () => node({ id: "qa", target_agent_slug: "qa", payload: { stage: "qa", target: TARGET }, estimate_usd: 0.5 });

describe("conductorTick — checkpoint no-change rule", () => {
  it("a verified no-change build stage passes with a no_change checkpoint", async () => {
    const noChangeCheckpoint = vi.fn(async () => ({ commit_sha: "30bd5f3" }));
    const { saveGraph, nodeById } = captureSaved();
    const deps = makeDeps({
      row: row([scaffoldDone(), buildInFlight(), qaPending()]),
      noChangeCheckpoint,
      saveGraph,
    });
    await conductorTick("cond-1", deps);
    expect(noChangeCheckpoint).toHaveBeenCalledWith({
      tenant_id: "t1",
      conductor_run_id: "cond-1",
      child_run_id: "eng-build-1",
      earlier_stage_landed: true,
    });
    expect(nodeById("build")).toMatchObject({
      status: "done",
      error: null,
      checkpoint: { kind: "no_change", commit_sha: "30bd5f3" },
    });
    expect(nodeById("qa")?.status).toBe("done");
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it("a verified no-change scaffold still kicks the instant preview, like a normal scaffold success", async () => {
    const startPreview = vi.fn();
    const { saveGraph, nodeById } = captureSaved();
    await conductorTick(
      "cond-1",
      makeDeps({
        row: row([
          node({ id: "scaffold", status: "dispatched", child_run_id: "eng-scaffold-2", payload: { stage: "scaffold", target: TARGET } }),
          node({ id: "build", payload: { stage: "build", target: TARGET } }),
        ]),
        noChangeCheckpoint: vi.fn(async () => ({ commit_sha: "abc123" })),
        startPreview,
        saveGraph,
      }),
    );
    expect(nodeById("scaffold")?.status).toBe("done");
    expect(startPreview).toHaveBeenCalledOnce();
  });

  it("an unverified no-change is still a failure (repair decides, as today)", async () => {
    for (const noChangeCheckpoint of [vi.fn(async () => null), vi.fn(async () => { throw new Error("blip"); })]) {
      const { saveGraph, nodeById } = captureSaved();
      await conductorTick(
        "cond-1",
        makeDeps({ row: row([scaffoldDone(), buildInFlight(), qaPending()]), noChangeCheckpoint, saveGraph }),
      );
      expect(nodeById("build")?.status).toBe("failed");
      expect(nodeById("build")?.checkpoint).toBeUndefined();
    }
  });

  it("never judges a chat refine's no-change, or a non-codegen stage, this way", async () => {
    const noChangeCheckpoint = vi.fn(async () => ({ commit_sha: "abc" }));
    await conductorTick(
      "cond-1",
      makeDeps({ row: row([buildInFlight({ refine_mode: true })]), noChangeCheckpoint }),
    );
    await conductorTick(
      "cond-1",
      makeDeps({
        row: row([scaffoldDone(), node({ id: "qa", target_agent_slug: "qa", status: "dispatched", child_run_id: "qa-1", payload: { stage: "qa" } })]),
        noChangeCheckpoint,
      }),
    );
    await conductorTick(
      "cond-1",
      makeDeps({ row: row([scaffoldDone(), buildInFlight()], { kind: "company_goal" }), noChangeCheckpoint }),
    );
    expect(noChangeCheckpoint).not.toHaveBeenCalled();
  });

  it("a done stage without a confirmed push is not landed-code evidence", async () => {
    const noChangeCheckpoint = vi.fn(async () => null);
    const unconfirmed = node({ id: "scaffold", status: "done", payload: { stage: "scaffold", target: TARGET } });
    await conductorTick("cond-1", makeDeps({ row: row([unconfirmed, buildInFlight(), qaPending()]), noChangeCheckpoint }));
    expect(noChangeCheckpoint).toHaveBeenCalledWith(expect.objectContaining({ earlier_stage_landed: false }));
  });

  it("dep absent → today's behaviour: the stage fails", async () => {
    const { saveGraph, nodeById } = captureSaved();
    await conductorTick("cond-1", makeDeps({ row: row([scaffoldDone(), buildInFlight(), qaPending()]), saveGraph }));
    expect(nodeById("build")?.status).toBe("failed");
  });
});

describe("conductorTick — pushed checkpoint", () => {
  it("a landed push records a pushed checkpoint with its commit", async () => {
    const { saveGraph, nodeById } = captureSaved();
    await conductorTick(
      "cond-1",
      makeDeps({
        row: row([scaffoldDone(), buildInFlight(), qaPending()]),
        childStatus: vi.fn(async () => "success" as ChildTerminalStatus),
        verifyStagePush: vi.fn(async () => "landed" as const),
        stageCommitSha: vi.fn(async () => "deadbeef"),
        saveGraph,
      }),
    );
    expect(nodeById("build")).toMatchObject({
      status: "done",
      checkpoint: { kind: "pushed", commit_sha: "deadbeef" },
    });
  });

  it("an unknown push verdict passes as before but records no checkpoint", async () => {
    const { saveGraph, nodeById } = captureSaved();
    await conductorTick(
      "cond-1",
      makeDeps({
        row: row([scaffoldDone(), buildInFlight(), qaPending()]),
        childStatus: vi.fn(async () => "success" as ChildTerminalStatus),
        verifyStagePush: vi.fn(async () => "unknown" as const),
        stageCommitSha: vi.fn(async () => "deadbeef"),
        saveGraph,
      }),
    );
    expect(nodeById("build")?.status).toBe("done");
    expect(nodeById("build")?.checkpoint).toBeUndefined();
  });
});
