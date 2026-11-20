import { describe, it, expect, vi } from "vitest";
import {
  conductorTick,
  type ConductorRow,
  type ConductorNode,
  type ConductorTickDeps,
  type ChildTerminalStatus,
  type RepairConfig,
} from "../conductor";
import { mapTickToLedger } from "../conductor-ledger";

const TOKEN_MISSING =
  "resolve-repo-creds: GITHUB_PROVISION_TOKEN not configured — cannot clone/push the provisioned autopilot repo.";

function node(over: Partial<ConductorNode> & { id: string }): ConductorNode {
  return {
    status: "pending",
    target_agent_slug: "engineer",
    payload: { stage: "build" },
    estimate_usd: 3,
    child_run_id: null,
    ...over,
  };
}

function row(goal_graph: ConductorNode[]): ConductorRow {
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

const REPAIR_ON: RepairConfig = {
  enabled: true,
  maxAttempts: 3,
  repairableStages: ["scaffold", "build", "qa"],
};

function makeDeps(r: ConductorRow, extra: Partial<ConductorTickDeps>): ConductorTickDeps {
  return {
    load: vi.fn(async () => r),
    childStatus: vi.fn(async () => "running" as ChildTerminalStatus),
    consumeBudget: vi.fn(async () => "charged" as const),
    dispatch: vi.fn(async () => ({ ok: true as const, child_run_id: "child-x" })),
    saveGraph: vi.fn(async () => {}),
    setStatus: vi.fn(async () => {}),
    repairConfig: REPAIR_ON,
    ...extra,
  };
}

describe("conductorTick — platform config error short-circuit", () => {
  it("a scaffold that died on a missing GITHUB_PROVISION_TOKEN fails at once, no repair dispatched, no budget charged", async () => {
    const dispatchRepair = vi.fn(async () => ({ ok: true as const, child_run_id: "repair-1" }));
    const scaffold = node({
      id: "scaffold",
      status: "failed",
      child_run_id: "sc-1",
      payload: { stage: "scaffold" },
      error: TOKEN_MISSING,
    });
    const graph = [
      node({ id: "spec", status: "done", payload: { stage: "spec" } }),
      scaffold,
      node({ id: "build", status: "pending", payload: { stage: "build" } }),
    ];
    const deps = makeDeps(row(graph), { dispatchRepair });

    const r = await conductorTick("cond-1", deps);

    expect(dispatchRepair).not.toHaveBeenCalled();
    expect(deps.consumeBudget).not.toHaveBeenCalled();
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(r).toMatchObject({
      action: "completed_platform_config_error",
      node_id: "scaffold",
      root_cause: TOKEN_MISSING,
      attempts: 0,
    });
    expect(deps.setStatus).toHaveBeenCalledWith(
      "cond-1",
      "failed",
      expect.objectContaining({ failure_class: "dispatch_failed", failure_reason: TOKEN_MISSING }),
    );
    const saved = (deps.saveGraph as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1] as ConductorNode[];
    const savedScaffold = saved.find((n) => n.id === "scaffold");
    expect(savedScaffold?.status).toBe("failed");
    expect(savedScaffold?.repair_attempts ?? 0).toBe(0);
    expect(savedScaffold?.failure_class).toBe("dispatch_failed");
    const ledger = mapTickToLedger(r);
    expect(ledger.action).toBe("completed");
    expect(ledger.outcome).toBe("failed");
    expect(ledger.error).toBe(`platform_config_error: ${TOKEN_MISSING}`);
    expect(ledger.error).not.toMatch(/repair_exhausted/);
  });

  it("a config error read from the child run (no stored node error) still short-circuits", async () => {
    const dispatchRepair = vi.fn(async () => ({ ok: true as const, child_run_id: "repair-1" }));
    const graph = [
      node({ id: "spec", status: "done", payload: { stage: "spec" } }),
      node({ id: "build", status: "failed", child_run_id: "b-1", payload: { stage: "build" } }),
    ];
    const deps = makeDeps(row(graph), {
      dispatchRepair,
      captureFailureSignal: vi.fn(async () => TOKEN_MISSING),
    });

    await conductorTick("cond-1", deps);

    expect(dispatchRepair).not.toHaveBeenCalled();
    expect(deps.consumeBudget).not.toHaveBeenCalled();
  });

  it("a code failure still enters the repair loop", async () => {
    const dispatchRepair = vi.fn(async () => ({ ok: true as const, child_run_id: "repair-1" }));
    const graph = [
      node({ id: "spec", status: "done", payload: { stage: "spec" } }),
      node({
        id: "scaffold",
        status: "failed",
        child_run_id: "sc-1",
        payload: { stage: "scaffold" },
        error: "TypeError: cannot read property 'map' of undefined at app/page.tsx:12",
      }),
    ];
    const deps = makeDeps(row(graph), { dispatchRepair });

    await conductorTick("cond-1", deps);

    expect(dispatchRepair).toHaveBeenCalledTimes(1);
  });

  const GENUINE_CONFIG_ERRORS: readonly string[] = [
    TOKEN_MISSING,
    "resolve-repo-creds: GitHub App not connected for this tenant. Install via /connectors before running sandbox agents.",
    "resolve-repo-creds: GitHub is connected but no repositories are selected for Zavi to reach. Pick the repos this agent may work in under Settings → Connectors → GitHub, then re-run.",
    "resolve-repo-creds: payload.repo_hint missing and no repos are accessible to the GitHub installation. Re-install via /connectors and grant repo access.",
    "resolve-repo-creds: tenant t1 is an umbrella-provisioned app (connector sentinel present) but has no tenant_resources repo row with mode='provisioned'.",
    `resolve-repo-creds: autopilot target "acme" must be 'owner/name'`,
    `resolve-repo-creds: repo_hint "upcar" must be 'owner/name'`,
    `resolve-repo-creds: refusing autopilot target "Praxis-build/app" — provisioned-repo gate failed (mode=user_repo (not provisioned)). A scaffold/build node may only target a tenant_resources repo with mode='provisioned' and a matching github_full_name.`,
  ];

  const TRANSIENT_READ_FAILURES: readonly string[] = [
    "resolve-repo-creds: connector_metadata read failed: upstream request timeout",
    "resolve-repo-creds: tenant_resources(repo) read failed for tenant t1: fetch failed. Refusing to fall through to the connected-repo gate — doing so would report a misleading connector error for what is a server-side fault or an ambiguous multi-repo row set.",
    `resolve-repo-creds: refusing autopilot target "Praxis-build/app" — provisioned-repo gate failed (query_error). A scaffold/build node may only target a tenant_resources repo with mode='provisioned' and a matching github_full_name.`,
  ];

  function failedScaffold(error: string) {
    const dispatchRepair = vi.fn(async () => ({ ok: true as const, child_run_id: "repair-1" }));
    const graph = [
      node({ id: "spec", status: "done", payload: { stage: "spec" } }),
      node({ id: "scaffold", status: "failed", child_run_id: "sc-1", payload: { stage: "scaffold" }, error }),
      node({ id: "build", status: "pending", payload: { stage: "build" } }),
    ];
    const deps = makeDeps(row(graph), { dispatchRepair });
    return { deps, dispatchRepair };
  }

  for (const raw of TRANSIENT_READ_FAILURES) {
    it(`a transient read failure goes to repair, not fail-fast: ${raw.slice(20, 80)}`, async () => {
      const { deps, dispatchRepair } = failedScaffold(raw);

      const r = await conductorTick("cond-1", deps);

      expect(dispatchRepair).toHaveBeenCalledTimes(1);
      expect(r.action).toBe("repair_dispatched");
      expect(deps.setStatus).not.toHaveBeenCalledWith("cond-1", "failed", expect.anything());
    });
  }

  for (const raw of GENUINE_CONFIG_ERRORS) {
    it(`a genuine config error still fails at once: ${raw.slice(20, 80)}`, async () => {
      const { deps, dispatchRepair } = failedScaffold(raw);

      const r = await conductorTick("cond-1", deps);

      expect(dispatchRepair).not.toHaveBeenCalled();
      expect(deps.consumeBudget).not.toHaveBeenCalled();
      expect(r.action).toBe("completed_platform_config_error");
    });
  }
});
