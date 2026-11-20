import { ExpectedToolError } from "@/services/tools/types";
import {
  compileSummary,
  suppressSmallGroups,
  stripJsonInRows,
  type Policy,
  type SummaryRequest,
} from "@zavi/shared/db-guard";
import type { OperatorDbCatalog, OperatorDbType } from "@/services/tools/operator-db/types";
import { getCatalog } from "@/services/tools/operator-db/catalog";
import type { ReadSession } from "./session";
import { loadDbAccess, readDbConfig, type DbAccess } from "./resolve";
import { loggedSession } from "./logged-session";
import { openSqlSession, type SqlSessionOptions } from "./direct/sql";
import { openMongoSession } from "./direct/mongo";
import { openDynamoSession } from "./direct/dynamo";
import { noTlsMessage } from "./direct/tls";
import { isConnectionFailure, unreachableMessage, rememberUnreachable, recallUnreachable, forgetUnreachable } from "./direct/reachability";
import { raiseOutage, clearOutageIfOpen } from "./direct/outage-card";
import { lastSuccessfulReadAt, egressIps, within } from "./direct/outage-facts";
import { reserveAudit, finalizeAudit, writeRefusalAudit } from "./audit";
import { noteNotConnected, noteRefusal } from "./run-reads";
import { pushAccessNote } from "./note-collector";
import { DatabaseUnreachableError, GatewayRefusal, type GatewayContext } from "./types";
import { openConnectorSession } from "./connector/session";
import { failureReason } from "./logged-session";
import type { OperatorDbDriver, SchemaMap } from "@/services/tools/operator-db/types";
import { attachSession } from "@/services/tools/operator-db/session-attach";
import { postgresDriver } from "@/services/tools/operator-db/drivers/postgres";
import { mongoDriver } from "@/services/tools/operator-db/drivers/mongo";
import { mysqlDriver } from "@/services/tools/operator-db/drivers/mysql";
import { dynamodbDriver } from "@/services/tools/operator-db/drivers/dynamodb";
import { redactingDriver } from "@/services/tools/operator-db/redact-result";

export * from "./types";
export type { ReadSession, MongoFacade, DynamoFacade, SqlResult, SqlQueryOptions } from "./session";
export type { DbAccess } from "./resolve";
export { NOT_CONNECTED_MESSAGE } from "./resolve";
export { collectAccessNotes } from "./note-collector";
export { recordDbTransport, readDbGeneration } from "./resolve";
export { requireTlsByDefault, transportOf, NO_TLS_MESSAGES, type Transport } from "./direct/tls";
export { takeRunNotes, peekRunNotes, chatReadMeta, type RunReadNote, type ChatReadMeta } from "./run-reads";
export { probeConnectivity, discoverWithConnection } from "./discovery/run";
export { probeWriteCapable, type WriteCapable } from "./discovery/privilege";
export { probeCandidate, describeTenantDb, checkStoredLogin, readOnlyCheckOf, CONNECTION_TEST_TEXT, type ProbeCandidateResult, type DescribeResult, type ReadOnlyCheck } from "./describe";
export { scrubDbPreviews, scrubPreviewsForRunEnd, deleteCheckpointsAtRunEnd } from "./scrub";
export { readDbSetup, readDbVisibility, readDbRetention, checkVisibilityNames, rawResultsRetention, revokeCommandFor, MANAGED_DB_LOGIN, type DbSetup, type DbVisibility, type DbRetention, type VisibilityInput } from "./settings";
export { introspectPostgres } from "./discovery/postgres";
export { introspectMysql } from "./discovery/mysql";
export { introspectMongo } from "./discovery/mongo";

export type ReadSessionOptions = Pick<SqlSessionOptions, "timeZone" | "statementTimeoutMs" | "int8AsNumber" | "utcOffsetSession">;

const runIdOf = (ctx: GatewayContext) => (ctx.caller.kind === "agent" ? ctx.caller.run_id : null);

async function resolveFor(ctx: GatewayContext): Promise<DbAccess> {
  try {
    return await loadDbAccess(ctx.tenant_id);
  } catch (e) {
    if (e instanceof ExpectedToolError && e.code === "operator_db_not_connected") noteNotConnected(runIdOf(ctx));
    throw e;
  }
}

async function openInner(access: DbAccess, ctx: GatewayContext, opts: ReadSessionOptions = {}): Promise<ReadSession> {
  if (access.mode === "connector") return openConnectorSession(ctx, access.dialect, { ...opts, generation: access.generation });
  return openDirect(access, opts);
}

async function dialDirect(access: DbAccess, opts: ReadSessionOptions): Promise<ReadSession> {
  const conn = access.connectionString!;
  if (access.dialect === "postgres" || access.dialect === "mysql") return openSqlSession(access.dialect, conn, opts);
  if (access.dialect === "mongodb") return openMongoSession(conn);
  return openDynamoSession(conn);
}

const failedHere = new Set<string>();

