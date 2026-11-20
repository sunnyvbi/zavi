import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
let inbound: Row | null;
let chats: Row[];
const inserted: Row[] = [];

function chain(table: string) {
  const filters: Array<[string, unknown]> = [];
  let pendingInsert: Row | null = null;
  const q: Record<string, unknown> = {};
  const self = () => q;
  Object.assign(q, {
    select: self,
    order: self,
    limit: self,
    update: self,
    eq: (k: string, v: unknown) => (filters.push([k, v]), q),
    is: (k: string, v: unknown) => (filters.push([k, v]), q),
    maybeSingle: async () => {
      if (table === "email_messages") return { data: inbound, error: null };
      if (table === "agent_threads" && pendingInsert) {
        const row = { id: `th-${chats.length + 1}`, deleted_at: null, ...pendingInsert };
        chats.push(row);
        return { data: { id: row.id }, error: null };
      }
      const hit = chats.find((c) => filters.every(([k, v]) => (c[k] ?? null) === v));
      return { data: hit ? { id: hit.id } : null, error: null };
    },
    insert: (rows: Row | Row[]) => {
      if (table === "agent_threads") {
        pendingInsert = rows as Row;
        return q;
      }
      inserted.push(...(rows as Row[]));
      return Promise.resolve({ error: null });
    },
    then: (ok: (v: { data: null; error: null }) => unknown) => Promise.resolve({ data: null, error: null }).then(ok),
  });
  return q;
}
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => ({ from: (t: string) => chain(t) }),
  tenantRpc: async () => ({ data: "u1", error: null }),
}));
vi.mock("@/services/agents/email-reply-trust", () => ({ isVerifiedMemberReplyRun: async () => true }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn() }));

import { chatTitle, mirrorEmailReplyToChat } from "../mirrorEmailReplyToChat";

const mirror = (run_id = "run-1") =>
  mirrorEmailReplyToChat({ tenant_id: "t", agent_slug: "cgo", run_id, run_payload: { email: { email_message_id: "e1" } }, sender_email: "f@x.co", answer: "About $18." });

beforeEach(() => {
  inserted.length = 0;
  chats = [{ id: "app-chat", agent_slug: "cgo", user_id: "u1", email_thread_id: null, deleted_at: null }];
  inbound = { body_text: "What CPA should I expect?", thread_id: "et-1", subject: "Re: Your growth plan" };
});

describe("mirrorEmailReplyToChat", () => {
  it("the founder's row carries the run that answers it", async () => {
    await mirror();
    expect(inserted).toEqual([
      expect.objectContaining({ sender_role: "user", body: "What CPA should I expect?", meta: { via: "email", reply_run_id: "run-1" } }),
      expect.objectContaining({ sender_role: "assistant", agent_run_id: "run-1" }),
    ]);
  });

  it("screenshot case: the email reply gets its own chat, titled with the subject, without the sign-off", async () => {
    inbound = {
      body_text: "Why do you want to raise it?\n\n\nRegards,\nRavi R.",
      thread_id: "et-raise",
      subject: "Re: Raise Rent a car at $35 per day to $178.80?",
    };
    await mirror();
    const chat = chats.find((c) => c.email_thread_id === "et-raise");
    expect(chat).toMatchObject({ title: "Raise Rent a car at $35 per day to $178.80?", title_source: "email", user_id: "u1", agent_slug: "cgo" });
    expect(inserted.every((m) => m.thread_id === chat!.id)).toBe(true);
    expect(inserted.some((m) => m.thread_id === "app-chat")).toBe(false);
    expect(inserted[0]).toMatchObject({ body: "Why do you want to raise it?" });
  });

  it("a second reply on the same email conversation goes to the same chat; another conversation gets its own", async () => {
    await mirror("run-1");
    await mirror("run-2");
    inbound = { body_text: "And TikTok?", thread_id: "et-2", subject: "Re: TikTok" };
    await mirror("run-3");
    expect(chats.filter((c) => c.email_thread_id).map((c) => c.email_thread_id)).toEqual(["et-1", "et-2"]);
    expect(inserted[2]!.thread_id).toBe(inserted[0]!.thread_id);
    expect(inserted[4]!.thread_id).not.toBe(inserted[0]!.thread_id);
  });

  it("a deleted email chat is not reused: the next reply starts a new one", async () => {
    chats.push({ id: "old", agent_slug: "cgo", user_id: "u1", email_thread_id: "et-1", deleted_at: "2026-10-20T00:00:00Z" });
    await mirror();
    expect(inserted[0]!.thread_id).not.toBe("old");
  });

  it("no email conversation on the inbound message: nothing is mirrored", async () => {
    inbound = { body_text: "Hi", thread_id: null, subject: null };
    await mirror();
    expect(inserted).toEqual([]);
    expect(chats).toHaveLength(1);
  });
});

describe("chatTitle", () => {
  it("drops reply and forward prefixes", () => {
    expect(chatTitle("Re: RE: Fwd: Budget")).toBe("Budget");
    expect(chatTitle("Budget review")).toBe("Budget review");
    expect(chatTitle("  ")).toBeNull();
    expect(chatTitle(null)).toBeNull();
  });
});
