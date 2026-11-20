import { EJSON, type Document } from "bson";
import {
  ConnectorOp,
  MAX_SKIP,
  checkReadOnly,
  compileSummary,
  mysqlPlaceholderProblem,
  guardMongoAggregate,
  guardMongoCount,
  guardMongoFind,
  guardSql,
  mongoResultStripper,
  policyFromRules,
  type CatalogLike,
  type CompiledSummary,
  type Policy,
  type StructuredOutput,
} from "@zavi/shared/db-guard";
import { DEFAULT_STATEMENT_MS } from "./config";
import type { Dialect, Introspection } from "./db/types";
import type { RulesState, WhatCanLeave } from "./rules";

export const TOTALS_ONLY_REFUSAL = "Only totals are allowed by your rules. Zavi must use a summary request.";
export const MONGO_MAX_TIME_MS = 5_000;

type MongoAction = Extract<ConnectorOp, { op: "mongo" }>["action"];

export type Checked =
  | { ok: true; kind: "describe"; policy: Policy | null }
  | {
      ok: true;
      kind: "sql";
      rule: WhatCanLeave;
      text: string;
      params: (string | number | boolean | null)[];
      maxRows: number;
      timeoutMs: number;
      timeZone?: string;
      utcOffset?: boolean;
      tables: string[];
      hidden: string[];
      policy: Policy;
      passthrough: string[];
      structured: StructuredOutput[];
    }
  | {
      ok: true;
      kind: "mongo";
      rule: WhatCanLeave;
      action: MongoAction;
      collection: string;
      filter: Document;
      options: Document;
      pipeline: Document[];
      maxRows: number;
      maxTimeMS: number;
      hidden: string[];
      strip: <T>(doc: T) => T;
      policy: Policy;
    }
  | { ok: true; kind: "summary"; rule: WhatCanLeave; compiled: CompiledSummary; limit: number; timeoutMs: number; policy: Policy; table: string }
  | { ok: false; status: "refused" | "failed"; reason: string; summary: string };

export type CheckContext = {
  rules: RulesState;
  dialect: Dialect | null;
  database: string | null;
  catalog: Introspection | null;
  maxStatementMs: number;
};

export function catalogLike(intro: Introspection): CatalogLike {
  return {
    tables: intro.tables.map((t) => ({
      name: t.name,
      columns: t.columns.map((c) => ({
        name: c.name,
        type: c.type,
        ...(c.json_keys && c.json_keys.length > 0 ? { json_keys: c.json_keys } : {}),
        ...(c.json_sampled ? { json_sampled: c.json_sampled } : {}),
        ...(c.json_map_like ? { json_map_like: true } : {}),
      })),
      ...(t.view_of ? { view_of: t.view_of } : {}),
      ...(t.partitioned ? { partitioned: true, partitions: t.partitions ?? [] } : {}),
      ...(t.parents && t.parents.length > 0 ? { parents: t.parents } : {}),
    })),
  };
}

export function describeOp(op: unknown): string {
  const p = ConnectorOp.safeParse(op);
  if (!p.success) return "(a request this connector does not understand)";
  const o = p.data;
  if (o.op === "sql") return o.text;
  if (o.op === "describe") return "describe: table and column names (no values)";
  if (o.op === "summary") return `summary ${JSON.stringify(o.request)}`;
  const body = o.action === "aggregate" ? o.pipeline : o.filter;
  return `${o.action} ${o.collection ?? ""} ${body === undefined ? "" : JSON.stringify(body)}`.trim();
}

