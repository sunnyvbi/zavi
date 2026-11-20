
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { Request, Response } from "express";

const m = vi.hoisted(() => ({ requireAuth: vi.fn(), hasConsent: vi.fn() }));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: m.requireAuth }));
vi.mock("@/services/extension/consent", () => ({ hasCurrentExtensionConsent: m.hasConsent }));
vi.mock("@/services/supabase", async () => {
  const f = await import("@/services/extension/__tests__/fake-ext-ops-db");
  return { serviceClient: () => f.fakeServiceClient };
});

import * as f from "@/services/extension/__tests__/fake-ext-ops-db";
import {
  deleteExtensionSession,
  getExtensionNextOp,
  postExtensionOpResult,
  postExtensionSession,
  postExtensionSessionHeartbeat,
} from "../browser-ops";

const T1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const T2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const UA = "11111111-1111-4111-8111-111111111111";
const UB = "22222222-2222-4222-8222-222222222222";
const RUN = "33333333-3333-4333-8333-333333333333";

function as(user: string, tenant = T1) {
  m.requireAuth.mockResolvedValue({ user_id: user, tenant_id: tenant, access_token: "x" });
}

function mkRes() {
  const ee = new EventEmitter();
  const r: any = {
    _status: 0,
    _body: undefined as unknown,
    headersSent: false,
    writableEnded: false,
    on: (ev: string, fn: () => void) => (ee.on(ev, fn), r),
    status(c: number) {
      r._status = c;
      return r;
    },
    json(b: unknown) {
      r._body = b;
      r.headersSent = r.writableEnded = true;
      return r;
    },
    end() {
      r.headersSent = r.writableEnded = true;
      return r;
    },
  };
  return r;
}

function req(p: { params?: object; query?: object; body?: unknown }): Request {
  return { params: p.params ?? {}, query: p.query ?? {}, body: p.body } as unknown as Request;
}

async function call(h: (q: Request, s: Response) => Promise<void>, p: Parameters<typeof req>[0]) {
  const res = mkRes();
  await h(req(p), res as Response);
  return res;
}

beforeEach(() => {
  f.resetDb();
  m.requireAuth.mockReset();
  m.hasConsent.mockReset();
  m.hasConsent.mockResolvedValue(true);
  as(UA);
});

function seedAWithOp(is_write = true) {
  const s = f.seedSession({ tenant_id: T1, user_id: UA, tab_id: 1 });
  const op = f.seedOp({
    tenant_id: T1,
    user_id: UA,
    run_id: RUN,
    panel_session_id: s.id,
    tab_id: 1,
    seq: 1,
    is_write,
  });
  return { s, op };
}

describe("consent gate", () => {
  it.each([
    ["POST sessions", postExtensionSession, { body: { tab_id: 1 } }],
    ["heartbeat", postExtensionSessionHeartbeat, { params: { id: RUN } }],
    ["DELETE session", deleteExtensionSession, { params: { id: RUN } }],
    ["ops/next", getExtensionNextOp, { query: { session: RUN } }],
    ["ops result", postExtensionOpResult, { params: { id: RUN }, body: {} }],
  ] as const)("%s → 403 consent_required with no consent, and touches nothing", async (_n, h, p) => {
    const { op } = seedAWithOp();
    m.hasConsent.mockResolvedValue(false);
    const res = await call(h as any, p as any);
    expect(res._status).toBe(403);
    expect(res._body.error.code).toBe("consent_required");
    expect(m.hasConsent).toHaveBeenCalledWith(T1, UA);
    expect(f.db.tables.extension_panel_sessions).toHaveLength(1);
    expect(op.status).toBe("queued");
    expect(f.db.rpcCalls).toHaveLength(0);
  });

  it("unauthenticated → the handler stops (requireAuth already answered)", async () => {
    m.requireAuth.mockResolvedValue(null);
    const res = await call(postExtensionSession, { body: { tab_id: 1 } });
    expect(res._status).toBe(0);
    expect(f.db.tables.extension_panel_sessions).toHaveLength(0);
  });
});

describe("sessions", () => {
  it("POST creates a session for the JWT user in the active tenant, ignoring body ids", async () => {
    const res = await call(postExtensionSession, {
      body: { tab_id: 5, user_id: UB, tenant_id: T2 },
    });
    expect(res._status).toBe(201);
    expect(f.db.tables.extension_panel_sessions[0]).toMatchObject({
      id: res._body.session_id,
      tenant_id: T1,
      user_id: UA,
      tab_id: 5,
    });
  });

  it("POST without a valid tab_id → 400", async () => {
    expect((await call(postExtensionSession, { body: {} }))._status).toBe(400);
    expect((await call(postExtensionSession, { body: { tab_id: "1" } }))._status).toBe(400);
    expect((await call(postExtensionSession, { body: { tab_id: -1 } }))._status).toBe(400);
  });

  it("heartbeat: owner 204; user B and cross-tenant 404", async () => {
    const { s } = seedAWithOp();
    expect((await call(postExtensionSessionHeartbeat, { params: { id: s.id } }))._status).toBe(204);
    as(UB);
    expect((await call(postExtensionSessionHeartbeat, { params: { id: s.id } }))._status).toBe(404);
    as(UA, T2);
    expect((await call(postExtensionSessionHeartbeat, { params: { id: s.id } }))._status).toBe(404);
    as(UA);
    expect((await call(postExtensionSessionHeartbeat, { params: { id: "nope" } }))._status).toBe(404);
  });

  it("DELETE: user B → 404 and A's session stays open; owner → 204", async () => {
    const { s } = seedAWithOp();
    as(UB);
    expect((await call(deleteExtensionSession, { params: { id: s.id } }))._status).toBe(404);
    expect(s.ended_at).toBeNull();
    as(UA);
    expect((await call(deleteExtensionSession, { params: { id: s.id } }))._status).toBe(204);
    expect(s.ended_at).not.toBeNull();
  });
});

