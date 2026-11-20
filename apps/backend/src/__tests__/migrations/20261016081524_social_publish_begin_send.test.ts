import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20261016081524_social_publish_begin_send.sql"),
  "utf8",
);
const POST = "aaaaaaaa-0000-4000-8000-000000000001";

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role;
    create table public.social_publish_attempts (
      id uuid primary key,
      post_id uuid not null,
      idempotency_key text not null unique,
      status text not null check (status in ('claimed', 'succeeded', 'failed', 'unknown'))
    );
  `);
  await db.exec(sql);
});

afterAll(async () => db.close());

beforeEach(async () => {
  await db.exec("delete from public.social_publish_attempts");
  await db.query(
    "insert into public.social_publish_attempts (id, post_id, idempotency_key, status) values ($1, $2, 'publish-1', 'claimed')",
    ["bbbbbbbb-0000-4000-8000-000000000001", POST],
  );
});

describe("social publish begin-send replay barrier", () => {
  it("lets one caller start sending and refuses every replay", async () => {
    const first = await db.query<{ won: boolean }>("select public.social_publish_begin_send($1, 'publish-1') as won", [POST]);
    const replay = await db.query<{ won: boolean }>("select public.social_publish_begin_send($1, 'publish-1') as won", [POST]);
    const status = await db.query<{ status: string }>("select status from public.social_publish_attempts where post_id = $1", [POST]);

    expect(first.rows[0].won).toBe(true);
    expect(replay.rows[0].won).toBe(false);
    expect(status.rows[0].status).toBe("sending");
  });

  it("is executable only by the service role", async () => {
    const grants = await db.query<{ rolname: string }>(`
      select rolname
        from pg_roles
       where rolname in ('anon', 'authenticated', 'service_role')
         and has_function_privilege(rolname, 'public.social_publish_begin_send(uuid,text)', 'execute')
       order by rolname
    `);
    expect(grants.rows.map((row) => row.rolname)).toEqual(["service_role"]);
  });
});
