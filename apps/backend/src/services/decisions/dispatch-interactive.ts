
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { alert } from "@/services/logging/alert";
import { logEvent } from "@/services/logging/logEvent";
import { releaseClaim } from "@/services/decisions/atomic-claim";
import { resolveWaiverState } from "@/services/decisions/waiver-resolve";
import { checkAutoFireRateCap } from "@/services/decisions/auto-fire-rate-cap";
import { consumeClassBudget } from "@/services/agents/class-cap";
import { isFleetHalted } from "@/services/agents/fleet-halt";
import { shouldHoldInteractiveShipPr } from "@/services/decisions/ship-pr-approval-gate";

export const IN_SESSION_DISPATCH_TRIGGERS: ReadonlySet<string> = new Set([
  "slack",
  "handoff",
  "a2a",
  "manual",
]);

export const IN_SESSION_DISPATCH_CLASSES: ReadonlySet<string> = new Set([
  "engineer.ship-pr",
]);

export const IN_SESSION_DISPATCH_TIMEOUT_MS = 60_000;

export type InSessionDispatchReason =
  | "dispatched"
  | "class_not_eligible"
  | "decision_not_claimable"
  | "not_this_run"
  | "not_auto"
  | "no_handler"
  | "not_interactive_trigger"
  | "fleet_halted"
  | "held_by_ship_pr_gate"
  | "waiver_expired"
  | "rate_capped"
  | "class_spend_cap_over"
  | "dispatch_failed"
  | "dispatch_timeout"
  | "dispatch_threw";

export type InSessionDispatchResult = {
  dispatched: boolean;
  reason: InSessionDispatchReason;
};

export function isInSessionDispatchTrigger(
  trigger: string | null | undefined,
): boolean {
  return typeof trigger === "string" && IN_SESSION_DISPATCH_TRIGGERS.has(trigger);
}

async function readDecisionRow(
  tenant_id: string,
  decision_id: string,
): Promise<{
  readOk: boolean;
  tenant_id: string | null;
  agent_run_id: string | null;
  status: string | null;
  autonomy_at_emit?: string | null;
  handler?: string | null;
}> {
  try {
    const { data, error } = await tenantClient(asTenantId(tenant_id))
      .from("decisions")
      .select("tenant_id, agent_run_id, status, autonomy_at_emit, handler")
      .eq("id", decision_id)
      .maybeSingle();
    if (error || !data) {
      return { readOk: false, tenant_id: null, agent_run_id: null, status: null };
    }
    const row = data as {
      tenant_id?: string | null;
      agent_run_id?: string | null;
      status?: string | null;
      autonomy_at_emit?: string | null;
      handler?: string | null;
    };
    return {
      readOk: true,
      tenant_id: row.tenant_id ?? null,
      agent_run_id: row.agent_run_id ?? null,
      status: row.status ?? null,
      autonomy_at_emit: row.autonomy_at_emit ?? null,
      handler: row.handler ?? null,
    };
  } catch {
    return { readOk: false, tenant_id: null, agent_run_id: null, status: null };
  }
}

async function readRunTrigger(
  tenant_id: string,
  agent_run_id: string,
): Promise<{ readOk: boolean; trigger: string | null }> {
  try {
    const { data, error } = await tenantClient(asTenantId(tenant_id))
      .from("agent_runs")
      .select("trigger")
      .eq("id", agent_run_id)
      .maybeSingle();
    if (error || !data) return { readOk: false, trigger: null };
    return {
      readOk: true,
      trigger: (data as { trigger?: string | null }).trigger ?? null,
    };
  } catch {
    return { readOk: false, trigger: null };
  }
}

function pushToMainFlag(body: unknown): boolean {
  return (
    !!body &&
    typeof body === "object" &&
    (body as { push_to_main?: unknown }).push_to_main === true
  );
}

