import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootEmailPipeline, PGLITE_MODULES, type Db } from "./email-pipeline-pglite";

const T = randomUUID();
const OWNER = randomUUID();
const MINE = [
  "20261108100000_email_send_pause.sql",
  "20261108100100_email_card_takeover_and_redispatch.sql",
  "20261108100150_email_card_tests_atomic.sql",
  "20261108100200_email_bulk_fanout_fixes.sql",
  "20261119150000_email_plan_sent_only_when_bulk_send_done.sql",
  "20261119150200_email_send_ref_not_sent_frees_list.sql",
];

describe.skipIf(!PGLITE_MODULES)("20261119150200 a tool send proven not sent frees its list (pglite)", () => {
  let db: Db;
  const one = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows[0];
  const r = async (sql: string, p: unknown[] = []) => (await one(sql, p)).r;

  async function approved(): Promise<string> {
    const id = (await one(
      "insert into decisions (tenant_id, decision_class, body, status) values ($1, 'email_campaign.create_and_send', $2, 'proposed') returning id",
      [T, JSON.stringify({ tool: "mailchimp", audience_id: `list-${randomUUID()}`, list_name: "Members", audience_count: 5 })],
    )).id;
    await db.query("select set_config('zavi.email_card_approve', 'on', false)");
    await db.query("update decisions set status = 'approved', approved_by = $2, approved_at = now() where id = $1", [id, OWNER]);
    await db.query("select set_config('zavi.email_card_approve', '', false)");
    await db.query(
      `insert into email_planned_sends (tenant_id, route, list_id, list_key, list_name, planned_at, planned_tz, angle, source, request_key, status, card_rail, card_id)
       values ($1, 'mailchimp', $2, $3, 'Members', now(), 'UTC', 'Welcome', 'founder', $4, 'sending', 'decisions', $5)`,
      [T, randomUUID(), `mailchimp:${randomUUID()}`, randomUUID(), id],
    );
    await db.query("update decisions set status = 'dispatching' where id = $1", [id]);
    return id;
  }
  const record = (id: string, ref = "camp-1") => r("select record_email_send_ref($1, 'decisions', $2, 'mailchimp', $3) r", [T, id, ref]);
  const mark = (id: string) => r("select mark_email_send_ref_not_sent($1, 'decisions', $2) r", [T, id]);
  const fail = (id: string) => db.query("update decisions set status = 'dispatch_failed', dispatch_error = 'Mailchimp refused. Nothing was sent.' where id = $1", [id]);
  const reservation = (id: string) => r("select state r from email_send_reservations where card_rail = 'decisions' and card_id = $1", [id]);
  const item = (id: string) => r("select status r from email_planned_sends where card_rail = 'decisions' and card_id = $1", [id]);

  beforeAll(async () => {
    db = await bootEmailPipeline(MINE);
    await db.query("insert into tenants values ($1)", [T]);
    await db.query("insert into tenant_users values ($1, $2, 'owner')", [T, OWNER]);
  }, 120_000);
  afterAll(async () => db?.close());

  it("a refused send proven a draft releases the list and skips the item", async () => {
    const id = await approved();
    expect(await reservation(id)).toBe("held");
    expect(await record(id)).toBe(true);
    expect(await mark(id)).toBe(true);
    await fail(id);
    expect(await reservation(id)).toBe("released");
    expect(await item(id)).toBe("skipped");
  });

  it("fail closed: with no proof the list stays held and the item reconciling", async () => {
    const id = await approved();
    await record(id);
    await fail(id);
    expect(await reservation(id)).toBe("held");
    expect(await item(id)).toBe("reconciling");
  });

  it("a new send attempt wipes an old proof", async () => {
    const id = await approved();
    await record(id, "camp-1");
    await mark(id);
    await record(id, "camp-2");
    await fail(id);
    expect(await reservation(id)).toBe("held");
    expect(await r("select not_sent_at r from email_send_refs where card_id = $1", [id])).toBeNull();
  });

  it("a mark for a card with no recorded campaign says so", async () => {
    expect(await mark(randomUUID())).toBe(false);
  });

  it("a mark never reaches another workspace's card", async () => {
    const id = await approved();
    await record(id);
    expect(await r("select mark_email_send_ref_not_sent($1, 'decisions', $2) r", [randomUUID(), id])).toBe(false);
    await fail(id);
    expect(await reservation(id)).toBe("held");
  });
});
