
import { resolveReportingTimezone } from "@/services/analytics/tenant-timezone";
import { cgoAdBudget } from "./cgo-ads";
import { enqueueGoalOwnerRun, OWN_GOALS_STAGE } from "./goal-owner";
import { currentBudgetSignature, nothingChangedSince, readLastReview } from "./budget-review-signature";
import type { ActiveAdBudget } from "@/services/decisions/ad-budget";
import { isInsufficientCreditsError } from "@/services/agents/credits";
import { recordWakeSkip } from "./cgo-wake-skips";

export const BUDGET_WAKE_HOURS: readonly number[] = [10, 14, 18, 22];

export function localHour(now: Date, tz: string): number {
  try {
    const h = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(now);
    const n = Number.parseInt(h, 10);
    return Number.isFinite(n) ? n % 24 : now.getUTCHours();
  } catch {
    return now.getUTCHours();
  }
}

export function isBudgetWakeHour(now: Date, tz: string): boolean {
  return BUDGET_WAKE_HOURS.includes(localHour(now, tz));
}

export type BudgetReviewOutcome =
  | { tenant_id: string; outcome: "woke"; run_id: string }
  | { tenant_id: string; outcome: "skipped"; why: string }
  | { tenant_id: string; outcome: "error"; error: string };

export const CONTROLLER_REVIEW_FLOOR_HOURS = 24;

export async function unchangedSinceLastReview(
  tenant_id: string,
  budget: ActiveAdBudget,
  now: Date = new Date(),
  floorHours?: number,
): Promise<boolean> {
  try {
    const [current, last] = await Promise.all([
      currentBudgetSignature(tenant_id, budget, now),
      readLastReview(tenant_id, OWN_GOALS_STAGE),
    ]);
    if (!nothingChangedSince(last, current)) return false;
    if (floorHours === undefined) return true;
    const at = Date.parse(last?.enqueued_at ?? "");
    return Number.isFinite(at) && now.getTime() - at < floorHours * 3_600_000;
  } catch (e) {
    console.warn(
      JSON.stringify({ event: "cgo.budget_review.signature_unreadable", tenant_id, error: (e as Error).message.slice(0, 300) }),
    );
    return false;
  }
}

export async function admitBudgetReview(
  tenant_id: string,
  now: Date = new Date(),
  opts: { from?: "clock" | "controller" } = {},
): Promise<BudgetReviewOutcome> {
  try {
    const { tz } = await resolveReportingTimezone(tenant_id);
    if (!isBudgetWakeHour(now, tz)) return { tenant_id, outcome: "skipped", why: "not_a_wake_hour" };
    const budget = await cgoAdBudget(tenant_id, now);
    if (!budget) {
      void recordWakeSkip(tenant_id, "ad_budget_review", "not_running_ads");
      return { tenant_id, outcome: "skipped", why: "not_running_ads" };
    }
    if (await unchangedSinceLastReview(tenant_id, budget, now, opts.from === "controller" ? CONTROLLER_REVIEW_FLOOR_HOURS : undefined)) {
      void recordWakeSkip(tenant_id, "ad_budget_review", "nothing_changed");
      return { tenant_id, outcome: "skipped", why: "nothing_changed" };
    }
    const r = await enqueueGoalOwnerRun({ tenant_id, reason: "ad_budget_review", now });
    if (!r.enqueued) return { tenant_id, outcome: "skipped", why: r.skipped };
    return { tenant_id, outcome: "woke", run_id: r.run_id };
  } catch (e) {
    const err = e as Error | null;
    if (err?.name === "InsufficientCreditsError" || isInsufficientCreditsError(err)) {
      return { tenant_id, outcome: "skipped", why: "no_credits" };
    }
    return { tenant_id, outcome: "error", error: (e as Error).message };
  }
}
