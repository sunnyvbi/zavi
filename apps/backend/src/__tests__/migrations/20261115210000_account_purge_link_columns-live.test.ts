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
  throw new Error(`[account-purge-link-columns-live] REQUIRE_RLS_MATRIX=1 but the suite would skip (url=${!!PG_URL}).`);
}

type Ref = { rel: string; col: string; action: string | null; bucket: string };

describe.skipIf(!SHOULD_RUN)("20261115210000 account purge link columns (live catalog)", () => {
  let c: Client;

  beforeAll(async () => {
    c = new Client({ connectionString: PG_URL });
    await c.connect();
    const { rows } = await c.query<{ ok: boolean }>(
      "select to_regprocedure('public._account_purge_tenant_refs()') is not null as ok",
    );
    if (!rows[0]?.ok) throw new Error("ZAVI_TEST_PG_URL has no account purge functions: point it at a fully migrated database");
  });
  afterAll(async () => {
    await c?.end();
  });

  it("every foreign-key column to tenants is classified", async () => {
    const { rows } = await c.query<Ref>(
      "select rel, col, action, bucket from _account_purge_tenant_refs() where bucket = 'unclassified' order by 1, 2",
    );
    expect(rows, "add each of these to account_purge_link_columns() as 'owner' or 'foreign'").toEqual([]);
  });

  it("the classifier sees every foreign key to tenants (single column, public table)", async () => {
    const { rows } = await c.query<{ rel: string; conname: string }>(
      `select c.conrelid::regclass::text as rel, c.conname::text as conname
         from pg_constraint c
         join pg_class cl on cl.oid = c.conrelid
         join pg_namespace ns on ns.oid = cl.relnamespace
        where c.contype = 'f'
          and c.confrelid = 'public.tenants'::regclass
          and c.conparentid = 0
          and (array_length(c.conkey, 1) <> 1 or ns.nspname <> 'public' or cl.relkind not in ('r', 'p'))
        order by 1, 2`,
    );
    expect(rows).toEqual([]);
  });

  it("every listed column exists, points at tenants and lands in the bucket its kind says", async () => {
    const { rows } = await c.query<{ rel: string; col: string; kind: string; action: string | null; bucket: string | null }>(
      `select l.rel, l.col, l.kind, r.action, r.bucket
         from account_purge_link_columns() l
         left join _account_purge_tenant_refs() r on r.rel = l.rel and r.col = l.col
        order by 1, 2`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const where = `${row.rel}.${row.col} (${row.kind})`;
      expect(row.bucket, `${where}: no foreign key to tenants`).not.toBeNull();
      if (row.kind === "foreign") expect(["other", "keep"], where).toContain(row.bucket);
      else expect(["delete", "clear", "keep"], where).toContain(row.bucket);
    }
    expect(rows.find((r) => r.rel === "ads_provider_accounts" && r.col === "credential_tenant_id")).toMatchObject({
      kind: "owner",
      action: "c",
      bucket: "delete",
    });
  });
});