async function openDirect(access: DbAccess, opts: ReadSessionOptions = {}): Promise<ReadSession> {
  const generation = access.generation ?? 0;
  const known = recallUnreachable(access.tenant_id, generation);
  if (known) throw new DatabaseUnreachableError(known.message);
  try {
    const session = await dialDirect(access, opts);
    forgetUnreachable(access.tenant_id);
    void clearOutageIfOpen(access.tenant_id, { sawFailure: failedHere.delete(access.tenant_id) });
    return session;
  } catch (e) {
    const tls = noTlsMessage(access.dialect, e, access.connectionString ?? "");
    const mongoTlsNamed = /\bssl\b|\btls\b|wrong version number|EPROTO/i.test(String((e as { message?: unknown })?.message ?? ""));
    if (tls && (access.dialect !== "mongodb" || mongoTlsNamed)) throw new ExpectedToolError("operator_db_tls_refused", tls);
    if (!isConnectionFailure(e)) throw e;
    failedHere.add(access.tenant_id);
    if (failedHere.size > 10_000) failedHere.delete(failedHere.values().next().value as string);
    const [lastReadAt, ips] = await Promise.all([
      within(lastSuccessfulReadAt(access.tenant_id), 1500, null),
      within(egressIps(), 1500, [] as string[]),
    ]);
    const message = unreachableMessage({ lastReadAt, ips });
    rememberUnreachable(access.tenant_id, generation, message);
    void raiseOutage(access.tenant_id, founderAdvice(ips));
    throw new DatabaseUnreachableError(message);
  }
}

function founderAdvice(ips: string[]): string {
  const list = ips.length ? ` Zavi connects from ${ips.join(", ")}.` : "";
  return `Check that your database is running and that its network allowlist (IP access list) accepts connections from Zavi's servers.${list}`;
}

export const __openDirectForTest = (access: DbAccess, opts: ReadSessionOptions = {}) => openDirect(access, opts);
export function __resetOpenDirectState(): void {
  failedHere.clear();
}

export async function withReadSession<T>(
  ctx: GatewayContext,
  fn: (session: ReadSession, access: DbAccess) => Promise<T>,
  opts: ReadSessionOptions = {},
): Promise<T> {
  const access = await resolveFor(ctx);
  const inner = await openInner(access, ctx, opts);
  const session = loggedSession(inner, access, ctx);
  try {
    return await fn(session, access);
  } finally {
    await session.close().catch(() => undefined);
  }
}

const DRIVERS: Record<OperatorDbType, () => OperatorDbDriver> = {
  postgres: postgresDriver,
  mongodb: mongoDriver,
  mysql: mysqlDriver,
  dynamodb: dynamodbDriver,
};

const driverFor = (dialect: OperatorDbType): OperatorDbDriver => redactingDriver(DRIVERS[dialect]());

export type AttachedDb = { driver: OperatorDbDriver; cfg: SchemaMap; access: DbAccess };

export async function withAttachedDriver<T>(
  ctx: GatewayContext,
  fn: (db: AttachedDb) => Promise<T>,
  opts: ReadSessionOptions = {},
): Promise<T> {
  return withReadSession(
    ctx,
    async (session, access) => {
      const cfg = attachSession({ ...access.config.schema_map } as SchemaMap, session);
      return fn({ driver: driverFor(access.dialect), cfg, access });
    },
    opts,
  );
}

export async function resolveAttachedDb(
  ctx: GatewayContext,
  opts: ReadSessionOptions = {},
): Promise<AttachedDb & { close: () => Promise<void> }> {
  const access = await resolveFor(ctx);
  const inner = await openInner(access, ctx, opts);
  const session = loggedSession(inner, access, ctx);
  const cfg = attachSession({ ...access.config.schema_map } as SchemaMap, session);
  return { driver: driverFor(access.dialect), cfg, access, close: () => session.close() };
}

export async function runSummary(ctx: GatewayContext, req: SummaryRequest): Promise<{ rows: Record<string, unknown>[]; table: string }> {
  const access = await resolveFor(ctx);
  const text = JSON.stringify(req);
  const compiled = compileSummary(req, access.dialect, access.policy, "cloud", { mysqlDatabase: access.database });
  if ("ok" in compiled) {
    await writeRefusalAudit({ ctx, mode: access.mode, dialect: access.dialect, operation: "summary", query_text: text, tables: [req.table], refused_by: "zavi", reason: compiled.reason });
    noteRefusal(runIdOf(ctx), "zavi", compiled.reason, [req.table]);
    pushAccessNote({ log_id: null, mode: access.mode, tables: [req.table], rows: 0, result: "refused", refused_by: "zavi", reason: compiled.reason, ...(compiled.rule ? { refused_rule: compiled.rule } : {}) });
    throw new GatewayRefusal(compiled.reason, "zavi", [req.table], { rule: compiled.rule });
  }
  const table = compiled.kind === "sql" ? req.table : compiled.collection;
  if (access.mode === "connector") return runConnectorSummary(ctx, access, req, table, text);
  const inner = await openDirect(access);
  const id = await reserveAudit({ ctx, mode: access.mode, dialect: access.dialect, operation: "summary", query_text: compiled.kind === "sql" ? compiled.text : text, tables: [table], generation: access.generation }).catch(async (e) => {
    await inner.close().catch(() => undefined);
    throw e;
  });
  const t0 = Date.now();
  let rows: Record<string, unknown>[];
  try {
    const raw =
      compiled.kind === "sql"
        ? (await inner.query(compiled.text, compiled.params, { maxRows: req.limit })).rows
        : ((await inner.mongo().aggregate(compiled.collection, compiled.pipeline)) as Record<string, unknown>[]);
    rows = stripSummaryJson(suppressSmallGroups(raw.map((r) => flattenMongoGroup(r))), access.policy, req.table, table);
  } catch (e) {
    await finalizeAudit(id, ctx, { result: "failed", row_count: 0, reason: e instanceof Error ? e.name : "Error", ms: Date.now() - t0 });
    throw e;
  } finally {
    await inner.close().catch(() => undefined);
  }
  await finalizeAudit(id, ctx, { result: "allowed", row_count: rows.length, ms: Date.now() - t0, generation: access.generation });
  pushAccessNote({ log_id: id, mode: access.mode, tables: [table], rows: rows.length, result: "allowed" });
  return { rows, table };
}

