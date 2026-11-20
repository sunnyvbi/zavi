
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";

const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(),
  scheduleRows: vi.fn(),
  cronDue: vi.fn(),
  loadAgent: vi.fn(),
  updateStamp: vi.fn(),
  fleetHalted: vi.fn(),
  logEvent: vi.fn(),
}));

vi.mock("@/services/agents/entitlement", () => ({
  createTierGate: () => ({
    decide: async () => ({ enforced: false, tier: "free", required_tier: "free", allowed: true }),
  }),
}));
vi.mock("@/services/agents/deepagent", () => ({ LangChainDeepAgentEngine: class {} }));
vi.mock("@/services/agents/fleet-halt", () => ({
  isFleetHalted: () => mocks.fleetHalted(),
}));
vi.mock("@/services/agents/work-queue", () => ({ enqueueWorkItem: mocks.enqueue }));
vi.mock("@/services/agents/registry", () => ({
  loadAgentDefinition: mocks.loadAgent,
}));
vi.mock("../../../workers/functions/cron-match", () => ({
  cronDueInBucket: mocks.cronDue,
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: mocks.logEvent }));
const updateEqChain = {
  eq: () => ({ eq: () => Promise.resolve(mocks.updateStamp()) }),
};
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          then: (cb: (r: { data: unknown[]; error: null }) => unknown) =>
            cb({ data: mocks.scheduleRows(), error: null }),
        }),
      }),
      update: () => updateEqChain,
    }),
  }),
}));

import { runScheduledRunsHandler } from "../../../workers/functions/scheduled-runs";

beforeAll(() => {
  process.env.PRAXIS_DISABLE_CRON_STOP = "1";
});
afterAll(() => {
  delete process.env.PRAXIS_DISABLE_CRON_STOP;
});

const fakeLogger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };

function makeDeps(over: Partial<{
  enabled: boolean;
  shortCircuit: boolean;
  totalUrls: number;
  changedUrls: string[];
  throws: boolean;
}> = {}) {
  return {
    isEnabled: vi.fn(async () => over.enabled ?? false),
    shortCircuit: vi.fn(async () => {
      if (over.throws) throw new Error("precheck blew up");
      return {
        shortCircuit: over.shortCircuit ?? false,
        totalUrls: over.totalUrls ?? 0,
        changedUrls: over.changedUrls ?? [],
      };
    }),
    loadBaseline: vi.fn(async () => []),
    refetch: vi.fn(async () => ({ content: "", ok: true })),
  };
}

const watchRow = {
  tenant_id: "tnt-1",
  agent_slug: "research",
  cron_expression: "0 9 * * 1",
  enabled: true,
  last_fired_at: null,
  payload_template: {
    standing_order: { prompt: "watch competitor pricing", deliver: { kind: "chat_thread" } },
  },
};

beforeEach(() => {
  Object.values(mocks).forEach((m) => m.mockReset());
  fakeLogger.warn.mockReset();
  fakeLogger.info.mockReset();
  fakeLogger.error.mockReset();
  mocks.cronDue.mockReturnValue(true);
  mocks.loadAgent.mockResolvedValue({ slug: "research" });
  mocks.updateStamp.mockResolvedValue({ error: null });
  mocks.enqueue.mockResolvedValue({ work_item_id: "wi-1" });
  mocks.fleetHalted.mockResolvedValue(false);
  mocks.logEvent.mockResolvedValue(undefined);
});

describe("scheduled-runs — research watch pre-check (flag-gated)", () => {
  it("flag OFF → enqueues the watch tick, no pre-check fetch, no suppression", async () => {
    mocks.scheduleRows.mockReturnValueOnce([watchRow]);
    const deps = makeDeps({ enabled: false });
    const res = await runScheduledRunsHandler(fakeLogger, deps);
    expect(deps.isEnabled).toHaveBeenCalledWith("tnt-1");
    expect(deps.shortCircuit).not.toHaveBeenCalled();
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(res.fired).toBe(1);
    expect(res.suppressedNoDelta).toBe(0);
  });

  it("flag ON + shortCircuit → SKIPS enqueue, stamps last_fired_at, logs no_delta", async () => {
    mocks.scheduleRows.mockReturnValueOnce([watchRow]);
    const deps = makeDeps({ enabled: true, shortCircuit: true, totalUrls: 3, changedUrls: [] });
    const res = await runScheduledRunsHandler(fakeLogger, deps);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(res.fired).toBe(0);
    expect(res.suppressedNoDelta).toBe(1);
    expect(mocks.updateStamp).toHaveBeenCalledTimes(1);
    expect(mocks.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "research.watch.precheck",
        code: "no_delta",
        tenant_id: "tnt-1",
        meta: { total: 3, count: 0 },
      }),
    );
  });

  it("flag ON + delta → enqueues exactly as today", async () => {
    mocks.scheduleRows.mockReturnValueOnce([watchRow]);
    const deps = makeDeps({
      enabled: true,
      shortCircuit: false,
      totalUrls: 2,
      changedUrls: ["https://a.com"],
    });
    const res = await runScheduledRunsHandler(fakeLogger, deps);
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(res.fired).toBe(1);
    expect(res.suppressedNoDelta).toBe(0);
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });

  it("a thrown pre-check → enqueues (fail-open)", async () => {
    mocks.scheduleRows.mockReturnValueOnce([watchRow]);
    const deps = makeDeps({ enabled: true, throws: true });
    const res = await runScheduledRunsHandler(fakeLogger, deps);
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(res.fired).toBe(1);
    expect(res.suppressedNoDelta).toBe(0);
  });

  it("a NON-research cron row → enqueues untouched, no pre-check call", async () => {
    mocks.scheduleRows.mockReturnValueOnce([
      {
        tenant_id: "tnt-1",
        agent_slug: "qa-engineer-weekly",
        cron_expression: "0 22 * * 0",
        enabled: true,
        last_fired_at: null,
        payload_template: { standing_order: { prompt: "x", deliver: { kind: "chat_thread" } } },
      },
    ]);
    const deps = makeDeps({ enabled: true, shortCircuit: true });
    const res = await runScheduledRunsHandler(fakeLogger, deps);
    expect(deps.isEnabled).not.toHaveBeenCalled();
    expect(deps.shortCircuit).not.toHaveBeenCalled();
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(res.fired).toBe(1);
  });

  it("a research run WITHOUT standing_order (non-watch) → enqueues untouched", async () => {
    mocks.scheduleRows.mockReturnValueOnce([
      {
        tenant_id: "tnt-1",
        agent_slug: "research",
        cron_expression: "0 9 * * 1",
        enabled: true,
        last_fired_at: null,
        payload_template: { some_other_key: true },
      },
    ]);
    const deps = makeDeps({ enabled: true, shortCircuit: true });
    const res = await runScheduledRunsHandler(fakeLogger, deps);
    expect(deps.isEnabled).not.toHaveBeenCalled();
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(res.fired).toBe(1);
  });
});
