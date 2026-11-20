
import { coverageFromRaw, normalizeRawCatalog } from "@/services/tools/operator-db/discovery";
import { heuristicHints } from "@/services/tools/operator-db/discovery/hints";
import { introspectPostgres, introspectMysql, introspectMongo } from "@/services/data-gateway";
import { callOperatorDbTool } from "@/services/mcp/internal/operator-db";
import type { OperatorDbType } from "@/services/tools/operator-db/types";
import { dbUrlFor, type EvalDialect } from "../env";
import { currentTenant, EVAL_TENANT_ID, setCurrentTenant, type EvalTenant } from "./current";

export { currentTenant, EVAL_TENANT_ID, type EvalTenant };

const cache = new Map<string, EvalTenant>();

export async function installEvalTenant(dialect: EvalDialect, shape: string): Promise<EvalTenant> {
  const key = `${dialect}:${shape}`;
  const hit = cache.get(key);
  if (hit) {
    setCurrentTenant(hit);
    return hit;
  }

  const connectionString = dbUrlFor(dialect, shape);
  if (!connectionString) throw new Error(`no connection configured for ${dialect}`);

  const raw =
    dialect === "postgres"
      ? await introspectPostgres(connectionString)
      : dialect === "mysql"
        ? await introspectMysql(connectionString)
        : await introspectMongo(connectionString);

  const catalog = normalizeRawCatalog(raw);
  const tenant: EvalTenant = {
    tenant_id: EVAL_TENANT_ID,
    dialect,
    shape,
    connectionString,
    catalogRow: {
      dialect: (dialect === "mongodb" ? "mongodb" : dialect) as OperatorDbType,
      catalog,
      hints: heuristicHints(catalog),
      catalog_hash: `eval-${dialect}-${shape}`,
      coverage: coverageFromRaw(raw),
      discovery_error: null,
      updated_at: new Date().toISOString(),
    },
  };
  cache.set(key, tenant);
  setCurrentTenant(tenant);
  return tenant;
}

export function runTool(toolName: string, args: unknown) {
  return callOperatorDbTool(currentTenant().tenant_id, toolName, args);
}
