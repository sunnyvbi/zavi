
import { ExpectedToolError } from "@/services/tools/types";
import type { ReadSession } from "@/services/data-gateway/session";
import { isSecretField, isSensitiveName, maskTaintedValue } from "./discovery/redact";
import { isValidTimeZone } from "@/services/analytics/metric-time";
import { checkReadOnly, lexSql, stripSqlNoise } from "@zavi/shared/db-guard";

export const CODEACT_STATEMENT_TIMEOUT_MS = 5000;

export const MAX_SQL_READS = 8;
export const MAX_ROWS_PER_READ = 5000;

export { stripSqlNoise };

export function assertReadOnlyStatement(rawSql: string, dialect?: "postgres" | "mysql"): void {
  const r = checkReadOnly(rawSql, dialect);
  if (!r.ok) throw new ExpectedToolError(r.code, r.reason);
}

export function assertReadOnlyReads(sqlReads: unknown, dialect?: "postgres" | "mysql"): asserts sqlReads is string[] {
  if (!Array.isArray(sqlReads)) {
    throw new ExpectedToolError("codeact_sql_invalid", "sql_reads must be an array of SELECT/CTE strings.");
  }
  if (sqlReads.length === 0) {
    throw new ExpectedToolError("codeact_sql_empty", "sql_reads must contain at least one read query.");
  }
  if (sqlReads.length > MAX_SQL_READS) {
    throw new ExpectedToolError(
      "codeact_sql_too_many",
      `sql_reads is capped at ${MAX_SQL_READS} queries per CodeAct call (got ${sqlReads.length}).`,
    );
  }
  for (const s of sqlReads) {
    assertReadOnlyStatement(s as string, dialect);
  }
}

export type CodeActReadResult = {
  index: number;
  row_count: number;
  row_count_exact: boolean;
  truncated: boolean;
  rows: Record<string, unknown>[];
  session_tz?: string;
  largest_table_rows?: number | null;
  masked?: "columns" | "strings";
};

export type CodeActReadOptions = {
  timeZone?: string;
  trustedSql?: boolean;
};

const SAFE_TZ = /^(UTC|[A-Za-z]+(\/[A-Za-z0-9_+-]+){1,2})$/;
export function safeSessionTimeZone(tz: unknown): string | null {
  return isValidTimeZone(tz) && SAFE_TZ.test(tz) ? tz : null;
}

const FAN_OUT_FACTOR = 1.5;

export function joinedTableNames(sql: string): string[] {
  const clean = stripSqlNoise(sql);
  if (!/\bjoin\b/i.test(clean)) return [];
  const names = new Set<string>();
  for (const m of clean.matchAll(/\b(?:from|join)\s+([A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_$]*)?)/gi)) {
    names.add(m[1]);
  }
  return [...names].slice(0, 12);
}

export function fanOutCaveat(sql: string, read: CodeActReadResult): string | null {
  if (!/\bjoin\b/i.test(stripSqlNoise(sql))) return null;
  const largest = read.largest_table_rows;
  if (largest != null && largest > 0 && read.row_count > FAN_OUT_FACTOR * largest) {
    return (
      `sql_reads[${read.index}] returned ${read.row_count} rows from a JOIN whose largest table holds about ${Math.round(largest)}: ` +
      "the join is probably matching one row to many. Check the join keys before trusting any count or sum built on it."
    );
  }
  const ids = read.rows.map((r) => r.id).filter((v) => v !== undefined && v !== null);
  if (ids.length > 1 && new Set(ids.map(String)).size < ids.length) {
    return (
      `sql_reads[${read.index}] is a JOIN whose \`id\` column repeats: one row matched many. ` +
      "Check the join keys before trusting any count or sum built on it."
    );
  }
  return null;
}

function stripSecretColumns(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  if (rows.length === 0) return rows;
  const secretCols = Object.keys(rows[0]).filter((c) => isSecretField(c));
  if (secretCols.length === 0) return rows;
  return rows.map((r) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) if (!secretCols.includes(k)) out[k] = v;
    return out;
  });
}

