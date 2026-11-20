import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  complete: vi.fn(),
  enqueue: vi.fn(),
  release: vi.fn(),
  fleetHalted: vi.fn(),
  relane: vi.fn(),
  callMcp: vi.fn(),
  logEvent: vi.fn(),
  claimUpdateRows: [{ event_id: "Ev1" }] as Array<{ event_id: string }>,
  surfaceOn: { whatsapp: true, telegram: true, discord: true },
  hostPhoneId: "PN-HOST",
  creditSkip: vi.fn(),
}));

vi.mock("@/services/agents/custom-agent-runs", () => ({
  noteCustomAgentCreditSkip: (...a: unknown[]) => mocks.creditSkip(...a),
}));

vi.mock("@/services/agents/deepagent", () => ({ LangChainDeepAgentEngine: class {} }));
vi.mock("@/services/connectors/whatsapp/adapter", () => ({
  whatsappOwnsNumber: (pn: string) => mocks.surfaceOn.whatsapp && pn === mocks.hostPhoneId,
}));
vi.mock("@/services/connectors/telegram/adapter", () => ({ telegramEnabled: () => mocks.surfaceOn.telegram }));
vi.mock("@/services/connectors/discord/adapter", () => ({ discordEnabled: () => mocks.surfaceOn.discord }));

vi.mock("@/services/agents/runner", () => ({
  enqueueAgentRun: mocks.enqueue,
  InsufficientCreditsError: class InsufficientCreditsError extends Error {
    constructor(slug: string) {
      super(`Agent "${slug}" rejected: out of credits`);
      this.name = "InsufficientCreditsError";
    }
  },
}));
vi.mock("@/services/agents/fleet-halt", () => ({
  isFleetHalted: () => mocks.fleetHalted(),
  FleetHaltedError: class FleetHaltedError extends Error {
    code = "fleet_halted";
    constructor() {
      super("fleet halt active");
      this.name = "FleetHaltedError";
    }
  },
}));
vi.mock("@/services/agents/work-queue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/agents/work-queue")>();
  return {
    ...actual,
    claimWorkItems: mocks.claim,
    completeWorkItem: mocks.complete,
    releaseWorkItemToPending: mocks.release,
    relaneStaleLocalItems: mocks.relane,
  };
});

vi.mock("@/services/mcp/execute", () => ({ callMcpTool: (...a: unknown[]) => mocks.callMcp(...a) }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: (...a: unknown[]) => mocks.logEvent(...a) }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => ({
      update: () => ({
        eq: () => ({
          eq: () => ({
            is: () => ({
              select: async () => ({ data: mocks.claimUpdateRows, error: null }),
            }),
          }),
        }),
      }),
    }),
  }),
}));

import { runWorkQueueDrainerHandler } from "../../../workers/functions/work-queue-drainer";

const fakeLogger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };

function item(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "wi-1",
    tenant_id: "tnt-1",
    agent_slug: "pm",
    source: "cron",
    priority: 0,
    status: "leased",
    attempts: 1,
    risk_tier: null,
    payload: { foo: "bar" },
    dedupe_key: "tnt-1:pm:bucket",
    agent_run_id: null,
    next_run_at: new Date().toISOString(),
    ...over,
  };
}

beforeEach(() => {
  Object.values(mocks).forEach((m) => {
    if (typeof (m as { mockReset?: unknown })?.mockReset === "function") {
      (m as unknown as { mockReset: () => void }).mockReset();
    }
  });
  fakeLogger.warn.mockReset();
  fakeLogger.info.mockReset();
  fakeLogger.error.mockReset();
  vi.stubEnv("PRAXIS_CONTAINER_ROLE", "canonical");
  mocks.enqueue.mockResolvedValue({ run_id: "run-1" });
  mocks.complete.mockResolvedValue(undefined);
  mocks.release.mockResolvedValue(undefined);
  mocks.fleetHalted.mockResolvedValue(false);
  mocks.relane.mockResolvedValue(0);
  mocks.callMcp.mockResolvedValue({ is_error: false, content: "{}" });
  mocks.logEvent.mockResolvedValue(undefined);
  mocks.claimUpdateRows = [{ event_id: "Ev1" }];
});