export function connectorWording(reason: string): string {
  return reason
    .replace(/ is hidden in What Zavi can see\./g, " is blocked by this connector's rules.")
    .replace(/ is not a (table|collection|field) Zavi may read\./g, " is not a $1 this connector allows.")
    .replace(/ Use one of the (tables|collections) listed by operator_db__catalog\./g, " Use the $1 this connector allows (operator_db__catalog lists them).")
    .replace(/Zavi's database guard/g, "the connector's guard")
    .replace(/ is partitioned and one of its partitions is not readable, so /g, " is partitioned and one of its partitions is not allowed by this connector's rules, so ")
    .replace(/ is partitioned and one of its partitions hides more fields, so /g, " is partitioned and one of its partitions blocks more fields, so ");
}

const refused = (reason: string, summary: string): Checked => ({ ok: false, status: "refused", reason: connectorWording(reason), summary });
const failed = (reason: string, summary: string): Checked => ({ ok: false, status: "failed", reason, summary });

const PROJECTION_VALUE = (v: unknown) => v === 0 || v === 1 || v === true || v === false;
const SORT_VALUE = (v: unknown) => v === 1 || v === -1;
const FIND_OPTIONS = new Set(["projection", "sort", "limit", "skip", "maxTimeMS", "hint"]);

function findOptionsProblem(options: Document): string | null {
  for (const k of Object.keys(options)) if (!FIND_OPTIONS.has(k)) return `The find option "${k}" is not supported by the connector.`;
  const plain = (v: unknown) => v !== null && typeof v === "object" && !Array.isArray(v);
  if (options.projection !== undefined && (!plain(options.projection) || !Object.values(options.projection as Document).every(PROJECTION_VALUE))) {
    return "Projections must list fields with 0 or 1.";
  }
  if (options.sort !== undefined && (!plain(options.sort) || !Object.values(options.sort as Document).every(SORT_VALUE))) return "Sorts must list fields with 1 or -1.";
  if (options.hint !== undefined && typeof options.hint !== "string" && (!plain(options.hint) || !Object.values(options.hint as Document).every(SORT_VALUE))) {
    return "A hint must be an index name or fields with 1 or -1.";
  }
  for (const k of ["limit", "skip", "maxTimeMS"] as const) {
    const v = options[k];
    if (v !== undefined && (typeof v !== "number" || !Number.isInteger(v) || v < 0)) return `${k} must be a whole number.`;
  }
  if (typeof options.skip === "number" && options.skip > MAX_SKIP) return `skip may be at most ${MAX_SKIP}.`;
  return null;
}

function fromEjson<T>(v: unknown): T | { error: string } {
  if (v === undefined) return v as T;
  try {
    return EJSON.deserialize(v as Document, { relaxed: true }) as T;
  } catch {
    return { error: "Zavi sent a value this connector cannot read." };
  }
}
const isErr = (v: unknown): v is { error: string } => !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1 && typeof (v as { error?: unknown }).error === "string";

export function checkRequest(raw: unknown, ctx: CheckContext): Checked {
  const parsed = ConnectorOp.safeParse(raw);
  const summary = describeOp(raw);
  if (!parsed.success) return refused("Zavi sent a request this connector does not understand. Update the connector or Zavi.", summary);
  const op = parsed.data;

  if (ctx.rules.status === "invalid") return refused("rules.yaml on this connector is invalid, so every request is refused until it is fixed on the connector's local page.", summary);
  if (!ctx.dialect) return failed("No database is added on this connector yet. Add one on the connector's local page (http://localhost:7801).", summary);
  if (!ctx.catalog) return failed("The connector could not read its database's structure.", summary);

  const policy = policyFromRules(ctx.rules.rules, catalogLike(ctx.catalog), ctx.dialect);
  if (op.op === "describe") return { ok: true, kind: "describe", policy };

  const rule = ctx.rules.rules.what_can_leave;
  const cap = Math.max(1, Math.min(ctx.rules.rules.max_rows, 1000));
  const timeoutFor = (asked?: number) => Math.max(100, Math.min(asked ?? DEFAULT_STATEMENT_MS, ctx.maxStatementMs));

  if (policy.allowed.size === 0) {
    return refused(
      ctx.rules.status === "missing" ? "No tables are allowed yet. The connector's owner has not saved rules on its local page." : "No tables are allowed by this connector's rules.",
      summary,
    );
  }

  if (op.op === "summary") {
    const mode = rule === "totals_and_counts_only" ? "totals_only" : "cloud";
    const compiled = compileSummary(op.request, ctx.dialect, policy, mode, { mysqlDatabase: ctx.database });
    if ("ok" in compiled) return refused(compiled.reason, summary);
    const table = compiled.kind === "mongo" ? compiled.collection : (policy.resolve(op.request.table, true)?.name ?? op.request.table);
    return { ok: true, kind: "summary", rule, compiled, limit: Math.min(op.request.limit, cap), timeoutMs: timeoutFor(), policy, table };
  }

  if (rule === "totals_and_counts_only") return refused(TOTALS_ONLY_REFUSAL, summary);

  if (op.op === "sql") {
    if (ctx.dialect === "mongodb") return refused("This connector's database is MongoDB, so SQL reads are not available.", summary);
    const ro = checkReadOnly(op.text, ctx.dialect);
    if (!ro.ok) return refused(ro.reason, summary);
    const g = guardSql(op.text, { policy, dialect: ctx.dialect, mysqlDatabase: ctx.database });
    if (!g.ok) return refused(g.reason, summary);
    if (ctx.dialect === "mysql") {
      const problem = mysqlPlaceholderProblem(g.sql, op.params.length);
      if (problem) return refused(problem, summary);
    }
    return {
      ok: true,
      kind: "sql",
      rule,
      text: g.sql,
      params: op.params,
      maxRows: Math.min(op.max_rows, cap),
      timeoutMs: timeoutFor(op.statement_timeout_ms),
      ...(op.time_zone ? { timeZone: op.time_zone } : {}),
      ...(op.utc_offset_session ? { utcOffset: true } : {}),
      tables: g.tables,
      hidden: g.hidden,
      policy,
      passthrough: g.passthrough,
      structured: g.structured,
    };
  }

  if (ctx.dialect !== "mongodb") return refused(`This connector's database is ${ctx.dialect === "postgres" ? "PostgreSQL" : "MySQL"}, so MongoDB reads are not available.`, summary);
  const filter = fromEjson<Document>(op.filter ?? {});
  const options = fromEjson<Document>(op.options ?? {});
  const pipeline = fromEjson<Document[]>(op.pipeline ?? []);
  for (const v of [filter, options, pipeline]) if (isErr(v)) return refused(v.error, summary);
  const f = filter as Document;
  const o = options as Document;
  const maxRows = Math.min(op.max_rows, cap);
  const maxTimeMS = Math.max(100, Math.min(typeof o.maxTimeMS === "number" ? o.maxTimeMS : MONGO_MAX_TIME_MS, ctx.maxStatementMs));
  const base = { ok: true as const, kind: "mongo" as const, rule, action: op.action, maxRows, maxTimeMS, policy };

  if (op.action === "listCollections") {
    return { ...base, collection: "", filter: {}, options: {}, pipeline: [], hidden: [], strip: <T>(d: T) => d };
  }
  const coll = op.collection ?? "";
  if (op.action === "find" || op.action === "findOne") {
    const problem = findOptionsProblem(o);
    if (problem) return refused(problem, summary);
    const g = guardMongoFind(coll, f, o, { policy });
    if (!g.ok) return refused(g.reason, summary);
    return { ...base, maxRows: op.action === "findOne" ? 1 : maxRows, collection: g.collection, filter: g.filter, options: g.options, pipeline: [], hidden: g.hidden, strip: mongoResultStripper(policy, g.touched) };
  }
  if (op.action === "aggregate") {
    const g = guardMongoAggregate(coll, pipeline, { policy });
    if (!g.ok) return refused(g.reason, summary);
    return { ...base, collection: g.collection, filter: {}, options: o.allowDiskUse === true ? { allowDiskUse: true } : {}, pipeline: g.pipeline, hidden: g.hidden, strip: mongoResultStripper(policy, g.touched) };
  }
  if (op.action === "countDocuments") {
    const extra = Object.keys(o).filter((k) => k !== "limit" && k !== "maxTimeMS");
    if (extra.length) return refused(`The count option "${extra[0]}" is not supported by the connector.`, summary);
    if (o.limit !== undefined && (typeof o.limit !== "number" || !Number.isInteger(o.limit) || o.limit < 0)) return refused("limit must be a whole number.", summary);
    const g = guardMongoCount(coll, f, { policy });
    if (!g.ok) return refused(g.reason, summary);
    return { ...base, collection: g.collection, filter: g.filter, options: o.limit !== undefined ? { limit: o.limit } : {}, pipeline: [], hidden: [], strip: <T>(d: T) => d };
  }
  const t = policy.resolve(coll, true);
  if (!t) return refused(`${coll} is not a collection this connector allows.`, summary);
  return { ...base, collection: t.name, filter: {}, options: {}, pipeline: [], hidden: [], strip: <T>(d: T) => d };
}

export const ZAVI_FIELD_BLOCKED = "The query uses a field blocked by your connector's rules.";
export const ZAVI_TABLE_NOT_ALLOWED = "The query reads a table your connector doesn't allow.";
export const ZAVI_DB_ERROR = "The database returned an error.";

export type ReasonScope = { deniedNames: string[]; blockedFields: string[] };

export function reasonScope(rules: RulesState, catalog: Introspection | null, dialect: Dialect | null): ReasonScope {
  const blockedFields = rules.rules.blocked.flatMap((ref) => {
    const dot = ref.lastIndexOf(".");
    return dot > 0 ? [ref, ref.slice(dot + 1)] : [ref];
  });
  if (!catalog || !dialect) return { deniedNames: [], blockedFields };
  const policy = policyFromRules(rules.rules, catalogLike(catalog), dialect);
  const names = new Set<string>();
  for (const t of catalog.tables) {
    if (!policy.isAllowed(t.name, true)) names.add(t.name);
    for (const p of t.partitions ?? []) if (!policy.isAllowed(p, true)) names.add(p);
  }
  return { deniedNames: [...names], blockedFields };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function mentions(reason: string, name: string): boolean {
  if (!name) return false;
  return new RegExp(`(^|[^A-Za-z0-9_$])${escapeRe(name)}($|[^A-Za-z0-9_$])`, "i").test(reason);
}

const FIELD_REASON = /is blocked by this connector's rules|is hidden in What Zavi can see|is not a field (this connector allows|Zavi knows)|blocks more fields/;
const TABLE_REASON = /is not a (table|collection) (this connector allows|Zavi may read)|which is not a table or alias/;

export function reasonForZavi(reason: string, scope: ReasonScope): string {
  if (FIELD_REASON.test(reason)) return ZAVI_FIELD_BLOCKED;
  if (TABLE_REASON.test(reason)) return ZAVI_TABLE_NOT_ALLOWED;
  if (scope.deniedNames.some((n) => mentions(reason, n))) return ZAVI_TABLE_NOT_ALLOWED;
  if (scope.blockedFields.some((f) => mentions(reason, f))) return ZAVI_FIELD_BLOCKED;
  return reason;
}
