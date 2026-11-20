
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  serviceClient: vi.fn(),
  send: vi.fn(async () => ({ ids: ["e1"] })),
  enqueueWorkItem: vi.fn(async () => {}),
  isFleetHalted: vi.fn(async () => false),
  logEvent: vi.fn(async () => {}),
  slackFetch: vi.fn(async () => ({ ok: true })),
  postWhatsAppReply: vi.fn(
    async (): Promise<{ ok: boolean; chunks?: number; windowClosed?: boolean; sent?: number; error?: string }> => ({
      ok: true,
      chunks: 1,
    }),
  ),
  postWhatsAppWindowTemplate: vi.fn(
    async (): Promise<{ ok: boolean; chunks?: number; sent?: number; error?: string }> => ({
      ok: true,
      chunks: 1,
    }),
  ),
  postTelegramReply: vi.fn(async () => ({ ok: true, sent: 1 })),
  postDiscordReply: vi.fn(async () => ({ ok: true, sent: 1 })),
  discordChannelMembership: vi.fn(async (): Promise<string> => "in"),
  findEnabledWhatsAppBinding: vi.fn(async () => ({ tenant_id: "t1", window_expires_at: null })),
  resolveTenantTier: vi.fn(async (): Promise<string> => "starter"),
  tierConfig: vi.fn((): Record<string, unknown> => ({ enforced: false, agentMin: {}, proTenants: [] })),
  sendReminderEmail: vi.fn(
    async (_i: unknown): Promise<{ sent: true } | { sent: false; reason: string }> => ({ sent: true }),
  ),
}));

vi.mock("../../client", () => ({
  inngest: {
    createFunction: (_c: unknown, _t: unknown, _f: unknown) => ({ id: "stub" }),
    send: m.send,
  },
}));
vi.mock("@/services/supabase", () => ({ serviceClient: m.serviceClient }));
vi.mock("@/services/agents/entitlement", () => ({
  loadTierGateConfig: async () => m.tierConfig(),
  resolveTenantTier: m.resolveTenantTier,
}));
vi.mock("@/services/agents/work-queue", () => ({ enqueueWorkItem: m.enqueueWorkItem }));
vi.mock("@/services/agents/fleet-halt", () => ({ isFleetHalted: m.isFleetHalted }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: m.logEvent }));
vi.mock("@/services/tools/slack/_client", () => ({ slackFetch: m.slackFetch }));
vi.mock("@/services/agents/scrub-agent-egress", () => ({
  scrubAgentEgress: (t: string) => ({ text: t }),
}));
vi.mock("@/services/tools/whatsapp/_client", () => ({
  postWhatsAppReply: m.postWhatsAppReply,
  postWhatsAppWindowTemplate: m.postWhatsAppWindowTemplate,
}));
vi.mock("@/services/tools/telegram/_client", () => ({ postTelegramReply: m.postTelegramReply }));
vi.mock("@/services/tools/discord/_client", () => ({ postDiscordReply: m.postDiscordReply }));
vi.mock("@/services/connectors/discord/adapter", () => ({
  discordChannelMembership: m.discordChannelMembership,
}));
vi.mock("@/services/connectors/whatsapp/binding", () => ({
  findEnabledWhatsAppBinding: m.findEnabledWhatsAppBinding,
}));
vi.mock("@/services/agents/reminder-email", () => ({
  sendReminderEmail: m.sendReminderEmail,
  defaultReminderEmailDeps: () => ({}),
}));

import { runReminderFireHandler, runReminderWaitHandler } from "../reminder-fire";

const logger = { info: vi.fn(), error: vi.fn() };

const ENV_SNAPSHOT = { ...process.env };
function ownNumber(phoneNumberId: string) {
  process.env.WHATSAPP_ACCESS_TOKEN = "tok";
  process.env.WHATSAPP_PHONE_NUMBER_ID = phoneNumberId;
  process.env.WHATSAPP_APP_SECRET = "sec";
  process.env.WHATSAPP_VERIFY_TOKEN = "vt";
}

const SLACK_PING = {
  id: "r1",
  tenant_id: "t1",
  agent_slug: "operator",
  mode: "ping" as const,
  note: "check the ads spend",
  schedule_kind: "once" as const,
  due_at: "2026-07-13T12:01:00.000Z",
  cron_expression: null,
  tz: "America/Los_Angeles",
  deliver: { kind: "slack_thread", channel_id: "C1", thread_ts: "1720.100" },
  fired_count: 0,
};

function updChain(
  result: { data: unknown; error: { message: string } | null },
  filters: Array<[string, string, unknown]> = [],
) {
  const c: Record<string, unknown> = {};
  c.eq = (col: string, v: unknown) => (filters.push(["eq", col, v]), c);
  c.is = (col: string, v: unknown) => (filters.push(["is", col, v]), c);
  c.select = async () => result;
  c.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej);
  return c;
}

