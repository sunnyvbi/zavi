import {
  checkReadOnly,
  guardSql,
  stripHiddenColumns,
  stripJsonInRows,
  guardMongoFind,
  guardMongoCount,
  guardMongoAggregate,
  mongoResultStripper,
  type Refusal,
} from "@zavi/shared/db-guard";
import type { MongoFacade, MongoFindOptions, ReadSession, SqlQueryOptions, SqlResult, DynamoFacade, DynamoFilter } from "./session";
import type { DbAccess } from "./resolve";
import { ConnectorOfflineError, GatewayRefusal, type GatewayContext } from "./types";
import { reserveAudit, finalizeAudit, writeRefusalAudit, type AuditOperation } from "./audit";
import { noteRefusal } from "./run-reads";
import { pushAccessNote } from "./note-collector";
import { guardedDynamoFacade, dynamoInputRefusal } from "./direct/dynamo";

const runIdOf = (ctx: GatewayContext) => (ctx.caller.kind === "agent" ? ctx.caller.run_id : null);

export function failureReason(e: unknown): string {
  if (e instanceof ConnectorOfflineError) return "connector offline";
  const ec = (e as { code?: unknown })?.code;
  if (ec === "connector_timeout") return "connector timeout";
  if (ec === "connector_invalid_result") return "connector sent an invalid result";
  if (ec === "connector_read_failed") return "connector could not run the read";
  const code = (e as { code?: unknown })?.code;
  const name = e instanceof Error ? e.name : "Error";
  return typeof code === "string" || typeof code === "number" ? `${name} (${String(code)})` : name;
}

