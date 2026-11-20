import type { Document } from "mongodb";
import {
  MAX_ROWS,
  SAFE_TIME_ZONE,
  parseConnectorResult,
  type ConnectorOp,
  type ConnectorResult,
  type SummaryRequest,
} from "@zavi/shared/db-guard";
import { ExpectedToolError } from "@/services/tools/types";
import { fromWireEjson, toWireEjson } from "../direct/mongo";
import { logEvent } from "@/services/logging/logEvent";
import type { MongoFacade, MongoFindOptions, ReadSession, SqlQueryOptions, SqlResult } from "../session";
import { ConnectorOfflineError, DbSourceChangedError, GatewayRefusal, type GatewayContext } from "../types";
import { awaitResult, enqueue, REQUEST_TTL_SECONDS, WAIT_TIMEOUT_MS, type QueueDeps } from "./queue";
import { ageText, isOnline, readActiveConnector, type ConnectorRow } from "./status";
import { handleConnectorOffline, type OfflineDeps } from "./offline";

const LIVENESS_RECHECK_MS = 5_000;

export type ConnectorSessionOptions = {
  generation?: number;
  timeZone?: string;
  statementTimeoutMs?: number;
  utcOffsetSession?: boolean;
};

export type ConnectorSessionDeps = {
  readConnector: typeof readActiveConnector;
  queue: Partial<QueueDeps>;
  offline: Partial<OfflineDeps>;
  log: typeof logEvent;
  now: () => number;
  waitTimeoutMs: number;
};

const DEFAULT: ConnectorSessionDeps = {
  readConnector: (t) => readActiveConnector(t),
  queue: {},
  offline: {},
  log: (i) => logEvent(i),
  now: () => Date.now(),
  waitTimeoutMs: WAIT_TIMEOUT_MS,
};

export function connectorNotPaired(): ExpectedToolError {
  return new ExpectedToolError(
    "connector_not_ready",
    "This workspace reads its database through a Zavi Connector, and no connector is paired. An owner or admin can install one from Connectors > Integrations > Your database.",
  );
}

type Done = Extract<ConnectorResult, { status: "done" }>["data"];

function wireParam(v: unknown): string | number | boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : String(v);
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v.slice(0, 4096);
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Date) return v.toISOString();
  try {
    return JSON.stringify(v).slice(0, 4096);
  } catch {
    return String(v).slice(0, 4096);
  }
}

const ejson = toWireEjson;
const fromEjson = fromWireEjson;

export type ConnectorSession = ReadSession & {
  summary(req: SummaryRequest): Promise<Record<string, unknown>[]>;
  describe(timeoutMs: number): Promise<Extract<Done, { kind: "describe" }>["introspection"]>;
  readonly totalsOnly: boolean;
};

