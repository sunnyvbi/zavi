import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const PG_URL = process.env.ZAVI_TEST_PG_URL ?? process.env.ZAVI_TEST_VANILLA_PG_URL;
const host = (() => {
  try {
    return PG_URL ? new URL(PG_URL).hostname : null;
  } catch {
    return null;
  }
})();
const SHOULD_RUN = !!PG_URL && (host === "127.0.0.1" || host === "localhost" || host === "::1");
if (process.env.REQUIRE_RLS_MATRIX === "1" && !SHOULD_RUN) {
  throw new Error(`[team-note-quiet-live] REQUIRE_RLS_MATRIX=1 but the suite would skip (url=${!!PG_URL}).`);
}
const MIGRATIONS = join(__dirname, "../../../../../supabase/migrations");
const read = (f: string) => readFileSync(join(MIGRATIONS, f), "utf8");

const h = vi.hoisted(() => ({ a: null as import("pg").Client | null }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => { throw new Error("not used here"); },
  tenantRpc: async (tenantId: string, fn: string, args: Record<string, unknown>) => {
    const names = Object.keys(args);
    const sql = `select public.${fn}(p_tenant_id => $1${names.map((k, i) => `, ${k} => $${i + 2}`).join("")}) as r`;
    try {
      const { rows } = await h.a!.query(sql, [tenantId, ...names.map((k) => args[k])]);
      return { data: rows[0]?.r ?? null, error: null };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      return { data: null, error: { code: err.code, message: err.message } };
    }
  },
}));
vi.mock("@/services/settings", () => ({
  getNumberSetting: async (k: string) =>
    ({ team_note_max_per_thread: 1, team_note_thread_window_hours: 24, team_note_max_per_day: 1,
       team_note_stop_offer_after_dismissals: 1, team_note_retention_days: 180 } as Record<string, number>)[k],
}));

import { claimJudgement, markShown, offerNote, promoteNote, sendNote } from "@/services/team-notes/store";

const BOOTSTRAP = `
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
  end $$;
  create schema if not exists auth;
  create table auth.users (id uuid primary key, email text);
  create or replace function auth.uid() returns uuid language sql as 'select null::uuid';
  create table public.tenants (id uuid primary key);
  create table public.tenant_users (tenant_id uuid references public.tenants(id), user_id uuid, role text);
  create or replace function public.app_active_tenant() returns uuid language sql as 'select null::uuid';
  create table public.agent_threads (id uuid primary key, tenant_id uuid not null, agent_slug text, user_id uuid);
  create table public.agent_runs (id uuid primary key, tenant_id uuid not null, agent_slug text, status text, error text);
  create table public.agent_thread_messages (
    id uuid primary key, thread_id uuid not null references public.agent_threads(id) on delete cascade,
    tenant_id uuid not null, sender_role text not null, body text, agent_run_id uuid, meta jsonb,
    created_at timestamptz not null default clock_timestamp());
`;

const T = randomUUID();
const U = randomUUID();
const settledWithin = <V>(p: Promise<V>, ms: number) =>
  Promise.race([p.then(() => "settled" as const), new Promise<"pending">((r) => setTimeout(() => r("pending"), ms))]);