function slackItem(over: Partial<Record<string, unknown>> = {}) {
  return item({
    source: "webhook_slack",
    agent_slug: "operator",
    payload: {
      slack: { channel_id: "D1", thread_ts: "1784160252.840219", event_id: "Ev1", team_id: "T1" },
    },
    ...over,
  });
}

describe("slack pre-claim recovery — no in-thread silence when no run can exist", () => {
  it("out-of-credits on a PRE-CLAIMED webhook_slack turn → posts an honest fallback, not silence", async () => {
    const { InsufficientCreditsError } = await import("@/services/agents/runner");
    mocks.claim.mockResolvedValue([slackItem()]);
    mocks.enqueue.mockRejectedValueOnce(new InsufficientCreditsError("operator"));

    await runWorkQueueDrainerHandler(fakeLogger);

    expect(mocks.callMcp).toHaveBeenCalledTimes(1);
    const [ctx, server, tool, args] = mocks.callMcp.mock.calls[0];
    expect(server).toBe("slack");
    expect(tool).toBe("post_message");
    expect(ctx).toMatchObject({ tenant_id: "tnt-1", slack_target_team_id: "T1" });
    expect(args).toMatchObject({ channel_id: "D1", thread_ts: "1784160252.840219" });
    expect(String((args as { text: string }).text)).toContain("out of run credits");
  });

  it("generic terminal enqueue failure on a webhook_slack turn → honest fallback", async () => {
    mocks.claim.mockResolvedValue([slackItem()]);
    mocks.enqueue.mockRejectedValueOnce(new Error("agent kill-switch"));

    await runWorkQueueDrainerHandler(fakeLogger);

    expect(mocks.callMcp).toHaveBeenCalledTimes(1);
    expect(String(mocks.callMcp.mock.calls[0][3].text)).toContain("couldn't pick that up");
  });

  it("someone already replied (guarded claim matches no row) → does NOT double-post", async () => {
    mocks.claimUpdateRows = [];
    mocks.claim.mockResolvedValue([slackItem()]);
    mocks.enqueue.mockRejectedValueOnce(new Error("boom"));

    await runWorkQueueDrainerHandler(fakeLogger);

    expect(mocks.callMcp).not.toHaveBeenCalled();
  });

  it("non-slack item terminal failure → no Slack post at all", async () => {
    mocks.claim.mockResolvedValue([item({ source: "cron" })]);
    mocks.enqueue.mockRejectedValueOnce(new Error("boom"));

    await runWorkQueueDrainerHandler(fakeLogger);

    expect(mocks.callMcp).not.toHaveBeenCalled();
  });

  it("fleet halt mid-tick → released to pending, NO fallback post (the run still comes)", async () => {
    const { FleetHaltedError } = await import("@/services/agents/fleet-halt");
    mocks.claim.mockResolvedValue([slackItem()]);
    mocks.enqueue.mockRejectedValueOnce(new FleetHaltedError());

    await runWorkQueueDrainerHandler(fakeLogger);

    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(mocks.callMcp).not.toHaveBeenCalled();
  });
});