export async function openConnectorSession(
  ctx: GatewayContext,
  dialect: ReadSession["dialect"],
  opts: ConnectorSessionOptions = {},
  deps: Partial<ConnectorSessionDeps> = {},
): Promise<ConnectorSession> {
  const d: ConnectorSessionDeps = { ...DEFAULT, ...deps };
  let row: ConnectorRow | null = await d.readConnector(ctx.tenant_id);
  if (!row) throw connectorNotPaired();
  let checkedAt = d.now();
  let offlineHandled = false;

  async function ensureOnline(): Promise<void> {
    if (d.now() - checkedAt > LIVENESS_RECHECK_MS) {
      row = await d.readConnector(ctx.tenant_id);
      checkedAt = d.now();
      if (!row) throw connectorNotPaired();
    }
    if (isOnline(row!, d.now())) return;
    if (!offlineHandled) {
      offlineHandled = true;
      await handleConnectorOffline(ctx, row, d.offline);
    }
    throw new ConnectorOfflineError(row!.machine_name, ageText(row!.last_seen_at, d.now()));
  }

  async function run(op: ConnectorOp, timeoutMs = d.waitTimeoutMs, ttl = REQUEST_TTL_SECONDS): Promise<Done> {
    await ensureOnline();
    if (opts.generation === undefined) throw new ExpectedToolError("connector_not_ready", "Zavi could not tell which database settings this read belongs to. Try again.");
    const id = await enqueue(ctx.tenant_id, op, opts.generation, ttl, d.queue);
    if (!id) throw connectorNotPaired();
    const finished = await awaitResult(ctx.tenant_id, id, { timeoutMs }, d.queue);
    if (finished === "timeout" || finished.status === "expired") {
      row = await d.readConnector(ctx.tenant_id).catch(() => row);
      checkedAt = d.now();
      if (row && !isOnline(row, d.now())) {
        if (!offlineHandled) {
          offlineHandled = true;
          await handleConnectorOffline(ctx, row, d.offline);
        }
        throw new ConnectorOfflineError(row.machine_name, ageText(row.last_seen_at, d.now()));
      }
      await d.log({ level: "warn", source: "data-gateway.connector", code: "connector_timeout", tenant_id: ctx.tenant_id, meta: { op: op.op } });
      throw new ExpectedToolError("connector_timeout", "Your Zavi Connector did not answer in time, so no result was used. Try again, or answer without the data.");
    }
    if (finished.status === "refused") {
      await d.log({ level: "info", source: "data-gateway.connector", code: "connector_refused", tenant_id: ctx.tenant_id, meta: { op: op.op } });
      throw new GatewayRefusal(finished.reason || "this read is not allowed by your connector's rules.", "connector", [], { totals_only: totalsOnly });
    }
    if (finished.status === "failed" && finished.reason === "source_changed") {
      throw new DbSourceChangedError();
    }
    if (finished.status === "failed") {
      throw new ExpectedToolError(
        "connector_read_failed",
        `Your Zavi Connector could not run this read: ${(finished.reason || "no reason given").slice(0, 300)}`,
      );
    }
    const parsed = parseConnectorResult(finished.result);
    if (!parsed.ok || parsed.value.status !== "done") {
      await d.log({ level: "warn", source: "data-gateway.connector", code: "connector_invalid_result", tenant_id: ctx.tenant_id, meta: { op: op.op } });
      throw new ExpectedToolError("connector_invalid_result", "Your Zavi Connector sent an answer Zavi could not check, so nothing from it was used.");
    }
    return parsed.value.data;
  }

  const totalsOnly = row.rules?.what_can_leave === "totals_and_counts_only";
  const unexpected = (kind: string): never => {
    throw new ExpectedToolError("connector_invalid_result", `Your Zavi Connector sent a ${kind} answer for a different kind of read, so nothing from it was used.`);
  };
  const docsOf = (data: Done): Document[] => (data.kind === "docs" ? data.docs.map(fromEjson) : unexpected(data.kind));
  const countOf = (data: Done): number => (data.kind === "count" ? data.count : unexpected(data.kind));

  const timeZone = typeof opts.timeZone === "string" && SAFE_TIME_ZONE.test(opts.timeZone) ? opts.timeZone : undefined;

  const query = async (text: string, params: unknown[] = [], o: SqlQueryOptions = {}): Promise<SqlResult> => {
    if (dialect !== "postgres" && dialect !== "mysql") {
      throw new ExpectedToolError("operator_db_unsupported_dialect", `SQL reads are not available on a ${dialect} database.`);
    }
    const max = Math.max(1, Math.min(MAX_ROWS, Math.floor(o.maxRows ?? MAX_ROWS)));
    const data = await run({
      op: "sql",
      text,
      params: params.slice(0, 100).map(wireParam),
      max_rows: max,
      ...(timeZone ? { time_zone: timeZone } : {}),
      ...(opts.statementTimeoutMs ? { statement_timeout_ms: Math.max(100, Math.min(120_000, Math.round(opts.statementTimeoutMs))) } : {}),
      ...(opts.utcOffsetSession ? { utc_offset_session: true } : {}),
    });
    if (data.kind !== "rows") return unexpected(data.kind);
    const rows = data.rows.map((r) => Object.fromEntries(data.columns.map((c, i) => [c, r[i] ?? null])));
    return { rows, fields: data.columns.map((name) => ({ name })), truncated: data.truncated };
  };

  const mongoOp = (action: Extract<ConnectorOp, { op: "mongo" }>["action"], body: { collection?: string; filter?: Record<string, unknown>; options?: Record<string, unknown>; pipeline?: Record<string, unknown>[]; max_rows?: number }) =>
    run({
      op: "mongo",
      action,
      ...(body.collection !== undefined ? { collection: body.collection } : {}),
      ...(body.filter !== undefined ? { filter: ejson(body.filter) } : {}),
      ...(body.options !== undefined ? { options: ejson(body.options) } : {}),
      ...(body.pipeline !== undefined ? { pipeline: body.pipeline.map((s) => ejson(s)) } : {}),
      max_rows: Math.max(1, Math.min(MAX_ROWS, Math.floor(body.max_rows ?? MAX_ROWS))),
    });

  const findOptions = (o: MongoFindOptions): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    if (o.projection) out.projection = o.projection;
    if (o.sort) out.sort = o.sort;
    if (o.limit !== undefined) out.limit = o.limit;
    if (o.skip !== undefined) out.skip = o.skip;
    if (o.maxTimeMS !== undefined) out.maxTimeMS = o.maxTimeMS;
    return out;
  };

  const mongoFacade: MongoFacade = {
    database: { name: "your database", explicit: true },
    async find(collection, filter, o = {}) {
      return docsOf(await mongoOp("find", { collection, filter, options: findOptions(o), max_rows: o.limit }));
    },
    async findOne(collection, filter, o = {}) {
      const docs = docsOf(await mongoOp("findOne", { collection, filter, options: findOptions(o), max_rows: 1 }));
      return docs[0] ?? null;
    },
    async aggregate(collection, pipeline, o = {}) {
      const options = { ...(o.maxTimeMS ? { maxTimeMS: o.maxTimeMS } : {}), ...(o.allowDiskUse ? { allowDiskUse: true } : {}) };
      const data = await mongoOp("aggregate", { collection, pipeline, options });
      if (o.failIfTruncated && data.kind === "docs" && data.truncated) {
        throw new ExpectedToolError("connector_rows_truncated", "The answer passed your Zavi Connector's row cap, so the partial rows were not used.");
      }
      return docsOf(data);
    },
    async countDocuments(collection, filter, o = {}) {
      return countOf(await mongoOp("countDocuments", { collection, filter, options: o.limit !== undefined ? { limit: o.limit } : {} }));
    },
    async estimatedDocumentCount(collection) {
      return countOf(await mongoOp("estimatedDocumentCount", { collection }));
    },
    async listCollections() {
      return docsOf(await mongoOp("listCollections", {})).map((c) => ({
        name: String((c as { name?: unknown }).name ?? ""),
        ...(typeof (c as { type?: unknown }).type === "string" ? { type: (c as { type: string }).type } : {}),
      }));
    },
  };

  return {
    dialect,
    totalsOnly,
    query,
    mongo: () => {
      if (dialect !== "mongodb") throw new ExpectedToolError("operator_db_unsupported_dialect", `MongoDB reads are not available on a ${dialect} database.`);
      return mongoFacade;
    },
    dynamo: () => {
      throw new ExpectedToolError("operator_db_unsupported_dialect", "DynamoDB is not available through the Zavi Connector.");
    },
    sessionTimeZone: () => timeZone,
    largestTableRows: async () => null,
    close: async () => undefined,
    async summary(req) {
      const data = await run({ op: "summary", request: req });
      if (data.kind !== "rows") return unexpected(data.kind);
      return data.rows.map((r) => Object.fromEntries(data.columns.map((c, i) => [c, r[i] ?? null])));
    },
    async describe(timeoutMs) {
      const data = await run({ op: "describe" }, timeoutMs, Math.min(180, Math.ceil(timeoutMs / 1000) + 10));
      if (data.kind !== "describe") return unexpected(data.kind);
      return data.introspection;
    },
  };
}
