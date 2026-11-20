import { getSecret } from "@/services/secrets/vault";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { readDbConfig, readDbGeneration, recordDbTransport } from "./resolve";
import type { OperatorDbType, RawIntrospection } from "@/services/tools/operator-db/types";
import {
  persistDiscoveryFailure,
  persistDiscoveryError,
  persistIntrospection,
  type DiscoverResult,
} from "@/services/tools/operator-db/discovery";
import { ExpectedToolError } from "@/services/tools/types";
import { openConnectorSession, type ConnectorSession } from "./connector/session";
import { failureReason } from "./logged-session";
import { probeConnectivity, discoverWithConnection } from "./discovery/run";
import { probeWriteCapable, type WriteCapable } from "./discovery/privilege";
import { MONGO_STRUCTURE_SCAN_TEXT } from "./discovery/mongo";
import { reserveAudit, finalizeAudit } from "./audit";
import { ConnectorOfflineError, DbSourceChangedError, GatewayRefusal, type GatewayContext } from "./types";
import { readOnlyCheckOf, type ReadOnlyCheck } from "./read-only";

export { readOnlyCheckOf, type ReadOnlyCheck };

export const CONNECTION_TEST_TEXT = "Connection test: sign in and check permissions";
const STRUCTURE_SCAN_TEXT = "Structure scan: list tables and columns";

export type ProbeCandidateResult = { ok: true; write_capable: WriteCapable } | { ok: false; error: string };

export async function probeCandidate(ctx: GatewayContext, type: OperatorDbType, connectionString: string): Promise<ProbeCandidateResult> {
  let id: string;
  try {
    id = await reserveAudit({ ctx, mode: "direct", dialect: type, operation: "connection_test", query_text: CONNECTION_TEST_TEXT, tables: [] });
  } catch {
    return { ok: false, error: "Zavi could not record this connection test in the data access log, so it did not run. Try again shortly." };
  }
  const t0 = Date.now();
  const probe = await probeConnectivity(type, connectionString);
  if (!probe.ok) {
    await finalizeAudit(id, ctx, { result: "failed", row_count: 0, reason: "connection failed", ms: Date.now() - t0 });
    return { ok: false, error: probe.error };
  }
  const write_capable = await probeWriteCapable(type, connectionString);
  await finalizeAudit(id, ctx, { result: "allowed", row_count: 0, ms: Date.now() - t0 }).catch(() => undefined);
  return { ok: true, write_capable };
}

export type DescribeResult =
  | DiscoverResult
  | { ok: false; discovery_error: "not_connected" | "no_secret" | "connector_not_ready" | "connector_offline" | "connector_no_database" | "stale_request" };

export async function describeTenantDb(ctx: GatewayContext, opts?: { capMs?: number; tableCap?: number; generation?: number | null }): Promise<DescribeResult> {
  const tenantId = ctx.tenant_id;
  const generation = await readDbGeneration(tenantId);
  if (opts?.generation != null && opts.generation !== generation) return { ok: false, discovery_error: "stale_request" };
  const cfg = await readDbConfig(tenantId);
  if (!cfg) {
    const { data: existing } = (await tenantClient(asTenantId(tenantId)).from("tenant_db_catalog").select("dialect").maybeSingle()) as {
      data: { dialect?: string } | null;
    };
    const dialect = existing?.dialect as OperatorDbType | undefined;
    if (dialect) await persistDiscoveryFailure(tenantId, dialect, "not_connected", generation);
    return { ok: false, discovery_error: "not_connected" };
  }
  if (cfg.mode === "connector") return describeViaConnector(ctx, cfg.type as OperatorDbType, generation, opts);

  const type = cfg.type as OperatorDbType;
  const secretKey = cfg.connection_secret_key || "operator_db.connection_string";
  const conn = await getSecret(tenantId, secretKey);
  if (!conn) {
    await persistDiscoveryFailure(tenantId, type, "no_secret", generation);
    return { ok: false, discovery_error: "no_secret" };
  }

  const id = await reserveAudit({
    ctx,
    mode: "direct",
    dialect: type,
    operation: "structure_scan",
    query_text: type === "mongodb" ? MONGO_STRUCTURE_SCAN_TEXT : STRUCTURE_SCAN_TEXT,
    tables: [],
  });
  const t0 = Date.now();
  const out = await discoverWithConnection(tenantId, type, conn, { capMs: opts?.capMs, tableCap: opts?.tableCap, generation });
  if (out.ok) await recordDbTransport(tenantId, type, conn, cfg.transport);
  await finalizeScan(id, ctx, out, t0);
  return out;
}

