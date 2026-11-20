import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

type Db = {
  exec: (q: string) => Promise<unknown>;
  query: <R = Record<string, any>>(q: string, p?: unknown[]) => Promise<{ rows: R[] }>;
  close: () => Promise<void>;
};
const modules = process.env.SITES_SQL_TEST_MODULES;
const DIR = join(__dirname, "../../../../../supabase/migrations");
const read = (f: string) => readFileSync(join(DIR, f), "utf8").replace(/^(begin|commit);$/gm, "");

const h = vi.hoisted(() => ({ db: null as Db | null }));
async function call(fn: string, args: Record<string, unknown>, tenantId?: string) {
  const names = Object.keys(args);
  const head = tenantId ? ["p_tenant_id => $1"] : [];
  const off = tenantId ? 2 : 1;
  const sql = `select public.${fn}(${[...head, ...names.map((k, i) => `${k} => $${i + off}`)].join(", ")}) as r`;
  try {
    const { rows } = await h.db!.query<{ r: unknown }>(sql, [...(tenantId ? [tenantId] : []), ...names.map((k) => args[k])]);
    return { data: rows[0]?.r ?? null, error: null };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { data: null, error: { code: err.code, message: err.message ?? "error" } };
  }
}
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => { throw new Error("not used here"); },
  tenantRpc: (tenantId: string, fn: string, args: Record<string, unknown>) => call(fn, args, tenantId),
  opsRpc: async (fn: string, args: Record<string, unknown>) => {
    if (fn !== "claim_team_report_pings") return call(fn, args);
    try {
      const { rows } = await h.db!.query("select * from public.claim_team_report_pings($1)", [args.p_limit]);
      return { data: rows, error: null };
    } catch (e) {
      return { data: null, error: { message: (e as Error).message } };
    }
  },
}));
vi.mock("@/services/settings", () => ({ getNumberSetting: async () => 180 }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));

import { sendNote } from "@/services/team-notes/store";
import { drainTeamReportPings, teamReportPingText } from "@/services/team-notes/report-pings";

