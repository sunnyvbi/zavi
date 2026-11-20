import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ requireAuth: vi.fn(), role: "owner" as string }));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: h.requireAuth }));
vi.mock("@/services/auth/tenant-role", () => ({
  requireTenantRole: async (_a: unknown, allowed: string[], res: { status: (n: number) => { json: (b: unknown) => void } }) => {
    if (allowed.includes(h.role)) return true;
    res.status(403).json({ error: { code: "forbidden" } });
    return false;
  },
}));
vi.mock("@/services/email-learnings/seed", () => ({ requestSeed: vi.fn(async () => true), retrySeed: vi.fn(), emailToolConnected: vi.fn(async () => true) }));
vi.mock("@/services/tenant-client", () => ({ asTenantId: (t: string) => t, tenantRpc: vi.fn() }));

import { emailLearningHandlers } from "@/routes/workspace/email-learnings";
import { LEARNING_MESSAGES, readLearnings, setLearning } from "@/services/email-learnings/api";

function res() {
  return {
    statusCode: 200,
    body: undefined as any,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
    setHeader() {
      return this;
    },
  };
}
const req = (body?: unknown) => ({ body }) as never;

beforeEach(() => {
  h.requireAuth.mockResolvedValue({ tenant_id: "tenant-a", user_id: "user-1" });
  h.role = "owner";
});
const handlers = (over: Record<string, unknown> = {}) =>
  emailLearningHandlers({ read: vi.fn(), removed: vi.fn(), set: vi.fn(), seen: vi.fn(), lookAgain: vi.fn(), ...over } as never);

describe("email learnings routes", () => {
  it("reads for the session's tenant and user only", async () => {
    const read = vi.fn(async () => ({ items: [], dismissed: 0, state: null }));
    const r = res();
    await handlers({ read }).list(req(), r as never);
    expect(read).toHaveBeenCalledWith("tenant-a", "user-1", { seed: true });
    expect(r.body).toEqual({ items: [], dismissed: 0, state: null });
  });

  it("a staff read of another workspace (override) never queues a seed there", async () => {
    h.requireAuth.mockResolvedValue({ tenant_id: "tenant-a", user_id: "user-1", tenant_overridden: true });
    const read = vi.fn(async () => ({ items: [], dismissed: 0, state: null }));
    await handlers({ read }).list(req(), res() as never);
    expect(read).toHaveBeenCalledWith("tenant-a", "user-1", { seed: false });
  });

  it("Look again: owners and admins only; says whether it was queued or already read today", async () => {
    const lookAgain = vi.fn(async () => "done");
    const r = res();
    await handlers({ lookAgain }).lookAgain(req(), r as never);
    expect(r.body).toMatchObject({ ok: true, status: "done", queued: false, message: expect.stringMatching(/already read your past emails today/) });
    lookAgain.mockResolvedValueOnce("pending");
    const p = res();
    await handlers({ lookAgain }).lookAgain(req(), p as never);
    expect(p.body).toMatchObject({ status: "pending", message: expect.stringMatching(/already reading/) });
    lookAgain.mockResolvedValueOnce("queued");
    const q = res();
    await handlers({ lookAgain }).lookAgain(req(), q as never);
    expect(q.body).toMatchObject({ status: "queued", queued: true });
    expect(lookAgain).toHaveBeenCalledWith("tenant-a", "user-1");
    lookAgain.mockResolvedValueOnce("already_retried_today");
    const a = res();
    await handlers({ lookAgain }).lookAgain(req(), a as never);
    expect(a.statusCode).toBe(409);
    expect(a.body.error).toMatchObject({ code: "already_retried_today", message: expect.stringMatching(/already tried again today/) });
    lookAgain.mockResolvedValueOnce("not_authorized");
    const n = res();
    await handlers({ lookAgain }).lookAgain(req(), n as never);
    expect(n.statusCode).toBe(403);
    h.role = "member";
    const m = res();
    await handlers({ lookAgain }).lookAgain(req(), m as never);
    expect(m.statusCode).toBe(403);
    expect(lookAgain).toHaveBeenCalledTimes(5);
  });

  it("an action: strict body; a refusal maps to its status and sentence", async () => {
    const set = vi.fn(async () => ({ ok: false as const, code: "card_changed", message: LEARNING_MESSAGES.card_changed }));
    const h2 = handlers({ set });
    const bad = res();
    await h2.set(req({ action: "edit", id: "not-a-uuid" }), bad as never);
    expect(bad.statusCode).toBe(400);
    const extra = res();
    await h2.set(req({ action: "add", text: "x", tenant_id: "other" }), extra as never);
    expect(extra.statusCode).toBe(400);
    const r = res();
    await h2.set(req({ action: "edit", id: "11111111-1111-4111-8111-111111111111", text: "x", version: 1 }), r as never);
    expect(set).toHaveBeenCalledWith("tenant-a", "user-1", { action: "edit", id: "11111111-1111-4111-8111-111111111111", text: "x", version: 1 });
    expect(r.statusCode).toBe(409);
    expect(r.body.error.message).toMatch(/changed since you opened it/);
  });

  it("an overridden workspace cannot change the list", async () => {
    h.requireAuth.mockResolvedValue({ tenant_id: "tenant-a", user_id: "user-1", tenant_overridden: true });
    const set = vi.fn();
    const r = res();
    await handlers({ set }).set(req({ action: "add", text: "x" }), r as never);
    expect(r.statusCode).toBe(403);
    expect(set).not.toHaveBeenCalled();
  });

  it("seen takes ids and versions for this user", async () => {
    const seen = vi.fn(async () => 2);
    const r = res();
    const items = [{ id: "11111111-1111-4111-8111-111111111111", version: 3 }];
    await handlers({ seen }).seen(req({ items }), r as never);
    expect(seen).toHaveBeenCalledWith("tenant-a", "user-1", items);
    expect(r.body).toEqual({ ok: true, marked: 2 });
  });
});

