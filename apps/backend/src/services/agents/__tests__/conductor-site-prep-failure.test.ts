
import { describe, it, expect, vi } from "vitest";
import {
  conductorTick,
  SITE_PREP_PLATFORM_COPY,
  type ConductorRow,
  type ConductorNode,
  type ConductorTickDeps,
  type ChildTerminalStatus,
} from "../conductor";

const RESET_FAILED =
  "resetSiteRepo: git failed (exit 1): error: Your local changes to the following files would be overwritten by checkout:\n\tindex.html\n\tsrc/App.tsx\n";
const PREVIEW_STUCK = "onSiteSandboxReady: the running preview could not be stopped (exit 1; still listening: node(41))";

function node(over: Partial<ConductorNode> & { id: string }): ConductorNode {
  return {
    status: "pending",
    target_agent_slug: "engineer",
    payload: { stage: "build", refine_mode: true, site_id: "s1" },
    estimate_usd: 3,
    child_run_id: null,
    ...over,
  };
}

function row(goal_graph: ConductorNode[]): ConductorRow {
  return { id: "cond-1", tenant_id: "t1", objective: "[refine] add a reviews section", status: "active", max_usd: 9, spend_usd: 3, kind: "build_app", goal_graph };
}

function makeDeps(r: ConductorRow, extra: Partial<ConductorTickDeps>): ConductorTickDeps {
  return {
    load: vi.fn(async () => r),
    childStatus: vi.fn(async () => "running" as ChildTerminalStatus),
    consumeBudget: vi.fn(async () => "charged" as const),
    dispatch: vi.fn(async () => ({ ok: true as const, child_run_id: "child-x" })),
    saveGraph: vi.fn(async () => {}),
    setStatus: vi.fn(async () => {}),
    repairConfig: { enabled: true, maxAttempts: 3, repairableStages: ["scaffold", "build", "qa"] },
    ...extra,
  };
}

describe("conductorTick: a site sandbox the platform could not prepare is never repaired", () => {
  for (const [name, error] of [["the repo reset", RESET_FAILED], ["the preview stop", PREVIEW_STUCK]] as const) {
    it(`${name}: fails once, no repair dispatch, no budget charge, plain copy`, async () => {
      const dispatchRepair = vi.fn(async () => ({ ok: true as const, child_run_id: "repair-1" }));
      const deps = makeDeps(row([node({ id: "refine-1", status: "failed", child_run_id: "e-1", error })]), { dispatchRepair });
      const r = await conductorTick("cond-1", deps);
      expect(dispatchRepair).not.toHaveBeenCalled();
      expect(deps.consumeBudget).not.toHaveBeenCalled();
      expect(r).toMatchObject({ action: "completed_platform_config_error", node_id: "refine-1", attempts: 0 });
      expect(deps.setStatus).toHaveBeenCalledWith(
        "cond-1",
        "failed",
        expect.objectContaining({ failure_class: "dispatch_failed", failure_reason: SITE_PREP_PLATFORM_COPY }),
      );
    });
  }

  it("read from the child run (no stored node error), it short-circuits too", async () => {
    const dispatchRepair = vi.fn(async () => ({ ok: true as const, child_run_id: "repair-1" }));
    const deps = makeDeps(row([node({ id: "refine-1", status: "failed", child_run_id: "e-1" })]), {
      dispatchRepair,
      captureFailureSignal: vi.fn(async () => RESET_FAILED),
    });
    await conductorTick("cond-1", deps);
    expect(dispatchRepair).not.toHaveBeenCalled();
  });

  it("a refused tree (wrong repo) is not this platform blip and still goes to the repair loop", async () => {
    const dispatchRepair = vi.fn(async () => ({ ok: true as const, child_run_id: "repair-1" }));
    const deps = makeDeps(
      row([node({ id: "refine-1", status: "failed", child_run_id: "e-1", error: "resetSiteRepo: origin mismatch (expected a, got b)" })]),
      { dispatchRepair },
    );
    await conductorTick("cond-1", deps);
    expect(dispatchRepair).toHaveBeenCalledTimes(1);
  });
});
