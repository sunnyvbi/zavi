import { beforeEach, describe, expect, it, vi } from "vitest";

const logEvent = vi.hoisted(() => vi.fn(async (_input: Record<string, unknown>) => undefined));
vi.mock("@/services/logging/logEvent", () => ({ logEvent }));

import { logBuildTick, stageTimings } from "../conductor-observability";
import type { ConductorNode } from "../conductor";

const T0 = Date.parse("2026-09-29T10:00:00Z");
const iso = (secs: number) => new Date(T0 + secs * 1000).toISOString();

function node(id: string, stage: string, over: Partial<ConductorNode> = {}): ConductorNode {
  return {
    id,
    status: "done",
    target_agent_slug: stage === "deploy" ? "" : "engineer",
    payload: { stage },
    estimate_usd: 1,
    child_run_id: `run-${id}`,
    ...over,
  };
}

function finishedGraph(): ConductorNode[] {
  return [
    node("provision", "provision", { child_run_id: null }),
    node("spec", "spec", { started_at: iso(0), finished_at: iso(90) }),
    node("scaffold", "scaffold", { started_at: iso(90), finished_at: iso(390) }),
    node("build", "build", { started_at: iso(390), finished_at: iso(1290), repair_attempts: 1 }),
    node("qa", "qa", { started_at: iso(1290), finished_at: iso(1350) }),
    node("deploy", "deploy", {
      child_run_id: null,
      payload: { stage: "deploy", deploy_enqueued_at: T0 + 1350 * 1000 },
      started_at: iso(1830),
      finished_at: iso(1830),
    }),
  ];
}

const calls = () => logEvent.mock.calls.map(([input]) => input as Record<string, any>);

describe("build stage timings", () => {
  beforeEach(() => {
    logEvent.mockClear();
  });

  it("stageTimings measures each stage and the deploy wait from when the gate was reached", () => {
    const { stages, total_ms } = stageTimings(finishedGraph());
    expect(stages.map(({ stage, ms }) => [stage, ms])).toEqual([
      ["spec", 90_000],
      ["scaffold", 300_000],
      ["build", 900_000],
      ["qa", 60_000],
      ["deploy", 480_000],
    ]);
    expect(total_ms).toBe(1_830_000);
  });

  it("deploy without a gate stamp falls back to its own started_at", () => {
    const graph = [node("deploy", "deploy", { started_at: iso(10), finished_at: iso(25) })];
    expect(stageTimings(graph).stages[0].ms).toBe(15_000);
  });

  it("logs one stage_timing row per timed stage plus a build_timing total when a build completes", async () => {
    await logBuildTick({
      tenant_id: "tenant-1",
      conductor_run_id: "cond-1",
      result: { action: "completed", final: "done" },
      graph: finishedGraph(),
    });
    const rows = calls();
    const stageRows = rows.filter((r) => r.code === "stage_timing");
    expect(stageRows.map((r) => [r.meta.build_stage, r.meta.ms])).toEqual([
      ["spec", 90_000],
      ["scaffold", 300_000],
      ["build", 900_000],
      ["qa", 60_000],
      ["deploy", 480_000],
    ]);
    for (const r of stageRows) {
      expect(r).toMatchObject({ source: "conductor.build", tenant_id: "tenant-1", run_id: "cond-1", level: "info" });
    }
    expect(stageRows.find((r) => r.meta.build_stage === "build")?.meta).toMatchObject({
      node_id: "build",
      run_id_ref: "run-build",
      retry_count: 1,
      node_status: "done",
    });
    const total = rows.find((r) => r.code === "build_timing");
    expect(total?.meta).toEqual({ build_stage: "total", ms: 1_830_000 });
    expect(total?.message).toBe("spec=90000ms scaffold=300000ms build=900000ms qa=60000ms deploy=480000ms");
    expect(rows.find((r) => r.code === "completed")?.meta.ms).toBe(480_000);
  });

  it("a failed build still reports the timings of the stages that ran", async () => {
    const graph = finishedGraph().slice(0, 4);
    graph[3] = { ...graph[3], status: "failed", error: "lint failed" };
    await logBuildTick({
      tenant_id: "tenant-1",
      conductor_run_id: "cond-1",
      result: { action: "completed_after_repair_exhausted", node_id: "build", root_cause: "lint failed", attempts: 2 },
      graph,
    });
    const stageRows = calls().filter((r) => r.code === "stage_timing");
    expect(stageRows.map((r) => [r.meta.build_stage, r.meta.node_status])).toEqual([
      ["spec", "done"],
      ["scaffold", "done"],
      ["build", "failed"],
    ]);
  });

  it("mid-build ticks do not emit timing rows", async () => {
    await logBuildTick({
      tenant_id: "tenant-1",
      conductor_run_id: "cond-1",
      result: { action: "dispatched", node_id: "qa", child_run_id: "run-qa" },
      graph: finishedGraph(),
    });
    expect(calls().map((r) => r.code)).toEqual(["dispatched"]);
  });

  it("a logging failure never throws out of the tick", async () => {
    logEvent.mockRejectedValueOnce(new Error("db down"));
    await expect(
      logBuildTick({
        tenant_id: "tenant-1",
        conductor_run_id: "cond-1",
        result: { action: "completed", final: "done" },
        graph: finishedGraph(),
      }),
    ).resolves.toBeUndefined();
  });
});
