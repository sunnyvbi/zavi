import { describe, it, expect, vi } from "vitest";
import { isProviderAuthError, isUsageLimitError, tagSeatAuthError } from "../infra-retry";
import { planUsageLimitRetry } from "../agent-auth";
import {
  conductorTick,
  classifyProviderError,
  type ConductorRow,
  type ConductorNode,
  type ConductorTickDeps,
  type ChildTerminalStatus,
  type RepairConfig,
} from "../conductor";
import { summarizeBuildFailure } from "../build-failure";

const QA_401 =
  "Claude Code returned an error result: Failed to authenticate. API Error: 401 OAuth access token has been revoked";

describe("isProviderAuthError", () => {
  it("matches the revoked-token result QA saw on the Build card", () => {
    expect(isProviderAuthError(QA_401)).toBe(true);
    expect(isUsageLimitError(QA_401)).toBe(false);
  });

  it("matches the other provider auth shapes", () => {
    expect(isProviderAuthError('API Error: 401 {"type":"error","error":{"type":"authentication_error"}}')).toBe(true);
    expect(isProviderAuthError("invalid x-api-key")).toBe(true);
    expect(isProviderAuthError("OAuth token has expired")).toBe(true);
  });

  it("leaves a built app's own login failures alone", () => {
    expect(isProviderAuthError("POST /api/login returned 401 Unauthorized")).toBe(false);
    expect(isProviderAuthError("Failed to authenticate user: wrong password")).toBe(false);
    expect(isProviderAuthError(null)).toBe(false);
  });
});

describe("planUsageLimitRetry on a revoked seat", () => {
  const base = { hasMoreTokens: true, attemptDirty: false, aborted: false, durableAttached: false };

  it("rotates a clean attempt to the next token", () => {
    expect(planUsageLimitRetry({ ...base, resultText: QA_401 })).toBe("rotate");
  });

  it("does not rotate when no token is left, the attempt is dirty, or the run aborted", () => {
    expect(planUsageLimitRetry({ ...base, hasMoreTokens: false, resultText: QA_401 })).toBe("none");
    expect(planUsageLimitRetry({ ...base, attemptDirty: true, resultText: QA_401 })).toBe("none");
    expect(planUsageLimitRetry({ ...base, aborted: true, resultText: QA_401 })).toBe("none");
  });
});

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

const REPAIR_ON: RepairConfig = { enabled: true, maxAttempts: 3, repairableStages: ["scaffold", "build", "qa"] };

describe("conductorTick on a revoked provider token", () => {
  it("classifies it as transient with copy that names no token", () => {
    const r = classifyProviderError(QA_401);
    expect(r.transient).toBe(true);
    expect(r.reason).not.toMatch(/oauth|token|401|revoked/i);
  });

  it("stops the interface stage without spending a repair or budget on the same dead seat", async () => {
    const dispatchRepair = vi.fn();
    const consumeBudget = vi.fn(async () => "charged" as const);
    const setStatus = vi.fn(async () => {});
    const deps: ConductorTickDeps = {
      load: vi.fn(async () =>
        row([
          node({ id: "spec", status: "done", payload: { stage: "spec" } }),
          node({ id: "scaffold", status: "done", payload: { stage: "scaffold" } }),
          node({ id: "build", status: "failed", child_run_id: "b-1", payload: { stage: "build" } }),
        ]),
      ),
      childStatus: vi.fn(async () => "running" as ChildTerminalStatus),
      consumeBudget,
      dispatch: vi.fn(async () => ({ ok: true as const, child_run_id: "child-x" })),
      saveGraph: vi.fn(async () => {}),
      setStatus,
      repairConfig: REPAIR_ON,
      captureFailureSignal: vi.fn(async () => QA_401),
      dispatchRepair,
    };

    const r = await conductorTick("cond-1", deps);

    expect((r as { action: string }).action).toBe("completed_provider_capacity");
    expect(dispatchRepair).not.toHaveBeenCalled();
    expect(consumeBudget).not.toHaveBeenCalled();
    const reason = JSON.stringify(setStatus.mock.calls);
    expect(reason).not.toMatch(/OAuth access token has been revoked/);
  });
});

describe("conductorTick on a built app's own auth failure", () => {
  const APP_SIGNALS = [
    "Browser check: fetch /api/me failed with API Error: 401",
    'POST /api/checkout failed: {"type":"authentication_error","message":"invalid x-api-key"}',
    "Google sign-in broke: OAuth token has expired",
    "The app's AI chat calls OpenAI: API Error: 401 invalid x-api-key",
    "The app's AI chat calls Anthropic: API Error: 401 authentication_error invalid x-api-key",
  ];

  for (const signal of APP_SIGNALS) {
    it(`sends "${signal}" to the repair loop instead of stopping as a provider outage`, async () => {
      expect(classifyProviderError(signal).transient).toBe(false);
      const dispatchRepair = vi.fn(async () => ({ ok: true as const, child_run_id: "repair-1" }));
      const deps: ConductorTickDeps = {
        load: vi.fn(async () =>
          row([
            node({ id: "spec", status: "done", payload: { stage: "spec" } }),
            node({ id: "scaffold", status: "done", payload: { stage: "scaffold" } }),
            node({ id: "build", status: "failed", child_run_id: "b-1", payload: { stage: "build" } }),
          ]),
        ),
        childStatus: vi.fn(async () => "running" as ChildTerminalStatus),
        consumeBudget: vi.fn(async () => "charged" as const),
        dispatch: vi.fn(async () => ({ ok: true as const, child_run_id: "child-x" })),
        saveGraph: vi.fn(async () => {}),
        setStatus: vi.fn(async () => {}),
        repairConfig: REPAIR_ON,
        captureFailureSignal: vi.fn(async () => signal),
        dispatchRepair,
      };

      const r = await conductorTick("cond-1", deps);

      expect((r as { action: string }).action).not.toBe("completed_provider_capacity");
      expect(dispatchRepair).toHaveBeenCalledTimes(1);
    });
  }
});

describe("summarizeBuildFailure on a revoked provider token", () => {
  it("files the failure as provider capacity, not a stage bug", () => {
    const f = summarizeBuildFailure({
      runStatus: "failed",
      graph: [{ id: "build", status: "failed", child_run_id: "b-1", payload: { stage: "build" } }],
      children: new Map([["b-1", { id: "b-1", status: "dispatch_error", error: QA_401 }]]),
    });
    expect(f?.class).toBe("provider_capacity");
  });
});

describe("tagSeatAuthError", () => {
  it("prefixes a bare seat auth throw so the conductor treats it as the seat's outage", () => {
    const tagged = tagSeatAuthError(new Error("API Error: 401 OAuth access token has been revoked")) as Error;
    expect(tagged.message).toMatch(/^Claude Code returned an error result: /);
    expect(classifyProviderError(tagged.message).transient).toBe(true);
  });

  it("leaves other throws and already-prefixed ones untouched", () => {
    const other = new Error("sandbox exited 137");
    expect(tagSeatAuthError(other)).toBe(other);
    const prefixed = new Error(QA_401);
    expect(tagSeatAuthError(prefixed)).toBe(prefixed);
  });
});
