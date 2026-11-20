
import type { ConductorTickResult } from "@/services/agents/conductor";

export type LedgerEntry = {
  action: string;
  node_id: string | null;
  child_run_id: string | null;
  outcome: string | null;
  error: string | null;
};

export function isLoggableTick(r: ConductorTickResult): boolean {
  return (
    r.action !== "noop" &&
    r.action !== "waiting" &&
    r.action !== "class_read_error"
  );
}

export function mapTickToLedger(r: ConductorTickResult): LedgerEntry {
  const node_id = "node_id" in r ? r.node_id : null;
  const child_run_id = "child_run_id" in r ? r.child_run_id : null;
  let action = r.action;
  let outcome: string | null = null;
  let error: string | null = null;
  if (r.action === "completed") outcome = r.final;
  else if (r.action === "halted") outcome = "halted";
  else if (r.action === "dispatch_failed") {
    outcome = "failed";
    error = r.reason;
  } else if (r.action === "repair_dispatched") {
    action = "dispatched";
    outcome = `repair_attempt_${r.attempt}`;
  } else if (r.action === "completed_after_repair_exhausted") {
    action = "completed";
    outcome = r.paused ? "paused" : "failed";
    error = `repair_exhausted_after_${r.attempts}: ${r.root_cause}`.slice(0, 4000);
  } else if (r.action === "completed_provider_capacity") {
    action = "completed";
    outcome = r.paused ? "paused" : "failed";
    error = `provider_capacity: ${r.root_cause}`.slice(0, 4000);
  } else if (r.action === "completed_app_database_setup") {
    action = "completed";
    outcome = r.paused ? "paused" : "failed";
    error = `app_database_setup: ${r.root_cause}`.slice(0, 4000);
  } else if (r.action === "completed_platform_config_error") {
    action = "completed";
    outcome = r.paused ? "paused" : "failed";
    error = `platform_config_error: ${r.root_cause}`.slice(0, 4000);
  } else if (r.action === "class_over_cap") {
    action = "halted";
    outcome = "over_cap";
    error = `class_cap:${r.decision_class}`;
  }
  return { action, node_id, child_run_id, outcome, error };
}

type RpcCaller = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ error: { message: string } | null }>;
};

export async function appendConductorAction(
  svc: RpcCaller,
  tenant_id: string,
  conductor_run_id: string,
  r: ConductorTickResult,
): Promise<void> {
  if (!isLoggableTick(r)) return;
  const e = mapTickToLedger(r);
  const { error } = await svc.rpc("append_autopilot_action", {
    p_tenant_id: tenant_id,
    p_conductor_run_id: conductor_run_id,
    p_node_id: e.node_id,
    p_action: e.action,
    p_target_agent_slug: null,
    p_child_run_id: e.child_run_id,
    p_decision_id: null,
    p_spend_delta: 0,
    p_outcome: e.outcome,
    p_error: e.error,
    p_evidence: {},
  });
  if (error) {
    // eslint-disable-next-line no-console
    console.error(`appendConductorAction: ${error.message}`);
  }
}
