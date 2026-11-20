import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const h = vi.hoisted(() => ({
  active: true,
  threads: [] as Array<Record<string, unknown>>,
  inserted: [] as Array<[string, Record<string, unknown>]>,
  answer: vi.fn(async (_t: string, _q: string) => "It's free."),
  role: "owner" as string | null,
  writeFails: false,
}));
vi.mock("../state", () => ({ isSetupActive: vi.fn(async () => h.active) }));
vi.mock("@/services/auth/tenant-role", () => ({ loadTenantRoleFor: vi.fn(async () => h.role) }));
vi.mock("../faq", () => ({ answerSetupQuestion: h.answer }));
vi.mock("@/services/company/facts", () => ({ setCompanyFact: vi.fn() }));
vi.mock("@/services/memory", () => ({ deleteNote: vi.fn() }));
vi.mock("@/services/knowledge-import/ask-conflict", () => ({ askNextConflict: vi.fn() }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  tenantClient: () => ({
    from: (table: string) => {
      const filters: Array<(r: Row) => boolean> = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const q: Record<string, any> = {
        select: () => q,
        eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q; },
        order: () => q,
        limit: () => q,
        maybeSingle: async () => ({ data: (table === "agent_threads" ? h.threads : []).find((r) => filters.every((f) => f(r))) ?? null, error: null }),
        insert: (row: Row | Row[]) => {
          const r = Array.isArray(row) ? row[0] : row;
          h.inserted.push([table, r]);
          const fail = table === "agent_thread_messages" && h.writeFails;
          return { select: () => ({ single: async () => (fail ? { data: null, error: { message: "boom" } } : { data: { id: table === "agent_threads" ? "th-new" : `m${h.inserted.length}` }, error: null }) }) };
        },
        update: () => ({ eq: async () => ({ error: null }) }),
      };
      return q;
    },
  }),
}));

import { tryGreeting, trySetupFaq } from "../chat-fastpaths";

const auth = { tenant_id: "t1", user_id: "u1", access_token: "tok" };
beforeEach(() => { h.active = true; h.threads = []; h.inserted = []; h.answer.mockClear(); h.role = "owner"; h.writeFails = false; });

describe("trySetupFaq", () => {
  it("answers in a new cgo thread with no run and no credits", async () => {
    const out = await trySetupFaq(auth, { message: "does it cost?", thread_id: null });
    expect(out).toEqual({ thread_id: "th-new", user_message_id: expect.any(String), ok: true, action: "setup_faq_no_run" });
    const msgs = h.inserted.filter(([t]) => t === "agent_thread_messages").map(([, r]) => r);
    expect(msgs.map((m) => [m.sender_role, m.agent_run_id])).toEqual([["user", null], ["assistant", null]]);
    expect(msgs[1]).toMatchObject({ body: "It's free.", meta: { no_run: true, reason: "setup_faq" } });
    expect(h.inserted.some(([t]) => t === "agent_runs")).toBe(false);
  });
  it("reuses the caller's own cgo thread, and refuses someone else's (fail closed)", async () => {
    h.threads = [{ id: "th-1", user_id: "u1", agent_slug: "cgo" }, { id: "th-2", user_id: "u2", agent_slug: "cgo" }];
    expect((await trySetupFaq(auth, { message: "hi there", thread_id: "th-1" }))?.thread_id).toBe("th-1");
    await expect(trySetupFaq(auth, { message: "hi there", thread_id: "th-2" })).rejects.toThrow(/thread_unavailable/);
  });
  it("members get the normal CGO (setup is owner/admin only)", async () => {
    h.role = "member";
    expect(await trySetupFaq(auth, { message: "does it cost?", thread_id: null })).toBeNull();
    expect(h.answer).not.toHaveBeenCalled();
  });
  it("FAILS CLOSED: a role or setup read error throws (chat-send answers 503, never a billable run)", async () => {
    const { loadTenantRoleFor } = await import("@/services/auth/tenant-role");
    (loadTenantRoleFor as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("db down"));
    await expect(trySetupFaq(auth, { message: "does it cost?", thread_id: null })).rejects.toThrow();
    const { isSetupActive } = await import("../state");
    (isSetupActive as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("db down"));
    await expect(trySetupFaq(auth, { message: "does it cost?", thread_id: null })).rejects.toThrow();
  });
  it("FAILS CLOSED: a message write error throws", async () => {
    h.writeFails = true;
    await expect(trySetupFaq(auth, { message: "does it cost?", thread_id: null })).rejects.toThrow(/message_write_failed/);
  });
  it("does nothing once setup is done (normal CGO turn)", async () => {
    h.active = false;
    expect(await trySetupFaq(auth, { message: "plan my ads", thread_id: null })).toBeNull();
    expect(h.answer).not.toHaveBeenCalled();
  });
});

describe("tryGreeting", () => {
  it("answers a bare greeting on any agent in a new thread with no run", async () => {
    const out = await tryGreeting(auth, "operator", { message: "Hello", thread_id: null });
    expect(out).toEqual({ thread_id: "th-new", user_message_id: expect.any(String), ok: true, action: "greeting_no_run" });
    expect(h.inserted[0]).toEqual(["agent_threads", expect.objectContaining({ agent_slug: "operator", title: "Hello" })]);
    const msgs = h.inserted.filter(([t]) => t === "agent_thread_messages").map(([, r]) => r);
    expect(msgs.map((m) => [m.sender_role, m.agent_run_id])).toEqual([["user", null], ["assistant", null]]);
    expect(msgs[1]).toMatchObject({ meta: { no_run: true, reason: "greeting" } });
  });
  it("leaves real asks and another agent's thread to the normal chat path", async () => {
    h.threads = [{ id: "th-1", user_id: "u1", agent_slug: "cgo" }];
    expect(await tryGreeting(auth, "operator", { message: "hello, fix my ads", thread_id: null })).toBeNull();
    expect(await tryGreeting(auth, "operator", { message: "hi", thread_id: "th-1" })).toBeNull();
    expect(h.inserted).toEqual([]);
  });
  it("throws when the reply cannot be written, instead of answering with a missing reply", async () => {
    h.writeFails = true;
    await expect(tryGreeting(auth, "operator", { message: "hey", thread_id: null })).rejects.toThrow(/message_write_failed/);
  });
});
