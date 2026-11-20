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

const h = vi.hoisted(() => ({ db: null as Db | null, settings: {} as Record<string, number> }));

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => { throw new Error("not used here"); },
  tenantRpc: async (tenantId: string, fn: string, args: Record<string, unknown>) => {
    const names = Object.keys(args);
    const params = [tenantId, ...names.map((k) => args[k])];
    const sql = `select public.${fn}(p_tenant_id => $1${names.map((k, i) => `, ${k} => $${i + 2}`).join("")}) as r`;
    try {
      const { rows } = await h.db!.query<{ r: unknown }>(sql, params);
      return { data: rows[0]?.r ?? null, error: null };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      return { data: null, error: { code: err.code, message: err.message } };
    }
  },
}));
vi.mock("@/services/settings", () => ({
  getNumberSetting: async (k: string) => {
    if (!(k in h.settings)) throw new Error(`unexpected setting ${k}`);
    return h.settings[k];
  },
}));

import {
  TeamNoteError, canOffer, claimJudgement, dismissNote, markShown, offerNote, promoteNote, recordJudgement, sendNote,
} from "@/services/team-notes/store";
import { classifyRunError, noteSurface } from "@/services/team-notes/signals";

const TA = "00000000-0000-4000-8000-00000000aaa1";
const TB = "00000000-0000-4000-8000-00000000aaa2";
const U = "00000000-0000-4000-8000-0000000000c1";
const OTHER = "00000000-0000-4000-8000-0000000000c3";
let seq = 0;
const uuid = () => `10000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

const DEFAULTS = {
  team_note_max_per_thread: 1, team_note_thread_window_hours: 24, team_note_max_per_day: 1,
  team_note_stop_offer_after_dismissals: 1, team_note_retention_days: 180,
};

describe.skipIf(!modules)("20261110100000_team_note_quiet (pglite, through store.ts)", () => {
  let db: Db;
  const one = async <R = Record<string, any>>(q: string, p: unknown[] = []) => (await db.query<R>(q, p)).rows[0];

  async function turn(opts: { tenant?: string; thread?: string; status?: string; error?: string | null } = {}) {
    const tenant = opts.tenant ?? TA;
    const thread = opts.thread ?? uuid();
    if (!opts.thread) {
      await db.query("insert into agent_threads (id, tenant_id, agent_slug, user_id) values ($1, $2, 'operator', $3)", [thread, tenant, U]);
    }
    const run = uuid();
    await db.query("insert into agent_runs (id, tenant_id, agent_slug, status, error) values ($1, $2, 'operator', $3, $4)",
      [run, tenant, opts.status ?? "success", opts.error ?? null]);
    const ask = uuid();
    const reply = uuid();
    const follow = uuid();
    await db.query("insert into agent_thread_messages (id, thread_id, tenant_id, sender_role, body, created_at) values ($1, $2, $3, 'user', 'ask', clock_timestamp())", [ask, thread, tenant]);
    await db.query("insert into agent_thread_messages (id, thread_id, tenant_id, sender_role, body, agent_run_id, created_at) values ($1, $2, $3, 'assistant', 'reply', $4, clock_timestamp())", [reply, thread, tenant, run]);
    await db.query("insert into agent_thread_messages (id, thread_id, tenant_id, sender_role, body, created_at) values ($1, $2, $3, 'user', 'no, that is wrong', clock_timestamp())", [follow, thread, tenant]);
    return { thread, run, ask, reply, follow };
  }

  const draft = (t: { reply: string }, surface: "strip" | "flag", anchor: string | null, source = "run_end") =>
    offerNote(TA, { messageId: t.reply, source, signal: "other", signals: ["run_failed"], fingerprint: "0123456789abcdef",
      note: "It went badly.", surface, anchorMessageId: anchor });
  const offer = (reply: string) => one("select * from team_note_offers where message_id = $1", [reply]);
  const meta = async (reply: string) => (await one<{ meta: any }>("select meta from agent_thread_messages where id = $1", [reply])).meta;

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
      create table public.tenants (id uuid primary key);
      create table public.tenant_users (tenant_id uuid references public.tenants(id), user_id uuid, role text);
      create or replace function public.app_active_tenant() returns uuid language sql as 'select null::uuid';
      create table public.agent_threads (id uuid primary key, tenant_id uuid not null, agent_slug text, user_id uuid);
      create table public.agent_runs (id uuid primary key, tenant_id uuid not null, agent_slug text, status text, error text);
      create table public.agent_thread_messages (
        id uuid primary key, thread_id uuid not null references public.agent_threads(id) on delete cascade,
        tenant_id uuid not null, sender_role text not null, body text, agent_run_id uuid, meta jsonb,
        created_at timestamptz not null default now());
      insert into public.tenants values ('${TA}'), ('${TB}');
      insert into auth.users values ('${U}', 'f@x.test'), ('${OTHER}', 'o@x.test');
      insert into public.tenant_users values ('${TA}', '${U}', 'owner'), ('${TB}', '${OTHER}', 'owner');
    `);
    await db.exec(read("20261008120000_team_notes.sql"));
  }, 120_000);
  afterAll(async () => db?.close());

  describe("backfill", () => {
    it("suppresses every open note from before the migration; sent notes untouched", async () => {
      const open1 = await turn();
      const open2 = await turn();
      const sent = await turn();
      for (const t of [open1, open2, sent]) {
        await db.query("select team_note_offer($1, $2, 'run_end', 'other', array['run_failed'], '0123456789abcdef', 'note')", [TA, t.reply]);
      }
      await db.query("select team_note_mark_shown($1, $2, $3, 9, 24, 9, 0)", [TA, U, open2.reply]);
      await db.query("select team_note_mark_shown($1, $2, $3, 9, 24, 9, 0)", [TA, U, sent.reply]);
      await db.query("select team_note_send($1, $2, $3, 'note', null, 180)", [TA, U, sent.reply]);

      await db.exec(read("20261110100000_team_note_quiet.sql"));

      for (const t of [open1, open2]) {
        expect(await offer(t.reply)).toMatchObject({ status: "suppressed", surface: "strip", anchor_message_id: null });
        expect((await offer(t.reply)).resolved_at).not.toBeNull();
        expect((await meta(t.reply)).team_note_state).toBe("suppressed");
      }
      expect(await offer(open1.reply)).toMatchObject({ shown_via: null, capped_as: null });
      expect(await offer(open2.reply)).toMatchObject({ shown_via: "strip", capped_as: "run_end_strip" });
      expect(await offer(sent.reply)).toMatchObject({ status: "sent", shown_via: "strip", capped_as: "run_end_strip" });
      expect((await meta(sent.reply)).team_note_state).toBe("sent");

      h.settings = { ...DEFAULTS };
      expect(await canOffer(TA, (await turn()).reply, { applyCaps: true })).toBe("daily_cap");
      await db.query("update team_note_offers set shown_at = now() - interval '2 days' where shown_at is not null");
    });
  });

  beforeEach(async () => {
    h.settings = { ...DEFAULTS };
    await db.query("delete from team_note_offers where tenant_id = $1 and status <> 'sent'", [TA]).catch(() => undefined);
    await db.query("delete from team_note_prefs").catch(() => undefined);
  });

  describe("offer_v2", () => {
    it("writes surface + anchor on the row and the reply meta", async () => {
      const t = await turn({ status: "failed", error: "tool crashed" });
      const surface = noteSurface({ signals: ["run_failed"], errorClass: classifyRunError("tool crashed") });
      expect(surface).toBe("strip");
      expect(await draft(t, surface, t.reply)).toMatchObject({ offered: true });
      expect(await offer(t.reply)).toMatchObject({ status: "drafted", surface: "strip", anchor_message_id: t.reply });
      expect((await meta(t.reply)).team_note_draft).toMatchObject({ surface: "strip", anchor_message_id: t.reply, offer_stop: false });
    });

    it("a strip needs an anchor; an anchor must be in the reply's own thread; a bad surface is refused", async () => {
      const t = await turn();
      const elsewhere = await turn();
      await expect(draft(t, "strip", null)).rejects.toMatchObject({ code: "invalid" });
      await expect(draft(t, "strip", elsewhere.follow)).rejects.toBeInstanceOf(TeamNoteError);
      await expect(draft(t, "banner" as never, t.reply)).rejects.toMatchObject({ code: "invalid" });
      expect(await offer(t.reply)).toBeUndefined();
      expect(await draft(t, "flag", null)).toMatchObject({ offered: true });
    });

    it("cross-tenant: a tenant-B call on a tenant-A reply is not found", async () => {
      const t = await turn();
      const r = await offerNote(TB, { messageId: t.reply, source: "run_end", signal: "other", signals: [],
        fingerprint: "0123456789abcdef", note: "x", surface: "flag", anchorMessageId: null });
      expect(r).toEqual({ offered: false, reason: "not_found" });
    });
  });

  describe("caps: only run_end strips spend them", () => {
    it("a second run_end strip in a day is capped and suppressed; a flag and a pushback strip still show", async () => {
      const first = await turn();
      await draft(first, "strip", first.reply);
      expect(await markShown(TA, U, first.reply, "strip")).toMatchObject({ show: true, first: true, via: "strip" });

      const capped = await turn();
      expect(await canOffer(TA, capped.reply, { applyCaps: true })).toBe("daily_cap");
      await draft(capped, "strip", capped.reply);
      expect(await markShown(TA, U, capped.reply, "strip")).toEqual({ show: false, reason: "daily_cap" });
      expect(await offer(capped.reply)).toMatchObject({ status: "suppressed" });

      const flagged = await turn();
      expect(await canOffer(TA, flagged.reply, { applyCaps: false })).toBe("ok");
      await draft(flagged, "flag", null);
      expect(await markShown(TA, U, flagged.reply, "flag")).toMatchObject({ show: true, via: "flag", offer_stop: false });

      const pushed = await turn();
      await draft(pushed, "strip", pushed.follow, "correction");
      expect(await markShown(TA, U, pushed.reply, "strip")).toMatchObject({ show: true, first: true });
    });

    it("stop suggesting these: honoured on every path", async () => {
      const t = await turn();
      await draft(t, "flag", null);
      await db.query("insert into team_note_prefs (user_id, tenant_id, suggestions_off) values ($1, $2, true)", [U, TA]);
      expect(await canOffer(TA, (await turn()).reply, { applyCaps: false })).toBe("suggestions_off");
      expect(await markShown(TA, U, t.reply, "flag")).toEqual({ show: false, reason: "suggestions_off" });
      const p = await turn();
      expect(await draft(p, "flag", null)).toEqual({ offered: false, reason: "suggestions_off" });
    });

    it("a flag the founder already opened is never a strip, even when an old tab asks (already-shown path)", async () => {
      const t = await turn();
      await draft(t, "flag", null);
      await markShown(TA, U, t.reply, "flag");
      expect(await markShown(TA, U, t.reply, "strip")).toEqual({ show: false, reason: "flag_only" });
      expect(await offer(t.reply)).toMatchObject({ status: "shown", shown_via: "flag", capped_as: null });
      expect(await markShown(TA, U, t.reply, "flag")).toMatchObject({ show: true, first: false });
    });

    it("promoting a shown run_end strip keeps its cap: the next run_end strip is still capped", async () => {
      const t = await turn();
      await draft(t, "strip", t.reply);
      await markShown(TA, U, t.reply, "strip");
      expect((await offer(t.reply)).capped_as).toBe("run_end_strip");
      await promoteNote(TA, { messageId: t.reply, anchorMessageId: t.follow, signals: ["founder_correction"] });
      expect(await offer(t.reply)).toMatchObject({ source: "correction", capped_as: "run_end_strip" });
      const next = await turn();
      expect(await canOffer(TA, next.reply, { applyCaps: true })).toBe("daily_cap");
      await draft(next, "strip", next.reply);
      expect(await markShown(TA, U, next.reply, "strip")).toEqual({ show: false, reason: "daily_cap" });
    });

    it("an old tab asking for a strip on a flag-only note is refused and the note stays drafted", async () => {
      const t = await turn();
      await draft(t, "flag", null);
      expect(await markShown(TA, U, t.reply, "strip")).toEqual({ show: false, reason: "flag_only" });
      expect(await offer(t.reply)).toMatchObject({ status: "drafted", shown_at: null });
    });

    it("the dismiss streak counts run_end strips only", async () => {
      h.settings.team_note_max_per_day = 50;
      h.settings.team_note_max_per_thread = 50;
      const f = await turn();
      await draft(f, "flag", null);
      await markShown(TA, U, f.reply, "flag");
      await dismissNote(TA, U, f.reply, false);
      const s1 = await turn();
      await draft(s1, "strip", s1.reply);
      expect(await markShown(TA, U, s1.reply, "strip")).toMatchObject({ show: true, offer_stop: false });
      await dismissNote(TA, U, s1.reply, false);
      const s2 = await turn();
      await draft(s2, "strip", s2.reply);
      expect(await markShown(TA, U, s2.reply, "strip")).toMatchObject({ show: true, offer_stop: true });
    });
  });

  describe("promote_v2 races (serialized by the row lock)", () => {
    it("promote before show: drafted flag becomes a drafted strip on the founder's message, no cap spent", async () => {
      const spent = await turn();
      await draft(spent, "strip", spent.reply);
      await markShown(TA, U, spent.reply, "strip");
      const t = await turn();
      await draft(t, "flag", null);
      expect(await promoteNote(TA, { messageId: t.reply, anchorMessageId: t.follow, signals: ["founder_correction"] }))
        .toMatchObject({ promoted: true, status: "drafted", source: "correction" });
      const o = await offer(t.reply);
      expect(o).toMatchObject({ status: "drafted", surface: "strip", anchor_message_id: t.follow, source: "correction" });
      expect(o.signals).toEqual(["run_failed", "founder_correction"]);
      expect((await meta(t.reply)).team_note_draft).toMatchObject({ surface: "strip", anchor_message_id: t.follow, note: "It went badly." });
      expect(await markShown(TA, U, t.reply, "strip")).toMatchObject({ show: true, first: true });
    });

    it("promote after show via flag: stays shown, shown_via never changes", async () => {
      const t = await turn();
      await draft(t, "flag", null);
      await markShown(TA, U, t.reply, "flag");
      expect(await promoteNote(TA, { messageId: t.reply, anchorMessageId: t.follow, signals: ["founder_frustration"] }))
        .toMatchObject({ promoted: true, status: "shown" });
      expect(await offer(t.reply)).toMatchObject({ status: "shown", shown_via: "flag", surface: "strip" });
      expect(await markShown(TA, U, t.reply, "strip")).toMatchObject({ show: true, first: false, via: "flag" });
      expect((await offer(t.reply)).shown_via).toBe("flag");
      expect((await meta(t.reply)).team_note_state).toBe("shown");
    });

    it("suppressed revival: a capped-away strip comes back as drafted on pushback", async () => {
      const spent = await turn();
      await draft(spent, "strip", spent.reply);
      await markShown(TA, U, spent.reply, "strip");
      const t = await turn();
      await draft(t, "strip", t.reply);
      await markShown(TA, U, t.reply, "strip");
      expect(await offer(t.reply)).toMatchObject({ status: "suppressed" });
      expect(await promoteNote(TA, { messageId: t.reply, anchorMessageId: t.follow, signals: ["founder_correction"] }))
        .toMatchObject({ promoted: true, status: "drafted" });
      expect(await offer(t.reply)).toMatchObject({ status: "drafted", resolved_at: null, anchor_message_id: t.follow });
      expect((await meta(t.reply)).team_note_state).toBe("drafted");
      expect(await markShown(TA, U, t.reply, "strip")).toMatchObject({ show: true });
    });

    it("a promoted strip shown days ago keeps its first shown_at, so it never takes today's run_end slot", async () => {
      const old = await turn();
      await draft(old, "strip", old.reply);
      await markShown(TA, U, old.reply, "strip");
      await db.query(
        "update team_note_offers set shown_at = now() - interval '2 days', status = 'suppressed', resolved_at = now() where message_id = $1",
        [old.reply],
      );
      await promoteNote(TA, { messageId: old.reply, anchorMessageId: old.follow, signals: ["founder_correction"] });
      expect(await markShown(TA, U, old.reply, "strip")).toMatchObject({ show: true });
      expect(Date.parse((await offer(old.reply)).shown_at)).toBeLessThan(Date.now() - 24 * 3600_000);
      const next = await turn();
      await draft(next, "strip", next.reply);
      expect(await markShown(TA, U, next.reply, "strip")).toMatchObject({ show: true, first: true });
    });

    it.each([
      ["sent", async (reply: string) => { await sendNote(TA, U, reply, "note", null); }],
      ["dismissed", async (reply: string) => { await dismissNote(TA, U, reply, false); }],
      ["stopped", async (reply: string) => { await dismissNote(TA, U, reply, true); }],
    ])("send/dismiss first, promote second: the founder's click wins (%s)", async (status, act) => {
      const t = await turn();
      await draft(t, "flag", null);
      await markShown(TA, U, t.reply, "flag");
      await act(t.reply);
      expect(await promoteNote(TA, { messageId: t.reply, anchorMessageId: t.follow, signals: ["founder_correction"] }))
        .toEqual({ promoted: false, reason: status });
      expect(await offer(t.reply)).toMatchObject({ status, surface: "flag", anchor_message_id: null });
    });

    it("promote first, send second: send works on the promoted strip", async () => {
      const t = await turn();
      await draft(t, "flag", null);
      await markShown(TA, U, t.reply, "flag");
      await promoteNote(TA, { messageId: t.reply, anchorMessageId: t.follow, signals: ["founder_correction"] });
      expect(await sendNote(TA, U, t.reply, "edited note", null)).toMatchObject({ status: "sent", first: true, source: "correction" });
      expect(await one("select source, note_edited from team_reports where message_id = $1", [t.reply]))
        .toEqual({ source: "correction", note_edited: true });
    });

    it("send and dismiss still require the note to be shown first", async () => {
      const t = await turn();
      await draft(t, "flag", null);
      expect(await sendNote(TA, U, t.reply, "note", null)).toEqual({ status: "closed" });
      expect(await dismissNote(TA, U, t.reply, false)).toEqual({ status: "closed" });
    });

    it("promote refuses an anchor from another thread, and a tenant-B caller", async () => {
      const t = await turn();
      const other = await turn();
      await draft(t, "flag", null);
      await expect(promoteNote(TA, { messageId: t.reply, anchorMessageId: other.follow, signals: [] })).rejects.toMatchObject({ code: "invalid" });
      expect(await promoteNote(TB, { messageId: t.reply, anchorMessageId: t.follow, signals: [] })).toEqual({ promoted: false, reason: "not_found" });
      expect(await offer(t.reply)).toMatchObject({ surface: "flag" });
    });

    it("promote with no offer yet is not_offered", async () => {
      const t = await turn();
      expect(await promoteNote(TA, { messageId: t.reply, anchorMessageId: t.follow, signals: [] })).toEqual({ promoted: false, reason: "not_offered" });
    });
  });

  describe("v1 RPCs after the migration (old backend during the rolling deploy)", () => {
    const v1Show = (reply: string, perDay = 1) =>
      one<{ r: Record<string, unknown> }>("select team_note_mark_shown($1, $2, $3, 1, 24, $4, 2) as r", [TA, U, reply, perDay]).then((x) => x.r);

    it("v1 offer drafts a flag (an old worker cannot tell a strip moment)", async () => {
      const t = await turn();
      const r = await one<{ r: Record<string, unknown> }>(
        "select team_note_offer($1, $2, 'run_end', 'other', array['tool_repeat_failure'], '0123456789abcdef', 'n') as r", [TA, t.reply]);
      expect(r.r).toMatchObject({ offered: true });
      expect(await offer(t.reply)).toMatchObject({ surface: "flag", anchor_message_id: null, status: "drafted" });
      expect((await meta(t.reply)).team_note_draft).toMatchObject({ surface: "flag", anchor_message_id: null });
    });

    it("v1 show refuses a flag (no persistent strip from an old tab)", async () => {
      const t = await turn();
      await draft(t, "flag", null);
      expect(await v1Show(t.reply)).toEqual({ show: false, reason: "flag_only" });
      expect(await offer(t.reply)).toMatchObject({ status: "drafted", shown_at: null });
    });

    it("v1 show of a run_end strip stamps shown_via + capped_as and spends the cap like v2", async () => {
      const t = await turn();
      await draft(t, "strip", t.reply);
      expect(await v1Show(t.reply)).toMatchObject({ show: true, first: true });
      expect(await offer(t.reply)).toMatchObject({ status: "shown", shown_via: "strip", capped_as: "run_end_strip" });
      const next = await turn();
      await draft(next, "strip", next.reply);
      expect(await v1Show(next.reply)).toEqual({ show: false, reason: "daily_cap" });
    });

    it("authenticated can execute no team-note RPC, old or new", async () => {
      const t = await turn();
      await db.exec("set role authenticated");
      try {
        for (const q of [
          `select team_note_mark_shown('${TA}', '${U}', '${t.reply}', 1, 24, 1, 1)`,
          `select team_note_promote_v2('${TA}', '${t.reply}', '${t.follow}', '{}')`,
          `select team_note_record_judgement_v2('${TA}', '${t.reply}', 'run_end', '{}', 'no', null, null)`,
        ]) {
          await expect(db.query(q)).rejects.toThrow(/permission denied/);
        }
        await expect(db.query("select count(*) from team_note_judgements")).rejects.toThrow(/permission denied/);
      } finally {
        await db.exec("reset role");
      }
    });
  });

  describe("claim_judgement_v2 upgrades", () => {
    it("run_end, then pushback: one upgrade to correction, then taken", async () => {
      const t = await turn();
      expect(await claimJudgement(TA, t.reply, "run_end", ["tool_repeat_failure"], false)).toBe("claimed");
      expect(await claimJudgement(TA, t.reply, "run_end", ["tool_repeat_failure"], false)).toBe("taken");
      expect(await claimJudgement(TA, t.reply, "correction", ["founder_correction"], false)).toBe("upgraded");
      expect(await one("select source, signals from team_note_judge_claims where message_id = $1", [t.reply]))
        .toEqual({ source: "correction", signals: ["founder_correction"] });
      expect(await claimJudgement(TA, t.reply, "correction", ["founder_frustration"], false)).toBe("taken");
    });

    it("rephrase and edit priors also upgrade to correction", async () => {
      for (const prior of ["rephrase", "edit"]) {
        const t = await turn();
        await claimJudgement(TA, t.reply, prior, ["founder_rephrase"], false);
        expect(await claimJudgement(TA, t.reply, "correction", ["founder_correction"], false)).toBe("upgraded");
      }
    });

    it("barge-in correction, then the run hard-fails: upgrade to run_end; a soft run_end is taken", async () => {
      const hard = await turn();
      await claimJudgement(TA, hard.reply, "correction", ["founder_correction"], false);
      expect(await claimJudgement(TA, hard.reply, "run_end", ["run_failed"], true)).toBe("upgraded");
      const soft = await turn();
      await claimJudgement(TA, soft.reply, "correction", ["founder_correction"], false);
      expect(await claimJudgement(TA, soft.reply, "run_end", ["tool_loop"], false)).toBe("taken");
    });

    it("once an offer exists no upgrade happens: the pushback caller is told 'offered'", async () => {
      const t = await turn();
      await claimJudgement(TA, t.reply, "run_end", ["tool_repeat_failure"], false);
      await draft(t, "flag", null);
      expect(await claimJudgement(TA, t.reply, "correction", ["founder_correction"], false)).toBe("offered");
      expect((await one("select source from team_note_judge_claims where message_id = $1", [t.reply])).source).toBe("run_end");
      expect(await canOffer(TA, t.reply, { applyCaps: false })).toBe("already_offered");
    });

    it("a user row or another tenant's reply is never claimable", async () => {
      const t = await turn();
      expect(await claimJudgement(TA, t.follow, "correction", [], false)).toBe("not_found");
      expect(await claimJudgement(TB, t.reply, "run_end", [], false)).toBe("not_found");
    });
  });

  describe("judgements (counts only) + purge", () => {
    it("records codes and ids only, re-derives run + agent, and is purged with the claims", async () => {
      const t = await turn();
      expect(await recordJudgement(TA, { messageId: t.reply, source: "run_end", signals: ["tool_loop"], verdict: "no", judgeSignal: null, surface: null })).toBe(true);
      expect(await recordJudgement(TA, { messageId: t.reply, source: "run_end", signals: ["tool_loop"], verdict: "bad", judgeSignal: "looping", surface: "flag" })).toBe(true);
      expect(await recordJudgement(TB, { messageId: t.reply, source: "run_end", signals: [], verdict: "no", judgeSignal: null, surface: null })).toBe(false);
      const rows = (await db.query("select * from team_note_judgements where message_id = $1 order by created_at", [t.reply])).rows;
      expect(rows.map((r) => [r.verdict, r.judge_signal, r.surface, r.run_id, r.agent_slug, r.tenant_id]))
        .toEqual([["no", null, null, t.run, "operator", TA], ["bad", "looping", "flag", t.run, "operator", TA]]);
      await expect(recordJudgement(TA, { messageId: t.reply, source: "run_end", signals: [], verdict: "maybe" as never, judgeSignal: null, surface: null }))
        .rejects.toBeInstanceOf(TeamNoteError);

      await db.query("update team_note_judgements set created_at = now() - interval '500 days' where message_id = $1", [t.reply]);
      const purged = await one<{ r: { deleted: number } }>("select purge_expired_team_notes_v2(100, 400) as r");
      expect(purged.r.deleted).toBeGreaterThanOrEqual(2);
      expect((await db.query("select 1 from team_note_judgements where message_id = $1", [t.reply])).rows).toHaveLength(0);
    });
  });
});
