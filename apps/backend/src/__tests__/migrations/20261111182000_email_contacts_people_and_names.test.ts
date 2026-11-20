import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { maskAddress } from "@/services/comms/bulk-outbound/mask";
import { bootEmailPipeline, PGLITE_MODULES, type Db } from "./email-pipeline-pglite";

const T = randomUUID();
const OTHER = randomUUID();
const OWNER = randomUUID();
const ADMIN = randomUUID();
const MEMBER = randomUUID();
const STRANGER = randomUUID();
const FILE = "20261111182000_email_contacts_people_and_names.sql";
const MINE = [
  "20261108100000_email_send_pause.sql",
  "20261108100100_email_card_takeover_and_redispatch.sql",
  "20261108100150_email_card_tests_atomic.sql",
  "20261108100200_email_bulk_fanout_fixes.sql",
  "20261108100300_email_card_send_state_and_doors.sql",
  "20261108100400_email_send_double_send_guards.sql",
  "20261111130000_email_member_edit_consent_and_import_guards.sql",
  FILE,
];
const dir = join(__dirname, "../../../../../supabase/migrations");
const rawSql = (f: string) => readFileSync(join(dir, f), "utf8").replace(/^(begin|commit);$/gm, "");

type Person = { id: string; email: string; masked: boolean; name: string | null; lists: { id: string; name: string }[]; status: string; source: string; added_at: string };
type People = { ok: boolean; total: number; rows: Person[]; counts: { contacts: number; lists: number; unsubscribed: number; bounced: number } | null; masked: boolean };

