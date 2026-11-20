import { z } from "zod";
import { SummaryRequest } from "./summary-ir";
import { MAX_PARENTS } from "./inheritance";

export const MAX_RESULT_BYTES = 900_000;
export const MAX_ROWS = 1000;
export const MAX_COLS = 200;
export const MAX_CELL_CHARS = 4096;
export const MAX_DEPTH = 8;
export const SAFE_TIME_ZONE = /^(UTC|[A-Za-z]+(\/[A-Za-z0-9_+-]+){1,2})$/;

export const ConnectorOp = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("sql"),
    text: z.string().max(20_000),
    params: z.array(z.union([z.string().max(4096), z.number(), z.boolean(), z.null()])).max(100).default([]),
    max_rows: z.number().int().min(1).max(MAX_ROWS),
    time_zone: z.string().regex(SAFE_TIME_ZONE).max(64).optional(),
    statement_timeout_ms: z.number().int().min(100).max(120_000).optional(),
    utc_offset_session: z.boolean().optional(),
  }),
  z.object({
    op: z.literal("mongo"),
    action: z.enum(["find", "findOne", "aggregate", "countDocuments", "estimatedDocumentCount", "listCollections"]),
    collection: z.string().max(128).optional(),
    filter: z.record(z.string(), z.unknown()).optional(),
    options: z.record(z.string(), z.unknown()).optional(),
    pipeline: z.array(z.record(z.string(), z.unknown())).max(20).optional(),
    max_rows: z.number().int().min(1).max(MAX_ROWS),
  }),
  z.object({ op: z.literal("summary"), request: SummaryRequest }),
  z.object({ op: z.literal("describe") }),
]);
export type ConnectorOp = z.infer<typeof ConnectorOp>;

const Cell = z.union([z.string().max(MAX_CELL_CHARS), z.number(), z.boolean(), z.null()]);

function depthOk(v: unknown, depth: number): boolean {
  if (v === null || typeof v !== "object") return typeof v !== "string" || v.length <= MAX_CELL_CHARS;
  if (depth >= MAX_DEPTH) return false;
  const vals = Array.isArray(v) ? v : Object.values(v as Record<string, unknown>);
  return vals.every((x) => depthOk(x, depth + 1));
}
const Doc = z.unknown().refine((v) => depthOk(v, 0), { message: `document nested deeper than ${MAX_DEPTH} or a value longer than ${MAX_CELL_CHARS} chars` });

export const RawIntrospectionSchema = z.object({
  dialect: z.enum(["postgres", "mysql", "mongodb", "dynamodb"]),
  tables: z
    .array(
      z.object({
        name: z.string().max(256),
        columns: z
          .array(
            z.object({
              name: z.string().max(256),
              type: z.string().max(128),
              nullable: z.boolean(),
              json_keys: z.array(z.string().max(64)).max(200).optional(),
              json_sampled: z.enum(["full", "partial", "none"]).optional(),
              json_map_like: z.boolean().optional(),
            }),
          )
          .max(2000),
        rowEstimate: z.number().nullable(),
        partitioned: z.boolean().optional(),
        partitions: z.array(z.string().max(256)).max(1000).optional(),
        parents: z.array(z.string().max(256)).max(MAX_PARENTS).optional(),
      }),
    )
    .max(1000),
  skippedUnsafeNames: z.number().int().nonnegative(),
  namesSeenTotal: z.number().int().nonnegative(),
  deadlineHit: z.boolean(),
  listingTruncated: z.boolean(),
});

const Rule = z.enum(["totals_and_counts_only", "rows_without_blocked_columns"]);
const Done = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("rows"),
    columns: z.array(z.string().max(128)).max(MAX_COLS),
    rows: z.array(z.array(Cell).max(MAX_COLS)).max(MAX_ROWS),
    truncated: z.boolean(),
    removed_columns: z.array(z.string().max(128)).max(MAX_COLS),
    rule: Rule,
  }),
  z.object({
    kind: z.literal("docs"),
    docs: z.array(Doc).max(MAX_ROWS),
    truncated: z.boolean(),
    removed_columns: z.array(z.string().max(128)).max(MAX_COLS),
    rule: Rule,
  }),
  z.object({ kind: z.literal("count"), count: z.number().int().nonnegative() }),
  z.object({ kind: z.literal("describe"), introspection: RawIntrospectionSchema }),
]);