export type SqlLineage = { mode: "clean" } | { mode: "columns"; outputs: string[] } | { mode: "all"; reason: string };

type Clause = "none" | "with" | "select" | "from" | "fromexpr" | "filter";
type Frame = { id: number; clause: Clause; hasSelect: boolean; item: number | null; filterOnly: boolean };

const FILTER_CLAUSES = new Set(["ON", "USING", "WHERE", "GROUP", "HAVING", "ORDER", "LIMIT", "OFFSET", "FETCH", "WINDOW"]);
const PREDICATE_SUBQUERY = new Set(["IN", "EXISTS", "ANY", "SOME", "ALL", "=", "<>", "!=", "<", ">", "<=", ">="]);
const TOUCHES_JSON = /->|#>|json|\[\s*'/i;
const JSON_BUILDER = /\bjsonb?_(?:build_object|build_array|object|array|object_agg|agg|arrayagg|objectagg)\s*\(/gi;
const LITERAL = /'(?:[^']|'')*'/g;

function jsonKeyLiterals(sql: string): string[] {
  if (!TOUCHES_JSON.test(sql)) return [];
  const builderArg = new Set<number>();
  for (const m of sql.matchAll(JSON_BUILDER)) {
    let depth = 1;
    let i = m.index! + m[0].length;
    while (i < sql.length && depth > 0) {
      if (sql[i] === "'") {
        LITERAL.lastIndex = i;
        const lit = LITERAL.exec(sql);
        if (!lit || lit.index !== i) break;
        const before = sql.slice(0, i).trimEnd();
        const after = sql.slice(i + lit[0].length).trimStart();
        if (depth === 1 && /[(,]$/.test(before) && after.startsWith(",")) builderArg.add(i);
        i += lit[0].length;
        continue;
      }
      if (sql[i] === "(") depth++;
      else if (sql[i] === ")") depth--;
      i++;
    }
  }
  return [...sql.matchAll(/'(?:[^']|'')*'/g)].filter((m) => !builderArg.has(m.index!)).map((m) => m[0]);
}

export function classifySqlLineage(sql: string, dialect: "postgres" | "mysql"): SqlLineage {
  const { tokens, unsafe } = lexSql(sql, dialect);
  if (unsafe) return { mode: "all", reason: "unreadable" };

  for (const lit of jsonKeyLiterals(sql)) {
    if (lit.slice(1, -1).split(/[^A-Za-z0-9_]+/).some((seg) => seg && isSensitiveName(seg))) {
      return { mode: "all", reason: "json key" };
    }
  }

  const kw = (i: number, ...v: string[]) => tokens[i]?.kind === "keyword" && v.includes(tokens[i]!.value);
  const punct = (i: number, v: string) => tokens[i]?.kind === "punct" && tokens[i]!.value === v;

  const at: { clause: Clause; item: number | null; filterOnly: boolean }[] = [];
  const items: number[][] = [];
  const itemFrame: number[] = [];
  const setOp = new Set<number>();
  const relations = new Set<string>();
  const aliasLists: { onTable: boolean }[] = [];
  let columnStar = false;
  let nextId = 0;
  let distinctOn = false;
  const stack: Frame[] = [{ id: nextId++, clause: "none", hasSelect: false, item: null, filterOnly: false }];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const f = stack[stack.length - 1]!;
    const onOfDistinct = kw(i, "ON") && kw(i - 1, "DISTINCT") && f.clause === "select";
    if (onOfDistinct) distinctOn = true;
    else if (t.kind === "keyword") {
      const v = t.value;
      if (v === "SELECT") {
        f.hasSelect = true;
        f.clause = "select";
        f.item = items.push([]) - 1;
        itemFrame.push(f.id);
      } else if ((v === "FROM" || v === "JOIN") && f.hasSelect) f.clause = "from";
      else if (FILTER_CLAUSES.has(v) && (f.hasSelect || v === "WHERE" || v === "ORDER")) f.clause = "filter";
      else if (v === "PARTITION" && !f.hasSelect) f.clause = "filter";
      else if (v === "UNION" || v === "INTERSECT" || v === "EXCEPT") {
        setOp.add(f.id);
        f.clause = "none";
      } else if (v === "WITH") f.clause = "with";
      if (f.clause !== "select") f.item = null;
    }
    at.push({ clause: f.clause, item: f.item, filterOnly: f.filterOnly });
    const openDistinctOn = distinctOn && punct(i, "(");
    if (f.item !== null && !kw(i, "SELECT") && !onOfDistinct && !openDistinctOn) items[f.item]!.push(i);
    if (t.kind === "punct" && t.value === "(") {
      distinctOn = false;
      if (openDistinctOn) {
        stack.push({ id: nextId++, clause: "filter", hasSelect: false, item: null, filterOnly: true });
        continue;
      }
      const inherit: Clause = f.clause === "from" ? "fromexpr" : f.clause;
      const predicate = f.clause === "filter" && PREDICATE_SUBQUERY.has(tokens[i - 1]?.value.toUpperCase() ?? "");
      stack.push({ id: nextId++, clause: inherit, hasSelect: false, item: f.item, filterOnly: f.filterOnly || predicate });
      continue;
    }
    if (t.kind === "punct" && t.value === ")") {
      if (stack.length > 1) stack.pop();
      continue;
    }
    if (t.kind === "punct" && t.value === "," && f.clause === "select" && f.hasSelect) {
      items[f.item!]!.pop();
      f.item = items.push([]) - 1;
      itemFrame.push(f.id);
      continue;
    }
    if (t.kind === "punct" && t.value === "*") {
      const isColumn = punct(i - 1, ".") || punct(i - 1, "(") || punct(i - 1, ",") || kw(i - 1, "SELECT", "DISTINCT", "ALL");
      const countStar = punct(i - 1, "(") && tokens[i - 2]?.kind === "ident" && tokens[i - 2]!.value.toLowerCase() === "count";
      if (isColumn && !countStar) columnStar = true;
    }
    if (t.kind !== "ident") continue;
    if (f.clause === "from" && t.next !== ".") {
      if (t.next === "(") {
        const p = kw(i - 1, "AS") ? i - 2 : i - 1;
        if (!(kw(p, "FROM", "JOIN", "LATERAL") || punct(p, ","))) aliasLists.push({ onTable: tokens[p]?.kind === "ident" });
      } else relations.add(t.value.toLowerCase());
    }
    if (f.clause === "with" && (kw(i + 1, "AS") || t.next === "(")) {
      relations.add(t.value.toLowerCase());
      if (t.next === "(") aliasLists.push({ onTable: false });
    }
  }

  const all = (reason: string): SqlLineage => ({ mode: "all", reason });
  if (aliasLists.some((a) => a.onTable || columnStar)) return all("column alias list");

  const plainItem = (item: number): { col: number; alias: number | null } | null => {
    const idx = items[item]!.filter((j, k) => !(k === 0 && kw(j, "DISTINCT", "ALL")));
    let n = 0;
    if (tokens[idx[n]!]?.kind !== "ident") return null;
    let col = idx[n]!;
    n++;
    for (let dots = 0; dots < 2 && punct(idx[n]!, "."); dots++) {
      if (tokens[idx[n + 1]!]?.kind !== "ident") return null;
      col = idx[n + 1]!;
      n += 2;
    }
    if (kw(idx[n]!, "AS")) n++;
    let alias: number | null = null;
    if (n < idx.length && tokens[idx[n]!]?.kind === "ident") alias = idx[n++]!;
    return n === idx.length ? { col, alias } : null;
  };
  const plainStar = (item: number): boolean => {
    const idx = items[item]!.filter((j, k) => !(k === 0 && kw(j, "DISTINCT", "ALL")));
    if (!punct(idx[idx.length - 1]!, "*")) return false;
    for (let k = 0; k < idx.length - 1; k += 2) {
      if (tokens[idx[k]!]?.kind !== "ident" || !punct(idx[k + 1]!, ".")) return false;
    }
    return true;
  };

  const outputs: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const { clause, item, filterOnly } = at[i]!;
    if (filterOnly || (clause !== "select" && clause !== "fromexpr")) continue;
    if (punct(i, "*")) {
      const isColumn = punct(i - 1, ".") || punct(i - 1, "(") || punct(i - 1, ",") || kw(i - 1, "SELECT", "DISTINCT", "ALL");
      if (!isColumn) continue;
      const countStar = punct(i - 1, "(") && tokens[i - 2]?.kind === "ident" && tokens[i - 2]!.value.toLowerCase() === "count";
      if (countStar) continue;
      if (item !== null && plainStar(item) && !setOp.has(itemFrame[item]!)) continue;
      return all("whole row in an expression");
    }
    if (t.kind !== "ident") continue;
    if (t.next === "." || t.next === "(") continue;
    if (kw(i - 1, "AS") || punct(i - 1, "::")) continue;
    const plain = item !== null ? plainItem(item) : null;
    if (plain && plain.alias === i) continue;
    const name = t.value;
    if (!punct(i - 1, ".") && relations.has(name.toLowerCase())) return all("whole row as a value");
    if (!isSensitiveName(name)) continue;
    let start = i;
    while (punct(start - 1, ".") && tokens[start - 2]?.kind === "ident") start -= 2;
    const open = kw(start - 1, "DISTINCT") ? start - 2 : start - 1;
    if (punct(open, "(") && tokens[open - 1]?.value.toLowerCase() === "count" && punct(i + 1, ")")) continue;
    if (kw(i + 1, "IS") && (kw(i + 2, "NULL") || (kw(i + 2, "NOT") && kw(i + 3, "NULL")))) continue;
    if (plain && plain.col === i && itemFrame[item!] === 0 && !setOp.has(0)) {
      outputs.push(tokens[plain.alias ?? plain.col]!.value.toLowerCase());
      continue;
    }
    return all(`sensitive column ${clause === "select" ? "in an expression or nested select" : "in FROM"}`);
  }
  return outputs.length ? { mode: "columns", outputs } : { mode: "clean" };
}

