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

describe.skipIf(!PGLITE_MODULES)("20261111110100 a send over the cap does not skip the same people every time (pglite)", () => {
  let db: Db;
  let list: string;
  let version: string;
  const one = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows[0];
  const r = async (sql: string, p: unknown[] = []) => (await one(sql, p)).r;
  const freeze = async () => {
    await db.query("select set_config('zavi.email_card_approve', 'on', false)");
    const decision = (await one("insert into decisions (tenant_id, decision_class, body, status, approved_by) values ($1, 'bulk_outbound.send', '{}', 'approved', $2) returning id", [T, OWNER])).id as string;
    await db.query("select set_config('zavi.email_card_approve', '', false)");
    const f = await r("select email_bulk_freeze_send($1, $2, $3, $4, 'S', 'b', 'hi@acme.test', null, 1000) r", [T, decision, list, version]);
    const rows = (await db.query<{ e: string }>("select email_at_send e from email_bulk_send_recipients where send_id = $1", [f.send_id])).rows.map((x) => x.e);
    return { decision, f, people: new Set(rows) };
  };

  beforeAll(async () => {
    db = await bootEmailPipeline(MINE);
    await db.query("insert into tenants values ($1)", [T]);
    await db.query("insert into tenant_users values ($1, $2, 'owner')", [T, OWNER]);
    list = (await one("insert into email_lists (tenant_id, name) values ($1, 'Big') returning id", [T])).id;
    version = (await one("insert into email_list_versions (tenant_id, list_id, source_kind, consent_text, consent_confirmed_by, consent_confirmed_at) values ($1, $2, 'csv', 'yes', $3, now()) returning id", [T, list, OWNER])).id;
    await db.query("update email_lists set active_version_id = $2 where id = $1", [list, version]);
    await db.query(
      `with c as (insert into email_contacts (tenant_id, email_norm) select $1, 'p' || lpad(g::text, 5, '0') || '@x.test' from generate_series(1, 1600) g returning id)
       insert into email_list_version_contacts (tenant_id, version_id, contact_id) select $1, $2, id from c`,
      [T, version],
    );
    await db.query("insert into email_suppression (tenant_id, email, reason) select $1, 'p' || lpad(g::text, 5, '0') || '@x.test', 'unsubscribe' from generate_series(1500, 1600) g", [T]);
  }, 120_000);
  afterAll(async () => db?.close());

  it("each send takes the cap, never a blocked person, and two sends to the same list reach different people", async () => {
    expect(await one("select email_list_version_freeze_count($1, $2) n", [T, version])).toEqual({ n: 1499 });
    const a = await freeze();
    const b = await freeze();
    expect(a.f).toMatchObject({ ok: true, created: true, total: 1000 });
    expect(b.f).toMatchObject({ ok: true, created: true, total: 1000 });
    for (const s of [a, b]) {
      expect(s.people.size).toBe(1000);
      for (const e of s.people) expect(Number(e.slice(1, 6))).toBeLessThan(1500);
    }
    const firstByAddress = new Set(Array.from({ length: 1000 }, (_, i) => `p${String(i + 1).padStart(5, "0")}@x.test`));
    expect([...a.people].filter((e) => !firstByAddress.has(e)).length).toBeGreaterThan(100);
    const both = [...a.people].filter((e) => b.people.has(e)).length;
    expect(both).toBeLessThan(900);
    expect(new Set([...a.people, ...b.people]).size).toBeGreaterThan(1300);
  });

  it("the same send frozen again keeps exactly who it had", async () => {
    const a = await freeze();
    const again = await r("select email_bulk_freeze_send($1, $2, $3, $4, 'S', 'b', 'hi@acme.test', null, 1000) r", [T, a.decision, list, version]);
    expect(again).toMatchObject({ ok: true, created: false, send_id: a.f.send_id, total: 1000 });
    const rows = (await db.query<{ e: string }>("select email_at_send e from email_bulk_send_recipients where send_id = $1", [a.f.send_id])).rows.map((x) => x.e);
    expect(new Set(rows)).toEqual(a.people);
  });
});