function makeSb(
  claimed: unknown[],
  bindingRow: unknown = { id: "th", tenant_id: "t1" },
  reminderUpdateError: { message: string } | null = null,
  leaseHeld = true,
) {
  const updates: Record<string, unknown>[] = [];
  const filters: Array<[string, string, unknown]> = [];
  const sb = {
    rpc: vi.fn(async (fn: string) =>
      fn === "claim_due_reminders" || fn === "claim_reminder_by_id"
        ? { data: claimed, error: null }
        : { data: null, error: null },
    ),
    from: vi.fn((table: string) => {
      if (table === "agent_reminders") {
        return {
          update: (patch: Record<string, unknown>) => {
            updates.push(patch);
            return updChain(
              reminderUpdateError
                ? { data: null, error: reminderUpdateError }
                : { data: leaseHeld ? [{ id: "r" }] : [], error: null },
              filters,
            );
          },
        };
      }
      const chain: Record<string, unknown> = {
        maybeSingle: async () => ({ data: bindingRow }),
      };
      chain.eq = () => chain;
      return {
        select: () => chain,
        insert: async () => ({ error: null }),
        update: () => ({ eq: async () => ({ error: null }) }),
      };
    }),
  };
  return { sb, updates, filters };
}

beforeEach(() => {
  process.env = { ...ENV_SNAPSHOT };
  vi.clearAllMocks();
  m.isFleetHalted.mockResolvedValue(false);
  m.slackFetch.mockResolvedValue({ ok: true });
  m.resolveTenantTier.mockResolvedValue("starter");
  m.sendReminderEmail.mockResolvedValue({ sent: true });
});

describe("reminder-fire", () => {
  it("delivers a PING into the Slack thread it was set in, and does not enqueue a run", async () => {
    const { sb, updates } = makeSb([SLACK_PING]);
    m.serviceClient.mockReturnValue(sb);

    const r = await runReminderFireHandler(logger);

    expect(r).toMatchObject({ claimed: 1, pinged: 1, enqueued: 0, failed: 0 });
    expect(m.slackFetch).toHaveBeenCalledWith(
      "t1",
      "chat.postMessage",
      expect.objectContaining({
        channel: "C1",
        thread_ts: "1720.100",
        text: "⏰ Reminder: check the ads spend",
      }),
      undefined,
    );
    expect(m.enqueueWorkItem).not.toHaveBeenCalled();
    expect(updates[0]).toMatchObject({ status: "fired", last_error: null });
  });

  it("enqueues an agent run for a RUN reminder, carrying the delivery target", async () => {
    const { sb } = makeSb([{ ...SLACK_PING, id: "r2", mode: "run", note: "re-check the deploy" }]);
    m.serviceClient.mockReturnValue(sb);

    const r = await runReminderFireHandler(logger);

    expect(r).toMatchObject({ pinged: 0, enqueued: 1 });
    expect(m.enqueueWorkItem).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: "t1",
        agent_slug: "operator",
        payload: {
          reminder: {
            prompt: "re-check the deploy",
            deliver: { kind: "slack_thread", channel_id: "C1", thread_ts: "1720.100" },
          },
        },
        dedupe_key: "reminder:r2:2026-07-13T12:01:00.000Z",
      }),
    );
    expect(m.slackFetch).not.toHaveBeenCalled();
  });

  it("re-arms a recurring reminder to its next fire instead of closing it", async () => {
    const { sb, updates } = makeSb([
      {
        ...SLACK_PING,
        id: "r3",
        schedule_kind: "recurring",
        cron_expression: "0 16 * * *",
        fired_count: 4,
      },
    ]);
    m.serviceClient.mockReturnValue(sb);

    await runReminderFireHandler(logger);

    expect(updates[0]).toMatchObject({ status: "pending", fired_count: 5 });
    expect(new Date(updates[0].due_at as string).getTime()).toBeGreaterThan(Date.now());
    expect(updates[0].lease_until).toBeNull();
  });

  it("marks a reminder FAILED (not fired) when delivery fails", async () => {
    const { sb, updates } = makeSb([SLACK_PING]);
    m.serviceClient.mockReturnValue(sb);
    m.slackFetch.mockRejectedValue(new Error("channel_not_found"));

    const r = await runReminderFireHandler(logger);

    expect(r).toMatchObject({ failed: 1, pinged: 0 });
    expect(updates[0]).toMatchObject({ status: "failed" });
    expect(updates[0].last_error).toContain("channel_not_found");
  });

  it("never leaks the note into the log event (C14 whitelist)", async () => {
    const { sb } = makeSb([SLACK_PING]);
    m.serviceClient.mockReturnValue(sb);
    m.slackFetch.mockRejectedValue(new Error("boom"));

    await runReminderFireHandler(logger);

    const call = m.logEvent.mock.calls[0] as unknown as [{ meta?: Record<string, unknown> }];
    expect(call).toBeDefined();
    const meta = call[0].meta;
    expect(JSON.stringify(meta)).not.toContain("check the ads spend");
    expect(meta).toEqual({ mode: "ping", kind: "once" });
  });

  it("refuses a RUN whose stored target is malformed, rather than enqueuing a run with nowhere to report", async () => {
    const { sb, updates } = makeSb([
      { ...SLACK_PING, mode: "run", deliver: { kind: "slack_thread", channel_id: "nope" } },
    ]);
    m.serviceClient.mockReturnValue(sb);

    const r = await runReminderFireHandler(logger);

    expect(m.enqueueWorkItem).not.toHaveBeenCalled();
    expect(r.failed).toBe(1);
    expect(updates[0]).toMatchObject({ status: "failed" });
  });

  it("skips the whole scan when the fleet is halted", async () => {
    m.isFleetHalted.mockResolvedValue(true);
    const { sb } = makeSb([SLACK_PING]);
    m.serviceClient.mockReturnValue(sb);

    const r = await runReminderFireHandler(logger);

    expect(r).toEqual({ claimed: 0, pinged: 0, enqueued: 0, failed: 0, deferred: 0 });
    expect(sb.rpc).not.toHaveBeenCalled();
  });

  it("claims through the leased RPC, never a bare table read (no double-fire)", async () => {
    const { sb } = makeSb([]);
    m.serviceClient.mockReturnValue(sb);

    await runReminderFireHandler(logger);

    expect(sb.rpc).toHaveBeenCalledWith("claim_due_reminders", { p_limit: 50 });
  });
});

