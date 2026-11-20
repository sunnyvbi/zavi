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
  "20261117210001_email_bulk_failed_send_refunds_allowance.sql",
];
const sha = (h: string, t: string) => createHash("sha256").update("email-r1").update("\0").update(h).update("\0").update(t).digest("hex");

describe.skipIf(!PGLITE_MODULES)("20261117210001 an email the provider refused gives the day's allowance back (pglite)", () => {
  let db: Db;
  const one = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows[0];
  const r = async (sql: string, p: unknown[] = []) => (await one(sql, p)).r;
  const claim = (send: string) => r("select email_bulk_claim_next($1, $2, 0) r", [T, send]);
  const settle = (send: string, contact: string, status: string) => r("select email_bulk_settle_recipient($1, $2, $3, $4) r", [T, send, contact, status]);
  const counter = () => one("select coalesce(sum(sent_count), 0)::int sent, coalesce(sum(bulk_sent_count), 0)::int bulk from email_send_counters where tenant_id = $1 and day = (now() at time zone 'utc')::date", [T]);

  async function send(people: number, domain: string): Promise<string> {
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
    const f = await r("select email_bulk_freeze_send($1, $2, $3, $4, 'S', $5, $6, null, 1000, $7, $8) r", [T, decision, list, version, text, `hi@${domain}`, html, sha(html, text)]);
    expect(f.ok).toBe(true);
    return f.send_id;
  }

  beforeAll(async () => {
    db = await bootEmailPipeline(MINE);
    await db.query("insert into tenants values ($1)", [T]);
    await db.query("insert into tenant_users values ($1, $2, 'owner')", [T, OWNER]);
  }, 120_000);
  afterAll(async () => db?.close());

  it("a new domain's 50-a-day warm-up still reaches 50 real emails when some addresses are refused", async () => {
    const s = await send(90, `d${randomUUID().slice(0, 8)}.test`);
    let sent = 0;
    let refused = 0;
    for (let i = 0; i < 90; i++) {
      const c = await claim(s);
      if (c.outcome !== "claimed") break;
      if (i % 3 === 0) {
        expect(await settle(s, c.contact_id, "failed")).toBe(true);
        refused++;
      } else {
        expect(await settle(s, c.contact_id, "sent")).toBe(true);
        sent++;
      }
    }
    expect(sent).toBe(50);
    expect(refused).toBeGreaterThan(0);
    expect(await counter()).toEqual({ sent: 50, bulk: 50 });
    expect((await claim(s)).outcome).toBe("allowance_exhausted");
  });

  it("only the claim that is settled refunds, once: sent, maybe-sent, a repeat or an already-settled row give nothing back", async () => {
    await db.query("delete from email_send_counters where tenant_id = $1", [T]);
    const s = await send(4, `d${randomUUID().slice(0, 8)}.test`);
    const a = await claim(s);
    const b = await claim(s);
    const c = await claim(s);
    expect(await counter()).toEqual({ sent: 3, bulk: 3 });
    expect(await settle(s, a.contact_id, "sent")).toBe(true);
    expect(await settle(s, b.contact_id, "unknown")).toBe(true);
    expect(await counter()).toEqual({ sent: 3, bulk: 3 });
    expect(await settle(s, b.contact_id, "failed")).toBe(true);
    expect(await counter()).toEqual({ sent: 3, bulk: 3 });
    expect(await settle(s, c.contact_id, "failed")).toBe(true);
    expect(await counter()).toEqual({ sent: 2, bulk: 2 });
    expect(await settle(s, c.contact_id, "failed")).toBe(false);
    expect(await settle(s, a.contact_id, "failed")).toBe(false);
    expect(await counter()).toEqual({ sent: 2, bulk: 2 });
    expect(await one("select status from email_bulk_send_recipients where send_id = $1 and contact_id = $2", [s, c.contact_id])).toEqual({ status: "failed" });
  });
});
