import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { keepEmailSendOutcomeLine, notifyEmailSendOutcome, notifyEmailSendOutcomeOrThrow, type OutcomeDeps, type SendOutcome } from "@/services/email-cards/outcome";

type Db = { exec: (q: string) => Promise<unknown>; query: (q: string, p?: unknown[]) => Promise<{ rows: any[] }>; close: () => Promise<void> };
let db: Db;

const DIR = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20261119110200_email_send_outcome_claim_release.sql";
const KIND = readFileSync(join(DIR, "20261031191500_email_send_outcome_kind.sql"), "utf-8");
const UNKNOWN = readFileSync(join(DIR, "20261111140000_email_send_outcome_unknown.sql"), "utf-8");
const sql = readFileSync(join(DIR, FILE), "utf-8");
const modules = process.env.SITES_SQL_TEST_MODULES;

const TENANT = "90518100-0000-4000-8000-000000000001";
const OTHER = "90518100-0000-4000-8000-000000000002";
const CARD = "cccccccc-0000-4000-8000-000000000101";
const OLD_CARD = "cccccccc-0000-4000-8000-000000000102";

const o: SendOutcome = { tenant_id: TENANT, rail: "decisions", card_id: CARD, outcome: "sent", sent: 3, total: 3 };

function world(failSends: number) {
  let failsLeft = failSends;
  const attempts: string[] = [];
  const delivered: string[] = [];
  const startResults: string[] = [];
  const deps: Partial<OutcomeDeps> = {
    readCard: async () => ({ body: { variants: [{ content: { subject: "Spring sale" } }], chosen_variant: 1, list_name: "Members" }, approved_by: "u-admin", approved_by_source: null }),
    claim: async (t, rail, id, outcome, line, kind) => {
      const r = (await db.query("select claim_email_send_outcome_tell($1, $2, $3, $4, $5, $6) as c", [t, rail, id, outcome, line, kind ?? ""])).rows[0].c as string;
      return r === "claimed" ? true : r === "reclaimed" ? "reclaimed" : false;
    },
    keep: async (t, rail, id, outcome, line, kind) =>
      (await db.query("select keep_email_send_outcome_line($1, $2, $3, $4, $5, $6) as k", [t, rail, id, outcome, line, kind ?? ""])).rows[0].k as boolean,
    release: async (t, rail, id, outcome, kind) => {
      await db.query("select release_email_send_outcome($1, $2, $3, $4, $5)", [t, rail, id, outcome, kind ?? ""]);
    },
    emailOf: async () => "admin@northwind.test",
    ownerEmail: async () => "owner@northwind.test",
    send: async (to) => {
      attempts.push(to);
      await new Promise((r) => setTimeout(r, 5));
      if (failsLeft > 0) {
        failsLeft -= 1;
        throw new Error("SendGrid 503");
      }
      delivered.push(to);
    },
    startResults: async (x) => {
      startResults.push(x.card_id);
    },
  };
  return { deps, attempts, delivered, startResults };
}

const rows = async () => (await db.query("select outcome, kind, line, claimed_at is not null as held from email_send_outcomes where card_id = $1", [CARD])).rows;