async function runConnectorSummary(
  ctx: GatewayContext,
  access: DbAccess,
  req: SummaryRequest,
  table: string,
  text: string,
): Promise<{ rows: Record<string, unknown>[]; table: string }> {
  const session = await openConnectorSession(ctx, access.dialect, { generation: access.generation });
  const id = await reserveAudit({ ctx, mode: "connector", dialect: access.dialect, operation: "summary", query_text: text, tables: [table], generation: access.generation });
  const t0 = Date.now();
  let rows: Record<string, unknown>[];
  try {
    rows = stripSummaryJson(suppressSmallGroups((await session.summary(req)).map((r) => flattenMongoGroup(r))), access.policy, req.table, table);
  } catch (e) {
    if (e instanceof GatewayRefusal && e.refused_by === "connector") {
      await finalizeAudit(id, ctx, { result: "refused", row_count: 0, refused_by: "connector", reason: e.reason, ms: Date.now() - t0 });
      noteRefusal(runIdOf(ctx), "connector", e.reason, [table]);
      pushAccessNote({ log_id: id, mode: "connector", tables: [table], rows: 0, result: "refused", refused_by: "connector", reason: e.reason });
      throw new GatewayRefusal(e.reason, "connector", [table]);
    }
    await finalizeAudit(id, ctx, { result: "failed", row_count: 0, reason: failureReason(e), ms: Date.now() - t0 });
    pushAccessNote({ log_id: id, mode: "connector", tables: [table], rows: 0, result: "failed" });
    throw e;
  }
  await finalizeAudit(id, ctx, { result: "allowed", row_count: rows.length, totals_only: true, ms: Date.now() - t0, generation: access.generation });
  pushAccessNote({ log_id: id, mode: "connector", tables: [table], rows: rows.length, result: "allowed", totals_only: true });
  return { rows, table };
}

function stripSummaryJson(rows: Record<string, unknown>[], policy: Policy, requested: string, table: string): Record<string, unknown>[] {
  const name = policy.resolve(requested, true)?.name ?? table;
  return stripJsonInRows(rows, { policy, tables: [name], hidden: policy.hiddenFields(name) });
}

function flattenMongoGroup(r: Record<string, unknown>): Record<string, unknown> {
  if (!("_id" in r)) return r;
  const { _id, ...rest } = r;
  return _id && typeof _id === "object" && !Array.isArray(_id) && !(_id instanceof Date) ? { ...(_id as Record<string, unknown>), ...rest } : rest;
}

export type DbStatus =
  | { connected: false }
  | {
      connected: true;
      mode: "direct" | "connector";
      dialect: OperatorDbType;
      discovered: boolean;
      discovery_error: string | null;
      rescan_failed_at: string | null;
      settings_confirmed: boolean;
    };

export async function dbStatus(tenant_id: string): Promise<DbStatus> {
  const row = await readDbConfig(tenant_id);
  if (!row) return { connected: false };
  const cat = await getCatalog(tenant_id);
  return {
    connected: true,
    mode: row.mode === "connector" ? "connector" : "direct",
    dialect: (cat?.dialect ?? row.type) as OperatorDbType,
    discovered: Boolean(cat && !cat.discovery_error && cat.catalog.tables.length > 0),
    discovery_error: cat?.discovery_error ?? null,
    rescan_failed_at: cat?.rescan_failed_at ?? null,
    settings_confirmed: Boolean(row.settings_confirmed_at),
  };
}

export function visibleCatalog(catalog: OperatorDbCatalog, policy: Policy): OperatorDbCatalog {
  return {
    tables: catalog.tables
      .filter((t) => policy.resolve(t.name, true) !== null)
      .map((t) => ({ ...t, columns: t.columns.filter((c) => !policy.isHidden(t.name, c.name)) })),
  };
}

export { loadDbAccess };
