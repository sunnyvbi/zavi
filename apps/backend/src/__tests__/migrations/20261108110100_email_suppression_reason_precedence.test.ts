import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootEmailPipeline, PGLITE_MODULES, type Db } from "./email-pipeline-pglite";

const T = randomUUID();
const OWNER = randomUUID();
const MINE = ["20261031191200_email_bulk_engagement.sql", "20261108110100_email_suppression_reason_precedence.sql", "20261108110100_email_suppression_reason_precedence.sql"];

describe.skipIf(!PGLITE_MODULES)("20261108110100 a suppression's reason is never downgraded (pglite)", () => {
  let db: Db;
  let n = 0;
  const one = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows[0];
  const addr = () => `p${++n}-${randomUUID().slice(0, 8)}@x.test`;
  const suppress = async (email: string, reason: string) => (await one("select suppress_email($1, $2, $3) r", [T, email, reason])).r as string;
  const unsubscribe = async (email: string) => (await one("select email_unsubscribe_and_count($1, $2) r", [T, email])).r;
  const row = (email: string) => one("select reason, unsub_token, created_at from email_suppression where tenant_id = $1 and email = $2", [T, email.toLowerCase()]);
  const shown = async (email: string) => ({
    is: (await one("select is_email_suppressed($1, $2) r", [T, email])).r,
    block: (await one("select email_bulk_block_reason($1, $2) r", [T, email])).r,
  });
  const contact = async (email: string) => (await one("insert into email_contacts (tenant_id, email_norm) values ($1, $2) returning id", [T, email])).id as string;
  const sentTo = async (contactId: string, email: string) => {
    const list = (await one("insert into email_lists (tenant_id, name) values ($1, $2) returning id", [T, `L ${email}`])).id;
    const version = (await one(
      "insert into email_list_versions (tenant_id, list_id, source_kind, consent_text, consent_confirmed_by, consent_confirmed_at) values ($1, $2, 'csv', 'yes', $3, now()) returning id",
      [T, list, OWNER],
    )).id;
    const decision = (await one("insert into decisions (tenant_id, decision_class, body) values ($1, 'bulk_outbound.send', '{}') returning id", [T])).id;
    const send = (await one(
      "insert into email_bulk_sends (tenant_id, decision_id, list_id, list_version_id, subject, body_text, from_address, total, sent) values ($1, $2, $3, $4, 'S', 'b', 'hi@acme.test', 1, 1) returning id",
      [T, decision, list, version],
    )).id as string;
    await db.query("insert into email_bulk_send_recipients (send_id, tenant_id, contact_id, email_at_send, status) values ($1, $2, $3, $4, 'sent')", [send, T, contactId, email]);
    return send;
  };

  beforeAll(async () => {
    db = await bootEmailPipeline(MINE);
    await db.query("insert into tenants values ($1)", [T]);
    await db.query("insert into tenant_users values ($1, $2, 'owner')", [T, OWNER]);
  }, 120_000);
  afterAll(async () => db?.close());

  it("a complaint followed by a bounce (a later 'dropped') stays a complaint, with the same token and row", async () => {
    const e = addr();
    const token = await suppress(e, "complaint");
    const before = await row(e);
    expect(await suppress(e.toUpperCase(), "bounce")).toBe(token);
    expect(await row(e)).toEqual(before);
    expect(await shown(e)).toEqual({ is: "complaint", block: "complained" });
  });

  it("a complaint is not turned into an unsubscribe by a click on the link, and the unsubscribe is still counted", async () => {
    const e = addr();
    const c = await contact(e);
    const send = await sentTo(c, e);
    await suppress(e, "complaint");
    expect(await unsubscribe(` ${e.toUpperCase()} `)).toEqual({ ok: true, new: true, sends_counted: 1 });
    expect((await row(e)).reason).toBe("complaint");
    expect((await one("select unsubscribes from email_bulk_sends where id = $1", [send])).unsubscribes).toBe(1);
    expect(await unsubscribe(e)).toEqual({ ok: true, new: false, sends_counted: 0 });
    expect((await row(e)).reason).toBe("complaint");
  });

  it("an erased contact who clicks an old unsubscribe link stays erased", async () => {
    const e = addr();
    const c = await contact(e);
    expect((await one("select email_contact_erase($1, $2) r", [T, c])).r).toBe(true);
    const before = await row(e);
    expect(before.reason).toBe("erased");
    expect(await unsubscribe(e)).toEqual({ ok: true, new: false, sends_counted: 0 });
    expect(await row(e)).toEqual(before);
    expect(await shown(e)).toEqual({ is: "erased", block: "erased" });
  });

  it("an erased address is not overwritten by any later webhook or manual reason", async () => {
    const e = addr();
    await db.query("insert into email_suppression (tenant_id, email, reason) values ($1, $2, 'erased')", [T, e]);
    for (const r of ["complaint", "unsubscribe", "bounce", "manual"]) {
      await suppress(e, r);
      expect((await row(e)).reason).toBe("erased");
    }
  });

  it("a stronger reason still wins: bounce then complaint is a complaint, bounce then unsubscribe is an unsubscribe, manual then bounce is a bounce", async () => {
    const a = addr();
    const token = await suppress(a, "bounce");
    expect(await suppress(a, "complaint")).toBe(token);
    expect((await row(a)).reason).toBe("complaint");

    const b = addr();
    const c = await contact(b);
    const send = await sentTo(c, b);
    await suppress(b, "bounce");
    expect(await unsubscribe(b)).toEqual({ ok: true, new: true, sends_counted: 1 });
    expect((await row(b)).reason).toBe("unsubscribe");
    expect((await one("select unsubscribes from email_bulk_sends where id = $1", [send])).unsubscribes).toBe(1);

    const m = addr();
    await suppress(m, "manual");
    await suppress(m, "bounce");
    expect((await row(m)).reason).toBe("bounce");
    await suppress(m, "manual");
    expect((await row(m)).reason).toBe("bounce");
  });

  it("the full order holds for every pair: the stored reason is always the stronger one", async () => {
    const order = ["manual", "bounce", "unsubscribe", "complaint"];
    for (const first of order) {
      for (const second of order) {
        const e = addr();
        await suppress(e, first);
        await suppress(e, second);
        expect({ first, second, got: (await row(e)).reason }).toEqual({ first, second, got: order[Math.max(order.indexOf(first), order.indexOf(second))] });
      }
    }
  });

  it("a fresh address is still written with its reason, and an unknown reason is still refused", async () => {
    const e = addr();
    const token = await suppress(e, "unsubscribe");
    expect(token).toMatch(/^[0-9a-f-]{36}$/);
    expect((await row(e)).reason).toBe("unsubscribe");
    await expect(db.query("select suppress_email($1, $2, 'erased')", [T, addr()])).rejects.toThrow(/invalid reason/);
    await expect(db.query("select suppress_email($1, $2, 'spam')", [T, addr()])).rejects.toThrow(/invalid reason/);
  });
});