describe("runWorkQueueDrainerHandler", () => {
  it("dispatches a background item: maps source→trigger, mirrors dedupe_key, completes done", async () => {
    mocks.claim.mockResolvedValueOnce([item({ source: "webhook_github" })]);

    const res = await runWorkQueueDrainerHandler(fakeLogger);

    expect(mocks.enqueue).toHaveBeenCalledWith({
      tenant_id: "tnt-1",
      agent_slug: "pm",
      trigger: "webhook",
      payload: { foo: "bar" },
      cron_dedupe_key: "tnt-1:pm:bucket",
    });
    expect(mocks.complete).toHaveBeenCalledWith("wi-1", "done", "run-1");
    expect(res).toMatchObject({ claimed: 1, dispatched: 1, failed: 0, skipped: 0 });
  });

  it("maps webhook_slack → slack trigger", async () => {
    mocks.claim.mockResolvedValueOnce([item({ source: "webhook_slack" })]);
    await runWorkQueueDrainerHandler(fakeLogger);
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: "slack" }),
    );
  });

  it("drops synchronous-direct sources (chat/manual) without enqueueing", async () => {
    mocks.claim.mockResolvedValueOnce([item({ id: "wi-c", source: "chat" })]);

    const res = await runWorkQueueDrainerHandler(fakeLogger);

    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.complete).toHaveBeenCalledWith(
      "wi-c",
      "dropped",
      null,
      expect.stringContaining("synchronous-direct"),
    );
    expect(res).toMatchObject({ dispatched: 0, skipped: 1 });
  });

  it("marks an item failed (not retried) when enqueue throws a safety gate", async () => {
    mocks.claim.mockResolvedValueOnce([item({ id: "wi-k" })]);
    mocks.enqueue.mockRejectedValueOnce(new Error("agent killed for this tenant"));

    const res = await runWorkQueueDrainerHandler(fakeLogger);

    expect(mocks.complete).toHaveBeenCalledWith(
      "wi-k",
      "failed",
      null,
      "agent killed for this tenant",
    );
    expect(res).toMatchObject({ dispatched: 0, failed: 1 });
  });

  it("marks an item failed with a stable 'insufficient_credits' reason when enqueue is out of credits", async () => {
    const { InsufficientCreditsError } = await import("@/services/agents/runner");
    mocks.claim.mockResolvedValueOnce([item({ id: "wi-ooc" })]);
    mocks.enqueue.mockRejectedValueOnce(new InsufficientCreditsError("engineer"));

    const res = await runWorkQueueDrainerHandler(fakeLogger);

    expect(mocks.complete).toHaveBeenCalledWith("wi-ooc", "failed", null, "insufficient_credits");
    expect(mocks.release).not.toHaveBeenCalled();
    expect(res).toMatchObject({ dispatched: 0, failed: 1 });
  });

  it("treats a dedupe-blocked enqueue (empty run_id) as done with null run_id", async () => {
    mocks.claim.mockResolvedValueOnce([item({ id: "wi-d" })]);
    mocks.enqueue.mockResolvedValueOnce({ run_id: "" });

    const res = await runWorkQueueDrainerHandler(fakeLogger);

    expect(mocks.complete).toHaveBeenCalledWith("wi-d", "done", null);
    expect(res).toMatchObject({ dispatched: 1, failed: 0 });
  });

  it("returns zeros on an empty queue", async () => {
    mocks.claim.mockResolvedValueOnce([]);
    const res = await runWorkQueueDrainerHandler(fakeLogger);
    expect(res).toEqual({ claimed: 0, dispatched: 0, failed: 0, skipped: 0 });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("skips the whole tick when fleet is halted (claims + completes nothing)", async () => {
    mocks.fleetHalted.mockResolvedValueOnce(true);
    const res = await runWorkQueueDrainerHandler(fakeLogger);
    expect(res).toEqual({ claimed: 0, dispatched: 0, failed: 0, skipped: 0 });
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("releases a claimed item back to pending (not failed) on a mid-tick fleet_halted", async () => {
    mocks.claim.mockResolvedValueOnce([item({ id: "wi-h" })]);
    const haltErr = Object.assign(new Error("fleet halt active"), { code: "fleet_halted" });
    mocks.enqueue.mockRejectedValueOnce(haltErr);

    const res = await runWorkQueueDrainerHandler(fakeLogger);

    expect(mocks.release).toHaveBeenCalledWith("wi-h");
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(res).toMatchObject({ dispatched: 0, failed: 0, skipped: 1 });
  });
});

const WA_ITEM_PAYLOAD = {
  whatsapp: { phone_number_id: "PN-HOST", wa_id: "1669", message_id: "wamid.1", text: "hi" },
};

describe("chat-surface credential gate", () => {
  beforeEach(() => {
    mocks.surfaceOn.whatsapp = true;
    mocks.surfaceOn.telegram = true;
    mocks.surfaceOn.discord = true;
  });

  it("releases a webhook_whatsapp item back to pending (short delay) when WhatsApp is not configured here", async () => {
    mocks.surfaceOn.whatsapp = false;
    mocks.claim.mockResolvedValueOnce([item({ id: "wi-wa", source: "webhook_whatsapp", payload: WA_ITEM_PAYLOAD })]);

    const res = await runWorkQueueDrainerHandler(fakeLogger);

    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledWith("wi-wa", 5);
    expect(res).toMatchObject({ claimed: 1, dispatched: 0, failed: 0, skipped: 1 });
    expect(fakeLogger.warn).toHaveBeenCalledWith(expect.stringContaining("surface not configured"));
  });

  it("releases a webhook_whatsapp item whose thread belongs to ANOTHER business number, even though WhatsApp is configured here", async () => {
    mocks.claim.mockResolvedValueOnce([
      item({
        id: "wi-other",
        source: "webhook_whatsapp",
        payload: { whatsapp: { ...WA_ITEM_PAYLOAD.whatsapp, phone_number_id: "PN-REAL" } },
      }),
    ]);

    const res = await runWorkQueueDrainerHandler(fakeLogger);

    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledWith("wi-other", 5);
    expect(res).toMatchObject({ claimed: 1, dispatched: 0, skipped: 1 });
  });

  it("terminalizes instead of releasing forever once attempts pass the cap (no silent strand)", async () => {
    mocks.claim.mockResolvedValueOnce([
      item({
        id: "wi-strand",
        source: "webhook_whatsapp",
        attempts: 20,
        payload: { whatsapp: { ...WA_ITEM_PAYLOAD.whatsapp, phone_number_id: "PN-NOBODY" } },
      }),
    ]);

    const res = await runWorkQueueDrainerHandler(fakeLogger);

    expect(mocks.release).not.toHaveBeenCalled();
    expect(mocks.complete).toHaveBeenCalledWith("wi-strand", "failed", null, "surface_unclaimable");
    expect(mocks.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ level: "error", code: "work_item.surface_unclaimable", tenant_id: "tnt-1" }),
    );
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(res).toMatchObject({ claimed: 1, dispatched: 0, failed: 1, skipped: 0 });
  });

  it("still releases (does not terminalize) while attempts are under the cap", async () => {
    mocks.claim.mockResolvedValueOnce([
      item({
        id: "wi-young",
        source: "webhook_whatsapp",
        attempts: 19,
        payload: { whatsapp: { ...WA_ITEM_PAYLOAD.whatsapp, phone_number_id: "PN-NOBODY" } },
      }),
    ]);

    const res = await runWorkQueueDrainerHandler(fakeLogger);

    expect(mocks.release).toHaveBeenCalledWith("wi-young", 5);
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(res).toMatchObject({ claimed: 1, failed: 0, skipped: 1 });
  });

  it("dispatches the same item normally when the surface IS configured", async () => {
    mocks.claim.mockResolvedValueOnce([item({ id: "wi-wa", source: "webhook_whatsapp", payload: WA_ITEM_PAYLOAD })]);
    const res = await runWorkQueueDrainerHandler(fakeLogger);
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({ trigger: "whatsapp" }));
    expect(mocks.release).not.toHaveBeenCalled();
    expect(res).toMatchObject({ dispatched: 1, skipped: 0 });
  });

  it("gates telegram/discord the same way and never touches non-surface sources", async () => {
    mocks.surfaceOn.telegram = false;
    mocks.surfaceOn.discord = false;
    mocks.claim.mockResolvedValueOnce([
      item({ id: "wi-tg", source: "webhook_telegram" }),
      item({ id: "wi-dc", source: "webhook_discord" }),
      item({ id: "wi-gh", source: "webhook_github" }),
    ]);
    const res = await runWorkQueueDrainerHandler(fakeLogger);
    expect(mocks.release).toHaveBeenCalledWith("wi-tg", 5);
    expect(mocks.release).toHaveBeenCalledWith("wi-dc", 5);
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.complete).toHaveBeenCalledWith("wi-gh", "done", "run-1");
    expect(res).toMatchObject({ claimed: 3, dispatched: 1, skipped: 2 });
  });
});