describe.skipIf(!SHOULD_RUN)("20261110100000 team note quiet, live (two connections)", () => {
  let admin: Client;
  let a: Client;
  let b: Client;
  let dbName = "";
  const q = async (c: Client, sql: string, p: unknown[] = []) => (await c.query(sql, p)).rows;
  const offer = async (reply: string) => (await q(a, "select * from team_note_offers where message_id = $1", [reply]))[0];
  const metaState = async (reply: string) =>
    (await q(a, "select meta->>'team_note_state' s from agent_thread_messages where id = $1", [reply]))[0]?.s;

  async function turn() {
    const thread = randomUUID();
    const run = randomUUID();
    const [ask, reply, follow] = [randomUUID(), randomUUID(), randomUUID()];
    await q(a, "insert into agent_threads (id, tenant_id, agent_slug, user_id) values ($1, $2, 'operator', $3)", [thread, T, U]);
    await q(a, "insert into agent_runs (id, tenant_id, agent_slug, status) values ($1, $2, 'operator', 'success')", [run, T]);
    await q(a, "insert into agent_thread_messages (id, thread_id, tenant_id, sender_role, body) values ($1, $2, $3, 'user', 'ask')", [ask, thread, T]);
    await q(a, "insert into agent_thread_messages (id, thread_id, tenant_id, sender_role, body, agent_run_id) values ($1, $2, $3, 'assistant', 'reply', $4)", [reply, thread, T, run]);
    await q(a, "insert into agent_thread_messages (id, thread_id, tenant_id, sender_role, body) values ($1, $2, $3, 'user', 'no, wrong')", [follow, thread, T]);
    return { reply, follow };
  }
  const flagShown = async () => {
    const t = await turn();
    await offerNote(T, { messageId: t.reply, source: "run_end", signal: "other", signals: ["tool_repeat_failure"],
      fingerprint: "0123456789abcdef", note: "It went badly.", surface: "flag", anchorMessageId: null });
    await markShown(T, U, t.reply, "flag");
    return t;
  };

  beforeAll(async () => {
    admin = new Client({ connectionString: PG_URL });
    await admin.connect();
    dbName = `zavi_team_note_${randomBytes(6).toString("hex")}`;
    await admin.query(`create database ${dbName}`);
    const u = new URL(PG_URL!);
    u.pathname = `/${dbName}`;
    a = new Client({ connectionString: u.toString() });
    b = new Client({ connectionString: u.toString() });
    await a.connect();
    await b.connect();
    h.a = a;
    await a.query(BOOTSTRAP);
    await a.query(`insert into tenants values ('${T}'); insert into auth.users values ('${U}', 'f@x.test');
                   insert into tenant_users values ('${T}', '${U}', 'owner');`);
    await a.query(read("20261008120000_team_notes.sql"));
  });
  afterAll(async () => {
    await a?.end().catch(() => {});
    await b?.end().catch(() => {});
    if (admin) {
      if (dbName) await admin.query(`drop database if exists ${dbName} with (force)`).catch(() => {});
      await admin.end();
    }
  });

  it("backfill: an offer drafted while the migration runs is retired with its meta, never half-done", async () => {
    const t = await turn();
    await b.query("begin");
    await b.query("select team_note_offer($1, $2, 'run_end', 'other', array['run_failed'], '0123456789abcdef', 'n')", [T, t.reply]);
    const migrating = a.query(read("20261110100000_team_note_quiet.sql"));
    expect(await settledWithin(migrating, 400)).toBe("pending");
    await b.query("commit");
    await migrating;
    expect(await offer(t.reply)).toMatchObject({ status: "suppressed" });
    expect(await metaState(t.reply)).toBe("suppressed");
  });

  it("send holds the row; a concurrent promote waits, then sees the send and changes nothing", async () => {
    const t = await flagShown();
    await b.query("begin");
    await b.query("select team_note_send($1, $2, $3, 'note', null, 180)", [T, U, t.reply]);
    const promoting = promoteNote(T, { messageId: t.reply, anchorMessageId: t.follow, signals: ["founder_correction"] });
    expect(await settledWithin(promoting, 300)).toBe("pending");
    await b.query("commit");
    expect(await promoting).toEqual({ promoted: false, reason: "sent" });
    expect(await offer(t.reply)).toMatchObject({ status: "sent", surface: "flag", anchor_message_id: null });
  });

  it("promote holds the row; a concurrent send waits, then sends the promoted strip", async () => {
    const t = await flagShown();
    await b.query("begin");
    await b.query("select team_note_promote_v2($1, $2, $3, array['founder_correction'])", [T, t.reply, t.follow]);
    const sending = sendNote(T, U, t.reply, "note", null);
    expect(await settledWithin(sending, 300)).toBe("pending");
    await b.query("commit");
    expect(await sending).toMatchObject({ status: "sent", source: "correction" });
    expect(await offer(t.reply)).toMatchObject({ status: "sent", surface: "strip", anchor_message_id: t.follow });
  });

  it("a show in flight blocks a promote; the promote then keeps the cap the show spent", async () => {
    await q(a, "update team_note_offers set shown_at = now() - interval '2 days' where shown_at is not null");
    const t = await turn();
    await offerNote(T, { messageId: t.reply, source: "run_end", signal: "other", signals: ["run_failed"],
      fingerprint: "0123456789abcdef", note: "n", surface: "strip", anchorMessageId: t.reply });
    await b.query("begin");
    await b.query("select team_note_mark_shown_v2($1, $2, $3, 1, 24, 1, 1, 'strip')", [T, U, t.reply]);
    const promoting = promoteNote(T, { messageId: t.reply, anchorMessageId: t.follow, signals: ["founder_correction"] });
    expect(await settledWithin(promoting, 300)).toBe("pending");
    await b.query("commit");
    expect(await promoting).toMatchObject({ promoted: true, status: "shown" });
    expect(await offer(t.reply)).toMatchObject({ source: "correction", shown_via: "strip", capped_as: "run_end_strip" });
    const next = await turn();
    await offerNote(T, { messageId: next.reply, source: "run_end", signal: "other", signals: ["run_failed"],
      fingerprint: "0123456789abcdef", note: "n", surface: "strip", anchorMessageId: next.reply });
    expect(await markShown(T, U, next.reply, "strip")).toEqual({ show: false, reason: "daily_cap" });
  });

  it("two concurrent pushback upgrades of one claim: exactly one wins", async () => {
    const t = await turn();
    expect(await claimJudgement(T, t.reply, "run_end", ["tool_repeat_failure"], false)).toBe("claimed");
    await b.query("begin");
    const first = (await q(b, "select team_note_claim_judgement_v2($1, $2, 'correction', array['founder_correction'], false) r", [T, t.reply]))[0].r;
    const second = claimJudgement(T, t.reply, "correction", ["founder_frustration"], false);
    expect(await settledWithin(second, 300)).toBe("pending");
    await b.query("commit");
    expect(first).toBe("upgraded");
    expect(await second).toBe("taken");
    expect((await q(a, "select signals from team_note_judge_claims where message_id = $1", [t.reply]))[0].signals).toEqual(["founder_correction"]);
  });
});
