import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const MIGRATIONS = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20261120110000_paced_signup_cards.sql";
const modules = process.env.SITES_SQL_TEST_MODULES;
const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const UNTIL = "2099-01-01T00:00:00Z";

type Db = {
  exec: (q: string) => Promise<unknown>;
  query: <R = Record<string, unknown>>(q: string, p?: unknown[]) => Promise<{ rows: R[] }>;
  close: () => Promise<void>;
};
let db: Db;
let seq = 0;

async function card(tenant: string, channel: string, over: Record<string, unknown> = {}): Promise<string> {
  seq += 1;
  const id = `cccccccc-0000-4000-8000-${String(seq).padStart(12, "0")}`;
  const cols = { id, tenant_id: tenant, channel_slug: channel, ...over };
  const keys = Object.keys(cols);
  await db.query(`insert into channel_actions (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")})`, Object.values(cols));
  return id;
}
const get = async (id: string) =>
  (await db.query<{ status: string; snoozed_until: string | null; held_reason: string | null }>("select status, snoozed_until, held_reason from channel_actions where id = $1", [id])).rows[0];
const hold = async (tenant: string, ids: string[], until = UNTIL) =>
  (await db.query<{ n: number }>("select hold_paced_channel_actions($1, $2::uuid[], $3::timestamptz) as n", [tenant, ids, until])).rows[0].n;
const release = async (tenant: string, channels: string[] | null, ids: string[] | null) =>
  (await db.query<{ n: number }>("select release_paced_channel_actions($1, $2::text[], $3::uuid[]) as n", [tenant, channels, ids])).rows[0].n;

describe.skipIf(!modules)(`${FILE} executed in Postgres (pglite)`, () => {
  beforeAll(async () => {
    const { PGlite } = createRequire(resolve(modules!, "../package.json"))("@electric-sql/pglite");
    db = new PGlite();
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create table channel_actions (
        id uuid primary key, tenant_id uuid not null, channel_slug text not null,
        status text not null default 'pending', snoozed_until timestamptz,
        exec_status text, approved_by uuid, founder_touched_at timestamptz
      );
      create table channel_action_events (
        id bigint generated always as identity primary key, tenant_id uuid not null,
        action_id uuid not null, event text not null, actor_kind text not null
      );
    `);
    const sql = readFileSync(join(MIGRATIONS, FILE), "utf-8");
    await db.exec(sql);
    await db.exec(sql);
  }, 60_000);
  beforeEach(async () => {
    await db.exec("delete from channel_action_events; delete from channel_actions;");
  });
  afterAll(async () => {
    await db?.close();
  });

  it("holds only this tenant's pending, untouched, never-paced cards", async () => {
    const ok = await card(T1, "seo");
    const other = await card(T2, "seo");
    const touched = await card(T1, "seo", { founder_touched_at: "2026-10-30T00:00:00Z" });
    const approved = await card(T1, "seo", { approved_by: T1 });
    const released = await card(T1, "seo", { held_reason: "released" });
    expect(await hold(T1, [ok, other, touched, approved, released])).toBe(1);
    expect(await get(ok)).toMatchObject({ status: "snoozed", held_reason: "pacing" });
    expect((await get(other)).status).toBe("pending");
    expect((await get(touched)).held_reason).toBeNull();
    expect((await get(released)).held_reason).toBe("released");
  });

  it("holds nothing once the founder answered any card of the workspace, and never with a past date", async () => {
    const a = await card(T1, "seo");
    expect(await hold(T1, [a], "2020-01-01T00:00:00Z")).toBe(0);
    const b = await card(T1, "geo");
    await db.query("insert into channel_action_events (tenant_id, action_id, event, actor_kind) values ($1, $2, 'acted', 'founder')", [T1, b]);
    expect(await hold(T1, [a])).toBe(0);
    expect((await get(a)).status).toBe("pending");
  });

  it("releases held cards on a channel for this tenant only, never a founder's own snooze", async () => {
    const mine = await card(T1, "reddit_organic", { status: "snoozed", snoozed_until: UNTIL, held_reason: "pacing" });
    const elsewhere = await card(T1, "seo", { status: "snoozed", snoozed_until: UNTIL, held_reason: "pacing" });
    const theirs = await card(T2, "reddit_organic", { status: "snoozed", snoozed_until: UNTIL, held_reason: "pacing" });
    const founderSnoozed = await card(T1, "reddit_organic", { status: "snoozed", snoozed_until: UNTIL, held_reason: "pacing" });
    await db.query("insert into channel_action_events (tenant_id, action_id, event, actor_kind) values ($1, $2, 'snoozed', 'founder')", [T1, founderSnoozed]);
    expect(await release(T1, ["reddit_organic"], null)).toBe(1);
    expect(await get(mine)).toMatchObject({ status: "pending", snoozed_until: null, held_reason: "released" });
    expect((await get(elsewhere)).status).toBe("snoozed");
    expect((await get(theirs)).status).toBe("snoozed");
    expect((await get(founderSnoozed)).status).toBe("snoozed");
  });
});