describe("three-tier pricing — plan_upgrade_required is a clean skip", () => {
  const refusal = () => Object.assign(new Error("Meta Ads needs the Pro plan ($240/mo)."), {
  code: "plan_upgrade_required",
  agent_slug: "meta_ads",
  required_tier: "pro",
  body: {
    error: { code: "plan_upgrade_required", required_tier: "pro", message: "Meta Ads needs the Pro plan ($240/mo)." },
  },
});

  it("drops the item with a stable reason, counts it skipped (not failed), never releases it", async () => {
    mocks.claim.mockResolvedValueOnce([item({ id: "wi-plan", agent_slug: "meta_ads" })]);
    mocks.enqueue.mockRejectedValueOnce(refusal());

    const res = await runWorkQueueDrainerHandler(fakeLogger);

    expect(mocks.complete).toHaveBeenCalledWith("wi-plan", "dropped", null, "plan_upgrade_required");
    expect(mocks.release).not.toHaveBeenCalled();
    expect(res).toMatchObject({ dispatched: 0, failed: 0, skipped: 1 });
    expect(fakeLogger.error).not.toHaveBeenCalled();
  });

  it("a pre-claimed Slack turn gets the plan message, not generic silence", async () => {
    mocks.claim.mockResolvedValue([slackItem()]);
    mocks.enqueue.mockRejectedValueOnce(refusal());

    await runWorkQueueDrainerHandler(fakeLogger);

    expect(mocks.callMcp).toHaveBeenCalledTimes(1);
    const text = String(mocks.callMcp.mock.calls[0][3].text);
    expect(text).toContain("Meta Ads needs the Pro plan ($240/mo).");
    expect(text).toContain("Billing page");
  });
});