async function finalizeScan(id: string, ctx: GatewayContext, out: DiscoverResult, t0: number): Promise<void> {
  await finalizeAudit(
    id,
    ctx,
    out.ok
      ? { result: "allowed", row_count: out.tables_found, ms: Date.now() - t0 }
      : {
          result: "failed",
          row_count: 0,
          reason:
            out.discovery_error === "source_changed"
              ? "source changed during discovery"
              : out.kept_last_good
                ? "discovery did not finish; the last good table list is kept"
                : "discovery failed",
          ms: Date.now() - t0,
        },
  ).catch(() => undefined);
}

export async function checkStoredLogin(ctx: GatewayContext): Promise<ReadOnlyCheck | null> {
  const cfg = await readDbConfig(ctx.tenant_id);
  if (!cfg || cfg.mode === "connector") return null;
  const type = cfg.type as OperatorDbType;
  if (type !== "postgres" && type !== "mysql") return "unknown";
  const conn = await getSecret(ctx.tenant_id, cfg.connection_secret_key || "operator_db.connection_string");
  if (!conn) return null;
  let id: string;
  try {
    id = await reserveAudit({ ctx, mode: "direct", dialect: type, operation: "connection_test", query_text: CONNECTION_TEST_TEXT, tables: [] });
  } catch {
    return null;
  }
  const t0 = Date.now();
  const write = await probeWriteCapable(type, conn);
  await finalizeAudit(id, ctx, { result: "allowed", row_count: 0, ms: Date.now() - t0 }).catch(() => undefined);
  return readOnlyCheckOf(type, write);
}

export const CONNECTOR_DESCRIBE_TIMEOUT_MS = 170_000;

async function describeViaConnector(
  ctx: GatewayContext,
  type: OperatorDbType,
  generation: number,
  opts?: { capMs?: number },
): Promise<DescribeResult> {
  if (type !== "postgres" && type !== "mysql" && type !== "mongodb") {
    return { ok: false, discovery_error: "connector_no_database" };
  }
  let session: ConnectorSession;
  try {
    session = await openConnectorSession(ctx, type, { generation });
  } catch (e) {
    if (e instanceof ExpectedToolError && e.code === "connector_not_ready") return { ok: false, discovery_error: "connector_not_ready" };
    throw e;
  }
  const id = await reserveAudit({ ctx, mode: "connector", dialect: type, operation: "structure_scan", query_text: STRUCTURE_SCAN_TEXT, tables: [] });
  const t0 = Date.now();
  const timeoutMs = Math.min(CONNECTOR_DESCRIBE_TIMEOUT_MS, opts?.capMs ?? CONNECTOR_DESCRIBE_TIMEOUT_MS);
  try {
    const raw = await session.describe(timeoutMs);
    if (raw.dialect !== type) {
      throw new ExpectedToolError("connector_invalid_result", `Your connector described a ${raw.dialect} database, not ${type}.`);
    }
    const out = await persistIntrospection(ctx.tenant_id, type, raw as RawIntrospection, Date.now() + 20_000, generation);
    await finalizeScan(id, ctx, out, t0);
    return out;
  } catch (e) {
    if (e instanceof ConnectorOfflineError) {
      await finalizeAudit(id, ctx, { result: "failed", row_count: 0, reason: "connector offline", ms: Date.now() - t0 });
      return { ok: false, discovery_error: "connector_offline" };
    }
    if (e instanceof GatewayRefusal) {
      await finalizeAudit(id, ctx, { result: "refused", row_count: 0, refused_by: "connector", reason: e.reason, ms: Date.now() - t0 });
      return persistDiscoveryError(ctx.tenant_id, type, new Error("refused by your connector"), generation);
    }
    await finalizeAudit(id, ctx, { result: "failed", row_count: 0, reason: failureReason(e), ms: Date.now() - t0 });
    if (e instanceof DbSourceChangedError) return { ok: false, discovery_error: "source_changed" };
    return persistDiscoveryError(ctx.tenant_id, type, e, generation);
  }
}
