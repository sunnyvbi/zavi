
import { staffCrossTenantClient } from "@/services/tenant-client";

export const GAP_DIMENSIONS = [
  "verified_brain",
  "product_url",
  "connectors",
  "goal_measurable",
  "deliverable",
  "founder_engaged",
] as const;
export type GapDimension = (typeof GAP_DIMENSIONS)[number];

export const ACTION_KINDS = [
  "brain_correct",
  "draft_send",
  "connector_nudge",
  "deliverable",
  "dispatch",
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export interface FdeEventInput {
  tenant_id: string;
  action_kind: ActionKind;
  staff_user_id?: string | null;
  staff_email?: string | null;
  gap_dimension?: GapDimension | null;
  readiness_at?: string | null;
  before_score?: number | null;
  after_score?: number | null;
  input_ref?: string | null;
  work_product_ref?: string | null;
  escalation_category?: string | null;
  agent_training_hint?: string | null;
}

export interface FdeEvent extends FdeEventInput {
  id: string;
  folded_into_prompt: boolean;
  folded_at: string | null;
  created_at: string;
}

export async function logFdeEvent(input: FdeEventInput): Promise<FdeEvent> {
  if (!input.tenant_id?.trim()) throw new Error("tenant_id required");

  const { data, error } = await staffCrossTenantClient("FDE training capture: record one staff rescue")
    .from("fde_training_events")
    .insert({
      tenant_id: input.tenant_id,
      action_kind: input.action_kind,
      staff_user_id: input.staff_user_id ?? null,
      staff_email: input.staff_email ?? null,
      gap_dimension: input.gap_dimension ?? null,
      readiness_at: input.readiness_at ?? null,
      before_score: input.before_score ?? null,
      after_score: input.after_score ?? null,
      input_ref: input.input_ref ?? null,
      work_product_ref: input.work_product_ref ?? null,
      escalation_category: input.escalation_category ?? null,
      agent_training_hint: input.agent_training_hint ?? null,
    })
    .select("*")
    .single();

  if (error) throw new Error(`fde_training_events insert failed: ${error.message}`);
  return data as FdeEvent;
}

export async function listFdeEvents(tenant_id: string, limit = 50): Promise<FdeEvent[]> {
  const { data, error } = await staffCrossTenantClient("FDE cockpit: read one tenant's rescue history")
    .from("fde_training_events")
    .select("*")
    .eq("tenant_id", tenant_id)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(`fde_training_events read failed: ${error.message}`);
  return (data ?? []) as FdeEvent[];
}

export async function fdeTouchCounts(tenant_ids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (tenant_ids.length === 0) return out;

  const { data, error } = await staffCrossTenantClient("FDE cockpit: count rescues across tenants")
    .from("fde_training_events")
    .select("tenant_id")
    .in("tenant_id", tenant_ids);

  if (error) throw new Error(`fde_training_events count failed: ${error.message}`);
  for (const row of (data ?? []) as { tenant_id: string }[]) {
    out.set(row.tenant_id, (out.get(row.tenant_id) ?? 0) + 1);
  }
  return out;
}