export function applySqlLineage(rows: Record<string, unknown>[], lineage: SqlLineage): Record<string, unknown>[] {
  if (lineage.mode === "clean" || rows.length === 0) return rows;
  if (lineage.mode === "all") return rows.map((r) => maskTaintedValue(r) as Record<string, unknown>);
  const masked = new Set(lineage.outputs);
  return rows.map((r) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) out[k] = masked.has(k.toLowerCase()) && v !== null ? "‹redacted›" : v;
    return out;
  });
}

export function toReadResult(index: number, fetched: Record<string, unknown>[]): CodeActReadResult {
  const truncated = fetched.length > MAX_ROWS_PER_READ;
  const rows = stripSecretColumns(truncated ? fetched.slice(0, MAX_ROWS_PER_READ) : fetched);
  return { index, row_count: rows.length, row_count_exact: !truncated, truncated, rows };
}

export function stripTrailingSemicolon(sql: string): string {
  return sql.replace(/;\s*$/, "");
}

const MYSQL_QUERY_ERRNOS = new Set([1054, 1146, 1064, 1052, 1109, 1247]);

const PG_QUERY_SQLSTATES = new Set([
  "42601",
  "42703",
  "42P01",
  "42P02",
  "42702",
  "42P08",
  "42P09",
  "42712",
  "42725",
  "42883",
  "42804",
  "42846",
  "42P10",
  "42803",
]);

