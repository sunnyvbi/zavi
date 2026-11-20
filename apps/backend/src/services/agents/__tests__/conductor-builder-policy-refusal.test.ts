
import { describe, it, expect, vi } from "vitest";
import {
  conductorTick,
  type ConductorRow,
  type ConductorNode,
  type ConductorTickDeps,
  type ChildTerminalStatus,
} from "../conductor";
import {
  BuilderPolicyRefusedError,
  builderPolicyRefusalCopy,
  hasRunFailureCode,
  isBuilderPolicyRefusal,
} from "../run-failure-code";
import { isInfraRetryable } from "../infra-retry";

const COPY =
  "This build changed files Zavi never publishes (supabase/migrations/001_a.sql), so nothing was published. Retry the build; if it happens again, contact support.";
const SIGNAL = new BuilderPolicyRefusedError(["supabase/migrations/001_a.sql"], COPY).message;

function node(over: Partial<ConductorNode> & { id: string }): ConductorNode {
  return {
    status: "pending",
    target_agent_slug: "engineer",
    payload: { stage: "build", site_id: "5e0b8edd-9e1a-4dd5-a4be-18997fb92ebe" },
    estimate_usd: 3,
    child_run_id: null,
    ...over,
  };
}

function row(goal_graph: ConductorNode[]): ConductorRow {
  return {
    id: "cond-1",
    tenant_id: "t1",
    objective: "Build product: Austin Dog Grooming",
    status: "active",
    max_usd: 5,
    spend_usd: 0,
    kind: "build_app",
    goal_graph,
  };
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

describe("BuilderPolicyRefusedError", () => {
  it("carries a stable run_failure_code, so the worker never natively retries it", () => {
    const e = new BuilderPolicyRefusedError(["a"], COPY);
    expect(hasRunFailureCode(e)).toBe(true);
    expect(e.message.startsWith("builder_policy_refused: ")).toBe(true);
  });
  it("is recognised through the worker's prefix and stack suffix, never from free text", () => {
    expect(isBuilderPolicyRefusal(SIGNAL)).toBe(true);
    expect(isBuilderPolicyRefusal(`dispatch_inner: ${SIGNAL}\n    at x (y.ts:1:1)`)).toBe(true);
    expect(builderPolicyRefusalCopy(`dispatch_inner: ${SIGNAL}\n    at x (y.ts:1:1)`)).toBe(COPY);
    expect(isBuilderPolicyRefusal("the platform refused to ship them: forbidden_path")).toBe(false);
    expect(isBuilderPolicyRefusal(null)).toBe(false);
  });
  it("is not infra-retryable", () => {
    expect(isInfraRetryable("failed", SIGNAL)).toBe(false);
    expect(isInfraRetryable("dispatch_error", SIGNAL)).toBe(false);
  });
});

describe("conductorTick: a policy refusal fails once, no repair", () => {
  it("stored node error: no repair dispatch, no budget charge, founder copy", async () => {
    const dispatchRepair = vi.fn(async () => ({ ok: true as const, child_run_id: "repair-1" }));
    const deps = makeDeps(row([node({ id: "build-1", status: "failed", child_run_id: "e-1", error: SIGNAL })]), {
      dispatchRepair,
    });
    const r = await conductorTick("cond-1", deps);
    expect(dispatchRepair).not.toHaveBeenCalled();
    expect(deps.consumeBudget).not.toHaveBeenCalled();
    expect(r).toMatchObject({ action: "completed_platform_config_error", node_id: "build-1", attempts: 0 });
    expect(deps.setStatus).toHaveBeenCalledWith(
      "cond-1",
      "failed",
      expect.objectContaining({ failure_class: "stage_failed", failure_reason: COPY }),
    );
  });

  it("signal read from the child run short-circuits too", async () => {
    const dispatchRepair = vi.fn(async () => ({ ok: true as const, child_run_id: "repair-1" }));
    const deps = makeDeps(row([node({ id: "build-1", status: "failed", child_run_id: "e-1" })]), {
      dispatchRepair,
      captureFailureSignal: vi.fn(async () => `dispatch_inner: ${SIGNAL}`),
    });
    await conductorTick("cond-1", deps);
    expect(dispatchRepair).not.toHaveBeenCalled();
  });

  it("a refused file name that reads like another failure class does not reclassify it", async () => {
    const copy = "This build changed files Zavi never publishes (.github/workflows/529-overloaded.yml), so nothing was published.";
    const signal = new BuilderPolicyRefusedError([".github/workflows/529-overloaded.yml"], copy).message;
    const dispatchRepair = vi.fn(async () => ({ ok: true as const, child_run_id: "repair-1" }));
    const deps = makeDeps(row([node({ id: "build-1", status: "failed", child_run_id: "e-1", error: signal })]), {
      dispatchRepair,
    });
    const r = await conductorTick("cond-1", deps);
    expect(dispatchRepair).not.toHaveBeenCalled();
    expect(r).toMatchObject({ action: "completed_platform_config_error" });
    expect(deps.setStatus).toHaveBeenCalledWith(
      "cond-1",
      "failed",
      expect.objectContaining({ failure_class: "stage_failed", failure_reason: copy }),
    );
  });

  it("an ordinary build failure still goes to the repair loop", async () => {
    const dispatchRepair = vi.fn(async () => ({ ok: true as const, child_run_id: "repair-1" }));
    const deps = makeDeps(
      row([node({ id: "build-1", status: "failed", child_run_id: "e-1", error: "typecheck failed: src/App.tsx(3,1)" })]),
      { dispatchRepair },
    );
    await conductorTick("cond-1", deps);
    expect(dispatchRepair).toHaveBeenCalledTimes(1);
  });
});
