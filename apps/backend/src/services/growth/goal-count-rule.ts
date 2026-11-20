
import { createHash } from "node:crypto";
import { z } from "zod";
import type { OperatorDbCatalog } from "@/services/tools/operator-db/types";

export const COUNT_DEFINITION_MAX = 400;

export type CountRule = {
  dialect: "sql" | "mongodb";
  source: "operator_db";
  collection?: string;
  pipeline?: Record<string, unknown>[];
  query?: string;
  definition: string;
  schema_hash: string;
  confirmed_at?: string | null;
  confirmed_by?: string | null;
  stale_reason?: CountFailure | null;
  stale_at?: string | null;
};

export type CountFailure =
  | "invalid_rule"
  | "not_connected"
  | "dialect_mismatch"
  | "read_only_rejected"
  | "unknown_tables"
  | "schema_changed"
  | "query_failed"
  | "not_one_number";

export type CountOutcome = { ok: true; value: number; schema_hash: string } | { ok: false; reason: CountFailure };

export const proposedCountRuleSchema = z.object({
  goal_id: z.string().uuid(),
  definition: z.string().min(3).max(COUNT_DEFINITION_MAX),
  dialect: z.enum(["sql", "mongodb"]),
  query: z.string().min(1).max(4000).optional(),
  collection: z.string().min(1).max(128).optional(),
  pipeline: z.array(z.record(z.string(), z.unknown())).min(1).max(12).optional(),
});
export type ProposedCountRule = z.infer<typeof proposedCountRuleSchema>;

const storedRuleSchema = z.object({
  dialect: z.enum(["sql", "mongodb"]),
  source: z.literal("operator_db"),
  collection: z.string().min(1).max(128).optional(),
  pipeline: z.array(z.record(z.string(), z.unknown())).min(1).max(12).optional(),
  query: z.string().min(1).max(4000).optional(),
  definition: z.string().min(1).max(COUNT_DEFINITION_MAX),
  schema_hash: z.string().min(1).max(64),
  confirmed_at: z.string().nullable().optional(),
  confirmed_by: z.string().nullable().optional(),
  stale_reason: z.string().nullable().optional(),
  stale_at: z.string().nullable().optional(),
});

export function parseCountRule(v: unknown): CountRule | null {
  const p = storedRuleSchema.safeParse(v);
  if (!p.success || !shapeOk(p.data)) return null;
  return p.data as CountRule;
}

export function confirmedRule(v: unknown): CountRule | null {
  const r = parseCountRule(v);
  return r && r.confirmed_at ? r : null;
}

function shapeOk(r: { dialect: string; query?: string; collection?: string; pipeline?: unknown[] }): boolean {
  return r.dialect === "sql" ? !!r.query && !r.collection && !r.pipeline : !!r.collection && Array.isArray(r.pipeline) && !r.query;
}

export function ruleFromProposal(p: ProposedCountRule): Omit<CountRule, "schema_hash"> | null {
  const r = {
    dialect: p.dialect,
    source: "operator_db" as const,
    definition: p.definition.trim().replace(/\s+/g, " "),
    ...(p.dialect === "sql" ? { query: p.query } : { collection: p.collection, pipeline: p.pipeline }),
  };
  return shapeOk(r) ? r : null;
}

function tokens(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean));
}

function lookupFroms(v: unknown, out: string[]): void {
  if (Array.isArray(v)) return v.forEach((x) => lookupFroms(x, out));
  if (!v || typeof v !== "object") return;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (k === "$lookup" && x && typeof x === "object" && typeof (x as { from?: unknown }).from === "string") {
      out.push((x as { from: string }).from);
    }
    lookupFroms(x, out);
  }
}

export function schemaHashFor(catalog: OperatorDbCatalog, rule: Pick<CountRule, "dialect" | "query" | "collection" | "pipeline">): string | null {
  const tables = catalog.tables ?? [];
  const text = rule.dialect === "sql" ? (rule.query ?? "") : `${rule.collection ?? ""} ${JSON.stringify(rule.pipeline ?? [])}`;
  const words = tokens(text);
  let named: typeof tables;
  if (rule.dialect === "mongodb") {
    const froms: string[] = [];
    lookupFroms(rule.pipeline ?? [], froms);
    const wanted = new Set([rule.collection ?? "", ...froms].map((n) => n.toLowerCase()));
    named = tables.filter((t) => wanted.has(t.name.toLowerCase()));
    if (named.length !== new Set([...wanted].filter(Boolean)).size) return null;
  } else {
    named = tables.filter((t) => {
      const n = t.name.toLowerCase();
      return words.has(n) || words.has(n.split(".").pop() ?? n);
    });
  }
  if (named.length === 0) return null;
  const shape = named
    .map((t) => ({
      t: t.name.toLowerCase(),
      c: t.columns
        .filter((c) => {
          const n = c.name.toLowerCase();
          return words.has(n) || (n.includes(".") && n.split(".").every((s) => words.has(s)));
        })
        .map((c) => `${c.name.toLowerCase()}:${c.type}`)
        .sort(),
    }))
    .sort((a, b) => a.t.localeCompare(b.t));
  return createHash("sha256").update(JSON.stringify(shape)).digest("hex").slice(0, 32);
}

export function oneNumber(rows: Array<Record<string, unknown>>, truncated: boolean): number | null {
  if (truncated || rows.length !== 1) return null;
  const fields = Object.entries(rows[0] ?? {}).filter(([k, v]) => !(k === "_id" && v === null));
  if (fields.length !== 1) return null;
  const v = fields[0][1];
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v.trim());
  return null;
}

