import { describe, it, expect, vi, beforeEach } from "vitest";
type Row = Record<string, unknown>;
const h = vi.hoisted(() => ({
  lastAssistant: null as Row | null,
  note: null as Row | null,
  setFact: vi.fn(async () => ({ ok: true, error: null as string | null })),
  deleteNote: vi.fn(async () => {}),
  askNext: vi.fn(async () => {}),
  inserted: [] as Row[],
  updated: [] as Row[],
  closeFails: false,
  role: "owner" as string,
  readError: null as null | string,
}));
vi.mock("@/services/company/facts", () => ({ setCompanyFact: h.setFact }));
vi.mock("@/services/memory", () => ({ deleteNote: h.deleteNote }));
vi.mock("@/services/knowledge-import/ask-conflict", () => ({ askNextConflict: h.askNext }));
vi.mock("@/services/auth/tenant-role", () => ({ loadTenantRoleFor: vi.fn(async () => h.role) }));
vi.mock("../state", () => ({ isSetupActive: vi.fn(async () => false) }));
vi.mock("../faq", () => ({ answerSetupQuestion: vi.fn() }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  tenantClient: () => ({
    from: (table: string) => {
      const q: Record<string, any> = {
        select: () => q, eq: () => q, order: () => q, limit: () => q,
        maybeSingle: async () =>
          h.readError === table
            ? { data: null, error: { message: "boom" } }
            : {
                data: table === "agent_threads" ? { user_id: "u1", agent_slug: "cgo" } : table === "agent_thread_messages" ? h.lastAssistant : h.note,
                error: null,
              },
        insert: (r: Row) => { h.inserted.push({ table, ...r }); return { select: () => ({ single: async () => ({ data: { id: "m" }, error: null }) }) }; },
        update: (v: Row) => {
          h.updated.push({ table, ...v });
          const done = h.closeFails ? { data: [], error: null } : { data: [{ id: "n1" }], error: null };
          return { eq: () => ({ eq: () => ({ select: async () => done }), then: (ok: (x: unknown) => unknown) => Promise.resolve(done).then(ok) }) };
        },
      };
      return q;
    },
  }),
}));
import { tryResolveConflict } from "../chat-fastpaths";

const auth = { tenant_id: "t1", user_id: "u1" };
const replies = () => h.inserted.filter((r) => r.table === "agent_thread_messages" && r.sender_role === "assistant").map((r) => r.body);
beforeEach(() => {
  h.setFact.mockReset(); h.setFact.mockResolvedValue({ ok: true, error: null });
  h.deleteNote.mockReset(); h.deleteNote.mockResolvedValue(undefined); h.askNext.mockClear(); h.inserted = []; h.updated = []; h.closeFails = false; h.role = "owner"; h.readError = null;
  h.lastAssistant = { meta: { fact_conflict: { note_id: "n1" } } };
  h.note = { id: "n1", source_ref: "tenant_document:d1#L9", metadata: { conflict: { key: "who_we_serve", file_value: "Parents", existing_value: "Schools", status: "open", asked_at: "x" } } };
});

