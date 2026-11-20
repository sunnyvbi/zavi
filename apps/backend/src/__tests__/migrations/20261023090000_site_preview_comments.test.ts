import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { MAX_COMMENT_BODY, MAX_MENTIONS, THREAD_STATUSES, cleanBody, checkMentions } from "@/services/sites/site-comments";

const MIGRATIONS = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20261023090000_site_preview_comments.sql";
const sql = readFileSync(join(MIGRATIONS, FILE), "utf-8");
const modules = process.env.SITES_SQL_TEST_MODULES;

const TA = "11111111-1111-4111-8111-111111111111";
const TB = "22222222-2222-4222-8222-222222222222";
const SA = "aaaaaaaa-0000-4000-8000-00000000000a";
const SB = "bbbbbbbb-0000-4000-8000-00000000000b";
const UA = "a1a1a1a1-0000-4000-8000-000000000001";
const UB = "b1b1b1b1-0000-4000-8000-000000000001";

describe(FILE, () => {
  it("sorts after every migration before it", () => {
    const all = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
    expect(all[all.length - 1] === FILE || all.indexOf(FILE) > all.indexOf("20261022120000_bulk_email_own_sender.sql")).toBe(true);
  });
});

type Db = { exec: (q: string) => Promise<unknown>; query: (q: string, p?: unknown[]) => Promise<{ rows: any[] }>; close: () => Promise<void> };
let db: Db;

async function thread(tenant: string, site: string, extra: Record<string, unknown> = {}): Promise<string> {
  const row = { page_path: "/", selector: "main > h1", created_by: UA, ...extra };
  const keys = Object.keys(row);
  const { rows } = await db.query(
    `insert into public.site_comment_threads (tenant_id, site_id, ${keys.join(", ")}) values ($1, $2, ${keys.map((_, i) => `$${i + 3}`).join(", ")}) returning id`,
    [tenant, site, ...keys.map((k) => (row as Record<string, unknown>)[k])],
  );
  return rows[0].id;
}

async function comment(tenant: string, threadId: string, body: string, mentions: string[] = []): Promise<string> {
  const { rows } = await db.query(
    "insert into public.site_comments (tenant_id, thread_id, author_id, body, mentions) values ($1, $2, $3, $4, $5::uuid[]) returning id",
    [tenant, threadId, UA, body, `{${mentions.join(",")}}`],
  );
  return rows[0].id;
}

async function asUser<T>(uid: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`set test.uid = '${uid}'; set role authenticated;`);
  try {
    return await fn();
  } finally {
    await db.exec("reset role; reset test.uid;");
  }
}