describe("reminder-wait (the sleeper)", () => {
  it("claims only ITS reminder by id, and delivers it", async () => {
    const { sb, updates } = makeSb([SLACK_PING]);
    m.serviceClient.mockReturnValue(sb);

    const r = await runReminderWaitHandler("r1", logger);

    expect(sb.rpc).toHaveBeenCalledWith("claim_reminder_by_id", { p_reminder_id: "r1" });
    expect(r).toMatchObject({ claimed: 1, pinged: 1 });
    expect(m.slackFetch).toHaveBeenCalled();
    expect(updates[0]).toMatchObject({ status: "fired" });
  });

  it("wakes to NOTHING when the reminder was cancelled while it slept", async () => {
    const { sb, updates } = makeSb([]);
    m.serviceClient.mockReturnValue(sb);

    const r = await runReminderWaitHandler("r1", logger);

    expect(r).toEqual({ claimed: 0, pinged: 0, enqueued: 0, failed: 0, deferred: 0 });
    expect(m.slackFetch).not.toHaveBeenCalled();
    expect(m.enqueueWorkItem).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it("defers to the sweep instead of delivering during a fleet halt", async () => {
    m.isFleetHalted.mockResolvedValue(true);
    const { sb } = makeSb([SLACK_PING]);
    m.serviceClient.mockReturnValue(sb);

    const r = await runReminderWaitHandler("r1", logger);

    expect(r.claimed).toBe(0);
    expect(sb.rpc).not.toHaveBeenCalled();
    expect(m.slackFetch).not.toHaveBeenCalled();
  });

  it("arms the NEXT sleeper when a recurring reminder fires (this is what keeps it recurring)", async () => {
    const { sb } = makeSb([
      { ...SLACK_PING, id: "r3", schedule_kind: "recurring", cron_expression: "0 16 * * *" },
    ]);
    m.serviceClient.mockReturnValue(sb);

    await runReminderWaitHandler("r3", logger);

    expect(m.send).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "reminder/scheduled",
        data: expect.objectContaining({ reminder_id: "r3" }),
      }),
    );
  });

  it("does NOT arm another sleeper for a one-off reminder", async () => {
    const { sb } = makeSb([SLACK_PING]);
    m.serviceClient.mockReturnValue(sb);

    await runReminderWaitHandler("r1", logger);

    expect(m.send).not.toHaveBeenCalled();
  });
});