export function loggedSession(inner: ReadSession, access: DbAccess, ctx: GatewayContext): ReadSession {
  const { policy } = access;
  const mode = access.mode;
  const dialect = access.dialect;

  const generation = access.generation ?? null;

  async function refuse(queryText: string, tables: string[], r: Refusal, operation: AuditOperation = "read"): Promise<never> {
    await writeRefusalAudit({ ctx, mode, dialect, operation, query_text: queryText, tables, refused_by: "zavi", reason: r.reason });
    noteRefusal(runIdOf(ctx), "zavi", r.reason, tables);
    pushAccessNote({ log_id: null, mode, tables, rows: 0, result: "refused", refused_by: "zavi", reason: r.reason, ...(r.rule ? { refused_rule: r.rule } : {}) });
    throw new GatewayRefusal(r.reason, "zavi", tables, { rule: r.rule });
  }

  async function audited<T>(queryText: string, tables: string[], run: () => Promise<T>, count: (t: T) => number, operation: AuditOperation = "read"): Promise<T> {
    const id = await reserveAudit({ ctx, mode, dialect, operation, query_text: queryText, tables, generation });
    const t0 = Date.now();
    let out: T;
    try {
      out = await run();
    } catch (e) {
      if (e instanceof GatewayRefusal && e.refused_by === "connector") {
        const totals_only = Boolean((inner as { totalsOnly?: boolean }).totalsOnly);
        await finalizeAudit(id, ctx, { result: "refused", row_count: 0, refused_by: "connector", reason: e.reason, totals_only, ms: Date.now() - t0 });
        noteRefusal(runIdOf(ctx), "connector", e.reason, tables);
        pushAccessNote({ log_id: id, mode, tables, rows: 0, result: "refused", refused_by: "connector", reason: e.reason, ...(totals_only ? { totals_only } : {}) });
        throw new GatewayRefusal(e.reason, "connector", tables, { totals_only });
      }
      await finalizeAudit(id, ctx, { result: "failed", row_count: 0, reason: failureReason(e), ms: Date.now() - t0 });
      pushAccessNote({ log_id: id, mode, tables, rows: 0, result: "failed" });
      throw e;
    }
    const rows = count(out);
    try {
      await finalizeAudit(id, ctx, { result: "allowed", row_count: rows, ms: Date.now() - t0, generation });
    } catch (e) {
      pushAccessNote({ log_id: id, mode, tables, rows: 0, result: "failed" });
      throw e;
    }
    pushAccessNote({ log_id: id, mode, tables, rows, result: "allowed" });
    return out;
  }

  const query = async (text: string, params: unknown[] = [], opts: SqlQueryOptions = {}): Promise<SqlResult> => {
    if (dialect !== "postgres" && dialect !== "mysql") return inner.query(text, params, opts);
    const label = opts.label ?? text;
    const ro = checkReadOnly(text, dialect);
    if (!ro.ok) return refuse(label, [], { ok: false, reason: ro.reason });
    const g = guardSql(text, { policy, dialect, mysqlDatabase: access.database ?? null });
    if (!g.ok) return refuse(label, [], g);
    return audited(
      label,
      g.tables,
      async () => {
        const r = await inner.query(g.sql, params, opts);
        const rows = stripJsonInRows(stripHiddenColumns(r.rows, g.hidden), { policy, tables: g.tables, hidden: g.hidden, passthrough: g.passthrough, structured: g.structured, fieldNames: r.fields.map((f) => f.name) });
        return { ...r, rows, fields: r.fields.filter((f) => !g.hidden.some((h) => h.toLowerCase() === f.name.toLowerCase())) };
      },
      (r) => r.rows.length,
    );
  };

  const mongoText = (op: string, collection: string, body: unknown) => {
    try {
      return `${op} ${collection} ${JSON.stringify(body)}`;
    } catch {
      return `${op} ${collection}`;
    }
  };

  let mongoFacade: MongoFacade | null = null;
  const mongo = (): MongoFacade => {
    if (mongoFacade) return mongoFacade;
    const m = inner.mongo();
    mongoFacade = {
      database: m.database,
      async find(collection, filter, options: MongoFindOptions = {}) {
        const text = mongoText("find", collection, { filter, options });
        const g = guardMongoFind(collection, filter, options as Record<string, unknown>, { policy });
        if (!g.ok) return refuse(text, [collection], g);
        const strip = mongoResultStripper(policy, g.touched);
        return audited(text, [g.collection], async () => (await m.find(g.collection, g.filter, g.options as MongoFindOptions)).map((d) => strip(d)), (r) => r.length);
      },
      async findOne(collection, filter, options: MongoFindOptions = {}) {
        const text = mongoText("findOne", collection, { filter, options });
        const g = guardMongoFind(collection, filter, options as Record<string, unknown>, { policy });
        if (!g.ok) return refuse(text, [collection], g);
        const strip = mongoResultStripper(policy, g.touched);
        return audited(text, [g.collection], async () => {
          const d = await m.findOne(g.collection, g.filter, g.options as MongoFindOptions);
          return d ? strip(d) : null;
        }, (r) => (r ? 1 : 0));
      },
      async aggregate(collection, pipeline, options = {}) {
        const text = mongoText("aggregate", collection, pipeline);
        const g = guardMongoAggregate(collection, pipeline, { policy });
        if (!g.ok) return refuse(text, [collection], g);
        const strip = mongoResultStripper(policy, g.touched);
        return audited(text, [g.collection], async () => (await m.aggregate(g.collection, g.pipeline, options)).map((d) => strip(d)), (r) => r.length);
      },
      async countDocuments(collection, filter, options = {}) {
        const text = mongoText("countDocuments", collection, filter);
        const g = guardMongoCount(collection, filter, { policy });
        if (!g.ok) return refuse(text, [collection], g);
        return audited(text, [g.collection], () => m.countDocuments(g.collection, g.filter, options), () => 1);
      },
      async estimatedDocumentCount(collection, options = {}) {
        const text = `estimatedDocumentCount ${collection}`;
        const t = policy.resolve(collection, true);
        if (!t) return refuse(text, [collection], { ok: false, reason: `${collection} is not a collection Zavi may read.` });
        return audited(text, [t.name], () => m.estimatedDocumentCount(t.name, options), () => 1);
      },
      async listCollections() {
        return audited("listCollections", [], async () => (await m.listCollections()).filter((c) => policy.resolve(c.name, true) !== null), (r) => r.length);
      },
    };
    return mongoFacade;
  };

  let dynamoFacade: DynamoFacade | null = null;
  const dynamo = (): DynamoFacade => {
    if (dynamoFacade) return dynamoFacade;
    const guarded = guardedDynamoFacade(inner.dynamo(), policy);
    const wrap = <I extends { table: string; fields?: string[]; key?: Record<string, string | number>; filter?: DynamoFilter }>(op: string, fn: (i: I) => Promise<Record<string, unknown>[]>) => async (input: I) => {
      const text = `${op} ${JSON.stringify(input)}`;
      const why = dynamoInputRefusal(input, policy);
      if (why) return refuse(text, [input.table], { ok: false, reason: why });
      const table = policy.resolve(input.table, true)!.name;
      return audited(text, [table], () => fn(input), (r) => r.length);
    };
    dynamoFacade = { scan: wrap("scan", (i) => guarded.scan(i)), query: wrap("query", (i) => guarded.query(i)) };
    return dynamoFacade;
  };

  return {
    dialect: inner.dialect,
    query,
    mongo,
    dynamo,
    sessionTimeZone: () => inner.sessionTimeZone(),
    largestTableRows: async (names) => {
      if (dialect !== "postgres" || mode === "connector") return null;
      const allowed = [...new Set(names.map((n) => policy.resolve(n.replace(/^public\./i, ""))?.name).filter((n): n is string => !!n))];
      if (allowed.length === 0) return null;
      const qualified = allowed.map((n) => `public."${n.replace(/"/g, '""')}"`);
      try {
        return await audited(`Planner row estimate (pg_class.reltuples) for ${allowed.join(", ")}`, allowed, () => inner.largestTableRows(qualified), () => 0);
      } catch {
        return null;
      }
    },
    close: () => inner.close(),
  };
}
