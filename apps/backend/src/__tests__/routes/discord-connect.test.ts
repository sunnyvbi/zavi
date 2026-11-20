
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { rpcMock, fromMock, state } = vi.hoisted(() => {
  const s = {
    memberRole: "admin" as string | null,
    rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  };
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    s.rpcCalls.push({ fn, args });
    return { data: null, error: null };
  });
  const from = vi.fn(() => {
    const builder: Record<string, unknown> = {};
    builder.select = vi.fn(() => builder);
    builder.eq = vi.fn(() => builder);
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

import { discordLink, discordStatus, discordDisconnect } from "@/routes/connectors/discord";

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

const req = () => ({ body: {}, headers: {} }) as never;

describe("POST /api/connectors/discord/link", () => {
  beforeEach(() => {
    process.env.DISCORD_BOT_TOKEN = "tok";
    process.env.DISCORD_CLIENT_ID = "12345";
    state.memberRole = "admin";
    state.rpcCalls.length = 0;
  });
  afterEach(() => {
    delete process.env.DISCORD_BOT_TOKEN;
    delete process.env.DISCORD_CLIENT_ID;
  });

  it("503s (safe-inert) when the surface is off", async () => {
    delete process.env.DISCORD_BOT_TOKEN;
    const r = res();
    await discordLink(req(), r as never);
    expect(r.statusCode).toBe(503);
    expect(state.rpcCalls.length).toBe(0);
  });

  it("403s a non-admin member — minting the connect capability is an admin action", async () => {
    state.memberRole = "member";
    const r = res();
    await discordLink(req(), r as never);
    expect(r.statusCode).toBe(403);
    expect((r.body as { error: { code: string } }).error.code).toBe("forbidden");
    expect(state.rpcCalls.length).toBe(0);
  });

  it("mints a single-use token for the SESSION tenant; returns the connect command + install URL", async () => {
    const r = res();
    await discordLink(req(), r as never);
    expect(r.statusCode).toBe(200);

    const mint = state.rpcCalls.find((c) => c.fn === "create_discord_link_token");
    expect(mint).toBeTruthy();
    expect(mint?.args.p_tenant_id).toBe("t-1");
    expect(mint?.args.p_minted_by).toBe("u-1");
    const token = String(mint?.args.p_token);
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);

    const body = r.body as { connect_command: string; install_url: string; expires_in: number };
    expect(body.connect_command).toBe(`@Zavi connect ${token}`);
    expect(body.install_url).toContain("client_id=12345");
    expect(body.expires_in).toBe(900);
  });

  it("still mints without DISCORD_CLIENT_ID (install_url null — bot may already be installed)", async () => {
    delete process.env.DISCORD_CLIENT_ID;
    const r = res();
    await discordLink(req(), r as never);
    expect(r.statusCode).toBe(200);
    expect((r.body as { install_url: unknown }).install_url).toBeNull();
  });
});

describe("GET /api/connectors/discord/status", () => {
  afterEach(() => {
    delete process.env.DISCORD_BOT_TOKEN;
  });

  it("reports configured:false + connected:false without touching the DB when the surface is off", async () => {
    delete process.env.DISCORD_BOT_TOKEN;
    fromMock.mockClear();
    const r = res();
    await discordStatus(req(), r as never);
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ configured: false, connected: false });
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("reads the tenant's enabled discord_guilds row through the tenant facade (never throws)", async () => {
    process.env.DISCORD_BOT_TOKEN = "tok";
    state.memberRole = "admin";
    const r = res();
    await discordStatus(req(), r as never);
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ configured: true, connected: true });
    expect(fromMock).toHaveBeenCalledWith("discord_guilds");
  });

  it("connected:false when no enabled guild row exists", async () => {
    process.env.DISCORD_BOT_TOKEN = "tok";
    state.memberRole = null;
    const r = res();
    await discordStatus(req(), r as never);
    expect(r.body).toEqual({ configured: true, connected: false });
  });
});

describe("POST /api/connectors/discord/disconnect", () => {
  beforeEach(() => {
    state.memberRole = "admin";
    state.rpcCalls.length = 0;
  });

  it("403s a non-admin member (tearing down a shared connector is an admin action)", async () => {
    state.memberRole = "member";
    const r = res();
    await discordDisconnect(req(), r as never);
    expect(r.statusCode).toBe(403);
    expect(state.rpcCalls.length).toBe(0);
  });

  it("unbinds the session tenant via unset_discord_connection_for_tenant", async () => {
    const r = res();
    await discordDisconnect(req(), r as never);
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ ok: true, connected: false });
    const unset = state.rpcCalls.find((c) => c.fn === "unset_discord_connection_for_tenant");
    expect(unset?.args).toEqual({ p_tenant_id: "t-1" });
  });
});
