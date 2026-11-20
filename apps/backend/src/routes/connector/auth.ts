import type { NextFunction, Request, Response } from "express";
import { preTenantRpc } from "@/services/tenant-client";
import { logEvent } from "@/services/logging/logEvent";
import { isConnectorToken, sha256Hex } from "@/services/data-gateway/connector/token";
import { onRevoke } from "@/services/data-gateway/connector/wakeup";

export type ConnectorCaller = { tenant_id: string; connector_id: string };

export const TOKEN_CACHE_TTL_MS = 30_000;
const TOKEN_CACHE_MAX = 50_000;
const cache = new Map<string, { caller: ConnectorCaller; exp: number }>();
onRevoke((tenant_id) => {
  for (const [k, v] of cache) if (v.caller.tenant_id === tenant_id) cache.delete(k);
});

export function getConnector(req: Request): ConnectorCaller {
  const c = (req as Request & { zaviConnector?: ConnectorCaller }).zaviConnector;
  if (!c) throw new Error("zaviConnector missing: requireConnectorToken not mounted");
  return c;
}

const lastLogged = new Map<string, number>();
function sampledAuthLog(stage: string): void {
  const now = Date.now();
  if (now - (lastLogged.get(stage) ?? 0) < 60_000) return;
  lastLogged.set(stage, now);
  void logEvent({ level: "warn", source: "db-connector.auth", code: "connector_auth_failed", meta: { stage } });
}

export type ResolveDeps = { preTenantRpc: typeof preTenantRpc; now?: () => number };

export async function resolveConnectorToken(raw: string, deps: ResolveDeps = { preTenantRpc: (...a) => preTenantRpc(...a) }): Promise<ConnectorCaller | "unknown" | "error"> {
  const now = (deps.now ?? Date.now)();
  const hash = sha256Hex(raw);
  const hit = cache.get(hash);
  if (hit && hit.exp > now) return hit.caller;
  if (hit) cache.delete(hash);
  try {
    const { data, error } = await deps.preTenantRpc("db_connector_resolve_token", { p_token_hash: hash });
    if (error) return "error";
    const row = Array.isArray(data) ? (data[0] as { tenant_id?: string; connector_id?: string } | undefined) : undefined;
    if (!row?.tenant_id || !row.connector_id) return "unknown";
    const caller = { tenant_id: row.tenant_id, connector_id: row.connector_id };
    if (cache.size >= TOKEN_CACHE_MAX) {
      const oldest = cache.keys().next().value as string | undefined;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(hash, { caller, exp: now + TOKEN_CACHE_TTL_MS });
    return caller;
  } catch {
    return "error";
  }
}

export function requireConnectorToken(deps?: ResolveDeps) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const hdr = req.headers.authorization ?? "";
    const raw = hdr.startsWith("Bearer ") ? hdr.slice(7).trim() : "";
    if (!isConnectorToken(raw)) {
      sampledAuthLog(raw ? "malformed" : "missing");
      res.status(401).json({ error: { code: "unauthorized" } });
      return;
    }
    const caller = await resolveConnectorToken(raw, deps);
    if (caller === "error") {
      sampledAuthLog("resolve_error");
      res.status(503).json({ error: { code: "unavailable" } });
      return;
    }
    if (caller === "unknown") {
      sampledAuthLog("unknown_or_revoked");
      res.status(401).json({ error: { code: "unauthorized" } });
      return;
    }
    (req as Request & { zaviConnector?: ConnectorCaller }).zaviConnector = caller;
    next();
  };
}

export function _resetAuthLogSampling(): void {
  lastLogged.clear();
  cache.clear();
}
