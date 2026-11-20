
import { serviceClient } from "@/services/supabase";
import type { CommsChannel } from "@/services/comms/safety-net";

export type OutboundChannel = CommsChannel;

export type QualificationState =
  | "new"
  | "qualified"
  | "contacted"
  | "engaged"
  | "replied"
  | "unsubscribed"
  | "disqualified";

export type SequenceState =
  | "idle"
  | "active"
  | "paused"
  | "stopped"
  | "completed";

export interface OutboundProspect {
  id: string;
  tenant_id: string;
  name: string | null;
  company: string | null;
  channel: OutboundChannel;
  handle: string;
  dedupe_key: string;
  icp_fit_score: number | null;
  qualification_state: QualificationState;
  source: string | null;
  sequence_id: string | null;
  sequence_step: number;
  next_action_at: string | null;
  sequence_state: SequenceState;
  last_contacted_at: string | null;
  meta: Record<string, unknown> | null;
}

export interface UpsertResult {
  id: string;
  inserted: boolean;
  dedupe_key: string;
}

export interface RpcOk {
  ok: boolean;
  reason?: string;
}

export interface AdvanceResult extends RpcOk {
  completed?: boolean;
  step?: number;
  wait_hours?: number;
}

export type StopReason = "replied" | "unsubscribed" | "manual";

export async function upsertProspect(
  tenantId: string,
  channel: OutboundChannel,
  handle: string,
  opts?: {
    name?: string;
    company?: string;
    icpFitScore?: number;
    source?: string;
    meta?: Record<string, unknown>;
  },
): Promise<UpsertResult> {
  const { data, error } = await serviceClient().rpc("upsert_outbound_prospect", {
    p_tenant_id: tenantId,
    p_channel: channel,
    p_handle: handle,
    p_name: opts?.name ?? null,
    p_company: opts?.company ?? null,
    p_icp_fit_score: opts?.icpFitScore ?? null,
    p_source: opts?.source ?? null,
    p_meta: opts?.meta ?? null,
  });
  if (error) throw new Error(`upsert_outbound_prospect failed: ${error.message}`);
  return data as UpsertResult;
}

export async function enrollProspect(
  tenantId: string,
  prospectId: string,
  sequenceId: string,
): Promise<RpcOk> {
  const { data, error } = await serviceClient().rpc("enroll_outbound_prospect", {
    p_tenant_id: tenantId,
    p_prospect_id: prospectId,
    p_sequence_id: sequenceId,
  });
  if (error) throw new Error(`enroll_outbound_prospect failed: ${error.message}`);
  return data as RpcOk;
}

export async function claimDueProspects(limit = 100): Promise<OutboundProspect[]> {
  const { data, error } = await serviceClient().rpc(
    "claim_due_outbound_prospects",
    { p_limit: limit },
  );
  if (error) throw new Error(`claim_due_outbound_prospects failed: ${error.message}`);
  return (data as OutboundProspect[]) ?? [];
}

export async function advanceProspect(
  tenantId: string,
  prospectId: string,
): Promise<AdvanceResult> {
  const { data, error } = await serviceClient().rpc("advance_outbound_prospect", {
    p_tenant_id: tenantId,
    p_prospect_id: prospectId,
  });
  if (error) throw new Error(`advance_outbound_prospect failed: ${error.message}`);
  return data as AdvanceResult;
}

export async function stopProspect(
  tenantId: string,
  prospectId: string,
  reason: StopReason,
): Promise<RpcOk> {
  const { data, error } = await serviceClient().rpc("stop_outbound_prospect", {
    p_tenant_id: tenantId,
    p_prospect_id: prospectId,
    p_reason: reason,
  });
  if (error) throw new Error(`stop_outbound_prospect failed: ${error.message}`);
  return data as RpcOk;
}
