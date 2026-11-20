
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { logEvent } from "@/services/logging/logEvent";
import { computeReadiness } from "@/services/readiness/compute";
import { proposeGoal, type ProposedGoal } from "@/services/readiness/goal-proposer";
import { isWorkerCronStopped } from "@/services/agents/cron-stopped";

const MAX_PROPOSALS_PER_SCAN = 25;

export function gateFor(blob: Record<string, unknown>): { enabled: boolean; allowlist: string[] } {
  if (blob.goal_proposer_enabled === false) return { enabled: false, allowlist: [] };
  const allow = blob.goal_proposer_tenants;
  const allowlist = Array.isArray(allow) ? allow.filter((x): x is string => typeof x === "string") : [];
  return { enabled: true, allowlist };
}

export interface Candidate {
  tenant_id: string;
  company_brain: string;
}

export interface GoalProposerDeps {
  propose: (brain: string) => Promise<ProposedGoal | null>;
  write: (c: Candidate, g: ProposedGoal) => Promise<string | null>;
  recompute: (tenant_id: string) => Promise<unknown>;
  log: typeof logEvent;
}

export interface ProposerResult {
  proposed: number;
  skipped_no_proposal: number;
  errors: number;
  tenants: string[];
}

export async function runGoalProposer(candidates: Candidate[], deps: GoalProposerDeps): Promise<ProposerResult> {
  const res: ProposerResult = { proposed: 0, skipped_no_proposal: 0, errors: 0, tenants: [] };
  for (const c of candidates) {
    try {
      const goal = await deps.propose(c.company_brain);
      if (!goal) {
        res.skipped_no_proposal++;
        await deps.log({
          level: "info",
          source: "goal-proposer-scan",
          code: "goal_proposer.no_proposal",
          tenant_id: c.tenant_id,
        });
        continue;
      }
      const id = await deps.write(c, goal);
      if (!id) {
        res.skipped_no_proposal++;
        await deps.log({
          level: "info",
          source: "goal-proposer-scan",
          code: "goal_proposer.refused_founder_goal",
          tenant_id: c.tenant_id,
        });
        continue;
      }
      res.proposed++;
      res.tenants.push(c.tenant_id);
      await deps.recompute(c.tenant_id);
      await deps.log({
        level: "info",
        source: "goal-proposer-scan",
        code: "goal_proposer.proposed",
        tenant_id: c.tenant_id,
        meta: { metric: goal.target_metric },
      });
    } catch (e) {
      res.errors++;
      try {
        await deps.log({
          level: "warn",
          source: "goal-proposer-scan",
          code: "goal_proposer.error",
          tenant_id: c.tenant_id,
          error: e,
        });
      } catch {
      }
    }
  }
  return res;
}

export const goalProposerScanFn = inngest.createFunction(
  { id: "goal-proposer-scan", concurrency: 1 },
  { cron: "45 7 * * *" },
  async ({ logger }) => {
    if (isWorkerCronStopped("goal-proposer-scan")) {
      logger.info("goal-proposer-scan: skipped — not on the scheduled-work allowlist");
      return { cron_stopped: true as const };
    }
    const svc = serviceClient();

    const { data: cfg, error: cfgErr } = await svc
      .from("system_config")
      .select("blob")
      .eq("id", 1)
      .maybeSingle<{ blob: Record<string, unknown> }>();
    if (cfgErr) {
      logger.error(`goal-proposer-scan: config read failed, disabling: ${cfgErr.message}`);
      return { disabled: true, reason: "config_read_failed" };
    }
    const gate = gateFor((cfg?.blob ?? {}) as Record<string, unknown>);
    if (!gate.enabled) {
      logger.info("goal-proposer-scan: disabled by kill switch");
      return { disabled: true };
    }

    let tq = svc.from("tenants").select("id").eq("kind", "real");
    if (gate.allowlist.length > 0) tq = tq.in("id", gate.allowlist);
    const { data: tenants, error: tErr } = await tq;
    if (tErr) throw new Error(`goal-proposer-scan tenant read failed: ${tErr.message}`);
    const ids = (tenants ?? []).map((t) => (t as { id: string }).id);
    if (ids.length === 0) return { proposed: 0 };

    const { data: goalRows } = await svc
      .from("autopilot_goals")
      .select("tenant_id, status")
      .in("tenant_id", ids)
      .in("status", ["active", "proposed"]);
    const hasGoal = new Set((goalRows ?? []).map((g) => (g as { tenant_id: string }).tenant_id));

    const need = ids.filter((id) => !hasGoal.has(id));
    if (need.length === 0) return { proposed: 0 };
    const { data: anchors } = await svc
      .from("memory_note")
      .select("tenant_id, body_markdown")
      .eq("slug", "company")
      .eq("note_type", "anchor")
      .is("superseded_by", null)
      .in("tenant_id", need);
    const brainOf = new Map(
      (anchors ?? []).map((a) => [(a as { tenant_id: string }).tenant_id, (a as { body_markdown: string | null }).body_markdown ?? ""]),
    );

    const candidates: Candidate[] = need
      .filter((id) => (brainOf.get(id) ?? "").trim().length > 40)
      .slice(0, MAX_PROPOSALS_PER_SCAN)
      .map((id) => ({ tenant_id: id, company_brain: brainOf.get(id) ?? "" }));

    const result = await runGoalProposer(candidates, {
      propose: proposeGoal,
      write: async (c, g) => {
        const { data, error } = await svc.rpc("propose_autopilot_goal", {
          p_tenant_id: c.tenant_id,
          p_objective: g.objective,
          p_target_metric: g.target_metric,
          p_target_value: g.target_value,
          p_rationale: g.rationale,
        });
        if (error) throw new Error(error.message);
        return (data as string | null) ?? null;
      },
      recompute: computeReadiness,
      log: logEvent,
    });

    logger.info(`goal-proposer-scan: proposed ${result.proposed}, skipped ${result.skipped_no_proposal}, errors ${result.errors}`);
    return result;
  },
);
