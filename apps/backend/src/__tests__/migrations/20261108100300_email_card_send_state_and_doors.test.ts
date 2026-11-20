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
  "20261108100300_email_card_send_state_and_doors.sql",
];

describe.skipIf(!PGLITE_MODULES)("20261108100300 card send facts, the Autopilot door, and the planned send under a pause (pglite)", () => {
  let db: Db;
  const one = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows[0];
  const r = async (sql: string, p: unknown[] = []) => (await one(sql, p)).r;

  beforeAll(async () => {
    db = await bootEmailPipeline(MINE);
    await db.query("insert into tenants values ($1)", [T]);
    await db.query("insert into tenant_users values ($1, $2, 'owner')", [T, OWNER]);
  }, 120_000);
  afterAll(async () => db?.close());

  it("Autopilot's door refuses a card with no versions: it is never approved", async () => {
    const id = (await one("insert into channel_actions (tenant_id, exec_class, exec_payload) values ($1, 'email_campaign.create_and_send', $2) returning id",
      [T, JSON.stringify({ tool: "mailchimp", audience_id: randomUUID(), subject: "s", body_text: "b" })])).id;
    expect(await r("select approve_email_campaign_send_as_cgo($1, $2, 'cgo-k', $3, 10) r", [T, id, OWNER])).toEqual({ ok: false, code: "redraft_required" });
    expect(await one("select exec_status, approved_by from channel_actions where id = $1", [id])).toEqual({ exec_status: null, approved_by: null });
  });

  it("a planned email due while email is paused is skipped with reason paused", async () => {
    const item = (await one(
      `insert into email_planned_sends (tenant_id, route, list_id, list_key, list_name, planned_at, planned_tz, angle, source, request_key, status)
       values ($1, 'zavi_list', $2, 'zavi_list:' || $2, 'L', now() - interval '3 hours', 'UTC', 'a', 'founder', $3, 'planned') returning id, schedule_gen`,
      [T, randomUUID(), randomUUID()],
    ));
    await r("select set_email_pause($1, $2, true) r", [T, OWNER]);
    expect(await r("select fire_email_planned_send($1, $2, $3, '{}'::jsonb) r", [T, item.id, item.schedule_gen])).toMatchObject({ ok: true, outcome: "skipped", reason: "paused" });
    expect(await one("select status, status_reason from email_planned_sends where id = $1", [item.id])).toEqual({ status: "skipped", status_reason: "paused" });
    await r("select set_email_pause($1, $2, false) r", [T, OWNER]);
  });

  it("send facts: the decision, its Zavi-list send and its results, scoped to the workspace", async () => {
    await db.query("select set_config('zavi.email_card_approve', 'on', false)");
    const d = (await one("insert into decisions (tenant_id, decision_class, body, status, approved_by, approved_at, dispatched_at, dispatch_error) values ($1, 'bulk_outbound.send', '{}', 'dispatch_failed', $2, now(), now(), 'The list was archived.') returning id", [T, OWNER])).id;
    await db.query("select set_config('zavi.email_card_approve', '', false)");
    const f = await r("select email_card_send_facts($1, 'decisions', $2) r", [T, d]);
    expect(f).toMatchObject({ card: { status: "dispatch_failed", approved: true, error: "The list was archived." }, bulk: null, results: null });
    expect(await r("select email_card_send_facts($1, 'decisions', $2) r", [randomUUID(), d])).toBeNull();
    const ca = (await one("insert into channel_actions (tenant_id, exec_class, exec_payload) values ($1, 'email_campaign.create_and_send', '{}') returning id", [T])).id;
    expect(await r("select email_card_send_facts($1, 'channel_actions', $2) r", [T, ca])).toMatchObject({ card: { status: "pending", exec_status: null, approved: false }, bulk: null });
  });
});
