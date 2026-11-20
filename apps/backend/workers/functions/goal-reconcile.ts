
import { persistingLogger } from "./_job-errors";
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { isWorkerCronStopped } from "@/services/agents/cron-stopped";
import { getBoolSetting } from "@/services/settings";
import { measureGoalMetric, type MeasureDeps } from "@/services/autopilot/goal-metric-resolver";
import { classifyGoalMetricKey } from "@/services/analytics/metric-registry";
import { classifyMetricMode } from "@/services/autopilot/goal-metric-vocab";
import { FOUNDER_ENTERED_SOURCE } from "@/services/autopilot/goal-measurement";
import { recordMetricSnapshot } from "@/services/analytics/record-metric-snapshot";
import { confirmedRule, countedSource, runCountRule, type CountDeps } from "@/services/growth/goal-count-rule";

const MAX_TENANTS_PER_SWEEP = 200;
const MAX_GOALS_PER_TENANT = 20;

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

async function recordGoalMeasurementSnapshot(args: {
  tenant_id: string;
  goal_id: string;
  target_metric: string;
  value: number;
  source: string;
  basis?: "mrr" | "arr";
  now: Date;
}): Promise<void> {
  try {
    if (args.basis === "arr") return;
    const metric_key = classifyGoalMetricKey(args.target_metric);
    if (!metric_key) return;
    const end = Math.floor(args.now.getTime() / MS_PER_HOUR) * MS_PER_HOUR;
    await recordMetricSnapshot({
      tenant_id: args.tenant_id,
      metric_key,
      value: args.value,
      status: "measured",
      source: args.source,
      window_kind: "rolling_7d",
      window_start: new Date(end - 7 * MS_PER_DAY).toISOString(),
      window_end: new Date(end).toISOString(),
      meta: { goal_id: args.goal_id, via: "goal-reconcile" },
    });
  } catch {
  }
}

type GoalRow = {
  id: string;
  objective: string;
  target_metric: string;
  target_value: number;
  baseline_value: number | null;
  current_value: number | null;
  due_date: string | null;
  priority: number;
  created_at: string | null;
  measurement_mode?: string | null;
  measure_source?: string | null;
  current_value_source?: string | null;
  count_rule?: unknown;
};