describe("ops/next", () => {
  it("owner gets the op (no tenant/user ids in the payload)", async () => {
    const { s, op } = seedAWithOp();
    const res = await call(getExtensionNextOp, { query: { session: s.id } });
    expect(res._status).toBe(200);
    expect(res._body.op.id).toBe(op.id);
    expect(res._body.op).not.toHaveProperty("tenant_id");
    expect(res._body.op).not.toHaveProperty("user_id");
    expect(op.status).toBe("delivered");
  });

  it("user B polling A's session → 404 and A's op is not delivered", async () => {
    const { s, op } = seedAWithOp();
    as(UB);
    const res = await call(getExtensionNextOp, { query: { session: s.id } });
    expect(res._status).toBe(404);
    expect(op.status).toBe("queued");
  });

  it("same user in another tenant → 404, op not delivered", async () => {
    const { s, op } = seedAWithOp();
    as(UA, T2);
    expect((await call(getExtensionNextOp, { query: { session: s.id } }))._status).toBe(404);
    expect(op.status).toBe("queued");
  });

  it("a dead session (not seen for 30s) → 404", async () => {
    const { s } = seedAWithOp();
    s.last_seen_at = new Date(Date.now() - 31_000).toISOString();
    expect((await call(getExtensionNextOp, { query: { session: s.id } }))._status).toBe(404);
  });

  it("missing/invalid session param → 404", async () => {
    expect((await call(getExtensionNextOp, { query: {} }))._status).toBe(404);
    expect((await call(getExtensionNextOp, { query: { session: "x" } }))._status).toBe(404);
  });
});

describe("ops/:id/result", () => {
  async function deliver() {
    const { s, op } = seedAWithOp();
    const res = await call(getExtensionNextOp, { query: { session: s.id } });
    return { s, op, token: res._body.op.execution_token as string };
  }

  it("owner with every id matching → 204 and the op is done", async () => {
    const { s, op, token } = await deliver();
    const res = await call(postExtensionOpResult, {
      params: { id: op.id },
      body: { session_id: s.id, run_id: RUN, execution_token: token, status: "done", result: { a: 1 } },
    });
    expect(res._status).toBe(204);
    expect(op).toMatchObject({ status: "done", result: { a: 1 } });
  });

  it("user B posting A's result (with A's real token) → 404, op untouched", async () => {
    const { s, op, token } = await deliver();
    as(UB);
    const res = await call(postExtensionOpResult, {
      params: { id: op.id },
      body: { session_id: s.id, run_id: RUN, execution_token: token, status: "done", user_id: UA },
    });
    expect(res._status).toBe(404);
    expect(op.status).toBe("delivered");
  });

  it("cross-tenant → 404", async () => {
    const { s, op, token } = await deliver();
    as(UA, T2);
    const res = await call(postExtensionOpResult, {
      params: { id: op.id },
      body: { session_id: s.id, run_id: RUN, execution_token: token, status: "done" },
    });
    expect(res._status).toBe(404);
    expect(op.status).toBe("delivered");
  });

  it("wrong execution_token → 404 (same shape as not-found)", async () => {
    const { s, op } = await deliver();
    const res = await call(postExtensionOpResult, {
      params: { id: op.id },
      body: {
        session_id: s.id,
        run_id: RUN,
        execution_token: "99999999-9999-4999-8999-999999999999",
        status: "done",
      },
    });
    expect(res._status).toBe(404);
    expect(res._body).toEqual({ error: { code: "not_found", message: "Not found." } });
    expect(op.status).toBe("delivered");
  });

  it("status other than done/failed, or malformed ids → 400", async () => {
    const { s, op, token } = await deliver();
    const base = { session_id: s.id, run_id: RUN, execution_token: token };
    expect(
      (await call(postExtensionOpResult, { params: { id: op.id }, body: { ...base, status: "unknown" } }))._status,
    ).toBe(400);
    expect(
      (await call(postExtensionOpResult, { params: { id: op.id }, body: { ...base, run_id: "x", status: "done" } }))._status,
    ).toBe(400);
    expect(op.status).toBe("delivered");
  });
});
