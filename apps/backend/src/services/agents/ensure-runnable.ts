
import { loadAgentDefinition } from "./registry";
import { getEffectiveVisibility } from "./visibility";
import { checkAgentTier, planUpgradeMessage } from "./entitlement";
import { isCustomAgentSlug, isEngineerBackendRun, type RunFacts, type Tier } from "@/services/billing/tiers";
import type { AgentDefinition } from "./types";

export type AgentRunnableCheck =
  | { runnable: true; agent: AgentDefinition }
  | {
      runnable: false;
      reason:
        | "not_found"
        | "default_disabled"
        | "global_override_hide"
        | "tenant_hidden_override"
        | "staff_locked_hide"
        | "channel_only_hide"
        | "not_in_plan"
        | "plan_upgrade_required";
      detail: string;
      required_tier?: Tier;
    };

import type { RunOrigin } from "./run-origin";
export { runOriginForTrigger, type RunOrigin } from "./run-origin";

export async function ensureAgentRunnable(
  tenant_id: string,
  slug: string,
  opts?: {
    origin?: RunOrigin;
    run?: RunFacts;
    agent?: AgentDefinition | null | Promise<AgentDefinition | null>;
  },
): Promise<AgentRunnableCheck> {
  if (!tenant_id) throw new Error("ensureAgentRunnable: tenant_id required");
  if (!slug) throw new Error("ensureAgentRunnable: slug required");

  const agent = opts?.agent !== undefined ? await opts.agent : await loadAgentDefinition(slug, tenant_id);
  if (!agent) {
    return {
      runnable: false,
      reason: "not_found",
      detail: `Agent "${slug}" not found in src/agents/`,
    };
  }

  if (isCustomAgentSlug(slug)) {
    const { isCustomAgentRun } = await import("./custom-agents");
    const ok = await isCustomAgentRun(tenant_id, slug, {
      runId: opts?.run?.runId ?? null,
      cronDedupeKey: opts?.run?.cronDedupeKey ?? null,
    });
    if (!ok) {
      return {
        runnable: false,
        reason: "not_found",
        detail: `custom agent "${slug}" is not active`,
      };
    }
  }

  const eff = await getEffectiveVisibility(tenant_id, slug);
  const listingOnlyHide = eff.reason === "channel_only_hide";
  if (!eff.visible && !listingOnlyHide) {
    const reason = eff.reason as Extract<
      AgentRunnableCheck,
      { runnable: false }
    >["reason"];
    return {
      runnable: false,
      reason,
      detail: `agent "${slug}" not visible for tenant ${tenant_id}: ${eff.reason}`,
    };
  }

  try {
    const d = await checkAgentTier(tenant_id, slug, {
      engineerBackendRun: isEngineerBackendRun(slug, opts?.run),
      run: opts?.run,
    });
    if (!d.allowed) {
      return {
        runnable: false,
        reason: "plan_upgrade_required",
        required_tier: d.required_tier,
        detail: planUpgradeMessage(slug, d.required_tier),
      };
    }
  } catch (e) {
    return {
      runnable: false,
      reason: "not_in_plan",
      detail: `tier gate unavailable for tenant ${tenant_id} (fail-closed): ${(e as Error).message}`,
    };
  }

  return { runnable: true, agent };
}
