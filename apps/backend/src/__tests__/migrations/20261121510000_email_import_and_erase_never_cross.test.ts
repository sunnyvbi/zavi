import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootEmailPipeline, PGLITE_MODULES, type Db } from "./email-pipeline-pglite";

const T = randomUUID();
const OTHER = randomUUID();
const OWNER = randomUUID();
const THIS_MIGRATION = "20261121510000_email_import_and_erase_never_cross.sql";
const MINE = [
  "20261108100000_email_send_pause.sql",
  "20261108100100_email_card_takeover_and_redispatch.sql",
  "20261108100150_email_card_tests_atomic.sql",
  "20261108100200_email_bulk_fanout_fixes.sql",
  "20261108100300_email_card_send_state_and_doors.sql",
  "20261108100400_email_send_double_send_guards.sql",
  "20261108110100_email_suppression_reason_precedence.sql",
  "20261108110200_email_contact_erase_marks_erased.sql",
  "20261111130000_email_member_edit_consent_and_import_guards.sql",
  "20261111182000_email_contacts_people_and_names.sql",
  "20261115150000_email_list_import_base_version.sql",
  "20261121450100_email_contact_erase_unsub_token.sql",
  THIS_MIGRATION,
];
const at = (e: string) => `${e}@example.com`;
type Out = { ok: boolean; reason?: string; list_id: string; version_id: string; contact_count: number };

describe.skipIf(!PGLITE_MODULES)("20261121510000 an import that read the erased list too early cannot bring a person back (pglite)", () => {
  let db: Db;

  const importNew = async (tenant: string, name: string, emails: (string | null)[], names: (string | null)[] | null = null) =>
    (await db.query("select email_list_import_version($1, null, $2, 'csv', '{}'::jsonb, $3, $4, $5) r", [tenant, name, emails, OWNER, names])).rows[0].r as Out;
  const contacts = async (tenant: string, email: string) =>
    (await db.query("select count(*)::int n from email_contacts where tenant_id = $1 and email_norm = $2", [tenant, email])).rows[0].n as number;
  const erase = async (email: string) => {
    const { rows } = await db.query("select id from email_contacts where tenant_id = $1 and email_norm = $2", [T, email]);
    return (await db.query("select email_contact_erase($1, $2) r", [T, rows[0].id])).rows[0].r;
  };
  const members = async (versionId: string) =>
    (await db.query("select c.email_norm e from email_list_version_contacts m join email_contacts c on c.id = m.contact_id where m.version_id = $1 order by 1", [versionId])).rows.map((r) => r.e as string);
  const heldLocks = async () => (await db.query("select count(*)::int n from pg_locks where locktype = 'advisory' and granted")).rows[0].n as number;

  beforeAll(async () => {
    db = await bootEmailPipeline(MINE);
    await db.query("insert into tenants values ($1), ($2)", [T, OTHER]);
    await db.query("insert into tenant_users values ($1, $3, 'owner'), ($2, $3, 'owner')", [T, OTHER, OWNER]);
    await importNew(T, "First", [at("bo"), at("cy"), at("di")]);
    expect(await erase(at("bo"))).toBe(true);
    expect(await erase(at("di"))).toBe(true);
  }, 60_000);
  afterAll(async () => {
    await db?.close();
  });

  it("drops an erased address from a mixed file and creates no contact for it", async () => {
    const out = await importNew(T, "Stale read", [at("bo"), at("ana"), ` ${at("DI").toUpperCase()} `]);
    expect(out).toMatchObject({ ok: true, contact_count: 1 });
    expect(await contacts(T, at("bo"))).toBe(0);
    expect(await contacts(T, at("di"))).toBe(0);
    expect(await members(out.version_id)).toEqual([at("ana")]);
  });

  it("keeps names lined up with the addresses that survive", async () => {
    const out = await importNew(T, "Named", [at("bo"), at("eve")], ["Bo", "Eve"]);
    expect(out.ok).toBe(true);
    const { rows } = await db.query("select display_name from email_contacts where tenant_id = $1 and email_norm = $2", [T, at("eve")]);
    expect(rows[0].display_name).toBe("Eve");
    expect((await db.query("select count(*)::int n from email_contacts where display_name = 'Bo'")).rows[0].n).toBe(0);
  });

  it("a file of only erased addresses makes no list and no contact", async () => {
    const before = (await db.query("select count(*)::int n from email_lists where tenant_id = $1", [T])).rows[0].n;
    expect(await importNew(T, "All erased", [at("bo"), at("di")])).toMatchObject({ ok: false, reason: "no_addresses" });
    expect((await db.query("select count(*)::int n from email_lists where tenant_id = $1", [T])).rows[0].n).toBe(before);
    expect(await contacts(T, at("bo"))).toBe(0);
  });

  it("an erasure in one workspace does not block the same address in another", async () => {
    const out = await importNew(OTHER, "Other", [at("bo")]);
    expect(out).toMatchObject({ ok: true, contact_count: 1 });
    expect(await contacts(OTHER, at("bo"))).toBe(1);
  });

  it.each(["import", "erase"])("%s holds the workspace lock until its transaction ends", async (which) => {
    await importNew(T, `Lock ${which}`, [at(`lock-${which}`)]);
    const { rows } = await db.query("select id from email_contacts where tenant_id = $1 and email_norm = $2", [T, at(`lock-${which}`)]);
    expect(await heldLocks()).toBe(0);
    await db.query("begin");
    if (which === "import") await importNew(T, "Lock held", [at("lock-held")]);
    else await db.query("select email_contact_erase($1, $2)", [T, rows[0].id]);
    expect(await heldLocks()).toBe(1);
    await db.query("rollback");
    expect(await heldLocks()).toBe(0);
  });

  it("import and erase take the same lock key", () => {
    const sql = readFileSync(join(process.cwd(), "../../supabase/migrations", THIS_MIGRATION), "utf8");
    const keys = [...sql.matchAll(/pg_advisory_xact_lock\((.+)\);/g)].map((m) => m[1]);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(1);
  });
});
