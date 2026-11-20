
import { describe, it, expect, vi } from "vitest";
import {
  conductorTick,
  pausableFailure,
  type ConductorRow,
  type ConductorNode,
  type ConductorTickDeps,
  type ChildTerminalStatus,
} from "../conductor";

const T = { github_full_name: "Praxis-build/app-1" };
const n = (id: string, stage: string, over: Partial<ConductorNode> = {}): ConductorNode => ({
  id,
  status: "pending",
  target_agent_slug: stage === "qa" ? "qa" : stage === "spec" ? "pm" : "engineer",
  payload: { stage, target: T },
  estimate_usd: 1,
  child_run_id: null,
  ...over,
});
const row = (goal_graph: ConductorNode[], over: Partial<ConductorRow> = {}): ConductorRow => ({
  id: "cond-1",
  tenant_id: "t1",
  objective: "build",
  status: "active",
  max_usd: 50,
  spend_usd: 0,
  kind: "build_app",
  goal_graph,
  ...over,
});
const fail = { failure_class: "stage_failed" as const };

describe("pausableFailure", () => {
  const withCode = [n("spec", "spec", { status: "done" }), n("scaffold", "scaffold", { status: "done" }), n("qa", "qa", { status: "failed" })];
  it("pauses a fresh Build that already finished a code-writing stage", () => {
    expect(pausableFailure(row(withCode), withCode, fail)).toBe(true);
    expect(pausableFailure(row(withCode), withCode, { failure_class: "dispatch_failed" })).toBe(true);
    expect(pausableFailure(row(withCode), withCode, { failure_class: "provider_capacity" })).toBe(true);
    expect(pausableFailure(row(withCode), withCode, undefined)).toBe(true);
  });
  it("fails when there is nothing to continue from", () => {
    const early = [n("spec", "spec", { status: "failed" }), n("scaffold", "scaffold")];
    expect(pausableFailure(row(early), early, fail)).toBe(false);
  });
  it("never pauses a founder cancel, a provision failure, a refine or a non-Build conductor", () => {
    for (const failure_class of ["user_cancelled", "provision_failed", "coach_precedence"] as const) {
      expect(pausableFailure(row(withCode), withCode, { failure_class })).toBe(false);
    }
    const refine = [n("b", "build", { status: "failed", payload: { stage: "build", refine_mode: true } })];
    expect(pausableFailure(row(refine), refine, fail)).toBe(false);
    expect(pausableFailure(row(withCode, { kind: "company_goal" }), withCode, fail)).toBe(false);
  });
});

describe("conductorTick — late failure pauses", () => {
  function deps(r: ConductorRow, over: Partial<ConductorTickDeps> = {}): ConductorTickDeps {
    return {
      load: vi.fn(async () => r),
      childStatus: vi.fn(async () => "failed" as ChildTerminalStatus),
      consumeBudget: vi.fn(async () => "charged" as const),
      dispatch: vi.fn(async () => ({ ok: true as const, child_run_id: "x" })),
      saveGraph: vi.fn(async () => {}),
      setStatus: vi.fn(async () => {}),
      now: () => Date.parse("2026-09-22T20:00:00Z"),
      ...over,
    };
  }

  it("a qa failure after build finished pauses the run with its reason", async () => {
    const graph = [
      n("scaffold", "scaffold", { status: "done" }),
      n("build", "build", { status: "done" }),
      n("qa", "qa", { status: "dispatched", child_run_id: "qa-1" }),
    ];
    const d = deps(row(graph));
    const r = await conductorTick("cond-1", d);
    expect(d.setStatus).toHaveBeenCalledWith("cond-1", "paused", expect.objectContaining({ failure_class: "stage_failed" }));
    expect(r).toEqual({ action: "completed", final: "paused" });
  });

  it("running out of credits on the next dispatch pauses the run", async () => {
    const graph = [n("scaffold", "scaffold", { status: "done" }), n("build", "build")];
    const d = deps(row(graph), { dispatch: vi.fn(async () => ({ ok: false as const, reason: "insufficient_credits" })) });
    await conductorTick("cond-1", d);
    const saved = (d.saveGraph as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1] as ConductorNode[];
    await conductorTick("cond-1", deps(row(saved), { setStatus: d.setStatus }));
    expect(d.setStatus).toHaveBeenLastCalledWith("cond-1", "paused", expect.objectContaining({ failure_class: "dispatch_failed" }));
  });

  it("a failure before any code was written still fails", async () => {
    const graph = [n("spec", "spec", { status: "dispatched", child_run_id: "pm-1" }), n("scaffold", "scaffold")];
    const d = deps(row(graph));
    await conductorTick("cond-1", d);
    expect(d.setStatus).toHaveBeenCalledWith("cond-1", "failed", expect.anything());
    expect(d.setStatus).not.toHaveBeenCalledWith("cond-1", "paused", expect.anything());
  });

  it("a paused run is never ticked", async () => {
    const d = deps(row([n("scaffold", "scaffold", { status: "done" })], { status: "paused" }));
    expect(await conductorTick("cond-1", d)).toEqual({ action: "noop", reason: "paused" });
    expect(d.dispatch).not.toHaveBeenCalled();
    expect(d.consumeBudget).not.toHaveBeenCalled();
  });
});
