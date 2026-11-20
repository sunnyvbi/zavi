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
  "20261111130000_email_member_edit_consent_and_import_guards.sql",
  "20261111182000_email_contacts_people_and_names.sql",
  "20261115150000_email_list_import_base_version.sql",
];

type Out = { ok: boolean; reason?: string; list_id: string; version_id: string; contact_count: number; already_blocked: number; new_count: number; new_blocked: number };

describe.skipIf(!PGLITE_MODULES)("20261115150000 import into a list only on top of the version it read (pglite)", () => {
  let db: Db;
  const r = async (q: string, p: unknown[] = []) => (await db.query(q, p)).rows[0].r;
  const add = (listId: string, emails: string[], base: string | null): Promise<Out> =>
    r("select email_list_import_version($1, $2, null, 'csv', '{}', $3, $4, null, $5) r", [T, listId, emails, OWNER, base]);
  const versions = async (listId: string) => Number((await db.query("select count(*)::int n from email_list_versions where list_id = $1", [listId])).rows[0].n);
  const emailsOn = async (versionId: string) =>
    (
      await db.query<{ e: string }>(
        "select c.email_norm e from email_list_version_contacts m join email_contacts c on c.id = m.contact_id where m.version_id = $1 order by 1",
        [versionId],
      )
    ).rows.map((x) => x.e);

  let first: Out;

  beforeAll(async () => {
    db = await bootEmailPipeline(MINE);
    await db.query("insert into tenants values ($1)", [T]);
    await db.query("insert into tenant_users values ($1, $2, 'owner')", [T, OWNER]);
    first = await r("select email_list_import_version($1, null, 'Waitlist', 'csv', '{}', $2, $3) r", [
      T,
      ["kept-ok@example.com", "kept-unsub@example.com", "gone@example.com"],
      OWNER,
    ]);
    await db.query("insert into email_suppression (tenant_id, email, reason) values ($1, 'kept-unsub@example.com', 'unsubscribe'), ($1, 'new-unsub@example.com', 'unsubscribe')", [T]);
    const gone = (await db.query<{ id: string }>("select id from email_contacts where tenant_id = $1 and email_norm = 'gone@example.com'", [T])).rows[0].id;
    expect(await r("select email_contact_erase($1, $2) r", [T, gone])).toBe(true);
  }, 120_000);
  afterAll(async () => db?.close());

  it("a second add built on a version that is no longer the newest is refused and writes nothing", async () => {
    const a = await add(first.list_id, ["racer-a@example.com", "kept-ok@example.com", "kept-unsub@example.com"], first.version_id);
    expect(a.ok).toBe(true);
    const before = await versions(first.list_id);
    const b = await add(first.list_id, ["racer-b@example.com", "kept-ok@example.com", "kept-unsub@example.com"], first.version_id);
    expect(b).toEqual({ ok: false, reason: "list_changed" });
    expect(await versions(first.list_id)).toBe(before);
    expect(await emailsOn(a.version_id)).toContain("racer-a@example.com");
    expect(await r("select count(*)::int r from email_contacts where tenant_id = $1 and email_norm = 'racer-b@example.com'", [T])).toBe(0);

    const retry = await add(first.list_id, ["racer-b@example.com", "racer-a@example.com", "kept-ok@example.com", "kept-unsub@example.com"], a.version_id);
    expect(retry.ok).toBe(true);
    expect(await emailsOn(retry.version_id)).toEqual(["kept-ok@example.com", "kept-unsub@example.com", "racer-a@example.com", "racer-b@example.com"]);
  });

  it("counts new people and new blocked people against the base, never the erased or already-blocked people on it", async () => {
    const latest = (await db.query<{ id: string }>("select id from email_list_versions where list_id = $1 order by created_at desc, id desc limit 1", [first.list_id])).rows[0].id;
    const out = await add(
      first.list_id,
      ["new-ok@example.com", "new-unsub@example.com", "gone@example.com", "kept-ok@example.com", "kept-unsub@example.com", "racer-a@example.com", "racer-b@example.com"],
      latest,
    );
    expect(out.ok).toBe(true);
    expect(out.contact_count).toBe(7);
    expect(out.new_count).toBe(3);
    expect(out.new_blocked).toBe(2);
    expect(out.already_blocked).toBe(3);
  });

  it("a call with no base, as an older backend makes, still imports without the check", async () => {
    const out: Out = await r("select email_list_import_version($1, $2, null, 'csv', '{}', $3, $4) r", [T, first.list_id, ["late@example.com"], OWNER]);
    expect(out.ok).toBe(true);
    expect(out.new_count).toBe(1);
  });
});
