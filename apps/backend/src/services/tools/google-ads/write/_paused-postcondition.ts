
import { gadsGetCampaign } from "../_client";
import { asTenantId, tenantRpc } from "@/services/tenant-client";
import { logEvent } from "@/services/logging/logEvent";
import { nudgeOpsAlertDrain } from "@/services/logging/ops-alert-outbox";

export const PAUSED_POSTCONDITION_SOURCE = "google_ads.create_campaign";

export type PausedPostconditionDeps = {
  getCampaign?: typeof gadsGetCampaign;
  rpc?: typeof tenantRpc;
  nudge?: () => void;
  log?: typeof logEvent;
};

export type PausedCheck = { paused: boolean | null; status: string | null; cpc_bid_ceiling_micros?: number | null };

export function pausedPostconditionKey(actionId: string): string {
  return `paused_postcondition:${actionId}`;
}

export async function checkCreatedPaused(
  a: { tenant_id: string; action_id: string; campaign_id: string },
  deps: PausedPostconditionDeps = {},
): Promise<PausedCheck> {
  let check: PausedCheck;
  try {
    const live = await (deps.getCampaign ?? gadsGetCampaign)(a.tenant_id, a.campaign_id);
    check = { paused: live.status === "PAUSED", status: live.status || null, cpc_bid_ceiling_micros: live.cpc_bid_ceiling_micros ?? null };
  } catch (e) {
    console.warn(`[paused-postcondition] campaign ${a.campaign_id}: readback failed: ${(e as Error).message}`);
    check = { paused: null, status: null };
  }
  if (check.paused === true) return check;

  const code = check.paused === false ? "paused_postcondition" : "paused_postcondition_unverified";
  const msg =
    `action=${a.action_id} campaign=${a.campaign_id}: ` +
    (check.paused === false
      ? `created with status PAUSED but Google reports ${check.status ?? "no status"}. Zavi changed nothing.`
      : "created, but the readback failed, so PAUSED is unconfirmed. Zavi changed nothing.");
  try {
    await (deps.log ?? logEvent)({
      level: "error",
      source: PAUSED_POSTCONDITION_SOURCE,
      code,
      message: msg,
      tenant_id: a.tenant_id,
    });
  } catch {
  }
  try {
    const rpc = deps.rpc ?? tenantRpc;
    const { data, error } = await rpc(asTenantId(a.tenant_id), "enqueue_ops_alert", {
      p_dedupe_key: pausedPostconditionKey(a.action_id),
      p_source: PAUSED_POSTCONDITION_SOURCE,
      p_code: code,
      p_tenant_id: a.tenant_id,
      p_msg: msg,
    });
    if (error) throw new Error(error.message);
    if (data === true) (deps.nudge ?? nudgeOpsAlertDrain)();
  } catch (e) {
    console.warn(`[paused-postcondition] action ${a.action_id}: alert enqueue failed: ${(e as Error).message}`);
  }
  return check;
}
