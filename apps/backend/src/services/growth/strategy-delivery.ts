import { MAX_ACTIVE_GOALS } from "@/services/autopilot/goal-limits";
import { classifyMetricMode } from "@/services/autopilot/goal-metric-vocab";
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import type { ParsedStrategy } from "@/agents/cgo/strategy";
import { renderStrategy } from "@/agents/cgo/strategy";
import { renderNorthStarAnchor, renderGtmAnchor, spineKey, strategyFingerprint } from "./apply-strategy";
import { sanitizeGapAnswer } from "@/services/memory/brain-slots";
import { timeStrategyStep } from "./strategy-timing";

export type DeliveryPhase = "writing" | "checking" | "saving" | "applied" | "failed" | "superseded";
export type StrategyDelivery = { run_id: string; phase: DeliveryPhase; plan_id?: string | null; goal_id?: string | null; artifact?: unknown };

export async function readStrategyDelivery(tenant: string, run: string): Promise<StrategyDelivery | null> {
  const { data, error } = await tenantClient(asTenantId(tenant)).from("growth_strategy_delivery")
    .select("run_id, phase, plan_id, artifact").eq("run_id", run).maybeSingle();
  if (error) throw new Error("strategy_delivery_read_failed");
  return data as StrategyDelivery | null;
}

export async function advanceStrategyDelivery(tenant: string, run: string, phase: DeliveryPhase | "apply", artifact?: unknown): Promise<StrategyDelivery> {
  const { data, error } = await tenantRpc(asTenantId(tenant), "advance_growth_strategy", {
    p_run_id: run, p_phase: phase, p_artifact: artifact ?? null,
  });
  if (error || !data || typeof data !== "object" || !("phase" in data) || !["writing", "checking", "saving", "applied", "failed", "superseded"].includes(String(data.phase))) throw new Error("strategy_delivery_write_failed");
  return { run_id: run, ...(data as Omit<StrategyDelivery, "run_id">) };
}

export function strategyArtifact(strategy: ParsedStrategy) {
  return {
    goal_limit: MAX_ACTIVE_GOALS, measurement_mode: classifyMetricMode(strategy.goal?.target_metric ?? ""),
    strategy, title: `Growth strategy — ${strategy.north_star.metric}`, body: renderStrategy(strategy),
    fingerprint: strategyFingerprint(strategy), spine: spineKey(strategy),
    north_star_anchor: sanitizeGapAnswer(renderNorthStarAnchor(strategy.north_star.metric, strategy.north_star.why)),
    gtm_anchor: sanitizeGapAnswer(renderGtmAnchor(strategy.constraint.statement, strategy.constraint.lever_family, strategy.channel_bets.map(b => b.channel_slug))),
  };
}

export async function applySavedStrategy(tenant: string, run: string): Promise<StrategyDelivery> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const receipt = await timeStrategyStep(tenant, run, "apply", () => advanceStrategyDelivery(tenant, run, "apply"));
      if (receipt.phase === "applied" && !receipt.plan_id) throw new Error("strategy_plan_receipt_missing");
      if (receipt.phase === "applied") {
        await finishDelivery(tenant, run, receipt).catch(() => {});
        await import("./plan-ready-email").then(m => m.armPlanReadyEmail(tenant, run)).catch(async (e: unknown) => {
          const { logEvent } = await import("@/services/logging/logEvent");
          await logEvent({ level: "warn", source: "growth.plan-ready-email", code: "plan_ready_arm_failed", tenant_id: tenant, run_id: run, error: e });
        }).catch(() => {});
      }
      return receipt;
    } catch (e) {
      last = e;
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
  await advanceStrategyDelivery(tenant, run, "failed").catch(() => {});
  throw last;
}

export async function deliverStrategy(tenant: string, run: string, strategy: ParsedStrategy): Promise<StrategyDelivery> {
  const saved = await timeStrategyStep(tenant, run, "artifact_save", () => advanceStrategyDelivery(tenant, run, "saving", strategyArtifact(strategy)));
  if (saved.phase === "superseded" || saved.phase === "applied") return saved;
  return applySavedStrategy(tenant, run);
}

async function finishDelivery(tenant: string, run: string, receipt: StrategyDelivery): Promise<void> {
  const saved = await readStrategyDelivery(tenant, run);
  if (saved?.phase !== "applied") return;
  const strategy = (saved.artifact as { strategy?: ParsedStrategy } | undefined)?.strategy;
  if (!strategy) return;
  if (strategy.brand_voice) {
    const { getTenantPersonalization, saveTenantPersonalization } = await import("@/services/personalization/store");
    await timeStrategyStep(tenant, run, "personalization", async () => {
      const current = await getTenantPersonalization(tenant);
      if (!current.brand_voice.trim()) await saveTenantPersonalization(tenant, { brand_voice: strategy.brand_voice! }, null);
    }).catch(() => {});
  }
  if (receipt.goal_id) {
    const { sendGoalAttention } = await import("./goal-attention");
    await timeStrategyStep(tenant, run, "goal_attention", () => sendGoalAttention({tenant_id:tenant,reason:"goal_set",goal_id:receipt.goal_id!})).catch(() => {});
  }
  const { fanOutFirstRun } = await import("./auto-first-run");
  await timeStrategyStep(tenant, run, "first_run", () => fanOutFirstRun(tenant, strategy.channel_bets));
}