describe("tryResolveConflict", () => {
  it("'Use the file's' writes the file's value as the founder's, closes it, and asks the next one", async () => {
    const out = await tryResolveConflict(auth, { message: "Use the file's", thread_id: "th-1" });
    expect(out?.action).toBe("fact_conflict_resolved");
    expect(h.setFact).toHaveBeenCalledWith("t1", "who_we_serve", "Parents", "tenant_document:d1#L9");
    expect(h.updated.find((u) => u.table === "memory_note")).toMatchObject({ metadata: { conflict: { status: "file" } } });
    expect(replies()).toEqual(['Got it. I\'ll use "Parents".']);
    expect(h.askNext).toHaveBeenCalledWith({ tenant_id: "t1", user_id: "u1" });
  });
  it("a failed write says so and keeps the conflict open (spec Q12)", async () => {
    h.setFact.mockResolvedValue({ ok: false, error: "db down" });
    const out = await tryResolveConflict(auth, { message: "Use the file's", thread_id: "th-1" });
    expect(out?.action).toBe("fact_conflict_failed");
    expect(h.updated.find((u) => u.table === "memory_note")).toBeUndefined();
    expect(replies()[0]).toMatch(/couldn't save that/i);
    expect(h.askNext).not.toHaveBeenCalled();
  });
  it("a user downgraded to member cannot answer (normal CGO; no company write)", async () => {
    h.role = "member";
    expect(await tryResolveConflict(auth, { message: "Use the file's", thread_id: "th-1" })).toBeNull();
    expect(h.setFact).not.toHaveBeenCalled();
  });
  it.each(["agent_threads", "agent_thread_messages", "memory_note"])("FAILS CLOSED on a returned error from %s", async (table) => {
    h.readError = table;
    await expect(tryResolveConflict(auth, { message: "Use the file's", thread_id: "th-1" })).rejects.toThrow();
    expect(h.setFact).not.toHaveBeenCalled();
  });
  it("a closure that updates ZERO rows is not acknowledged and does not move the queue", async () => {
    h.closeFails = true;
    const out = await tryResolveConflict(auth, { message: "Use the file's", thread_id: "th-1" });
    expect(out?.action).toBe("fact_conflict_failed");
    expect(h.askNext).not.toHaveBeenCalled();
  });
  it("'Keep' whose note delete fails is not acknowledged either", async () => {
    h.deleteNote.mockRejectedValueOnce(new Error("db down"));
    const out = await tryResolveConflict(auth, { message: "Keep what you have", thread_id: "th-1" });
    expect(out?.action).toBe("fact_conflict_failed");
    expect(h.askNext).not.toHaveBeenCalled();
  });
  it("'Keep what you have' confirms the existing value and removes the file's disagreeing fact", async () => {
    await tryResolveConflict(auth, { message: "keep what you have ", thread_id: "th-1" });
    expect(h.setFact).toHaveBeenCalledWith("t1", "who_we_serve", "Schools", "setup:conflict");
    expect(h.deleteNote).toHaveBeenCalledWith("t1", "n1", "u1", "founder kept the existing value");
  });
  it("'Keep' whose confirm fails keeps the file's fact and says so", async () => {
    h.setFact.mockResolvedValue({ ok: false, error: "db down" });
    await tryResolveConflict(auth, { message: "Keep what you have", thread_id: "th-1" });
    expect(h.deleteNote).not.toHaveBeenCalled();
  });
  it.each([
    ["a closed conflict", () => { h.note = { ...h.note!, metadata: { conflict: { status: "file" } } }; }],
    ["a kept (deleted) conflict note", () => { h.note = null; }],
    ["the ack of the answer it repeats", () => { h.lastAssistant = { meta: { no_run: true, reason: "fact_conflict_resolved" } }; }],
    ["the ack of an earlier retry (a double retry)", () => { h.lastAssistant = { meta: { no_run: true, reason: "fact_conflict_already_resolved" } }; }],
  ])("a retried chip on %s gets a no-run 'already answered' reply, never a run", async (_label, arrange) => {
    arrange();
    const out = await tryResolveConflict(auth, { message: "Use the file's", thread_id: "th-1" });
    expect(out?.action).toBe("fact_conflict_already_resolved");
    expect(replies()[0]).toMatch(/already answered/i);
    expect(h.inserted.filter((r) => r.table === "agent_thread_messages").every((r) => !r.agent_run_id)).toBe(true);
    expect(h.setFact).not.toHaveBeenCalled();
    expect(h.deleteNote).not.toHaveBeenCalled();
  });
  it("ignores other messages and a thread with no pending question", async () => {
    expect(await tryResolveConflict(auth, { message: "tell me more", thread_id: "th-1" })).toBeNull();
    h.lastAssistant = { meta: {} };
    expect(await tryResolveConflict(auth, { message: "Use the file's", thread_id: "th-1" })).toBeNull();
    expect(h.setFact).not.toHaveBeenCalled();
  });
});