const PG_IDENTIFIER_MESSAGE = new Set([
  "42703", "42P01", "42P02", "42702", "42P08", "42P09",
  "42712", "42725", "42883", "42804", "42846", "42P10", "42803",
]);
const MYSQL_IDENTIFIER_MESSAGE = new Set([1054, 1146, 1052, 1109, 1247]);

export function describeSqlError(e: unknown): string {
  const code = (e as { code?: unknown }).code;
  const errno = (e as { errno?: unknown }).errno;
  const msg = (e as { message?: unknown }).message;
  const identifierShaped =
    (typeof code === "string" && PG_IDENTIFIER_MESSAGE.has(code.toUpperCase())) ||
    (typeof errno === "number" && MYSQL_IDENTIFIER_MESSAGE.has(errno));
  if (identifierShaped && typeof msg === "string") return msg;

  const position = (e as { position?: unknown }).position;
  const at = typeof position === "string" || typeof position === "number" ? ` at position ${position}` : "";
  const which = typeof code === "string" ? `SQLSTATE ${code}` : typeof errno === "number" ? `error ${errno}` : "an error";
  return `the database rejected the statement as malformed${at} (${which}). The message is withheld because a syntax error quotes the query text back, which can contain customer data.`;
}

export function isAgentFixableSqlError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const code = (e as { code?: unknown }).code;
  if (typeof code === "string" && PG_QUERY_SQLSTATES.has(code.toUpperCase())) return true;
  const errno = (e as { errno?: unknown }).errno;
  return typeof errno === "number" && MYSQL_QUERY_ERRNOS.has(errno);
}

