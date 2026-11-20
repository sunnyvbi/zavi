import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { MEETING_NOTES_RETENTION_DAYS } from "@/services/meetings/recap-destination";

const MIGRATIONS = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20261115190000_notetaker_blank_old_excerpts.sql";
const SQL = readFileSync(join(MIGRATIONS, FILE), "utf-8");
const modules = process.env.SITES_SQL_TEST_MODULES;

const T = "11111111-1111-4111-8111-111111111111";

const SCHEMA = `
  create role anon; create role authenticated; create role service_role;
  create table public.meeting_atoms (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null,
    title text not null,
    status text not null default 'auto_stored',
    source_excerpt text not null default '',
    created_at timestamptz not null default now()
  );
  create table public.decisions (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null,
    decision_class text not null,
    status text not null default 'proposed',
    body jsonb not null default '{}'::jsonb,
    emitted_at timestamptz not null default now()
  );
  create table public.memory_note (id uuid primary key default gen_random_uuid(), body_markdown text not null);
`;

type Db = {
  exec: (q: string) => Promise<unknown>;
  query: <R = Record<string, any>>(q: string, p?: unknown[]) => Promise<{ rows: R[] }>;
  close: () => Promise<void>;
};
let db: Db;

const QUOTE = "Asha: we ship the pricing page Friday";
const daysAgo = (n: number) => `now() - interval '${n} days'`;

describe(FILE, () => {
  it("sorts after the migration that added meeting notes", () => {
    const all = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
    expect(all.indexOf(FILE)).toBeGreaterThan(all.indexOf("20261115170000_notetaker_recap_destination.sql"));
  });
});

describe(`${FILE} executed in Postgres (pglite)`, () => {
  const blank = async () =>
    (await db.query<{ out: { facts: number; cards: number } }>("select public.notetaker_blank_old_excerpts() as out")).rows[0].out;
  const fact = async (title: string) =>
    (await db.query<{ source_excerpt: string; title: string }>("select title, source_excerpt from public.meeting_atoms where title = $1", [title])).rows[0];
  const card = async (id: string) =>
    (await db.query<{ body: any; status: string }>("select body, status from public.decisions where id = $1", [id])).rows[0];
  const fails = async (q: string) => {
    try {
      await db.query(q);
      return false;
    } catch {
      return true;
    }
  };
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    const { PGlite } = modules
      ? createRequire(resolve(modules, "../package.json"))("@electric-sql/pglite")
      : await import("@electric-sql/pglite");
    db = new PGlite();
    await db.exec(SCHEMA);
    await db.exec(SQL);
    await db.exec(SQL);

    const old = MEETING_NOTES_RETENTION_DAYS + 1;
    const fresh = MEETING_NOTES_RETENTION_DAYS - 1;
    await db.exec(`
      insert into public.meeting_atoms (tenant_id, title, status, source_excerpt, created_at) values
        ('${T}', 'old fact', 'approved', '${QUOTE}', ${daysAgo(old)}),
        ('${T}', 'old pending fact', 'pending_review', '${QUOTE}', ${daysAgo(old)}),
        ('${T}', 'fresh fact', 'auto_stored', '${QUOTE}', ${daysAgo(fresh)});
      insert into public.memory_note (body_markdown) values ('Ship Friday\n> ${QUOTE}');
    `);
    const insertCard = async (key: string, cls: string, body: unknown, days: number, status = "expired") => {
      const { rows } = await db.query<{ id: string }>(
        `insert into public.decisions (tenant_id, decision_class, status, body, emitted_at) values ($1, $2, $3, $4::jsonb, ${daysAgo(days)}) returning id`,
        [T, cls, status, JSON.stringify(body)],
      );
      ids[key] = rows[0].id;
    };
    const atoms = [
      { atom_type: "decision", title: "Ship Friday", body: "Pricing page", source_excerpt: QUOTE },
      { atom_type: "policy", title: "Weekly review", body: "", source_excerpt: "" },
      { atom_type: "spec_fact", title: "No excerpt key" },
    ];
    await insertCard("old", "notetaker.write_atoms", { meeting_bot_id: "b1", meeting_date: "2026-09-01", title: "Standup", atoms }, old, "acted");
    await insertCard("oldProposed", "notetaker.write_atoms", { meeting_bot_id: "b2", meeting_date: "2026-09-01", title: "Standup", atoms }, old, "proposed");
    await insertCard("fresh", "notetaker.write_atoms", { meeting_bot_id: "b3", meeting_date: "2026-10-20", title: "Standup", atoms }, fresh);
    await insertCard("noAtoms", "notetaker.write_atoms", { meeting_bot_id: "b4", title: "Standup" }, old);
    await insertCard("otherClass", "memory.write_note", { atoms: [{ source_excerpt: QUOTE }] }, old);
  }, 60_000);
  afterAll(async () => db?.close());

  it(`blanks the quote on facts and review cards older than ${MEETING_NOTES_RETENTION_DAYS} days, and keeps everything else`, async () => {
    expect(await blank()).toEqual({ facts: 2, cards: 3 });

    expect(await fact("old fact")).toEqual({ title: "old fact", source_excerpt: "" });
    expect(await fact("old pending fact")).toEqual({ title: "old pending fact", source_excerpt: "" });
    expect((await fact("fresh fact")).source_excerpt).toBe(QUOTE);

    for (const key of ["old", "oldProposed"]) {
      const { body } = await card(ids[key]);
      expect(body.excerpts_cleared_at).toBeTruthy();
      expect(body.atoms).toEqual([
        { atom_type: "decision", title: "Ship Friday", body: "Pricing page", source_excerpt: "" },
        { atom_type: "policy", title: "Weekly review", body: "", source_excerpt: "" },
        { atom_type: "spec_fact", title: "No excerpt key" },
      ]);
      expect(body).toMatchObject({ meeting_bot_id: expect.any(String), title: "Standup" });
    }
    expect((await card(ids.old)).status).toBe("acted");
    expect((await card(ids.noAtoms)).body).toMatchObject({ meeting_bot_id: "b4", excerpts_cleared_at: expect.any(String) });
    expect((await card(ids.fresh)).body.atoms[0].source_excerpt).toBe(QUOTE);
    expect((await card(ids.fresh)).body.excerpts_cleared_at).toBeUndefined();
    expect((await card(ids.otherClass)).body.atoms[0].source_excerpt).toBe(QUOTE);
    expect((await db.query<{ body_markdown: string }>("select body_markdown from public.memory_note")).rows[0].body_markdown).toContain(QUOTE);
  });

  it("a second run changes nothing", async () => {
    const before = (await card(ids.old)).body.excerpts_cleared_at;
    expect(await blank()).toEqual({ facts: 0, cards: 0 });
    expect((await card(ids.old)).body.excerpts_cleared_at).toBe(before);
  });

  it("only the service role may call it", async () => {
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`);
      try {
        expect(await fails("select public.notetaker_blank_old_excerpts()")).toBe(true);
      } finally {
        await db.exec("reset role");
      }
    }
    await db.exec("set role service_role");
    try {
      expect(await fails("select public.notetaker_blank_old_excerpts()")).toBe(false);
    } finally {
      await db.exec("reset role");
    }
  });
});