describe("the api", () => {
  it("opening the list asks for a seed (once a day, in SQL) and never fails on it", async () => {
    const calls: string[] = [];
    const rpc = async (_t: string, name: string) => {
      calls.push(name);
      return { data: { items: [{ id: "a" }], dismissed: 1, state: null }, error: null };
    };
    const seed = vi.fn(async () => {
      throw new Error("down");
    });
    expect(await readLearnings("t", "u", {}, { rpc, seed, retry: vi.fn(), toolsConnected: async () => true })).toEqual({
      items: [{ id: "a" }],
      dismissed: 1,
      state: null,
      tools_connected: true,
    });
    expect(seed).toHaveBeenCalledWith("t");
    expect(calls).toEqual(["list_email_learnings"]);
    seed.mockClear();
    await readLearnings("t", "u", { seed: false }, { rpc, seed, retry: vi.fn(), toolsConnected: async () => true });
    expect(seed).not.toHaveBeenCalled();
  });

  it("says when no email tool is connected, and says it does not know when that read fails", async () => {
    const rpc = async () => ({ data: { items: [], dismissed: 0, state: null }, error: null });
    const seed = async () => "queued" as const;
    expect((await readLearnings("t", "u", {}, { rpc, seed, retry: vi.fn(), toolsConnected: async () => false })).tools_connected).toBe(false);
    const down = async (): Promise<boolean> => {
      throw new Error("connector_metadata read failed");
    };
    expect((await readLearnings("t", "u", {}, { rpc, seed, retry: vi.fn(), toolsConnected: down })).tools_connected).toBeNull();
  });

  it("an action passes the actor; a SQL code becomes a sentence", async () => {
    const rpc = vi.fn(async () => ({ data: { ok: false, code: "list_full" }, error: null }));
    expect(await setLearning("t", "u", { action: "add", text: "x" }, { rpc, seed: async () => "done" as const, retry: async () => "done" as const, toolsConnected: async () => true })).toEqual({ ok: false, code: "list_full", message: LEARNING_MESSAGES.list_full });
    expect(rpc).toHaveBeenCalledWith("t", "set_email_learning", { p_actor_user_id: "u", p_action: "add", p_id: null, p_text: "x", p_version: null });
  });
});
