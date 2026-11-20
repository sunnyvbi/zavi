
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const m = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  tg: vi.fn(async (_a: unknown) => ({ ok: true })),
  dc: vi.fn(async (_a: unknown) => ({ ok: true })),
  channelGuild: {} as Record<string, string>,
}));

function query(table: string) {
  const filters: Array<(r: Row) => boolean> = [];
  const run = () => (m.tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
  const b = {
    select: () => b,
    eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
    maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
  };
  return b;
}

vi.mock("@/services/supabase", () => ({ serviceClient: () => ({ from: (t: string) => query(t) }) }));
vi.mock("@/agents/index", () => ({ dispatchers: {} }));
vi.mock("@/services/tools/telegram/_client", () => ({ postTelegramReply: (a: unknown) => m.tg(a) }));
vi.mock("@/services/tools/discord/_client", () => ({ postDiscordReply: (a: unknown) => m.dc(a) }));
vi.mock("@/services/tools/slack/_client", () => ({ slackFetch: vi.fn() }));
vi.mock("@/services/tools/whatsapp/_client", () => ({ postWhatsAppReply: vi.fn(), postWhatsAppWindowTemplate: vi.fn() }));
vi.mock("@/services/connectors/whatsapp/adapter", () => ({ whatsappOwnsNumber: () => false }));
vi.mock("@/services/connectors/discord/adapter", () => ({
  discordChannelInGuild: async (c: string, g: string) => m.channelGuild[c] === g,
  discordChannelMembership: async (c: string, g: string) =>
    m.channelGuild[c] === "__down__" ? "unknown" : m.channelGuild[c] === g ? "in" : "other",
}));

import { deliverCustomAgentResult, defaultCustomDeliveryDeps } from "../custom-agent-runs";
import { customDeliverSchema } from "../custom-agents";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";

const send = async (deliver: unknown, tenant_id = T1) =>
  deliverCustomAgentResult(
    { tenant_id, run_id: "run-1", agent_name: "Standup", deliver: deliver as never, text: "hello" },
    await defaultCustomDeliveryDeps((t) => t),
  );

beforeEach(() => {
  m.tg.mockClear();
  m.dc.mockClear();
  m.tables = {
    telegram_chats: [{ chat_id: 424242, tenant_id: T1, status: "enabled" }],
    discord_guilds: [{ guild_id: "G1", tenant_id: T1, status: "enabled" }],
  };
  m.channelGuild = { D1: "G1", FOREIGN: "G-OTHER", DOWN: "__down__" };
});

describe("customDeliverSchema: telegram + discord", () => {
  it("accepts the reminder shapes and rejects extra fields", () => {
    expect(customDeliverSchema.safeParse({ kind: "telegram", chat_id: 424242 }).success).toBe(true);
    expect(customDeliverSchema.safeParse({ kind: "discord", channel_id: "D1", guild_id: "G1" }).success).toBe(true);
    expect(customDeliverSchema.safeParse({ kind: "discord", channel_id: "D1" }).success).toBe(false);
    expect(customDeliverSchema.safeParse({ kind: "telegram", chat_id: 1, bot_token: "x" }).success).toBe(false);
  });
});

describe("deliverCustomAgentResult via the reminder senders", () => {
  it("telegram: sends on the tenant's bound chat", async () => {
    expect(await send({ kind: "telegram", chat_id: 424242 })).toBeNull();
    expect(m.tg).toHaveBeenCalledWith({ chat_id: 424242, text: "hello" });
  });

  it("discord: sends in the tenant's bound guild", async () => {
    expect(await send({ kind: "discord", channel_id: "D1", guild_id: "G1" })).toBeNull();
    expect(m.dc).toHaveBeenCalledWith({ channel_id: "D1", text: "hello" });
  });

  it("telegram: a chat bound to ANOTHER tenant is rejected, nothing sent", async () => {
    expect(await send({ kind: "telegram", chat_id: 424242 }, T2)).toMatch(/no longer an enabled binding/);
    expect(m.tg).not.toHaveBeenCalled();
  });

  it("discord: own guild + a channel from ANOTHER guild is rejected at send, nothing sent", async () => {
    expect(await send({ kind: "discord", channel_id: "FOREIGN", guild_id: "G1" })).toMatch(/not in this tenant's guild/);
    expect(m.dc).not.toHaveBeenCalled();
  });

  it("discord: a failed channel lookup is transient (not a cross-tenant refusal), nothing sent", async () => {
    expect(await send({ kind: "discord", channel_id: "DOWN", guild_id: "G1" })).toMatch(/^__transient__:/);
    expect(m.dc).not.toHaveBeenCalled();
  });

  it("discord: a guild bound to ANOTHER tenant is rejected, nothing sent", async () => {
    expect(await send({ kind: "discord", channel_id: "D1", guild_id: "G1" }, T2)).toMatch(/no longer an enabled binding/);
    expect(m.dc).not.toHaveBeenCalled();
  });
});

describe("reminders share the Discord sender, so they get the same channel check", () => {
  it("a reminder to own guild + a foreign channel is refused, nothing sent", async () => {
    const { reminderDeliveryDeps } = await import("../reminder-delivery-deps");
    const deps = reminderDeliveryDeps({ scrub: (t) => t });
    const err = await deps.postToDiscord!({ tenant_id: T1, channel_id: "FOREIGN", guild_id: "G1", text: "ping" });
    expect(err).toMatch(/not in this tenant's guild/);
    expect(m.dc).not.toHaveBeenCalled();
  });
});