describe.skipIf(!PGLITE_MODULES)("20261111182000 contacts people view and imported names (pglite)", () => {
  let db: Db;
  const one = async (q: string, p: unknown[] = []) => (await db.query(q, p)).rows[0];
  const r = async (q: string, p: unknown[] = []) => (await one(q, p)).r;
  const importV = (tenant: string, list: { id?: string; name?: string }, kind: string, emails: string[], names: (string | null)[] | null, by = OWNER) =>
    r("select email_list_import_version($1, $2, $3, $4, '{}', $5, $6, $7) r", [tenant, list.id ?? null, list.id ? null : list.name, kind, emails, by, names]);
  const consent = (tenant: string, v: { list_id: string; version_id: string }) =>
    r("select email_list_record_consent($1, $2, $3, $4, 'They agreed.') r", [tenant, v.list_id, v.version_id, OWNER]);
  const people = (user: string, args: { search?: string | null; list?: string | null; limit?: number; offset?: number } = {}, tenant = T): Promise<People> =>
    r("select email_contacts_people($1, $2, $3, $4, $5, $6) r", [tenant, user, args.search ?? null, args.list ?? null, args.limit ?? 50, args.offset ?? 0]);
  const byEmail = (p: People, start: string) => p.rows.find((x) => x.email.startsWith(start));

  let csvList: { list_id: string; version_id: string };
  let dbList: { list_id: string; version_id: string };
  let archived: { list_id: string; version_id: string };

  beforeAll(async () => {
    db = await bootEmailPipeline(MINE);
    await db.query("insert into tenants values ($1), ($2)", [T, OTHER]);
    await db.query("insert into tenant_users values ($1, $2, 'owner'), ($1, $3, 'admin'), ($1, $4, 'member'), ($5, $2, 'owner')", [T, OWNER, ADMIN, MEMBER, OTHER]);

    csvList = await importV(T, { name: "Waitlist" }, "csv", ["ada@example.com", "bo@example.com", "cy@example.com", "erin@example.com"], ["Ada Lovelace", null, "Cy Twombly", "Erin"]);
    await consent(T, csvList);
    await db.exec("alter table email_list_versions disable trigger email_list_versions_immutable_trg");
    await db.query("update email_list_versions set created_at = now() - interval '2 days' where id = $1", [csvList.version_id]);
    await db.exec("alter table email_list_versions enable trigger email_list_versions_immutable_trg");
    dbList = await importV(T, { name: "App users" }, "database", ["bo@example.com", "dee.secret@private.example", "erin@example.com"], ["Bo Diddley", "Dee Hidden", null]);
    await consent(T, dbList);
    archived = await importV(T, { name: "Old" }, "csv", ["zed@example.com"], ["Zed Gone"]);
    await consent(T, archived);
    await db.query("update email_lists set archived_at = now() where id = $1", [archived.list_id]);

    await db.query("insert into email_suppression (tenant_id, email, reason) values ($1, 'bo@example.com', 'unsubscribe'), ($1, 'cy@example.com', 'bounce')", [T]);
    await db.query("update email_contacts set erased_at = now(), email_norm = null, display_name = null where tenant_id = $1 and email_norm = 'erin@example.com'", [T]);
    await importV(OTHER, { name: "Theirs" }, "csv", ["ada@example.com", "other@example.com"], ["Not Ada", "Other"]);
  }, 120_000);
  afterAll(async () => db?.close());

  it("an owner sees every person on the unarchived lists with their lists, status, source and name", async () => {
    const p = await people(OWNER);
    expect(p.ok).toBe(true);
    expect(p.masked).toBe(false);
    expect(p.rows.map((x) => x.email).sort()).toEqual(["ada@example.com", "bo@example.com", "cy@example.com", "dee.secret@private.example"]);
    expect(p.total).toBe(4);
    const bo = byEmail(p, "bo@")!;
    expect(bo.lists.map((l) => l.name).sort()).toEqual(["App users", "Waitlist"]);
    expect(bo.status).toBe("unsubscribed");
    expect(bo.source).toBe("csv");
    expect(bo.name).toBe("Bo Diddley");
    expect(byEmail(p, "ada@")).toMatchObject({ name: "Ada Lovelace", status: "ok", source: "csv", masked: false, lists: [{ id: csvList.list_id, name: "Waitlist" }] });
    expect(byEmail(p, "cy@")).toMatchObject({ status: "bounced" });
    expect(byEmail(p, "dee.")).toMatchObject({ name: "Dee Hidden", source: "database", masked: false });
    expect(p.counts).toEqual({ contacts: 4, lists: 2, unsubscribed: 1, bounced: 1 });
  });

  it("archived lists and erased people are left out, and another workspace's people never appear", async () => {
    const p = await people(ADMIN, { limit: 200 });
    const emails = p.rows.map((x) => x.email);
    expect(emails).not.toContain("zed@example.com");
    expect(emails.some((e) => e.startsWith("erin"))).toBe(false);
    expect(emails).not.toContain("other@example.com");
    expect(p.rows.flatMap((x) => x.lists.map((l) => l.id))).not.toContain(archived.list_id);
    expect(byEmail(p, "ada@")!.name).toBe("Ada Lovelace");
  });

  it("a member sees addresses copied from the database masked exactly as the list view masks them", async () => {
    const p = await people(MEMBER);
    expect(p.masked).toBe(true);
    const dee = p.rows.find((x) => x.name === "Dee Hidden")!;
    expect(dee.email).toBe(maskAddress("dee.secret@private.example"));
    expect(dee.masked).toBe(true);
    const bo = p.rows.find((x) => x.lists.length === 2)!;
    expect(bo.email).toBe(maskAddress("bo@example.com"));
    expect(byEmail(p, "ada@")).toMatchObject({ email: "ada@example.com", masked: false });
    expect(JSON.stringify(p)).not.toContain("dee.secret");
  });

  it.each(["dee.secret", "secret@private", "DEE.SECRET@PRIVATE.EXAMPLE", "bo@example.com"])(
    "a member searching the raw address %j of a masked person gets no match",
    async (q) => {
      const p = await people(MEMBER, { search: q });
      expect(p.total).toBe(0);
      expect(p.rows).toEqual([]);
    },
  );

  it("an owner finds the same people by address, and a member still finds them by name", async () => {
    expect((await people(OWNER, { search: "DEE.SECRET" })).rows.map((x) => x.name)).toEqual(["Dee Hidden"]);
    expect((await people(MEMBER, { search: "hidden" })).rows.map((x) => x.email)).toEqual([maskAddress("dee.secret@private.example")]);
    expect((await people(MEMBER, { search: "ada@exa" })).rows.map((x) => x.name)).toEqual(["Ada Lovelace"]);
    expect((await people(OWNER, { search: "100%_" })).total).toBe(0);
  });

  it("the list filter keeps only that list's people but still shows every list they are on", async () => {
    const p = await people(OWNER, { list: dbList.list_id });
    expect(p.rows.map((x) => x.email).sort()).toEqual(["bo@example.com", "dee.secret@private.example"]);
    expect(byEmail(p, "bo@")!.lists).toHaveLength(2);
    expect(p.counts!.contacts).toBe(4);
  });

  it("pages, and a stranger is refused", async () => {
    const a = await people(OWNER, { limit: 2, offset: 0 });
    const b = await people(OWNER, { limit: 2, offset: 2 });
    expect(a.total).toBe(4);
    expect(new Set([...a.rows, ...b.rows].map((x) => x.id)).size).toBe(4);
    expect(a.counts).toEqual({ contacts: 4, lists: 2, unsubscribed: 1, bounced: 1 });
    expect(b.counts).toBeNull();
    expect(b.total).toBe(4);
    const searched = await people(OWNER, { search: "ada" });
    expect(searched.counts).toBeNull();
    expect(searched.total).toBe(1);
    expect((await people(OWNER, { search: "   " })).counts).toEqual({ contacts: 4, lists: 2, unsubscribed: 1, bounced: 1 });
    expect(await people(STRANGER)).toEqual({ ok: false, code: "not_authorized" });
  });

  it("a newest import still waiting for consent already shows its people", async () => {
    const v = await importV(T, { name: "Pending" }, "csv", ["pen@example.com"], ["Pen Ding"], MEMBER);
    const p = await people(OWNER, { search: "pen ding" });
    expect(p.rows).toMatchObject([{ email: "pen@example.com", lists: [{ id: v.list_id, name: "Pending" }] }]);
  });

  describe("names from an import", () => {
    const name = async (email: string, tenant = T) => (await one("select display_name n from email_contacts where tenant_id = $1 and email_norm = $2", [tenant, email]))?.n;

    it("are written for a new person, cleaned and capped", async () => {
      const long = `Ann\r\nBcc: x@y.com  ${"z".repeat(300)}`;
      await importV(T, { name: `L ${randomUUID()}` }, "csv", ["ann@example.com", "  Tab@Example.com "], [long, "  Tab\tby   "]);
      const ann = await name("ann@example.com");
      expect(ann).toMatch(/^Ann Bcc: x@y\.com z+$/);
      expect(ann.length).toBe(200);
      expect(await name("tab@example.com")).toBe("Tab by");
    });

    it("never overwrite a name already there, but fill one that was empty", async () => {
      await importV(T, { name: `L ${randomUUID()}` }, "csv", ["fill@example.com"], [null]);
      expect(await name("fill@example.com")).toBeNull();
      await importV(T, { name: `L ${randomUUID()}` }, "csv", ["ada@example.com", "bo@example.com", "fill@example.com"], ["Someone Else", "Bo Other", "Fill Later"]);
      expect(await name("ada@example.com")).toBe("Ada Lovelace");
      expect(await name("bo@example.com")).toBe("Bo Diddley");
      expect(await name("fill@example.com")).toBe("Fill Later");
      expect(await name("ada@example.com", OTHER)).toBe("Not Ada");
    });

    it("an import without names leaves names alone and a blank name stores nothing", async () => {
      await importV(T, { name: `L ${randomUUID()}` }, "csv", ["ada@example.com", "new1@example.com"], null);
      await importV(T, { name: `L ${randomUUID()}` }, "csv", ["new2@example.com"], ["   "]);
      expect(await name("ada@example.com")).toBe("Ada Lovelace");
      expect(await name("new1@example.com")).toBeNull();
      expect(await name("new2@example.com")).toBeNull();
    });

    it("a repeated address takes the first non-empty name", async () => {
      await importV(T, { name: `L ${randomUUID()}` }, "csv", ["rep@example.com", "REP@example.com"], [null, "Second"]);
      expect(await name("rep@example.com")).toBe("Second");
    });

    it("a repeated address in any case or spacing keeps the first cleaned name in file order, and one row per person", async () => {
      const emails = ["  Dup@Example.com ", "dup@example.com", "DUP@EXAMPLE.COM", "dup@example.com", "solo@example.com", "other.dup@example.com", "OTHER.dup@example.com"];
      const names = [null, " \t ", "  First   Pick ", "Later", null, "Odd One", "Odd Two"];
      const out = await importV(T, { name: `L ${randomUUID()}` }, "csv", emails, names);
      expect(out).toMatchObject({ ok: true, contact_count: 3 });
      expect(await name("dup@example.com")).toBe("First Pick");
      expect(await name("solo@example.com")).toBeNull();
      expect(await name("other.dup@example.com")).toBe("Odd One");
      expect((await one("select count(*)::int n from email_contacts where tenant_id = $1 and email_norm = 'dup@example.com'", [T])).n).toBe(1);
      expect((await one("select count(*)::int n from email_list_version_contacts where version_id = $1", [out.version_id])).n).toBe(3);
    });

    it("a 10,000-person import with names and repeats finishes quickly and names every person from their first row", async () => {
      const N = 10_000;
      const emails: string[] = [];
      const names: (string | null)[] = [];
      for (let i = 0; i < N; i++) {
        emails.push(`big${i}@example.com`);
        names.push(i % 7 === 0 ? null : `Person ${i}`);
      }
      for (let i = 0; i < N; i += 7) {
        emails.push(`BIG${i}@example.com`);
        names.push(`Late ${i}`);
      }
      const BIG = randomUUID();
      await db.query("insert into tenants values ($1)", [BIG]);
      await db.query("insert into tenant_users values ($1, $2, 'owner')", [BIG, OWNER]);
      const started = Date.now();
      const out = await importV(BIG, { name: "Everyone" }, "csv", emails, names);
      const ms = Date.now() - started;
      expect(out).toMatchObject({ ok: true, contact_count: N });
      expect(ms).toBeLessThan(15_000);
      const got = await db.query(
        "select email_norm, display_name from email_contacts where tenant_id = $1 and email_norm in ('big0@example.com', 'big1@example.com', 'big7@example.com', 'big9999@example.com')",
        [BIG],
      );
      expect(Object.fromEntries((got.rows as { email_norm: string; display_name: string }[]).map((x) => [x.email_norm, x.display_name]))).toEqual({
        "big0@example.com": "Late 0",
        "big1@example.com": "Person 1",
        "big7@example.com": "Late 7",
        "big9999@example.com": "Person 9999",
      });
      expect((await one("select count(*)::int n from email_contacts where tenant_id = $1 and display_name is null", [BIG])).n).toBe(0);
      expect((await one("select count(*)::int n from email_contacts where tenant_id = $1", [BIG])).n).toBe(N);
    }, 120_000);

    it("names that do not line up with the addresses are refused and nothing is stored", async () => {
      const before = (await one("select count(*)::int n from email_lists where tenant_id = $1", [T])).n;
      await expect(importV(T, { name: `L ${randomUUID()}` }, "csv", ["a1@example.com", "a2@example.com"], ["only one"])).rejects.toThrow(/line up/);
      expect((await one("select count(*)::int n from email_lists where tenant_id = $1", [T])).n).toBe(before);
    });
  });

  describe("the import's existing guards still refuse", () => {
    it.each(["a<b@example.com", "a,b@example.com", "x@nodot", "a\r\nb@example.com"])("%j refuses the whole import, names or not", async (bad) => {
      const listName = `List ${randomUUID()}`;
      const contactsBefore = (await one("select count(*)::int n from email_contacts where tenant_id = $1", [T])).n;
      expect(await importV(T, { name: listName }, "csv", ["ok@example.com", bad], ["Ok", "Bad"])).toEqual({ ok: false, reason: "invalid_address" });
      expect(await importV(T, { name: listName }, "database", ["ok@example.com", bad], null)).toEqual({ ok: false, reason: "invalid_address" });
      expect((await one("select count(*)::int n from email_lists where tenant_id = $1 and name = $2", [T, listName])).n).toBe(0);
      expect((await one("select count(*)::int n from email_contacts where tenant_id = $1", [T])).n).toBe(contactsBefore);
    });

    it("a stranger, a taken name and an archived list are refused", async () => {
      expect(await importV(T, { name: `L ${randomUUID()}` }, "csv", ["s@example.com"], ["S"], STRANGER)).toEqual({ ok: false, reason: "not_a_member" });
      expect(await importV(T, { name: " waitlist " }, "csv", ["s@example.com"], ["S"])).toEqual({ ok: false, reason: "name_taken" });
      expect(await importV(T, { id: archived.list_id }, "csv", ["s@example.com"], ["S"])).toEqual({ ok: false, reason: "list_not_found" });
      expect(await name0("s@example.com")).toBeUndefined();
    });

    it("over 10,000 addresses is too many", async () => {
      const many = Array.from({ length: 10_001 }, (_, i) => `m${i}@example.com`);
      expect(await importV(T, { name: `L ${randomUUID()}` }, "csv", many, null)).toEqual({ ok: false, reason: "too_many" });
    });

    const name0 = async (email: string) => (await one("select display_name n from email_contacts where tenant_id = $1 and email_norm = $2", [T, email]))?.n;
  });

  it("the old seven-argument call still works and only one import function exists", async () => {
    const out = await r("select email_list_import_version($1, null, $2, 'csv', '{}', $3, $4) r", [T, `L ${randomUUID()}`, ["seven@example.com"], OWNER]);
    expect(out).toMatchObject({ ok: true, contact_count: 1 });
    expect((await one("select count(*)::int n from pg_proc where proname = 'email_list_import_version'")).n).toBe(1);
  });

  it("counts addresses already in contacts without writing, ignoring erased people and other workspaces", async () => {
    const before = (await one("select count(*)::int n from email_contacts")).n;
    expect(await r("select email_contacts_existing_count($1, $2, $3) r", [T, OWNER, [" ADA@example.com", "ada@example.com", "erin@example.com", "other@example.com", "nobody@example.com", ""]])).toBe(1);
    expect((await one("select count(*)::int n from email_contacts")).n).toBe(before);
  });

  it("a member's existing count leaves out people they only see masked, so a CSV cannot confirm a hidden address", async () => {
    const count = (user: string, emails: string[]) => r("select email_contacts_existing_count($1, $2, $3) r", [T, user, emails]);
    const probe = ["ada@example.com", "bo@example.com", "dee.secret@private.example", "zed@example.com"];
    expect(await count(OWNER, probe)).toBe(4);
    expect(await count(ADMIN, probe)).toBe(4);
    expect(await count(MEMBER, probe)).toBe(2);
    expect(await count(MEMBER, ["dee.secret@private.example"])).toBe(0);
    expect(await count(MEMBER, ["bo@example.com"])).toBe(0);
    expect(await count(MEMBER, ["ada@example.com"])).toBe(1);
    expect(await count(MEMBER, ["zed@example.com"])).toBe(1);
    expect(await count(STRANGER, probe)).toBe(0);
    expect(await r("select email_contacts_existing_count($1, null, $2) r", [T, probe])).toBe(0);
    expect((await one("select count(*)::int n from pg_proc where proname = 'email_contacts_existing_count'")).n).toBe(1);
  });

  it("a database list that is archived still hides its people from a member's existing count", async () => {
    const S = randomUUID();
    await db.query("insert into tenants values ($1)", [S]);
    await db.query("insert into tenant_users values ($1, $2, 'owner'), ($1, $3, 'member')", [S, OWNER, MEMBER]);
    const v = await importV(S, { name: "Customers" }, "database", ["hidden@arch.example"], null);
    await consent(S, v);
    await db.query("update email_lists set archived_at = now() where id = $1", [v.list_id]);
    const count = (user: string) => r("select email_contacts_existing_count($1, $2, $3) r", [S, user, ["hidden@arch.example"]]);
    expect(await count(OWNER)).toBe(1);
    expect(await count(MEMBER)).toBe(0);
  });

  it("status matches email_bulk_block_reason for every person across all three do-not-email records", async () => {
    const S = randomUUID();
    await db.query("insert into tenants values ($1)", [S]);
    await db.query("insert into tenant_users values ($1, $2, 'owner')", [S, OWNER]);
    const emails = ["ok@s.example", "cu@s.example", "cb@s.example", "cm@s.example", "ec@s.example", "ee@s.example", "both@s.example", "unk@s.example"];
    await importV(S, { name: "Mixed" }, "csv", emails, null);
    await db.query("insert into comms_unsubscribes (tenant_id, channel, recipient) values ($1, 'email', 'cu@s.example'), ($1, 'email', 'both@s.example'), ($1, 'sms', 'ok@s.example')", [S]);
    await db.query("insert into comms_suppressions (tenant_id, channel, recipient, reason) values ($1, 'email', 'cb@s.example', 'bounce'), ($1, 'email', 'cm@s.example', 'manual'), ($1, 'email', 'both@s.example', 'complaint')", [S]);
    await db.query("insert into email_suppression (tenant_id, email, reason) values ($1, 'ec@s.example', 'complaint'), ($1, 'ee@s.example', 'erased'), ($1, 'both@s.example', 'bounce'), ($1, 'unk@s.example', 'manual')", [S]);
    await db.query("insert into email_suppression (tenant_id, email, reason) values ($1, 'ok@s.example', 'unsubscribe')", [OTHER]);
    const p = await people(OWNER, { limit: 200 }, S);
    const got = Object.fromEntries(p.rows.map((x) => [x.email, x.status]));
    expect(got).toEqual({
      "ok@s.example": "ok",
      "cu@s.example": "unsubscribed",
      "cb@s.example": "bounced",
      "cm@s.example": "suppressed",
      "ec@s.example": "complained",
      "ee@s.example": "erased",
      "both@s.example": "bounced",
      "unk@s.example": "suppressed",
    });
    for (const e of emails) {
      expect(got[e]).toBe((await one("select coalesce(email_bulk_block_reason($1, $2), 'ok') s", [S, e])).s);
    }
    expect(p.counts).toEqual({ contacts: 8, lists: 1, unsubscribed: 1, bounced: 2 });
  });

  it("is re-runnable", async () => {
    await db.exec(rawSql(FILE));
    expect((await people(OWNER)).ok).toBe(true);
    expect((await one("select count(*)::int n from pg_proc where proname = 'email_list_import_version'")).n).toBe(1);
  });
});
