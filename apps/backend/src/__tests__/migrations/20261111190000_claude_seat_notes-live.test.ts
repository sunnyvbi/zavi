import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client, types } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StaleRevisionError } from "@/services/tenant-client";
import { editSecretList, parseSecretList, type SecretListDeps } from "@/services/settings";

const PG_URL = process.env.ZAVI_TEST_VANILLA_PG_URL;
const KEY = "anthropic_oauth_token_pool";
const MIGRATION = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20261111190000_claude_seat_notes.sql"),
  "utf8",
);
const T1 = "sk-ant-oat01-aaaaaaaaaaaaaaaa1111";
const T2 = "sk-ant-oat01-bbbbbbbbbbbbbbbb2222";
const T3 = "sk-ant-oat01-cccccccccccccccc3333";
const seatOf = (t: string) => `seat_${Buffer.from(t).toString("hex").slice(-12)}`;

const BOOTSTRAP = `
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
  end $$;
  drop table if exists public.agent_auth_seat_note;
  drop table if exists public.app_setting;
  create table public.app_setting (
    key text primary key, value jsonb not null, value_type text not null default 'boolean',
    description text not null default '', updated_at timestamptz not null default now(), updated_by text
  );
  grant select, insert, update, delete on public.app_setting to service_role;
`;

const asText = {
  getTypeParser: ((oid: number, format?: "text" | "binary") =>
    oid === 1184 ? (v: string) => v : types.getTypeParser(oid, format as "text")) as typeof types.getTypeParser,
};