describe("reminder-sweep — draining", () => {
  function makePagingSb(pages: unknown[][]) {
    let i = 0;
    return {
      rpc: vi.fn(async (fn: string) =>
        fn === "claim_due_reminders"
          ? { data: i < pages.length ? pages[i++] : [], error: null }
          : { data: null, error: null },
      ),
      from: vi.fn(() => ({
        update: () => updChain({ data: [{ id: "r" }], error: null }),
        select: () => ({
          eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: "th" } }) }) }),
        }),
        insert: async () => ({ error: null }),
      })),
    };
  }

  const row = (id: string) => ({ ...SLACK_PING, id });
  const fullPage = (tag: string) => Array.from({ length: 50 }, (_, n) => row(`${tag}-${n}`));

  it("keeps claiming until a page comes back short", async () => {
    const sb = makePagingSb([fullPage("a"), fullPage("b"), [row("tail")]]);
    m.serviceClient.mockReturnValue(sb);

    const r = await runReminderFireHandler(logger);

    expect(r.claimed).toBe(101);
    expect(r.pinged).toBe(101);
    expect(sb.rpc).toHaveBeenCalledTimes(3);
  });

  it("stops after one claim when the queue is empty", async () => {
    const sb = makePagingSb([[]]);
    m.serviceClient.mockReturnValue(sb);

    const r = await runReminderFireHandler(logger);

    expect(r).toMatchObject({ claimed: 0, pinged: 0, failed: 0 });
    expect(sb.rpc).toHaveBeenCalledTimes(1);
  });

  it("caps a single tick rather than running unbounded", async () => {
    const sb = makePagingSb(Array.from({ length: 40 }, (_, n) => fullPage(`p${n}`)));
    m.serviceClient.mockReturnValue(sb);

    const r = await runReminderFireHandler(logger);

    expect(r.claimed).toBe(1000);
    expect(sb.rpc).toHaveBeenCalledTimes(20);
  });

  it("stops draining on a claim error instead of spinning", async () => {
    const sb = {
      rpc: vi.fn(async () => ({ data: null, error: { message: "boom" } })),
      from: vi.fn(() => ({ update: () => updChain({ data: [{ id: "r" }], error: null }) })),
    };
    m.serviceClient.mockReturnValue(sb);

    const r = await runReminderFireHandler(logger);

    expect(r).toMatchObject({ claimed: 0 });
    expect(sb.rpc).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalled();
  });
});

describe("reminder-fire — chat surfaces and DM", () => {
  const withDeliver = (deliver: unknown) => ({ ...SLACK_PING, deliver });

  it("opens an IM and posts there for a slack_dm target", async () => {
    const { sb } = makeSb([withDeliver({ kind: "slack_dm", slack_user_id: "U1ABC" })]);
    m.serviceClient.mockReturnValue(sb);
    (m.slackFetch as unknown as { mockImplementation: (f: unknown) => void }).mockImplementation(async (_t: string, method: string) =>
      method === "conversations.open" ? { channel: { id: "D9" } } : { ok: true },
    );

    const r = await runReminderFireHandler(logger);

    expect(r).toMatchObject({ pinged: 1, failed: 0 });
    expect(m.slackFetch).toHaveBeenCalledWith("t1", "conversations.open", { users: "U1ABC" }, undefined);
    expect(m.slackFetch).toHaveBeenCalledWith(
      "t1",
      "chat.postMessage",
      expect.objectContaining({ channel: "D9" }),
      undefined,
    );
  });

  it("falls back to the originating thread when the IM cannot be opened", async () => {
    const { sb, updates } = makeSb([
      withDeliver({
        kind: "slack_dm",
        slack_user_id: "U1ABC",
        fallback: { kind: "slack_thread", channel_id: "C1", thread_ts: "1720.100" },
      }),
    ]);
    m.serviceClient.mockReturnValue(sb);
    (m.slackFetch as unknown as { mockImplementation: (f: unknown) => void }).mockImplementation(async (_t: string, method: string) => {
      if (method === "conversations.open") throw new Error("missing_scope");
      return { ok: true };
    });

    const r = await runReminderFireHandler(logger);

    expect(r).toMatchObject({ pinged: 1, failed: 0 });
    expect(m.slackFetch).toHaveBeenCalledWith(
      "t1",
      "chat.postMessage",
      expect.objectContaining({ channel: "C1", thread_ts: "1720.100" }),
      undefined,
    );
    expect(updates[0]).toMatchObject({ status: "fired", last_error: null });
  });

  it("sends the WhatsApp window template when the 24h window has shut", async () => {
    ownNumber("PN1");
    const { sb } = makeSb([
      withDeliver({ kind: "whatsapp", wa_id: "1555", phone_number_id: "PN1" }),
    ]);
    m.serviceClient.mockReturnValue(sb);
    m.postWhatsAppReply.mockResolvedValue({ ok: false, windowClosed: true, sent: 0, error: "window_closed" });

    const r = await runReminderFireHandler(logger);

    expect(m.postWhatsAppWindowTemplate).toHaveBeenCalledWith({ wa_id: "1555" });
    expect(r).toMatchObject({ pinged: 1, failed: 0 });
  });

  it("records a failure when WhatsApp cannot deliver at all", async () => {
    ownNumber("PN1");
    const { sb, updates } = makeSb([
      withDeliver({ kind: "whatsapp", wa_id: "1555", phone_number_id: "PN1" }),
    ]);
    m.serviceClient.mockReturnValue(sb);
    m.postWhatsAppReply.mockResolvedValue({ ok: false, windowClosed: true, sent: 0, error: "window_closed" });
    m.postWhatsAppWindowTemplate.mockResolvedValue({ ok: false, sent: 0, error: "template_not_approved" });

    const r = await runReminderFireHandler(logger);

    expect(r).toMatchObject({ failed: 1 });
    expect(updates[0]).toMatchObject({ status: "failed" });
    expect(String(updates[0].last_error)).toMatch(/template/);
  });

  it("delivers to Telegram and Discord targets", async () => {
    const { sb: sb1 } = makeSb([withDeliver({ kind: "telegram", chat_id: -100123 })]);
    m.serviceClient.mockReturnValue(sb1);
    expect(await runReminderFireHandler(logger)).toMatchObject({ pinged: 1 });
    expect(m.postTelegramReply).toHaveBeenCalledWith(
      expect.objectContaining({ chat_id: -100123 }),
    );

    const { sb: sb2 } = makeSb([withDeliver({ kind: "discord", channel_id: "DC1", guild_id: "G1" })]);
    m.serviceClient.mockReturnValue(sb2);
    expect(await runReminderFireHandler(logger)).toMatchObject({ pinged: 1 });
    expect(m.postDiscordReply).toHaveBeenCalledWith(
      expect.objectContaining({ channel_id: "DC1" }),
    );
  });
});

