
import { PLAN_READY_SUBJECT } from "@/email/templates/plan-ready";
import { sendPushForEvent } from "@/services/notifications/push-fanout";
import { planReadyDecision, planReadyDeps, type PlanReadyDeps } from "./plan-ready-email";

export const PLAN_READY_PUSH_BODY = "Have a look and change anything that does not fit. It is your plan.";

export type PlanReadyPushDeps = Pick<PlanReadyDeps, "tenantOfRun" | "facts"> & { send: typeof sendPushForEvent };

export async function maybeSendPlanReadyPush(
  run_id: string,
  deps: PlanReadyPushDeps = { ...planReadyDeps, send: sendPushForEvent },
): Promise<{ sent: number; reason?: string }> {
  const tenant_id = await deps.tenantOfRun(run_id);
  if (!tenant_id) return { sent: 0, reason: "run_not_found" };
  const facts = await deps.facts(tenant_id);
  const decision = planReadyDecision({
    ...facts,
    enabled: true,
    owner: facts.owner && { ...facts.owner, optedOut: false },
  });
  if (!decision.send) return { sent: 0, reason: decision.reason };
  const { sent, skipped_reason } = await deps.send({
    tenant_id,
    kind: "result_milestone",
    agent_slug: "cgo",
    thread_id: null,
    title: PLAN_READY_SUBJECT,
    body: PLAN_READY_PUSH_BODY,
    user_id: facts.owner!.user_id,
  });
  return skipped_reason ? { sent, reason: skipped_reason } : { sent };
}
