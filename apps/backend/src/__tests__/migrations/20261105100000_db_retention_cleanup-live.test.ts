import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSdkSessionStore, shouldUseDurableResume, type SessionStoreDb } from "@/services/agents/sdk-session-store";

const PG_URL = process.env.ZAVI_TEST_PG_URL ?? process.env.ZAVI_TEST_VANILLA_PG_URL;
const host = (() => {
  try {
    return PG_URL ? new URL(PG_URL).hostname : null;
  } catch {
    return null;
  }
})();
const SHOULD_RUN = !!PG_URL && (host === "127.0.0.1" || host === "localhost" || host === "::1");
if (process.env.REQUIRE_RLS_MATRIX === "1" && !SHOULD_RUN) {
  throw new Error(`[db-retention-cleanup-live] REQUIRE_RLS_MATRIX=1 but the suite would skip (url=${!!PG_URL}).`);
}
const MIGRATIONS = join(__dirname, "../../../../../supabase/migrations");
const MIGRATION_FILES = readdirSync(MIGRATIONS)
  .filter((f) => /^20261105(0901|0902|0903|0904|0905|0906|0907|0908|0909)00_idx_.*\.sql$/.test(f) || f === "20261105100000_db_retention_cleanup.sql")
  .sort();

const BOOTSTRAP = `
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
  end $$;
  create table agent_run_stream_drafts (run_id uuid primary key, tenant_id uuid not null, thread_id uuid, agent_slug text not null default 'a',
    seq bigint not null default 0, text text not null default '', status text not null default 'streaming', updated_at timestamptz not null default now());
  create table memory_search_trace (id uuid primary key default gen_random_uuid(), tenant_id uuid not null, run_id uuid, created_at timestamptz not null default now());
  create table eval_candidates (id bigserial primary key, tenant_id uuid not null, created_at timestamptz not null default now());
  create table praxis_logs (id uuid primary key default gen_random_uuid(), created_at timestamptz not null default now(), level text not null default 'info');
  create type agent_run_event_stage as enum ('claimed', 'tool_use_started', 'tool_use_completed', 'completed');
  create table agent_run_events (id bigserial primary key, agent_run_id uuid, tenant_id uuid, stage agent_run_event_stage not null, meta jsonb, created_at timestamptz default now());
  create table thread_event (id bigserial primary key, tenant_id uuid not null, agent_run_id uuid, agent_slug text, kind text not null, body jsonb,
    created_at timestamptz not null default now(), thread_id uuid);
  create table code_index_state (tenant_id uuid not null, repo_full_name text not null, current_build_id uuid, indexed_at timestamptz default now(),
    primary key (tenant_id, repo_full_name));
  create table code_symbols (id uuid primary key default gen_random_uuid(), tenant_id uuid not null, repo_full_name text not null,
    symbol_name text, build_id uuid, indexed_at timestamptz default now());
  create table code_symbol_refs (id uuid primary key default gen_random_uuid(), tenant_id uuid not null, repo_full_name text not null,
    symbol_name text, build_id uuid, indexed_at timestamptz default now());
  create index code_symbols_build_idx on code_symbols (tenant_id, repo_full_name, build_id);
  create index code_symbol_refs_build_idx on code_symbol_refs (tenant_id, repo_full_name, build_id);
  create table agent_threads (id uuid primary key, tenant_id uuid not null, sdk_session_id text);
  create table sdk_session_entries (id bigint generated always as identity primary key, tenant_id uuid not null,
    thread_id uuid not null references agent_threads(id) on delete cascade, project_key text not null default 'p', session_key text not null,
    position bigint not null, entry_uuid text, entry jsonb not null default '{}', created_at timestamptz not null default now());
  create index sdk_session_entries_load_idx on sdk_session_entries (tenant_id, thread_id, session_key, position);
  create unique index sdk_session_entries_uuid_uq on sdk_session_entries (tenant_id, thread_id, session_key, entry_uuid) where entry_uuid is not null;
  create table decisions (id uuid primary key default gen_random_uuid(), tenant_id uuid not null, decision_class text not null,
    status text not null, body jsonb not null default '{}', emitted_at timestamptz default now());
`;

