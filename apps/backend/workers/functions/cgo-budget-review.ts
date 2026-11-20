
import { inngest } from "../client";
import { fleetSweepClient } from "@/services/tenant-client";
import { isWorkerCronStopped } from "@/services/agents/cron-stopped";
import { isCanonicalContainer } from "@/services/agents/boot-role";
import { admitBudgetReview, type BudgetReviewOutcome } from "@/services/growth/budget-review-admission";
import { liveTenantIds } from "./cgo-daily-check";
import { recordWakeSkip } from "@/services/growth/cgo-wake-skips";
import { alertMoneyJobErrors } from "./_money-job-alert";
import { logJobError } from "./_job-errors";

export {
  BUDGET_WAKE_HOURS,
  localHour,
  isBudgetWakeHour,
  unchangedSinceLastReview,
  type BudgetReviewOutcome,
} from "@/services/growth/budget-review-admission";

const MAX_BUDGETS_PER_SWEEP = 500;

export async function tenantsWithActiveBudgets(): Promise<string[]> {
  const { data, error } = await fleetSweepClient("cgo budget review: list tenants with an active ad budget")
    .from("ad_budgets")
    .select("tenant_id")
    .eq("status", "active")
    .limit(MAX_BUDGETS_PER_SWEEP);
  if (error) throw new Error(`cgo-budget-review: budget list failed: ${error.message}`);
  const ids = ((data ?? []) as Array<{ tenant_id: string }>).map((r) => r.tenant_id);
  return ids.length === 0 ? [] : liveTenantIds(ids);
}

export async function reviewTenant(tenant_id: string, now: Date = new Date()): Promise<BudgetReviewOutcome> {
  return admitBudgetReview(tenant_id, now);
}

export async function runBudgetReview(now: Date = new Date()) {
  if (isWorkerCronStopped("cgo-budget-review")) return { cron_stopped: true as const };
  const tenants = await tenantsWithActiveBudgets();
  const results: BudgetReviewOutcome[] = [];
  for (const t of tenants) {
    const r = await reviewTenant(t, now);
    if (r.outcome === "error") {
      await logJobError("cgo-budget-review", `tenant ${t}: ${r.error}`);
      await recordWakeSkip(t, "ad_budget_review", "error");
    }
    results.push(r);
  }
  await alertMoneyJobErrors(
    "cgo-budget-review",
    results.filter((r) => r.outcome === "error").map((r) => r.tenant_id),
    tenants.length,
  );
  return {
    tenants: tenants.length,
    woke: results.filter((r) => r.outcome === "woke").length,
    skipped: results.filter((r) => r.outcome === "skipped").length,
    errors: results.filter((r) => r.outcome === "error").length,
  };
}

export const cgoBudgetReviewFn = inngest.createFunction(
  { id: "cgo-budget-review", retries: 1, concurrency: { limit: 1 } },
  { cron: "23 * * * *" },
  async ({ step }) => {
    if (!isCanonicalContainer()) return { skipped: "not_canonical" as const };
    return step.run("review", () => runBudgetReview());
  },
);