describe("reminder-fire — cron healing", () => {
  it("rewrites a fractional minute when re-arming a recurring reminder", async () => {
    const { sb, updates } = makeSb([
      {
        ...SLACK_PING,
        schedule_kind: "recurring" as const,
        cron_expression: "0.008049999999911961 16 * * 1",
      },
    ]);
    m.serviceClient.mockReturnValue(sb);

    await runReminderFireHandler(logger);

    expect(updates[0]).toMatchObject({ status: "pending", cron_expression: "0 16 * * 1" });
  });
});

describe("reminder-fire — send-time tenant and host guards", () => {
  const withDeliver = (deliver: unknown) => ({ ...SLACK_PING, deliver });

  it("refuses Telegram when the chat is no longer bound to this tenant", async () => {
    const { sb, updates } = makeSb(
      [withDeliver({ kind: "telegram", chat_id: -100123 })],
      null,
    );
    m.serviceClient.mockReturnValue(sb);

    const r = await runReminderFireHandler(logger);

    expect(m.postTelegramReply).not.toHaveBeenCalled();
    expect(r).toMatchObject({ failed: 1, pinged: 0 });
    expect(String(updates[0].last_error)).toMatch(/no longer an enabled binding/);
  });

  it("leaves a Discord reminder pending when Discord could not be asked (5xx/429)", async () => {
    m.discordChannelMembership.mockResolvedValueOnce("unknown");
    const { sb, updates } = makeSb([
      { ...withDeliver({ kind: "discord", channel_id: "DC1", guild_id: "G1" }), due_at: new Date().toISOString() },
    ]);
    m.serviceClient.mockReturnValue(sb);

    const r = await runReminderFireHandler(logger);

    expect(m.postDiscordReply).not.toHaveBeenCalled();
    expect(r).toMatchObject({ deferred: 1, failed: 0, pinged: 0 });
    expect(updates).toHaveLength(0);
  });

  it("fails a Discord reminder whose channel Discord says is in another guild", async () => {
    m.discordChannelMembership.mockResolvedValueOnce("other");
    const { sb, updates } = makeSb([withDeliver({ kind: "discord", channel_id: "DC1", guild_id: "G1" })]);
    m.serviceClient.mockReturnValue(sb);

    const r = await runReminderFireHandler(logger);

    expect(m.postDiscordReply).not.toHaveBeenCalled();
    expect(r).toMatchObject({ failed: 1 });
    expect(String(updates[0].last_error)).toMatch(/not in this tenant's guild/);
  });

  it("refuses Discord when the guild is no longer bound to this tenant", async () => {
    const { sb } = makeSb(
      [withDeliver({ kind: "discord", channel_id: "DC1", guild_id: "G1" })],
      null,
    );
    m.serviceClient.mockReturnValue(sb);

    const r = await runReminderFireHandler(logger);

    expect(m.postDiscordReply).not.toHaveBeenCalled();
    expect(r).toMatchObject({ failed: 1 });
  });

  it("leaves a WhatsApp reminder pending when this host does not own the number", async () => {
    const env = { ...process.env };
    process.env.WHATSAPP_ACCESS_TOKEN = "tok";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "OTHER_NUMBER";
    process.env.WHATSAPP_APP_SECRET = "sec";
    process.env.WHATSAPP_VERIFY_TOKEN = "vt";
    try {
      const { sb, updates } = makeSb([
        {
          ...withDeliver({ kind: "whatsapp", wa_id: "1555", phone_number_id: "PN1" }),
          due_at: new Date().toISOString(),
        },
      ]);
      m.serviceClient.mockReturnValue(sb);

      const r = await runReminderFireHandler(logger);

      expect(m.postWhatsAppReply).not.toHaveBeenCalled();
      expect(r).toMatchObject({ deferred: 1, failed: 0, pinged: 0 });
      expect(updates).toHaveLength(0);
    } finally {
      process.env = env;
    }
  });

  it("defers on an UNCONFIGURED host too, rather than killing another host's reminder", async () => {
    const env = { ...process.env };
    for (const k of [
      "WHATSAPP_ACCESS_TOKEN",
      "WHATSAPP_PHONE_NUMBER_ID",
      "WHATSAPP_APP_SECRET",
      "WHATSAPP_VERIFY_TOKEN",
    ]) {
      delete process.env[k];
    }
    try {
      const { sb, updates } = makeSb([
        {
          ...withDeliver({ kind: "whatsapp", wa_id: "1555", phone_number_id: "PN1" }),
          due_at: new Date().toISOString(),
        },
      ]);
      m.serviceClient.mockReturnValue(sb);

      const r = await runReminderFireHandler(logger);

      expect(m.postWhatsAppReply).not.toHaveBeenCalled();
      expect(r).toMatchObject({ deferred: 1, failed: 0 });
      expect(updates).toHaveLength(0);
    } finally {
      process.env = env;
    }
  });

  it("stops deferring and fails once nobody has served it for a day", async () => {
    const env = { ...process.env };
    process.env.WHATSAPP_ACCESS_TOKEN = "tok";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "OTHER_NUMBER";
    process.env.WHATSAPP_APP_SECRET = "sec";
    process.env.WHATSAPP_VERIFY_TOKEN = "vt";
    try {
      const { sb, updates } = makeSb([
        {
          ...withDeliver({ kind: "whatsapp", wa_id: "1555", phone_number_id: "PN1" }),
          due_at: new Date(Date.now() - 25 * 3600 * 1000).toISOString(),
        },
      ]);
      m.serviceClient.mockReturnValue(sb);

      const r = await runReminderFireHandler(logger);

      expect(r).toMatchObject({ failed: 1, deferred: 0 });
      expect(updates[0]).toMatchObject({ status: "failed" });
      expect(String(updates[0].last_error)).toMatch(/within 24h/);
    } finally {
      process.env = env;
    }
  });
});

describe("reminder-fire — RUN mode ownership", () => {
  const WA_RUN = {
    ...SLACK_PING,
    mode: "run" as const,
    due_at: new Date().toISOString(),
    deliver: { kind: "whatsapp", wa_id: "1555", phone_number_id: "PN1" },
  };

  it("does not enqueue — or close out — a WhatsApp RUN this host cannot deliver", async () => {
    ownNumber("SOME_OTHER_NUMBER");
    const { sb, updates } = makeSb([WA_RUN]);
    m.serviceClient.mockReturnValue(sb);

    const r = await runReminderFireHandler(logger);

    expect(m.enqueueWorkItem).not.toHaveBeenCalled();
    expect(r).toMatchObject({ deferred: 1, enqueued: 0, failed: 0 });
    expect(updates).toHaveLength(0);
  });

  it("enqueues normally on the host that owns the number", async () => {
    ownNumber("PN1");
    const { sb } = makeSb([WA_RUN]);
    m.serviceClient.mockReturnValue(sb);

    const r = await runReminderFireHandler(logger);

    expect(m.enqueueWorkItem).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ enqueued: 1, deferred: 0 });
  });

  it("a deferred page cannot be re-claimed by the same sweep", async () => {
    ownNumber("SOME_OTHER_NUMBER");
    const page = Array.from({ length: 50 }, (_, n) => ({ ...WA_RUN, id: `wa-${n}` }));
    let served = 0;
    const sb = {
      rpc: vi.fn(async () => ({ data: served++ === 0 ? page : [], error: null })),
      from: vi.fn(() => ({ update: () => updChain({ data: [{ id: "r" }], error: null }) })),
    };
    m.serviceClient.mockReturnValue(sb);

    const r = await runReminderFireHandler(logger);

    expect(r).toMatchObject({ deferred: 50, enqueued: 0, failed: 0 });
    expect(sb.rpc).toHaveBeenCalledTimes(2);
  });
});

