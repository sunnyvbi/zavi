import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

type Db = { exec: (q: string) => Promise<unknown>; query: (q: string, p?: unknown[]) => Promise<{ rows: any[] }>; close: () => Promise<void> };
let db: Db;

const FILE = "20261120120000_social_publish_finalize_never_unpublishes.sql";
const sql = readFileSync(join(__dirname, "../../../../../supabase/migrations", FILE), "utf-8");
const modules = process.env.SITES_SQL_TEST_MODULES;

const POST = "11111111-0000-4000-8000-000000000001";
const OTHER = "11111111-0000-4000-8000-000000000002";
const finalize = (id: string, ok: boolean) =>
  db.query("select social_publish_finalize($1, $2, $3, $4, $5, $6::jsonb)", [id, ok, ok ? "ext-1" : null, ok ? "https://x.example/1" : null, ok ? null : "transient_exhausted", "{}"]);
const post = async (id: string) => (await db.query("select status, external_url, last_error from social_posts where id = $1", [id])).rows[0];
const attempt = async (id: string) => (await db.query("select status from social_publish_attempts where post_id = $1", [id])).rows[0].status;

describe.skipIf(!modules)(`${FILE}: a published post stays published (pglite)`, () => {
  beforeAll(async () => {
    const { PGlite } = createRequire(resolve(modules!, "../package.json"))("@electric-sql/pglite");
    db = new PGlite();
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create table social_posts (id uuid primary key, status text not null, external_post_id text, external_url text, last_error text, updated_at timestamptz);
      create table social_publish_attempts (post_id uuid not null, status text not null, response jsonb, error text);
      insert into social_posts (id, status) values ('${POST}', 'publishing'), ('${OTHER}', 'publishing');
      insert into social_publish_attempts (post_id, status) values ('${POST}', 'claimed'), ('${OTHER}', 'claimed');
    `);
    await db.exec(sql);
  });
  afterAll(async () => {
    await db?.close();
  });

  it("a failed finalize after the success finalize leaves the post published", async () => {
    await finalize(POST, true);
    await finalize(POST, false);
    expect(await post(POST)).toEqual({ status: "published", external_url: "https://x.example/1", last_error: null });
    expect(await attempt(POST)).toBe("succeeded");
  });

  it("a failed finalize still lands on a post that never published", async () => {
    await finalize(OTHER, false);
    expect(await post(OTHER)).toMatchObject({ status: "failed", last_error: "transient_exhausted" });
    expect(await attempt(OTHER)).toBe("failed");
  });
});