export const ConnectorResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("done"), data: Done }),
  z.object({ status: z.literal("refused"), reason: z.string().max(500) }),
  z.object({ status: z.literal("failed"), reason: z.string().max(500) }),
]);
export type ConnectorResult = z.infer<typeof ConnectorResult>;

export function parseConnectorResult(raw: unknown): { ok: true; value: ConnectorResult } | { ok: false; reason: string } {
  let size: number;
  try {
    size = new TextEncoder().encode(JSON.stringify(raw) ?? "").length;
  } catch {
    return { ok: false, reason: "result is not JSON-serializable" };
  }
  if (size > MAX_RESULT_BYTES) return { ok: false, reason: `result is ${size} bytes (max ${MAX_RESULT_BYTES})` };
  const r = ConnectorResult.safeParse(raw);
  if (!r.success) return { ok: false, reason: r.error.issues[0]?.message ?? "invalid result" };
  return { ok: true, value: r.data };
}

export const PAIR_CODE_PATTERN = /^zpair_[0-9A-HJKMNP-TV-Z]{26}$/;
export const CONNECTOR_TOKEN_PATTERN = /^zconn_[0-9a-f]{64}$/;
export const SOURCE_INSTANCE_PATTERN = /^[0-9a-f]{32}$/;
const SourceInstance = z.string().regex(SOURCE_INSTANCE_PATTERN).nullable();
const Generation = z.number().int().nonnegative().nullable();

const Machine = z.string().trim().min(1).max(120);
const Version = z.string().trim().min(1).max(40);

export const ConnectorPairRequest = z.object({
  code: z.string().max(64),
  machine: Machine,
  version: Version,
});
export type ConnectorPairRequest = z.infer<typeof ConnectorPairRequest>;

export const ConnectorRulesSummary = z.object({
  allowed_tables: z.array(z.string().max(256)).max(1000),
  blocked_fields: z.array(z.string().max(512)).max(5000),
  what_can_leave: z.enum(["totals_and_counts_only", "rows_without_blocked_columns"]),
  max_rows: z.number().int().min(1).max(MAX_ROWS),
  allowed_columns: z.array(z.string().max(512)).max(5000).optional(),
});
export type ConnectorRulesSummary = z.infer<typeof ConnectorRulesSummary>;

export const ConnectorHeartbeat = z
  .object({
    machine: Machine,
    version: Version,
    dialect: z.enum(["postgres", "mysql", "mongodb"]).nullable().optional(),
    source_instance_id: SourceInstance,
    rules: ConnectorRulesSummary.nullable().optional(),
    rules_hash: z.string().regex(/^[0-9a-f]{64}$/).nullable().optional(),
  })
  .refine((h) => (h.rules == null) === (h.rules_hash == null), { message: "rules and rules_hash must be sent together" });
export type ConnectorHeartbeat = z.infer<typeof ConnectorHeartbeat>;

export const ConnectorDelivery = z.object({
  id: z.string().uuid(),
  execution_token: z.string().uuid(),
  op: ConnectorOp,
  generation: Generation,
});
export type ConnectorDelivery = z.infer<typeof ConnectorDelivery>;

export function parseConnectorCompletion(
  raw: unknown,
):
  | { ok: true; execution_token: string; generation: number | null; source_instance_id: string | null; value: ConnectorResult }
  | { ok: false; reason: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "body must be an object" };
  const { execution_token, generation, source_instance_id, ...rest } = raw as Record<string, unknown>;
  if (typeof execution_token !== "string" || !z.string().uuid().safeParse(execution_token).success) {
    return { ok: false, reason: "execution_token must be a uuid" };
  }
  const parsed = parseConnectorResult(rest);
  if (!parsed.ok) return parsed;
  const g = Generation.optional().safeParse(generation);
  const s = SourceInstance.optional().safeParse(source_instance_id);
  if (!g.success) return { ok: false, reason: "generation must be a non-negative integer or null" };
  if (!s.success) return { ok: false, reason: "source_instance_id must be 32 hex characters or null" };
  if (parsed.value.status === "done" && (generation === undefined || source_instance_id === undefined)) {
    return { ok: false, reason: "a result must echo generation and source_instance_id" };
  }
  return { ok: true, execution_token, generation: g.data ?? null, source_instance_id: s.data ?? null, value: parsed.value };
}
