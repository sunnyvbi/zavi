
import { serviceClient, serverClientFromBearer } from "@/services/supabase";

export class ScheduleValidationError extends Error {}
export class ScheduleForbiddenError extends Error {}

export type AgentSchedule = {
  agent_slug: string;
  cron_expression: string;
  enabled: boolean;
  last_fired_at: string | null;
  payload_template: Record<string, unknown> | null;
  timezone: string | null;
};

export async function getSchedule(
  tenant_id: string,
  agent_slug: string,
): Promise<AgentSchedule | null> {
  const { data, error } = await serviceClient()
    .from("tenant_agent_schedules")
    .select("agent_slug, cron_expression, enabled, last_fired_at, payload_template, timezone")
    .eq("tenant_id", tenant_id)
    .eq("agent_slug", agent_slug)
    .maybeSingle<AgentSchedule>();
  if (error) throw new Error(error.message);
  return data ?? null;
}

function mapRpcError(code: string | undefined, message: string): Error {
  if (code === "42501") return new ScheduleForbiddenError(message);
  if (code === "22023") return new ScheduleValidationError(message);
  return new Error(message);
}

export async function upsertSchedule(
  access_token: string,
  tenant_id: string,
  agent_slug: string,
  cron_expression: string,
  enabled: boolean,
  payload_template?: Record<string, unknown> | null,
  timezone?: string | null,
): Promise<void> {
  const { error } = await serverClientFromBearer(access_token).rpc(
    "upsert_agent_schedule",
    {
      p_tenant_id: tenant_id,
      p_agent_slug: agent_slug,
      p_cron_expression: cron_expression,
      p_enabled: enabled,
      p_payload_template: payload_template ?? null,
      p_timezone: timezone ?? null,
    },
  );
  if (error) throw mapRpcError(error.code, error.message);
}

export async function deleteSchedule(
  access_token: string,
  tenant_id: string,
  agent_slug: string,
): Promise<void> {
  const { error } = await serverClientFromBearer(access_token).rpc(
    "delete_agent_schedule",
    { p_tenant_id: tenant_id, p_agent_slug: agent_slug },
  );
  if (error) throw mapRpcError(error.code, error.message);
}
