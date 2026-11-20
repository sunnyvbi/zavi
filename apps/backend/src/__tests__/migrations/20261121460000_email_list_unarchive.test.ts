import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootEmailPipeline, PGLITE_MODULES, type Db } from "./email-pipeline-pglite";

const OWNER = randomUUID();
const ADMIN = randomUUID();
const MEMBER = randomUUID();
const STRANGER = randomUUID();
const MINE = [
  "20261108100000_email_send_pause.sql",
  "20261108100100_email_card_takeover_and_redispatch.sql",
  "20261108100150_email_card_tests_atomic.sql",
  "20261108100200_email_bulk_fanout_fixes.sql",
  "20261108100300_email_card_send_state_and_doors.sql",
  "20261108100400_email_send_double_send_guards.sql",
  "20261112200000_email_bulk_resume_both_stops.sql",
  "20261121450000_email_bulk_abuse_ends_and_resumes.sql",
  "20261121460000_email_list_unarchive.sql",
];

describe.skipIf(!PGLITE_MODULES)("20261121460000 unarchiving a contact list (pglite)", () => {
  let db: Db;
  const one = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows[0];
  const r = async (sql: string, p: unknown[] = []) => (await one(sql, p)).r;
  const unarchive = (t: string, list: string, user = OWNER) => r("select email_list_unarchive($1, $2, $3) r", [t, list, user]);
  const claim = (t: string, send: string) => r("select email_bulk_claim_next($1, $2, 100) r", [t, send]);
  const send = (id: string) => one("select status, hold_reason, next_run_at from email_bulk_sends where id = $1", [id]);
  const isArchived = async (id: string) => (await one("select archived_at is not null a from email_lists where id = $1", [id])).a as boolean;

  async function workspace() {
    const t = randomUUID();
    await db.query("insert into tenants values ($1)", [t]);
    await db.query("insert into tenant_users values ($1, $2, 'owner'), ($1, $3, 'admin'), ($1, $4, 'member')", [t, OWNER, ADMIN, MEMBER]);
    await db.query("insert into tenant_sending_domain (tenant_id, domain, verification_status, provider_domain_id) values ($1, 'acme.test', 'verified', 'sg-1')", [t]);
    await db.query("insert into email_domain_warmup (tenant_id, domain, day_index, last_sent_on) values ($1, 'acme.test', 20, current_date)", [t]).catch(() => undefined);
    return t;
  }

  async function listWith(t: string, name: string, emails: string[], consented = true, source = "csv") {
    const list = (await one("insert into email_lists (tenant_id, name) values ($1, $2) returning id", [t, name])).id as string;
    const version = (await one(
      `insert into email_list_versions (tenant_id, list_id, source_kind, contact_count, consent_text, consent_confirmed_by, consent_confirmed_at)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [t, list, source, emails.length, consented ? "yes" : null, consented ? OWNER : null, consented ? new Date().toISOString() : null],
    )).id as string;
    if (consented) await db.query("update email_lists set active_version_id = $2 where id = $1", [list, version]);
    for (const email of emails) {
      const c = (await one(
        `insert into email_contacts (tenant_id, email_norm) values ($1, $2)
         on conflict (tenant_id, email_norm) do update set email_norm = excluded.email_norm returning id`, [t, email])).id;
      await db.query("insert into email_list_version_contacts (tenant_id, version_id, contact_id) values ($1, $2, $3)", [t, version, c]);
    }
    return { list, version };
  }

  async function freeze(t: string, list: string, version: string) {
    await db.query("select set_config('zavi.email_card_approve', 'on', false)");
    const decision = (await one("insert into decisions (tenant_id, decision_class, body, status, approved_by) values ($1, 'bulk_outbound.send', '{}', 'approved', $2) returning id", [t, OWNER])).id;
    await db.query("select set_config('zavi.email_card_approve', '', false)");
    return r("select email_bulk_freeze_send($1, $2, $3, $4, 'S', 'b', 'hi@acme.test', null, 1000) r", [t, decision, list, version]);
  }

  async function runningSend(t: string, list: string, version: string, status: string, holdReason: string | null = null, nextRun: string | null = null) {
    const f = await freeze(t, list, version);
    expect(f).toMatchObject({ ok: true });
    await db.query("update email_bulk_sends set status = $2, hold_reason = $3, next_run_at = $4 where id = $1", [f.send_id, status, holdReason, nextRun]);
    return f.send_id as string;
  }

  const archive = (list: string) => db.query("update email_lists set archived_at = now() where id = $1", [list]);

  beforeAll(async () => {
    let added = false;
    db = await bootEmailPipeline(MINE, async (d) => {
      if (added) return;
      added = true;
      await d.exec(`
        alter table tenant_sending_domain add column if not exists provider_domain_id text;
        create table if not exists app_setting (key text primary key, value jsonb not null);
        create table if not exists staff_users (user_id uuid primary key, revoked_at timestamptz);
        alter table tenant_app_setting add column if not exists updated_by text;
      `);
    });
  }, 120_000);
  afterAll(async () => db?.close());

  it("moves the list back to the sendable lists and out of the archived view, with its people count", async () => {
    const t = await workspace();
    const { list } = await listWith(t, "Spring", ["a@x.test", "b@x.test"]);
    await archive(list);
    expect(await r("select email_list_summaries($1) r", [t])).toEqual([]);
    expect(await r("select email_list_archived_summaries($1) r", [t])).toEqual([
      expect.objectContaining({ id: list, name: "Spring", people: 2, from_database: false }),
    ]);
    expect(await unarchive(t, list, ADMIN)).toEqual({ ok: true, unarchived: true, stopped_sends: 0 });
    expect(await r("select email_list_archived_summaries($1) r", [t])).toEqual([]);
    expect((await r("select email_list_summaries($1) r", [t])).map((l: { id: string }) => l.id)).toEqual([list]);
    const { version } = (await one("select active_version_id as version from email_lists where id = $1", [list]));
    expect(await freeze(t, list, version)).toMatchObject({ ok: true, total: 2 });
  });

  it("the archived view counts the newest import when no import was ever confirmed, and flags a database list", async () => {
    const t = await workspace();
    const { list } = await listWith(t, "Draft", ["a@x.test"], false, "database");
    await archive(list);
    expect(await r("select email_list_archived_summaries($1) r", [t])).toEqual([
      expect.objectContaining({ id: list, people: 1, from_database: true }),
    ]);
  });

  it("a member, a stranger and another workspace's owner change nothing", async () => {
    const t = await workspace();
    const other = await workspace();
    await db.query("insert into tenant_users values ($1, $2, 'viewer')", [t, randomUUID()]);
    const { list } = await listWith(t, "Spring", ["a@x.test"]);
    await archive(list);
    expect(await unarchive(t, list, MEMBER)).toEqual({ ok: false, reason: "not_authorized" });
    expect(await unarchive(t, list, STRANGER)).toEqual({ ok: false, reason: "not_authorized" });
    expect(await unarchive(other, list, OWNER)).toEqual({ ok: false, reason: "list_not_found" });
    expect(await isArchived(list)).toBe(true);
    expect(await r("select email_list_archived_summaries($1) r", [other])).toEqual([]);
  });

  it("only the service role can call it", async () => {
    for (const fn of ["email_list_unarchive(uuid, uuid, uuid)", "email_list_archived_summaries(uuid)"]) {
      for (const role of ["anon", "authenticated"]) {
        expect((await one("select has_function_privilege($1, $2, 'execute') ok", [role, `public.${fn}`])).ok).toBe(false);
      }
      expect((await one("select has_function_privilege('service_role', $1, 'execute') ok", [`public.${fn}`])).ok).toBe(true);
    }
  });

  it("creates no consent: an import nobody confirmed stays unconfirmed and cannot be frozen, and every version row is untouched", async () => {
    const t = await workspace();
    const { list, version } = await listWith(t, "NoConsent", ["a@x.test"], false);
    await archive(list);
    const before = await r("select coalesce(jsonb_agg(to_jsonb(v) order by v.id), '[]') r from email_list_versions v where v.list_id = $1", [list]);
    await unarchive(t, list);
    expect(await r("select coalesce(jsonb_agg(to_jsonb(v) order by v.id), '[]') r from email_list_versions v where v.list_id = $1", [list])).toEqual(before);
    expect((await one("select active_version_id v from email_lists where id = $1", [list])).v).toBeNull();
    const [summary] = await r("select email_list_summaries($1) r", [t]);
    expect(summary.latest.consented).toBe(false);
    expect(summary.active).toBeNull();
    expect(await freeze(t, list, version)).toMatchObject({ ok: false });
  });

  it("does not widen consent to a newer unconfirmed import: the confirmed version stays the one a send uses", async () => {
    const t = await workspace();
    const { list, version } = await listWith(t, "TwoImports", ["old@x.test"]);
    const newer = (await one("insert into email_list_versions (tenant_id, list_id, source_kind, contact_count) values ($1, $2, 'csv', 9) returning id", [t, list])).id;
    await archive(list);
    await unarchive(t, list);
    expect((await one("select active_version_id v from email_lists where id = $1", [list])).v).toBe(version);
    expect((await one("select consent_confirmed_at c from email_list_versions where id = $1", [newer])).c).toBeNull();
  });

  it("unsubscribed, bounced and suppressed people, including ones blocked while archived, stay out of every later send", async () => {
    const t = await workspace();
    const { list, version } = await listWith(t, "Mixed", ["ok@x.test", "unsub@x.test", "bounce@x.test", "supp@x.test", "late@x.test"]);
    await db.query("insert into comms_unsubscribes (tenant_id, channel, recipient) values ($1, 'email', 'unsub@x.test')", [t]);
    await db.query("insert into comms_suppressions (tenant_id, channel, recipient, reason) values ($1, 'email', 'bounce@x.test', 'bounce')", [t]);
    await db.query("insert into email_suppression (tenant_id, email, reason) values ($1, 'supp@x.test', 'manual')", [t]);
    await archive(list);
    await db.query("insert into email_suppression (tenant_id, email, reason) values ($1, 'late@x.test', 'unsubscribe')", [t]);
    const rows = async () => (await db.query("select email, reason from email_suppression where tenant_id = $1 order by email", [t])).rows;
    const before = await rows();
    await unarchive(t, list);
    expect(await rows()).toEqual(before);
    expect(await one("select email_list_version_freeze_count($1, $2) n", [t, version])).toEqual({ n: 1 });
    const f = await freeze(t, list, version);
    expect(f).toMatchObject({ ok: true, total: 1 });
    expect((await db.query("select email_at_send from email_bulk_send_recipients where send_id = $1", [f.send_id])).rows).toEqual([{ email_at_send: "ok@x.test" }]);
  });

  it("a send the archive already held stays held, and neither the sender nor the pause switch nor staff restarts it", async () => {
    const t = await workspace();
    const { list, version } = await listWith(t, "Held", ["a@x.test", "b@x.test"]);
    const id = await runningSend(t, list, version, "held", "list_archived");
    await archive(list);
    expect(await unarchive(t, list)).toEqual({ ok: true, unarchived: true, stopped_sends: 1 });
    expect(await claim(t, id)).toEqual({ outcome: "held" });
    await db.query("select email_bulk_settle_send($1, $2, 'sending', null, null)", [t, id]);
    await db.query("select set_email_pause($1, $2, true), set_email_pause($1, $2, false)", [t, OWNER]);
    expect(await r("select email_bulk_resume_send($1, $2) r", [t, id])).toMatchObject({ ok: false, reason: "not_resumable" });
    expect(await send(id)).toMatchObject({ status: "held", hold_reason: "list_archived" });
    expect((await one("select count(*)::int n from email_bulk_send_recipients where send_id = $1 and status = 'pending'", [id])).n).toBe(2);
  });

  it.each([
    ["sending", null],
    ["waiting_for_tomorrow", "2099-01-01T00:05:00Z"],
  ])("a %s send the sender had not reached yet cannot slip through an archive and unarchive", async (status, nextRun) => {
    const t = await workspace();
    const { list, version } = await listWith(t, "Slip", ["a@x.test", "b@x.test"]);
    const id = await runningSend(t, list, version, status as string, null, nextRun);
    await archive(list);
    expect(await unarchive(t, list)).toEqual({ ok: true, unarchived: true, stopped_sends: 1 });
    expect(await send(id)).toEqual({ status: "held", hold_reason: "list_archived", next_run_at: null });
    expect(await claim(t, id)).toEqual({ outcome: "held" });
    expect((await one("select count(*)::int n from email_bulk_send_recipients where send_id = $1 and status = 'sending'", [id])).n).toBe(0);
  });

  it("a chunk that settles late cannot put the stopped send back on tomorrow's queue", async () => {
    const t = await workspace();
    const { list, version } = await listWith(t, "Late", ["a@x.test"]);
    const id = await runningSend(t, list, version, "sending");
    await archive(list);
    await unarchive(t, list);
    await db.query("select email_bulk_settle_send($1, $2, 'waiting_for_tomorrow', null, now() + interval '1 day')", [t, id]);
    expect(await send(id)).toEqual({ status: "held", hold_reason: "list_archived", next_run_at: null });
  });

  it("a send held by the email pause does not come back when the founder resumes email after unarchiving", async () => {
    const t = await workspace();
    const { list, version } = await listWith(t, "Paused", ["a@x.test"]);
    const other = await listWith(t, "Untouched", ["b@x.test"]);
    const id = await runningSend(t, list, version, "held", "email_paused");
    const bystander = await runningSend(t, other.list, other.version, "held", "email_paused");
    await db.query("select set_email_pause($1, $2, true)", [t, OWNER]);
    await archive(list);
    expect(await unarchive(t, list)).toMatchObject({ stopped_sends: 1 });
    const resumed = await r("select set_email_pause($1, $2, false) r", [t, OWNER]);
    expect(resumed.resumed).toEqual([bystander]);
    expect(await send(id)).toMatchObject({ status: "held", hold_reason: "list_archived" });
  });

  it("leaves alone sends on other lists, other workspaces, stops the founder made, and a send with nobody left", async () => {
    const t = await workspace();
    const elsewhere = await workspace();
    const { list, version } = await listWith(t, "Mine", ["a@x.test"]);
    const other = await listWith(t, "Other", ["b@x.test"]);
    const far = await listWith(elsewhere, "Far", ["c@x.test"]);
    const onOther = await runningSend(t, other.list, other.version, "sending");
    const onFar = await runningSend(elsewhere, far.list, far.version, "sending");
    const stopped = await runningSend(t, list, version, "held", "stopped");
    const emptied = await runningSend(t, list, version, "sending");
    await db.query("update email_bulk_send_recipients set status = 'sent' where send_id = $1", [emptied]);
    await archive(list);
    expect(await unarchive(t, list)).toMatchObject({ stopped_sends: 0 });
    expect(await send(onOther)).toMatchObject({ status: "sending", hold_reason: null });
    expect(await send(onFar)).toMatchObject({ status: "sending", hold_reason: null });
    expect(await send(stopped)).toMatchObject({ status: "held", hold_reason: "stopped" });
    expect(await send(emptied)).toMatchObject({ status: "sending", hold_reason: null });
  });

  it("a second click or second tab is a no-op and never stops a send approved after the first one", async () => {
    const t = await workspace();
    const { list, version } = await listWith(t, "Twice", ["a@x.test"]);
    await archive(list);
    const [first, second] = await Promise.all([unarchive(t, list), unarchive(t, list)]);
    expect([first, second]).toEqual([
      { ok: true, unarchived: true, stopped_sends: 0 },
      { ok: true, unarchived: false, stopped_sends: 0 },
    ]);
    const id = await runningSend(t, list, version, "sending");
    expect(await unarchive(t, list)).toEqual({ ok: true, unarchived: false, stopped_sends: 0 });
    expect(await send(id)).toMatchObject({ status: "sending", hold_reason: null });
  });

  it("a name reused while archived refuses cleanly: nothing moves, its stopped send stays put, the other list keeps working", async () => {
    const t = await workspace();
    const { list, version } = await listWith(t, "  Spring  ", ["a@x.test"]);
    const id = await runningSend(t, list, version, "waiting_for_tomorrow", null, "2099-01-01T00:05:00Z");
    await archive(list);
    const reused = await listWith(t, "SPRING", ["b@x.test"]);
    expect(await unarchive(t, list)).toEqual({ ok: false, reason: "name_taken" });
    expect(await isArchived(list)).toBe(true);
    expect(await isArchived(reused.list)).toBe(false);
    expect((await send(id)).status).toBe("waiting_for_tomorrow");
    await archive(reused.list);
    expect(await unarchive(t, list)).toMatchObject({ ok: true, unarchived: true, stopped_sends: 1 });
    expect(await unarchive(t, reused.list)).toEqual({ ok: false, reason: "name_taken" });
  });
});
