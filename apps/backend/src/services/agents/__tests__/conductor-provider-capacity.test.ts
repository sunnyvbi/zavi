
import { describe, it, expect, vi } from "vitest";
import {
  conductorTick,
  classifyProviderError,
  type ConductorRow,
  type ConductorNode,
  type ConductorTickDeps,
  type ChildTerminalStatus,
  type RepairConfig,
} from "../conductor";
import { mapTickToLedger } from "../conductor-ledger";

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

function row(over: Partial<ConductorRow> & { goal_graph: ConductorNode[] }): ConductorRow {
  return {
    id: "cond-1",
    tenant_id: "t1",
    objective: "build product",
    status: "active",
    max_usd: 100,
    spend_usd: 0,
    kind: "build_app",
    ...over,
  };
}

const REPAIR_ON: RepairConfig = {
  enabled: true,
  maxAttempts: 3,
  repairableStages: ["scaffold", "build", "qa"],
};

function makeDeps(
  opts: Partial<ConductorTickDeps> & { row: ConductorRow | null },
): ConductorTickDeps {
  return {
    load: vi.fn(async () => opts.row),
    childStatus: opts.childStatus ?? vi.fn(async () => "running" as ChildTerminalStatus),
    consumeBudget: opts.consumeBudget ?? vi.fn(async () => "charged"),
    dispatch: opts.dispatch ?? vi.fn(async () => ({ ok: true as const, child_run_id: "child-x" })),
    saveGraph: opts.saveGraph ?? vi.fn(async () => {}),
    setStatus: opts.setStatus ?? vi.fn(async () => {}),
    repairConfig: opts.repairConfig,
    captureFailureSignal: opts.captureFailureSignal,
    dispatchRepair: opts.dispatchRepair,
  };
}

describe("classifyProviderError", () => {
  const transient = [
    "Claude Code returned an error result: You're out of extra usage · resets 2:30pm (UTC)",
    "anthropic API overloaded_error",
    "HTTP 529 overloaded",
    "usage limit reached for this billing period",
    "429 too many requests from the anthropic api",
    "claude: rate_limited, please retry",
  ];
  for (const s of transient) {
    it(`transient: ${s.slice(0, 40)}`, () => {
      const r = classifyProviderError(s);
      expect(r.transient).toBe(true);
      expect(r.reason).toContain("provider capacity");
    });
  }

  const notTransient = [
    "TypeError: cannot read property 'map' of undefined at Page.tsx:42",
    "assertion failed: expected 200 got 500 on /api/health",
    "SyntaxError: Unexpected token",
    "429 Too Many Requests",
    "POST /api/login returned 429 too many requests",
    "the app implements rate limiting on the signup endpoint",
    "",
  ];
  for (const s of notTransient) {
    it(`NOT transient: ${s.slice(0, 40) || "(empty)"}`, () => {
      expect(classifyProviderError(s).transient).toBe(false);
    });
  }

  it("null/undefined signal → not transient", () => {
    expect(classifyProviderError(null).transient).toBe(false);
    expect(classifyProviderError(undefined).transient).toBe(false);
  });
});

describe("conductorTick — provider-capacity short-circuit", () => {
  it("a scaffold failure from a provider-capacity error fails CLEANLY without burning a repair", async () => {
    const dispatchRepair = vi.fn();
    const consumeBudget = vi.fn(async () => "charged" as const);
    const captureFailureSignal = vi.fn(
      async () => "Claude Code returned an error result: You're out of extra usage · resets 2:30pm (UTC)",
    );
    const deps = makeDeps({
      row: row({
        goal_graph: [
          node({ id: "spec", status: "done", payload: { stage: "spec" } }),
          node({ id: "scaffold", status: "failed", child_run_id: "sc-1", payload: { stage: "scaffold" } }),
          node({ id: "build", status: "pending", payload: { stage: "build" } }),
        ],
      }),
      repairConfig: REPAIR_ON,
      captureFailureSignal,
      dispatchRepair,
      consumeBudget,
    });

    const r = await conductorTick("cond-1", deps);

    expect(r).toEqual({
      action: "completed_provider_capacity",
      node_id: "scaffold",
      root_cause: expect.stringContaining("provider capacity"),
      attempts: 0,
    });
    expect(deps.setStatus).toHaveBeenCalledWith(
      "cond-1",
      "failed",
      expect.objectContaining({
        failure_class: expect.any(String),
        failure_reason: expect.any(String),
      }),
    );
    expect(dispatchRepair).not.toHaveBeenCalled();
    expect(consumeBudget).not.toHaveBeenCalled();
  });

  it("short-circuits on the FIRST failure (before the cap check) — attempts stays 0", async () => {
    const dispatchRepair = vi.fn();
    const deps = makeDeps({
      row: row({
        goal_graph: [
          node({ id: "build", status: "failed", child_run_id: "bc-1", payload: { stage: "build" } }),
        ],
      }),
      repairConfig: REPAIR_ON,
      captureFailureSignal: vi.fn(async () => "429 Too Many Requests from the anthropic api"),
      dispatchRepair,
    });
    const r = await conductorTick("cond-1", deps);
    expect((r as { action: string }).action).toBe("completed_provider_capacity");
    expect((r as { attempts: number }).attempts).toBe(0);
    expect(dispatchRepair).not.toHaveBeenCalled();
  });

  it("REGRESSION: a genuine code failure still enters the normal repair loop", async () => {
    const dispatchRepair = vi.fn(async () => ({ ok: true as const, child_run_id: "repair-1" }));
    const deps = makeDeps({
      row: row({
        goal_graph: [
          node({ id: "build", status: "failed", child_run_id: "bc-2", payload: { stage: "build" } }),
        ],
      }),
      repairConfig: REPAIR_ON,
      captureFailureSignal: vi.fn(async () => "TypeError: cannot read property 'map' of undefined"),
      dispatchRepair,
    });
    const r = await conductorTick("cond-1", deps);
    expect((r as { action: string }).action).toBe("repair_dispatched");
    expect(dispatchRepair).toHaveBeenCalledOnce();
  });
});

describe("mapTickToLedger — provider-capacity folds onto an allowed action", () => {
  it("completed_provider_capacity → action 'completed', outcome 'failed', error carries the reason", () => {
    const e = mapTickToLedger({
      action: "completed_provider_capacity",
      node_id: "scaffold",
      root_cause: "Your AI team hit provider capacity (LLM usage limit). No code changes were made — retry in a bit.",
      attempts: 0,
    });
    expect(e.action).toBe("completed");
    expect(e.outcome).toBe("failed");
    expect(e.error).toContain("provider_capacity:");
  });
});
