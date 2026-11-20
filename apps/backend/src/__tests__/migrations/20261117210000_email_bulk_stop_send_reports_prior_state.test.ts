import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootEmailPipeline, PGLITE_MODULES, type Db } from "./email-pipeline-pglite";

const T = randomUUID();
const OWNER = randomUUID();
const MINE = [
  "20261108100000_email_send_pause.sql",
  "20261108100100_email_card_takeover_and_redispatch.sql",
  "20261108100150_email_card_tests_atomic.sql",
  "20261108100200_email_bulk_fanout_fixes.sql",
  "20261117210000_email_bulk_stop_send_reports_prior_state.sql",
];
const sha = (h: string, t: string) => createHash("sha256").update("email-r1").update("\0").update(h).update("\0").update(t).digest("hex");

describe.skipIf(!PGLITE_MODULES)("20261117210000 stop the rest says what state the send was in (pglite)", () => {
  let db: Db;
  const one = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows[0];
  const r = async (sql: string, p: unknown[] = []) => (await one(sql, p)).r;

  async function send(people: number): Promise<{ send: string; decision: string }> {
    const list = (await one("insert into email_lists (tenant_id, name) values ($1, $2) returning id", [T, `L ${randomUUID()}`])).id;
    const version = (await one(
      "insert into email_list_versions (tenant_id, list_id, source_kind, consent_text, consent_confirmed_by, consent_confirmed_at) values ($1, $2, 'csv', 'yes', $3, now()) returning id",
      [T, list, OWNER],
    )).id;
    await db.query("update email_lists set active_version_id = $2 where id = $1", [list, version]);
    for (let i = 0; i < people; i++) {
      const c = (await one("insert into email_contacts (tenant_id, email_norm) values ($1, $2) returning id", [T, `p${i}-${randomUUID().slice(0, 6)}@x.test`])).id;
      await db.query("insert into email_list_version_contacts (tenant_id, version_id, contact_id) values ($1, $2, $3)", [T, version, c]);
    }
    await db.query("select set_config('zavi.email_card_approve', 'on', false)");
    const decision = (await one(
      "insert into decisions (tenant_id, decision_class, body, status, approved_by, approved_at) values ($1, 'bulk_outbound.send', $2, 'approved', $3, now()) returning id",
      [T, JSON.stringify({ list_id: list, list_version_id: version }), OWNER],
    )).id;
    await db.query("select set_config('zavi.email_card_approve', '', false)");
    const html = "<p>x {{zavi_unsubscribe_url}}</p>";
    const text = "x {{zavi_unsubscribe_url}}";
    const f = await r("select email_bulk_freeze_send($1, $2, $3, $4, 'S', $5, $6, null, 1000, $7, $8) r", [T, decision, list, version, text, `hi@d${randomUUID().slice(0, 8)}.test`, html, sha(html, text)]);
    expect(f.ok).toBe(true);
    return { send: f.send_id, decision };
  }

  beforeAll(async () => {
    db = await bootEmailPipeline(MINE);
    await db.query("insert into tenants values ($1)", [T]);
    await db.query("insert into tenant_users values ($1, $2, 'owner')", [T, OWNER]);
  }, 120_000);
  afterAll(async () => db?.close());

  it("a send waiting for tomorrow's allowance reports that, so the sender can be woken", async () => {
    const s = await send(3);
    await db.query("update email_bulk_sends set status = 'waiting_for_tomorrow', next_run_at = now() + interval '20 hours' where id = $1", [s.send]);
    expect(await r("select email_bulk_stop_send($1, $2, $3) r", [T, OWNER, s.decision])).toEqual({ ok: true, stopped: 3, already_sent: 0, send_id: s.send, was: "waiting_for_tomorrow", was_reason: null });
    expect(await one("select status, hold_reason, next_run_at from email_bulk_sends where id = $1", [s.send])).toEqual({ status: "held", hold_reason: "stopped", next_run_at: null });
  });

  it("a send held while email was paused reports the hold it replaced", async () => {
    const s = await send(2);
    await db.query("update email_bulk_sends set status = 'held', hold_reason = 'email_paused' where id = $1", [s.send]);
    expect(await r("select email_bulk_stop_send($1, $2, $3) r", [T, OWNER, s.decision])).toEqual({ ok: true, stopped: 2, already_sent: 0, send_id: s.send, was: "held", was_reason: "email_paused" });
  });

  it("a send still going reports sending, and a refusal says nothing about the send", async () => {
    const s = await send(1);
    expect(await r("select email_bulk_stop_send($1, $2, $3) r", [T, OWNER, s.decision])).toMatchObject({ ok: true, send_id: s.send, was: "sending", was_reason: null });
    await db.query("update email_bulk_sends set status = 'done' where id = $1", [s.send]);
    const refused = await r("select email_bulk_stop_send($1, $2, $3) r", [T, OWNER, s.decision]);
    expect(refused).toMatchObject({ ok: false, code: "not_stoppable" });
    expect(refused).not.toHaveProperty("send_id");
  });
});
