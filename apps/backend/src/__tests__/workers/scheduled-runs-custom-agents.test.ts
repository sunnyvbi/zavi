
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";

const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(),
  scheduleRows: vi.fn(),
  cronDue: vi.fn(),
  loadAgent: vi.fn(),
  updateStamp: vi.fn(),
  fleetHalted: vi.fn(),
}));

vi.mock("@/services/agents/deepagent", () => ({ LangChainDeepAgentEngine: class {} }));
vi.mock("@/services/agents/entitlement", () => ({
  createTierGate: () => ({
    decide: async () => ({ enforced: false, tier: "free", required_tier: "free", allowed: true }),
  }),
}));
vi.mock("@/services/agents/fleet-halt", () => ({ isFleetHalted: () => mocks.fleetHalted() }));
vi.mock("@/services/agents/work-queue", () => ({ enqueueWorkItem: mocks.enqueue }));
vi.mock("@/services/agents/registry", () => ({ loadAgentDefinition: mocks.loadAgent }));
vi.mock("../../../workers/functions/cron-match", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../workers/functions/cron-match")>()),
  cronDueInBucket: (...a: unknown[]) => mocks.cronDue(...a),
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          then: (cb: (r: { data: unknown[]; error: null }) => unknown) =>
            cb({ data: mocks.scheduleRows() ?? [], error: null }),
        }),
      }),
      update: () => ({ eq: () => ({ eq: () => Promise.resolve(mocks.updateStamp()) }) }),
    }),
  }),
}));

import { runScheduledRunsHandler } from "../../../workers/functions/scheduled-runs";
import type { CustomScheduleDeps } from "../../../workers/functions/custom-agent-schedules";

const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
const noPrecheck = {
  isEnabled: async () => false,
  shortCircuit: vi.fn(),
  loadBaseline: vi.fn(),
  refetch: vi.fn(),
} as never;

function customDeps(over: Partial<CustomScheduleDeps> = {}): CustomScheduleDeps {
  return {
    loadTriggers: vi.fn(async () => []),
    loadActiveAgents: vi.fn(async () => []),
    claim: vi.fn(async () => true),
    unclaim: vi.fn(async () => {}),
    tierAllowed: vi.fn(async () => true),
    enqueue: vi.fn(async () => ({ work_item_id: "wi-c" })),
    recordFailure: vi.fn(async () => null),
    ...over,
  };
}

beforeAll(() => {
  process.env.PRAXIS_DISABLE_CRON_STOP = "1";
});
afterAll(() => {
  delete process.env.PRAXIS_DISABLE_CRON_STOP;
});

beforeEach(() => {
  Object.values(mocks).forEach((m) => m.mockReset());
  Object.values(logger).forEach((m) => m.mockReset());
  mocks.cronDue.mockReturnValue(true);
  mocks.loadAgent.mockResolvedValue({ slug: "fleet-auditor" });
  mocks.updateStamp.mockResolvedValue({ error: null });
  mocks.enqueue.mockResolvedValue({ work_item_id: "wi-1" });
  mocks.fleetHalted.mockResolvedValue(false);
});

describe("scheduled-runs + custom agents", () => {
  it("runs the custom scan after the built-in rows, built-in enqueue unchanged", async () => {
    mocks.scheduleRows.mockReturnValueOnce([
      {
        tenant_id: "tnt-1",
        agent_slug: "fleet-auditor",
        cron_expression: "0 10 * * 1",
        enabled: true,
        last_fired_at: null,
        payload_template: null,
        timezone: null,
      },
    ]);
    const deps = customDeps();
    const r = await runScheduledRunsHandler(logger, noPrecheck, deps);
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ agent_slug: "fleet-auditor", source: "cron", payload: null }),
    );
    expect(deps.loadTriggers).toHaveBeenCalledTimes(1);
    expect(r.fired).toBe(1);
    expect(r.custom).toMatchObject({ scanned: 0, fired: 0 });
  });

  it("a custom-scan error is logged and leaves the built-in result intact", async () => {
    mocks.scheduleRows.mockReturnValueOnce([]);
    const deps = customDeps({
      loadTriggers: vi.fn(async () => {
        throw new Error("db down");
      }),
    });
    const r = await runScheduledRunsHandler(logger, noPrecheck, deps);
    expect(r.custom).toBeUndefined();
    expect(r.scanned).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("custom agent scan failed"));
  });

  it("the fleet halt skips the custom scan too", async () => {
    mocks.fleetHalted.mockResolvedValue(true);
    const deps = customDeps();
    const r = await runScheduledRunsHandler(logger, noPrecheck, deps);
    expect(r.halted).toBe(true);
    expect(deps.loadTriggers).not.toHaveBeenCalled();
  });

  it("custom triggers ignore SCHEDULED_AGENTS_ALLOWED (a person wrote them)", async () => {
    delete process.env.PRAXIS_DISABLE_CRON_STOP;
    try {
      mocks.scheduleRows.mockReturnValueOnce([]);
      const now = new Date();
      const bucket = new Date(Math.floor(now.getTime() / 300_000) * 300_000);
      const deps = customDeps({
        loadTriggers: vi.fn(async () => [
          {
            id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            tenant_id: "tnt-1",
            agent_id: "ag-1",
            cron: "*/5 * * * *",
            tz: "UTC",
            deliver: null,
            next_due_at: null,
            last_result_summary: null,
          },
        ]),
        loadActiveAgents: vi.fn(async () => [
          { id: "ag-1", tenant_id: "tnt-1", slug: "c-abcdef1234", status: "active", default_deliver: null },
        ]),
      });
      const r = await runScheduledRunsHandler(logger, noPrecheck, deps);
      expect(r.custom?.fired).toBe(1);
      expect(deps.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ agent_slug: "c-abcdef1234", dedupe_key: expect.stringContaining(bucket.toISOString()) }),
      );
    } finally {
      process.env.PRAXIS_DISABLE_CRON_STOP = "1";
    }
  });
});
