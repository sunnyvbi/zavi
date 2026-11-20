import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootEmailPipeline, PGLITE_MODULES, type Db } from "./email-pipeline-pglite";

const T = randomUUID();
const OWNER = randomUUID();
const ERASE = "20261108110200_email_contact_erase_marks_erased.sql";
const MINE = ["20261031191200_email_bulk_engagement.sql", "20261108110100_email_suppression_reason_precedence.sql", ERASE, ERASE];

describe.skipIf(!PGLITE_MODULES)("20261108110200 erasing a contact marks the address erased (pglite)", () => {
  let db: Db;
  let n = 0;
  const one = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows[0];
  const addr = () => `e${++n}-${randomUUID().slice(0, 8)}@x.test`;
  const erase = async (contactId: string) => (await one("select email_contact_erase($1, $2) r", [T, contactId])).r as boolean;
  const row = (email: string) => one("select reason, unsub_token, created_at from email_suppression where tenant_id = $1 and email = $2", [T, email]);
  const contact = async (email: string) =>
    (await one("insert into email_contacts (tenant_id, email_norm, display_name) values ($1, $2, 'Pat') returning id", [T, email])).id as string;
  const sendWith = async (contactId: string, email: string, status: string) => {
    const list = (await one("insert into email_lists (tenant_id, name) values ($1, $2) returning id", [T, `L ${email} ${status}`])).id;
    const version = (await one(
      "insert into email_list_versions (tenant_id, list_id, source_kind, consent_text, consent_confirmed_by, consent_confirmed_at) values ($1, $2, 'csv', 'yes', $3, now()) returning id",
      [T, list, OWNER],
    )).id;
    const decision = (await one("insert into decisions (tenant_id, decision_class, body) values ($1, 'bulk_outbound.send', '{}') returning id", [T])).id;
    const send = (await one(
      "insert into email_bulk_sends (tenant_id, decision_id, list_id, list_version_id, subject, body_text, from_address, total) values ($1, $2, $3, $4, 'S', 'b', 'hi@acme.test', 1) returning id",
      [T, decision, list, version],
    )).id as string;
    await db.query("insert into email_bulk_send_recipients (send_id, tenant_id, contact_id, email_at_send, status) values ($1, $2, $3, $4, $5)", [send, T, contactId, email, status]);
    return send;
  };
  const recipient = (send: string, contactId: string) =>
    one("select status, skip_reason, email_at_send, stamped_at is not null as stamped from email_bulk_send_recipients where send_id = $1 and contact_id = $2", [send, contactId]);

  beforeAll(async () => {
    db = await bootEmailPipeline(MINE);
    await db.query("insert into tenants values ($1)", [T]);
    await db.query("insert into tenant_users values ($1, $2, 'owner')", [T, OWNER]);
  }, 120_000);
  afterAll(async () => db?.close());

  for (const prior of ["unsubscribe", "bounce", "complaint", "manual"]) {
    it(`an address already suppressed as ${prior} becomes erased, keeping its token and date, and the erase does everything else as before`, async () => {
      const e = addr();
      const c = await contact(e);
      await db.query("select suppress_email($1, $2, $3)", [T, e, prior]);
      const before = await row(e);
      const pending = await sendWith(c, e, "pending");
      const sent = await sendWith(c, e, "sent");

      expect(await erase(c)).toBe(true);

      expect(await row(e)).toEqual({ ...before, reason: "erased" });
      expect((await one("select email_bulk_block_reason($1, $2) r", [T, e])).r).toBe("erased");
      expect(await recipient(pending, c)).toEqual({ status: "skipped", skip_reason: "erased", email_at_send: null, stamped: true });
      expect(await recipient(sent, c)).toEqual({ status: "sent", skip_reason: null, email_at_send: null, stamped: false });
      expect(await one("select email_norm, display_name, erased_at is not null as erased from email_contacts where id = $1", [c])).toEqual({ email_norm: null, display_name: null, erased: true });
    });
  }

  it("a later webhook or unsubscribe click after the erase cannot take the erased reason away", async () => {
    const e = addr();
    const c = await contact(e);
    await db.query("select suppress_email($1, $2, 'bounce')", [T, e]);
    await erase(c);
    await db.query("select suppress_email($1, $2, 'complaint')", [T, e]);
    await db.query("select email_unsubscribe_and_count($1, $2)", [T, e]);
    expect((await row(e)).reason).toBe("erased");
  });

  it("an address with no row gets an erased row; a second erase returns false and changes nothing", async () => {
    const e = addr();
    const c = await contact(e);
    expect(await row(e)).toBeUndefined();
    expect(await erase(c)).toBe(true);
    const after = await row(e);
    expect(after.reason).toBe("erased");
    expect(await erase(c)).toBe(false);
    expect(await row(e)).toEqual(after);
    expect((await one("select count(*)::int k from email_suppression where tenant_id = $1 and email = $2", [T, e])).k).toBe(1);
  });

  it("another tenant's row for the same address is not touched, and bad input is still refused", async () => {
    const other = randomUUID();
    await db.query("insert into tenants values ($1)", [other]);
    const e = addr();
    await db.query("insert into email_suppression (tenant_id, email, reason) values ($1, $2, 'bounce')", [other, e]);
    await erase(await contact(e));
    expect((await one("select reason from email_suppression where tenant_id = $1 and email = $2", [other, e])).reason).toBe("bounce");
    expect(await erase(randomUUID())).toBe(false);
    await expect(db.query("select email_contact_erase(null, $1)", [randomUUID()])).rejects.toThrow(/null argument/);
  });
});
