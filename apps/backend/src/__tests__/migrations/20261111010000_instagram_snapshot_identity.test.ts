import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const TENANT = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER = "bbbbbbbb-0000-4000-8000-000000000002";
let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create table connector_metadata (tenant_id uuid, slug text, team_id text, primary key (tenant_id, slug));
    create table social_account_snapshots (
      tenant_id uuid, channel text, captured_on date, username text, name text,
      profile_image_url text, followers_count int, post_count int,
      created_at timestamptz not null default now(), primary key (tenant_id, channel, captured_on)
    );
    create table social_post_metric_snapshots (
      tenant_id uuid, channel text, external_post_id text not null, captured_on date,
      posted_at timestamptz, text text, url text, format text, has_link boolean, metrics jsonb,
      primary key (tenant_id, channel, external_post_id, captured_on)
    );
  `);
  await db.exec(readFileSync(join(__dirname, "../../../../../supabase/migrations/20261111010000_instagram_snapshot_identity.sql"), "utf8"));
});
afterAll(async () => db.close());
beforeEach(async () => {
  await db.exec("truncate connector_metadata, social_account_snapshots, social_post_metric_snapshots");
  for (const tenant of [TENANT, OTHER]) {
    await db.query("insert into connector_metadata values ($1, 'composio.instagram', 'ca_new')", [tenant]);
  }
});
async function store({ tenant = TENANT, connection = "ca_new", id = "ig_new", username = "new_owner", at = "2026-10-19T12:00:00Z", posts = [{ external_post_id: "new_post", text: "new", metrics: { views: 2 }, has_link: false }] }: {
  tenant?: string; connection?: string; id?: string; username?: string; at?: string; posts?: Record<string, unknown>[];
} = {}) {
  const r = await db.query<{ stored: boolean }>("select store_instagram_snapshots($1,$2,$3,$4,$5,$6) as stored", [tenant, connection, id, at, JSON.stringify({ username, followers_count: 5, post_count: posts.length }), JSON.stringify(posts)]);
  return r.rows[0].stored;
}
async function seedLegacy(day: string, username: string | null, postId: string, tenant = TENANT) {
  await db.query("insert into social_account_snapshots (tenant_id, channel, captured_on, username, created_at) values ($1,'instagram',$2,$3,$2::date::timestamptz)", [tenant, day, username]);
  await db.query("insert into social_post_metric_snapshots (tenant_id, channel, captured_on, external_post_id) values ($1,'instagram',$2,$3)", [tenant, day, postId]);
}
async function posts(tenant = TENANT) {
  return (await db.query<{ external_post_id: string; account_id: string; captured_on: string }>("select external_post_id, account_id, captured_on::text from social_post_metric_snapshots where tenant_id=$1 and channel='instagram' order by captured_on, external_post_id", [tenant])).rows;
}

describe("atomic Instagram snapshot storage", () => {
  it("removes old account days and a same-day legacy mix, retaining this account's history", async () => {
    await seedLegacy("2026-10-01", "old_owner", "old_post");
    await seedLegacy("2026-10-09", "new_owner", "new_post");
    await db.query("insert into social_post_metric_snapshots (tenant_id,channel,captured_on,external_post_id) values ($1,'instagram','2026-10-09','mixed_before_this_fix')", [TENANT]);
    await seedLegacy("2026-10-19", "new_owner", "old_same_day_post");
    expect(await store()).toBe(true);
    expect(await posts()).toEqual([
      { external_post_id: "new_post", account_id: "ig_new", captured_on: "2026-10-09" },
      { external_post_id: "new_post", account_id: "ig_new", captured_on: "2026-10-19" },
    ]);
  });

  it("removes orphaned posts and unknown-account days", async () => {
    await seedLegacy("2026-10-02", null, "unknown");
    await db.query("insert into social_post_metric_snapshots (tenant_id, channel, captured_on, external_post_id) values ($1,'instagram','2026-10-03','orphan')", [TENANT]);
    await store();
    expect((await posts()).map((r) => r.external_post_id)).toEqual(["new_post"]);
  });

  it("preserves a stable account's history when its username changes", async () => {
    await store({ at: "2026-10-18T12:00:00Z", username: "old_name" });
    await store({ username: "renamed" });
    expect(await posts()).toHaveLength(2);
    const r = await db.query<{ username: string }>("select username from social_account_snapshots order by captured_on");
    expect(r.rows.map((r) => r.username)).toEqual(["old_name", "renamed"]);
  });

  it("refreshes the capture timestamp and connection when the same account reconnects on the same day", async () => {
    await store({ at: "2026-10-19T08:00:00Z" });
    await db.query("update connector_metadata set team_id='ca_reconnect' where tenant_id=$1", [TENANT]);
    await store({ connection: "ca_reconnect" });
    const r = await db.query<{ created_at: Date; connection_id: string }>("select created_at, connection_id from social_account_snapshots where tenant_id=$1", [TENANT]);
    expect(new Date(r.rows[0].created_at).toISOString()).toBe("2026-10-19T12:00:00.000Z");
    expect(r.rows[0].connection_id).toBe("ca_reconnect");
  });

  it("rejects an in-flight read from a disconnected login without deleting anything", async () => {
    await store();
    expect(await store({ connection: "ca_old", id: "ig_old", at: "2026-10-19T13:00:00Z" })).toBe(false);
    expect((await posts())[0].account_id).toBe("ig_new");
  });

  it("rejects an older read that finishes after a newer refresh", async () => {
    await store();
    expect(await store({ at: "2026-10-19T11:00:00Z", posts: [] })).toBe(false);
    expect(await posts()).toHaveLength(1);
  });

  it("rolls back deletions and the account write if any post cannot be stored", async () => {
    await seedLegacy("2026-10-01", "old_owner", "old_post");
    await expect(store({ posts: [{ text: "missing primary key" }] })).rejects.toThrow();
    expect((await posts()).map((r) => r.external_post_id)).toEqual(["old_post"]);
    const r = await db.query<{ username: string }>("select username from social_account_snapshots where tenant_id=$1", [TENANT]);
    expect(r.rows.map((r) => r.username)).toEqual(["old_owner"]);
  });

  it("clears today's stale posts even when the new account has no posts", async () => {
    await seedLegacy("2026-10-19", "old_owner", "old_post");
    await store({ posts: [] });
    expect(await posts()).toEqual([]);
  });

  it("never changes another tenant or another channel", async () => {
    await seedLegacy("2026-10-01", "old_owner", "other_tenant", OTHER);
    await db.query("insert into social_post_metric_snapshots (tenant_id,channel,captured_on,external_post_id) values ($1,'x','2026-10-01','x_post')", [TENANT]);
    await store();
    expect((await posts(OTHER)).map((r) => r.external_post_id)).toEqual(["other_tenant"]);
    expect((await db.query("select * from social_post_metric_snapshots where channel='x'")).rows).toHaveLength(1);
  });

  it("only allows the service role to execute the writer", async () => {
    const r = await db.query<{ rolname: string }>("select rolname from pg_roles where rolname in ('anon','authenticated','service_role') and has_function_privilege(rolname, 'public.store_instagram_snapshots(uuid,text,text,timestamptz,jsonb,jsonb)', 'execute')");
    expect(r.rows.map((r) => r.rolname)).toEqual(["service_role"]);
  });
});
