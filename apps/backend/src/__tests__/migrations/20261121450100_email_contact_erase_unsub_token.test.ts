import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootEmailPipeline, PGLITE_MODULES, type Db } from "./email-pipeline-pglite";

const T = randomUUID();
const OTHER = randomUUID();
const PRIOR = ["20261031191200_email_bulk_engagement.sql", "20261108110100_email_suppression_reason_precedence.sql", "20261108110200_email_contact_erase_marks_erased.sql"];
const MINE = [...PRIOR, "20261121450100_email_contact_erase_unsub_token.sql"];

describe.skipIf(!PGLITE_MODULES)("20261121450100 erasing a contact drops the address from the unsubscribe tokens (pglite)", () => {
  let db: Db;
  const one = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows[0];
  const contact = async (t: string, email: string) => (await one("insert into email_contacts (tenant_id, email_norm) values ($1, $2) returning id", [t, email])).id as string;
  const token = async (t: string, email: string) => (await one("select get_or_create_unsub_token($1, $2) r", [t, email])).r as string;
  const stored = async (t: string, email: string) => (await one("select count(*)::int n from email_unsub_token where tenant_id = $1 and email = $2", [t, email])).n as number;

  beforeAll(async () => {
    db = await bootEmailPipeline(MINE);
    await db.query("insert into tenants values ($1), ($2)", [T, OTHER]);
  }, 120_000);
  afterAll(async () => db?.close());

  it("the erased address leaves email_unsub_token; another person and the same address in another workspace keep theirs", async () => {
    const c = await contact(T, "gone@x.test");
    await contact(T, "stays@x.test");
    await contact(OTHER, "gone@x.test");
    await token(T, "gone@x.test");
    const kept = await token(T, "stays@x.test");
    const elsewhere = await token(OTHER, "gone@x.test");

    expect((await one("select email_contact_erase($1, $2) r", [T, c])).r).toBe(true);

    expect(await stored(T, "gone@x.test")).toBe(0);
    expect(await token(T, "stays@x.test")).toBe(kept);
    expect(await token(OTHER, "gone@x.test")).toBe(elsewhere);
  });

  it("a send racing the erase asks for a token afterwards: the address is not stored again and that token resolves to nothing", async () => {
    const c = await contact(T, "raced@x.test");
    await token(T, "raced@x.test");
    await db.query("select email_contact_erase($1, $2)", [T, c]);

    const late = await token(T, "raced@x.test");

    expect(late).toMatch(/^[0-9a-f-]{36}$/);
    expect(await stored(T, "raced@x.test")).toBe(0);
    expect((await one("select count(*)::int n from email_unsub_token where token = $1", [late])).n).toBe(0);
  });

  it("an address suppressed for any other reason keeps a stable, stored token, whatever its case", async () => {
    await db.query("select suppress_email($1, $2, 'bounce')", [T, "bounced@x.test"]);
    const a = await token(T, "Bounced@X.test");
    expect(await token(T, "bounced@x.test")).toBe(a);
    expect(await stored(T, "bounced@x.test")).toBe(1);
  });
});
