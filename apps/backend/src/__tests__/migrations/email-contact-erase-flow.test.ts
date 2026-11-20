import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootEmailPipeline, PGLITE_MODULES, type Db } from "./email-pipeline-pglite";

const T = randomUUID();
const OTHER = randomUUID();
const OWNER = randomUUID();
const OTHER_OWNER = randomUUID();
const MINE = [
  "20261031191200_email_bulk_engagement.sql",
  "20261108100000_email_send_pause.sql",
  "20261108100100_email_card_takeover_and_redispatch.sql",
  "20261108100150_email_card_tests_atomic.sql",
  "20261108100200_email_bulk_fanout_fixes.sql",
  "20261108100300_email_card_send_state_and_doors.sql",
  "20261108100400_email_send_double_send_guards.sql",
  "20261108110100_email_suppression_reason_precedence.sql",
  "20261108110200_email_contact_erase_marks_erased.sql",
  "20261111110100_email_bulk_freeze_spread_over_cap.sql",
  "20261111130000_email_member_edit_consent_and_import_guards.sql",
  "20261111182000_email_contacts_people_and_names.sql",
  "20261115150000_email_list_import_base_version.sql",
  "20261115160000_email_people_hide_database_lists_from_members.sql",
  "20261117210001_email_bulk_failed_send_refunds_allowance.sql",
  "20261121450100_email_contact_erase_unsub_token.sql",
];

