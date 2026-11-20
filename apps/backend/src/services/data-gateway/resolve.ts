import { transportOf } from "./direct/tls";
import { getSecret } from "@/services/secrets/vault";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { ExpectedToolError } from "@/services/tools/types";
import { logEvent } from "@/services/logging/logEvent";
import { getCatalog, hintsToSchemaMapShape, type ResolvedCatalog } from "@/services/tools/operator-db/catalog";
import { applyConfirmedMap, getConfirmedMapping, type CanonicalMap } from "@/services/tools/operator-db/mapping";
import type { OperatorDbConfig, OperatorDbType } from "@/services/tools/operator-db/types";
import { effectivePolicy, type Policy } from "@zavi/shared/db-guard";
import type { GatewayMode } from "./types";

export const NOT_CONNECTED_MESSAGE =
  "Your database is not connected for this workspace. Connect it from Connectors > Integrations > Your database.";

export type DbAccess = {
  tenant_id: string;
  mode: GatewayMode;
  dialect: OperatorDbType;
  config: OperatorDbConfig;
  catalog: ResolvedCatalog;
  policy: Policy;
  connectionString: string | null;
  database: string | null;
  generation: number;
  confirmed_map?: CanonicalMap | null;
};

export async function readDbGeneration(tenant_id: string): Promise<number> {
  const { data, error } = (await tenantClient(asTenantId(tenant_id)).from("tenant_db_generation").select("generation").maybeSingle()) as {
    data: { generation?: number | string } | null;
    error: { message?: string } | null;
  };
  if (error) throw new ExpectedToolError("operator_db_config_read_failed", "Could not read the database settings for this workspace.");
  return Number(data?.generation ?? 0);
}

export function databaseFromConnection(conn: string | null): string | null {
  if (!conn) return null;
  try {
    const p = decodeURIComponent(new URL(conn).pathname.replace(/^\//, "").split("/")[0] ?? "");
    return p || null;
  } catch {
    return null;
  }
}

export type ConfigRow = {
  type: string;
  mode: string | null;
  connection_secret_key: string;
  disabled_tables: string[] | null;
  hidden_fields: string[] | null;
  unhidden_fields: string[] | null;
  auto_hide: boolean | null;
  settings_confirmed_at: string | null;
  policy_catalog_hash: string | null;
  transport?: string | null;
};

export function notConnected(): ExpectedToolError {
  return new ExpectedToolError("operator_db_not_connected", NOT_CONNECTED_MESSAGE, {
    next_step: "operator_action",
    unblockers: ["An owner or admin connects the database at Connectors > Integrations > Your database"],
  });
}

export function notDiscovered(failed: boolean): ExpectedToolError {
  return failed
    ? new ExpectedToolError("operator_db_not_discovered", "Database schema discovery did not complete. Reconnect the database to retry.", {
        next_step: "operator_action",
        unblockers: ["Operator reconnects the database to re-run discovery"],
      })
    : new ExpectedToolError("operator_db_not_discovered", "Database schema is still being discovered. This is automatic — retry shortly.", {
        next_step: "auto",
        unblockers: ["Automatic schema discovery in progress / will retry"],
      });
}

export async function readDbConfig(tenant_id: string): Promise<ConfigRow | null> {
  const { data, error } = (await tenantClient(asTenantId(tenant_id))
    .from("tenant_db_config")
    .select(
      "type, mode, connection_secret_key, disabled_tables, hidden_fields, unhidden_fields, auto_hide, settings_confirmed_at, policy_catalog_hash, transport",
    )
    .maybeSingle()) as { data: ConfigRow | null; error: { message?: string } | null };
  if (error) throw new ExpectedToolError("operator_db_config_read_failed", "Could not read the database settings for this workspace.");
  return data;
}

export async function recordDbTransport(tenant_id: string, dialect: string, connectionString: string, current?: string | null): Promise<void> {
  const t = transportOf(dialect, connectionString);
  if (!t || t === current) return;
  try {
    await tenantClient(asTenantId(tenant_id)).from("tenant_db_config").update({ transport: t }).eq("mode", "direct");
  } catch {
  }
}

const FALLBACK_LOG_WINDOW_MS = 60 * 60 * 1000;
const fallbackLogged = new Map<string, number>();

export function noteLastGoodFallback(tenant_id: string, rescanFailedAt: string | null | undefined, now: number = Date.now()): boolean {
  const last = fallbackLogged.get(tenant_id);
  if (last !== undefined && now - last < FALLBACK_LOG_WINDOW_MS) return false;
  fallbackLogged.set(tenant_id, now);
  if (fallbackLogged.size > 10_000) fallbackLogged.delete(fallbackLogged.keys().next().value as string);
  void logEvent({
    level: "warn",
    source: "operator-db.discovery",
    code: "serving_last_good_catalog",
    tenant_id,
    meta: rescanFailedAt && Number.isFinite(Date.parse(rescanFailedAt)) ? { rescan_age_ms: Math.max(0, now - Date.parse(rescanFailedAt)) } : {},
  }).catch(() => undefined);
  return true;
}

export function __resetLastGoodFallbackLog(): void {
  fallbackLogged.clear();
}

export async function loadDbAccess(
  tenant_id: string,
  deps: { getSecret?: typeof getSecret; withSecret?: boolean } = {},
): Promise<DbAccess> {
  const generation = await readDbGeneration(tenant_id);
  const row = await readDbConfig(tenant_id);
  if (!row) throw notConnected();

  const resolved = await getCatalog(tenant_id);
  if (!resolved || resolved.discovery_error || resolved.catalog.tables.length === 0) {
    throw notDiscovered(Boolean(resolved?.discovery_error));
  }
  if (resolved.rescan_failed_at) noteLastGoodFallback(tenant_id, resolved.rescan_failed_at);

  const hintMap = hintsToSchemaMapShape(resolved.hints);
  const confirmed = resolved.catalog_hash ? await getConfirmedMapping(tenant_id, resolved.catalog_hash) : null;
  const dialect = (resolved.dialect ?? (row.type as OperatorDbType)) as OperatorDbType;
  const config: OperatorDbConfig = {
    type: dialect,
    connection_secret_key: row.connection_secret_key,
    schema_map: applyConfirmedMap(hintMap, confirmed?.confirmed_map),
  };

  const unhiddenValid = Boolean(row.policy_catalog_hash) && row.policy_catalog_hash === resolved.catalog_hash;
  const policy = effectivePolicy(
    {
      auto_hide: row.auto_hide ?? false,
      hidden_fields: row.hidden_fields ?? [],
      unhidden_fields: unhiddenValid ? (row.unhidden_fields ?? []) : [],
      disabled_tables: row.disabled_tables ?? [],
    },
    resolved.catalog,
    dialect,
  );

  const mode: GatewayMode = row.mode === "connector" ? "connector" : "direct";
  let connectionString: string | null = null;
  if (mode === "direct" && deps.withSecret !== false) {
    connectionString = await (deps.getSecret ?? getSecret)(tenant_id, row.connection_secret_key);
    if (!connectionString) {
      throw new ExpectedToolError("operator_db_secret_missing", "The saved database login is missing. Reconnect the database.");
    }
  }
  return {
    tenant_id,
    mode,
    dialect,
    config,
    catalog: resolved,
    policy,
    connectionString,
    database: dialect === "mysql" ? databaseFromConnection(connectionString) : null,
    generation,
    confirmed_map: confirmed?.confirmed_map ?? null,
  };
}
