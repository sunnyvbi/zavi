
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({ payload: vi.fn(), schedule: vi.fn() }));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => ({
      select: () => {
        const chain = {
          eq: () => chain,
          maybeSingle: async () => ({ data: { payload: m.payload() }, error: null }),
        };
        return chain;
      },
    }),
  }),
}));
vi.mock("@/services/agents/schedules", () => ({ getSchedule: m.schedule }));

import { socialProposeStandingOrderTool, CHANNEL_STANDING_ORDER_CLASS } from "../propose_standing_order";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
const THREAD = "11111111-1111-1111-1111-111111111111";

function ctx(over: Record<string, unknown> = {}, emit = vi.fn().mockResolvedValue("dec-1")) {
  return {
    tenant_id: TENANT,
    run_id: "run-1",
    agent_slug: "x_organic",
    run_trigger: "handoff",
    emit_decision: emit,
    log: vi.fn(),
    ...over,
  } as never;
}

const good = {
  cron_expression: "0 13 * * *",
  timezone: "Asia/Calcutta",
  prompt: "Daily X brief for Couple App. Sources: … Window: … Report: …",
};

beforeEach(() => {
  m.payload.mockReset().mockReturnValue({ operator_thread_id: THREAD });
  m.schedule.mockReset().mockResolvedValue(null);
});

describe("social__propose_standing_order", () => {
  it("emits ONE channel.create-standing-order decision with the thread from the run payload", async () => {
    const emit = vi.fn().mockResolvedValue("dec-1");
    const out = (await socialProposeStandingOrderTool.execute(ctx({}, emit), good)) as Record<string, unknown>;
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(CHANNEL_STANDING_ORDER_CLASS, {
      cron_expression: "0 13 * * *",
      timezone: "Asia/Calcutta",
      standing_order: { prompt: good.prompt, deliver: { kind: "chat_thread", thread_id: THREAD } },
      channel_slug: "x_organic",
      channel_name: "X",
      replaces_existing: false,
    });
    expect(out).toMatchObject({ decision_id: "dec-1", scheduled: false, replaces_existing: false });
  });

  it("uses thread_id on a chat run, and reports replaces_existing when a row exists", async () => {
    m.payload.mockReturnValue({ thread_id: THREAD });
    m.schedule.mockResolvedValue({ agent_slug: "x_organic" });
    const emit = vi.fn().mockResolvedValue("dec-2");
    const out = (await socialProposeStandingOrderTool.execute(ctx({ run_trigger: "chat" }, emit), good)) as {
      replaces_existing: boolean;
      note: string;
    };
    expect(emit.mock.calls[0][1]).toMatchObject({
      standing_order: { deliver: { thread_id: THREAD } },
      replaces_existing: true,
    });
    expect(out.replaces_existing).toBe(true);
    expect(out.note).toMatch(/replaces/);
  });

  it.each([
    ["not a channel agent", { agent_slug: "operator" }, "standing_order_not_channel_agent"],
    ["scheduled run", { run_trigger: "channel_recipe" }, "standing_order_wrong_surface"],
    ["cron trigger", { run_trigger: "cron" }, "standing_order_wrong_surface"],
    ["no emit", { emit_decision: undefined }, "standing_order_no_emit"],
  ])("refuses: %s", async (_label, over, code) => {
    await expect(socialProposeStandingOrderTool.execute(ctx(over), good)).rejects.toMatchObject({ code });
  });

  it("refuses when the run has no thread to deliver into (model cannot name one)", async () => {
    m.payload.mockReturnValue({ something_else: THREAD });
    await expect(socialProposeStandingOrderTool.execute(ctx(), good)).rejects.toMatchObject({
      code: "standing_order_no_thread",
    });
  });

  it.each([
    ["bad cron", { cron_expression: "every day" }, "standing_order_bad_cron"],
    ["bad tz", { timezone: "Mars/Olympus" }, "standing_order_bad_timezone"],
    ["secret", { prompt: "use xoxb-1234567890-abcdefghij" }, "standing_order_secret_in_prompt"],
  ])("refuses input: %s", async (_label, over, code) => {
    await expect(socialProposeStandingOrderTool.execute(ctx(), { ...good, ...over })).rejects.toMatchObject({ code });
  });

  it("caps the prompt at 5000 (zod)", async () => {
    await expect(
      socialProposeStandingOrderTool.execute(ctx(), { ...good, prompt: "x".repeat(5001) }),
    ).rejects.toBeTruthy();
  });
});