describe("reminder-fire: recurring run needs a paid plan at fire time", () => {
  const RECURRING_RUN = {
    ...SLACK_PING,
    id: "rr",
    mode: "run" as const,
    schedule_kind: "recurring" as const,
    cron_expression: "0 16 * * 1",
  };

  it("Free now: no run is enqueued and the reminder is cancelled (not re-armed)", async () => {
    m.resolveTenantTier.mockResolvedValue("free");
    const { sb, updates } = makeSb([RECURRING_RUN]);
    m.serviceClient.mockReturnValue(sb);
    await runReminderFireHandler(logger);
    expect(m.enqueueWorkItem).not.toHaveBeenCalled();
    expect(updates).toEqual([{ status: "cancelled", last_error: "plan_upgrade_required", lease_until: null }]);
    expect(m.send).not.toHaveBeenCalled();
  });

  it("deferred tier config (swallowed read error): not cancelled, no run, re-armed", async () => {
    m.tierConfig.mockReturnValueOnce({ enforced: false, agentMin: {}, proTenants: [], deferred: true });
    m.resolveTenantTier.mockResolvedValue("free");
    const { sb, updates } = makeSb([RECURRING_RUN]);
    m.serviceClient.mockReturnValue(sb);
    await runReminderFireHandler(logger);
    expect(m.enqueueWorkItem).not.toHaveBeenCalled();
    expect(updates[0]).toMatchObject({ status: "pending" });
    expect(updates).not.toContainEqual(expect.objectContaining({ status: "cancelled" }));
  });

  it("plan unreadable: fail closed (no run), re-armed for the next fire", async () => {
    m.resolveTenantTier.mockRejectedValue(new Error("db down"));
    const { sb, updates } = makeSb([RECURRING_RUN]);
    m.serviceClient.mockReturnValue(sb);
    await runReminderFireHandler(logger);
    expect(m.enqueueWorkItem).not.toHaveBeenCalled();
    expect(updates[0]).toMatchObject({ status: "pending" });
  });

  it("Starter: enqueued as before; a one-off run on Free is not re-checked", async () => {
    const { sb } = makeSb([RECURRING_RUN]);
    m.serviceClient.mockReturnValue(sb);
    await runReminderFireHandler(logger);
    expect(m.enqueueWorkItem).toHaveBeenCalledTimes(1);
    m.resolveTenantTier.mockResolvedValue("free");
    const { sb: sb2 } = makeSb([{ ...SLACK_PING, id: "once", mode: "run" }]);
    m.serviceClient.mockReturnValue(sb2);
    await runReminderFireHandler(logger);
    expect(m.enqueueWorkItem).toHaveBeenCalledTimes(2);
  });
});

