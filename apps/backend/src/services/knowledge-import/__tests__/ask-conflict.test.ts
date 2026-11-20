import { describe, it, expect, vi, beforeEach } from "vitest";

type Note = { id: string; created_at: string; metadata: Record<string, any> };
const h = vi.hoisted(() => ({
  threadId: "th-1" as string | null,
  notes: [] as Note[],
  inserted: [] as Array<Record<string, unknown>>,
  insertFails: false,
  existingQuestion: false,
  updateFails: false,
}));
vi.mock("@/services/setup/chat-fastpaths", () => ({
  latestCgoThread: vi.fn(async () => h.threadId),
  CGO: "cgo",
  CONFLICT_USE_FILE: "Use the file's",
  CONFLICT_KEEP: "Keep what you have",
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  tenantClient: () => ({
    from: (table: string) => {
      const q: Record<string, any> = {
        select: () => q, eq: () => q, not: () => q, order: () => q, limit: () => q,
        then: (ok: (x: unknown) => unknown) =>
          Promise.resolve({
            data: table === "memory_note" ? h.notes : table === "agent_thread_messages" && h.existingQuestion ? [{ id: "q1" }] : [],
            error: null,
          }).then(ok),
        insert: (row: Record<string, unknown>) => {
          h.inserted.push({ table, ...row });
          const fail = table === "agent_thread_messages" && h.insertFails;
          return { select: () => ({ single: async () => (fail ? { data: null, error: { message: "boom" } } : { data: { id: "x" }, error: null }) }) };
        },
        update: (v: Record<string, any>) => ({
          eq: (_c: string, id: string) => {
            if (table === "memory_note" && !h.updateFails) {
              const n = h.notes.find((x) => x.id === id);
              if (n) n.metadata = v.metadata;
            }
            const done = { error: h.updateFails ? { message: "boom" } : null, data: h.updateFails ? [] : [{ id }] };
            return { eq: () => ({ select: async () => done }), then: (ok: (x: unknown) => unknown) => Promise.resolve(done).then(ok) };
          },
        }),
      };
      return q;
    },
  }),
}));
import { askNextConflict, conflictQuestion } from "../ask-conflict";

const conflict = (id: string, at: string, over: Record<string, unknown> = {}): Note => ({
  id, created_at: at,
  metadata: { filename: "retro.md", conflict: { key: "who_we_serve", file_value: "Parents", existing_value: "Schools", existing_source: "onboarding_enrichment", status: "open", asked_at: null, ...over } },
});
beforeEach(() => { h.threadId = "th-1"; h.inserted = []; h.insertFails = false; h.existingQuestion = false; h.updateFails = false; h.notes = [conflict("n1", "2026-09-24T01:00:00Z"), conflict("n2", "2026-09-24T02:00:00Z")]; });

describe("askNextConflict", () => {
  it("asks the OLDEST open conflict, only one, with the two buttons", async () => {
    await askNextConflict({ tenant_id: "t1", user_id: "u1" });
    const msgs = h.inserted.filter((r) => r.table === "agent_thread_messages");
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ thread_id: "th-1", sender_role: "assistant", agent_run_id: null });
    expect(msgs[0].meta).toEqual({ no_run: true, reason: "fact_conflict", fact_conflict: { note_id: "n1" }, suggestions: ["Use the file's", "Keep what you have"] });
    expect(h.notes[0].metadata.conflict.asked_at).toEqual(expect.any(String));
    expect(h.notes[1].metadata.conflict.asked_at).toBeNull();
  });
  it("asks nothing while one is active (asked and still open)", async () => {
    h.notes[0].metadata.conflict.asked_at = "2026-09-24T03:00:00Z";
    await askNextConflict({ tenant_id: "t1", user_id: "u1" });
    expect(h.inserted.filter((r) => r.table === "agent_thread_messages")).toHaveLength(0);
  });
  it("a failed post leaves asked_at null so the next trigger asks again", async () => {
    h.insertFails = true;
    await askNextConflict({ tenant_id: "t1", user_id: "u1" });
    expect(h.notes[0].metadata.conflict.asked_at).toBeNull();
  });
  it("a posted question whose asked_at write failed is REPAIRED next time, not posted twice", async () => {
    h.existingQuestion = true;
    await askNextConflict({ tenant_id: "t1", user_id: "u1" });
    expect(h.inserted.filter((r) => r.table === "agent_thread_messages")).toHaveLength(0);
    expect(h.notes[0].metadata.conflict.asked_at).toEqual(expect.any(String));
  });
  it("creates the cgo thread when the founder has none", async () => {
    h.threadId = null;
    await askNextConflict({ tenant_id: "t1", user_id: "u1" });
    expect(h.inserted[0]).toMatchObject({ table: "agent_threads", agent_slug: "cgo", user_id: "u1" });
  });
  it("names both values and where each came from", () => {
    expect(conflictQuestion({ key: "who_we_serve", file_value: "Parents", existing_value: "Schools", existing_source: "onboarding_enrichment", filename: "retro.md" }))
      .toBe('retro.md says who you serve is "Parents". I have "Schools" (from your website). Which is right?');
  });
});
