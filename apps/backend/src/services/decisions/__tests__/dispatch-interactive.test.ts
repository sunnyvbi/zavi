
import { describe, it, expect, vi, beforeEach } from "vitest";

const executeDispatchMock = vi.fn(async () => ({ ok: true }) as { ok: boolean; error?: string });
const estimateUsdMock = vi.fn(() => 0);
vi.mock("../../../../workers/functions/dispatch-decision", () => ({
  executeDispatch: (...a: unknown[]) => executeDispatchMock(...(a as [])),
  estimateUsdFromDecisionBody: (...a: unknown[]) => estimateUsdMock(...(a as [])),
}));

const isFleetHaltedMock = vi.fn(async () => false);
vi.mock("@/services/agents/fleet-halt", () => ({
  isFleetHalted: () => isFleetHaltedMock(),
}));

const resolveWaiverStateMock = vi.fn(async () => ({ state: "none" }));
vi.mock("@/services/decisions/waiver-resolve", () => ({
  resolveWaiverState: (...a: unknown[]) => resolveWaiverStateMock(...(a as [])),
}));

const checkAutoFireRateCapMock = vi.fn(async () => ({ allowed: true, count: 0, cap: 10 }));
vi.mock("@/services/decisions/auto-fire-rate-cap", () => ({
  checkAutoFireRateCap: (...a: unknown[]) => checkAutoFireRateCapMock(...(a as [])),
}));

const consumeClassBudgetMock = vi.fn(async () => "charged");
vi.mock("@/services/agents/class-cap", () => ({
  consumeClassBudget: (...a: unknown[]) => consumeClassBudgetMock(...(a as [])),
}));

const releaseClaimMock = vi.fn(async () => {});
vi.mock("@/services/decisions/atomic-claim", () => ({
  releaseClaim: (...a: unknown[]) => releaseClaimMock(...(a as [])),
}));

const alertMock = vi.fn(async () => {});
vi.mock("@/services/logging/alert", () => ({
  alert: (...a: unknown[]) => alertMock(...(a as [])),
}));

vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));

let decisionRow: { data: unknown; error: unknown } = {
  data: {
    tenant_id: "11111111-1111-4111-8111-111111111111",
    agent_run_id: "run-1",
    status: "proposed",
  },
  error: null,
};
let triggerRow: { data: unknown; error: unknown } = {
  data: { trigger: "slack" },
  error: null,
};
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () =>
            table === "decisions" ? decisionRow : triggerRow,
        }),
      }),
    }),
  }),
}));

import { dispatchInteractiveDecision } from "../dispatch-interactive";

const BASE = {
  decision_id: "dec-1",
  tenant_id: "11111111-1111-4111-8111-111111111111",
  decision_class: "engineer.ship-pr",
  agent_run_id: "run-1",
  body: { repo: "rravi149/upcar", base_branch: "development" },
};

beforeEach(() => {
  vi.clearAllMocks();
  triggerRow = { data: { trigger: "slack" }, error: null };
  decisionRow = {
    data: {
      tenant_id: "11111111-1111-4111-8111-111111111111",
      agent_run_id: "run-1",
      status: "proposed",
    },
    error: null,
  };
  executeDispatchMock.mockResolvedValue({ ok: true });
  isFleetHaltedMock.mockResolvedValue(false);
  resolveWaiverStateMock.mockResolvedValue({ state: "none" });
  checkAutoFireRateCapMock.mockResolvedValue({ allowed: true, count: 0, cap: 10 });
  consumeClassBudgetMock.mockResolvedValue("charged");
  estimateUsdMock.mockReturnValue(0);
});