describe.skipIf(!PG_URL)("20261111190000 claude seat notes, live", () => {
  let db: Client;
  const clients: Client[] = [];
  const connect = async () => {
    const c = new Client({ connectionString: PG_URL, types: asText });
    await c.connect();
    clients.push(c);
    return c;
  };
  const apply = (c: Client, a: Partial<Parameters<SecretListDeps["apply"]>[0]> & { expectedRevision: string | null; value: string }) =>
    c
      .query("select public.apply_secret_list_edit($1, $2, $3, $4, $5::jsonb, $6::text[], $7) as rev", [
        a.key ?? KEY,
        a.expectedRevision,
        a.value,
        "desc",
        JSON.stringify(a.noteUpserts ?? []),
        a.noteDeletes ?? [],
        "staff@test",
      ])
      .then((r) => r.rows[0].rev as string);
  const snapshot = async () =>
    (await db.query("select value #>> '{}' as value, updated_at from app_setting where key = $1", [KEY])).rows[0] as
      | { value: string; updated_at: string }
      | undefined;
  const notes = async () =>
    Object.fromEntries((await db.query("select seat, note from agent_auth_seat_note order by seat")).rows.map((r) => [r.seat, r.note]));

  const pgDeps = (c: Client): SecretListDeps => ({
    async readSnapshot() {
      const r = (await c.query("select value, updated_at from app_setting where key = $1", [KEY])).rows[0];
      return { value: r?.value, revision: r?.updated_at ?? null };
    },
    async readNotes(seats) {
      const r = await c.query("select seat, note from agent_auth_seat_note where seat = any($1)", [seats]);
      return new Map(r.rows.map((x) => [x.seat, x.note]));
    },
    async apply(a) {
      try {
        return await apply(c, a);
      } catch (e) {
        if ((e as Error).message === "stale_revision") throw new StaleRevisionError();
        throw e;
      }
    },
    seatOf,
    notesEnabled: () => true,
  });

  beforeAll(async () => {
    db = await connect();
  });
  afterAll(async () => {
    for (const c of clients) await c.end();
  });

  const reset = async () => {
    await db.query(BOOTSTRAP);
    await db.query(MIGRATION);
  };

  it("the migration applies twice (idempotent)", async () => {
    await reset();
    await db.query(MIGRATION);
  });

  it("first write needs a null revision; every later write needs the current one", async () => {
    await reset();
    const r1 = await apply(db, { expectedRevision: null, value: T1 });
    expect(await snapshot()).toMatchObject({ value: T1 });
    await expect(apply(db, { expectedRevision: null, value: T2 })).rejects.toThrow("stale_revision");
    const r2 = await apply(db, { expectedRevision: r1, value: `${T1},${T2}` });
    expect(r2).not.toBe(r1);
    await expect(apply(db, { expectedRevision: r1, value: T3 })).rejects.toThrow("stale_revision");
    const raw = (await db.query("select jsonb_typeof(value) t, value from app_setting where key = $1", [KEY])).rows[0];
    expect(raw.t).toBe("string");
    expect(parseSecretList(raw.value)).toEqual([T1, T2]);
  });

  it("a stale write raises plain P0001, never 40001 (PostgREST 14 retries 40001 without limit)", async () => {
    await reset();
    await apply(db, { expectedRevision: null, value: T1 });
    const code = await apply(db, { expectedRevision: null, value: T2 }).then(
      () => "no error",
      (e: { code?: string }) => e.code,
    );
    expect(code).toBe("P0001");
  });

  it("a note-only edit still moves the revision", async () => {
    await reset();
    const r1 = await apply(db, { expectedRevision: null, value: T1 });
    const r2 = await apply(db, { expectedRevision: r1, value: T1, noteUpserts: [{ seat: seatOf(T1), note: "Ravi's Max" }] });
    expect(r2).not.toBe(r1);
    expect(await notes()).toEqual({ [seatOf(T1)]: "Ravi's Max" });
    await expect(
      apply(db, { expectedRevision: r1, value: T1, noteUpserts: [{ seat: seatOf(T1), note: "stale" }] }),
    ).rejects.toThrow("stale_revision");
  });

  it("refuses a note that carries a pool token, and writes nothing", async () => {
    await reset();
    const r1 = await apply(db, { expectedRevision: null, value: `${T1},${T2}` });
    await expect(
      apply(db, { expectedRevision: r1, value: `${T1},${T2}`, noteUpserts: [{ seat: seatOf(T1), note: `spare ${T2}` }] }),
    ).rejects.toThrow("note_contains_credential");
    expect((await snapshot())?.updated_at).toBe(r1);
    expect(await notes()).toEqual({});
  });

  it("refuses other keys, whitespace in the value, and malformed seats or notes", async () => {
    await reset();
    await expect(apply(db, { key: "memory_reranker_enabled", expectedRevision: null, value: "x" })).rejects.toThrow(/not a credential list/);
    await expect(apply(db, { expectedRevision: null, value: `${T1}, ${T2}` })).rejects.toThrow(/without whitespace/);
    await expect(apply(db, { expectedRevision: null, value: T1, noteUpserts: [{ seat: "not-a-seat", note: "x" }] })).rejects.toThrow(
      /check constraint/,
    );
    await expect(apply(db, { expectedRevision: null, value: T1, noteUpserts: [{ seat: seatOf(T1), note: "  " }] })).rejects.toThrow(
      /check constraint/,
    );
  });

  it("deletes exactly the notes it is told to", async () => {
    await reset();
    const r1 = await apply(db, {
      expectedRevision: null,
      value: `${T1},${T2}`,
      noteUpserts: [
        { seat: seatOf(T1), note: "a" },
        { seat: seatOf(T2), note: "b" },
      ],
    });
    await apply(db, { expectedRevision: r1, value: T1, noteDeletes: [seatOf(T2)] });
    expect(await notes()).toEqual({ [seatOf(T1)]: "a" });
  });

  it("a writer holding the lock makes a concurrent writer with the same revision fail stale", async () => {
    await reset();
    const r1 = await apply(db, { expectedRevision: null, value: T1 });
    const a = await connect();
    const b = await connect();
    await a.query("begin");
    await apply(a, { expectedRevision: r1, value: `${T1},${T2}` });
    const bWrite = apply(b, { expectedRevision: r1, value: `${T1},${T3}` }).then(
      () => "ok",
      (e: Error) => e.message,
    );
    await new Promise((r) => setTimeout(r, 200));
    await a.query("commit");
    expect(await bWrite).toBe("stale_revision");
    expect((await snapshot())?.value).toBe(`${T1},${T2}`);
  });

  it("is service-role only", async () => {
    await reset();
    const priv = (await db.query(
      `select has_function_privilege('anon', 'public.apply_secret_list_edit(text,text,text,text,jsonb,text[],text)', 'execute') a,
              has_function_privilege('authenticated', 'public.apply_secret_list_edit(text,text,text,text,jsonb,text[],text)', 'execute') u,
              has_function_privilege('service_role', 'public.apply_secret_list_edit(text,text,text,text,jsonb,text[],text)', 'execute') s,
              has_table_privilege('anon', 'public.agent_auth_seat_note', 'select') ta,
              has_table_privilege('authenticated', 'public.agent_auth_seat_note', 'select') tu,
              (select relrowsecurity from pg_class where oid = 'public.agent_auth_seat_note'::regclass) rls`,
    )).rows[0];
    expect(priv).toEqual({ a: false, u: false, s: true, ta: false, tu: false, rls: true });
  });

  it("editSecretList end to end: overlapping appends both survive, notes follow replace and remove", async () => {
    await reset();
    const a = await connect();
    const b = await connect();
    await editSecretList(KEY, { op: "append", tokens: T1, note: "Ravi's Max" }, "staff@test", pgDeps(a));
    await Promise.all([
      editSecretList(KEY, { op: "append", tokens: T2 }, "staff@test", pgDeps(a)),
      editSecretList(KEY, { op: "append", tokens: T3, note: "Tarun's seat" }, "staff@test", pgDeps(b)),
    ]);
    expect(new Set(parseSecretList((await snapshot())?.value))).toEqual(new Set([T1, T2, T3]));
    expect(await notes()).toEqual({ [seatOf(T1)]: "Ravi's Max", [seatOf(T3)]: "Tarun's seat" });

    const fresh = "sk-ant-oat01-dddddddddddddddd4444";
    const rev = (await snapshot())!.updated_at;
    await editSecretList(KEY, { op: "replace", target: seatOf(T1), token: fresh, expectedRevision: rev }, "staff@test", pgDeps(a));
    expect(parseSecretList((await snapshot())?.value)[0]).toBe(fresh);
    expect((await notes())[seatOf(fresh)]).toBe("Ravi's Max");

    await editSecretList(KEY, { op: "remove", target: seatOf(T3) }, "staff@test", pgDeps(a));
    expect(await notes()).toEqual({ [seatOf(fresh)]: "Ravi's Max" });
    await expect(
      editSecretList(KEY, { op: "note", target: seatOf(fresh), note: "late", expectedRevision: rev }, "staff@test", pgDeps(b)),
    ).rejects.toMatchObject({ status: 409 });
  });
});
