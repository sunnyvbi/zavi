import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
vi.mock("@/services/agents/registry", () => ({ loadAgentDefinition: mocks.loadAgent }));
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
      update: () => ({ eq: () => ({ eq: () => Promise.resolve(mocks.updateStamp()) }) }),
    }),
  }),
}));

import { runScheduledRunsHandler } from "../../../workers/functions/scheduled-runs";
import { SCHEDULED_AGENTS_ALLOWED } from "@/services/agents/cron-stopped";

const fakeLogger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };

function row(agent_slug: string) {
  return {
    tenant_id: "tnt-1",
    agent_slug,
    cron_expression: "10 14 * * *",
    enabled: true,
    last_fired_at: null,
    payload_template: null,
    timezone: null,
  };
}

beforeEach(() => {
  Object.values(mocks).forEach((m) => m.mockReset());
  Object.values(fakeLogger).forEach((m) => m.mockReset());
  mocks.cronDue.mockReturnValue(true);
  mocks.loadAgent.mockResolvedValue({ slug: "growth-lead" });
  mocks.updateStamp.mockResolvedValue({ error: null });
  mocks.enqueue.mockResolvedValue({ work_item_id: "wi-1" });
  mocks.fleetHalted.mockResolvedValue(false);
  delete process.env.PRAXIS_DISABLE_CRON_STOP;
});

afterEach(() => {
  delete process.env.PRAXIS_DISABLE_CRON_STOP;
});

describe("runScheduledRunsHandler — fleet-wide cron stop", () => {
  it("chief-of-staff is on the stop list", () => {
    expect(SCHEDULED_AGENTS_ALLOWED.has("chief-of-staff")).toBe(false);
  });

  it("does not enqueue a due chief-of-staff schedule, and counts it", async () => {
    mocks.scheduleRows.mockReturnValueOnce([row("chief-of-staff")]);
    const out = await runScheduledRunsHandler(fakeLogger);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(out.fired).toBe(0);
    expect(out.skippedStopped).toBe(1);
    expect(out.skippedUnwired).toBe(0);
  });

  it("skips before the registry read, so a stopped agent costs nothing", async () => {
    mocks.scheduleRows.mockReturnValueOnce([row("chief-of-staff")]);
    await runScheduledRunsHandler(fakeLogger);
    expect(mocks.loadAgent).not.toHaveBeenCalled();
  });

  it("fires NOTHING while the allowlist is empty", async () => {
    mocks.scheduleRows.mockReturnValueOnce([
      row("operator"),
      row("research"),
      row("chief-of-staff"),
    ]);
    const out = await runScheduledRunsHandler(fakeLogger);
    expect(out.fired).toBe(0);
    expect(out.skippedStopped).toBe(3);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("PRAXIS_DISABLE_CRON_STOP=1 restores firing without a code change", async () => {
    process.env.PRAXIS_DISABLE_CRON_STOP = "1";
    mocks.loadAgent.mockResolvedValue({ slug: "chief-of-staff" });
    mocks.scheduleRows.mockReturnValueOnce([row("chief-of-staff")]);
    const out = await runScheduledRunsHandler(fakeLogger);
    expect(out.fired).toBe(1);
    expect(out.skippedStopped).toBe(0);
  });
});

describe("runScheduledRunsHandler — standing orders are exempt from the stop", () => {
  const standing = {
    standing_order: {
      prompt: "Post stalled approvals + GMV to #ops",
      deliver: { kind: "chat_thread", thread_id: "11111111-1111-1111-1111-111111111111" },
    },
  };

  it("an operator standing order fires while the allowlist is empty", async () => {
    mocks.loadAgent.mockResolvedValue({ slug: "operator" });
    mocks.scheduleRows.mockReturnValueOnce([{ ...row("operator"), payload_template: standing }]);
    const out = await runScheduledRunsHandler(fakeLogger);
    expect(out.skippedStopped).toBe(0);
    expect(out.fired).toBe(1);
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({ agent_slug: "operator", payload: standing }));
  });

  it("the same slug with no standing order stays stopped", async () => {
    mocks.loadAgent.mockResolvedValue({ slug: "operator" });
    mocks.scheduleRows.mockReturnValueOnce([row("operator")]);
    const out = await runScheduledRunsHandler(fakeLogger);
    expect(out.skippedStopped).toBe(1);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});