describe.skipIf(!PGLITE_MODULES)("erasing a contact, through to the next send (pglite)", () => {
  let db: Db;
  const one = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows[0];
  const r = async (sql: string, p: unknown[] = []) => (await one(sql, p)).r;
  const importList = (t: string, by: string, listId: string | null, name: string | null, emails: string[], names: string[] | null = null) =>
    r("select email_list_import_version($1, $2, $3, 'csv', '{}'::jsonb, $4, $5, $6, null) r", [t, listId, name, emails, by, names]);
  const consent = async (t: string, by: string, list: string, version: string) => {
    await db.query("update email_list_versions set consent_text = 'yes', consent_confirmed_by = $2, consent_confirmed_at = now() where id = $1", [version, by]);
    await db.query("update email_lists set active_version_id = $2 where id = $1 and tenant_id = $3", [list, version, t]);
  };
  const list = async (t: string, by: string, name: string, emails: string[]) => {
    const out = await importList(t, by, null, name, emails);
    await consent(t, by, out.list_id, out.version_id);
    return { list: out.list_id as string, version: out.version_id as string };
  };
  const contactId = async (t: string, email: string) => (await one("select id from email_contacts where tenant_id = $1 and email_norm = $2", [t, email]))?.id as string;
  const erase = (t: string, id: string) => r("select email_contact_erase($1, $2) r", [t, id]);
  const people = (t: string, by: string, listId: string | null = null) => r("select email_contacts_people($1, $2, null, $3, 50, 0) r", [t, by, listId]);
  const addresses = async (t: string, by: string, listId: string | null = null) => (await people(t, by, listId)).rows.map((p: { email: string }) => p.email);
  const freeze = async (t: string, by: string, l: { list: string; version: string }) => {
    await db.query("select set_config('zavi.email_card_approve', 'on', false)");
    const decision = (await one("insert into decisions (tenant_id, decision_class, body, status, approved_by) values ($1, 'bulk_outbound.send', '{}', 'approved', $2) returning id", [t, by])).id;
    await db.query("select set_config('zavi.email_card_approve', '', false)");
    return r("select email_bulk_freeze_send($1, $2, $3, $4, 'S', 'b', 'hi@acme.test', null, 1000) r", [t, decision, l.list, l.version]);
  };
  const recipients = async (sendId: string) => (await db.query("select email_at_send e, status s, skip_reason k from email_bulk_send_recipients where send_id = $1 order by email_at_send nulls first", [sendId])).rows;

  beforeAll(async () => {
    db = await bootEmailPipeline(MINE);
    await db.query("insert into tenants values ($1), ($2)", [T, OTHER]);
    await db.query("insert into tenant_users values ($1, $2, 'owner'), ($3, $4, 'owner')", [T, OWNER, OTHER, OTHER_OWNER]);
  }, 120_000);
  afterAll(async () => db?.close());

  it("the person leaves every list at once, including a list still waiting on consent, and no later send has them", async () => {
    const a = await list(T, OWNER, "Every A", ["gone@every.test", "stays@every.test"]);
    const b = await list(T, OWNER, "Every B", ["gone@every.test", "other@every.test"]);
    const waiting = await importList(T, OWNER, null, "Every C", ["gone@every.test"]);

    expect(await erase(T, await contactId(T, "gone@every.test"))).toBe(true);

    expect(await addresses(T, OWNER)).not.toContain("gone@every.test");
    expect(await addresses(T, OWNER, a.list)).toEqual(["stays@every.test"]);
    expect(await addresses(T, OWNER, b.list)).toEqual(["other@every.test"]);
    expect(await addresses(T, OWNER, waiting.list_id)).toEqual([]);
    expect((await r("select email_list_version_emails($1, $2, $3, 100) r", [T, a.list, a.version]))).toEqual(["stays@every.test"]);
    const sent = await freeze(T, OWNER, a);
    expect(sent).toMatchObject({ ok: true, total: 1 });
    expect(await recipients(sent.send_id)).toEqual([{ e: "stays@every.test", s: "pending", k: null }]);
    expect(await one("select email_norm, display_name from email_contacts where tenant_id = $1 and erased_at is not null limit 1", [T])).toEqual({ email_norm: null, display_name: null });
  });

  it("a re-upload brings the address back only as Erased: blocked, counted as blocked, left out of the next send, any spelling", async () => {
    const before = await list(T, OWNER, "Reup", ["back@reup.test", "keep@reup.test"]);
    await erase(T, await contactId(T, "back@reup.test"));

    const again = await importList(T, OWNER, before.list, null, ["  BACK@Reup.test ", "keep@reup.test"], ["Back Again", "Keep"]);
    await consent(T, OWNER, before.list, again.version_id);

    expect(again).toMatchObject({ ok: true, contact_count: 2, already_blocked: 1 });
    expect(await r("select email_bulk_block_reason($1, 'back@reup.test') r", [T])).toBe("erased");
    const row = (await people(T, OWNER, before.list)).rows.find((p: { email: string }) => p.email === "back@reup.test");
    expect(row.status).toBe("erased");
    expect(await r("select email_list_version_freeze_count($1, $2) r", [T, again.version_id])).toBe(1);
    const sent = await freeze(T, OWNER, { list: before.list, version: again.version_id });
    expect(await recipients(sent.send_id)).toEqual([{ e: "keep@reup.test", s: "pending", k: null }]);
  });

  it("erasing the re-uploaded row removes it again and the block holds", async () => {
    const l = await list(T, OWNER, "Twice", ["twice@x.test"]);
    await erase(T, await contactId(T, "twice@x.test"));
    await importList(T, OWNER, l.list, null, ["twice@x.test"]);
    expect(await erase(T, await contactId(T, "twice@x.test"))).toBe(true);
    expect(await addresses(T, OWNER, l.list)).toEqual([]);
    expect(await r("select email_bulk_block_reason($1, 'twice@x.test') r", [T])).toBe("erased");
  });

  it("a send in progress: everyone waiting is skipped, the claimed email is stopped at the last check, and nobody else is touched", async () => {
    const l = await list(T, OWNER, "Flight", ["a@flight.test", "b@flight.test", "c@flight.test"]);
    const send = (await freeze(T, OWNER, l)).send_id;
    const claim = await r("select email_bulk_claim_next($1, $2, 0) r", [T, send]);
    expect(claim.outcome).toBe("claimed");
    const [waiting, untouched] = ["a@flight.test", "b@flight.test", "c@flight.test"].filter((e) => e !== claim.email);

    await erase(T, claim.contact_id);
    await erase(T, await contactId(T, waiting));

    expect(await r("select email_bulk_skip_if_blocked($1, $2, $3) r", [T, send, claim.contact_id])).toBe("erased");
    expect(await recipients(send)).toEqual([
      { e: null, s: "skipped", k: "erased" },
      { e: null, s: "skipped", k: "erased" },
      { e: untouched, s: "pending", k: null },
    ]);
    expect(await r("select email_bulk_claim_next($1, $2, 0) r", [T, send])).toMatchObject({ outcome: "claimed", email: untouched });
    expect(await r("select email_bulk_claim_next($1, $2, 0) r", [T, send])).toEqual({ outcome: "none_pending" });
  });

  it("an email the provider took just before the erase is recorded as sent, not hidden as skipped, and the address stays gone", async () => {
    const l = await list(T, OWNER, "Raced", ["raced@x.test"]);
    const send = (await freeze(T, OWNER, l)).send_id;
    const claim = await r("select email_bulk_claim_next($1, $2, 0) r", [T, send]);
    expect(await r("select email_bulk_skip_if_blocked($1, $2, $3) r", [T, send, claim.contact_id])).toBeNull();

    await erase(T, claim.contact_id);

    expect(await r("select email_bulk_settle_recipient($1, $2, $3, 'sent') r", [T, send, claim.contact_id])).toBe(true);
    expect(await recipients(send)).toEqual([{ e: null, s: "sent", k: null }]);
  });

  it("another workspace cannot erase this contact, and nothing of either workspace moves", async () => {
    const mine = await list(T, OWNER, "Mine", ["shared@iso.test"]);
    const theirs = await list(OTHER, OTHER_OWNER, "Theirs", ["shared@iso.test"]);
    const id = await contactId(T, "shared@iso.test");

    expect(await erase(OTHER, id)).toBe(false);
    expect(await addresses(T, OWNER, mine.list)).toEqual(["shared@iso.test"]);
    expect(await r("select email_bulk_block_reason($1, 'shared@iso.test') r", [T])).toBeNull();
    expect(await r("select email_bulk_block_reason($1, 'shared@iso.test') r", [OTHER])).toBeNull();

    expect(await erase(T, id)).toBe(true);
    expect(await r("select email_bulk_block_reason($1, 'shared@iso.test') r", [OTHER])).toBeNull();
    expect(await addresses(OTHER, OTHER_OWNER, theirs.list)).toEqual(["shared@iso.test"]);
    const sent = await freeze(OTHER, OTHER_OWNER, theirs);
    expect(sent).toMatchObject({ ok: true, total: 1 });
  });

  it("a second erase of the same person answers false, so two clicks cannot both report success", async () => {
    await list(T, OWNER, "Dbl", ["dbl@x.test"]);
    const id = await contactId(T, "dbl@x.test");
    expect(await erase(T, id)).toBe(true);
    expect(await erase(T, id)).toBe(false);
    expect((await one("select count(*)::int n from email_suppression where tenant_id = $1 and email = 'dbl@x.test'", [T])).n).toBe(1);
  });
});
