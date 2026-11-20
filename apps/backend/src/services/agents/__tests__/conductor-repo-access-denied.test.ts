
import { describe, it, expect, vi } from "vitest";
import {
  conductorTick,
  REPO_ACCESS_DENIED_COPY,
  type ConductorRow,
  type ConductorNode,
  type ConductorTickDeps,
  type ChildTerminalStatus,
} from "../conductor";
import { isInfraRetryable, isRepoAccessDenied } from "../infra-retry";

const CLONE_403 =
  "cloneRepo failed exit=128 stderr=Cloning into '/home/user/repo'...\n" +
  "remote: Write access to repository not granted.\n" +
  "fatal: unable to access 'https://github.com/Zavi-Latest-Build/apna-tutor-693dfbdb.git/': The requested URL returned error: 403";
const CLONE_404 =
  "cloneRepo failed exit=128 stderr=Cloning into '/home/user/repo'...\nremote: Repository not found.\nfatal: repository 'https://github.com/x/y.git/' not found";
const CLONE_NETWORK =
  "cloneRepo failed exit=128 stderr=fatal: unable to access 'https://github.com/x/y.git/': Could not resolve host: github.com";
const CLONE_RATE_LIMIT =
  "cloneRepo failed exit=128 stderr=remote: API rate limit exceeded\nfatal: The requested URL returned error: 403";

function node(over: Partial<ConductorNode> & { id: string }): ConductorNode {
  return {
    status: "pending",
    target_agent_slug: "engineer",
    payload: { stage: "build", refine_mode: true },
    estimate_usd: 3,
    child_run_id: null,
    ...over,
  };
}

function row(goal_graph: ConductorNode[]): ConductorRow {
  return {
    id: "cond-1",
    tenant_id: "t1",
    objective: "[refine] change the headline",
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

describe("isRepoAccessDenied", () => {
  it("matches a clone refused with 403 or 404", () => {
    expect(isRepoAccessDenied(CLONE_403)).toBe(true);
    expect(isRepoAccessDenied(CLONE_404)).toBe(true);
  });
  it("does not match a network blip, a rate limit, a bare 403, or another error", () => {
    expect(isRepoAccessDenied(CLONE_NETWORK)).toBe(false);
    expect(
      isRepoAccessDenied("cloneRepo failed exit=128 stderr=fatal: unable to access 'x': The requested URL returned error: 403"),
    ).toBe(false);
    expect(isRepoAccessDenied(CLONE_RATE_LIMIT)).toBe(false);
    expect(isRepoAccessDenied("TypeError: x is undefined (returned error: 403)")).toBe(false);
    expect(isRepoAccessDenied(null)).toBe(false);
  });
  it("a refused clone is not infra-retryable; a network clone failure still is", () => {
    expect(isInfraRetryable("dispatch_error", CLONE_403)).toBe(false);
    expect(isInfraRetryable("dispatch_error", CLONE_NETWORK)).toBe(true);
  });
});

describe("conductorTick: a refused clone fails once, no repair", () => {
  it("stored node error: fails cleanly, no repair dispatch, no budget charge, plain copy", async () => {
    const dispatchRepair = vi.fn(async () => ({ ok: true as const, child_run_id: "repair-1" }));
    const deps = makeDeps(row([node({ id: "refine-1", status: "failed", child_run_id: "e-1", error: CLONE_403 })]), {
      dispatchRepair,
    });
    const r = await conductorTick("cond-1", deps);
    expect(dispatchRepair).not.toHaveBeenCalled();
    expect(deps.consumeBudget).not.toHaveBeenCalled();
    expect(r).toMatchObject({ action: "completed_platform_config_error", node_id: "refine-1", attempts: 0 });
    expect(deps.setStatus).toHaveBeenCalledWith(
      "cond-1",
      "failed",
      expect.objectContaining({ failure_class: "dispatch_failed", failure_reason: REPO_ACCESS_DENIED_COPY }),
    );
  });

  it("signal read from the child run short-circuits too", async () => {
    const dispatchRepair = vi.fn(async () => ({ ok: true as const, child_run_id: "repair-1" }));
    const deps = makeDeps(row([node({ id: "refine-1", status: "failed", child_run_id: "e-1" })]), {
      dispatchRepair,
      captureFailureSignal: vi.fn(async () => CLONE_404),
    });
    await conductorTick("cond-1", deps);
    expect(dispatchRepair).not.toHaveBeenCalled();
  });

  it("a network clone failure still goes to the repair loop", async () => {
    const dispatchRepair = vi.fn(async () => ({ ok: true as const, child_run_id: "repair-1" }));
    const deps = makeDeps(row([node({ id: "refine-1", status: "failed", child_run_id: "e-1", error: CLONE_NETWORK })]), {
      dispatchRepair,
    });
    await conductorTick("cond-1", deps);
    expect(dispatchRepair).toHaveBeenCalledTimes(1);
  });
});
