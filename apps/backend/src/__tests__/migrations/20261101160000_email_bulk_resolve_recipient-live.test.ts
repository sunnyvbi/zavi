import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dir = join(__dirname, "../../../../../supabase/migrations");
const SQL = readFileSync(join(dir, "20261101160000_email_bulk_resolve_recipient.sql"), "utf8").replace(/^(begin|commit);$/gm, "");

const BOOTSTRAP = `
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
  end $$;
  create table public.email_bulk_send_recipients (
    send_id uuid not null,
    tenant_id uuid not null,
    contact_id uuid not null,
    email_at_send text,
    status text not null default 'sent',
    primary key (send_id, contact_id)
  );
`;

const PG_URL = process.env.ZAVI_TEST_VANILLA_PG_URL;

describe.skipIf(!PG_URL)("20261101160000 email_bulk_resolve_recipient, live", () => {
  let db: Client;
  const resolve = async (send: string, email: string) =>
    (await db.query<{ t: string | null }>("select email_bulk_resolve_recipient($1, $2) t", [send, email])).rows[0].t;

  beforeAll(async () => {
    db = new Client({ connectionString: PG_URL });
    await db.connect();
    const exists = (await db.query<{ t: string | null }>("select to_regclass('public.email_bulk_send_recipients')::text t")).rows[0];
    if (exists.t) throw new Error("ZAVI_TEST_VANILLA_PG_URL must be a VANILLA throwaway database");
    await db.query("begin");
    await db.query(BOOTSTRAP);
    await db.query(SQL);
  });
  afterAll(async () => {
    if (!db) return;
    await db.query("rollback").catch(() => {});
    await db.end();
  });

  it("must catch: the owner of THIS send and THIS address, and nobody else", async () => {
    const a = randomUUID();
    const b = randomUUID();
    const sendA = randomUUID();
    const sendB = randomUUID();
    await db.query("insert into email_bulk_send_recipients values ($1, $2, $3, 'pat@example.test'), ($4, $5, $6, 'sam@example.test')", [
      sendA, a, randomUUID(), sendB, b, randomUUID(),
    ]);
    expect(await resolve(sendA, "  PAT@Example.test ")).toBe(a);
    expect(await resolve(sendB, "sam@example.test")).toBe(b);
    expect(await resolve(sendB, "pat@example.test")).toBeNull();
    expect(await resolve(sendA, "nobody@example.test")).toBeNull();
    expect(await resolve(randomUUID(), "pat@example.test")).toBeNull();
  });

  it("an erased address (nulled at erasure) resolves to no one", async () => {
    const send = randomUUID();
    await db.query("insert into email_bulk_send_recipients values ($1, $2, $3, null)", [send, randomUUID(), randomUUID()]);
    expect(await resolve(send, "")).toBeNull();
  });

  it("service role only, and the lookup uses the send + address index", async () => {
    const g = (
      await db.query<{ anon: boolean; auth: boolean; svc: boolean }>(
        "select has_function_privilege('anon', 'email_bulk_resolve_recipient(uuid,text)', 'execute') anon, has_function_privilege('authenticated', 'email_bulk_resolve_recipient(uuid,text)', 'execute') auth, has_function_privilege('service_role', 'email_bulk_resolve_recipient(uuid,text)', 'execute') svc",
      )
    ).rows[0];
    expect(g).toEqual({ anon: false, auth: false, svc: true });
    await db.query("set local enable_seqscan = off");
    const plan = (await db.query<{ "QUERY PLAN": string }>("explain select tenant_id from email_bulk_send_recipients where send_id = $1 and email_at_send = 'x'", [randomUUID()])).rows
      .map((r) => r["QUERY PLAN"])
      .join("\n");
    await db.query("set local enable_seqscan = on");
    expect(plan).toMatch(/email_bulk_send_recipients_send_email_idx/);
  });
});