describe.skipIf(!modules)(`${FILE} executed in Postgres (pglite)`, () => {
  let threadA: string;

  beforeAll(async () => {
    const { PGlite } = createRequire(resolve(modules!, "../package.json"))("@electric-sql/pglite");
    db = new PGlite();
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
      grant usage on schema auth to authenticated, anon;
      grant execute on function auth.uid() to authenticated, anon;
      grant usage on schema public to authenticated, anon;
      create table public.tenants (id uuid primary key);
      create table public.tenant_users (user_id uuid, tenant_id uuid);
      grant select on public.tenant_users to authenticated;
      create table public.sites (id uuid primary key, tenant_id uuid not null references public.tenants(id) on delete cascade);
      insert into public.tenants values ('${TA}'), ('${TB}');
      insert into public.tenant_users values ('${UA}', '${TA}'), ('${UB}', '${TB}');
      insert into public.sites values ('${SA}', '${TA}'), ('${SB}', '${TB}');
      grant all on all tables in schema public to anon, authenticated;
      alter default privileges in schema public grant all on tables to anon, authenticated;
    `);
    await db.exec(sql);
    await db.exec(sql);
    threadA = await thread(TA, SA, { anchor_text: "Hero title", section: "hero", rel_x: 0.25, rel_y: 0.75 });
    await comment(TA, threadA, "make it bigger", [UA]);
  });
  afterAll(async () => db?.close());

  it("refuses a thread whose tenant is not the site's tenant", async () => {
    await expect(thread(TB, SA)).rejects.toThrow(/site_comment_threads_site_tenant_fk/);
  });

  it("refuses a comment whose tenant is not the thread's tenant", async () => {
    await expect(comment(TB, threadA, "cross")).rejects.toThrow(/site_comments_thread_tenant_fk/);
  });

  it("caps the body at the route's limit and refuses a blank one", async () => {
    const max = "x".repeat(MAX_COMMENT_BODY);
    expect(cleanBody(max)).toBe(max);
    await expect(comment(TA, threadA, max)).resolves.toBeTruthy();
    expect(cleanBody(`${max}x`)).toBeNull();
    await expect(comment(TA, threadA, `${max}x`)).rejects.toThrow(/check/);
    await expect(comment(TA, threadA, "   ")).rejects.toThrow(/check/);
  });

  it("caps mentions at the route's limit", async () => {
    const ids = Array.from({ length: MAX_MENTIONS + 1 }, (_, i) => `cccccccc-0000-4000-8000-${String(i).padStart(12, "0")}`);
    expect(checkMentions(ids, ids)).toEqual({ ok: false, code: "bad_mentions" });
    await expect(comment(TA, threadA, "many", ids.slice(0, MAX_MENTIONS))).resolves.toBeTruthy();
    await expect(comment(TA, threadA, "too many", ids)).rejects.toThrow(/check/);
  });

  it("accepts exactly the statuses the route allows", async () => {
    for (const status of THREAD_STATUSES) {
      await expect(db.query("update public.site_comment_threads set status = $1 where id = $2", [status, threadA])).resolves.toBeTruthy();
    }
    await expect(db.query("update public.site_comment_threads set status = 'deleted' where id = $1", [threadA])).rejects.toThrow(/check/);
    await db.query("update public.site_comment_threads set status = 'open' where id = $1", [threadA]);
  });

  it("refuses a pin outside the element and a path that is not a site path", async () => {
    await expect(thread(TA, SA, { rel_x: 1.5 })).rejects.toThrow(/check/);
    await expect(thread(TA, SA, { page_path: "https://evil.example" })).rejects.toThrow(/check/);
    await expect(thread(TA, SA, { section: "Hero<x>" })).rejects.toThrow(/check/);
  });

  it("lets a member read only their own tenant's threads and comments", async () => {
    const mine = await asUser(UA, () => db.query("select id from public.site_comment_threads"));
    expect(mine.rows.map((r) => r.id)).toContain(threadA);
    const theirs = await asUser(UB, async () => ({
      threads: (await db.query("select id from public.site_comment_threads")).rows,
      comments: (await db.query("select id from public.site_comments")).rows,
    }));
    expect(theirs).toEqual({ threads: [], comments: [] });
    const stranger = await asUser("dddddddd-0000-4000-8000-000000000001", () => db.query("select id from public.site_comments"));
    expect(stranger.rows).toEqual([]);
  });

  it("gives a signed-in client no way to write", async () => {
    await expect(
      asUser(UA, () => db.query("insert into public.site_comments (tenant_id, thread_id, author_id, body) values ($1, $2, $3, 'x')", [TA, threadA, UA])),
    ).rejects.toThrow(/permission denied/);
    await expect(asUser(UA, () => db.query("update public.site_comment_threads set status = 'resolved'"))).rejects.toThrow(/permission denied/);
    await expect(asUser(UA, () => db.query("delete from public.site_comments"))).rejects.toThrow(/permission denied/);
  });

  it("goes away with its site", async () => {
    const t = await thread(TB, SB);
    await comment(TB, t, "bye");
    await db.query("delete from public.sites where id = $1", [SB]);
    const left = await db.query("select count(*)::int as n from public.site_comments where tenant_id = $1", [TB]);
    expect(left.rows[0].n).toBe(0);
  });
});