describe("reminder-fire: email to the reminder's creator", () => {
  const CHAT_PING = {
    ...SLACK_PING,
    created_by: "u-creator",
    deliver: { kind: "chat_thread", thread_id: "11111111-2222-3333-4444-555555555555" },
  };

  it("sends no email when the fire could not be saved, so the re-fire does not email twice", async () => {
    const { sb } = makeSb([CHAT_PING], undefined, { message: "db down" });
    m.serviceClient.mockReturnValue(sb);

    await runReminderWaitHandler("r1", logger);

    expect(m.sendReminderEmail).not.toHaveBeenCalled();
  });

  it("still emails a recurring reminder when scheduling its next fire fails", async () => {
    const { sb, updates } = makeSb([{ ...CHAT_PING, schedule_kind: "recurring", cron_expression: "0 16 * * *" }]);
    m.serviceClient.mockReturnValue(sb);
    m.send.mockRejectedValueOnce(new Error("inngest down"));

    await runReminderWaitHandler("r1", logger);

    expect(updates[0]).toMatchObject({ status: "pending" });
    expect(m.sendReminderEmail).toHaveBeenCalledTimes(1);
  });

  it("the sweep closes out every row on a page before it sends any email", async () => {
    const { sb, updates } = makeSb([CHAT_PING, { ...CHAT_PING, id: "r2" }]);
    m.serviceClient.mockReturnValue(sb);
    const updatesAtEachSend: number[] = [];
    m.sendReminderEmail.mockImplementation(async () => {
      updatesAtEachSend.push(updates.length);
      return { sent: true };
    });

    await runReminderFireHandler(logger);

    expect(updates).toHaveLength(2);
    expect(updatesAtEachSend).toEqual([2, 2]);
  });

  it("emails the creator the note when a PING fires, and still posts to the thread", async () => {
    const { sb, updates } = makeSb([CHAT_PING]);
    m.serviceClient.mockReturnValue(sb);

    const r = await runReminderWaitHandler("r1", logger);

    expect(r).toMatchObject({ pinged: 1, failed: 0 });
    expect(m.sendReminderEmail).toHaveBeenCalledTimes(1);
    expect(m.sendReminderEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: "t1",
        created_by: "u-creator",
        mode: "ping",
        note: "check the ads spend",
        deliver: CHAT_PING.deliver,
      }), expect.anything());
    expect(updates[0]).toMatchObject({ status: "fired" });
  });

  it("a failed or throwing email changes nothing: thread delivery happens and the reminder is marked fired", async () => {
    for (const failure of [
      () => m.sendReminderEmail.mockResolvedValue({ sent: false, reason: "send_failed: 403" }),
      () => m.sendReminderEmail.mockRejectedValue(new Error("sendgrid down")),
    ]) {
      const inserts: unknown[] = [];
      const { sb, updates } = makeSb([CHAT_PING]);
      const baseFrom = sb.from;
      sb.from = vi.fn((table: string) => {
        const t = baseFrom(table) as Record<string, unknown>;
        if (table === "agent_thread_messages") {
          t.insert = async (row: unknown) => {
            inserts.push(row);
            return { error: null };
          };
        }
        return t;
      }) as unknown as typeof sb.from;
      m.serviceClient.mockReturnValue(sb);
      failure();

      const r = await runReminderWaitHandler("r1", logger);

      expect(r).toMatchObject({ claimed: 1, pinged: 1, failed: 0 });
      expect(inserts).toHaveLength(1);
      expect(updates[0]).toMatchObject({ status: "fired", last_error: null });
    }
  });

  it("passes the Slack requester and its stored team through for a Slack-origin reminder", async () => {
    const deliver = { kind: "slack_thread", channel_id: "C1", thread_ts: "1720.100", team_id: "T1" };
    const { sb } = makeSb([{ ...SLACK_PING, deliver, created_by: null, slack_user_id: "U123" }]);
    m.serviceClient.mockReturnValue(sb);

    await runReminderWaitHandler("r1", logger);

    expect(m.sendReminderEmail).toHaveBeenCalledWith(
      expect.objectContaining({ created_by: null, slack_user_id: "U123", mode: "ping", deliver }), expect.anything());
  });

  const LEASE = "2026-07-13T12:03:00.123456+00:00";

  it("fences the close-out on the lease this worker claimed", async () => {
    const { sb, filters } = makeSb([{ ...CHAT_PING, lease_until: LEASE }]);
    m.serviceClient.mockReturnValue(sb);

    await runReminderWaitHandler("r1", logger);

    expect(filters).toContainEqual(["eq", "id", "r1"]);
    expect(filters).toContainEqual(["eq", "lease_until", LEASE]);
    expect(m.sendReminderEmail).toHaveBeenCalledTimes(1);
  });

  it("a worker whose lease lapsed sends no email (the new owner sends the only one)", async () => {
    for (const row of [
      { ...CHAT_PING, lease_until: LEASE },
      { ...CHAT_PING, lease_until: LEASE, schedule_kind: "recurring", cron_expression: "0 16 * * *" },
    ]) {
      vi.clearAllMocks();
      const { sb, updates } = makeSb([row], undefined, null, false);
      m.serviceClient.mockReturnValue(sb);

      const r = await runReminderWaitHandler("r1", logger);

      expect(r.pinged).toBe(1);
      expect(updates).toHaveLength(1);
      expect(m.sendReminderEmail).not.toHaveBeenCalled();
      expect(m.send).not.toHaveBeenCalled();
    }
  });

  it("two workers on one row: only the lease holder emails", async () => {
    const row = { ...CHAT_PING, lease_until: LEASE };
    const stale = makeSb([row], undefined, null, false);
    m.serviceClient.mockReturnValue(stale.sb);
    await runReminderWaitHandler("r1", logger);
    const owner = makeSb([{ ...row, lease_until: "2026-07-13T12:05:00+00:00" }]);
    m.serviceClient.mockReturnValue(owner.sb);
    await runReminderWaitHandler("r1", logger);

    expect(m.sendReminderEmail).toHaveBeenCalledTimes(1);
  });

  it("a timed-out email send still leaves the reminder fired, and is logged", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    m.sendReminderEmail.mockResolvedValue({ sent: false, reason: "send_timeout" });
    const { sb, updates } = makeSb([{ ...CHAT_PING, lease_until: LEASE }]);
    m.serviceClient.mockReturnValue(sb);

    const r = await runReminderWaitHandler("r1", logger);

    expect(r).toMatchObject({ claimed: 1, pinged: 1, failed: 0 });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ status: "fired", last_error: null });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("send_timeout"));
    warn.mockRestore();
  });

  it("emails a RUN reminder once its run is enqueued", async () => {
    const { sb } = makeSb([{ ...CHAT_PING, mode: "run" }]);
    m.serviceClient.mockReturnValue(sb);

    const r = await runReminderWaitHandler("r1", logger);

    expect(r.enqueued).toBe(1);
    expect(m.sendReminderEmail).toHaveBeenCalledWith(expect.objectContaining({ mode: "run" }), expect.anything());
  });

  it("does not email a RUN that never enqueued (malformed target), nor a deferred reminder", async () => {
    const { sb } = makeSb([{ ...CHAT_PING, mode: "run", deliver: { kind: "slack_thread", channel_id: "nope" } }]);
    m.serviceClient.mockReturnValue(sb);
    await runReminderWaitHandler("r1", logger);
    expect(m.sendReminderEmail).not.toHaveBeenCalled();

    const { sb: sb2 } = makeSb([
      {
        ...CHAT_PING,
        due_at: new Date().toISOString(),
        deliver: { kind: "whatsapp", wa_id: "1555", phone_number_id: "not-ours" },
      },
    ]);
    m.serviceClient.mockReturnValue(sb2);
    const r2 = await runReminderWaitHandler("r1", logger);
    expect(r2.deferred).toBe(1);
    expect(m.sendReminderEmail).not.toHaveBeenCalled();
  });
});
