import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

const sql = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20261121110000_shopify_app_member_identity.sql"),
  "utf8",
);

let db: PGlite;

beforeEach(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role;
    create schema auth;
    create table auth.users (id uuid primary key, email text);
    create table public.tenant_users (user_id uuid not null, tenant_id uuid not null, role text not null);
  `);
  await db.exec(sql);
});

afterEach(async () => {
  await db.close();
});

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";

async function resolve(tenant: string, email: string) {
  return db.query<{ user_id: string; role: string }>(
    "select * from public.resolve_shopify_app_member($1::uuid, $2::text)",
    [tenant, email],
  );
}

describe("resolve_shopify_app_member", () => {
  it("matches one verified email case-insensitively inside the resolved tenant", async () => {
    await db.exec(`
      insert into auth.users values ('${USER_A}', 'Owner@Example.com');
      insert into public.tenant_users values ('${USER_A}', '${TENANT_A}', 'admin');
    `);
    const result = await resolve(TENANT_A, " owner@example.com ");
    expect(result.rows).toEqual([{ user_id: USER_A, role: "admin" }]);
    expect((await resolve(TENANT_B, "owner@example.com")).rows).toEqual([]);
  });

  it("refuses an ambiguous email instead of choosing a user", async () => {
    await db.exec(`
      insert into auth.users values
        ('${USER_A}', 'shared@example.com'),
        ('${USER_B}', 'SHARED@example.com');
      insert into public.tenant_users values
        ('${USER_A}', '${TENANT_A}', 'owner'),
        ('${USER_B}', '${TENANT_A}', 'member');
    `);
    expect((await resolve(TENANT_A, "shared@example.com")).rows).toEqual([]);
  });
});