describe("only the canonical container drains the shared prod queue", () => {
  it("a local stack (no role) claims nothing and re-lanes nothing", async () => {
    mocks.claim.mockResolvedValue([item({ source: "webhook_slack" })]);

    const res = await runWorkQueueDrainerHandler(fakeLogger, {});

    expect(res).toEqual({ claimed: 0, dispatched: 0, failed: 0, skipped: 0 });
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.relane).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("PRAXIS_DRAIN_SHARED_QUEUE=1 opts a dev stack in on purpose", async () => {
    mocks.claim.mockResolvedValue([item()]);

    const res = await runWorkQueueDrainerHandler(fakeLogger, { PRAXIS_DRAIN_SHARED_QUEUE: "1" });

    expect(mocks.claim).toHaveBeenCalledTimes(1);
    expect(res.dispatched).toBe(1);
  });
});

describe("Agent Builder S2: scheduled custom-agent items", () => {
  const TRIG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const customItem = (over: Partial<Record<string, unknown>> = {}) =>
    item({
      agent_slug: "c-abcdef1234",
      payload: { task_description: "Scheduled run", custom_agent: { trigger_id: TRIG } },
      dedupe_key: `custom:${TRIG}:bucket`,
      ...over,
    });

  it("passes the trigger id to enqueueAgentRun (stamp_custom_agent_run re-checks it)", async () => {
    mocks.claim.mockResolvedValueOnce([customItem()]);
    await runWorkQueueDrainerHandler(fakeLogger);
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ agent_slug: "c-abcdef1234", trigger: "cron", custom_trigger_id: TRIG }),
    );
  });

  it("a built-in slug never carries a trigger id, even with the payload key", async () => {
    mocks.claim.mockResolvedValueOnce([customItem({ agent_slug: "pm" })]);
    await runWorkQueueDrainerHandler(fakeLogger);
    expect(mocks.enqueue.mock.calls[0][0]).not.toHaveProperty("custom_trigger_id");
  });

  it("out of credits: the fire is dropped and the credits-skip notice path runs", async () => {
    const { InsufficientCreditsError } = await import("@/services/agents/runner");
    mocks.claim.mockResolvedValueOnce([customItem()]);
    mocks.enqueue.mockRejectedValueOnce(new InsufficientCreditsError("c-abcdef1234"));
    await runWorkQueueDrainerHandler(fakeLogger);
    expect(mocks.complete).toHaveBeenCalledWith("wi-1", "failed", null, "insufficient_credits");
    expect(mocks.creditSkip).toHaveBeenCalledWith("tnt-1", TRIG);
  });

  it("a built-in agent out of credits sends no custom notice", async () => {
    const { InsufficientCreditsError } = await import("@/services/agents/runner");
    mocks.claim.mockResolvedValueOnce([item()]);
    mocks.enqueue.mockRejectedValueOnce(new InsufficientCreditsError("pm"));
    await runWorkQueueDrainerHandler(fakeLogger);
    expect(mocks.creditSkip).not.toHaveBeenCalled();
  });
});
