import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootEmailPipeline, PGLITE_MODULES, type Db } from "./email-pipeline-pglite";

const T = randomUUID();
const OWNER = randomUUID();
const MEMBER = randomUUID();
const THIS_MIGRATION = "20261121500000_email_people_source_shows_mixed_lists.sql";
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
  THIS_MIGRATION,
];
const MIXED_REF = { table: "customers", column: "email", mixed: "database_and_csv" };

type Row = { email: string; masked: boolean; source: string; lists: Array<{ id: string; name: string }> };
type Page = { ok: boolean; total: number; rows: Row[]; counts: { contacts: number } | null; masked: boolean };
const at = (e: string) => `${e}@example.com`;

describe.skipIf(!PGLITE_MODULES)("20261121500000 the People source never claims one source for a mixed list (pglite)", () => {
  let db: Db;
  let testing: string;
  let before: { owner: Page; member: Page };

  const people = async (user: string, search: string | null = null, listId: string | null = null): Promise<Page> =>
    (await db.query("select email_contacts_people($1, $2, $3, $4) r", [T, user, search, listId])).rows[0].r as Page;
  const importNew = async (name: string, kind: string, ref: object, emails: string[]) =>
    ((await db.query("select email_list_import_version($1, null, $2, $3, $4, $5, $6) r", [T, name, kind, ref, emails, OWNER])).rows[0].r as { list_id: string; version_id: string });
  const importInto = async (listId: string, base: string, kind: string, ref: object, emails: string[]) =>
    ((await db.query("select email_list_import_version($1, $2, null, $3, $4, $5, $6, null, $7) r", [T, listId, kind, ref, emails, OWNER, base])).rows[0].r as { ok: boolean; version_id: string });
  const consent = async (listId: string, versionId: string) =>
    (await db.query("select email_list_record_consent($1, $2, $3, $4, 'These people agreed to hear from me.') r", [T, listId, versionId, OWNER])).rows[0].r as { ok: boolean };
  const source = (page: Page, email: string) => page.rows.find((r) => r.email === email)?.source;

  async function seed() {
    await db.query("insert into tenants values ($1)", [T]);
    await db.query("insert into tenant_users values ($1, $2, 'owner'), ($1, $3, 'member')", [T, OWNER, MEMBER]);
    await importNew("Waitlist", "csv", { column: "Email" }, [at("cara"), at("eve")]);
    await importNew("Customers", "database", { table: "customers", column: "email" }, [at("dan")]);
    await importNew("Odd", "csv", { column: "Email", mixed: "database_and_csv" }, [at("odd")]);

    const first = await importNew("Testing list", "csv", { column: "Email" }, [at("ana"), at("bo"), at("eve")]);
    testing = first.list_id;
    expect(await consent(testing, first.version_id)).toMatchObject({ ok: true });
    const mixed = await importInto(testing, first.version_id, "database", MIXED_REF, [at("dee"), at("ana"), at("bo"), at("eve")]);
    expect(mixed.ok).toBe(true);
    expect(await consent(testing, mixed.version_id)).toMatchObject({ ok: true });

    const pendingFirst = await importNew("Pending", "csv", { column: "Email" }, [at("pen")]);
    expect(await consent(pendingFirst.list_id, pendingFirst.version_id)).toMatchObject({ ok: true });
    const pending = await importInto(pendingFirst.list_id, pendingFirst.version_id, "database", MIXED_REF, [at("pen"), at("quinn")]);
    expect(pending.ok).toBe(true);
  }

  beforeAll(async () => {
    db = await bootEmailPipeline(MINE, async (d, file) => {
      if (file !== THIS_MIGRATION) return;
      db = d;
      await seed();
      before = { owner: await people(OWNER), member: await people(MEMBER) };
    });
  }, 120_000);
  afterAll(async () => db?.close());

  it("the seed reproduces the bug: the old function called the CSV people on the mixed list Database", () => {
    expect(source(before.owner, at("ana"))).toBe("database");
    expect(source(before.owner, at("bo"))).toBe("database");
  });

  it("people on a mixed list read as both sources, never as just the database", async () => {
    const page = await people(OWNER);
    expect(source(page, at("ana"))).toBe("database_and_csv");
    expect(source(page, at("bo"))).toBe("database_and_csv");
    expect(source(page, at("dee"))).toBe("database_and_csv");
  });

  it("a CSV-only person stays CSV and a database-only person stays Database", async () => {
    const page = await people(OWNER);
    expect(source(page, at("cara"))).toBe("csv");
    expect(source(page, at("dan"))).toBe("database");
  });

  it("before consent the CSV person keeps CSV from the active version and the newcomer reads as mixed", async () => {
    const page = await people(OWNER);
    expect(source(page, at("pen"))).toBe("csv");
    expect(source(page, at("quinn"))).toBe("database_and_csv");
  });

  it("a person whose oldest list is a plain CSV keeps CSV after a later list turns mixed", async () => {
    const eve = (await people(OWNER)).rows.find((r) => r.email === at("eve"));
    expect(eve?.source).toBe("csv");
    expect(eve?.lists.map((l) => l.name).sort()).toEqual(["Testing list", "Waitlist"]);
  });

  it("a plain member gets nothing of a mixed or database list: no address, no count, no search hit, no filter, no mixed source", async () => {
    const page = await people(MEMBER);
    expect(page.masked).toBe(true);
    expect(page.rows.map((r) => r.email).sort()).toEqual([at("cara"), at("eve"), at("odd")]);
    expect(page.counts?.contacts).toBe(3);
    for (const r of page.rows) {
      expect(r.source).toBe("csv");
      expect(r.lists.map((l) => l.name)).not.toContain("Testing list");
      expect(r.lists.map((l) => l.name)).not.toContain("Pending");
    }
    expect(JSON.stringify(page)).not.toContain("database_and_csv");
    for (const hidden of ["ana", "bo", "dee", "dan", "pen", "quinn"]) expect((await people(MEMBER, hidden)).total).toBe(0);
    const filtered = await people(MEMBER, null, testing);
    expect(filtered.total).toBe(0);
    expect(filtered.rows).toEqual([]);
  });

  it("a CSV version carrying the mixed marker never shows a member that the list holds database people", async () => {
    expect(source(await people(MEMBER), at("odd"))).toBe("csv");
  });

  it("a plain member's page is byte-for-byte what the old function returned", async () => {
    expect(await people(MEMBER)).toEqual(before.member);
  });

  it("an owner's page differs from the old function only in the source of people on a mixed version", async () => {
    const after = await people(OWNER);
    const noSource = (p: Page) => ({ ...p, rows: p.rows.map(({ source: _s, ...r }) => r) });
    expect(noSource(after)).toEqual(noSource(before.owner));
    const changed = after.rows.filter((r, i) => r.source !== before.owner.rows[i].source).map((r) => r.email).sort();
    expect(changed).toEqual([at("ana"), at("bo"), at("dee"), at("quinn")]);
  });

  it("re-runs cleanly and keeps service-role-only access", async () => {
    const sql = readFileSync(join(__dirname, "../../../../../supabase/migrations", THIS_MIGRATION), "utf8").replace(/^(begin|commit);$/gm, "");
    await db.exec(sql);
    expect(source(await people(OWNER), at("ana"))).toBe("database_and_csv");
    const roles = (await db.query<{ grantee: string }>("select grantee::regrole::text as grantee from pg_proc p, aclexplode(p.proacl) a where p.proname = 'email_contacts_people' and a.privilege_type = 'EXECUTE'")).rows.map((r) => r.grantee);
    expect(roles).not.toContain("anon");
    expect(roles).not.toContain("authenticated");
    expect(roles).toContain("service_role");
  });
});
