
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const s = vi.hoisted(() => ({
  role: "admin" as string | null,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  rpcData: {} as Record<string, unknown>,
  threadFilters: [] as Array<Record<string, unknown>>,
  enabled: 0,
  pending: 0,
  rows: [] as Array<{ id: string; handle: string }>,
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      s.rpcCalls.push({ fn, args });
      return { data: s.rpcData[fn] ?? null, error: null };
    },
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      let head = false;
      const b: any = {
        select: (_cols: string, opts?: { head?: boolean }) => ((head = !!opts?.head), b),
        eq: (c: string, v: unknown) => ((filters[c] = v), b),
        order: () => b,
        limit: () => b,
        maybeSingle: async () => ({ data: s.role === null ? null : { role: s.role }, error: null }),
        then: (resolve: (v: unknown) => void) => {
          if (table === "imessage_threads") s.threadFilters.push({ ...filters });
          resolve(head ? { count: filters.status === "enabled" ? s.enabled : s.pending } : { data: s.rows, error: null });
        },
      };
      return b;
    },
  }),
}));
vi.mock("@/services/auth/middleware", () => ({
  requireAuth: async () => ({ user_id: "u-1", tenant_id: "t-1" }),
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: async () => {} }));

import {
  imessageConfirm,
  imessageDisconnect,
  imessageLink,
  imessageLinkRoute,
  imessageStatus,
} from "@/routes/connectors/imessage";

function res() {
  const r: any = {
    statusCode: 200,
    body: null as any,
    status(c: number) { r.statusCode = c; return r; },
    json(b: unknown) { r.body = b; return r; },
  };
  return r;
}
const req = (body: Record<string, unknown> = {}) => ({ body, headers: {} }) as never;

const KEYS = ["SENDBLUE_API_KEY_ID", "SENDBLUE_API_SECRET", "SENDBLUE_FROM_NUMBER", "SENDBLUE_WEBHOOK_SECRET"];
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  process.env.SENDBLUE_API_KEY_ID = "kid";
  process.env.SENDBLUE_API_SECRET = "ksecret";
  process.env.SENDBLUE_FROM_NUMBER = "+13475550100";
  process.env.SENDBLUE_WEBHOOK_SECRET = "hook";
  Object.assign(s, { role: "admin", rpcCalls: [], rpcData: {}, threadFilters: [], enabled: 0, pending: 0, rows: [] });
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("POST /api/connectors/imessage/link", () => {
  it("builds the Messages deep link Settings shows", () => {
    expect(imessageLink("+13475550100", "Connect Zavi: abc")).toBe("sms:+13475550100&body=Connect%20Zavi%3A%20abc");
  });

  it("503s while the surface is off", async () => {
    delete process.env.SENDBLUE_API_SECRET;
    const r = res();
    await imessageLinkRoute(req(), r);
    expect(r.statusCode).toBe(503);
    expect(s.rpcCalls).toHaveLength(0);
  });

  it("403s a member and mints nothing", async () => {
    s.role = "member";
    const r = res();
    await imessageLinkRoute(req(), r);
    expect(r.statusCode).toBe(403);
    expect(s.rpcCalls).toHaveLength(0);
  });

  it("mints for the SESSION tenant and returns the link, prefill and our line", async () => {
    const r = res();
    await imessageLinkRoute(req(), r);
    const mint = s.rpcCalls.find((c) => c.fn === "create_imessage_link_token")!;
    expect(mint.args).toMatchObject({ p_tenant_id: "t-1", p_minted_by: "u-1", p_ttl_seconds: 900 });
    const token = String(mint.args.p_token);
    expect(r.body).toEqual({
      ok: true,
      imessage_url: `sms:+13475550100&body=${encodeURIComponent(`Connect Zavi: ${token}`)}`,
      prefill: `Connect Zavi: ${token}`,
      line: "+13475550100",
      expires_in: 900,
    });
  });

  it("hands back the caller's live link instead of rotating it", async () => {
    s.rpcData.live_imessage_link_token = [{ token: "livetoken", expires_in: 600 }];
    const r = res();
    await imessageLinkRoute(req(), r);
    expect(s.rpcCalls.map((c) => c.fn)).toEqual(["live_imessage_link_token"]);
    expect(r.body.prefill).toBe("Connect Zavi: livetoken");
  });
});

