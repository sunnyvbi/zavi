
import { inngest } from "../client";
import { isWorkerCronStopped } from "@/services/agents/cron-stopped";
import { runAdBudgetReconcile, reconcileReadFailedBudgets } from "@/services/decisions/ad-budget-reconcile";

export async function runAdBudgetReconcileTick(now: Date = new Date()) {
  if (isWorkerCronStopped("ad-budget-reconcile")) return { cron_stopped: true as const };
  return runAdBudgetReconcile(now);
}

export const adBudgetReconcileFn = inngest.createFunction(
  { id: "ad-budget-reconcile", retries: 1, concurrency: { limit: 1 } },
  { cron: "7 * * * *" },
  async ({ step }) => step.run("reconcile", () => runAdBudgetReconcileTick()),
);

export const adBudgetReconnectReadFn = inngest.createFunction(
  { id: "ad-budget-reconnect-read", retries: 1, concurrency: { limit: 1 } },
  { event: "ad_budget.reconnect_read.requested" },
  async ({ event, step }) =>
    step.run("reconcile", () => {
      const tenant_id = String(event.data?.tenant_id ?? "");
      if (!tenant_id) return { flagged: 0, recorded: 0, read_failed: 0, errors: 0 };
      return reconcileReadFailedBudgets(tenant_id);
    }),
);
