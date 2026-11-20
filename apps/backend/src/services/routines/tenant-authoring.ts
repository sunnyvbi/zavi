
import { serviceClient } from "@/services/supabase";
import {
  validateRoutineSpec,
  ROUTINE_SPEC_CURRENT_VERSION,
} from "./routine-spec";
import { promoteCandidate } from "./promote-gate";
import { approveRoutineCandidate, type RoutineApproveResult } from "./routine-candidates";
import { validateRoutineArgs } from "./arg-validate";
import { discoverToolsForTenant } from "@/services/mcp/discovery";

export interface AuthorTenantRoutineInput {
  tenant_id: string;
  agent_slug: string;
  routine_name: string;
  routine_spec: unknown;
  granted_tool_names: string[];
  created_by: string;
}

export interface AuthorTenantRoutineResult {
  ok: boolean;
  id?: string;
  reason?: string;
}

export type RoutineToolResolver = (
  tenant_id: string,
  granted_tool_names: string[],
  agent_slug: string,
) => Promise<Array<{ name: string; input_schema: unknown }>>;

const defaultResolveTools: RoutineToolResolver = async (t, g, a) =>
  (await discoverToolsForTenant(t, g, a)).tools;

export async function authorTenantRoutine(
  input: AuthorTenantRoutineInput,
  sb = serviceClient(),
  resolveTools: RoutineToolResolver = defaultResolveTools,
): Promise<AuthorTenantRoutineResult> {
  const { tenant_id, agent_slug, created_by } = input;
  if (!tenant_id || !agent_slug || !created_by) {
    return { ok: false, reason: "missing tenant_id/agent_slug/created_by" };
  }
  const routine_name = (input.routine_name ?? "").trim();
  if (!routine_name) return { ok: false, reason: "routine_name is required" };

  const specCheck = validateRoutineSpec(input.routine_spec);
  if (!specCheck.ok) {
    return { ok: false, reason: `invalid_routine_spec: ${specCheck.reason}` };
  }

  const granted = Array.isArray(input.granted_tool_names)
    ? input.granted_tool_names.filter((t): t is string => typeof t === "string" && t.length > 0)
    : [];
  if (granted.length === 0) {
    return { ok: false, reason: "granted_tool_names must be a non-empty list of the agent's tools" };
  }

  let liveTools;
  try {
    liveTools = await resolveTools(tenant_id, granted, agent_slug);
  } catch (e) {
    return { ok: false, reason: `tool_resolution_failed: ${(e as Error).message}` };
  }
  const schemaByTool = new Map<string, unknown>(
    liveTools.map((t) => [t.name, t.input_schema] as const),
  );
  const argCheck = validateRoutineArgs(specCheck.spec.steps, schemaByTool);
  if (!argCheck.ok) {
    return { ok: false, reason: `invalid_step_args: ${argCheck.reason}` };
  }

  const { data, error } = await sb
    .from("tenant_routines")
    .insert({
      tenant_id,
      agent_slug,
      routine_name,
      routine_spec: specCheck.spec,
      spec_version: ROUTINE_SPEC_CURRENT_VERSION,
      granted_tool_names: granted,
      status: "candidate",
      provenance_origin: "tenant_authored",
      founder_blessed: false,
      created_by,
    })
    .select("id")
    .maybeSingle<{ id: string }>();
  if (error || !data) {
    return { ok: false, reason: `insert_failed: ${error?.message ?? "no row returned"}` };
  }
  return { ok: true, id: data.id };
}

export async function approveTenantRoutine(
  id: string,
  tenant_id: string,
  decided_by: string,
  sb = serviceClient(),
): Promise<RoutineApproveResult> {
  const { data: rowRaw, error: loadErr } = await sb
    .from("tenant_routines")
    .select("id, tenant_id, status, provenance_origin")
    .eq("id", id)
    .eq("tenant_id", tenant_id)
    .maybeSingle<{ id: string; tenant_id: string; status: string; provenance_origin: string | null }>();
  if (loadErr) return { approved: false, reason: `load_failed: ${loadErr.message}`, candidate_id: id };
  if (!rowRaw) return { approved: false, reason: "routine not found for this tenant", candidate_id: id };
  if (rowRaw.provenance_origin !== "tenant_authored") {
    return { approved: false, reason: "not_tenant_authored: use the staff route for machine-distilled routines", candidate_id: id };
  }

  if (rowRaw.status === "candidate") {
    const promo = await promoteCandidate(id);
    if (promo.outcome === "rejected") {
      return { approved: false, reason: `promote_rejected: ${promo.reason}`, candidate_id: id };
    }
  }

  const result = await approveRoutineCandidate(id, decided_by);

  if (result.approved) {
    await sb
      .from("tenant_routines")
      .update({ approved_by: decided_by, approved_at: new Date().toISOString() })
      .eq("id", id)
      .eq("tenant_id", tenant_id)
      .eq("status", "approved");
  }
  return result;
}
