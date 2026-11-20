import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { emailSendOutcomeLine } from "@/email/templates/email-send-outcome";

type Db = { exec: (q: string) => Promise<unknown>; query: (q: string, p?: unknown[]) => Promise<{ rows: any[] }>; close: () => Promise<void> };
let db: Db;

const DIR = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20261111140000_email_send_outcome_unknown.sql";
const KIND = readFileSync(join(DIR, "20261031191500_email_send_outcome_kind.sql"), "utf-8");
const sql = readFileSync(join(DIR, FILE), "utf-8");
const modules = process.env.SITES_SQL_TEST_MODULES;

const TENANT = "90508080-0000-4000-8000-000000000001";
const OTHER = "90508080-0000-4000-8000-000000000002";
const CARD = "cccccccc-0000-4000-8000-000000000001";

const claim = async (outcome: string, tenant = TENANT, kind = "") =>
  (await db.query("select claim_email_send_outcome($1, 'decisions', $2, $3, $4, $5) as c", [tenant, CARD, outcome, `line ${outcome}`, kind])).rows[0].c as boolean;

describe.skipIf(!modules)(`${FILE}: an unclear send is told once as "may have gone out" (pglite)`, () => {
  beforeAll(async () => {
    const { PGlite } = createRequire(resolve(modules!, "../package.json"))("@electric-sql/pglite");
    db = new PGlite();
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create table tenants (id uuid primary key);
      create table decisions (id uuid primary key, tenant_id uuid not null);
      create table public.email_send_outcomes (
        id         uuid primary key default gen_random_uuid(),
        tenant_id  uuid not null references public.tenants(id) on delete cascade,
        rail       text not null check (rail in ('channel_actions', 'decisions')),
        card_id    uuid not null,
        outcome    text not null check (outcome in ('sent', 'failed')),
        line       text not null check (char_length(line) between 1 and 500),
        created_at timestamptz not null default now(),
        unique (rail, card_id, outcome)
      );
      create function _email_card(p_tenant_id uuid, p_rail text, p_id uuid, p_lock boolean, out o_found boolean)
      language sql as $$ select exists (select 1 from decisions d where d.id = p_id and d.tenant_id = p_tenant_id) $$;
    `);
    await db.exec(KIND);
    await db.exec(sql);
    await db.exec(sql);
  });
  afterAll(async () => db?.close());
  beforeEach(async () => {
    await db.exec("delete from email_send_outcomes; delete from decisions; delete from tenants;");
    await db.query("insert into tenants values ($1), ($2)", [TENANT, OTHER]);
    await db.query("insert into decisions values ($1, $2)", [CARD, TENANT]);
  });

  it("claims an unknown outcome exactly once, for the card's own tenant only", async () => {
    expect(await claim("unknown", OTHER)).toBe(false);
    expect(await claim("unknown")).toBe(true);
    expect(await claim("unknown")).toBe(false);
    expect((await db.query("select outcome, line from email_send_outcomes")).rows).toEqual([{ outcome: "unknown", line: "line unknown" }]);
  });

  it("a later definite answer is still told: unknown never suppresses sent or failed", async () => {
    expect(await claim("unknown")).toBe(true);
    expect(await claim("sent")).toBe(true);
    expect(await claim("failed")).toBe(true);
    expect(await claim("sent")).toBe(false);
  });

  it("the line Zavi writes for an unclear send, with the longest subject, fits the claim", async () => {
    const line = emailSendOutcomeLine({ outcome: "unknown", subject: "S".repeat(200), listName: "L".repeat(120), sent: null, total: null, reason: "R".repeat(500), kind: undefined });
    expect(line).toMatch(/may have gone out/);
    expect(line).not.toMatch(/not sent/i);
    const out = await db.query("select claim_email_send_outcome($1, 'decisions', $2, 'unknown', $3) as c", [TENANT, CARD, line]);
    expect(out.rows[0].c).toBe(true);
    expect((await db.query("select char_length(line) n from email_send_outcomes")).rows[0].n).toBe(500);
  });

  it("anything else is still refused by the table", async () => {
    await expect(claim("maybe")).rejects.toThrow(/email_send_outcomes_outcome_check/);
  });
});
