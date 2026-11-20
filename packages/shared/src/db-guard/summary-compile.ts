import type { Policy, CatalogTable } from "./policy";
import type { Refusal, Dialect } from "./types";
import { isSensitiveField } from "./sensitive";
import { sourceFor } from "./sql-guard";
import { structuredClass } from "./pg-structured";
import { MIN_GROUP_SIZE, MAX_IN_VALUES, type SummaryRequest, type SummaryMode } from "./summary-ir";

const refuse = (reason: string, rule?: "settings"): Refusal => ({ ok: false, reason, refused_by: "zavi", ...(rule ? { rule } : {}) });

export type FieldKind = "number" | "date" | "other";

export function fieldKind(type: string | undefined): FieldKind {
  const t = (type ?? "").toLowerCase();
  if (/^(enum|composite|user-defined)\b/.test(t)) return "other";
  if (/(^|[^a-z])(int|integer|bigint|smallint|tinyint|mediumint|numeric|decimal|real|double|float|money|number|long)([^a-z]|$)/.test(t) || /^(int\d|float\d|serial|bigserial)/.test(t)) {
    return "number";
  }
  if (/(date|timestamp|datetime)/.test(t)) return "date";
  return "other";
}

export function isStructuredField(column: { type?: string; json_sampled?: unknown; json_keys?: unknown }): boolean {
  if (column.json_sampled !== undefined || column.json_keys !== undefined) return true;
  if (structuredClass(column.type) !== null) return true;
  return (column.type ?? "")
    .toLowerCase()
    .split("|")
    .map((t) => t.trim())
    .some((t) => /^(json|jsonb|document|object|array|hstore)$/.test(t) || t.endsWith("[]"));
}

export type CheckedSummary = { ok: true; table: CatalogTable; columns: Map<string, { name: string; kind: FieldKind }> };

const ID_LIKE = /(^|[^a-z])(id|uuid|guid|pk|slug|handle|username|token|hash|serial|external.?ref|reference|url|code)$|^_id$|[a-z]Id$|_id$|_uuid$|_key$/i;
const FREE_TEXT = /(note|description|body|message|comment|content|text|bio|summary|title|reason|subject|details|feedback|review|caption|query)s?$/i;

function groupable(table: string, field: string): string | null {
  if (isSensitiveField(table, field)) return "it looks like personal data";
  if (ID_LIKE.test(field)) return "it looks like an identifier";
  if (FREE_TEXT.test(field)) return "it looks like free text";
  return null;
}

function wholeDay(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(v);
  if (!m || Number.isNaN(Date.parse(m[1]!))) return null;
  return m[1]!;
}