export type CountCatalog = { dialect: string; catalog: OperatorDbCatalog; discovery_error: string | null };
export type CountDeps = {
  catalog: (tenant_id: string) => Promise<CountCatalog | null>;
  mongoAggregate: (tenant_id: string, collection: string, pipeline: Record<string, unknown>[]) => Promise<{ rows: Array<Record<string, unknown>>; truncated: boolean }>;
  sqlRead: (tenant_id: string, query: string) => Promise<{ rows: Array<Record<string, unknown>>; truncated: boolean }>;
};

export const defaultCountDeps: CountDeps = {
  async catalog(tenant_id) {
    const { getCatalog } = await import("@/services/tools/operator-db/catalog");
    const c = await getCatalog(tenant_id);
    return c ? { dialect: c.dialect, catalog: c.catalog, discovery_error: c.discovery_error } : null;
  },
  async mongoAggregate(tenant_id, collection, pipeline) {
    const { withReadSession } = await import("@/services/data-gateway");
    const { MAX_ROWS_PER_READ } = await import("@/services/tools/operator-db/codeact-sql");
    const { mongoReadTainted } = await import("@/services/tools/operator-db/drivers/mongo");
    const { maskTaintedValue, redactDocDeep } = await import("@/services/tools/operator-db/discovery/redact");
    const raw = (await withReadSession({ tenant_id, caller: { kind: "background", feature: "Goal count" } }, (session) =>
      session.mongo().aggregate(collection, [...pipeline, { $limit: MAX_ROWS_PER_READ }]),
    )) as Array<Record<string, unknown>>;
    const tainted = mongoReadTainted(pipeline);
    const rows = tainted ? raw.map((d) => maskTaintedValue(redactDocDeep(d)) as Record<string, unknown>) : raw;
    return { rows, truncated: rows.length >= MAX_ROWS_PER_READ };
  },
  async sqlRead(tenant_id, query) {
    const { withReadSession } = await import("@/services/data-gateway");
    const { runCodeActReads } = await import("@/services/tools/operator-db/codeact-sql");
    const [r] = await withReadSession({ tenant_id, caller: { kind: "background", feature: "Goal count" } }, (session) =>
      runCodeActReads(session, [query]),
    );
    return { rows: r?.rows ?? [], truncated: r ? r.truncated : true };
  },
};

export async function runCountRule(
  tenant_id: string,
  rule: Pick<CountRule, "dialect" | "query" | "collection" | "pipeline"> & { schema_hash?: string },
  opts: { checkHash: boolean },
  deps: CountDeps = defaultCountDeps,
): Promise<CountOutcome> {
  if (!shapeOk(rule)) return { ok: false, reason: "invalid_rule" };
  try {
    if (rule.dialect === "sql") {
      const { assertReadOnlyStatement } = await import("@/services/tools/operator-db/codeact-sql");
      try {
        assertReadOnlyStatement(rule.query!);
      } catch {
        return { ok: false, reason: "read_only_rejected" };
      }
    }
    const cat = await deps.catalog(tenant_id);
    if (!cat || cat.discovery_error) return { ok: false, reason: "not_connected" };
    const sqlDb = cat.dialect === "postgres" || cat.dialect === "mysql";
    if (rule.dialect === "sql" ? !sqlDb : cat.dialect !== "mongodb") return { ok: false, reason: "dialect_mismatch" };
    if (rule.dialect === "mongodb") {
      const { validateAggregate } = await import("@/services/tools/operator-db/mongo-read-grammar");
      const { allowedCollectionsFromCatalog } = await import("@/services/tools/operator-db/catalog");
      const allowed = allowedCollectionsFromCatalog(cat.catalog);
      if (!allowed.has(rule.collection!.toLowerCase()) || !validateAggregate(rule.pipeline, { allowedCollections: allowed }).ok) {
        return { ok: false, reason: "read_only_rejected" };
      }
    }
    const hash = schemaHashFor(cat.catalog, rule);
    if (!hash) return { ok: false, reason: "unknown_tables" };
    if (opts.checkHash && hash !== rule.schema_hash) return { ok: false, reason: "schema_changed" };
    const out =
      rule.dialect === "sql" ? await deps.sqlRead(tenant_id, rule.query!) : await deps.mongoAggregate(tenant_id, rule.collection!, rule.pipeline!);
    const value = oneNumber(out.rows, out.truncated);
    return value === null ? { ok: false, reason: "not_one_number" } : { ok: true, value, schema_hash: hash };
  } catch (e) {
    console.warn(`[goal-count-rule] count failed for tenant ${tenant_id}: ${(e as Error)?.constructor?.name ?? "error"}`);
    return { ok: false, reason: "query_failed" };
  }
}

export function countedSource(definition: string): string {
  return `counted: ${definition}`.slice(0, 200);
}

export function failureWords(reason: CountFailure | string | null | undefined): string {
  switch (reason) {
    case "schema_changed":
      return "the data it reads changed shape";
    case "not_one_number":
      return "it no longer comes back as one number";
    case "not_connected":
      return "your database is not connected";
    case "unknown_tables":
      return "the table it reads is gone";
    case "read_only_rejected":
      return "it is not a plain read";
    default:
      return "the count failed";
  }
}

export function ruleKey(rule: Pick<CountRule, "dialect" | "query" | "collection" | "pipeline">, schemaHash: string): string {
  const body = rule.dialect === "sql" ? rule.query ?? "" : `${rule.collection}|${JSON.stringify(rule.pipeline ?? [])}`;
  return createHash("sha256").update(`${rule.dialect}|${body}|${schemaHash}`).digest("hex").slice(0, 10);
}
