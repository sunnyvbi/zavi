import { describe, it, expect, vi } from "vitest";
import {
  conductorTick,
  type ConductorRow,
  type ConductorNode,
  type ConductorTickDeps,
  type ChildTerminalStatus,
  type RepairConfig,
} from "../conductor";

const SPEC_OUTPUT = "# PRD\nA booking app for dog groomers with calendar, reminders and payments.";
const SCAFFOLD_OUTPUT = "Scaffolded routes /book /calendar /settings; data model groomer, slot, booking.";
const TARGET = { github_full_name: "praxis-built/groomly" };
const IDEA = "a booking app for dog groomers";

const REPAIR_ON: RepairConfig = {
  enabled: true,
  maxAttempts: 3,
  repairableStages: ["scaffold", "build", "qa"],
};

function node(over: Partial<ConductorNode> & { id: string }): ConductorNode {
  return {
    status: "pending",
    target_agent_slug: "engineer",
    payload: {},
    estimate_usd: 3,
    child_run_id: null,
    ...over,
  };
}

function freshBuildGraph(): ConductorNode[] {
  return [
    node({ id: "provision", status: "done", child_run_id: "prov-c", payload: { stage: "provision", idea: IDEA, target: TARGET } }),
    node({ id: "spec", status: "done", child_run_id: "spec-c", target_agent_slug: "pm", payload: { stage: "spec", idea: IDEA } }),
    node({ id: "scaffold", payload: { stage: "scaffold", idea: IDEA, company_name: "Groomly", target: TARGET } }),
    node({ id: "build", payload: { stage: "build", idea: IDEA, company_name: "Groomly", target: TARGET } }),
    node({ id: "qa", payload: { stage: "qa", target: TARGET } }),
  ];
}

function makeRow(goal_graph: ConductorNode[]): ConductorRow {
  return {
    id: "cond-1",
    tenant_id: "t1",
    objective: "build product",
    status: "active",
    max_usd: 100,
    spend_usd: 0,
    kind: "build_app",
    goal_graph,
  };
}

const OUTPUTS: Record<string, string> = { "spec-c": SPEC_OUTPUT, "scaffold-c": SCAFFOLD_OUTPUT };

function makeDeps(row: ConductorRow) {
  const dispatch = vi.fn(async () => ({ ok: true as const, child_run_id: "orig-child" }));
  const dispatchRepair = vi.fn(async () => ({ ok: true as const, child_run_id: "repair-child" }));
  const childOutput = vi.fn(async (id: string) => OUTPUTS[id] ?? null);
  const deps: ConductorTickDeps = {
    load: vi.fn(async () => row),
    childStatus: vi.fn(async () => "running" as ChildTerminalStatus),
    consumeBudget: vi.fn(async () => "charged" as const),
    dispatch,
    saveGraph: vi.fn(async () => {}),
    setStatus: vi.fn(async () => {}),
    repairConfig: REPAIR_ON,
    dispatchRepair,
    childOutput,
  };
  return { deps, dispatch, dispatchRepair, childOutput };
}

function repairPayloadOf(dispatchRepair: ReturnType<typeof makeDeps>["dispatchRepair"]): Record<string, unknown> {
  expect(dispatchRepair).toHaveBeenCalledTimes(1);
  return (dispatchRepair.mock.calls[0] as unknown as [{ payload: Record<string, unknown> }])[0].payload;
}

async function dispatchThenFail(graph: ConductorNode[], nodeId: string, error: string) {
  const row = makeRow(graph);
  const first = makeDeps(row);
  const r1 = await conductorTick("cond-1", first.deps);
  expect(r1).toMatchObject({ action: "dispatched", node_id: nodeId });
  const originalPayload = (first.dispatch.mock.calls[0] as unknown as [{ payload: Record<string, unknown> }])[0].payload;
  const failed = graph.find((n) => n.id === nodeId)!;
  failed.status = "failed";
  failed.error = error;
  const second = makeDeps(row);
  const r2 = await conductorTick("cond-1", second.deps);
  expect(r2).toMatchObject({ action: "repair_dispatched", node_id: nodeId, attempt: 1 });
  return { originalPayload, repair: repairPayloadOf(second.dispatchRepair) };
}