export function checkSummary(req: SummaryRequest, policy: Policy, mode: SummaryMode = "cloud"): CheckedSummary | Refusal {
  const table = policy.resolve(req.table, true);
  if (!table) return refuse(`${req.table} is not a table Zavi may read. Use one of the tables listed by operator_db__catalog.`, "settings");
  const columns = new Map<string, { name: string; kind: FieldKind }>();
  const col = (field: string): { name: string; kind: FieldKind } | Refusal => {
    const c = table.columns.find((x) => x.name === field);
    if (!c) return refuse(`${table.name}.${field} is not a field Zavi knows. Use the field names listed by operator_db__catalog.`);
    if (policy.isHidden(table.name, c.name)) return refuse(`${table.name}.${c.name} is hidden in What Zavi can see.`, "settings");
    if (isSensitiveField(table.name, c.name)) return refuse(`Zavi does not summarize ${table.name}.${c.name}: it looks like personal data.`);
    if (isStructuredField(c)) return refuse(`Zavi does not summarize ${table.name}.${c.name}: it holds JSON or other structured values. Use a plain column.`);
    const v = { name: c.name, kind: fieldKind(c.type) };
    columns.set(c.name, v);
    return v;
  };
  for (const m of req.measures) {
    if (m.fn === "count") continue;
    if (mode === "totals_only" && (m.fn === "min" || m.fn === "max")) {
      return refuse(`${m.fn} is not available with "Totals and counts only": it returns one record's exact value. Use count, sum or avg.`, "settings");
    }
    const c = col(m.field);
    if ("ok" in c) return c;
    if ((m.fn === "sum" || m.fn === "avg") && c.kind !== "number") return refuse(`${m.fn} needs a numeric field; ${table.name}.${c.name} is not numeric.`);
    if ((m.fn === "min" || m.fn === "max") && c.kind === "other") return refuse(`${m.fn} needs a numeric or date field; ${table.name}.${c.name} is neither.`);
  }
  for (const g of req.group_by) {
    const c = col(g.field);
    if ("ok" in c) return c;
    const why = groupable(table.name, c.name);
    if (why) return refuse(`Zavi does not group by ${table.name}.${c.name}: ${why}.`);
    if (g.bucket && c.kind !== "date") return refuse(`A ${g.bucket} bucket needs a date field; ${table.name}.${c.name} is not a date.`);
    if (!g.bucket && c.kind === "date") return refuse(`Group ${table.name}.${c.name} by day, week or month.`);
  }
  for (const f of req.filters) {
    const c = col(f.field);
    if ("ok" in c) return c;
    const why = groupable(table.name, c.name);
    if (why) return refuse(`Zavi does not filter on ${table.name}.${c.name}: ${why}.`);
    if (f.op === "is_null") {
      if (f.value !== undefined) return refuse(`is_null takes no value.`);
      continue;
    }
    if (f.op === "in") {
      if (!Array.isArray(f.value) || f.value.length === 0 || f.value.length > MAX_IN_VALUES) return refuse(`"in" needs a list of 1 to ${MAX_IN_VALUES} values.`);
      if (c.kind === "date" && f.value.some((v) => wholeDay(v) === null)) return refuse(`Dates in a filter must be whole days (YYYY-MM-DD).`);
      continue;
    }
    if (f.value === undefined || Array.isArray(f.value)) return refuse(`${f.op} needs one value.`);
    if (f.op !== "eq" && c.kind === "other") return refuse(`Ranges (${f.op}) only work on numeric or date fields.`);
    if (c.kind === "date" && wholeDay(f.value) === null) return refuse(`Dates in a filter must be whole days (YYYY-MM-DD).`);
  }
  return { ok: true, table, columns };
}

export function suppressSmallGroups<R extends Record<string, unknown>>(rows: R[]): R[] {
  return rows.filter((r) => {
    const n = typeof r.__n === "string" ? Number(r.__n) : r.__n;
    return typeof n === "number" && Number.isFinite(n) && n >= MIN_GROUP_SIZE;
  });
}

export type CompiledSummary =
  | { kind: "sql"; text: string; params: (string | number | boolean)[] }
  | { kind: "mongo"; collection: string; pipeline: Record<string, unknown>[] };

const measureAlias = (m: SummaryRequest["measures"][number]) => (m.fn === "count" ? "count" : `${m.fn}_${m.field.replace(/\./g, "_")}`);
const groupAlias = (g: SummaryRequest["group_by"][number]) => (g.bucket ? `${g.field.replace(/\./g, "_")}_${g.bucket}` : g.field.replace(/\./g, "_"));

export function compileSummary(
  req: SummaryRequest,
  dialect: Dialect,
  policy: Policy,
  mode: SummaryMode = "cloud",
  opts: { mysqlDatabase?: string | null } = {},
): CompiledSummary | Refusal {
  const checked = checkSummary(req, policy, mode);
  if (!checked.ok) return checked;
  if (dialect === "dynamodb") return refuse("Summaries are not available for DynamoDB.");
  const table = checked.table.name;
  const norm: SummaryRequest = {
    ...req,
    filters: req.filters.map((f) => {
      if (checked.columns.get(f.field)?.kind !== "date") return f;
      if (Array.isArray(f.value)) return { ...f, value: f.value.map((v) => wholeDay(v)!) };
      return f.value === undefined ? f : { ...f, value: wholeDay(f.value)! };
    }),
  };
  if (dialect === "mongodb") return compileMongo(norm, table, checked.columns);
  const from = sourceFor(table, policy, dialect, opts.mysqlDatabase ?? null);
  if (typeof from !== "string") return from;
  return compileSql(norm, dialect, from);
}

