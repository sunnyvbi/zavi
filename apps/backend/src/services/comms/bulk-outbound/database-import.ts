
import { ExpectedToolError } from "@/services/tools/types";
import { listContactImportTables, readContactColumn, type ContactImportContext } from "@/services/data-gateway/person";
import { DATABASE_IMPORT_MAX_ROWS } from "./config";
import { BulkEmailError } from "./errors";

const TABLE_IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)?$/;
const COLUMN_IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export type ImportTable = { name: string; columns: Array<{ name: string; type: string }> };

function notConnected(): BulkEmailError {
  return new BulkEmailError("database_not_connected", "Connect your database first, then import from it.", 409);
}

const importCtx = (tenantId: string, userId: string): ContactImportContext => ({
  tenant_id: tenantId,
  caller: { kind: "person", user_id: userId, feature: "Contact import" },
});

export async function listImportTables(tenantId: string, userId: string): Promise<ImportTable[]> {
  try {
    return (await listContactImportTables(importCtx(tenantId, userId))).filter((t) => typeof t.name === "string" && t.name.length > 0);
  } catch (e) {
    if (e instanceof ExpectedToolError) throw notConnected();
    throw e;
  }
}

function quote(dbType: "postgres" | "mysql", ident: string): string {
  const q = dbType === "postgres" ? '"' : "`";
  return ident
    .split(".")
    .map((part) => `${q}${part}${q}`)
    .join(".");
}

export function buildColumnRead(dbType: "postgres" | "mysql", table: string, column: string): string {
  if (!TABLE_IDENT.test(table) || !COLUMN_IDENT.test(column)) {
    throw new BulkEmailError("database_bad_name", "That table or column cannot be imported.");
  }
  const col = quote(dbType, column);
  return `SELECT ${col} FROM ${quote(dbType, table)} WHERE ${col} IS NOT NULL LIMIT ${DATABASE_IMPORT_MAX_ROWS + 1}`;
}

export type DatabaseColumnRead = {
  db_type: string;
  table: string;
  column: string;
  values: unknown[];
  truncated: boolean;
};

export async function readDatabaseColumn(args: {
  tenantId: string;
  userId: string;
  table: string;
  column: string;
}): Promise<DatabaseColumnRead> {
  let tables: ImportTable[];
  try {
    tables = await listContactImportTables(importCtx(args.tenantId, args.userId));
  } catch (e) {
    if (e instanceof ExpectedToolError) throw notConnected();
    throw new BulkEmailError("database_read_failed", "We could not read your database's tables just now. Try again.", 502);
  }
  const wantTable = String(args.table ?? "").trim().toLowerCase();
  const tableMatches = tables.filter((t) => t.name.toLowerCase() === wantTable);
  const catTable = tableMatches.length === 1 ? tableMatches[0] : undefined;
  if (!catTable) {
    throw new BulkEmailError("database_table_not_found", "That table was not found in your connected database.");
  }
  const wantColumn = String(args.column ?? "").trim().toLowerCase();
  const columnMatches = catTable.columns.filter((c) => c.name.toLowerCase() === wantColumn);
  const catColumn = columnMatches.length === 1 ? columnMatches[0] : undefined;
  if (!catColumn) {
    throw new BulkEmailError("database_column_not_found", "That column was not found in that table.");
  }
  if (!TABLE_IDENT.test(catTable.name) || !COLUMN_IDENT.test(catColumn.name)) {
    throw new BulkEmailError("database_bad_name", "That table or column cannot be imported.");
  }

  let read: Awaited<ReturnType<typeof readContactColumn>>;
  try {
    read = await readContactColumn(importCtx(args.tenantId, args.userId), catTable.name, catColumn.name, DATABASE_IMPORT_MAX_ROWS);
  } catch (e) {
    if (e instanceof ExpectedToolError && e.code === "operator_db_unsupported_dialect") {
      throw new BulkEmailError(
        "database_not_supported",
        "Importing from this kind of database is not supported yet. Upload a CSV instead.",
      );
    }
    if (e instanceof ExpectedToolError && (e.code === "operator_db_not_connected" || e.code === "operator_db_not_discovered")) throw notConnected();
    throw new BulkEmailError("database_read_failed", "We could not read that column from your database. Try again.", 502);
  }
  const values = read.dialect === "mongodb" ? read.values.filter((v): v is string => typeof v === "string") : read.values;
  return { db_type: read.dialect, table: read.table, column: read.field, values, truncated: read.truncated };
}