describe("a Slack ask opens its PR in-session", () => {
  it("dispatches exactly once for a slack-triggered engineer.ship-pr", async () => {
    const out = await dispatchInteractiveDecision(BASE);
    expect(out).toEqual({ dispatched: true, reason: "dispatched" });
    expect(executeDispatchMock).toHaveBeenCalledTimes(1);
    expect(executeDispatchMock).toHaveBeenCalledWith("dec-1", {
      slackNotice: "outbox",
    });
  });

  it.each(["handoff", "a2a", "manual"])(
    "also dispatches for a %s trigger",
    async (trigger) => {
      triggerRow = { data: { trigger }, error: null };
      const out = await dispatchInteractiveDecision(BASE);
      expect(out.dispatched).toBe(true);
      expect(executeDispatchMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["cron", "webhook", "email", "channel_recipe", "mcp", "telegram"])(
    "does NOT dispatch a %s trigger (automated, or a human surface not yet widened)",
    async (trigger) => {
      triggerRow = { data: { trigger }, error: null };
      const out = await dispatchInteractiveDecision(BASE);
      expect(out).toEqual({ dispatched: false, reason: "not_interactive_trigger" });
      expect(executeDispatchMock).not.toHaveBeenCalled();
    },
  );
});

describe("a chat ask is NOT auto-opened", () => {
  it("does not dispatch a chat-triggered ship-pr (reply-yes owns that)", async () => {
    triggerRow = { data: { trigger: "chat" }, error: null };
    const out = await dispatchInteractiveDecision(BASE);
    expect(out.dispatched).toBe(false);
    expect(executeDispatchMock).not.toHaveBeenCalled();
  });

  it("does not dispatch a cron-triggered ship-pr (the allowlist stop stays honoured)", async () => {
    triggerRow = { data: { trigger: "cron" }, error: null };
    const out = await dispatchInteractiveDecision(BASE);
    expect(out).toEqual({ dispatched: false, reason: "not_interactive_trigger" });
    expect(executeDispatchMock).not.toHaveBeenCalled();
  });

  it("fails CLOSED when the run row cannot be read", async () => {
    triggerRow = { data: null, error: { message: "boom" } };
    const out = await dispatchInteractiveDecision(BASE);
    expect(out).toEqual({ dispatched: false, reason: "not_interactive_trigger" });
    expect(executeDispatchMock).not.toHaveBeenCalled();
  });
});

describe("a refusing guard leaves the decision proposed", () => {
  it("fleet halt stops it before any other read", async () => {
    isFleetHaltedMock.mockResolvedValue(true);
    const out = await dispatchInteractiveDecision(BASE);
    expect(out).toEqual({ dispatched: false, reason: "fleet_halted" });
    expect(executeDispatchMock).not.toHaveBeenCalled();
    expect(checkAutoFireRateCapMock).not.toHaveBeenCalled();
  });

  it("an expired autopilot waiver holds it", async () => {
    resolveWaiverStateMock.mockResolvedValue({ state: "expired" });
    const out = await dispatchInteractiveDecision(BASE);
    expect(out).toEqual({ dispatched: false, reason: "waiver_expired" });
    expect(executeDispatchMock).not.toHaveBeenCalled();
  });

  it("the auto-fire rate cap holds it", async () => {
    checkAutoFireRateCapMock.mockResolvedValue({ allowed: false, count: 11, cap: 10 });
    const out = await dispatchInteractiveDecision(BASE);
    expect(out).toEqual({ dispatched: false, reason: "rate_capped" });
    expect(executeDispatchMock).not.toHaveBeenCalled();
  });

  it("the per-class spend cap holds it", async () => {
    estimateUsdMock.mockReturnValue(10);
    consumeClassBudgetMock.mockResolvedValue("over_cap");
    const out = await dispatchInteractiveDecision(BASE);
    expect(out).toEqual({ dispatched: false, reason: "class_spend_cap_over" });
    expect(executeDispatchMock).not.toHaveBeenCalled();
  });

  it("a push_to_main row on an interactive trigger is held", async () => {
    const out = await dispatchInteractiveDecision({
      ...BASE,
      body: { ...BASE.body, push_to_main: true },
    });
    expect(out).toEqual({ dispatched: false, reason: "held_by_ship_pr_gate" });
    expect(executeDispatchMock).not.toHaveBeenCalled();
  });
});

describe("dispatch failure is contained and visible", () => {
  it("returns (does not throw) when executeDispatch reports failure, and alerts", async () => {
    executeDispatchMock.mockResolvedValue({ ok: false, error: "github 500" });
    const out = await dispatchInteractiveDecision(BASE);
    expect(out).toEqual({ dispatched: false, reason: "dispatch_failed" });
    expect(alertMock).toHaveBeenCalledTimes(1);
  });

  it("returns (does not throw) when executeDispatch throws, releases the claim, and alerts", async () => {
    executeDispatchMock.mockRejectedValue(new Error("kaboom"));
    const out = await dispatchInteractiveDecision(BASE);
    expect(out).toEqual({ dispatched: false, reason: "dispatch_threw" });
    expect(releaseClaimMock).toHaveBeenCalledWith("dec-1", "in_session_dispatch_threw");
    expect(alertMock).toHaveBeenCalledTimes(1);
  });

  it("times out without releasing the claim (releasing it would invite a SECOND PR)", async () => {
    executeDispatchMock.mockImplementation(
      () => new Promise(() => {}) as Promise<{ ok: boolean }>,
    );
    const out = await dispatchInteractiveDecision({ ...BASE, timeoutMs: 10 });
    expect(out).toEqual({ dispatched: false, reason: "dispatch_timeout" });
    expect(releaseClaimMock).not.toHaveBeenCalled();
    expect(alertMock).toHaveBeenCalledTimes(1);
  });

  it("bounds the GUARDS too, not just the dispatch", async () => {
    isFleetHaltedMock.mockImplementation(
      () => new Promise(() => {}) as Promise<boolean>,
    );
    const out = await dispatchInteractiveDecision({ ...BASE, timeoutMs: 10 });
    expect(out.reason).toBe("dispatch_timeout");
    expect(executeDispatchMock).not.toHaveBeenCalled();
  });
});

describe("emit dedupe cannot make us open someone else's PR", () => {
  it("refuses a decision row belonging to a DIFFERENT run", async () => {
    decisionRow = {
      data: {
        tenant_id: BASE.tenant_id,
        agent_run_id: "some-other-run",
        status: "proposed",
      },
      error: null,
    };
    const out = await dispatchInteractiveDecision(BASE);
    expect(out).toEqual({ dispatched: false, reason: "not_this_run" });
    expect(executeDispatchMock).not.toHaveBeenCalled();
  });

  it("refuses a decision row belonging to a different TENANT", async () => {
    decisionRow = {
      data: {
        tenant_id: "22222222-2222-4222-8222-222222222222",
        agent_run_id: "run-1",
        status: "proposed",
      },
      error: null,
    };
    const out = await dispatchInteractiveDecision(BASE);
    expect(out).toEqual({ dispatched: false, reason: "not_this_run" });
    expect(executeDispatchMock).not.toHaveBeenCalled();
  });

  it("refuses a row that is no longer proposed (already dispatched elsewhere)", async () => {
    decisionRow = {
      data: { tenant_id: BASE.tenant_id, agent_run_id: "run-1", status: "acted" },
      error: null,
    };
    const out = await dispatchInteractiveDecision(BASE);
    expect(out).toEqual({ dispatched: false, reason: "decision_not_claimable" });
    expect(executeDispatchMock).not.toHaveBeenCalled();
  });

  it("fails CLOSED when the decision row cannot be read", async () => {
    decisionRow = { data: null, error: { message: "boom" } };
    const out = await dispatchInteractiveDecision(BASE);
    expect(out).toEqual({ dispatched: false, reason: "decision_not_claimable" });
    expect(executeDispatchMock).not.toHaveBeenCalled();
  });
});

describe("the zero-cost case does not touch the spend cap", () => {
  it("skips consumeClassBudget when the estimate is 0 (a ship-pr body)", async () => {
    estimateUsdMock.mockReturnValue(0);
    await dispatchInteractiveDecision(BASE);
    expect(consumeClassBudgetMock).not.toHaveBeenCalled();
    expect(executeDispatchMock).toHaveBeenCalledTimes(1);
  });

  it("charges, and can be refused, when the estimate is non-zero", async () => {
    estimateUsdMock.mockReturnValue(25);
    consumeClassBudgetMock.mockResolvedValue("over_cap");
    const out = await dispatchInteractiveDecision(BASE);
    expect(out).toEqual({ dispatched: false, reason: "class_spend_cap_over" });
    expect(executeDispatchMock).not.toHaveBeenCalled();
  });

  it("a transient cap READ error proceeds — parity with the auto-cron", async () => {
    estimateUsdMock.mockReturnValue(25);
    consumeClassBudgetMock.mockResolvedValue("read_error");
    const out = await dispatchInteractiveDecision(BASE);
    expect(out.dispatched).toBe(true);
  });
});

describe("only the allowlisted class dispatches in-session", () => {
  it("does NOT dispatch channel.recipe_step (null dispatch_handler would mark it acted)", async () => {
    const out = await dispatchInteractiveDecision({
      ...BASE,
      decision_class: "channel.recipe_step",
    });
    expect(out).toEqual({ dispatched: false, reason: "class_not_eligible" });
    expect(executeDispatchMock).not.toHaveBeenCalled();
    expect(isFleetHaltedMock).not.toHaveBeenCalled();
  });

  it.each(["qa.weekly-digest", "dispute-response.submit-evidence"])(
    "does NOT dispatch %s",
    async (decision_class) => {
      const out = await dispatchInteractiveDecision({ ...BASE, decision_class });
      expect(out.dispatched).toBe(false);
      expect(out.reason).toBe("class_not_eligible");
      expect(executeDispatchMock).not.toHaveBeenCalled();
    },
  );
});

describe("custom agent (customAgent: true, set only after the runner verified the run)", () => {
  const CUSTOM = {
    ...BASE,
    decision_class: "meta_ads.budget_change",
    body: { ad_set_id: "as1", new_daily_budget_usd: 25 },
    customAgent: true as const,
  };
  const customRow = (over: Record<string, unknown> = {}) => ({
    data: {
      tenant_id: BASE.tenant_id,
      agent_run_id: "run-1",
      status: "proposed",
      autonomy_at_emit: "auto",
      handler: "meta_ads.budget_change",
      ...over,
    },
    error: null,
  });

  it("any class with a handler, on its schedule (cron): dispatched", async () => {
    decisionRow = customRow();
    triggerRow = { data: { trigger: "cron" }, error: null };
    expect(await dispatchInteractiveDecision(CUSTOM)).toEqual({ dispatched: true, reason: "dispatched" });
    expect(executeDispatchMock).toHaveBeenCalledTimes(1);
  });

  it("the same class and trigger WITHOUT the custom flag: never dispatched", async () => {
    decisionRow = customRow();
    triggerRow = { data: { trigger: "cron" }, error: null };
    const { customAgent: _c, ...builtIn } = CUSTOM;
    expect((await dispatchInteractiveDecision(builtIn)).dispatched).toBe(false);
    expect(executeDispatchMock).not.toHaveBeenCalled();
  });

  it("a row not stamped auto, or with no handler: left proposed", async () => {
    triggerRow = { data: { trigger: "cron" }, error: null };
    decisionRow = customRow({ autonomy_at_emit: "approval" });
    expect(await dispatchInteractiveDecision(CUSTOM)).toEqual({ dispatched: false, reason: "not_auto" });
    decisionRow = customRow({ handler: null });
    expect(await dispatchInteractiveDecision(CUSTOM)).toEqual({ dispatched: false, reason: "no_handler" });
    expect(executeDispatchMock).not.toHaveBeenCalled();
  });

  it("another run's row (emit dedupe) is still refused", async () => {
    decisionRow = customRow({ agent_run_id: "run-OTHER" });
    triggerRow = { data: { trigger: "cron" }, error: null };
    expect((await dispatchInteractiveDecision(CUSTOM)).reason).toBe("not_this_run");
    expect(executeDispatchMock).not.toHaveBeenCalled();
  });

  it("every cap still applies: rate cap and spend cap leave it proposed", async () => {
    decisionRow = customRow();
    triggerRow = { data: { trigger: "cron" }, error: null };
    checkAutoFireRateCapMock.mockResolvedValueOnce({ allowed: false, count: 10, cap: 10 });
    expect((await dispatchInteractiveDecision(CUSTOM)).reason).toBe("rate_capped");
    estimateUsdMock.mockReturnValue(25);
    consumeClassBudgetMock.mockResolvedValueOnce("over_cap");
    expect((await dispatchInteractiveDecision(CUSTOM)).reason).toBe("class_spend_cap_over");
    expect(executeDispatchMock).not.toHaveBeenCalled();
  });
});