const days = (n: number) => `now() - interval '${n} days'`;

describe.skipIf(!SHOULD_RUN)("20261105100000 data retention cleanup, live", () => {
  let admin: Client;
  let db: Client;
  let dbUrl = "";
  let dbName = "";
  const T = randomUUID();
  const q = async <R = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as R[];
  const one = async <R = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await q<R>(sql, params))[0];
  const count = async (sql: string, params: unknown[] = []) => Number((await one<{ n: string }>(`select count(*) n from ${sql}`, params)).n);

  beforeAll(async () => {
    admin = new Client({ connectionString: PG_URL });
    await admin.connect();
    dbName = `zavi_retention_${randomBytes(6).toString("hex")}`;
    await admin.query(`create database ${dbName}`);
    const u = new URL(PG_URL!);
    u.pathname = `/${dbName}`;
    dbUrl = u.toString();
    db = new Client({ connectionString: dbUrl });
    await db.connect();
    await db.query(BOOTSTRAP);
    expect(MIGRATION_FILES).toHaveLength(10);
    for (let i = 0; i < 2; i++) for (const f of MIGRATION_FILES) await db.query(readFileSync(join(MIGRATIONS, f), "utf8"));
  });
  afterAll(async () => {
    await db?.end().catch(() => {});
    if (admin) {
      if (dbName) await admin.query(`drop database if exists ${dbName} with (force)`).catch(() => {});
      await admin.end();
    }
  });

  it("stream drafts: only rows not updated for a day go, in batches", async () => {
    for (let i = 0; i < 3; i++) await db.query(`insert into agent_run_stream_drafts (run_id, tenant_id, updated_at) values ($1, $2, ${days(2)})`, [randomUUID(), T]);
    const live = randomUUID();
    await db.query("insert into agent_run_stream_drafts (run_id, tenant_id, updated_at) values ($1, $2, now() - interval '2 hours')", [live, T]);
    expect((await one<{ n: number }>("select purge_stream_drafts(2) n")).n).toBe(2);
    expect((await one<{ n: number }>("select purge_stream_drafts(2) n")).n).toBe(1);
    expect((await one<{ n: number }>("select purge_stream_drafts(2) n")).n).toBe(0);
    expect(await q("select run_id from agent_run_stream_drafts")).toEqual([{ run_id: live }]);
  });

  it("memory traces 30 days, eval candidates 90 days, logs 90 days", async () => {
    await db.query(`insert into memory_search_trace (tenant_id, created_at) values ($1, ${days(31)}), ($1, ${days(29)})`, [T]);
    await db.query(`insert into eval_candidates (tenant_id, created_at) values ($1, ${days(91)}), ($1, ${days(60)})`, [T]);
    await db.query(`insert into praxis_logs (created_at) values (${days(91)}), (${days(89)})`);
    expect((await one<{ n: number }>("select purge_memory_search_traces(100) n")).n).toBe(1);
    expect((await one<{ n: number }>("select purge_eval_candidates(100) n")).n).toBe(1);
    expect((await one<{ n: number }>("select purge_praxis_logs(100) n")).n).toBe(1);
    expect(await count("memory_search_trace")).toBe(1);
    expect(await count("eval_candidates")).toBe(1);
    expect(await count("praxis_logs")).toBe(1);
  });

  it("run events: old rows go except tool_use_completed, which the public counter keeps counting", async () => {
    const run = randomUUID();
    for (const stage of ["claimed", "tool_use_started", "tool_use_completed", "completed"]) {
      await db.query(`insert into agent_run_events (agent_run_id, tenant_id, stage, created_at) values ($1, $2, $3, ${days(40)})`, [run, T, stage]);
    }
    await db.query(`insert into agent_run_events (agent_run_id, tenant_id, stage, created_at) values ($1, $2, 'claimed', ${days(5)})`, [run, T]);
    expect((await one<{ n: number }>("select purge_run_events(100) n")).n).toBe(3);
    const left = await q<{ stage: string; old: boolean }>(`select stage::text, created_at < ${days(30)} as old from agent_run_events order by stage`);
    expect(left).toEqual([
      { stage: "claimed", old: false },
      { stage: "tool_use_completed", old: true },
    ]);
  });

  it("thread events: only old tool_call and reasoning go; chat answers, run markers and plans stay", async () => {
    for (const kind of ["tool_call", "reasoning", "chat_assistant", "run_start", "run_end", "plan", "plan_critic_verdict"]) {
      await db.query(`insert into thread_event (tenant_id, kind, created_at) values ($1, $2, ${days(100)})`, [T, kind]);
    }
    await db.query(`insert into thread_event (tenant_id, kind, created_at) values ($1, 'tool_call', ${days(10)})`, [T]);
    expect((await one<{ n: number }>("select purge_thread_event_steps(100) n")).n).toBe(2);
    const kinds = (await q<{ kind: string }>("select kind from thread_event order by kind")).map((r) => r.kind);
    expect(kinds).toEqual(["chat_assistant", "plan", "plan_critic_verdict", "run_end", "run_start", "tool_call"]);
  });

  it("code index: a 60-day-old index is dropped, orphans of failed builds go, the committed and in-flight generations stay", async () => {
    const stale = { repo: "acme/stale", build: randomUUID() };
    const fresh = { repo: "acme/fresh", build: randomUUID(), orphan: randomUUID(), inflight: randomUUID() };
    await db.query(`insert into code_index_state values ($1, $2, $3, ${days(70)}), ($1, $4, $5, ${days(3)})`, [T, stale.repo, stale.build, fresh.repo, fresh.build]);
    const rows = async (table: string, repo: string, build: string | null, n: number, at: string) => {
      for (let i = 0; i < n; i++) await db.query(`insert into ${table} (tenant_id, repo_full_name, build_id, indexed_at) values ($1, $2, $3, ${at})`, [T, repo, build]);
    };
    await rows("code_symbols", stale.repo, stale.build, 3, days(70));
    await rows("code_symbol_refs", stale.repo, stale.build, 4, days(70));
    await rows("code_symbols", fresh.repo, fresh.build, 2, days(3));
    await rows("code_symbol_refs", fresh.repo, fresh.build, 2, days(3));
    await rows("code_symbol_refs", fresh.repo, fresh.orphan, 3, days(2));
    await rows("code_symbol_refs", fresh.repo, null, 1, days(200));
    await rows("code_symbol_refs", fresh.repo, fresh.inflight, 2, "now() - interval '5 minutes'");

    expect((await one<{ n: number }>("select expire_stale_code_indexes() n")).n).toBe(1);
    expect((await one<{ n: number }>("select expire_stale_code_indexes() n")).n).toBe(0);
    expect(await q("select repo_full_name, current_build_id from code_index_state order by 1")).toEqual([
      { repo_full_name: fresh.repo, current_build_id: fresh.build },
      { repo_full_name: stale.repo, current_build_id: null },
    ]);

    let deleted = 0;
    for (let i = 0; i < 20; i++) {
      const r = (await one<{ r: { deleted: number; more: boolean } }>("select purge_code_index_orphans(3) r")).r;
      expect(r.deleted).toBeLessThanOrEqual(3);
      deleted += r.deleted;
      if (!r.more) break;
    }
    expect(deleted).toBe(3 + 4 + 3 + 1);
    expect(await count("code_symbols where repo_full_name = $1", [stale.repo])).toBe(0);
    expect(await count("code_symbol_refs where repo_full_name = $1", [stale.repo])).toBe(0);
    expect(await count("code_symbols where build_id = $1", [fresh.build])).toBe(2);
    expect(await count("code_symbol_refs where build_id = $1", [fresh.build])).toBe(2);
    expect(await count("code_symbol_refs where build_id = $1", [fresh.inflight])).toBe(2);
    expect((await one<{ r: { deleted: number } }>("select purge_code_index_orphans(3) r")).r.deleted).toBe(0);
  });

  it("sdk sessions: a session goes WHOLE only when its newest entry is 30 days old, and the thread forgets it", async () => {
    const oldThread = randomUUID();
    const liveThread = randomUUID();
    await db.query("insert into agent_threads values ($1, $2, 'sess-old'), ($3, $2, 'sess-live')", [oldThread, T, liveThread]);
    for (let i = 1; i <= 4; i++) {
      await db.query(`insert into sdk_session_entries (tenant_id, thread_id, session_key, position, created_at) values ($1, $2, 'sess-old', $3, ${days(45 - i)})`, [T, oldThread, i]);
    }
    await db.query(`insert into sdk_session_entries (tenant_id, thread_id, session_key, position, created_at) values ($1, $2, 'sess-old::sub', 1, ${days(40)})`, [T, oldThread]);
    await db.query(`insert into sdk_session_entries (tenant_id, thread_id, session_key, position, created_at) values ($1, $2, 'sess-live', 1, ${days(50)}), ($1, $2, 'sess-live', 2, ${days(1)})`, [T, liveThread]);
    await db.query(`insert into sdk_session_entries (tenant_id, thread_id, session_key, position, created_at) values ($1, $2, 'sess-ancient', 1, ${days(90)})`, [T, oldThread]);

    let deleted = 0;
    for (let i = 0; i < 10; i++) {
      const r = (await one<{ r: { deleted: number; more: boolean } }>("select purge_sdk_sessions(10) r")).r;
      deleted += r.deleted;
      if (!r.more) break;
    }
    expect(deleted).toBe(4 + 1 + 1);
    expect(await q("select session_key, position::int from sdk_session_entries order by session_key, position")).toEqual([
      { session_key: "sess-live", position: 1 },
      { session_key: "sess-live", position: 2 },
    ]);
    expect(await q("select id, sdk_session_id from agent_threads order by sdk_session_id nulls first")).toEqual([
      { id: oldThread, sdk_session_id: null },
      { id: liveThread, sdk_session_id: "sess-live" },
    ]);
    expect(Number((await one<{ passes: number }>("select passes from retention_purge_cursor where purge = 'sdk_sessions'")).passes)).toBeGreaterThan(0);

    const thread = await one<{ sdk_session_id: string | null }>("select sdk_session_id from agent_threads where id = $1", [oldThread]);
    expect(shouldUseDurableResume({ isChatMode: true, durableEnabled: true, sdkSessionId: thread.sdk_session_id, mirrorDegradedAt: null })).toBe(false);
    const store = createSdkSessionStore({ runId: "r", tenantId: T, threadId: oldThread }, pgStoreDb(db));
    expect(await store.load({ projectKey: "p", sessionId: "sess-old" })).toBeNull();
    const liveStore = createSdkSessionStore({ runId: "r", tenantId: T, threadId: liveThread }, pgStoreDb(db));
    expect(await liveStore.load({ projectKey: "p", sessionId: "sess-live" })).toHaveLength(2);
  });

  it("ship-pr decisions: terminal and 30 days old keep each file's path, lose its content; open ones are untouched", async () => {
    const files = [
      { path: "src/a.ts", action: "modify", content: "secret code", diff: "+secret" },
      { path: "src/b.png", action: "create", content: "aGk=", encoding: "base64" },
    ];
    const ins = async (cls: string, status: string, age: number) =>
      (await one<{ id: string }>(`insert into decisions (tenant_id, decision_class, status, body, emitted_at) values ($1, $2, $3, $4, ${days(age)}) returning id`, [
        T, cls, status, JSON.stringify({ title: "t", files, repo: "acme/x" }),
      ])).id;
    const acted = await ins("engineer.ship-pr", "acted", 40);
    const failed = await ins("engineer.ship-pr", "dispatch_failed", 40);
    const proposed = await ins("engineer.ship-pr", "proposed", 40);
    const approved = await ins("engineer.ship-pr", "approved", 40);
    const recent = await ins("engineer.ship-pr", "acted", 10);
    const other = await ins("content-design.propose-change", "acted", 40);

    expect((await one<{ n: number }>("select purge_ship_pr_file_contents(1) n")).n).toBe(1);
    expect((await one<{ n: number }>("select purge_ship_pr_file_contents(10) n")).n).toBe(1);
    expect((await one<{ n: number }>("select purge_ship_pr_file_contents(10) n")).n).toBe(0);

    const body = async (id: string) => (await one<{ body: Record<string, unknown> }>("select body from decisions where id = $1", [id])).body;
    for (const id of [acted, failed]) {
      const b = await body(id);
      expect(b.files).toEqual([
        { path: "src/a.ts", action: "modify", content_purged: true },
        { path: "src/b.png", action: "create", content_purged: true },
      ]);
      expect(b.title).toBe("t");
      expect(b.repo).toBe("acme/x");
      expect(typeof b.files_content_purged_at).toBe("string");
    }
    for (const id of [proposed, approved, recent, other]) {
      expect((await body(id)).files).toEqual(files);
    }
  });

  it("only service_role may call the purges: not PUBLIC, anon or authenticated", async () => {
    const rows = await q<{ fn: string; pub: boolean; anon: boolean; auth: boolean; svc: boolean }>(`
      select p.proname fn,
             exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') pub,
             has_function_privilege('anon', p.oid, 'execute') anon,
             has_function_privilege('authenticated', p.oid, 'execute') auth,
             has_function_privilege('service_role', p.oid, 'execute') svc
        from pg_proc p where p.pronamespace = 'public'::regnamespace
         and (p.proname like 'purge\\_%' or p.proname in ('expire_stale_code_indexes', 'sdk_session_append'))`);
    expect(rows.length).toBe(11);
    for (const r of rows) expect(r).toMatchObject({ pub: false, anon: false, auth: false, svc: true });
    const helpers = await q<{ fn: string; pub: boolean; anon: boolean; auth: boolean }>(`
      select p.proname fn,
             exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') pub,
             has_function_privilege('anon', p.oid, 'execute') anon,
             has_function_privilege('authenticated', p.oid, 'execute') auth
        from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like '\\_%'`);
    expect(helpers.length).toBe(3);
    const tomb = await one<{ anon: boolean; auth: boolean }>(
      "select has_table_privilege('anon', 'sdk_session_purged', 'select') anon, has_table_privilege('authenticated', 'sdk_session_purged', 'select') auth",
    );
    expect(tomb).toEqual({ anon: false, auth: false });
    for (const r of helpers) expect(r).toMatchObject({ pub: false, anon: false, auth: false });
  });

  it("a purge whose index is missing refuses to run instead of scanning the table", async () => {
    await db.query("drop index thread_event_prunable_created_idx");
    await expect(db.query("select purge_thread_event_steps(10)")).rejects.toMatchObject({ code: "55000" });
    await db.query("create index thread_event_prunable_created_idx on praxis_logs (created_at)");
    await expect(db.query("select purge_thread_event_steps(10)")).rejects.toMatchObject({ code: "55000" });
    await db.query("drop index thread_event_prunable_created_idx");
    await db.query(readFileSync(join(MIGRATIONS, MIGRATION_FILES.find((f) => f.includes("thread_event"))!), "utf8"));
    expect((await one<{ n: number }>("select purge_thread_event_steps(10) n")).n).toBe(0);
    await db.query("drop index thread_event_prunable_created_idx");
    await db.query("create index thread_event_prunable_created_idx on thread_event (created_at)");
    await expect(db.query("select purge_thread_event_steps(10)")).rejects.toMatchObject({ code: "55000" });
    await db.query("drop index thread_event_prunable_created_idx");
    await db.query("create index thread_event_prunable_created_idx on thread_event (created_at) where kind = 'tool_call'");
    await expect(db.query("select purge_thread_event_steps(10)")).rejects.toMatchObject({ code: "55000" });
    await db.query("drop index thread_event_prunable_created_idx");
    await db.query(readFileSync(join(MIGRATIONS, MIGRATION_FILES.find((f) => f.includes("thread_event"))!), "utf8"));
    await db.query("drop index praxis_logs_created_idx");
    await db.query("create index praxis_logs_created_idx on praxis_logs (level)");
    await expect(db.query("select purge_praxis_logs(10)")).rejects.toMatchObject({ code: "55000" });
    await db.query("drop index praxis_logs_created_idx");
    await db.query(readFileSync(join(MIGRATIONS, MIGRATION_FILES.find((f) => f.includes("praxis_logs"))!), "utf8"));
    expect((await one<{ n: number }>("select purge_praxis_logs(10) n")).n).toBe(0);
    for (const fn of ["purge_stream_drafts", "purge_memory_search_traces", "purge_eval_candidates", "purge_run_events", "purge_ship_pr_file_contents"]) {
      await db.query(`select ${fn}(1)`);
    }
    await db.query("select expire_stale_code_indexes(1)");
    await db.query("drop index code_symbols_build_idx");
    await expect(db.query("select purge_code_index_orphans(10)")).rejects.toMatchObject({ code: "55000" });
    await db.query("create index code_symbols_build_idx on code_symbols (tenant_id, repo_full_name, build_id)");
  });

  it("sdk sessions: a purge waits for an in-flight append to a NEW subpath of the session, then keeps it", async () => {
    const thread = randomUUID();
    await db.query("insert into agent_threads values ($1, $2, 'sess-race')", [thread, T]);
    await db.query(`insert into sdk_session_entries (tenant_id, thread_id, session_key, position, created_at) values ($1, $2, 'sess-race', 1, ${days(40)}), ($1, $2, 'sess-race::old-sub', 1, ${days(40)})`, [T, thread]);
    const appender = new Client({ connectionString: dbUrl });
    const purger = new Client({ connectionString: dbUrl });
    await appender.connect();
    await purger.connect();
    try {
      await purger.query("update retention_purge_cursor set after_ts = null, after_id = null where purge = 'sdk_sessions'");
      await appender.query("begin");
      await appender.query("select sdk_session_append($1, $2, 'p', 'sess-race::new-sub', $3)", [T, thread, JSON.stringify([{ type: "user" }])]);
      let done = false;
      const purge = purger.query("select purge_sdk_sessions(1000) r").then((r) => {
        done = true;
        return r.rows[0].r as { deleted: number };
      });
      await new Promise((r) => setTimeout(r, 300));
      expect(done).toBe(false);
      await appender.query("commit");
      await purge;
      expect(await q("select session_key from sdk_session_entries where thread_id = $1 order by 1", [thread])).toEqual([
        { session_key: "sess-race" },
        { session_key: "sess-race::new-sub" },
        { session_key: "sess-race::old-sub" },
      ]);
      expect((await one<{ s: string | null }>("select sdk_session_id s from agent_threads where id = $1", [thread])).s).toBe("sess-race");
    } finally {
      await appender.end();
      await purger.end();
    }
  });

  it("sdk sessions: an append that waited while the purge removed its session is refused, not started over", async () => {
    const thread = randomUUID();
    await db.query("insert into agent_threads values ($1, $2, 'sess-gone')", [thread, T]);
    await db.query(`insert into sdk_session_entries (tenant_id, thread_id, session_key, position, created_at) values ($1, $2, 'sess-gone', 1, ${days(40)})`, [T, thread]);
    await db.query("update retention_purge_cursor set after_ts = null, after_id = null where purge = 'sdk_sessions'");
    const purger = new Client({ connectionString: dbUrl });
    const appender = new Client({ connectionString: dbUrl });
    await purger.connect();
    await appender.connect();
    try {
      await purger.query("begin");
      const r = (await purger.query("select purge_sdk_sessions(1000) r")).rows[0].r as { deleted: number };
      expect(r.deleted).toBeGreaterThanOrEqual(1);
      let settled = false;
      const append = appender
        .query("select sdk_session_append($1, $2, 'p', 'sess-gone::new-sub', $3)", [T, thread, JSON.stringify([{ type: "user" }])])
        .then(
          () => ({ code: null as string | null }),
          (e: { code?: string }) => ({ code: e.code ?? "?" }),
        )
        .finally(() => {
          settled = true;
        });
      await new Promise((res) => setTimeout(res, 300));
      expect(settled).toBe(false);
      await purger.query("commit");
      expect(await append).toEqual({ code: "ZSP01" });
      expect(await count("sdk_session_entries where thread_id = $1", [thread])).toBe(0);
      expect((await one<{ s: string | null }>("select sdk_session_id s from agent_threads where id = $1", [thread])).s).toBeNull();
      await db.query("select sdk_session_append($1, $2, 'p', 'sess-new', $3)", [T, thread, JSON.stringify([{ type: "user" }])]);
      expect(await count("sdk_session_entries where thread_id = $1 and session_key = 'sess-new'", [thread])).toBe(1);
    } finally {
      await purger.end();
      await appender.end();
    }
  });

  it("sdk sessions: tombstones older than 30 days are pruned by the purge", async () => {
    await db.query(`insert into sdk_session_purged (tenant_id, thread_id, session_id, purged_at) values ($1, $2, 'old-tomb', ${days(31)}), ($1, $2, 'new-tomb', ${days(1)})`, [T, randomUUID()]);
    await db.query("select purge_sdk_sessions(10)");
    expect((await q<{ session_id: string }>("select session_id from sdk_session_purged where session_id in ('old-tomb', 'new-tomb')")).map((r) => r.session_id)).toEqual(["new-tomb"]);
  });

  it("sdk sessions: a 1,500-entry session waits on a 1,000-entry call and goes whole on a 5,000-entry one", async () => {
    await db.query("update retention_purge_cursor set after_ts = null, after_id = null where purge = 'sdk_sessions'");
    const thread = randomUUID();
    await db.query("insert into agent_threads values ($1, $2, 'mid')", [thread, T]);
    await db.query(
      `insert into sdk_session_entries (tenant_id, thread_id, session_key, position, created_at)
       select $1, $2, 'mid', g, ${days(85)} + g * interval '1 second' from generate_series(1, 1500) g`,
      [T, thread],
    );
    const small = (await one<{ r: { deleted: number; deferred: boolean; more: boolean } }>("select purge_sdk_sessions(1000) r")).r;
    expect(small).toMatchObject({ deleted: 0, deferred: true, more: false });
    expect(await count("sdk_session_entries where thread_id = $1", [thread])).toBe(1500);
    const big = (await one<{ r: { deleted: number } }>("select purge_sdk_sessions(5000) r")).r;
    expect(big.deleted).toBeGreaterThanOrEqual(1500);
    expect(await count("sdk_session_entries where thread_id = $1", [thread])).toBe(0);
  });

  it("sdk sessions: a session too big for one call is skipped and counted, never cut", async () => {
    await db.query("update retention_purge_cursor set after_ts = null, after_id = null where purge = 'sdk_sessions'");
    const thread = randomUUID();
    await db.query("insert into agent_threads values ($1, $2, 'huge')", [thread, T]);
    await db.query(
      `insert into sdk_session_entries (tenant_id, thread_id, session_key, position, created_at)
       select $1, $2, 'huge', g, ${days(80)} + g * interval '1 second' from generate_series(1, 5001) g`,
      [T, thread],
    );
    await db.query(`insert into sdk_session_entries (tenant_id, thread_id, session_key, position, created_at) values ($1, $2, 'small', 1, ${days(79)})`, [T, thread]);
    let oversized = 0;
    let r: { more: boolean; oversized: number } = { more: true, oversized: 0 };
    for (let i = 0; i < 20 && r.more; i++) {
      r = (await one<{ r: typeof r }>("select purge_sdk_sessions(5000) r")).r;
      oversized += r.oversized;
    }
    expect(oversized).toBeGreaterThanOrEqual(1);
    expect(await count("sdk_session_entries where thread_id = $1 and session_key = 'huge'", [thread])).toBe(5001);
    expect(await count("sdk_session_entries where thread_id = $1 and session_key = 'small'", [thread])).toBe(0);
    expect((await one<{ s: string | null }>("select sdk_session_id s from agent_threads where id = $1", [thread])).s).toBe("huge");
    await db.query("delete from sdk_session_entries where thread_id = $1", [thread]);
  });

  it("sdk sessions: one call claims sessions only up to its entry budget, never part of one", async () => {
    await db.query("update retention_purge_cursor set after_ts = null, after_id = null where purge = 'sdk_sessions'");
    const thread = randomUUID();
    await db.query("insert into agent_threads values ($1, $2, null)", [thread, T]);
    for (const [sid, n, age] of [["big-a", 3, 60], ["big-b", 3, 59], ["big-c", 3, 58]] as const) {
      for (let i = 1; i <= n; i++) {
        await db.query(`insert into sdk_session_entries (tenant_id, thread_id, session_key, position, created_at) values ($1, $2, $3, $4, ${days(age)})`, [T, thread, sid, i]);
      }
    }
    const first = (await one<{ r: { deleted: number; sessions: number; more: boolean } }>("select purge_sdk_sessions(4) r")).r;
    expect(first).toMatchObject({ deleted: 3, sessions: 1, more: true });
    expect((await q<{ k: string }>("select distinct session_key k from sdk_session_entries where thread_id = $1 order by 1", [thread])).map((r) => r.k)).toEqual(["big-b", "big-c"]);
    let r = first;
    for (let i = 0; i < 10 && r.more; i++) r = (await one<{ r: typeof first }>("select purge_sdk_sessions(4) r")).r;
    expect(await count("sdk_session_entries where thread_id = $1", [thread])).toBe(0);
  });

  it("code index: refs finish their pass before symbols start, so symbols are never starved", async () => {
    await db.query("update retention_purge_cursor set after_tenant = null, after_key = null where purge in ('code_symbol_refs', 'code_symbols', 'code_index_phase')");
    const t2 = randomUUID();
    for (let i = 0; i < 4; i++) {
      await db.query(`insert into code_symbol_refs (tenant_id, repo_full_name, build_id, indexed_at) values ($1, $2, $3, ${days(5)})`, [t2, `r/${i}`, randomUUID()]);
    }
    await db.query(`insert into code_symbols (tenant_id, repo_full_name, build_id, indexed_at) values ($1, 's/0', $2, ${days(5)})`, [t2, randomUUID()]);
    const phases: string[] = [];
    let more = true;
    for (let i = 0; i < 30 && more; i++) {
      const r = (await one<{ r: { more: boolean; phase: string } }>("select purge_code_index_orphans(100, 1) r")).r;
      phases.push(r.phase);
      more = r.more;
    }
    expect(more).toBe(false);
    expect(await count("code_symbol_refs where tenant_id = $1", [t2])).toBe(0);
    expect(await count("code_symbols where tenant_id = $1", [t2])).toBe(0);
    expect(phases.lastIndexOf("code_symbol_refs")).toBeLessThan(phases.indexOf("code_symbols"));
  });
});

function pgStoreDb(db: Client): SessionStoreDb {
  return {
    rpc: async () => ({ error: null }),
    from: () => ({
      select: () => {
        const filters: Array<[string, unknown]> = [];
        const f = {
          eq(col: string, val: unknown) {
            filters.push([col, val]);
            return f;
          },
          async order(col: string) {
            const where = filters.map(([c], i) => `${c} = $${i + 1}`).join(" and ");
            const { rows } = await db.query(`select entry from sdk_session_entries where ${where} order by ${col}`, filters.map(([, v]) => v));
            return { data: rows as Array<{ entry: unknown }>, error: null };
          },
        };
        return f;
      },
    }),
  };
}
