import type { Request, Response } from "express";
import { requireAuth, type AuthedRequest } from "@/services/auth/middleware";
import { isTenantAdminOrOwner } from "@/services/auth/members";
import { serverClientFromBearer } from "@/services/supabase";
import { logEvent } from "@/services/logging/logEvent";
import { createPairCode } from "@/services/data-gateway/connector/pairing";
import { ageText, isOnline, readActiveConnector, type ConnectorRow } from "@/services/data-gateway/connector/status";
import { LOCAL_REMOVAL_COMMAND } from "@/services/data-gateway/connector/token";
import { publishRevoke } from "@/services/data-gateway/connector/wakeup";

function noStore(res: Response): void {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Pragma", "no-cache");
}

function notAdmin(res: Response): void {
  res.status(403).json({ error: { code: "not_admin", message: "Only owners and admins can manage the Zavi Connector." } });
}

async function authWithRole(req: Request, res: Response): Promise<{ auth: AuthedRequest; admin: boolean } | null> {
  const auth = await requireAuth(req, res);
  if (!auth) return null;
  const admin = await isTenantAdminOrOwner(serverClientFromBearer(auth.access_token), auth.user_id, auth.tenant_id);
  return { auth, admin };
}

export async function connectorPairCode(req: Request, res: Response): Promise<void> {
  const a = await authWithRole(req, res);
  if (!a) return;
  if (!a.admin) return notAdmin(res);
  noStore(res);
  const client = serverClientFromBearer(a.auth.access_token);
  try {
    const out = await createPairCode((name, args) => client.rpc(name, args), a.auth.tenant_id);
    res.json(out);
  } catch (e) {
    if ((e as { code?: unknown }).code === "42501") return notAdmin(res);
    await logEvent({ level: "error", source: "db-connector.pair", code: "pair_code_create_failed", tenant_id: a.auth.tenant_id });
    res.status(500).json({ error: { code: "pair_code_failed", message: "Could not make a pairing code. Try again." } });
  }
}

export type ConnectorStatusBody =
  | { paired: false }
  | {
      paired: true;
      online: boolean;
      machine: string | null;
      version: string | null;
      dialect: string | null;
      last_seen_at: string | null;
      last_seen_age: string | null;
      paired_at: string;
      pairing_id: string | null;
      rules?: ConnectorRow["rules"];
      skipped?: { feature: string; at: string; emailed: boolean } | null;
    };

export function statusBody(row: ConnectorRow | null, admin: boolean, now = Date.now()): ConnectorStatusBody {
  if (!row) return { paired: false };
  const online = isOnline(row, now);
  const base = {
    paired: true as const,
    online,
    machine: row.machine_name,
    version: row.version,
    dialect: row.dialect,
    last_seen_at: row.last_seen_at,
    last_seen_age: ageText(row.last_seen_at, now),
    paired_at: row.created_at,
    pairing_id: row.pair_code_id ?? null,
  };
  if (!admin) return base;
  const skippedThisOutage =
    !online && row.last_skipped_at && row.last_skipped_feature && (!row.last_seen_at || Date.parse(row.last_skipped_at) >= Date.parse(row.last_seen_at));
  return {
    ...base,
    rules: row.rules,
    skipped: skippedThisOutage ? { feature: row.last_skipped_feature!, at: row.last_skipped_at!, emailed: Boolean(row.offline_notified_at) } : null,
  };
}

export async function connectorStatus(req: Request, res: Response): Promise<void> {
  const a = await authWithRole(req, res);
  if (!a) return;
  try {
    res.json(statusBody(await readActiveConnector(a.auth.tenant_id), a.admin));
  } catch {
    res.status(500).json({ error: { code: "connector_status_unavailable", message: "Could not load the connector status." } });
  }
}

export async function connectorRemove(req: Request, res: Response): Promise<void> {
  const a = await authWithRole(req, res);
  if (!a) return;
  if (!a.admin) return notAdmin(res);
  const { data, error } = await serverClientFromBearer(a.auth.access_token).rpc("remove_db_connector", { p_tenant_id: a.auth.tenant_id });
  if (error) {
    if (error.code === "42501") return notAdmin(res);
    await logEvent({ level: "error", source: "db-connector.remove", code: "connector_remove_failed", tenant_id: a.auth.tenant_id });
    res.status(500).json({ error: { code: "connector_remove_failed", message: "Could not remove the connector. Try again." } });
    return;
  }
  const out = (data ?? {}) as { removed?: boolean; machine?: string | null };
  await publishRevoke(a.auth.tenant_id).catch(() => undefined);
  await logEvent({ level: "info", source: "db-connector.remove", code: "connector_removed", tenant_id: a.auth.tenant_id });
  res.json({ ok: true, removed: Boolean(out.removed), machine: out.machine ?? null, removal_command: LOCAL_REMOVAL_COMMAND });
}