function compileSql(req: SummaryRequest, dialect: "postgres" | "mysql", from: string): CompiledSummary {
  const q = (n: string) => (dialect === "mysql" ? "`" + n.replace(/`/g, "``") + "`" : '"' + n.replace(/"/g, '""') + '"');
  const params: (string | number | boolean)[] = [];
  const p = (v: string | number | boolean) => {
    params.push(v);
    return dialect === "postgres" ? `$${params.length}` : "?";
  };
  const bucket = (field: string, b: "day" | "week" | "month") => {
    if (dialect === "postgres") return `date_trunc('${b}', ${q(field)})`;
    if (b === "day") return `DATE(${q(field)})`;
    if (b === "week") return `DATE(DATE_SUB(${q(field)}, INTERVAL WEEKDAY(${q(field)}) DAY))`;
    return `DATE_FORMAT(${q(field)}, '%Y-%m-01')`;
  };
  const groups = req.group_by.map((g) => ({ expr: g.bucket ? bucket(g.field, g.bucket) : q(g.field), alias: groupAlias(g) }));
  const measures = req.measures.map((m) => `${m.fn === "count" ? "count(*)" : `${m.fn}(${q(m.field)})`} AS ${q(measureAlias(m))}`);
  const where = req.filters.map((f) => {
    const c = q(f.field);
    switch (f.op) {
      case "eq": return `${c} = ${p(f.value as string)}`;
      case "gt": return `${c} > ${p(f.value as string)}`;
      case "gte": return `${c} >= ${p(f.value as string)}`;
      case "lt": return `${c} < ${p(f.value as string)}`;
      case "lte": return `${c} <= ${p(f.value as string)}`;
      case "in": return `${c} IN (${(f.value as (string | number | boolean)[]).map((v) => p(v)).join(", ")})`;
      case "is_null": return `${c} IS NULL`;
    }
  });
  const select = [...groups.map((g) => `${g.expr} AS ${q(g.alias)}`), `count(*) AS ${q("__n")}`, ...measures].join(", ");
  let text = `SELECT ${select} FROM ${from}`;
  if (where.length) text += ` WHERE ${where.join(" AND ")}`;
  if (groups.length) text += ` GROUP BY ${groups.map((g) => g.expr).join(", ")}`;
  text += ` HAVING count(*) >= ${MIN_GROUP_SIZE} ORDER BY ${q("__n")} DESC LIMIT ${req.limit}`;
  return { kind: "sql", text, params };
}

function compileMongo(req: SummaryRequest, collection: string, columns: Map<string, { name: string; kind: FieldKind }>): CompiledSummary {
  const val = (field: string, v: unknown) => (columns.get(field)?.kind === "date" && typeof v === "string" ? new Date(`${v}T00:00:00.000Z`) : v);
  const match: Record<string, unknown> = {};
  const and: Record<string, unknown>[] = [];
  for (const f of req.filters) {
    const v = Array.isArray(f.value) ? f.value.map((x) => val(f.field, x)) : val(f.field, f.value);
    const cond =
      f.op === "eq" ? v
      : f.op === "gt" ? { $gt: v }
      : f.op === "gte" ? { $gte: v }
      : f.op === "lt" ? { $lt: v }
      : f.op === "lte" ? { $lte: v }
      : f.op === "in" ? { $in: v }
      : null;
    and.push({ [f.field]: cond });
  }
  if (and.length) match.$and = and;
  const id: Record<string, unknown> = {};
  for (const g of req.group_by) {
    id[groupAlias(g)] = g.bucket ? { $dateTrunc: { date: `$${g.field}`, unit: g.bucket } } : `$${g.field}`;
  }
  const group: Record<string, unknown> = { _id: req.group_by.length ? id : null, __n: { $sum: 1 } };
  for (const m of req.measures) {
    if (m.fn === "count") group.count = { $sum: 1 };
    else group[measureAlias(m)] = { [`$${m.fn}`]: `$${m.field}` };
  }
  const pipeline: Record<string, unknown>[] = [];
  if (and.length) pipeline.push({ $match: match });
  pipeline.push({ $group: group }, { $match: { __n: { $gte: MIN_GROUP_SIZE } } }, { $sort: { __n: -1 } }, { $limit: req.limit });
  return { kind: "mongo", collection, pipeline };
}
