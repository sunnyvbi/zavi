
import { sampleJsonKeys } from "@zavi/shared/db-guard";
import mysql from "mysql2/promise";
import type { RawIntrospection, RawTable, RawColumn } from "@/services/tools/operator-db/types";
import { prioritizeAndCap, isSafeName, DEFAULT_TABLE_CAP, COLUMN_BATCH } from "@/services/tools/operator-db/discovery/util";
import { applyMysqlStatementTimeout } from "@/services/tools/operator-db/mysql-session";

export async function introspectMysql(
  connectionString: string,
  tableCap: number = DEFAULT_TABLE_CAP,
  deadlineMs: number = Date.now() + 25_000,
): Promise<RawIntrospection> {
  const conn = await mysql.createConnection({
    uri: connectionString,
    connectTimeout: 8000,
  });
  try {
    await applyMysqlStatementTimeout((sql) => conn.query(sql), 5000);
    await conn.query("SET SESSION lock_wait_timeout = 5");
    await conn.query("START TRANSACTION READ ONLY");

    const [tRows] = await conn.query({
      sql: `SELECT table_name AS n, table_rows AS est FROM information_schema.tables
            WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'`,
      timeout: 5000,
    });
    const listed = tRows as { n: string; est: number | null }[];
    const allNames = listed.map((r) => r.n);
    const estimates = new Map<string, number | null>(
      listed.map((r) => [r.n, r.est == null ? null : Number(r.est)]),
    );
    const skippedUnsafeNames = allNames.filter((n) => !isSafeName(n)).length;
    const picked = prioritizeAndCap(allNames, tableCap, estimates);

    let deadlineHit = false;
    const colsByTable = new Map<string, RawColumn[]>();
    for (let i = 0; i < picked.length; i += COLUMN_BATCH) {
      if (Date.now() > deadlineMs) {
        deadlineHit = true;
        break;
      }
      const chunk = picked.slice(i, i + COLUMN_BATCH);
      const [cRows] = await conn.query({
        sql: `SELECT table_name AS tbl, column_name AS name, data_type AS type, is_nullable AS nullable
              FROM information_schema.columns
              WHERE table_schema = DATABASE() AND table_name IN (${chunk.map(() => "?").join(",")})
              ORDER BY table_name, ordinal_position`,
        values: chunk,
        timeout: 5000,
      });
      for (const c of cRows as { tbl: string; name: string; type: string; nullable: string }[]) {
        let arr = colsByTable.get(c.tbl);
        if (!arr) {
          arr = [];
          colsByTable.set(c.tbl, arr);
        }
        arr.push({
          name: c.name,
          type: c.type,
          nullable: String(c.nullable).toUpperCase() === "YES",
        });
      }
    }

    const tables: RawTable[] = [];
    for (const t of picked) {
      const columns = colsByTable.get(t);
      if (!columns) continue;
      const est = estimates.get(t) ?? null;
      tables.push({ name: t, columns, rowEstimate: est == null ? null : Number(est) });
    }
    await sampleJsonKeys("mysql", tables, async (q) => (await conn.query({ sql: q, timeout: 5000 }))[0] as Record<string, unknown>[], { deadlineAt: deadlineMs });
    return {
      dialect: "mysql", tables, skippedUnsafeNames,
      namesSeenTotal: allNames.length,
      deadlineHit,
      listingTruncated: false };
  } finally {
    await conn.end().catch(() => undefined);
  }
}
