
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { rpcMock, fromMock, state } = vi.hoisted(() => {
  const s = {
    memberRole: "admin" as string | null,
    rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
    rpcData: 2 as unknown,
  };
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    s.rpcCalls.push({ fn, args });
    return { data: s.rpcData, error: null };
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

import { whatsappDisconnect, whatsappLink } from "@/routes/connectors/whatsapp";

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
const reqWith = (body: Record<string, unknown>) => ({ body, headers: {} }) as never;

const KEYS = [
  "WHATSAPP_ACCESS_TOKEN",
  "WHATSAPP_PHONE_NUMBER_ID",
  "WHATSAPP_APP_SECRET",
  "WHATSAPP_VERIFY_TOKEN",
  "WHATSAPP_BUSINESS_NUMBER",
];

describe("POST /api/connectors/whatsapp/disconnect", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    state.memberRole = "admin";
    state.rpcCalls.length = 0;
    state.rpcData = 2;
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("403s a non-admin member and touches no RPC", async () => {
    state.memberRole = "member";
    const r = res();
    await whatsappDisconnect(req(), r as never);
    expect(r.statusCode).toBe(403);
    expect(r.body).toEqual({ error: { code: "not_admin" } });
    expect(state.rpcCalls.length).toBe(0);
  });

  it("calls unset_whatsapp_connection with the SESSION tenant injected and nothing else", async () => {
    const r = res();
    await whatsappDisconnect(req(), r as never);
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ ok: true, connected: false, threads: 0 });
    const unset = state.rpcCalls.find((c) => c.fn === "unset_whatsapp_connection");
    expect(unset?.args).toEqual({ p_tenant_id: "t-1" });
  });

  it("an empty thread_id means the whole tenant, same as no body", async () => {
    const r = res();
    await whatsappDisconnect(reqWith({ thread_id: "" }), r as never);
    expect(state.rpcCalls.map((c) => c.fn)).toEqual(["unset_whatsapp_connection"]);
  });

  it("is NOT gated on the surface being configured — teardown must work after secrets are pulled", async () => {
    for (const k of KEYS) delete process.env[k];
    const link = res();
    await whatsappLink(req(), link as never);
    expect(link.statusCode).toBe(503);
    const r = res();
    await whatsappDisconnect(req(), r as never);
    expect(r.statusCode).toBe(200);
    expect(state.rpcCalls.some((c) => c.fn === "unset_whatsapp_connection")).toBe(true);
  });
});

describe("POST /api/connectors/whatsapp/disconnect — one number (thread_id)", () => {
  const THREAD = "0b7a1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";

  beforeEach(() => {
    state.memberRole = "admin";
    state.rpcCalls.length = 0;
    state.rpcData = 2;
  });

  it("removes ONE thread via unset_whatsapp_thread with the SESSION tenant injected, never the tenant-wide RPC", async () => {
    const r = res();
    await whatsappDisconnect(reqWith({ thread_id: THREAD }), r as never);
    expect(r.statusCode).toBe(200);
    expect(state.rpcCalls.map((c) => c.fn)).toEqual(["unset_whatsapp_thread"]);
    expect(state.rpcCalls[0]?.args).toEqual({ p_tenant_id: "t-1", p_thread_id: THREAD });
  });

  it("keeps the tile Connected while other numbers remain (RPC returns the remaining count)", async () => {
    state.rpcData = 2;
    const r = res();
    await whatsappDisconnect(reqWith({ thread_id: THREAD }), r as never);
    expect(r.body).toEqual({ ok: true, connected: true, threads: 2 });
  });

  it("reports disconnected when the LAST number is removed", async () => {
    state.rpcData = 0;
    const r = res();
    await whatsappDisconnect(reqWith({ thread_id: THREAD }), r as never);
    expect(r.body).toEqual({ ok: true, connected: false, threads: 0 });
  });

  it("404s when the id matched nothing of THIS tenant's (RPC returns null) — a foreign id looks the same", async () => {
    state.rpcData = null;
    const r = res();
    await whatsappDisconnect(reqWith({ thread_id: THREAD }), r as never);
    expect(r.statusCode).toBe(404);
    expect(r.body).toEqual({ error: { code: "thread_not_found" } });
  });

  it("400s a non-uuid thread_id before touching any RPC", async () => {
    const r = res();
    await whatsappDisconnect(reqWith({ thread_id: "16692256032" }), r as never);
    expect(r.statusCode).toBe(400);
    expect(r.body).toEqual({ error: { code: "thread_id_invalid" } });
    expect(state.rpcCalls.length).toBe(0);
  });

  it("403s a non-admin member and touches no RPC", async () => {
    state.memberRole = "member";
    const r = res();
    await whatsappDisconnect(reqWith({ thread_id: THREAD }), r as never);
    expect(r.statusCode).toBe(403);
    expect(state.rpcCalls.length).toBe(0);
  });
});

describe("POST /api/connectors/whatsapp/link", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    for (const k of KEYS) process.env[k] = "set";
    process.env.WHATSAPP_BUSINESS_NUMBER = "+1 (555) 123-4567";
    state.memberRole = "admin";
    state.rpcCalls.length = 0;
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("returns the same normalized number the deep link is addressed to", async () => {
    const r = res();
    await whatsappLink(req(), r as never);
    expect(r.statusCode).toBe(200);
    const body = r.body as { wa_url: string; prefill: string; business_number: string };
    expect(body.business_number).toBe("15551234567");
    expect(body.wa_url).toContain(`phone=${body.business_number}&`);
    expect(body.wa_url).toContain(encodeURIComponent(body.prefill));
    expect(body.prefill).toMatch(/^Connect Zavi: \S+$/);
  });
});

describe("POST /api/connectors/whatsapp/link: reuse of a live link", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      process.env[k] = k === "WHATSAPP_BUSINESS_NUMBER" ? "15550001111" : "x";
    }
    state.memberRole = "admin";
    state.rpcCalls.length = 0;
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("opening the panel hands back the caller's own live token and does not mint", async () => {
    state.rpcData = [{ token: "LIVEWA", expires_in: 420 }];
    const r = res();
    await whatsappLink(req(), r as never);
    expect(r.statusCode).toBe(200);
    expect(state.rpcCalls.find((c) => c.fn === "live_whatsapp_link_token")?.args).toMatchObject({ p_tenant_id: "t-1", p_minted_by: "u-1" });
    expect(state.rpcCalls.some((c) => c.fn === "create_whatsapp_link_token")).toBe(false);
    expect(r.body).toMatchObject({ prefill: "Connect Zavi: LIVEWA", expires_in: 420 });
  });

  it("an explicit new link ({fresh:true}) mints instead", async () => {
    state.rpcData = [{ token: "LIVEWA", expires_in: 420 }];
    const r = res();
    await whatsappLink(reqWith({ fresh: true }), r as never);
    expect(state.rpcCalls.some((c) => c.fn === "live_whatsapp_link_token")).toBe(false);
    expect(state.rpcCalls.some((c) => c.fn === "create_whatsapp_link_token")).toBe(true);
  });
});
