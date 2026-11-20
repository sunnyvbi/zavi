
import { describe, it, expect, vi } from "vitest";
import { conductorTick, type ConductorNode, type ConductorRow, type ConductorTickDeps } from "../conductor";

function node(over: Partial<ConductorNode> & { id: string }): ConductorNode {
  return {
    status: "pending",
    target_agent_slug: "engineer",
    payload: { task: "do" },
    estimate_usd: 1,
    child_run_id: null,
    ...over,
  };
}

describe("conductor threads the spec PRD into the build node", () => {
  it("build gets the spec output as prd and the scaffold output as prior_output", async () => {
    const graph = [
      node({ id: "spec", status: "done", target_agent_slug: "pm", child_run_id: "spec-child", payload: { stage: "spec" } }),
      node({ id: "scaffold", status: "done", child_run_id: "scaffold-child", payload: { stage: "scaffold" } }),
      node({ id: "build", status: "pending", payload: { stage: "build", idea: "bookstore" } }),
    ];
    const outputs: Record<string, string> = { "spec-child": "THE PRD", "scaffold-child": "scaffold summary" };
    const dispatch = vi.fn(async () => ({ ok: true as const, child_run_id: "build-child" }));
    const deps: ConductorTickDeps = {
      load: vi.fn(async (): Promise<ConductorRow> => ({
        id: "cond-1",
        tenant_id: "t1",
        objective: "build a bookstore",
        status: "active",
        max_usd: 100,
        spend_usd: 0,
        kind: "build_app",
        goal_graph: graph,
      })),
      childStatus: vi.fn(async () => "success" as const),
      consumeBudget: vi.fn(async () => "charged" as const),
      dispatch,
      saveGraph: vi.fn(async () => {}),
      setStatus: vi.fn(async () => {}),
      childOutput: vi.fn(async (id: string) => outputs[id] ?? null),
    };

    await conductorTick("cond-1", deps);

    expect(dispatch).toHaveBeenCalledTimes(1);
    const payload = (dispatch.mock.calls[0] as unknown as [{ payload: Record<string, unknown> }])[0].payload;
    expect(payload.prd).toBe("THE PRD");
    expect(payload.prior_output).toBe("scaffold summary");
  });
});
