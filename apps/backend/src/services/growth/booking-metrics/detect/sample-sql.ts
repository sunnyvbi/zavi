
import type { CollectionSketch, FieldSketch } from "./sample-mongo";
import type { OperatorDbCatalog } from "@/services/tools/operator-db/types";

export type SqlEngine = "postgres" | "mysql";

const TXN_NAME_RE =
  /^(trips?|bookings?|orders?|reservations?|appointments?|rides?|jobs?|sales?|transactions?|invoices?|checkouts?|purchases?)$/i;

const SAMPLE_ROWS = 60;
const MAX_CANDIDATES = 3;
const MAX_FIELDS_PER_TABLE = 45;
const EXAMPLES_PER_FIELD = 4;
const MAX_STATUS_VALUES = 40;
const STMT_TIMEOUT_MS = 6000;

const SAFE_IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
function isSafeIdent(name: unknown): name is string {
  return typeof name === "string" && SAFE_IDENT.test(name);
}

const MONEY_HINT = /amount|total|price|fee|cost|payout|gmv|revenue|paid|charge|grand|net|deposit|value|sum/i;
const NUMERIC_TYPE =
  /^(?:(?:small|big|tiny|medium)?int(?:eger)?|numeric|decimal|double(?: precision)?|real|float|money|(?:small|big)?serial|number)\b/i;
const DATE_TYPE = /date|time/i;

function jsType(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (v instanceof Date) return "date";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function toNum(v: unknown): unknown {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return v;
}

function safeExample(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const t = typeof v;
  if (t === "number" || t === "boolean") return v;
  if (t === "bigint") return String(v);
  if (t === "string") return (v as string).slice(0, 40);
  if (Array.isArray(v)) return `[array:${(v as unknown[]).length}]`;
  if (t === "object") return `{obj:${Object.keys(v as object).slice(0, 6).join(",")}}`;
  return `[${t}]`;
}

function score(f: FieldSketch, statusPaths: Set<string>): number {
  let s = 0;
  if (f.types.includes("date")) s += 4;
  if (f.numeric_stats) s += 3;
  if (MONEY_HINT.test(f.path)) s += 3;
  if (statusPaths.has(f.path)) s += 2;
  return s;
}

export function buildSketch(
  collection: string,
  approx_count: number | null,
  columns: Array<{ name: string; type: string }>,
  rows: Array<Record<string, unknown>>,
): CollectionSketch {
  const typeByCol = new Map(columns.map((c) => [c.name, String(c.type || "")]));
  const colOrder = (columns.length ? columns.map((c) => c.name) : Object.keys(rows[0] ?? {})).filter(
    (n) => SAFE_IDENT.test(n),
  );

  const fields: FieldSketch[] = [];
  const status_candidates: CollectionSketch["status_candidates"] = [];

  for (const col of colOrder) {
    const sqlType = typeByCol.get(col) ?? "";
    const numericType = NUMERIC_TYPE.test(sqlType);
    const dateType = !numericType && DATE_TYPE.test(sqlType);

    const types = new Set<string>();
    if (numericType) types.add("number");
    else if (dateType) types.add("date");

    const examples: unknown[] = [];
    const nums: number[] = [];
    const strCounts = new Map<string, number>();

    for (const row of rows) {
      if (!(col in row)) continue;
      const raw = row[col];
      if (raw === null || raw === undefined) {
        types.add("null");
        continue;
      }
      const v = numericType ? toNum(raw) : raw;
      const t = jsType(v);
      types.add(t);
      if (t === "number") nums.push(v as number);
      if (examples.length < EXAMPLES_PER_FIELD) examples.push(safeExample(v));
      if (!numericType && !dateType && typeof raw === "string" && raw.length <= 40) {
        strCounts.set(raw, (strCounts.get(raw) ?? 0) + 1);
      }
    }

    const fs: FieldSketch = { path: col, types: [...types], examples };
    if (nums.length > 0) {
      const finite = nums.filter(Number.isFinite);
      if (finite.length) {
        fs.numeric_stats = {
          min: Math.min(...finite),
          max: Math.max(...finite),
          nonzero_frac: Math.round((finite.filter((n) => n > 0).length / finite.length) * 100) / 100,
        };
      }
    }
    fields.push(fs);

    if (strCounts.size > 1 && strCounts.size <= MAX_STATUS_VALUES) {
      status_candidates.push({
        path: col,
        values: [...strCounts.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count })),
      });
    }
  }

  const statusPaths = new Set(status_candidates.map((s) => s.path));
  const ranked = fields.sort((a, b) => score(b, statusPaths) - score(a, statusPaths));
  return {
    collection,
    approx_count,
    fields: ranked.slice(0, MAX_FIELDS_PER_TABLE),
    status_candidates,
  };
}

export interface SqlQueryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export type SampleOutcome = { sketches: CollectionSketch[]; skipped: string[] };

function quote(name: string, engine: SqlEngine): string {
  return engine === "mysql" ? `\`${name}\`` : `"${name}"`;
}

export function sampleSql(table: string, columns: string[], engine: SqlEngine, random: boolean): string {
  const cols = columns.map((c) => quote(c, engine)).join(", ");
  const order = random ? (engine === "mysql" ? " ORDER BY RAND()" : " ORDER BY random()") : "";
  return `SELECT ${cols} FROM ${quote(table, engine)}${order} LIMIT ${SAMPLE_ROWS}`;
}

export async function collectSketches(q: SqlQueryable, catalog: OperatorDbCatalog, engine: SqlEngine): Promise<SampleOutcome> {
  const withCounts = catalog.tables
    .filter((t) => isSafeIdent(t.name))
    .map((t) => ({ name: t.name, count: Number(t.rowEstimate) || 0, columns: t.columns }));

  const named = withCounts.filter((t) => TXN_NAME_RE.test(t.name)).map((t) => t.name);
  const bySize = [...withCounts].sort((a, b) => b.count - a.count).map((t) => t.name);
  const shortlist = [...new Set([...named, ...bySize])].slice(0, MAX_CANDIDATES);

  const sketches: CollectionSketch[] = [];
  const skipped: string[] = [];
  for (const table of shortlist) {
    const entry = withCounts.find((t) => t.name === table)!;
    const columns = entry.columns.filter((c) => SAFE_IDENT.test(c.name)).map((c) => ({ name: c.name, type: String(c.type ?? "") }));
    if (columns.length === 0) {
      skipped.push(`${table}: no visible columns`);
      continue;
    }
    const names = columns.map((c) => c.name);
    let rows: Array<Record<string, unknown>> = [];
    try {
      rows = (await q.query(sampleSql(table, names, engine, true))).rows;
    } catch (e) {
      if ((e as { code?: string })?.code === "data_access_refused") {
        skipped.push(`${table}: refused (${(e as Error).message.slice(0, 200)})`);
        continue;
      }
      try {
        rows = (await q.query(sampleSql(table, names, engine, false))).rows;
      } catch (e2) {
        skipped.push(`${table}: sample failed (${e2 instanceof Error ? e2.name : "Error"})`);
        continue;
      }
    }
    if (rows.length === 0) {
      skipped.push(`${table}: no rows`);
      continue;
    }
    sketches.push(buildSketch(table, entry.count || null, columns, rows));
  }
  return { sketches, skipped };
}

export async function sampleSqlSketches(q: SqlQueryable, catalog: OperatorDbCatalog, engine: SqlEngine): Promise<SampleOutcome> {
  return collectSketches(q, catalog, engine);
}
