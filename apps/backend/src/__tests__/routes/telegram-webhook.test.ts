
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { rpcMock, fromMock, enqueueMock, state } = vi.hoisted(() => {
  const s = {
    tenantRow: null as { tenant_id: string; status: string } | null,
    duplicate: false,
    consumeStatus: "ok" as string,
    consumeError: null as string | null,
    enqueueThrow: null as string | null,
    logCalls: [] as Array<Record<string, unknown>>,
    rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
    telegramCalls: [] as Array<{ method: string; params: Record<string, unknown> }>,
  };
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    s.rpcCalls.push({ fn, args });
    if (fn === "consume_telegram_link_token")
      return s.consumeError
        ? { data: null, error: { message: s.consumeError } }
        : { data: s.consumeStatus, error: null };
    return { data: null, error: null };
  });
  const from = vi.fn(() => ({
    select: vi.fn(() => ({
      eq: vi.fn(() => ({
        maybeSingle: vi.fn(async () => ({ data: s.tenantRow, error: null })),
      })),
    })),
    update: vi.fn(() => ({ eq: vi.fn(async () => ({ error: null })) })),
  }));
  return {
    rpcMock: rpc,
    fromMock: from,
    enqueueMock: vi.fn(async (_item: Record<string, unknown>) => {
      if (s.enqueueThrow) throw new Error(s.enqueueThrow);
      return s.duplicate
        ? { duplicate: true as const }
        : { duplicate: false as const, ingested_event_id: "ing-1", work_item_id: "wi-1" };
    }),
    state: s,
  };
});

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ rpc: rpcMock, from: fromMock }),
}));
vi.mock("@/services/logging/logEvent", () => ({
  logEvent: vi.fn(async (e: Record<string, unknown>) => {
    state.logCalls.push(e);
  }),
}));
vi.mock("@/services/agents/work-queue", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/services/agents/work-queue")>();
  return { ...real, ingestAndEnqueueWorkItem: enqueueMock };
});
vi.mock("@/services/connectors/telegram/adapter", async (importOriginal) => {
  const real = await importOriginal<
    typeof import("@/services/connectors/telegram/adapter")
  >();
  return {
    ...real,
    callTelegram: vi.fn(async (method: string, params: Record<string, unknown>) => {
      state.telegramCalls.push({ method, params });
      return { ok: true, result: {} };
    }),
  };
});

import { telegramWebhook } from "@/routes/webhooks/telegram";

function res() {
  const r: Record<string, unknown> & { statusCode: number; body: unknown } = {
    statusCode: 200,
    body: null,
    status(code: number) {
      r.statusCode = code;
      return r;
    },
    json(b: unknown) {
      r.body = b;
      return r;
    },
  };
  return r;
}

function req(body: unknown, secret?: string) {
  return {
    body,
    headers: secret ? { "x-telegram-bot-api-secret-token": secret } : {},
  } as never;
}

const SECRET = "test-webhook-secret";
const TOKEN = "tok_ABCDEFGHIJKLMNOPQRSTUVWXYZ01";

function messageUpdate(over: Record<string, unknown> = {}) {
  return {
    update_id: 1001,
    message: {
      message_id: 7,
      chat: { id: 555, type: "private", first_name: "Aryaan" },
      from: { id: 42, is_bot: false, first_name: "Aryaan", username: "aryaan" },
      text: "what's our CAC this week?",
      ...over,
    },
  };
}

