import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { logEvent } from "@/services/logging/logEvent";
import { AuditUnavailableError, DbSourceChangedError, type GatewayContext, type GatewayMode } from "./types";

export const MAX_QUERY_TEXT = 20_000;

export type AuditOperation = "read" | "summary" | "structure_scan" | "connection_test";

export type AuditEntry = {
  ctx: GatewayContext;
  mode: GatewayMode;
  dialect: string;
  operation: AuditOperation;
  query_text: string;
  tables: string[];
  generation?: number | null;
};

function baseRow(e: AuditEntry): Record<string, unknown> {
  const c = e.ctx.caller;
  return {
    caller_kind: c.kind,
    agent_slug: c.kind === "agent" ? c.agent_slug : null,
    run_id: c.kind === "agent" ? c.run_id : null,
    tool_name: c.kind === "agent" ? c.tool_name : null,
    feature: c.kind === "agent" ? null : c.feature,
    user_id: c.kind === "person" ? c.user_id : null,
    mode: e.mode,
    dialect: e.dialect,
    operation: e.operation,
    query_text: (e.query_text || "(empty)").slice(0, MAX_QUERY_TEXT),
    tables: e.tables.slice(0, 50),
  };
}

export async function reserveAudit(e: AuditEntry): Promise<string> {
  const row = baseRow(e);
  let res: { data: unknown; error: unknown };
  try {
    res = await tenantRpc(asTenantId(e.ctx.tenant_id), "reserve_data_access", {
      p_generation: e.generation ?? null,
      p_caller_kind: row.caller_kind,
      p_agent_slug: row.agent_slug,
      p_run_id: row.run_id,
      p_tool_name: row.tool_name,
      p_feature: row.feature,
      p_user_id: row.user_id,
      p_mode: row.mode,
      p_dialect: row.dialect,
      p_operation: row.operation,
      p_query_text: row.query_text,
      p_tables: row.tables,
    });
  } catch {
    throw new AuditUnavailableError();
  }
  if ((res.error as { code?: string } | null)?.code === "ZD412") throw new DbSourceChangedError();
  const id = typeof res.data === "string" ? res.data : null;
  if (res.error || !id) throw new AuditUnavailableError();
  return id;
}

export type AuditFinal = {
  result: "allowed" | "refused" | "failed";
  row_count: number;
  refused_by?: "zavi" | "connector";
  reason?: string;
  totals_only?: boolean;
  ms: number;
  generation?: number | null;
};

export function sentToAi(ctx: GatewayContext, result: AuditFinal["result"]): boolean {
  return ctx.caller.kind === "agent" && result === "allowed";
}

export async function finalizeAudit(id: string, ctx: GatewayContext, f: AuditFinal): Promise<void> {
  const allowed = f.result === "allowed";
  let outcome: unknown;
  try {
    const { data, error } = await tenantRpc(asTenantId(ctx.tenant_id), "finalize_data_access", {
      p_id: id,
      p_generation: f.generation ?? null,
      p_result: f.result,
      p_row_count: Math.max(0, Math.floor(f.row_count)),
      p_sent_to_ai: sentToAi(ctx, f.result),
      p_refused_by: f.refused_by ?? null,
      p_reason: f.reason ? f.reason.slice(0, 500) : null,
      p_totals_only: f.totals_only ?? false,
      p_ms: Math.max(0, Math.round(f.ms)),
    });
    if (error) throw error;
    outcome = data;
  } catch (err) {
    await logEvent({ level: allowed ? "error" : "warn", source: "data-gateway.audit", code: "audit_finalize_failed", error: err, tenant_id: ctx.tenant_id });
    if (allowed) throw new AuditUnavailableError();
    return;
  }
  if (outcome === "source_changed") {
    await logEvent({ level: "info", source: "data-gateway.audit", code: "read_discarded_source_changed", tenant_id: ctx.tenant_id });
    if (allowed) throw new DbSourceChangedError();
    return;
  }
  if (outcome !== "ok") {
    await logEvent({ level: allowed ? "error" : "warn", source: "data-gateway.audit", code: "audit_finalize_failed", tenant_id: ctx.tenant_id, meta: { code: String(outcome) } });
    if (allowed) throw new AuditUnavailableError();
  }
}

export async function writeRefusalAudit(
  e: AuditEntry & { refused_by: "zavi" | "connector"; reason: string; totals_only?: boolean },
): Promise<string | null> {
  try {
    const { data, error } = await tenantClient(asTenantId(e.ctx.tenant_id))
      .from("data_access_log")
      .insert({
        ...baseRow(e),
        result: "refused",
        finished_at: new Date().toISOString(),
        refused_by: e.refused_by,
        reason: e.reason.slice(0, 500),
        totals_only: e.totals_only ?? false,
        sent_to_ai: false,
      })
      .select("id")
      .single();
    if (error || !data) return null;
    return (data as { id: string }).id;
  } catch {
    return null;
  }
}
