
import { withAttachedDriver } from "@/services/data-gateway";
import { allowedCollectionsFromCatalog } from "./catalog";
import { runCodeActReads } from "./codeact-sql";
import { redactDocDeep } from "./discovery/redact";
import { isSecretField } from "./discovery/redact";
import { sessionFor } from "./session-attach";
import { ExpectedToolError } from "@/services/tools/types";
import type { GenericReadOptions, OperatorDbType } from "./types";

export const ROW_BROWSE_MAX_LIMIT = 100;
export const ROW_BROWSE_DEFAULT_LIMIT = 25;
export const ROW_BROWSE_MAX_OFFSET = 100_000;
const MASK = "••••••";
const CELL_MAX_CHARS = 500;

const SQL_IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)?$/;

export type RowBrowseColumn = { name: string; type: string };
export type RowBrowseCell = string | number | boolean | null;
export type RowBrowseResult = {
  dialect: OperatorDbType;
  table: string;
  columns: RowBrowseColumn[];
  rows: Record<string, RowBrowseCell>[];
  has_more: boolean;
  masked_columns: string[];
};

export function normalizeCell(v: unknown, opts?: { truncate?: boolean }): RowBrowseCell {
  if (v === null || v === undefined) return null;
  const t = typeof v;
  if (t === "number" || t === "boolean") return v as RowBrowseCell;
  if (v instanceof Date) return v.toISOString();
  let s: string;
  if (t === "string") {
    s = v as string;
  } else if (t === "bigint") {
    s = (v as bigint).toString();
  } else if (Array.isArray(v) || Object.getPrototypeOf(v) === Object.prototype) {
    try {
      s = JSON.stringify(v);
    } catch {
      s = String(v);
    }
  } else {
    s = String(v);
  }
  if (opts?.truncate === false) return s;
  return s.length > CELL_MAX_CHARS ? `${s.slice(0, CELL_MAX_CHARS - 1)}…` : s;
}

export function wasCellTruncated(cell: RowBrowseCell): boolean {
  return typeof cell === "string" && cell.length === CELL_MAX_CHARS && cell.endsWith("…");
}

export function maskRow(
  row: Record<string, unknown>,
  secretCols: ReadonlySet<string>,
): Record<string, RowBrowseCell> {
  const out: Record<string, RowBrowseCell> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = secretCols.has(k.toLowerCase()) ? (v == null ? null : MASK) : normalizeCell(v);
  }
  return out;
}

export function buildBoundedSelect(table: string, limit: number, offset: number): string {
  if (!SQL_IDENT.test(table)) {
    throw new ExpectedToolError("operator_db_bad_table", `Table name not identifier-safe: ${table}`);
  }
  const lim = Math.max(1, Math.floor(limit));
  const off = Math.max(0, Math.floor(offset));
  return `SELECT * FROM ${table} LIMIT ${lim} OFFSET ${off}`;
}

export function clampLimit(raw: number): number {
  if (!Number.isFinite(raw)) return ROW_BROWSE_DEFAULT_LIMIT;
  return Math.max(1, Math.min(ROW_BROWSE_MAX_LIMIT, Math.floor(raw)));
}
export function clampOffset(raw: number): number {
  if (!Number.isFinite(raw) || raw < 0) return 0;
  const off = Math.floor(raw);
  if (off > ROW_BROWSE_MAX_OFFSET) {
    throw new ExpectedToolError(
      "operator_db_offset_too_large",
      `This viewer pages up to ${ROW_BROWSE_MAX_OFFSET.toLocaleString()} rows. Narrow the table or query the database directly.`,
    );
  }
  return off;
}

export async function readTableRows(args: {
  tenantId: string;
  userId: string;
  table: string;
  limit: number;
  offset: number;
}): Promise<RowBrowseResult> {
  const limit = clampLimit(args.limit);
  const offset = clampOffset(args.offset);
  const ctx = { tenant_id: args.tenantId, caller: { kind: "person" as const, user_id: args.userId, feature: "Table browser" as const } };

  return withAttachedDriver(ctx, async ({ driver, cfg, access }) => {
    const config = access.config;
    const resolved = access.catalog;
    const allowed = allowedCollectionsFromCatalog(resolved.catalog);

    const want = args.table.trim().toLowerCase();
    const matches = (resolved.catalog.tables ?? []).filter((t) => typeof t.name === "string" && t.name.toLowerCase() === want);
    const catTable = matches.length === 1 ? matches[0] : undefined;
    if (!catTable || !allowed.has(want) || !access.policy.resolve(catTable.name, true)) {
      throw new ExpectedToolError("operator_db_bad_table", `Unknown table: ${args.table}`);
    }
    const tableName = catTable.name;

    const columns: RowBrowseColumn[] = (catTable.columns ?? [])
      .filter((c) => !access.policy.isHidden(tableName, c.name))
      .map((c) => ({ name: c.name, type: c.type }));
    const secretCols = new Set(
      columns.map((c) => c.name.toLowerCase()).filter((n) => isSecretField(n)),
    );

    const fetch = limit + 1;
    let rawRows: Record<string, unknown>[] = [];

    if (config.type === "mongodb") {
      if (!driver.query_collection) {
        throw new ExpectedToolError(
          "operator_db_rows_unsupported_dialect",
          "Row browsing isn't available for this operator DB driver yet.",
        );
      }
      const secretFieldExclusions = columns.map((c) => c.name).filter((n) => isSecretField(n));
      const options: GenericReadOptions = {
        limit: fetch,
        skip: offset,
        sort: { _id: 1 },
        secretFieldExclusions,
      };
      const res = await driver.query_collection(tableName, {}, options, cfg, allowed);
      rawRows = res.data?.rows ?? [];
    } else if (config.type === "postgres" || config.type === "mysql") {
      const sql = buildBoundedSelect(tableName, fetch, offset);
      const results = await runCodeActReads(sessionFor(cfg), [sql], { trustedSql: true });
      rawRows = (results[0]?.rows ?? []).map((r) => redactDocDeep(r));
    } else {
      throw new ExpectedToolError(
        "operator_db_rows_unsupported_dialect",
        `Row browsing isn't supported for ${config.type} databases yet.`,
      );
    }

    const has_more = rawRows.length > limit;
    const pageRows = has_more ? rawRows.slice(0, limit) : rawRows;
    const rows = pageRows.map((r) => maskRow(r, secretCols));

    return {
      dialect: config.type as OperatorDbType,
      table: tableName,
      columns,
      rows,
      has_more,
      masked_columns: [...secretCols],
    };
  });
}
