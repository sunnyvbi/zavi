import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};
let who = { user_id: "u1", tenant_id: "tenant-a" };

class Query {
  private filters: Array<(r: Row) => boolean> = [];
  constructor(private table: string) {}
  select() {
    return this;
  }
  eq(c: string, v: unknown) {
    this.filters.push((r) => r[c] === v);
    return this;
  }
  is(c: string, v: unknown) {
    this.filters.push((r) => (r[c] ?? null) === v);
    return this;
  }
  not(c: string, _op: string, v: unknown) {
    this.filters.push((r) => (r[c] ?? null) !== v);
    return this;
  }
  in(c: string, vs: unknown[]) {
    this.filters.push((r) => vs.includes(r[c]));
    return this;
  }
  gte(c: string, v: string) {
    this.filters.push((r) => String(r[c] ?? "") >= v);
    return this;
  }
  gt(c: string, v: string) {
    this.filters.push((r) => String(r[c] ?? "") > v);
    return this;
  }
  filter(c: string, op: string, v: unknown) {
    const m = /^(\w+)->>(\w+)$/.exec(c);
    if (!m || op !== "eq") throw new Error(`unsupported filter ${c} ${op}`);
    this.filters.push((r) => ((r[m[1]] as Record<string, unknown> | null)?.[m[2]] ?? null) === v);
    return this;
  }
  order() {
    return this;
  }
  limit() {
    return this;
  }
  then<T>(ok: (v: { data: unknown; error: unknown }) => T) {
    const hit = (db[this.table] ?? []).filter((r) => this.filters.every((f) => f(r)));
    return Promise.resolve({ data: hit.map((r) => ({ ...r })), error: null }).then(ok);
  }
}

vi.mock("@/services/auth/middleware", () => ({ requireAuth: async () => ({ ...who, access_token: "t" }) }));
vi.mock("@/services/supabase", () => ({ serviceClient: vi.fn(), serverClientFromBearer: vi.fn() }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => ({ from: (t: string) => new Query(t) }),
  tenantRpc: vi.fn(),
}));

import { getGrowthYouAsked } from "../head-of-growth";

const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

function thread(over: Row = {}): Row {
  return { id: "th-1", tenant_id: "tenant-a", user_id: "u1", agent_slug: "cgo", deleted_at: null, synthetic: false, ...over };
}
function ask(over: Row = {}): Row {
  return { id: "m-q", tenant_id: "tenant-a", thread_id: "th-1", sender_role: "user", body: "What CPA should I expect?", meta: { via: "email", reply_run_id: "run-1" }, agent_run_id: null, created_at: ago(5), ...over };
}
function reply(over: Row = {}): Row {
  return { id: "m-a", tenant_id: "tenant-a", thread_id: "th-1", sender_role: "assistant", body: "About $18 a signup at today's spend.", meta: { via: "email" }, agent_run_id: "run-1", created_at: ago(4.9), ...over };
}

async function call() {
  const res = { statusCode: 200, body: undefined as unknown, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; } };
  await getGrowthYouAsked({} as unknown as Request, res as unknown as Response);
  return res as { statusCode: number; body: { asked: { question: string; at: string; answer: string | null } | null } };
}

beforeEach(() => {
  who = { user_id: "u1", tenant_id: "tenant-a" };
  db.agent_threads = [thread()];
  db.agent_thread_messages = [ask(), reply()];
});

describe("GET /api/workspace/growth/you-asked", () => {
  it("the founder's emailed question and cgo's reply from the same run", async () => {
    const res = await call();
    expect(res.statusCode).toBe(200);
    expect(res.body.asked).toEqual({ question: "What CPA should I expect?", at: db.agent_thread_messages[0].created_at, answer: "About $18 a signup at today's spend." });
  });

  it("another member's thread in the same tenant is never read", async () => {
    who = { user_id: "u2", tenant_id: "tenant-a" };
    expect((await call()).body.asked).toBeNull();
  });

  it("another tenant's thread and messages are never read", async () => {
    db.agent_threads = [thread({ tenant_id: "tenant-b" })];
    db.agent_thread_messages = [ask({ tenant_id: "tenant-b" }), reply({ tenant_id: "tenant-b" })];
    expect((await call()).body.asked).toBeNull();
    db.agent_threads = [thread()];
    expect((await call()).body.asked).toBeNull();
  });

  it("a non-cgo thread, a deleted thread or a synthetic thread is not read", async () => {
    for (const over of [{ agent_slug: "operator" }, { deleted_at: ago(1) }, { synthetic: true }]) {
      db.agent_threads = [thread(over)];
      expect((await call()).body.asked).toBeNull();
    }
  });

  it("a message with no question, a chat message, a superseded one, or one older than 7 days is not 'You asked'", async () => {
    for (const over of [
      { body: "Thanks, go ahead." },
      { meta: { reply_run_id: "run-1" } },
      { meta: { via: "email", reply_run_id: "run-1", superseded_by: "m-x" } },
      { created_at: ago(24 * 8) },
    ]) {
      db.agent_thread_messages = [ask(over), reply()];
      expect((await call()).body.asked).toBeNull();
    }
  });

  it("no reply from that run yet: the question with answer null", async () => {
    db.agent_thread_messages = [ask(), reply({ agent_run_id: "run-other" })];
    expect((await call()).body.asked).toMatchObject({ question: "What CPA should I expect?", answer: null });
    db.agent_thread_messages = [ask({ meta: { via: "email" } }), reply()];
    expect((await call()).body.asked).toMatchObject({ answer: null });
  });

  it("a reply after the founder's next message is not the answer", async () => {
    db.agent_thread_messages = [ask(), { ...ask({ id: "m-next", body: "Also, hold Reddit.", meta: { via: "chat" }, created_at: ago(4.95) }) }, reply()];
    expect((await call()).body.asked).toMatchObject({ question: "What CPA should I expect?", answer: null });
  });

  it("the latest emailed question wins, clipped at a word", async () => {
    const long = `${"Which channel ".repeat(40)}should I fund?`;
    db.agent_thread_messages = [ask({ created_at: ago(30) }), reply({ created_at: ago(29) }), ask({ id: "m-q2", body: long, meta: { via: "email", reply_run_id: "run-2" }, created_at: ago(2) })];
    const asked = (await call()).body.asked!;
    expect(asked.question.length).toBeLessThanOrEqual(300);
    expect(asked.question).toMatch(/ (Which|channel)…\?$/);
    expect(asked.answer).toBeNull();
  });
});