export function rethrowAsRecoverable(e: unknown, index: number): never {
  if (isAgentFixableSqlError(e)) {
    throw new ExpectedToolError(
      "codeact_sql_error",
      `sql_reads[${index}] was rejected by the database. Check the column and table names against ` +
        `operator_db__catalog and call the tool again with the corrected query; see meta.db_message.`,
      { read_index: index, db_message: describeSqlError(e) },
    );
  }
  throw e;
}

export async function runCodeActReads(
  session: ReadSession,
  sqlReads: string[],
  opts: CodeActReadOptions = {},
): Promise<CodeActReadResult[]> {
  const dialect = session.dialect;
  if (dialect !== "postgres" && dialect !== "mysql") {
    throw new ExpectedToolError(
      "codeact_sql_unsupported_dialect",
      `CodeAct read+compute supports postgres and mysql operator DBs. This tenant's DB is "${dialect}".`,
    );
  }
  assertReadOnlyReads(sqlReads, dialect);
  const out: CodeActReadResult[] = [];
  for (let i = 0; i < sqlReads.length; i++) {
    let r: Awaited<ReturnType<ReadSession["query"]>>;
    try {
      r = await session.query(sqlReads[i], [], { maxRows: MAX_ROWS_PER_READ });
    } catch (e) {
      if (e instanceof ExpectedToolError) throw e;
      rethrowAsRecoverable(e, i);
    }
    const lineage: SqlLineage = opts.trustedSql ? { mode: "clean" } : classifySqlLineage(sqlReads[i]!, dialect);
    const rows = applySqlLineage(stripSecretColumns(r.rows), lineage);
    const tz = session.sessionTimeZone();
    out.push({
      index: i,
      row_count: rows.length,
      row_count_exact: !r.truncated,
      truncated: r.truncated,
      rows,
      ...(lineage.mode === "columns" ? { masked: "columns" as const } : lineage.mode === "all" ? { masked: "strings" as const } : {}),
      ...(tz ? { session_tz: tz } : {}),
    });
  }
  if (dialect === "postgres") {
    for (const read of out) {
      const names = joinedTableNames(sqlReads[read.index]);
      if (names.length === 0) continue;
      read.largest_table_rows = await session.largestTableRows(names).catch(() => null);
    }
  }
  return out;
}
