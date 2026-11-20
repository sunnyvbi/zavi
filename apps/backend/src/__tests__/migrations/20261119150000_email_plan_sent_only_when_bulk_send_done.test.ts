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
  "20261119150000_email_plan_sent_only_when_bulk_send_done.sql",
];
const sha = (h: string, t: string) => createHash("sha256").update("email-r1").update("\0").update(h).update("\0").update(t).digest("hex");

describe.skipIf(!PGLITE_MODULES)("20261119150000 a planned Zavi-list item is sent only when its bulk send is done (pglite)", () => {
  let db: Db;
  const one = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows[0];
  const r = async (sql: string, p: unknown[] = []) => (await one(sql, p)).r;

  async function planned(): Promise<{ send: string; decision: string; item: string }> {
    const list = (await one("insert into email_lists (tenant_id, name) values ($1, $2) returning id", [T, `L ${randomUUID()}`])).id;
    const version = (await one(
      "insert into email_list_versions (tenant_id, list_id, source_kind, consent_text, consent_confirmed_by, consent_confirmed_at) values ($1, $2, 'csv', 'yes', $3, now()) returning id",
      [T, list, OWNER],
    )).id;
    await db.query("update email_lists set active_version_id = $2 where id = $1", [list, version]);
    for (let i = 0; i < 3; i++) {
      const c = (await one("insert into email_contacts (tenant_id, email_norm) values ($1, $2) returning id", [T, `p${i}-${randomUUID().slice(0, 6)}@x.test`])).id;
      await db.query("insert into email_list_version_contacts (tenant_id, version_id, contact_id) values ($1, $2, $3)", [T, version, c]);
    }
    await db.query("select set_config('zavi.email_card_approve', 'on', false)");
    const decision = (await one(
      "insert into decisions (tenant_id, decision_class, body, status, approved_by, approved_at) values ($1, 'bulk_outbound.send', $2, 'approved', $3, now()) returning id",
      [T, JSON.stringify({ list_id: list, list_version_id: version }), OWNER],
    )).id;
    await db.query("select set_config('zavi.email_card_approve', '', false)");
    const item = (await one(
      `insert into email_planned_sends (tenant_id, route, list_id, list_key, list_name, planned_at, planned_tz, angle, source, request_key, status, card_rail, card_id)
       values ($1, 'zavi_list', $2, $3, 'L', now(), 'UTC', 'Welcome', 'founder', $4, 'sending', 'decisions', $5) returning id`,
      [T, list, `zavi_list:${list}`, randomUUID(), decision],
    )).id;
    const html = "<p>x {{zavi_unsubscribe_url}}</p>";
    const text = "x {{zavi_unsubscribe_url}}";
    const f = await r("select email_bulk_freeze_send($1, $2, $3, $4, 'S', $5, $6, null, 1000, $7, $8) r", [T, decision, list, version, text, `hi@d${randomUUID().slice(0, 8)}.test`, html, sha(html, text)]);
    expect(f.ok).toBe(true);
    return { send: f.send_id, decision, item };
  }

  const act = async (decision: string) => {
    await db.query("update decisions set status = 'dispatching' where id = $1", [decision]);
    await db.query("update decisions set status = 'acted' where id = $1", [decision]);
  };
  const stored = (item: string) => one("select status, status_reason, sent_at from email_planned_sends where id = $1", [item]);
  const finish = (send: string, status: string, sent: number, unknown = 0) =>
    db.query("update email_bulk_sends set status = $2, sent = $3, unknown = $4 where id = $1", [send, status, sent, unknown]);

  beforeAll(async () => {
    db = await bootEmailPipeline(MINE);
    await db.query("insert into tenants values ($1)", [T]);
    await db.query("insert into tenant_users values ($1, $2, 'owner')", [T, OWNER]);
  }, 120_000);
  afterAll(async () => db?.close());

  it("stays sending after the first batch, and turns sent when the send is done", async () => {
    const s = await planned();
    await finish(s.send, "sending", 1);
    await act(s.decision);
    expect(await stored(s.item)).toMatchObject({ status: "sending", sent_at: null });
    await finish(s.send, "done", 3);
    const after = await stored(s.item);
    expect(after.status).toBe("sent");
    expect(after.sent_at).not.toBeNull();
  });

  it.each(["waiting_for_tomorrow", "held"])("a %s send is not stored as sent", async (status) => {
    const s = await planned();
    await finish(s.send, status, 1);
    await act(s.decision);
    expect((await stored(s.item)).status).toBe("sending");
  });

  it("Stop the rest leaves the item not sent", async () => {
    const s = await planned();
    await act(s.decision);
    expect(await r("select email_bulk_stop_send($1, $2, $3) r", [T, OWNER, s.decision])).toMatchObject({ ok: true });
    expect((await stored(s.item)).status).toBe("sending");
  });

  it("a send done before the decision acts still settles sent", async () => {
    const s = await planned();
    await finish(s.send, "done", 3);
    expect((await stored(s.item)).status).toBe("sending");
    await act(s.decision);
    expect((await stored(s.item)).status).toBe("sent");
  });

  it("a send that ends with only unknown outcomes is reconciling, never sent", async () => {
    const s = await planned();
    await act(s.decision);
    await finish(s.send, "done", 0, 3);
    expect(await stored(s.item)).toMatchObject({ status: "reconciling", status_reason: "may_have_sent", sent_at: null });
  });

  it("a send that failed after some went out is reconciling", async () => {
    const s = await planned();
    await act(s.decision);
    await finish(s.send, "failed", 2);
    expect((await stored(s.item)).status).toBe("reconciling");
  });

  it("a send that reached nobody is skipped", async () => {
    const s = await planned();
    await act(s.decision);
    await finish(s.send, "done", 0);
    expect(await stored(s.item)).toMatchObject({ status: "skipped", status_reason: "nobody_sent" });
  });

  it("a finished send under an unacted decision changes nothing", async () => {
    const s = await planned();
    await finish(s.send, "done", 3);
    expect((await stored(s.item)).status).toBe("sending");
  });
});
