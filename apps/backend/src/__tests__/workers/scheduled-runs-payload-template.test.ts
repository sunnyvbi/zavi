import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";

const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(),
  scheduleRows: vi.fn(),
  cronDue: vi.fn(),
  loadAgent: vi.fn(),
  updateStamp: vi.fn(),
  fleetHalted: vi.fn(),
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
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          then: (cb: (r: { data: unknown[]; error: null }) => unknown) =>
            cb({ data: mocks.scheduleRows(), error: null }),
        }),
      }),
      update: () => ({
        eq: () => ({ eq: () => Promise.resolve(mocks.updateStamp()) }),
      }),
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

const fakeLogger = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
};

beforeEach(() => {
  Object.values(mocks).forEach((m) => m.mockReset());
  fakeLogger.warn.mockReset();
  fakeLogger.info.mockReset();
  fakeLogger.error.mockReset();
  mocks.cronDue.mockReturnValue(true);
  mocks.loadAgent.mockResolvedValue({ slug: "qa-engineer-weekly" });
  mocks.updateStamp.mockResolvedValue({ error: null });
  mocks.enqueue.mockResolvedValue({ work_item_id: "wi-1" });
  mocks.fleetHalted.mockResolvedValue(false);
});

describe("runScheduledRunsHandler — payload_template merge", () => {
  it("forwards payload_template as the enqueue payload", async () => {
    mocks.scheduleRows.mockReturnValueOnce([
      {
        tenant_id: "tnt-1",
        agent_slug: "qa-engineer-weekly",
        cron_expression: "0 22 * * 0",
        enabled: true,
        last_fired_at: null,
        payload_template: {
          repo_hint: "rravi149/praxis",
          staging_origin: "https://staging.example.com",
        },
      },
    ]);
    await runScheduledRunsHandler(fakeLogger);
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        agent_slug: "qa-engineer-weekly",
        source: "cron",
        payload: {
          repo_hint: "rravi149/praxis",
          staging_origin: "https://staging.example.com",
        },
      }),
    );
  });

  it("empty payload_template → null payload (existing behavior)", async () => {
    mocks.scheduleRows.mockReturnValueOnce([
      {
        tenant_id: "tnt-1",
        agent_slug: "fleet-auditor",
        cron_expression: "0 10 * * 1",
        enabled: true,
        last_fired_at: null,
        payload_template: {},
      },
    ]);
    await runScheduledRunsHandler(fakeLogger);
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ payload: null }),
    );
  });

  it("null payload_template → null payload (safety)", async () => {
    mocks.scheduleRows.mockReturnValueOnce([
      {
        tenant_id: "tnt-1",
        agent_slug: "fleet-auditor",
        cron_expression: "0 10 * * 1",
        enabled: true,
        last_fired_at: null,
        payload_template: null,
      },
    ]);
    await runScheduledRunsHandler(fakeLogger);
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ payload: null }),
    );
  });
});

describe("runScheduledRunsHandler — fleet halt (Bundle B item B-4)", () => {
  it("skips the entire scan when halted — no enqueue, no schedule read", async () => {
    mocks.fleetHalted.mockResolvedValue(true);
    mocks.scheduleRows.mockReturnValueOnce([
      {
        tenant_id: "tnt-1",
        agent_slug: "qa-engineer-weekly",
        cron_expression: "0 22 * * 0",
        enabled: true,
        last_fired_at: null,
        payload_template: {},
      },
    ]);
    const result = await runScheduledRunsHandler(fakeLogger);
    expect(result.halted).toBe(true);
    expect(result.fired).toBe(0);
    expect(result.scanned).toBe(0);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("FAIL-SAFE: a halted verdict (true on DB error) skips the scan", async () => {
    mocks.fleetHalted.mockResolvedValue(true);
    const result = await runScheduledRunsHandler(fakeLogger);
    expect(result.halted).toBe(true);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});
