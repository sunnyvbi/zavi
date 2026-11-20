
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";

export const EXEC_STAGES = ["created", "content_set", "send_requested", "sent"] as const;
export type ExecStage = (typeof EXEC_STAGES)[number];

export type ExecProgress = { campaign_id: string; stage: ExecStage };

export function toExecProgress(raw: unknown): ExecProgress | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.campaign_id === "string" && r.campaign_id ? r.campaign_id : null;
  const stage = (EXEC_STAGES as readonly string[]).includes(r.stage as string) ? (r.stage as ExecStage) : null;
  return id && stage ? { campaign_id: id, stage } : null;
}

export function sendMayHaveHappened(p: ExecProgress | null): boolean {
  return p?.stage === "send_requested" || p?.stage === "sent";
}

export async function readExecProgress(tenantId: string, actionId: string): Promise<ExecProgress | null> {
  const { data, error } = await tenantClient(asTenantId(tenantId))
    .from("channel_actions")
    .select("exec_progress")
    .eq("id", actionId)
    .maybeSingle();
  if (error) throw new Error(`exec_progress read failed: ${error.message}`);
  return toExecProgress((data as { exec_progress?: unknown } | null)?.exec_progress);
}

export async function recordExecProgress(
  tenantId: string,
  actionId: string,
  claimId: string,
  progress: ExecProgress,
  rpc: typeof tenantRpc = tenantRpc,
): Promise<boolean> {
  const { data, error } = await rpc(asTenantId(tenantId), "record_channel_action_exec_progress", {
    p_action_id: actionId,
    p_claim_id: claimId,
    p_progress: progress,
  });
  if (error) throw new Error(`record_channel_action_exec_progress failed: ${error.message}`);
  return (data as { ok?: boolean } | null)?.ok === true;
}