describe.skipIf(!modules)(`${FILE}: a failed outcome email never burns its claim (pglite)`, () => {
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
    await db.exec(UNKNOWN);
    await db.query("insert into tenants values ($1), ($2)", [TENANT, OTHER]);
    await db.query("insert into decisions values ($1, $2)", [OLD_CARD, TENANT]);
    await db.query("insert into email_send_outcomes (tenant_id, rail, card_id, outcome, line) values ($1, 'decisions', $2, 'sent', 'told before this migration')", [TENANT, OLD_CARD]);
    await db.exec(sql);
    await db.exec(sql);
  });
  afterAll(async () => db?.close());
  beforeEach(async () => {
    await db.query("delete from email_send_outcomes where card_id = $1", [CARD]);
    await db.query("delete from decisions where id = $1", [CARD]);
    await db.query("insert into decisions values ($1, $2)", [CARD, TENANT]);
  });

  it("a send that fails once is sent by the next teller, exactly once, and results start once", async () => {
    const w = world(1);
    expect(await notifyEmailSendOutcome(o, w.deps)).toBe(false);
    expect(await rows()).toEqual([expect.objectContaining({ outcome: "sent", held: false })]);
    expect(await notifyEmailSendOutcome(o, w.deps)).toBe(true);
    expect(await notifyEmailSendOutcome(o, w.deps)).toBe(false);
    expect(w.attempts).toEqual(["admin@northwind.test", "admin@northwind.test"]);
    expect(w.delivered).toEqual(["admin@northwind.test"]);
    expect(w.startResults).toEqual([CARD]);
    expect(await rows()).toEqual([expect.objectContaining({ held: true })]);
  });

  it("a line kept after every retry failed still lets a later teller send the one notice", async () => {
    const w = world(1);
    await expect(notifyEmailSendOutcomeOrThrow(o, w.deps)).rejects.toThrow();
    expect(await keepEmailSendOutcomeLine(o, w.deps)).toBe(false);
    expect(await rows()).toEqual([expect.objectContaining({ held: false })]);
    expect(await notifyEmailSendOutcome(o, w.deps)).toBe(true);
    expect(await notifyEmailSendOutcome(o, w.deps)).toBe(false);
    expect(w.delivered).toEqual(["admin@northwind.test"]);
    expect(w.startResults).toEqual([CARD]);
  });

  it("a line kept when nothing was ever sent is claimed by the next teller, which sends once", async () => {
    const w = world(0);
    expect(await keepEmailSendOutcomeLine(o, w.deps)).toBe(true);
    expect(await rows()).toEqual([expect.objectContaining({ held: false })]);
    expect(await notifyEmailSendOutcome(o, w.deps)).toBe(true);
    expect(await notifyEmailSendOutcome(o, w.deps)).toBe(false);
    expect(w.attempts).toEqual(["admin@northwind.test"]);
  });

  it("concurrent tellers after a failed send email the approver once", async () => {
    const w = world(1);
    expect(await notifyEmailSendOutcome(o, w.deps)).toBe(false);
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => notifyEmailSendOutcome(o, w.deps)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(w.delivered).toEqual(["admin@northwind.test"]);
    expect(w.attempts).toHaveLength(2);
  });

  it("concurrent first tellers email the approver once", async () => {
    const w = world(0);
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => notifyEmailSendOutcome(o, w.deps)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(w.delivered).toEqual(["admin@northwind.test"]);
  });

  it("an outcome told before this migration stays told: no teller sends it again", async () => {
    const w = world(0);
    expect(await notifyEmailSendOutcome({ ...o, card_id: OLD_CARD }, w.deps)).toBe(false);
    expect(w.attempts).toEqual([]);
  });

  it("another tenant cannot claim, keep or release this card's outcome", async () => {
    const w = world(1);
    expect(await notifyEmailSendOutcome(o, w.deps)).toBe(false);
    expect((await db.query("select claim_email_send_outcome_tell($1, 'decisions', $2, 'sent', 'x') as c", [OTHER, CARD])).rows[0].c).toBe("taken");
    expect((await db.query("select keep_email_send_outcome_line($1, 'decisions', $2, 'sent', 'x') as k", [OTHER, CARD])).rows[0].k).toBe(false);
    expect((await db.query("select claim_email_send_outcome_tell($1, 'decisions', $2, 'sent', 'mine') as c", [TENANT, CARD])).rows[0].c).toBe("reclaimed");
    expect((await db.query("select release_email_send_outcome($1, 'decisions', $2, 'sent') as r", [OTHER, CARD])).rows[0].r).toBe(false);
    expect(await rows()).toEqual([expect.objectContaining({ held: true, line: "mine" })]);
  });

  it("re-applying the migration leaves a released claim released, so the next teller still sends the one notice", async () => {
    const w = world(1);
    expect(await notifyEmailSendOutcome(o, w.deps)).toBe(false);
    expect(await rows()).toEqual([expect.objectContaining({ outcome: "sent", held: false })]);
    await db.exec(sql);
    await db.exec(sql);
    expect(await rows()).toEqual([expect.objectContaining({ outcome: "sent", held: false })]);
    expect(await notifyEmailSendOutcome(o, w.deps)).toBe(true);
    expect(w.delivered).toEqual(["admin@northwind.test"]);
    expect(w.startResults).toEqual([CARD]);
  });

  it("the old claim still marks a row as told, so code from before this migration never sends twice", async () => {
    expect((await db.query("select claim_email_send_outcome($1, 'decisions', $2, 'sent', 'old') as c", [TENANT, CARD])).rows[0].c).toBe(true);
    expect((await db.query("select claim_email_send_outcome_tell($1, 'decisions', $2, 'sent', 'new') as c", [TENANT, CARD])).rows[0].c).toBe("taken");
  });
});