describe("POST /api/connectors/imessage/confirm", () => {
  it("confirms by tenant + code only: no handle ever reaches the RPC", async () => {
    s.rpcData.confirm_imessage_bind = "ok";
    const r = res();
    await imessageConfirm(req({ code: " k7q2-9f3m ", handle: "+19999999999", tenant_id: "t-evil" }), r);
    expect(r.body).toEqual({ ok: true });
    expect(s.rpcCalls).toEqual([{ fn: "confirm_imessage_bind", args: { p_confirm_code: "k7q2-9f3m", p_tenant_id: "t-1" } }]);
  });

  it("answers every refusal with the same 400, the reason only in the body", async () => {
    for (const reason of ["bad_code", "no_pending", "expired", "too_many_attempts"]) {
      s.rpcData.confirm_imessage_bind = reason;
      const r = res();
      await imessageConfirm(req({ code: "x" }), r);
      expect(r.statusCode).toBe(400);
      expect(r.body).toEqual({ error: { code: reason } });
    }
  });

  it("403s a member and 400s an empty code", async () => {
    s.role = "member";
    const r1 = res();
    await imessageConfirm(req({ code: "x" }), r1);
    expect(r1.statusCode).toBe(403);
    s.role = "owner";
    const r2 = res();
    await imessageConfirm(req({ code: "  " }), r2);
    expect(r2.statusCode).toBe(400);
    expect(s.rpcCalls).toHaveLength(0);
  });
});

describe("POST /api/connectors/imessage/disconnect", () => {
  it("tears down every thread of the session tenant", async () => {
    s.rpcData.unset_imessage_connection = 2;
    const r = res();
    await imessageDisconnect(req(), r);
    expect(s.rpcCalls).toEqual([{ fn: "unset_imessage_connection", args: { p_tenant_id: "t-1" } }]);
    expect(r.body).toEqual({ ok: true, connected: false, threads: 0 });
  });

  it("removes one number by tenant + id and reports what is left", async () => {
    s.rpcData.unset_imessage_thread = 1;
    const id = "11111111-1111-4111-8111-111111111111";
    const r = res();
    await imessageDisconnect(req({ thread_id: id }), r);
    expect(s.rpcCalls).toEqual([{ fn: "unset_imessage_thread", args: { p_thread_id: id, p_tenant_id: "t-1" } }]);
    expect(r.body).toEqual({ ok: true, connected: true, threads: 1 });
  });

  it("404s an id that matched nothing and 400s a non-uuid", async () => {
    const r1 = res();
    await imessageDisconnect(req({ thread_id: "11111111-1111-4111-8111-111111111111" }), r1);
    expect(r1.statusCode).toBe(404);
    const r2 = res();
    await imessageDisconnect(req({ thread_id: "1; drop table" }), r2);
    expect(r2.statusCode).toBe(400);
  });

  it("403s a member", async () => {
    s.role = "member";
    const r = res();
    await imessageDisconnect(req(), r);
    expect(r.statusCode).toBe(403);
    expect(s.rpcCalls).toHaveLength(0);
  });
});

describe("GET /api/connectors/imessage/status", () => {
  beforeEach(() => {
    s.enabled = 2;
    s.pending = 1;
    s.rows = [
      { id: "th-1", handle: "+14155550123" },
      { id: "th-2", handle: "ann@icloud.com" },
    ];
  });

  it("gives an admin the roster, masked, and scoped to the session tenant", async () => {
    const r = res();
    await imessageStatus(req(), r);
    expect(r.body).toEqual({
      configured: true,
      connected: true,
      threads: 2,
      pending: 1,
      handsets: [
        { id: "th-1", number: "+1 ••• ••• 0123" },
        { id: "th-2", number: "a•••@icloud.com" },
      ],
    });
    expect(JSON.stringify(r.body)).not.toContain("4155550123");
    expect(s.threadFilters.every((f) => f.tenant_id === "t-1")).toBe(true);
  });

  it("tells a member it is connected without naming anyone's phone", async () => {
    s.role = "member";
    const r = res();
    await imessageStatus(req(), r);
    expect(r.body).toMatchObject({ connected: true, threads: 2, handsets: [] });
  });
});