describe("conductor repair payload keeps fresh-build stage semantics", () => {
  it("a failed first-build scaffold is repaired as a scaffold with the spec, not as a refine", async () => {
    const signal = "workspace went offline: sandbox sbx_123 not found";
    const { originalPayload, repair } = await dispatchThenFail(freshBuildGraph(), "scaffold", signal);

    expect(originalPayload.prd).toBe(SPEC_OUTPUT);
    expect(repair).not.toHaveProperty("refine_mode");
    expect(repair).toMatchObject({
      stage: "scaffold",
      repair_mode: true,
      repair_attempt: 1,
      failure_signal: signal,
      idea: IDEA,
      prd: SPEC_OUTPUT,
      prior_output: SPEC_OUTPUT,
      target: TARGET,
    });
    expect(repair.prd).toBe(originalPayload.prd);
    expect(repair.prior_output).toBe(originalPayload.prior_output);
  });

  it("a failed first-build build stage is repaired with the same prd/prior_output its original dispatch got", async () => {
    const graph = freshBuildGraph();
    Object.assign(graph[2], { status: "done", child_run_id: "scaffold-c" });
    const { originalPayload, repair } = await dispatchThenFail(graph, "build", "Type error: Property 'slot' does not exist");

    expect(repair).not.toHaveProperty("refine_mode");
    expect(repair).toMatchObject({ stage: "build", repair_mode: true, failure_signal: expect.stringContaining("Type error") });
    expect(repair.prior_output).toBe(SCAFFOLD_OUTPUT);
    expect(repair.prior_output).toBe(originalPayload.prior_output);
    expect(repair.prd).toBe(originalPayload.prd);
  });

  it("a scaffold node's own prd is kept over the threaded output, matching the original dispatch", async () => {
    const graph = freshBuildGraph();
    graph[2].payload.prd = "OWN PRD";
    const { originalPayload, repair } = await dispatchThenFail(graph, "scaffold", "npm run build exited 1");
    expect(originalPayload.prd).toBe("OWN PRD");
    expect(repair.prd).toBe("OWN PRD");
    expect(repair.prior_output).toBe(SPEC_OUTPUT);
  });

  it("a repair still dispatches the static payload when the spec output read throws", async () => {
    const graph = freshBuildGraph();
    graph[2].status = "failed";
    graph[2].error = "build failed";
    const row = makeRow(graph);
    const { deps, dispatchRepair, childOutput } = makeDeps(row);
    childOutput.mockRejectedValueOnce(new Error("db down"));
    const r = await conductorTick("cond-1", deps);
    expect(r).toMatchObject({ action: "repair_dispatched", node_id: "scaffold" });
    const repair = repairPayloadOf(dispatchRepair);
    expect(repair).not.toHaveProperty("refine_mode");
    expect(repair).not.toHaveProperty("prior_output");
    expect(repair).toMatchObject({ stage: "scaffold", repair_mode: true, idea: IDEA });
  });

  it("a refine run's repair is unchanged: refine_mode stays on and no prior output is threaded", async () => {
    const refineNode = node({
      id: "refine",
      status: "failed",
      child_run_id: "refine-c",
      error: "Type error in app/page.tsx",
      payload: { stage: "build", refine_mode: true, idea: "make the header blue", target: TARGET },
    });
    const { deps, dispatchRepair, childOutput } = makeDeps(makeRow([refineNode]));
    const r = await conductorTick("cond-1", deps);
    expect(r).toMatchObject({ action: "repair_dispatched", node_id: "refine" });
    const repair = repairPayloadOf(dispatchRepair);
    expect(repair).toEqual({
      stage: "build",
      refine_mode: true,
      idea: "make the header blue",
      target: TARGET,
      repair_mode: true,
      repair_attempt: 1,
      failure_signal: "Type error in app/page.tsx",
    });
    expect(childOutput).not.toHaveBeenCalled();
  });

  it("a fresh build's qa repair keeps its code-fix refine flavour", async () => {
    const graph = freshBuildGraph();
    Object.assign(graph[2], { status: "done", child_run_id: "scaffold-c" });
    Object.assign(graph[3], { status: "done", child_run_id: "build-c" });
    Object.assign(graph[4], { status: "failed", child_run_id: "qa-c", error: "GET /book returned 500" });
    const { deps, dispatchRepair, childOutput } = makeDeps(makeRow(graph));
    await conductorTick("cond-1", deps);
    const repair = repairPayloadOf(dispatchRepair);
    expect(repair).toMatchObject({ stage: "qa", refine_mode: true, repair_mode: true });
    expect(repair).not.toHaveProperty("prior_output");
    expect(childOutput).not.toHaveBeenCalled();
  });
});