export async function dispatchInteractiveDecision(args: {
  decision_id: string;
  tenant_id: string;
  decision_class: string;
  agent_run_id: string;
  body: unknown;
  customAgent?: boolean;
  timeoutMs?: number;
}): Promise<InSessionDispatchResult> {
  const { decision_id, tenant_id, decision_class, agent_run_id, body } = args;
  const custom = args.customAgent === true;
  const timeoutMs = args.timeoutMs ?? IN_SESSION_DISPATCH_TIMEOUT_MS;

  const refuse = async (
    reason: InSessionDispatchReason,
    message: string,
  ): Promise<InSessionDispatchResult> => {
    await logEvent({
      level: "info",
      source: "dispatch-interactive",
      code: reason,
      message,
      tenant_id,
      meta: { decision_class },
    }).catch(() => {});
    return { dispatched: false, reason };
  };

  if (!custom && !IN_SESSION_DISPATCH_CLASSES.has(decision_class)) {
    return { dispatched: false, reason: "class_not_eligible" };
  }

  const TIMED_OUT = Symbol("timed_out");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
  });

  let dispatchStarted = false;

  const run = async (): Promise<InSessionDispatchResult> => {
    if (await isFleetHalted()) {
      return refuse("fleet_halted", "fleet halted — decision left proposed");
    }

    const row = await readDecisionRow(tenant_id, decision_id);
    if (!row.readOk || row.status !== "proposed") {
      return refuse(
        "decision_not_claimable",
        "decision row unreadable or no longer proposed — leaving it alone",
      );
    }
    if (row.tenant_id !== tenant_id || row.agent_run_id !== agent_run_id) {
      return refuse(
        "not_this_run",
        "decision belongs to a different run or tenant (emit dedupe) — not ours to open",
      );
    }

    if (custom) {
      if (row.autonomy_at_emit !== "auto") {
        return refuse("not_auto", "custom-agent decision not stamped auto — decision left proposed");
      }
      if (!row.handler) {
        return refuse("no_handler", "class has no dispatch handler — decision left proposed");
      }
    }

    const { readOk, trigger } = await readRunTrigger(tenant_id, agent_run_id);
    if (!readOk || (!custom && !isInSessionDispatchTrigger(trigger))) {
      return refuse(
        "not_interactive_trigger",
        "trigger is not an in-session dispatch trigger (or was unreadable) — decision left proposed",
      );
    }

    if (decision_class === "engineer.ship-pr") {
      if (
        shouldHoldInteractiveShipPr({
          hasRunId: true,
          readOk,
          trigger,
          pushToMain: pushToMainFlag(body),
        })
      ) {
        return refuse(
          "held_by_ship_pr_gate",
          "ship-pr gate held this decision — decision left proposed",
        );
      }
    }

    const waiver = await resolveWaiverState(tenant_id, decision_class);
    if (waiver.state === "expired") {
      return refuse(
        "waiver_expired",
        "autopilot waiver expired — decision left proposed for manual approval",
      );
    }

    const capRes = await checkAutoFireRateCap(tenant_id, decision_class);
    if (!capRes.allowed) {
      return refuse(
        "rate_capped",
        "auto-fire rate cap reached — decision left proposed for manual approval",
      );
    }

    const { executeDispatch, estimateUsdFromDecisionBody } = await import(
      "../../../workers/functions/dispatch-decision"
    );

    const estimate_usd = estimateUsdFromDecisionBody(body ?? null);
    if (estimate_usd > 0) {
      const classVerdict = await consumeClassBudget(
        tenant_id,
        decision_class,
        estimate_usd,
      );
      if (classVerdict === "over_cap") {
        return refuse(
          "class_spend_cap_over",
          "per-class spend cap would be breached — decision left proposed for manual approval",
        );
      }
    }

    dispatchStarted = true;
    const res = await executeDispatch(decision_id, { slackNotice: "outbox" });

    if (!res.ok) {
      await alert({
        source: "dispatch-interactive",
        code: "in_session_dispatch_failed",
        msg: `in-session dispatch failed for class ${decision_class}`,
        tenant_id,
      }).catch(() => {});
      return { dispatched: false, reason: "dispatch_failed" };
    }

    await logEvent({
      level: "info",
      source: "dispatch-interactive",
      code: "in_session_dispatched",
      message: "decision dispatched in-session before the run terminated",
      tenant_id,
      meta: { decision_class },
    }).catch(() => {});
    return { dispatched: true, reason: "dispatched" };
  };

  try {
    const settled = run();
    settled.catch(() => {});

    const raced = await Promise.race([settled, deadline]);

    if (raced === TIMED_OUT) {
      settled
        .then((late) => {
          void logEvent({
            level: "info",
            source: "dispatch-interactive",
            code: "in_session_dispatch_late",
            message: "in-session dispatch finished after the run stopped waiting",
            tenant_id,
            meta: { decision_class, code: late.reason },
          }).catch(() => {});
        })
        .catch(() => {});

      await alert({
        source: "dispatch-interactive",
        code: "in_session_dispatch_timeout",
        msg: `in-session dispatch still running after ${timeoutMs}ms for class ${decision_class} — run stopped waiting, claim left with the in-flight call`,
        tenant_id,
      }).catch(() => {});
      return { dispatched: false, reason: "dispatch_timeout" };
    }

    return raced;
  } catch (e) {
    if (dispatchStarted) {
      await releaseClaim(decision_id, "in_session_dispatch_threw").catch(() => {});
    }
    await alert({
      source: "dispatch-interactive",
      code: "in_session_dispatch_threw",
      msg: `in-session dispatch threw for class ${decision_class}: ${(e as Error).message}`,
      tenant_id,
    }).catch(() => {});
    return { dispatched: false, reason: "dispatch_threw" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