describe("POST /api/webhooks/telegram", () => {
  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = "123:fake";
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    delete process.env.TELEGRAM_BOT_USERNAME;
    state.tenantRow = { tenant_id: "t-1", status: "enabled" };
    state.duplicate = false;
    state.consumeStatus = "ok";
    state.consumeError = null;
    state.enqueueThrow = null;
    state.logCalls.length = 0;
    state.rpcCalls.length = 0;
    state.telegramCalls.length = 0;
    enqueueMock.mockClear();
  });
  afterEach(() => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    delete process.env.TELEGRAM_BOT_USERNAME;
  });

  it("503s (safe-inert) when creds are unset", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    const r = res();
    await telegramWebhook(req(messageUpdate(), SECRET), r as never);
    expect(r.statusCode).toBe(503);
  });

  it("401s on a missing or wrong secret header, does no work", async () => {
    for (const bad of [undefined, "wrong-secret"]) {
      const r = res();
      await telegramWebhook(req(messageUpdate(), bad), r as never);
      expect(r.statusCode).toBe(401);
    }
    expect(state.rpcCalls.length).toBe(0);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("bound chat message → ONE atomic ingest+enqueue with telegram routing + sender identity, then ack", async () => {
    const r = res();
    await telegramWebhook(req(messageUpdate(), SECRET), r as never);
    expect(r.statusCode).toBe(200);

    expect(state.rpcCalls.find((c) => c.fn === "ingest_event")).toBeUndefined();
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    const arg = enqueueMock.mock.calls[0][0];
    expect(arg.tenant_id).toBe("t-1");
    expect(arg.provider).toBe("telegram");
    expect(arg.external_event_id).toBe("1001");
    expect(arg.event_type).toBe("message");
    expect(arg.ingest_payload).toBeTruthy();
    expect(arg.agent_slug).toBe("operator");
    expect(arg.source).toBe("webhook_telegram");
    expect(arg.dedupe_key).toBe("telegram:1001");

    const ack = state.telegramCalls.find((c) => c.method === "sendMessage");
    expect(String(ack?.params.text)).toMatch(/^On it/);
    expect(ack?.params.chat_id).toBe(555);
    const tg = (arg.payload as { telegram: Record<string, unknown> }).telegram;
    expect(tg.chat_id).toBe(555);
    expect(tg.message_id).toBe(7);
    expect(tg.text).toBe("what's our CAC this week?");
    expect(tg.from_user_id).toBe(42);
    expect(tg.from_username).toBe("aryaan");
  });

  it("redelivered update (server-side duplicate) → no second 'On it' ack", async () => {
    state.duplicate = true;
    const r = res();
    await telegramWebhook(req(messageUpdate(), SECRET), r as never);
    expect(r.statusCode).toBe(200);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(state.telegramCalls.find((c) => c.method === "sendMessage")).toBeUndefined();
  });

  it("unbound chat message → fail closed (no ingest, no enqueue, still 200)", async () => {
    state.tenantRow = null;
    const r = res();
    await telegramWebhook(req(messageUpdate(), SECRET), r as never);
    expect(r.statusCode).toBe(200);
    expect(state.rpcCalls.find((c) => c.fn === "ingest_event")).toBeUndefined();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("/start <token> → consume_telegram_link_token with chat + Telegram sender identity, success reply", async () => {
    state.tenantRow = null;
    const r = res();
    await telegramWebhook(req(messageUpdate({ text: `/start ${TOKEN}` }), SECRET), r as never);
    expect(r.statusCode).toBe(200);

    const consume = state.rpcCalls.find((c) => c.fn === "consume_telegram_link_token");
    expect(consume).toBeTruthy();
    expect(consume?.args.p_token).toBe(TOKEN);
    expect(consume?.args.p_chat_id).toBe(555);
    expect(consume?.args.p_tg_user_id).toBe(42);
    expect(consume?.args.p_tg_username).toBe("aryaan");

    const reply = state.telegramCalls.find((c) => c.method === "sendMessage");
    expect(String(reply?.params.text)).toContain("Connected");
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("/start with an invalid/expired token → error reply, nothing bound, no run", async () => {
    state.tenantRow = null;
    state.consumeStatus = "invalid_or_expired";
    const r = res();
    await telegramWebhook(req(messageUpdate({ text: `/start ${TOKEN}` }), SECRET), r as never);
    const reply = state.telegramCalls.find((c) => c.method === "sendMessage");
    expect(String(reply?.params.text)).toMatch(/invalid or has expired/i);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("/start <token> for a chat bound to ANOTHER tenant → refusal reply + audit log, nothing rebound", async () => {
    state.consumeStatus = "chat_already_bound";
    const r = res();
    await telegramWebhook(req(messageUpdate({ text: `/start ${TOKEN}` }), SECRET), r as never);
    const reply = state.telegramCalls.find((c) => c.method === "sendMessage");
    expect(String(reply?.params.text)).toMatch(/already connected to a different/i);
    const log = state.logCalls.find((l) => l.code === "telegram_bind_cross_tenant_refused");
    expect(log).toBeTruthy();
    expect((log?.meta as Record<string, unknown>).chat_id).toBe(555);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("/start <token> when the bind RPC errors → the tapper is told, not left in silence", async () => {
    state.consumeError = "connection reset";
    const r = res();
    await telegramWebhook(req(messageUpdate({ text: `/start ${TOKEN}` }), SECRET), r as never);
    expect(r.statusCode).toBe(200);
    const reply = state.telegramCalls.find((c) => c.method === "sendMessage");
    expect(String(reply?.params.text)).toMatch(/something went wrong/i);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("intake throw (fleet halt / RPC error) → user told it failed, still 200, no 'On it'", async () => {
    state.enqueueThrow = "fleet halted";
    const r = res();
    await telegramWebhook(req(messageUpdate(), SECRET), r as never);
    expect(r.statusCode).toBe(200);
    const msgs = state.telegramCalls.filter((c) => c.method === "sendMessage");
    expect(msgs).toHaveLength(1);
    expect(String(msgs[0].params.text)).toMatch(/didn't go through/i);
  });

  it("bare /start → Settings instructions only; NOTHING is minted webhook-side", async () => {
    state.tenantRow = null;
    const r = res();
    await telegramWebhook(req(messageUpdate({ text: "/start" }), SECRET), r as never);
    expect(r.statusCode).toBe(200);

    expect(state.rpcCalls.map((c) => c.fn)).not.toContain("create_telegram_pending_binding");
    expect(state.rpcCalls.map((c) => c.fn)).not.toContain("consume_telegram_link_token");

    const reply = state.telegramCalls.find((c) => c.method === "sendMessage");
    expect(String(reply?.params.text)).toContain("zaviagent.com/workspace?tab=settings");
    expect(String(reply?.params.text)).not.toMatch(/telegram_bind=/);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("a word merely PREFIXED by /start is a normal task, not the bind branch", async () => {
    const r = res();
    await telegramWebhook(req(messageUpdate({ text: "/started the migration, now what?" }), SECRET), r as never);
    expect(r.statusCode).toBe(200);
    expect(state.rpcCalls.map((c) => c.fn)).not.toContain("consume_telegram_link_token");
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    const item = enqueueMock.mock.calls[0][0] as {
      payload: { telegram: { text: string } };
    };
    expect(item.payload.telegram.text).toBe("/started the migration, now what?");
  });

  it("media caption is the task text (screenshot + 'fix this' class)", async () => {
    const r = res();
    await telegramWebhook(
      req(
        messageUpdate({
          text: undefined,
          caption: "can you fix this issue",
          photo: [{ file_id: "f1" }],
        }),
        SECRET,
      ),
      r as never,
    );
    const arg = enqueueMock.mock.calls[0][0];
    expect((arg.payload as { telegram: { text: string } }).telegram.text).toBe(
      "can you fix this issue",
    );
  });

  it("media with no caption → no run, no dangling ingest row, and the user is told why", async () => {
    const r = res();
    await telegramWebhook(
      req(messageUpdate({ text: undefined, photo: [{ file_id: "f1" }] }), SECRET),
      r as never,
    );
    expect(r.statusCode).toBe(200);
    expect(enqueueMock).not.toHaveBeenCalled();
    const reply = state.telegramCalls.find((c) => c.method === "sendMessage");
    expect(String(reply?.params.text)).toMatch(/can't read images or attachments/i);
    expect(reply?.params.reply_to_message_id).toBe(7);
  });

  it("empty text with NO media (e.g. bare mention) → silent skip, no media reply", async () => {
    process.env.TELEGRAM_BOT_USERNAME = "zavi_bot";
    const r = res();
    await telegramWebhook(
      req(
        messageUpdate({
          chat: { id: -100, type: "supergroup", title: "Ops" },
          text: "@zavi_bot",
          entities: [{ type: "mention", offset: 0, length: 9 }],
        }),
        SECRET,
      ),
      r as never,
    );
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(state.telegramCalls.find((c) => c.method === "sendMessage")).toBeUndefined();
  });

  it("group message is DROPPED when TELEGRAM_BOT_USERNAME is unset (hard fail-closed gate)", async () => {
    const r = res();
    await telegramWebhook(
      req(messageUpdate({ chat: { id: -100, type: "supergroup", title: "Ops" } }), SECRET),
      r as never,
    );
    expect(r.statusCode).toBe(200);
    expect(state.rpcCalls.find((c) => c.fn === "ingest_event")).toBeUndefined();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("group message without a mention is ignored; with the @mention it runs, mention stripped", async () => {
    process.env.TELEGRAM_BOT_USERNAME = "zavi_bot";
    const r = res();
    await telegramWebhook(
      req(messageUpdate({ chat: { id: -100, type: "supergroup", title: "Ops" } }), SECRET),
      r as never,
    );
    expect(enqueueMock).not.toHaveBeenCalled();

    const r2 = res();
    await telegramWebhook(
      req(
        messageUpdate({
          chat: { id: -100, type: "supergroup", title: "Ops" },
          text: "@zavi_bot ship the fix",
          entities: [{ type: "mention", offset: 0, length: 9 }],
        }),
        SECRET,
      ),
      r2 as never,
    );
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    const arg = enqueueMock.mock.calls[0][0];
    expect((arg.payload as { telegram: { text: string } }).telegram.text).toBe("ship the fix");
  });

  it("a reply to a DIFFERENT bot does not wake Zavi; a reply to THIS bot does", async () => {
    process.env.TELEGRAM_BOT_USERNAME = "zavi_bot";
    const group = { chat: { id: -100, type: "supergroup", title: "Ops" } };

    const r = res();
    await telegramWebhook(
      req(
        messageUpdate({
          ...group,
          text: "yes do that",
          reply_to_message: { from: { id: 900, is_bot: true, username: "other_bot" } },
        }),
        SECRET,
      ),
      r as never,
    );
    expect(enqueueMock).not.toHaveBeenCalled();

    const r2 = res();
    await telegramWebhook(
      req(
        messageUpdate({
          ...group,
          text: "yes do that",
          reply_to_message: { from: { id: 901, is_bot: true, username: "Zavi_Bot" } },
        }),
        SECRET,
      ),
      r2 as never,
    );
    expect(enqueueMock).toHaveBeenCalledTimes(1);
  });

  it("bot kicked (my_chat_member) → unset_telegram_connection for that chat (clears the tile when it was the last)", async () => {
    state.tenantRow = { tenant_id: "t-1", status: "enabled" };
    state.rpcCalls.length = 0;
    const r = res();
    await telegramWebhook(
      req(
        {
          update_id: 1002,
          my_chat_member: {
            chat: { id: 555, type: "private" },
            new_chat_member: { status: "kicked", user: { id: 999, is_bot: true } },
          },
        },
        SECRET,
      ),
      r as never,
    );
    expect(r.statusCode).toBe(200);
    const unset = state.rpcCalls.find((c) => c.fn === "unset_telegram_connection");
    expect(unset?.args).toEqual({ p_tenant_id: null, p_chat_id: 555 });
  });

  it("messages authored by a bot never wake the fleet (bot-to-bot loop guard)", async () => {
    state.tenantRow = { tenant_id: "t-1", status: "enabled" };
    enqueueMock.mockClear();
    const r = res();
    await telegramWebhook(
      req(
        {
          update_id: 1003,
          message: {
            message_id: 77,
            chat: { id: 555, type: "private" },
            from: { id: 900, is_bot: true, username: "other_bot" },
            text: "what's our CAC?",
          },
        },
        SECRET,
      ),
      r as never,
    );
    expect(r.statusCode).toBe(200);
    expect(enqueueMock).not.toHaveBeenCalled();
  });
});
