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
  "20261108100400_email_send_double_send_guards.sql",
  "20261111110100_email_bulk_freeze_spread_over_cap.sql",
];

describe.skipIf(!PGLITE_MODULES)("Flow 79: a send never reaches people on an import nobody confirmed (pglite, non-regression guard)", () => {
  let db: Db;
  let list: string;
  const one = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows[0];
  const r = async (sql: string, p: unknown[] = []) => (await one(sql, p)).r;
  const version = async (emails: string[], consented: boolean) => {
    const id = (await one(
      "insert into email_list_versions (tenant_id, list_id, source_kind, contact_count, consent_text, consent_confirmed_by, consent_confirmed_at) values ($1, $2, 'csv', $3, $4, $5, $6) returning id",
      [T, list, emails.length, consented ? "yes" : null, consented ? OWNER : null, consented ? new Date().toISOString() : null],
    )).id as string;
    for (const email of emails) {
      const c = (await one("insert into email_contacts (tenant_id, email_norm) values ($1, $2) on conflict (tenant_id, email_norm) do update set email_norm = excluded.email_norm returning id", [T, email])).id;
      await db.query("insert into email_list_version_contacts (tenant_id, version_id, contact_id) values ($1, $2, $3)", [T, id, c]);
    }
    return id;
  };
  const freeze = async (v: string) => {
    await db.query("select set_config('zavi.email_card_approve', 'on', false)");
    const decision = (await one("insert into decisions (tenant_id, decision_class, body, status, approved_by) values ($1, 'bulk_outbound.send', '{}', 'approved', $2) returning id", [T, OWNER])).id;
    await db.query("select set_config('zavi.email_card_approve', '', false)");
    return r("select email_bulk_freeze_send($1, $2, $3, $4, 'S', 'b', 'hi@acme.test', null, 1000) r", [T, decision, list, v]);
  };

  beforeAll(async () => {
    db = await bootEmailPipeline(MINE);
    await db.query("insert into tenants values ($1)", [T]);
    await db.query("insert into tenant_users values ($1, $2, 'owner')", [T, OWNER]);
    list = (await one("insert into email_lists (tenant_id, name) values ($1, 'Patients') returning id", [T])).id;
  }, 120_000);
  afterAll(async () => db?.close());

  it("the summary offers the consented version, its send holds only those people, and the waiting import cannot be frozen", async () => {
    const v1 = await version(["old@x.test", "both@x.test"], true);
    await db.query("update email_lists set active_version_id = $2 where id = $1", [list, v1]);
    const v2 = await version(["both@x.test", "new@x.test"], false);
    const [s] = (await r("select email_list_summaries($1) r", [T])) as Array<{ active: { id: string }; latest: { id: string; consented: boolean } }>;
    expect(s.active.id).toBe(v1);
    expect(s.latest).toMatchObject({ id: v2, consented: false });
    const sent = await freeze(v1);
    expect(sent).toMatchObject({ ok: true, created: true, total: 2 });
    const people = (await db.query<{ e: string }>("select email_at_send e from email_bulk_send_recipients where send_id = $1 order by 1", [sent.send_id])).rows.map((x) => x.e);
    expect(people).toEqual(["both@x.test", "old@x.test"]);
    expect(await freeze(v2)).toMatchObject({ ok: false, reason: "version_not_consented" });
  });
});
