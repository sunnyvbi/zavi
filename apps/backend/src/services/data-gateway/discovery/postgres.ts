
import { Client } from "pg";
import {
  sampleJsonKeys,
  annotatePgStructuredColumns,
  pgColumnType,
  PG_COLUMNS_SQL,
  PG_ANCESTORS_SQL,
  ancestorsMap,
  capWithAncestors,
  type AncestorRow,
  type PgColumnRow,
  type PgTypeRef,
} from "@zavi/shared/db-guard";
import type { RawIntrospection, RawTable, RawColumn } from "@/services/tools/operator-db/types";
import { prioritizeAndCap, isSafeName, DEFAULT_TABLE_CAP, COLUMN_BATCH } from "@/services/tools/operator-db/discovery/util";
import { pgSslOption } from "@/services/tools/operator-db/pg-ssl";

export async function introspectPostgres(
  connectionString: string,
  tableCap: number = DEFAULT_TABLE_CAP,
  deadlineMs: number = Date.now() + 25_000,
): Promise<RawIntrospection> {
  const client = new Client({
    connectionString,
    ssl: pgSslOption(connectionString),
    statement_timeout: 5000,
    query_timeout: 5000,
    connectionTimeoutMillis: 8000,
  });
  try {
    await client.connect();
    await client.query("SET search_path = pg_catalog, public");
    await client.query("BEGIN TRANSACTION READ ONLY");

    const all = await client.query<{ table_name: string; est: string | null }>(
      `SELECT t.table_name, c.reltuples::bigint AS est
         FROM information_schema.tables t
         LEFT JOIN pg_namespace n ON n.nspname = t.table_schema
         LEFT JOIN pg_class c ON c.relname = t.table_name AND c.relnamespace = n.oid
        WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'`,
    );
    const allNames = all.rows.map((r) => r.table_name);
    const estimates = new Map<string, number | null>(
      all.rows.map((r) => {
        const n = r.est == null ? null : Number(r.est);
        return [r.table_name, n == null || n < 0 ? null : n];
      }),
    );
    const parts = await client.query<{ parent: string; parts: string[] | null }>(
      `WITH RECURSIVE tree AS (
         SELECT c.oid AS root, i.inhrelid AS child
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_inherits i ON i.inhparent = c.oid
          WHERE n.nspname = 'public' AND c.relkind = 'p'
         UNION
         SELECT t.root, i.inhrelid FROM tree t JOIN pg_inherits i ON i.inhparent = t.child
       )
       SELECT p.relname AS parent,
              array_agg(CASE WHEN ns.nspname = 'public' THEN ch.relname ELSE ns.nspname || '.' || ch.relname END) AS parts
         FROM tree t
         JOIN pg_class p ON p.oid = t.root
         JOIN pg_class ch ON ch.oid = t.child
         JOIN pg_namespace ns ON ns.oid = ch.relnamespace
        GROUP BY p.relname
       UNION ALL
       SELECT c.relname, NULL FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'p'
          AND NOT EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhparent = c.oid)`,
    );
    const partitionsOf = new Map<string, string[]>(parts.rows.map((r) => [r.parent, r.parts ?? []]));
    const anc = await client.query<AncestorRow>(PG_ANCESTORS_SQL);
    const ancestorsOf = ancestorsMap(anc.rows);
    const skippedUnsafeNames = allNames.filter((n) => !isSafeName(n)).length;
    const ranked = prioritizeAndCap(allNames, allNames.length, estimates);
    const picked = capWithAncestors(ranked, tableCap, ancestorsOf, new Set(ranked));

    let deadlineHit = false;
    const colsByTable = new Map<string, RawColumn[]>();
    const typeRefs: PgTypeRef[] = [];
    for (let i = 0; i < picked.length; i += COLUMN_BATCH) {
      if (Date.now() > deadlineMs) {
        deadlineHit = true;
        break;
      }
      const chunk = picked.slice(i, i + COLUMN_BATCH);
      const cols = await client.query<PgColumnRow & { table_name: string; column_name: string; is_nullable: string }>(PG_COLUMNS_SQL, [chunk]);
      for (const c of cols.rows) {
        let arr = colsByTable.get(c.table_name);
        if (!arr) {
          arr = [];
          colsByTable.set(c.table_name, arr);
        }
        arr.push({
          name: c.column_name,
          type: pgColumnType(c),
          nullable: c.is_nullable === "YES",
        });
        if (c.data_type === "USER-DEFINED") typeRefs.push({ table: c.table_name, column: c.column_name, schema: c.type_schema ?? null, name: c.udt_name ?? null });
      }
    }

    const tables: RawTable[] = [];
    for (const t of picked) {
      const columns = colsByTable.get(t);
      if (!columns) continue;
      const estVal = estimates.get(t) ?? null;
      const partitions = partitionsOf.get(t);
      const parents = ancestorsOf.get(t);
      tables.push({
        name: t,
        columns,
        rowEstimate: estVal == null ? null : Number(estVal),
        ...(partitions ? { partitioned: true, partitions } : {}),
        ...(parents && parents.length > 0 ? { parents } : {}),
      });
    }

    await sampleJsonKeys("postgres", tables, async (q) => (await client.query(q)).rows as Record<string, unknown>[], { deadlineAt: deadlineMs });
    await annotatePgStructuredColumns(tables, typeRefs, async (q, params) => (await client.query(q, params)).rows as Record<string, unknown>[], { deadlineAt: deadlineMs });
    await client.query("COMMIT").catch(() => undefined);
    return {
      dialect: "postgres", tables, skippedUnsafeNames,
      namesSeenTotal: allNames.length,
      deadlineHit,
      listingTruncated: false };
  } finally {
    await client.end().catch(() => undefined);
  }
}
