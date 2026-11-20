
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  enqueueWorkItem: vi.fn(),
  enqueueAgentRun: vi.fn(),
  runChannelRecipe: vi.fn(),
  scheduleRows: vi.fn(),
  cronDue: vi.fn(),
  loadAgent: vi.fn(),
  updateStamp: vi.fn(),
  fleetHalted: vi.fn(),
  tierDecide: vi.fn(),
}));

vi.mock("@/services/agents/entitlement", () => ({
  createTierGate: () => ({ decide: (t: string, s: string) => mocks.tierDecide(t, s) }),
}));

vi.mock("@/services/agents/fleet-halt", () => ({
  isFleetHalted: () => mocks.fleetHalted(),
}));
vi.mock("@/services/agents/work-queue", () => ({ enqueueWorkItem: mocks.enqueueWorkItem }));
vi.mock("@/services/agents/runner", () => ({ enqueueAgentRun: mocks.enqueueAgentRun }));
vi.mock("@/services/channels/engine", () => ({ runChannelRecipe: mocks.runChannelRecipe }));
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

const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
const THREAD = "11111111-1111-1111-1111-111111111111";
const template = {
  standing_order: {
    prompt: "Daily X brief for Couple App",
    deliver: { kind: "chat_thread", thread_id: THREAD },
  },
};

function row(agent_slug: string, payload_template: Record<string, unknown> | null = template) {
  return {
    tenant_id: "tnt-1",
    agent_slug,
    cron_expression: "0 13 * * *",
    enabled: true,
    last_fired_at: null,
    payload_template,
    timezone: "Asia/Calcutta",
  };
}

beforeEach(() => {
  Object.values(mocks).forEach((m) => m.mockReset());
  logger.warn.mockReset();
  logger.info.mockReset();
  logger.error.mockReset();
  mocks.cronDue.mockReturnValue(true);
  mocks.loadAgent.mockResolvedValue({ slug: "x_organic" });
  mocks.updateStamp.mockResolvedValue({ error: null });
  mocks.fleetHalted.mockResolvedValue(false);
  mocks.enqueueWorkItem.mockResolvedValue({ work_item_id: "wi-1" });
  mocks.enqueueAgentRun.mockResolvedValue({ run_id: "run-1" });
  mocks.runChannelRecipe.mockResolvedValue({ ok: true, run_id: "run-1" });
  mocks.tierDecide.mockResolvedValue({ enforced: false, tier: "free", required_tier: "starter", allowed: true });
});

describe("scheduled-runs — channel standing orders", () => {
  it("routes an x_organic row through runChannelRecipe with the template as extra", async () => {
    mocks.scheduleRows.mockReturnValueOnce([row("x_organic")]);
    const r = await runScheduledRunsHandler(logger);

    expect(r.fired).toBe(1);
    expect(mocks.enqueueWorkItem).not.toHaveBeenCalled();
    expect(mocks.runChannelRecipe).toHaveBeenCalledTimes(1);
    const [tenant, channel, deps, redo, extra] = mocks.runChannelRecipe.mock.calls[0];
    expect(tenant).toBe("tnt-1");
    expect(channel).toBe("x_organic");
    expect(redo).toBeUndefined();
    expect(extra).toEqual(template);

    await deps.enqueue({
      slug: "x_organic",
      tenant_id: "tnt-1",
      trigger: "channel_recipe",
      payload: { ...template, channel_slug: "x_organic" },
    });
    expect(mocks.enqueueAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({
        agent_slug: "x_organic",
        tenant_id: "tnt-1",
        trigger: "channel_recipe",
        cron_dedupe_key: expect.stringMatching(/^tnt-1:x_organic:/),
        payload: expect.objectContaining({ standing_order: template.standing_order }),
      }),
    );
    expect(mocks.updateStamp).toHaveBeenCalledTimes(1);
  });

  it("a channel row WITHOUT a standing order is an anonymous clock — stopped by the allowlist", async () => {
    mocks.scheduleRows.mockReturnValueOnce([row("x_organic", {})]);
    const r = await runScheduledRunsHandler(logger);
    expect(mocks.runChannelRecipe).not.toHaveBeenCalled();
    expect(r.skippedStopped).toBe(1);
  });

  it("a refused channel run (cap reached) is not counted as fired but is still stamped", async () => {
    mocks.runChannelRecipe.mockResolvedValueOnce({
      ok: false,
      reason: "cap_reached",
      message: "cap",
      spent_30d: 9,
    });
    mocks.scheduleRows.mockReturnValueOnce([row("x_organic")]);
    const r = await runScheduledRunsHandler(logger);
    expect(r.fired).toBe(0);
    expect(mocks.updateStamp).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/cap_reached/));
  });

  it("an engine throw is logged, not stamped, and does not stop the scan", async () => {
    mocks.runChannelRecipe.mockRejectedValueOnce(new Error("boom"));
    mocks.scheduleRows.mockReturnValueOnce([row("x_organic"), row("operator")]);
    mocks.loadAgent.mockResolvedValue({ slug: "any" });
    const r = await runScheduledRunsHandler(logger);
    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/boom/));
    expect(r.fired).toBe(1);
    expect(mocks.enqueueWorkItem).toHaveBeenCalledTimes(1);
  });

  it("a non-channel row keeps the work-queue path (byte-identical)", async () => {
    mocks.loadAgent.mockResolvedValue({ slug: "operator" });
    mocks.scheduleRows.mockReturnValueOnce([row("operator")]);
    await runScheduledRunsHandler(logger);
    expect(mocks.runChannelRecipe).not.toHaveBeenCalled();
    expect(mocks.enqueueWorkItem).toHaveBeenCalledWith(
      expect.objectContaining({ agent_slug: "operator", source: "cron", payload: template }),
    );
  });
});

describe("scheduled-runs — three-tier pricing", () => {
  it("skips a schedule the tenant's tier cannot run: no run, no stamp, counted", async () => {
    mocks.tierDecide.mockResolvedValue({ enforced: true, tier: "free", required_tier: "starter", allowed: false });
    mocks.scheduleRows.mockReturnValueOnce([row("x_organic")]);
    const r = await runScheduledRunsHandler(logger);
    expect(mocks.runChannelRecipe).not.toHaveBeenCalled();
    expect(mocks.enqueueWorkItem).not.toHaveBeenCalled();
    expect(mocks.updateStamp).not.toHaveBeenCalled();
    expect(r.fired).toBe(0);
    expect(r.skippedPlan).toBe(1);
    expect(mocks.tierDecide).toHaveBeenCalledWith("tnt-1", "x_organic");
  });

  it("fails closed when the tier cannot be read, and keeps scanning other rows", async () => {
    mocks.loadAgent.mockResolvedValue({ slug: "any" });
    mocks.tierDecide
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValueOnce({ enforced: true, tier: "free", required_tier: "free", allowed: true });
    mocks.scheduleRows.mockReturnValueOnce([row("x_organic"), row("operator")]);
    const r = await runScheduledRunsHandler(logger);
    expect(mocks.runChannelRecipe).not.toHaveBeenCalled();
    expect(r.skippedPlan).toBe(1);
    expect(r.fired).toBe(1);
    expect(mocks.enqueueWorkItem).toHaveBeenCalledTimes(1);
  });
});
