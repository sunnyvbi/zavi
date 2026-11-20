import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

const sql = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20261124100000_shopify_app_user_links.sql"),
  "utf8",
);

let db: PGlite;
const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWNER_A = "11111111-1111-4111-8111-111111111111";
const MEMBER_A = "22222222-2222-4222-8222-222222222222";
const OWNER_B = "33333333-3333-4333-8333-333333333333";

beforeEach(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role;
    create schema auth;
    create table auth.users (id uuid primary key);
    create table public.tenants (id uuid primary key);
    create table public.tenant_users (tenant_id uuid not null, user_id uuid not null, role text not null);
    create table public.connector_metadata (tenant_id uuid not null, slug text not null, team_name text);
    create table public.shopify_pending_installations (shop text not null, claimed_tenant_id uuid, claimed_at timestamptz, access_token_key text);
    insert into auth.users values ('${OWNER_A}'), ('${MEMBER_A}'), ('${OWNER_B}');
    insert into tenants values ('${TENANT_A}'), ('${TENANT_B}');
    insert into tenant_users values
      ('${TENANT_A}', '${OWNER_A}', 'owner'),
      ('${TENANT_A}', '${MEMBER_A}', 'member'),
      ('${TENANT_B}', '${OWNER_B}', 'owner');
    insert into connector_metadata values
      ('${TENANT_A}', 'composio.shopify', 'acme.myshopify.com'),
      ('${TENANT_B}', 'composio.shopify', 'acme.myshopify.com');
  `);
  await db.exec(sql);
});

afterEach(async () => db.close());

async function link(tenant: string, user: string) {
  return db.query<{ link_shopify_app_member: string | null }>(
    "select public.link_shopify_app_member($1::uuid, $2, $3, $4::uuid)",
    [tenant, "acme.myshopify.com", "42", user],
  );
}

describe("Shopify App Home user links", () => {
  it("links only a tenant owner/admin and resolves the live role", async () => {
    expect((await link(TENANT_A, OWNER_A)).rows[0]?.link_shopify_app_member).toBe(OWNER_A);
    const resolved = await db.query<{ user_id: string; role: string }>(
      "select * from public.resolve_shopify_app_member_link($1::uuid, $2, $3)",
      [TENANT_A, "acme.myshopify.com", "42"],
    );
    expect(resolved.rows).toEqual([{ user_id: OWNER_A, role: "owner" }]);
    expect((await link(TENANT_A, MEMBER_A)).rows[0]?.link_shopify_app_member).toBeNull();
  });

  it("can bind the confirmed staff identity before the connector row is saved", async () => {
    await db.query("delete from connector_metadata where tenant_id = $1::uuid", [TENANT_A]);
    await db.query(
      "insert into shopify_pending_installations (shop, claimed_tenant_id, claimed_at, access_token_key) values ($1, $2::uuid, now(), 'vault-key')",
      ["acme.myshopify.com", TENANT_A],
    );
    expect((await link(TENANT_A, OWNER_A)).rows[0]?.link_shopify_app_member).toBe(OWNER_A);
  });

  it("does not move one Shopify staff identity across tenants", async () => {
    expect((await link(TENANT_A, OWNER_A)).rows[0]?.link_shopify_app_member).toBe(OWNER_A);
    const unavailable = await db.query<{ shopify_app_member_link_available: boolean }>(
      "select public.shopify_app_member_link_available($1::uuid, $2, $3)",
      [TENANT_B, "acme.myshopify.com", "42"],
    );
    expect(unavailable.rows[0]?.shopify_app_member_link_available).toBe(false);
    expect((await link(TENANT_B, OWNER_B)).rows[0]?.link_shopify_app_member).toBeNull();
  });

  it("lets a stale identity link move after the old tenant no longer owns the shop", async () => {
    await link(TENANT_A, OWNER_A);
    await db.query("delete from connector_metadata where tenant_id = $1::uuid", [TENANT_A]);
    const available = await db.query<{ shopify_app_member_link_available: boolean }>(
      "select public.shopify_app_member_link_available($1::uuid, $2, $3)",
      [TENANT_B, "acme.myshopify.com", "42"],
    );
    expect(available.rows[0]?.shopify_app_member_link_available).toBe(true);
    expect((await link(TENANT_B, OWNER_B)).rows[0]?.link_shopify_app_member).toBe(OWNER_B);
  });

  it("deletes the identity link when the tenant disconnects the shop", async () => {
    await link(TENANT_A, OWNER_A);
    const deleted = await db.query<{ delete_shopify_app_member_links: number }>(
      "select public.delete_shopify_app_member_links($1::uuid, $2)",
      [TENANT_A, "acme.myshopify.com"],
    );
    expect(Number(deleted.rows[0]?.delete_shopify_app_member_links)).toBe(1);
    const resolved = await db.query(
      "select * from public.resolve_shopify_app_member_link($1::uuid, $2, $3)",
      [TENANT_A, "acme.myshopify.com", "42"],
    );
    expect(resolved.rows).toEqual([]);
  });
});
