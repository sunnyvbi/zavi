
import { asTenantId, tenantRpc } from "@/services/tenant-client";
import { isRunFlatBilled } from "./flat-pricing";

export type RecordLateResult = "recorded" | "already" | "run_finished" | "no_run";

export async function recordLateToolCharge(input: {
  tenantId: string;
  runId: string;
  toolCallId: string;
  cardId?: string | null;
  reservedUsd: number;
}): Promise<RecordLateResult> {
  const { tenantId, runId, toolCallId, cardId, reservedUsd } = input;
  if (!Number.isFinite(reservedUsd) || reservedUsd <= 0) {
    throw new Error(`recordLateToolCharge: reservedUsd must be positive (got ${reservedUsd})`);
  }
  const { data, error } = await tenantRpc(asTenantId(tenantId), "record_late_tool_charge", {
    p_run_id: runId,
    p_tool_call_id: toolCallId,
    p_card_id: cardId ?? null,
    p_reserved_usd: reservedUsd,
  });
  if (error) throw new Error(`recordLateToolCharge: ${error.message}`);
  return data as RecordLateResult;
}

export type SettleLateResult = {
  status: "refunded" | "nothing_to_refund" | "already" | "pending" | "not_found";
  credits: number;
  daily?: number;
  included?: number;
  purchased?: number;
  forfeited?: number;
};

export async function settleLateToolCharge(input: {
  tenantId: string;
  runId: string;
  toolCallId: string;
  actualUsd: number;
}): Promise<SettleLateResult> {
  const { tenantId, runId, toolCallId, actualUsd } = input;
  if (!Number.isFinite(actualUsd) || actualUsd < 0) {
    throw new Error(`settleLateToolCharge: actualUsd must be a finite non-negative number (got ${actualUsd})`);
  }
  const settleUsd = (await isRunFlatBilled(tenantId, runId)) ? Number.MAX_SAFE_INTEGER : actualUsd;
  const { data, error } = await tenantRpc(asTenantId(tenantId), "refund_tool_charge", {
    p_run_id: runId,
    p_tool_call_id: toolCallId,
    p_actual_usd: settleUsd,
  });
  if (error) throw new Error(`settleLateToolCharge: ${error.message}`);
  return data as SettleLateResult;
}