const TA = "00000000-0000-4000-8000-00000000aaa1";
const TB = "00000000-0000-4000-8000-00000000aaa2";
const U = "00000000-0000-4000-8000-0000000000c1";
const UB = "00000000-0000-4000-8000-0000000000c2";
const SECRET = "SECRET_NOTE_TEXT";
let seq = 0;
const uuid = () => `20000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

describe.skipIf(!modules)("20261110120000_team_note_staff (pglite)", () => {
  let db: Db;
  const one = async <R = Record<string, any>>(q: string, p: unknown[] = []) => (await db.query<R>(q, p)).rows[0];
  const rows = async <R = Record<string, any>>(q: string, p: unknown[] = []) => (await db.query<R>(q, p)).rows;

  async function shownNote(tenant = TA, user = U, agent = "operator") {
    const thread = uuid(); const reply = uuid();
    await db.query("insert into agent_threads (id, tenant_id, agent_slug, user_id) values ($1, $2, $3, $4)", [thread, tenant, agent, user]);
    await db.query("insert into agent_thread_messages (id, thread_id, tenant_id, sender_role, body) values ($1, $2, $3, 'assistant', 'reply')", [reply, thread, tenant]);
    await db.query("select team_note_offer_v2($1, $2, 'run_end', 'tool_failure', array['run_failed'], '0123456789abcdef', $3, 'strip', $2)", [tenant, reply, SECRET]);
    await db.query("select team_note_mark_shown_v2($1, $2, $3, 50, 24, 50, 0, 'strip')", [tenant, user, reply]);
    return { thread, reply };
  }

  beforeAll(async () => {
    const { PGlite } = createRequire(resolve(modules!, "../package.json"))("@electric-sql/pglite");
    db = new PGlite() as Db;
    h.db = db;
    await db.exec(`
      do $$ begin
        if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
        if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
        if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
      end $$;
      create schema if not exists auth;
      create table auth.users (id uuid primary key, email text);
      create or replace function auth.uid() returns uuid language sql as 'select null::uuid';
      create table public.tenants (id uuid primary key, slug text, display_name text);
      create table public.tenant_users (tenant_id uuid references public.tenants(id), user_id uuid, role text);
      create or replace function public.app_active_tenant() returns uuid language sql as 'select null::uuid';
      create table public.agent_threads (id uuid primary key, tenant_id uuid not null, agent_slug text, user_id uuid);
      create table public.agent_runs (id uuid primary key, tenant_id uuid not null, agent_slug text, status text, error text);
      create table public.agent_thread_messages (
        id uuid primary key, thread_id uuid not null references public.agent_threads(id) on delete cascade,
        tenant_id uuid not null, sender_role text not null, body text, agent_run_id uuid, meta jsonb,
        created_at timestamptz not null default clock_timestamp());
      insert into public.tenants values ('${TA}', 'acme', 'Acme'), ('${TB}', 'beta', 'Beta');
      insert into auth.users values ('${U}', 'a@x.test'), ('${UB}', 'b@x.test');
      insert into public.tenant_users values ('${TA}', '${U}', 'owner'), ('${TB}', '${UB}', 'owner');
    `);
    for (const f of ["20261008120000_team_notes.sql", "20261110100000_team_note_quiet.sql", "20261110120000_team_note_staff.sql"]) {
      await db.exec(read(f));
    }
  }, 120_000);
  afterAll(async () => db?.close());

  beforeEach(async () => {
    await db.exec("delete from team_report_pings; delete from team_reports; delete from team_note_offers; delete from team_note_judgements;");
  });

  describe("send enqueues the ping in the same transaction", () => {
    it("first send: report + one pending ping due at the 10-minute window's end; codes only", async () => {
      const n = await shownNote();
      const sent = await sendNote(TA, U, n.reply, SECRET, "more " + SECRET);
      expect(sent).toMatchObject({ status: "sent", first: true });
      const p = await one("select * from team_report_pings");
      expect(Number(sent.ping_id)).toBe(Number(p.id));
      expect(Number((await one<{ d: string }>("select team_report_ping_due_at($1) as d", [p.id])).d ? 1 : 0)).toBe(1);
      expect(p).toMatchObject({ tenant_id: TA, agent_slug: "operator", signal: "tool_failure", send_count: 1, status: "pending", attempts: 0 });
      expect(new Date(p.next_attempt_at).getTime() - new Date(p.window_start).getTime()).toBe(10 * 60_000);
      expect(new Date(p.window_start).getUTCMinutes() % 10).toBe(0);
      expect(JSON.stringify(p)).not.toContain(SECRET);
    });

    it("more sends in the same window bump the counter; an idempotent retry does not", async () => {
      const a = await shownNote();
      const b = await shownNote(TA, U, "pm");
      await sendNote(TA, U, a.reply, "n", null);
      await sendNote(TA, U, a.reply, "n", null);
      await sendNote(TA, U, b.reply, "n", null);
      expect(await rows("select send_count, agent_slug from team_report_pings")).toEqual([{ send_count: 2, agent_slug: "pm" }]);
      const other = await shownNote(TB, UB);
      await sendNote(TB, UB, other.reply, "n", null);
      expect((await rows("select tenant_id from team_report_pings order by tenant_id")).map((r) => r.tenant_id)).toEqual([TA, TB]);
    });

    it("a send after the drainer claimed the window's row opens the next window's row (never folded into a claimed ping)", async () => {
      const a = await shownNote(); const b = await shownNote(); const c = await shownNote();
      await sendNote(TA, U, a.reply, "n", null);
      await db.exec("update team_report_pings set next_attempt_at = now() - interval '1 second'");
      const [claimed] = await rows("select * from claim_team_report_pings(10)");
      await sendNote(TA, U, b.reply, "n", null);
      const after = await rows("select window_start, send_count, status from team_report_pings order by window_start");
      expect(after).toHaveLength(2);
      expect(after[0]).toMatchObject({ send_count: 1, status: "sending" });
      expect(after[1]).toMatchObject({ send_count: 1, status: "pending" });
      expect(new Date(after[1].window_start).getTime() - new Date(after[0].window_start).getTime()).toBe(10 * 60_000);
      await db.query("select finish_team_report_ping($1, $2, 'sent', null)", [claimed.id, claimed.attempts]);
      expect((await one("select team_report_ping_due_at($1) as d", [claimed.id])).d).toBeNull();
      await sendNote(TA, U, c.reply, "n", null);
      expect((await rows("select send_count, status from team_report_pings order by window_start")).map((r) => [r.send_count, r.status]))
        .toEqual([[1, "sent"], [2, "pending"]]);
    });

    it("a send after the window's ping was sent is pinged in the next window", async () => {
      const a = await shownNote(); const b = await shownNote();
      await sendNote(TA, U, a.reply, "n", null);
      await db.exec("update team_report_pings set status = 'sent', sent_at = now()");
      await sendNote(TA, U, b.reply, "n", null);
      expect((await rows("select send_count, status from team_report_pings order by window_start")).map((r) => [r.send_count, r.status]))
        .toEqual([[1, "sent"], [1, "pending"]]);
    });

    it("a send that fails stores neither the report nor the ping (one transaction)", async () => {
      const n = await shownNote();
      await expect(sendNote(TA, U, n.reply, "x".repeat(1001), null)).rejects.toMatchObject({ code: "invalid" });
      expect(await rows("select 1 from team_reports")).toHaveLength(0);
      expect(await rows("select 1 from team_report_pings")).toHaveLength(0);
    });

    it("a send on a note that was never shown is closed and enqueues nothing", async () => {
      const thread = uuid(); const reply = uuid();
      await db.query("insert into agent_threads (id, tenant_id, agent_slug, user_id) values ($1, $2, 'operator', $3)", [thread, TA, U]);
      await db.query("insert into agent_thread_messages (id, thread_id, tenant_id, sender_role, body) values ($1, $2, $3, 'assistant', 'r')", [reply, thread, TA]);
      await db.query("select team_note_offer_v2($1, $2, 'run_end', 'other', '{}', '0123456789abcdef', 'n', 'flag', null)", [TA, reply]);
      expect(await sendNote(TA, U, reply, "n", null)).toEqual({ status: "closed" });
      expect(await rows("select 1 from team_report_pings")).toHaveLength(0);
    });
  });

  describe("ping drain", () => {
    const due = () => db.exec("update team_report_pings set next_attempt_at = now() - interval '1 second' where status = 'pending'");

    it("not due before the window closes", async () => {
      const n = await shownNote();
      await sendNote(TA, U, n.reply, "n", null);
      const post = vi.fn(async () => ({ ok: true, status: 200 }));
      expect(await drainTeamReportPings({ webhook: () => "https://hooks.example/x", post })).toMatchObject({ claimed: 0 });
      expect(post).not.toHaveBeenCalled();
    });

    it("delivers once with slug, agent, signal, count and the admin link, and never the note", async () => {
      const a = await shownNote(); const b = await shownNote();
      await sendNote(TA, U, a.reply, SECRET, SECRET);
      await sendNote(TA, U, b.reply, SECRET, null);
      await due();
      const post = vi.fn(async (_u: string, _b: { text: string }) => ({ ok: true, status: 200 }));
      expect(await drainTeamReportPings({ webhook: () => "https://hooks.example/x", post })).toMatchObject({ claimed: 1, sent: 1, batches: 1 });
      const text = post.mock.calls[0][1].text;
      expect(text).toBe(teamReportPingText({ tenant_slug: "acme", agent_slug: "operator", signal: "tool_failure", send_count: 2 }));
      expect(text).toContain("acme");
      expect(text).toContain("2 reports");
      expect(text).toContain("https://admin.zaviagent.com/team-notes");
      expect(text).not.toContain(SECRET);
      expect(await one("select status, sent_at is not null as sent from team_report_pings")).toEqual({ status: "sent", sent: true });
      expect(await drainTeamReportPings({ webhook: () => "https://hooks.example/x", post })).toMatchObject({ claimed: 0 });
    });

    it("webhook unset: skipped, never posted, never replayed later", async () => {
      const n = await shownNote();
      await sendNote(TA, U, n.reply, "n", null);
      await due();
      const post = vi.fn();
      expect(await drainTeamReportPings({ webhook: () => undefined, post })).toMatchObject({ claimed: 1, skipped: 1 });
      expect(post).not.toHaveBeenCalled();
      expect((await one("select status from team_report_pings")).status).toBe("skipped");
      expect(await drainTeamReportPings({ webhook: () => "https://hooks.example/x", post })).toMatchObject({ claimed: 0 });
    });

    it("a failed POST backs off and the 6th attempt parks the row as failed", async () => {
      const n = await shownNote();
      await sendNote(TA, U, n.reply, "n", null);
      const post = vi.fn(async () => ({ ok: false, status: 503 }));
      for (let i = 1; i <= 6; i++) {
        await due();
        const r = await drainTeamReportPings({ webhook: () => "https://hooks.example/x", post });
        expect(r.claimed).toBe(1);
        const p = await one("select status, attempts, last_error, next_attempt_at > now() as later from team_report_pings");
        if (i < 6) expect(p).toMatchObject({ status: "pending", attempts: i, last_error: "http_503", later: true });
        else expect(p).toMatchObject({ status: "failed", attempts: 6 });
      }
      await due();
      expect(await drainTeamReportPings({ webhook: () => "https://hooks.example/x", post })).toMatchObject({ claimed: 0 });
    });

    it("a backlog bigger than one batch drains in one tick, batch by batch", async () => {
      await db.exec(`insert into team_report_pings (tenant_id, window_start, agent_slug, signal, next_attempt_at)
        select '${TA}', timestamptz '2026-01-01' + make_interval(mins => 10 * g), 'operator', 'other', now() - interval '1 second'
          from generate_series(1, 120) g`);
      const post = vi.fn(async () => ({ ok: true, status: 200 }));
      expect(await drainTeamReportPings({ webhook: () => "https://hooks.example/x", post })).toMatchObject({ claimed: 120, sent: 120, batches: 3 });
      expect(post).toHaveBeenCalledTimes(120);
    });

    it("the claim lease outlasts a batch: a second drainer gets nothing while the first is still posting", async () => {
      const n = await shownNote();
      await sendNote(TA, U, n.reply, "n", null);
      await due();
      const [first] = await rows("select * from claim_team_report_pings(10)");
      expect(first).toBeTruthy();
      await db.query("update team_report_pings set next_attempt_at = next_attempt_at - interval '11 minutes' where id = $1", [first.id]);
      expect(await rows("select * from claim_team_report_pings(10)")).toHaveLength(0);
      const lease = await one("select next_attempt_at - now() > interval '3 minutes' as left from team_report_pings where id = $1", [first.id]);
      expect(lease.left).toBe(true);
    });

    it("a drainer that hits its deadline releases the rest; the next drain posts each ping exactly once", async () => {
      for (let i = 0; i < 3; i++) {
        const n = await shownNote(i === 0 ? TA : TB, i === 0 ? U : UB);
        await sendNote(i === 0 ? TA : TB, i === 0 ? U : UB, n.reply, "n", null);
        await db.query("update team_report_pings set window_start = window_start - make_interval(mins => 10 * $1::int) where status = 'pending' and attempts = 0 and send_count = 1 and id = (select max(id) from team_report_pings)", [i]);
      }
      await due();
      const posted: string[] = [];
      let t = 0;
      const post = vi.fn(async (_u: string, b: { text: string }) => { posted.push(b.text); t += 60_000; return { ok: true, status: 200 }; });
      const first = await drainTeamReportPings({ webhook: () => "https://hooks.example/x", post, now: () => t }, { deadlineMs: 60_000 });
      expect(first).toMatchObject({ sent: 1, released: 2 });
      const back = await rows("select status, attempts, next_attempt_at <= now() as due from team_report_pings where status <> 'sent'");
      expect(back).toEqual([{ status: "pending", attempts: 0, due: true }, { status: "pending", attempts: 0, due: true }]);
      const second = await drainTeamReportPings({ webhook: () => "https://hooks.example/x", post, now: () => 0 });
      expect(second).toMatchObject({ sent: 2, released: 0 });
      expect(posted).toHaveLength(3);
      expect((await rows("select status from team_report_pings")).every((r) => r.status === "sent")).toBe(true);
    });

    it("a stale fencing token cannot overwrite the new holder's outcome", async () => {
      const n = await shownNote();
      await sendNote(TA, U, n.reply, "n", null);
      await due();
      const [claimed] = await rows("select * from claim_team_report_pings(10)");
      expect((await one("select finish_team_report_ping($1, $2, 'sent', null) as ok", [claimed.id, claimed.attempts + 1])).ok).toBe(false);
      expect((await one("select finish_team_report_ping($1, $2, 'sent', null) as ok", [claimed.id, claimed.attempts])).ok).toBe(true);
      await expect(db.query("select finish_team_report_ping($1, 1, 'maybe', null)", [claimed.id])).rejects.toThrow(/unknown outcome/);
    });
  });

  describe("staff reads", () => {
    it("aggregates are separate, windowed, text-free and have no tenant column", async () => {
      const n = await shownNote();
      await sendNote(TA, U, n.reply, SECRET, null);
      await shownNote(TB, UB, "pm");
      for (const [t, v, s] of [[TA, "bad", "looping"], [TA, "no", null], [TB, "bad", "looping"]] as const) {
        await db.query("insert into team_note_judgements (tenant_id, agent_slug, source, signals, verdict, judge_signal, surface) values ($1, 'operator', 'run_end', array['tool_loop','tool_thrash'], $2, $3, $4)",
          [t, v, s, v === "bad" ? "flag" : null]);
      }
      await db.query("insert into team_note_judgements (tenant_id, agent_slug, source, signals, verdict, created_at) values ($1, 'operator', 'run_end', '{}', 'no', now() - interval '10 days')", [TA]);

      const j7 = await rows("select * from team_note_judgement_summary(7)");
      expect(j7.map((r) => [r.agent_slug, r.code_signal, r.judge_signal, r.source, r.surface, r.verdict])).toEqual([
        ["operator", "tool_loop", "looping", "run_end", "flag", "bad"],
        ["operator", "tool_loop", null, "run_end", null, "no"],
      ]);
      expect(j7.map((r) => Number(r.n))).toEqual([2, 1]);
      expect((await rows("select * from team_note_judgement_summary(30)")).map((r) => Number(r.n)).reduce((a, b) => a + b, 0)).toBe(4);

      const o7 = await rows("select * from team_note_offer_summary(7) order by agent_slug");
      expect(o7.map((r) => [r.agent_slug, r.code_signal, r.judge_signal, r.surface, r.status, Number(r.n)])).toEqual([
        ["operator", "run_failed", "tool_failure", "strip", "sent", 1],
        ["pm", "run_failed", "tool_failure", "strip", "shown", 1],
      ]);
      for (const r of [...j7, ...o7]) {
        expect(Object.keys(r)).not.toContain("tenant_id");
        expect(JSON.stringify(r)).not.toContain(SECRET);
      }
      await expect(db.query("select * from team_note_offer_summary(14)")).rejects.toThrow(/days must be 7 or 30/);
    });

    it("the report list is metadata only, newest first, with a keyset cursor", async () => {
      const made: string[] = [];
      for (let i = 0; i < 3; i++) {
        const n = await shownNote();
        await sendNote(TA, U, n.reply, `${SECRET}-${i}`, i === 0 ? "extra" : null);
        made.push((await one("select id from team_reports where message_id = $1", [n.reply])).id);
      }
      await db.query("update team_reports set created_at = now() - make_interval(mins => (3 - position)::int), expires_at = now() + interval '170 days' from (select id, row_number() over (order by created_at) as position from team_reports) x where x.id = team_reports.id");
      const page1 = await rows("select * from team_reports_staff_list(null, null, 2)");
      expect(page1).toHaveLength(2);
      expect(page1[0]).toMatchObject({ tenant_slug: "acme", tenant_name: "Acme", agent_slug: "operator", signal: "tool_failure", source: "run_end", status: "new" });
      for (const r of page1) {
        expect(Object.keys(r).sort()).toEqual(["agent_slug", "created_at", "has_extra", "id", "message_id", "note_edited", "signal", "source",
          "status", "tenant_id", "tenant_name", "tenant_slug", "thread_id"]);
        expect(JSON.stringify(r)).not.toContain(SECRET);
      }
      const last = page1[1];
      const page2 = await rows("select * from team_reports_staff_list($1, $2, 2)", [last.created_at, last.id]);
      expect(page2).toHaveLength(1);
      expect(new Set([...page1, ...page2].map((r) => r.id))).toEqual(new Set(made));
      expect(page2[0].has_extra).toBe(true);
      expect(page1.every((r) => r.has_extra === false)).toBe(true);
      await expect(db.query("select * from team_reports_staff_list(now(), null, 2)")).rejects.toThrow(/cursor needs both parts/);
    });

    it("a report whose chat was deleted still lists, with null links", async () => {
      const n = await shownNote();
      await sendNote(TA, U, n.reply, "n", null);
      await db.query("delete from agent_threads where id = $1", [n.thread]);
      expect(await rows("select thread_id, message_id from team_reports_staff_list(null, null, 10)")).toEqual([{ thread_id: null, message_id: null }]);
    });

    it("authenticated can execute none of the staff RPCs nor read the pings", async () => {
      await db.exec("set role authenticated");
      try {
        for (const q of ["select * from team_note_judgement_summary(7)", "select * from team_note_offer_summary(7)",
          "select * from team_reports_staff_list(null, null, 1)", "select * from claim_team_report_pings(1)",
          "select count(*) from team_report_pings"]) {
          await expect(db.query(q)).rejects.toThrow(/permission denied/);
        }
      } finally {
        await db.exec("reset role");
      }
    });
  });

  it("purge drops settled pings after 30 days and keeps pending ones", async () => {
    await db.exec(`insert into team_report_pings (tenant_id, window_start, agent_slug, signal, status, next_attempt_at, created_at) values
      ('${TA}', now() - interval '40 days', 'operator', 'other', 'sent', now(), now() - interval '40 days'),
      ('${TA}', now() - interval '41 days', 'operator', 'other', 'pending', now(), now() - interval '41 days'),
      ('${TA}', now() - interval '2 days', 'operator', 'other', 'skipped', now(), now() - interval '2 days')`);
    const r = await one<{ r: { deleted: number } }>("select purge_expired_team_notes_v2(100, 400) as r");
    expect(r.r.deleted).toBe(1);
    expect((await rows("select status from team_report_pings order by created_at")).map((x) => x.status)).toEqual(["pending", "skipped"]);
  });
});
