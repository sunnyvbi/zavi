import { describe, it, expect, vi, beforeEach } from "vitest";

const { requireAuthMock } = vi.hoisted(() => ({
  requireAuthMock: vi.fn(async () => ({ user_id: "u-1", tenant_id: "t-1", access_token: "tok" })),
}));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: requireAuthMock }));

type ThreadRow = { id: string; title: string; last_message_at: string; created_at: string; deleted_at: string | null };

const { db } = vi.hoisted(() => ({
  db: { threads: [] as ThreadRow[], messages: [] as unknown[], messageReads: 0 },
}));

vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({
    from: (table: string) => {
      const preds: Array<(r: Record<string, unknown>) => boolean> = [];
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = (col: string, val: unknown) => {
        if (table === "agent_threads" && col === "id") preds.push((r) => r.id === val);
        return chain;
      };
      chain.is = (col: string, val: unknown) => {
        preds.push((r) => (r[col] ?? null) === val);
        return chain;
      };
      chain.filter = () => chain;
      chain.order = () => chain;
      chain.limit = async (n: number) => {
        if (table === "agent_threads") {
          const rows = db.threads.filter((r) => preds.every((p) => p(r as unknown as Record<string, unknown>)));
          return { data: rows.slice(0, n), error: null };
        }
        db.messageReads += 1;
        return { data: db.messages, error: null };
      };
      return chain;
    },
  }),
}));

import { agentChatHistory } from "../chat-history";

const LIVE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GONE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function call(query: Record<string, string>) {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
  return agentChatHistory({ params: { slug: "operator" }, query } as never, res as never).then(() => res);
}

beforeEach(() => {
  db.threads = [
    { id: GONE, title: "deleted", last_message_at: "2026-10-27T10:00:00Z", created_at: "2026-10-27T09:00:00Z", deleted_at: "2026-10-27T10:01:00Z" },
    { id: LIVE, title: "live", last_message_at: "2026-10-26T10:00:00Z", created_at: "2026-10-26T09:00:00Z", deleted_at: null },
  ];
  db.messages = [{ id: "m1", sender_role: "assistant", body: "old", agent_run_id: null, created_at: "2026-10-27T10:00:00Z" }];
  db.messageReads = 0;
});

describe("GET /api/agents/:slug/chat/history with a deleted chat", () => {
  it("returns 404 and no messages for a deleted thread_id", async () => {
    const res = await call({ thread_id: GONE });
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: { code: "not_found", message: "thread not found" } });
    expect(db.messageReads).toBe(0);
  });

  it("still loads a thread that is not deleted", async () => {
    const res = await call({ thread_id: LIVE });
    expect(res.statusCode).toBe(200);
    expect((res.body as { thread: { id: string } }).thread.id).toBe(LIVE);
  });

  it("skips a deleted thread when picking the latest chat", async () => {
    const res = await call({});
    expect(res.statusCode).toBe(200);
    expect((res.body as { thread: { id: string } }).thread.id).toBe(LIVE);
  });
});
