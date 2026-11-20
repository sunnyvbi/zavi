import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const MIGRATIONS = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20261114230000_attention_signal_and_latest_reply.sql";

type Db = {
  exec: (q: string) => Promise<unknown>;
  query: <R = Record<string, unknown>>(q: string, p?: unknown[]) => Promise<{ rows: R[] }>;
  close: () => Promise<void>;
};

const SCHEMA = `
  create role anon; create role authenticated; create role service_role;
  create table tenants (id uuid primary key);
  create table thread_event (
    id bigint generated always as identity primary key,
    tenant_id uuid not null, agent_run_id uuid, thread_id uuid, agent_slug text not null,
    kind text not null check (kind in ('chat_user','chat_assistant','run_start','reasoning','plan',
      'plan_critic_verdict','tool_call','file_read','file_edit','file_create','decision','run_end')),
    body jsonb not null, citations jsonb not null default '[]'::jsonb, created_at timestamptz not null default now()
  );
  create table decisions (
    id uuid primary key default gen_random_uuid(), tenant_id uuid not null, agent_run_id uuid,
    decision_class text not null default 'x', body jsonb not null default '{}'::jsonb,
    status text default 'proposed', emitted_at timestamptz default now(), autonomy_at_emit text,
    archived_at timestamptz, snoozed_until timestamptz, home text
  );
  create table agent_thread_messages (
    id uuid primary key default gen_random_uuid(), thread_id uuid not null, tenant_id uuid not null,
    sender_role text not null, body text not null, meta jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
  );
`;

const modules = process.env.SITES_SQL_TEST_MODULES;

describe(`${FILE} executed in Postgres (pglite)`, () => {
  let db: Db;
  let T = "";

  beforeAll(async () => {
    const { PGlite } = modules
      ? createRequire(resolve(modules, "../package.json"))("@electric-sql/pglite")
      : await import("@electric-sql/pglite");
    db = new PGlite();
    await db.exec(SCHEMA);
    await db.exec(readFileSync(join(MIGRATIONS, FILE), "utf-8"));
  }, 30_000);
  afterAll(async () => {
    await db?.close();
  });
  beforeEach(async () => {
    T = randomUUID();
    await db.query("insert into tenants values ($1)", [T]);
  });

  const rings = async () =>
    (
      await db.query<{ agent_slug: string; agent_run_id: string | null; thread_id: string | null; body: Record<string, unknown> }>(
        "select agent_slug, agent_run_id, thread_id, body from thread_event where tenant_id = $1 and kind = 'attention' order by id",
        [T],
      )
    ).rows;
  const propose = async (status = "proposed", autonomy: string | null = "approval", cls = "meta.budget") =>
    (
      await db.query<{ id: string }>(
        "insert into decisions (tenant_id, agent_run_id, status, autonomy_at_emit, decision_class, home, body) values ($1, $2, $3, $4, $5, 'growth', '{\"secret\":\"spend $500\"}') returning id",
        [T, randomUUID(), status, autonomy, cls],
      )
    ).rows[0].id;

  describe("the attention doorbell", () => {
    it("rings once for a new card, with ids only and no run, thread or agent", async () => {
      const id = await propose();
      const r = await rings();
      expect(r).toEqual([{ agent_slug: "_attention", agent_run_id: null, thread_id: null, body: { decision_id: id, home: "growth" } }]);
      expect(JSON.stringify(r)).not.toContain("spend");
    });

    it("rings when the card leaves the pending view (approved, rejected)", async () => {
      const id = await propose();
      await db.query("update decisions set status = 'approved' where id = $1", [id]);
      expect(await rings()).toHaveLength(2);
    });

    it("rings on snooze and archive while pending", async () => {
      const id = await propose();
      await db.query("update decisions set snoozed_until = now() + interval '1 day' where id = $1", [id]);
      await db.query("update decisions set archived_at = now() where id = $1", [id]);
      expect(await rings()).toHaveLength(3);
    });

    it("stays quiet for an edit that cannot move the card in or out of the view", async () => {
      const id = await propose();
      await db.query("update decisions set body = '{\"a\":1}' where id = $1", [id]);
      expect(await rings()).toHaveLength(1);
    });

    it("stays quiet for an auto decision: it never waits on anyone", async () => {
      const id = await propose("proposed", "auto");
      await db.query("update decisions set status = 'acted' where id = $1", [id]);
      expect(await rings()).toHaveLength(0);
    });

    it("stays quiet for a dispatch-specialist row the pending view hides", async () => {
      const id = await propose("proposed", "approval", "cgo.dispatch-specialist");
      await db.query("update decisions set status = 'approved' where id = $1", [id]);
      expect(await rings()).toHaveLength(0);
    });

    it("stays quiet for a card that was never pending", async () => {
      const id = await propose("approved");
      await db.query("update decisions set status = 'acted' where id = $1", [id]);
      expect(await rings()).toHaveLength(0);
    });
  });

  describe("latest_assistant_messages", () => {
    const msg = (thread: string, role: string, body: string, at: string, meta: object = {}) =>
      db.query("insert into agent_thread_messages (thread_id, tenant_id, sender_role, body, meta, created_at) values ($1, $2, $3, $4, $5, $6)", [
        thread,
        T,
        role,
        body,
        JSON.stringify(meta),
        at,
      ]);

    it("returns each thread's newest assistant message, never a user message", async () => {
      const a = randomUUID();
      const b = randomUUID();
      await msg(a, "assistant", "old answer", "2026-10-24T10:00:00Z");
      await msg(a, "assistant", "new answer", "2026-10-24T11:00:00Z");
      await msg(a, "user", "thanks", "2026-10-24T12:00:00Z");
      await msg(b, "assistant", "Which city?", "2026-10-24T09:00:00Z", { envelope_schema: "clarifying_questions" });
      const rows = (
        await db.query<{ thread_id: string; body_head: string; is_question: boolean }>(
          "select thread_id, body_head, is_question from latest_assistant_messages($1::uuid[])",
          [[a, b]],
        )
      ).rows;
      const byId = Object.fromEntries(rows.map((r) => [r.thread_id, r]));
      expect(rows).toHaveLength(2);
      expect(byId[a]).toMatchObject({ body_head: "new answer", is_question: false });
      expect(byId[b]).toMatchObject({ body_head: "Which city?", is_question: true });
    });

    it("cuts the body to its head", async () => {
      const a = randomUUID();
      await msg(a, "assistant", "x".repeat(5000), "2026-10-24T10:00:00Z");
      const [row] = (await db.query<{ body_head: string }>("select body_head from latest_assistant_messages($1::uuid[])", [[a]])).rows;
      expect(row.body_head).toHaveLength(400);
    });

    it("returns nothing for a thread with no assistant reply", async () => {
      const a = randomUUID();
      await msg(a, "user", "hello", "2026-10-24T10:00:00Z");
      expect((await db.query("select * from latest_assistant_messages($1::uuid[])", [[a]])).rows).toEqual([]);
    });
  });
});
