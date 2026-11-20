
import { isPartialRiskExecCode } from "@zavi/shared";
import type { SlipStage } from "@/components/agents/slip/decisionSlip";

export type ChannelSlipItem = {
  status?: string | null;
  exec_status?: "queued" | "dispatching" | "executed" | "failed" | null;
  exec_waiting?: "approvals" | null;
  exec_bucket?: string | null;
  exec_code?: string | null;
};

export function channelSlipStage(a: ChannelSlipItem, o: { approving?: boolean } = {}): SlipStage | null {
  if (a.exec_status === "dispatching" && a.exec_waiting === "approvals") return "held";
  if (a.exec_status === "failed") {
    return isPartialRiskExecCode(a.exec_code ?? null) || a.exec_bucket === "partial_risk" ? "partial" : "failed";
  }
  if (a.exec_status === "executed") return "done";
  if (a.exec_status === "dispatching") return "sending";
  if (a.exec_status === "queued" || o.approving) return "queued";
  if (!a.status) return null;
  if (a.status === "pending") return "waiting";
  if (a.status === "acted") return "done";
  return "closed";
}
