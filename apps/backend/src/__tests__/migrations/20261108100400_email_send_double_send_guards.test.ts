import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootEmailPipeline, PGLITE_MODULES, type Db } from "./email-pipeline-pglite";

const T = randomUUID();
const OWNER = randomUUID();
const MEMBER = randomUUID();
const MINE = [
  "20261108100000_email_send_pause.sql",
  "20261108100100_email_card_takeover_and_redispatch.sql",
  "20261108100150_email_card_tests_atomic.sql",
  "20261108100200_email_bulk_fanout_fixes.sql",
  "20261108100300_email_card_send_state_and_doors.sql",
  "20261108100400_email_send_double_send_guards.sql",
];
const sha = (h: string, t: string) => createHash("sha256").update("email-r1").update("\0").update(h).update("\0").update(t).digest("hex");
const v = (n: number) => ({ content: { subject: `S${n}` }, html: `<p>${n}</p>`, text: `${n}`, render_sha: sha(`<p>${n}</p>`, `${n}`) });

describe.skipIf(!PGLITE_MODULES)("20261108100400 guards against a second send (pglite)", () => {
  let db: Db;
  const one = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows[0];
  const r = async (sql: string, p: unknown[] = []) => (await one(sql, p)).r;
  const card = async (audience: string) =>
    (await one("insert into channel_actions (tenant_id, exec_class, exec_payload) values ($1, 'email_campaign.create_and_send', $2) returning id",
      [T, JSON.stringify({ tool: "sendgrid", audience_id: audience, variants: [v(1)], template_snapshot: {}, renderer_version: "email-r1" })])).id as string;
  const tested = async (id: string) => {
    const pre = await r("select email_card_for_test($1, 'channel_actions', $2, 1, $3) r", [T, id, OWNER]);
    await r("select record_email_test_send($1, 'channel_actions', $2, 1, $3, $4) r", [T, id, OWNER, pre.test_sha]);
  };
  const approve = (id: string) => r("select approve_email_card($1, 'channel_actions', $2, 1, $3, $4, 50) r", [T, id, OWNER, randomUUID()]);

  beforeAll(async () => {
    db = await bootEmailPipeline(MINE);
    await db.query("insert into tenants values ($1)", [T]);
    await db.query("insert into tenant_users values ($1, $2, 'owner'), ($1, $3, 'member')", [T, OWNER, MEMBER]);
  }, 120_000);
  afterAll(async () => db?.close());

  it("a second card for a list with a send still in flight (or of unknown outcome) is refused; once it settles, the founder may send again", async () => {
    const list = randomUUID();
    const first = await card(list);
    await tested(first);
    expect(await approve(first)).toMatchObject({ ok: true });
    const redraft = await card(list);
    await tested(redraft);
    expect(await approve(redraft)).toEqual({ ok: false, code: "list_send_in_flight" });
    expect(await one("select exec_status from channel_actions where id = $1", [redraft])).toEqual({ exec_status: null });
    await db.query("update channel_actions set exec_status = 'dispatching' where id = $1", [first]);
    await db.query("update channel_actions set exec_status = 'failed', exec_result = '{\"code\":\"exec_outcome_unknown\"}' where id = $1", [first]);
    expect(await approve(redraft)).toEqual({ ok: false, code: "list_send_in_flight" });
    await db.query("update channel_actions set exec_result = '{\"code\":\"exec_partial\",\"not_sent\":true}' where id = $1", [first]);
    expect(await one("select state from email_send_reservations where card_id = $1", [first])).toEqual({ state: "released" });
    expect(await approve(redraft)).toMatchObject({ ok: true });
    expect(await approve(first)).toMatchObject({ ok: false });
  });

  it("a founder may still send to a list that got an email in the last 7 days (the spacing is Autopilot's)", async () => {
    const list = randomUUID();
    const sent = await card(list);
    await tested(sent);
    await approve(sent);
    await db.query("update channel_actions set exec_status = 'dispatching' where id = $1", [sent]);
    await db.query("update channel_actions set exec_status = 'executed' where id = $1", [sent]);
    const next = await card(list);
    await tested(next);
    expect(await approve(next)).toMatchObject({ ok: true });
  });

  it("a card with a scheduled planned send cannot be edited", async () => {
    const id = await card(randomUUID());
    await db.query(
      `insert into email_planned_sends (tenant_id, route, list_id, list_key, list_name, planned_at, planned_tz, angle, source, request_key, status, card_rail, card_id,
         sched_variant, sched_count, sched_by, sched_sha, sched_version, sched_card_id, sched_account, sched_at)
       values ($1, 'sendgrid', 'L', 'sendgrid:L', 'L', now() + interval '1 day', 'UTC', 'a', 'founder', $2, 'scheduled', 'channel_actions', $3, 1, 5, $4, 'x', 1, $3, '{}', now())`,
      [T, randomUUID(), id, OWNER],
    );
    const body = (await one("select exec_payload b from channel_actions where id = $1", [id])).b;
    const sealed = { content: { subject: "new" }, html: "<p>new</p>", text: "new", render_sha: sha("<p>new</p>", "new") };
    expect(await r("select edit_email_card_variant($1, 'channel_actions', $2, 1, $3, $4, $5) r", [T, id, MEMBER, JSON.stringify(body), JSON.stringify(sealed)])).toEqual({ ok: false, code: "scheduled_send_pending" });
    await db.query("update email_planned_sends set status = 'ready', sched_variant = null, sched_count = null, sched_by = null, sched_sha = null, sched_version = null, sched_card_id = null, sched_account = null, sched_at = null where card_id = $1", [id]);
    expect(await r("select edit_email_card_variant($1, 'channel_actions', $2, 1, $3, $4, $5) r", [T, id, MEMBER, JSON.stringify(body), JSON.stringify(sealed)])).toMatchObject({ ok: true });
  });

  it("the freeze skips suppressed and unsubscribed people, so the cap is spent on people who can be emailed", async () => {
    const list = (await one("insert into email_lists (tenant_id, name) values ($1, 'Big') returning id", [T])).id;
    const version = (await one("insert into email_list_versions (tenant_id, list_id, source_kind, consent_text, consent_confirmed_by, consent_confirmed_at) values ($1, $2, 'csv', 'yes', $3, now()) returning id", [T, list, OWNER])).id;
    await db.query("update email_lists set active_version_id = $2 where id = $1", [list, version]);
    await db.query(
      `with c as (insert into email_contacts (tenant_id, email_norm) select $1, 'p' || lpad(g::text, 5, '0') || '@x.test' from generate_series(1, 1200) g returning id)
       insert into email_list_version_contacts (tenant_id, version_id, contact_id) select $1, $2, id from c`,
      [T, version],
    );
    await db.query("insert into email_suppression (tenant_id, email, reason) select $1, 'p' || lpad(g::text, 5, '0') || '@x.test', 'unsubscribe' from generate_series(1, 200) g", [T]);
    await db.query("insert into comms_unsubscribes (tenant_id, channel, recipient) select $1, 'email', 'p' || lpad(g::text, 5, '0') || '@x.test' from generate_series(201, 250) g", [T]);
    await db.query("insert into comms_suppressions (tenant_id, channel, recipient, reason) select $1, 'email', 'p' || lpad(g::text, 5, '0') || '@x.test', 'bounce' from generate_series(251, 300) g", [T]);
    expect(await one("select email_list_version_freeze_count($1, $2) n", [T, version])).toEqual({ n: 900 });
    await db.query("select set_config('zavi.email_card_approve', 'on', false)");
    const decision = (await one("insert into decisions (tenant_id, decision_class, body, status, approved_by) values ($1, 'bulk_outbound.send', '{}', 'approved', $2) returning id", [T, OWNER])).id;
    await db.query("select set_config('zavi.email_card_approve', '', false)");
    const f = await r("select email_bulk_freeze_send($1, $2, $3, $4, 'S', 'b', 'hi@acme.test', null, 1000) r", [T, decision, list, version]);
    expect(f).toMatchObject({ ok: true, total: 900 });
    expect(await one(
      `select count(*)::int n from email_bulk_send_recipients r where r.send_id = $1 and public.email_bulk_block_reason($2, r.email_at_send) is not null`, [f.send_id, T])).toEqual({ n: 0 });
  });

  it("a send closed after a refusal cannot be resumed by staff", async () => {
    const list = (await one("insert into email_lists (tenant_id, name) values ($1, 'Small') returning id", [T])).id;
    const version = (await one("insert into email_list_versions (tenant_id, list_id, source_kind, consent_text, consent_confirmed_by, consent_confirmed_at) values ($1, $2, 'csv', 'yes', $3, now()) returning id", [T, list, OWNER])).id;
    const c = (await one("insert into email_contacts (tenant_id, email_norm) values ($1, 'solo@x.test') returning id", [T])).id;
    await db.query("insert into email_list_version_contacts (tenant_id, version_id, contact_id) values ($1, $2, $3)", [T, version, c]);
    await db.query("select set_config('zavi.email_card_approve', 'on', false)");
    const decision = (await one("insert into decisions (tenant_id, decision_class, body, status, approved_by) values ($1, 'bulk_outbound.send', '{}', 'approved', $2) returning id", [T, OWNER])).id;
    await db.query("select set_config('zavi.email_card_approve', '', false)");
    await db.query("insert into email_send_reservations (tenant_id, list_key, card_rail, card_id, source) values ($1, $2, 'decisions', $3, 'founder')", [T, `zavi_list:${list}`, decision]);
    const f = await r("select email_bulk_freeze_send($1, $2, $3, $4, 'S', 'b', 'hi@acme.test', null, 1000) r", [T, decision, list, version]);
    await r("select email_bulk_settle_send($1, $2, 'held', 'provider_refused', null) r", [T, f.send_id]);
    expect(await r("select email_bulk_close_held_send($1, $2) r", [T, f.send_id])).toBe(true);
    expect(await one("select state from email_send_reservations where card_id = $1", [decision])).toEqual({ state: "released" });
    expect(await r("select email_bulk_resume_send($1, $2) r", [T, f.send_id])).toEqual({ ok: false, reason: "not_held" });
    expect(await r("select email_bulk_claim_next($1, $2, 0) r", [T, f.send_id])).toEqual({ outcome: "held" });
  });
});
