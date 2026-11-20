import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PG_URL = process.env.ZAVI_TEST_PG_URL;
const host = (() => {
  try {
    return PG_URL ? new URL(PG_URL).hostname : null;
  } catch {
    return null;
  }
})();
const SHOULD_RUN = !!PG_URL && (host === "127.0.0.1" || host === "localhost" || host === "::1");
if (process.env.REQUIRE_RLS_MATRIX === "1" && !SHOULD_RUN) {
  throw new Error(`[account-purge-safety-live] REQUIRE_RLS_MATRIX=1 but the suite would skip (url=${!!PG_URL}).`);
}

const NOT_STORAGE_PATHS: Record<string, string> = {
  "agent_runs.agent_definition_path": "repo path of the agent definition",
  "code_symbol_refs.file_path": "source file path in a connected repo",
  "code_symbols.file_path": "source file path in a connected repo",
  "creator_notifications.link_path": "in-app route the notification opens",
  "fundraising_raise_intro.path": "intro path label",
  "geo_crawler_hits_daily.path": "URL path a crawler fetched",
  "repo_profiles.manifest_paths": "manifest file paths in a connected repo",
  "site_comment_threads.page_path": "page URL path on the site",
  "site_function_logs.path": "request URL path",
  "site_page_views.path": "page URL path",
  "tenant_sandbox.preview_path": "route the engineer preview opens",
};

describe.skipIf(!SHOULD_RUN)("20261116200000 account purge safety (live catalog)", () => {
  let c: Client;

  beforeAll(async () => {
    c = new Client({ connectionString: PG_URL });
    await c.connect();
    const { rows } = await c.query<{ ok: boolean }>(
      `select to_regprocedure('public._account_purge_cross_tenant(uuid[],uuid,uuid[],text,boolean)') is not null
          and to_regprocedure('public._account_purge_cross_tenant_report(uuid[],uuid,uuid[],text,boolean)') is not null
          and to_regprocedure('public.account_deletion_begin(uuid,uuid,text,text,timestamptz,uuid[],uuid[])') is not null as ok`,
    );
    if (!rows[0]?.ok) throw new Error("ZAVI_TEST_PG_URL has no 20261116200000 purge functions: point it at a fully migrated database");
  });
  afterAll(async () => {
    await c?.end();
  });

  it("the cross-workspace walk runs on the real foreign-key graph in every mode, locking or not", async () => {
    for (const mode of ["workspace", "user", "runs"]) {
      for (const lock of [false, true]) {
        await c.query("begin");
        try {
          const { rows } = await c.query<{ j: Record<string, number> }>(
            "select _account_purge_cross_tenant($1::uuid[], $2::uuid, $3::uuid[], $4, $5) as j",
            [[randomUUID()], randomUUID(), [randomUUID()], mode, lock],
          );
          expect(rows[0].j, `${mode} lock=${lock}`).toEqual({});
          if (!lock) {
            const report = await c.query<{ j: Record<string, number> }>(
              "select _account_purge_cross_tenant_report($1::uuid[], $2::uuid, $3::uuid[], $4, false) as j",
              [[randomUUID()], randomUUID(), [randomUUID()], mode],
            );
            expect(report.rows[0].j, `${mode} report`).toEqual({});
          }
        } finally {
          await c.query("rollback");
        }
      }
    }
  });

  it("every storage path column in a workspace table is listed, or named here as not a storage path", async () => {
    const { rows } = await c.query<{ col: string }>(
      `select cl.relname || '.' || a.attname as col
         from pg_attribute a
         join pg_class cl on cl.oid = a.attrelid
         join pg_namespace ns on ns.oid = cl.relnamespace
         join pg_type t on t.oid = a.atttypid
        where ns.nspname = 'public' and cl.relkind in ('r', 'p') and a.attnum > 0 and not a.attisdropped
          and (a.attname ~ '(_path|_paths)$' or a.attname in ('path', 'storage_path'))
          and (t.typname in ('text', 'varchar', '_text', '_varchar'))
          and exists (select 1 from pg_attribute ta
                       where ta.attrelid = a.attrelid and ta.attname = 'tenant_id' and not ta.attisdropped)
          and not exists (select 1 from account_purge_storage_ref_columns() l
                           where l.rel = cl.relname and l.col = a.attname)
        order by 1`,
    );
    const unclassified = rows.map((r) => r.col).filter((col) => !(col in NOT_STORAGE_PATHS));
    expect(unclassified, "add each to account_purge_storage_ref_columns() or NOT_STORAGE_PATHS").toEqual([]);
  });

  it("every listed storage path column exists in a table with a tenant_id", async () => {
    const { rows } = await c.query<{ rel: string; col: string; ok: boolean }>(
      `select l.rel, l.col,
              exists (select 1 from pg_attribute a
                       where a.attrelid = to_regclass('public.' || quote_ident(l.rel))
                         and a.attname = l.col and not a.attisdropped)
              and exists (select 1 from pg_attribute a
                           where a.attrelid = to_regclass('public.' || quote_ident(l.rel))
                             and a.attname = 'tenant_id' and not a.attisdropped) as ok
         from account_purge_storage_ref_columns() l order by 1, 2`,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r) => !r.ok).map((r) => `${r.rel}.${r.col}`)).toEqual([]);
  });
});
