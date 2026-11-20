
import { Client } from "pg";
import mysql from "mysql2/promise";
import type { OperatorDbType } from "@/services/tools/operator-db/types";
import { pgSslOption } from "@/services/tools/operator-db/pg-ssl";

export type WriteCapable = "true" | "false" | "unknown";

export const PG_PRIVILEGE_AUDIT_SQL = `
SELECT r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolbypassrls, r.rolreplication,
  pg_has_role(current_user, 'pg_write_all_data', 'USAGE') AS write_all_data,
  has_database_privilege(current_user, current_database(), 'CREATE') AS db_create,
  EXISTS (
    SELECT 1 FROM pg_namespace n
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
       AND has_schema_privilege(current_user, n.oid, 'CREATE')
  ) AS schema_create,
  EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
       AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
       AND (pg_has_role(current_user, c.relowner, 'USAGE')
            OR has_table_privilege(current_user, c.oid, 'INSERT')
            OR has_table_privilege(current_user, c.oid, 'UPDATE')
            OR has_table_privilege(current_user, c.oid, 'DELETE')
            OR has_table_privilege(current_user, c.oid, 'TRUNCATE'))
  ) AS table_write
FROM pg_roles r WHERE r.rolname = current_user`;

export type PgAuditRow = Record<string, boolean | null | undefined>;
const PG_FLAGS = ["rolsuper", "rolcreaterole", "rolcreatedb", "rolbypassrls", "rolreplication", "write_all_data", "db_create", "schema_create", "table_write"];

export function pgVerdict(row: PgAuditRow | undefined): WriteCapable {
  if (!row) return "unknown";
  let unknown = false;
  for (const k of PG_FLAGS) {
    const v = row[k];
    if (v === true) return "true";
    if (v !== false) unknown = true;
  }
  return unknown ? "unknown" : "false";
}

const MYSQL_READ_ONLY = new Set(["SELECT", "SHOW VIEW", "USAGE", "SHOW DATABASES", "PROCESS", "REPLICATION CLIENT"]);

export function mysqlVerdict(lines: string[]): WriteCapable {
  if (lines.length === 0) return "unknown";
  let unknown = false;
  for (const raw of lines) {
    const line = raw.trim().replace(/\s+/g, " ");
    if (!/^GRANT /i.test(line)) {
      unknown = true;
      continue;
    }
    if (/ WITH (GRANT|ADMIN) OPTION$/i.test(line)) return "true";
    const m = /^GRANT (.+?) ON (.+) TO /i.exec(line);
    if (!m) {
      unknown = true;
      continue;
    }
    const privs = m[1]!
      .replace(/\([^)]*\)/g, "")
      .split(",")
      .map((p) => p.trim().toUpperCase())
      .filter(Boolean);
    if (privs.some((p) => !MYSQL_READ_ONLY.has(p))) return "true";
  }
  return unknown ? "unknown" : "false";
}

export async function probeWriteCapable(type: OperatorDbType, connectionString: string): Promise<WriteCapable> {
  try {
    if (type === "postgres") {
      const c = new Client({
        connectionString,
        ssl: pgSslOption(connectionString),
        connectionTimeoutMillis: 6000,
        statement_timeout: 4000,
      });
      try {
        await c.connect();
        const r = await c.query<PgAuditRow>(PG_PRIVILEGE_AUDIT_SQL);
        return pgVerdict(r.rows[0]);
      } finally {
        await c.end().catch(() => undefined);
      }
    }
    if (type === "mysql") {
      const conn = await mysql.createConnection({ uri: connectionString, connectTimeout: 6000 });
      try {
        const [rows] = await conn.query("SHOW GRANTS FOR CURRENT_USER()");
        const lines = (rows as Array<Record<string, unknown>>).map((r) => String(Object.values(r)[0] ?? ""));
        return mysqlVerdict(lines);
      } finally {
        await conn.end().catch(() => undefined);
      }
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}
