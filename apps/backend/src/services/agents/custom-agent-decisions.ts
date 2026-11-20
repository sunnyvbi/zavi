import { PERSON_ONLY_EXEC_CLASSES } from "@/services/growth/person-only";
import { isCustomAgentSlug } from "@/services/billing/tiers";
import { isComposioDecisionClass } from "@/services/connectors/composio/write-classify";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { insertWriteReceipt, resolveCustomWriteRun, settleWriteReceipt } from "./custom-agent-writes";

export type CustomDecisionDispatchDeps = {
  resolve: typeof resolveCustomWriteRun;
  handToHuman: (tenant_id: string, decision_id: string, run_id: string) => Promise<void>;
  insertReceipt: typeof insertWriteReceipt;
  settleReceipt: typeof settleWriteReceipt;
  dispatch: (args: {
    decision_id: string;
    tenant_id: string;
    decision_class: string;
    agent_run_id: string;
    body: unknown;
    customAgent: true;
  }) => Promise<{ dispatched: boolean; reason: string }>;
};

export async function handCustomDecisionToHuman(tenant_id: string, decision_id: string, run_id: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { error } = await tenantClient(asTenantId(tenant_id))
        .from("decisions")
        .update({ autonomy_at_emit: "approval" })
        .eq("id", decision_id)
        .eq("agent_run_id", run_id)
        .eq("status", "proposed")
        .eq("autonomy_at_emit", "auto");
      if (!error) return;
      console.warn(`[custom-agent-decisions] hand-to-human failed (try ${attempt + 1}): ${error.message}`);
    } catch (e) {
      console.warn(`[custom-agent-decisions] hand-to-human threw (try ${attempt + 1}): ${(e as Error).message}`);
    }
  }
  console.error(`[custom-agent-decisions] HAND-TO-HUMAN STUCK decision=${decision_id}: row may be proposed+auto and unlisted`);
}

const defaultDeps: CustomDecisionDispatchDeps = {
  resolve: resolveCustomWriteRun,
  handToHuman: handCustomDecisionToHuman,
  insertReceipt: insertWriteReceipt,
  settleReceipt: settleWriteReceipt,
  dispatch: async (a) => {
    const { dispatchInteractiveDecision } = await import("@/services/decisions/dispatch-interactive");
    return dispatchInteractiveDecision(a);
  },
};

export type CustomDecisionDispatchOutcome = "not_custom" | "dispatched" | "not_dispatched" | "receipt_failed";

export async function dispatchCustomAgentDecision(
  args: { tenant_id: string; run_id: string; slug: string; decision_id: string; decision_class: string; body: unknown },
  deps: CustomDecisionDispatchDeps = defaultDeps,
): Promise<CustomDecisionDispatchOutcome> {
  if (!isCustomAgentSlug(args.slug)) return "not_custom";
  const toHuman = () => deps.handToHuman(args.tenant_id, args.decision_id, args.run_id);
  if (isComposioDecisionClass(args.decision_class)) {
    await toHuman();
    return "not_dispatched";
  }
  const b = args.body && typeof args.body === "object" ? (args.body as { origin?: unknown; founder_chat_order?: unknown }) : {};
  if (b.founder_chat_order === true && (b.origin === "user_initiated_chat" || b.origin === "user_initiated_ledger")) {
    await toHuman();
    return "not_dispatched";
  }
  if (PERSON_ONLY_EXEC_CLASSES.has(args.decision_class) || b.origin === "cut_guard_override" || b.origin === "zavi_location_proposal" || b.origin === "zavi_location_undo") {
    await toHuman();
    return "not_dispatched";
  }
  try {
    const run = await deps.resolve(args.tenant_id, args.run_id, args.slug);
    if (run.state === "not_custom") return "not_custom";
    if (run.state !== "admitted") {
      await toHuman();
      return "not_dispatched";
    }
    const facts = { tenant_id: run.tenant_id, run_id: run.run_id, agent_id: run.agent_id, slug: run.slug };
    const id = await deps.insertReceipt(facts, `decision:${args.decision_class}`, args.decision_class, "attempted");
    if (!id) {
      await toHuman();
      return "receipt_failed";
    }
    let res: { dispatched: boolean; reason: string };
    try {
      res = await deps.dispatch({
        decision_id: args.decision_id,
        tenant_id: args.tenant_id,
        decision_class: args.decision_class,
        agent_run_id: args.run_id,
        body: args.body,
        customAgent: true,
      });
    } catch (e) {
      res = { dispatched: false, reason: "dispatch_threw" };
      console.warn(`[custom-agent-decisions] dispatch threw: ${(e as Error).message}`);
    }
    await deps.settleReceipt(
      { tenant_id: args.tenant_id, id },
      res.dispatched ? "succeeded" : "failed",
      res.dispatched ? null : res.reason,
    );
    if (!res.dispatched && res.reason !== "dispatch_timeout") await toHuman();
    return res.dispatched ? "dispatched" : "not_dispatched";
  } catch (e) {
    console.warn(`[custom-agent-decisions] ${(e as Error).message}`);
    await toHuman();
    return "not_dispatched";
  }
}
