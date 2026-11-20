import { randomUUID } from "node:crypto";
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
  "20261111130000_email_member_edit_consent_and_import_guards.sql",
  "20261111182000_email_contacts_people_and_names.sql",
  "20261115150000_email_list_import_base_version.sql",
  "20261115160000_email_people_hide_database_lists_from_members.sql",
];

type Row = { email: string; lists: Array<{ id: string; name: string }> };
type Page = { ok: boolean; total: number; rows: Row[]; counts: { contacts: number } | null };

describe.skipIf(!PGLITE_MODULES)("20261115160000 a member's People view shows nothing of a database list (pglite)", () => {
  let db: Db;
  let dbList: string;
  const r1 = async (q: string, p: unknown[]) => (await db.query(q, p)).rows[0].r as Record<string, unknown>;
  const people = async (user: string, listId: string | null = null): Promise<Page> =>
    (await db.query("select email_contacts_people($1, $2, null, $3) r", [T, user, listId])).rows[0].r as Page;

  beforeAll(async () => {
    db = await bootEmailPipeline(MINE);
    await db.query("insert into tenants values ($1)", [T]);
    await db.query("insert into tenant_users values ($1, $2, 'owner'), ($1, $3, 'member')", [T, OWNER, MEMBER]);
    const csv = (await db.query("select email_list_import_version($1, null, 'Waitlist', 'csv', '{}', $2, $3) r", [T, ["both@example.com", "csv-only@example.com"], OWNER])).rows[0].r as { list_id: string };
    expect(csv.list_id).toBeTruthy();
    dbList = ((await db.query("select email_list_import_version($1, null, 'Customers', 'database', '{}', $2, $3) r", [T, ["both@example.com", "db-only@example.com"], OWNER])).rows[0].r as { list_id: string }).list_id;
  }, 120_000);
  afterAll(async () => db?.close());

  it("a member sees only CSV-list people, never the database list on a row, and no database people in the counts", async () => {
    const page = await people(MEMBER);
    expect(page.ok).toBe(true);
    expect(page.rows.map((r) => r.email).sort()).toEqual(["both@example.com", "csv-only@example.com"]);
    for (const r of page.rows) expect(r.lists.map((l) => l.name)).toEqual(["Waitlist"]);
    expect(page.counts?.contacts).toBe(2);
    const filtered = await people(MEMBER, dbList);
    expect(filtered.total).toBe(0);
    expect(filtered.rows).toEqual([]);
  });

  it("a member's CSV added to a database list is not sendable until an owner or admin confirms consent for it", async () => {
    const latest = async () => (await db.query<{ id: string }>("select id from email_list_versions where list_id = $1 order by created_at desc, id desc limit 1", [dbList])).rows[0].id;
    const ownerVersion = await latest();
    expect(await r1("select email_list_record_consent($1, $2, $3, $4, 'These people agreed to hear from me.') r", [T, dbList, ownerVersion, OWNER])).toMatchObject({ ok: true });
    const added = (await db.query("select email_list_import_version($1, $2, null, 'database', $3, $4, $5, null, $6) r", [
      T, dbList, { column: "email", mixed: "database_and_csv" }, ["both@example.com", "db-only@example.com", "member-csv@example.com"], MEMBER, ownerVersion,
    ])).rows[0].r as { ok: boolean; version_id: string };
    expect(added.ok).toBe(true);
    const active = async () => (await db.query<{ a: string }>("select active_version_id a from email_lists where id = $1", [dbList])).rows[0].a;
    expect(await active()).toBe(ownerVersion);
    expect(await r1("select email_list_record_consent($1, $2, $3, $4, 'These people agreed to hear from me.') r", [T, dbList, added.version_id, MEMBER])).toMatchObject({ ok: false, reason: "not_authorized" });
    expect(await active()).toBe(ownerVersion);
    const ref = (await db.query<{ ref: Record<string, unknown> }>("select source_ref ref from email_list_versions where id = $1", [added.version_id])).rows[0].ref;
    expect(ref.mixed).toBe("database_and_csv");
  });

  it("an owner still sees every person and every list", async () => {
    const page = await people(OWNER);
    expect(page.rows.map((r) => r.email).sort()).toEqual(["both@example.com", "csv-only@example.com", "db-only@example.com", "member-csv@example.com"]);
    expect((await people(OWNER, dbList)).total).toBe(3);
    expect((await people(MEMBER)).rows.map((r) => r.email)).not.toContain("member-csv@example.com");
  });
});
