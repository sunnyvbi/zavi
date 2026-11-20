
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { rpcMock, fromMock, state } = vi.hoisted(() => {
  const s = {
    memberRole: "admin" as string | null,
    chatCount: 0 as number | null,
    rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
    live: null as null | { token: string; expires_in: number },
  };
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    s.rpcCalls.push({ fn, args });
    if (fn.startsWith("live_")) return { data: s.live ? [s.live] : [], error: null };
    return { data: null, error: null };
  });
  const from = vi.fn(() => {
    const builder: Record<string, unknown> = {};
    builder.select = vi.fn(() => builder);
    builder.eq = vi.fn(() => builder);
    builder.count = s.chatCount;
    builder.maybeSingle = vi.fn(async () =>
      s.memberRole === null
        ? { data: null, error: null }
        : { data: { role: s.memberRole }, error: null },
    );
    return builder;
  });
  return { rpcMock: rpc, fromMock: from, state: s };
});

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ rpc: rpcMock, from: fromMock }),
}));
vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async () => ({ user_id: "u-1", tenant_id: "t-1" })),
}));
vi.mock("@/services/logging/logEvent", () => ({
  logEvent: vi.fn(async () => {}),
}));

import { telegramLink, telegramStatus, telegramDisconnect } from "@/routes/connectors/telegram";

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

const req = (body: Record<string, unknown> = {}) => ({ body, headers: {} }) as never;

describe("POST /api/connectors/telegram/link: reuse of a live link", () => {
  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = "123:fake";
    process.env.TELEGRAM_WEBHOOK_SECRET = "s3cret";
    process.env.TELEGRAM_BOT_USERNAME = "zavi_bot";
    state.memberRole = "admin";
    state.rpcCalls.length = 0;
    state.live = null;
  });
  afterEach(() => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    delete process.env.TELEGRAM_BOT_USERNAME;
  });

  it("opening a panel hands back the caller's own live token and does NOT mint (so the old link keeps working)", async () => {
    state.live = { token: "LIVE123", expires_in: 600 };
    const r = res();
    await telegramLink(req(), r as never);
    expect(r.statusCode).toBe(200);
    const lookup = state.rpcCalls.find((c) => c.fn === "live_telegram_link_token");
    expect(lookup?.args).toMatchObject({ p_tenant_id: "t-1", p_minted_by: "u-1", p_min_seconds: 300 });
    expect(state.rpcCalls.some((c) => c.fn === "create_telegram_link_token")).toBe(false);
    expect(r.body).toMatchObject({ dm_url: "https://t.me/zavi_bot?start=LIVE123", expires_in: 600 });
  });

  it("an explicit new link ({fresh:true}) skips the lookup and mints", async () => {
    state.live = { token: "LIVE123", expires_in: 600 };
    const r = res();
    await telegramLink(req({ fresh: true }), r as never);
    expect(state.rpcCalls.some((c) => c.fn === "live_telegram_link_token")).toBe(false);
    expect(state.rpcCalls.some((c) => c.fn === "create_telegram_link_token")).toBe(true);
  });

  it("a member is refused before any lookup", async () => {
    state.memberRole = "member";
    state.live = { token: "LIVE123", expires_in: 600 };
    const r = res();
    await telegramLink(req(), r as never);
    expect(r.statusCode).toBe(403);
    expect(state.rpcCalls.length).toBe(0);
  });
});

describe("POST /api/connectors/telegram/link", () => {
  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = "123:fake";
    process.env.TELEGRAM_WEBHOOK_SECRET = "s3cret";
    process.env.TELEGRAM_BOT_USERNAME = "zavi_bot";
    state.memberRole = "admin";
    state.rpcCalls.length = 0;
    state.live = null;
  });
  afterEach(() => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    delete process.env.TELEGRAM_BOT_USERNAME;
  });

  it("503s (safe-inert) when the surface is off", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    const r = res();
    await telegramLink(req(), r as never);
    expect(r.statusCode).toBe(503);
    expect(state.rpcCalls.length).toBe(0);
  });

  it("503s when TELEGRAM_BOT_USERNAME is unset (deep links need it; so does group gating)", async () => {
    delete process.env.TELEGRAM_BOT_USERNAME;
    const r = res();
    await telegramLink(req(), r as never);
    expect(r.statusCode).toBe(503);
    expect((r.body as { error: { code: string } }).error.code).toBe("telegram_username_missing");
  });

  it("403s a non-admin member — minting the connect capability is an admin action", async () => {
    state.memberRole = "member";
    const r = res();
    await telegramLink(req(), r as never);
    expect(r.statusCode).toBe(403);
    expect(state.rpcCalls.length).toBe(0);
  });

  it("mints a single-use token for the SESSION tenant and returns t.me deep links", async () => {
    const r = res();
    await telegramLink(req(), r as never);
    expect(r.statusCode).toBe(200);

    const mint = state.rpcCalls.find((c) => c.fn === "create_telegram_link_token");
    expect(mint).toBeTruthy();
    expect(mint?.args.p_tenant_id).toBe("t-1");
    expect(mint?.args.p_minted_by).toBe("u-1");
    const token = String(mint?.args.p_token);
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);

    const body = r.body as { dm_url: string; group_url: string; expires_in: number };
    expect(body.dm_url).toBe(`https://t.me/zavi_bot?start=${token}`);
    expect(body.group_url).toBe(`https://t.me/zavi_bot?startgroup=${token}`);
    expect(body.expires_in).toBe(900);
  });
});

describe("GET /api/connectors/telegram/status", () => {
  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = "123:fake";
    process.env.TELEGRAM_WEBHOOK_SECRET = "s3cret";
    fromMock.mockClear();
  });
  afterEach(() => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    state.chatCount = 0;
  });

  it("reports configured:false + connected:false without touching the DB when the surface is off", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    const r = res();
    await telegramStatus(req(), r as never);
    expect(r.body).toEqual({ configured: false, connected: false, chats: 0 });
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("connected is the live enabled-chat count (telegram_chats), not connector_metadata", async () => {
    state.chatCount = 2;
    const r = res();
    await telegramStatus(req(), r as never);
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ configured: true, connected: true, chats: 2 });
    expect(fromMock).toHaveBeenCalledWith("telegram_chats");
    expect(fromMock).not.toHaveBeenCalledWith("connector_metadata");
  });

  it("zero enabled chats → connected:false (a blocked/kicked bot reads disconnected)", async () => {
    state.chatCount = 0;
    const r = res();
    await telegramStatus(req(), r as never);
    expect(r.body).toEqual({ configured: true, connected: false, chats: 0 });
  });
});

describe("POST /api/connectors/telegram/disconnect", () => {
  beforeEach(() => {
    state.memberRole = "admin";
    state.rpcCalls.length = 0;
  });

  it("403s a non-admin member", async () => {
    state.memberRole = "member";
    const r = res();
    await telegramDisconnect(req(), r as never);
    expect(r.statusCode).toBe(403);
    expect(state.rpcCalls.length).toBe(0);
  });

  it("calls unset_telegram_connection for the session tenant with no chat id", async () => {
    const r = res();
    await telegramDisconnect(req(), r as never);
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatchObject({ ok: true, connected: false });
    const unset = state.rpcCalls.find((c) => c.fn === "unset_telegram_connection");
    expect(unset?.args).toEqual({ p_tenant_id: "t-1", p_chat_id: null });
  });
});