type SweepLogger = {
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

export type TenantReconcileResult = {
  goals_seen: number;
  measured: number;
  skipped_unmeasured: number;
  errors: number;
  counted?: number;
  count_stale?: number;
};

export async function reconcileGoalsForTenant(
  tenant_id: string,
  now: Date,
  logger: SweepLogger,
  measureDeps?: MeasureDeps,
  countDeps?: CountDeps,
): Promise<TenantReconcileResult> {
  const svc = serviceClient();
  const out: TenantReconcileResult = {
    goals_seen: 0,
    measured: 0,
    skipped_unmeasured: 0,
    errors: 0,
  };

  const { data, error } = await svc
    .from("autopilot_goals")
    .select(
      "id, objective, target_metric, target_value, baseline_value, current_value, current_value_source, due_date, priority, created_at, measurement_mode, count_rule, measure_source",
    )
    .eq("tenant_id", tenant_id)
    .eq("status", "active")
    .order("priority", { ascending: false })
    .limit(MAX_GOALS_PER_TENANT);
  if (error) {
    logger.warn(`[goal-reconcile] goals read failed for ${tenant_id}: ${error.message}`);
    out.errors += 1;
    return out;
  }

  const goals = (data ?? []) as GoalRow[];
  out.goals_seen = goals.length;

  for (const goal of goals) {
    const rule = confirmedRule(goal.count_rule);
    if (rule) {
      try {
        const outcome = await runCountRule(tenant_id, rule, { checkHash: true }, countDeps);
        if (!outcome.ok) {
          out.count_stale = (out.count_stale ?? 0) + 1;
          const { error: sErr } = await svc
            .from("autopilot_goals")
            .update({ count_rule: { ...rule, stale_reason: outcome.reason, stale_at: rule.stale_at ?? now.toISOString() } })
            .eq("id", goal.id)
            .eq("tenant_id", tenant_id);
          if (sErr) logger.warn(`[goal-reconcile] marking count rule stale failed for goal ${goal.id}: ${sErr.message}`);
          continue;
        }
        const { error: rpcErr } = await svc.rpc("update_goal_progress", {
          p_tenant_id: tenant_id,
          p_goal_id: goal.id,
          p_current_value: outcome.value,
        });
        if (rpcErr) {
          logger.warn(`[goal-reconcile] update_goal_progress failed for goal ${goal.id}: ${rpcErr.message}`);
          out.errors += 1;
          continue;
        }
        out.measured += 1;
        out.counted = (out.counted ?? 0) + 1;
        const { error: stampErr } = await svc
          .from("autopilot_goals")
          .update({
            current_value_at: now.toISOString(),
            current_value_source: countedSource(rule.definition),
            ...(rule.stale_reason ? { count_rule: { ...rule, stale_reason: null, stale_at: null } } : {}),
          })
          .eq("id", goal.id)
          .eq("tenant_id", tenant_id);
        if (stampErr) logger.warn(`[goal-reconcile] counted-at stamp failed for goal ${goal.id}: ${stampErr.message}`);
      } catch (e) {
        out.errors += 1;
        logger.warn(`[goal-reconcile] counting goal ${goal.id} (tenant ${tenant_id}) threw: ${(e as Error).message}`);
      }
      continue;
    }
    if (goal.measurement_mode !== "auto") {
      out.skipped_unmeasured += 1;
      continue;
    }
    if (classifyMetricMode(goal.target_metric) === "manual_reported") {
      out.skipped_unmeasured += 1;
      const src = goal.current_value_source;
      const readerWritten = src != null && src !== FOUNDER_ENTERED_SOURCE && !src.startsWith("counted:");
      const { error: modeErr } = await svc
        .from("autopilot_goals")
        .update({
          measurement_mode: "manual_reported",
          ...(readerWritten ? { current_value: null, current_value_source: null } : {}),
        })
        .eq("id", goal.id)
        .eq("tenant_id", tenant_id)
        .eq("measurement_mode", "auto");
      if (modeErr) logger.warn(`[goal-reconcile] mode fix failed for goal ${goal.id}: ${modeErr.message}`);
      continue;
    }
    try {
      const outcome = await measureGoalMetric({
        tenant_id,
        target_metric: goal.target_metric,
        goal_created_at: goal.created_at,
        now,
        deps: measureDeps,
        measure_source: goal.measure_source ?? null,
      });
      if (!outcome.measured) {
        out.skipped_unmeasured += 1;
        continue;
      }

      out.measured += 1;
      const { error: rpcErr } = await svc.rpc("update_goal_progress", {
        p_tenant_id: tenant_id,
        p_goal_id: goal.id,
        p_current_value: outcome.value,
      });
      if (rpcErr) {
        logger.warn(
          `[goal-reconcile] update_goal_progress failed for goal ${goal.id}: ${rpcErr.message}`,
        );
        out.errors += 1;
      }

      if (!rpcErr) {
        try {
          const { error: stampErr } = await svc
            .from("autopilot_goals")
            .update({ current_value_at: now.toISOString(), current_value_source: String(outcome.source).slice(0, 200) })
            .eq("id", goal.id)
            .eq("tenant_id", tenant_id);
          if (stampErr) throw new Error(stampErr.message);
        } catch (e) {
          logger.warn(`[goal-reconcile] measured-at stamp failed for goal ${goal.id}: ${(e as Error).message}`);
        }
      }

      await recordGoalMeasurementSnapshot({
        tenant_id,
        goal_id: goal.id,
        target_metric: goal.target_metric,
        value: outcome.value,
        source: outcome.source,
        basis: outcome.basis,
        now,
      });

    } catch (e) {
      out.errors += 1;
      logger.warn(
        `[goal-reconcile] goal ${goal.id} (tenant ${tenant_id}) threw: ${(e as Error).message}`,
      );
    }
  }

  return out;
}

export type SweepResult = {
  skipped?: true;
  reason?: string;
  scanned?: number;
  tenants_reconciled?: number;
  skipped_autopilot_off?: number;
  skipped_no_goals?: number;
  measured?: number;
  errors?: number;
};

export async function runGoalReconcileSweep(
  logger: SweepLogger,
  measureDeps?: MeasureDeps,
  now: Date = new Date(),
  countDeps?: CountDeps,
): Promise<SweepResult> {
  const svc = serviceClient();

  const { data: halted, error: killErr } = await svc.rpc("is_fleet_halted");
  if (killErr) {
    logger.error(
      `goal-reconcile: is_fleet_halted failed (fail-closed, skipping): ${killErr.message}`,
    );
    return { skipped: true, reason: "fleet_kill_check_failed" };
  }
  if (halted === true) {
    return { skipped: true, reason: "fleet_halted" };
  }

  const { data, error } = await svc
    .from("tenants")
    .select("id")
    .order("created_at", { ascending: true })
    .limit(MAX_TENANTS_PER_SWEEP);
  if (error) {
    logger.error(`goal-reconcile: tenant scan failed: ${error.message}`);
    return { scanned: 0, errors: 1 };
  }
  const tenants = (data ?? []) as Array<{ id: string }>;

  let tenants_reconciled = 0;
  let skipped_autopilot_off = 0;
  let skipped_no_goals = 0;
  let measured = 0;
  let errors = 0;

  for (const t of tenants) {
    try {
      const r = await reconcileGoalsForTenant(t.id, now, logger, measureDeps, countDeps);
      if (r.goals_seen === 0) {
        skipped_no_goals += 1;
        continue;
      }
      tenants_reconciled += 1;
      measured += r.measured;
      errors += r.errors;
    } catch (e) {
      errors += 1;
      logger.warn(`[goal-reconcile] tenant ${t.id} threw: ${(e as Error).message}`);
    }
  }

  return {
    scanned: tenants.length,
    tenants_reconciled,
    skipped_autopilot_off,
    skipped_no_goals,
    measured,
    errors,
  };
}

type ActiveGoal = {
  id: string;
  objective: string;
  target_metric: string;
  target_value: number;
  baseline_value: number | null;
  current_value: number | null;
  due_date: string | null;
  priority: number;
};

export function renderGoalsBlock(
  goals: ActiveGoal[],
  enabledDemandAgents: readonly string[] = [],
  goalTrends: Record<string, string> = {},
): string {
  if (goals.length === 0) {
    return "(no active autopilot goals)";
  }
  const lines: string[] = [
    `## Active autopilot goals (founder-set targets)`,
    ``,
    `You are the CEO loop's planner. For each goal below, decide today's`,
    `highest-leverage move and surface it as a Tier-1 with a`,
    `\`suggested_dispatch\` entry (target_agent_slug + intent). The founder`,
    `one-clicks Approve on each → the specialist runs. Stay grounded in the`,
    `tenant's real data; do not invent metrics.`,
    ``,
  ];

  if (enabledDemandAgents.length > 0) {
    lines.push(
      `### Demand specialists you may dispatch (enabled for this tenant)`,
    );
    for (const slug of enabledDemandAgents) {
      lines.push(`- \`${slug}\``);
    }
    lines.push(
      `Only set \`suggested_dispatch.target_agent_slug\` to a slug listed above`,
      `(or another visible fleet agent). Do NOT dispatch to a demand agent that`,
      `is not listed — it is disabled for this tenant.`,
      ``,
    );
  }

  for (const g of goals) {
    const baseline =
      g.baseline_value != null
        ? `baseline=${g.baseline_value}`
        : "baseline=unset";
    const current =
      g.current_value != null
        ? `current=${g.current_value}`
        : "current=unmeasured";
    const due = g.due_date ?? "no-due-date";
    lines.push(`- **${g.objective}**`);
    lines.push(
      `  - target: \`${g.target_metric}\` >= ${g.target_value}; ${baseline}; ${current}; due ${due}; priority ${g.priority}`,
    );
    lines.push(`  - goal_id: \`${g.id}\``);
    const trend = goalTrends[g.id];
    if (trend) lines.push(`  - ${trend}`);
  }
  lines.push(``);
  return lines.join("\n");
}

export const goalReconcileFn = inngest.createFunction(
  { id: "goal-reconcile", concurrency: 1 },
  { cron: "30 13 * * *" },
  async ({ logger }) => {
    if (isWorkerCronStopped("goal-reconcile")) {
      logger.info("goal-reconcile: skipped — not on the scheduled-work allowlist");
      return { cron_stopped: true as const };
    }
    return runGoalReconcileSweep(persistingLogger("goal-reconcile", logger));
  },
);
