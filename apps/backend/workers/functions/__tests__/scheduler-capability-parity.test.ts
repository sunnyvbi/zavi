import { describe, it, expect } from "vitest";

import { GROWTH_SCHEDULED_WORKERS } from "@/services/agents/scheduler-capability";
import { validateCronExpression } from "../cron-match";
import { inngestFunctions } from "../index";
import { channelSweepFn } from "../channel-sweep";
import { goalReconcileFn } from "../goal-reconcile";
import { cgoDailyCheckFn } from "../cgo-daily-check";
import { adBudgetReconcileFn } from "../ad-budget-reconcile";
import { cgoBudgetReviewFn } from "../cgo-budget-review";
import { adSpendControllerFn } from "../ad-spend-controller";

type FnConfig = { opts: { id: string; triggers?: Array<{ cron?: string }> } };

const REGISTERED: Record<string, FnConfig> = {
  "channel-sweep": channelSweepFn as unknown as FnConfig,
  "goal-reconcile": goalReconcileFn as unknown as FnConfig,
  "cgo-daily-check": cgoDailyCheckFn as unknown as FnConfig,
  "ad-budget-reconcile": adBudgetReconcileFn as unknown as FnConfig,
  "cgo-budget-review": cgoBudgetReviewFn as unknown as FnConfig,
  "ad-spend-controller": adSpendControllerFn as unknown as FnConfig,
};

describe("scheduler capability map parity", () => {
  it("covers exactly the registered worker set", () => {
    expect(GROWTH_SCHEDULED_WORKERS.map((w) => w.worker).sort()).toEqual(
      Object.keys(REGISTERED).sort(),
    );
    for (const { worker } of GROWTH_SCHEDULED_WORKERS) {
      expect(REGISTERED[worker]!.opts.id).toBe(worker);
    }
  });

  it("carries the exact cron trigger list each worker registers", () => {
    for (const { worker, cron } of GROWTH_SCHEDULED_WORKERS) {
      const crons = (REGISTERED[worker]!.opts.triggers ?? [])
        .map((t) => t.cron)
        .filter((c): c is string => typeof c === "string");
      expect(crons, worker).toEqual([cron]);
    }
  });

  it("every mapped worker is in the served registry", () => {
    const served = inngestFunctions as unknown[];
    for (const { worker } of GROWTH_SCHEDULED_WORKERS) {
      expect(served, worker).toContain(REGISTERED[worker]);
    }
  });

  it("every map cron is a valid 5-field expression", () => {
    for (const { worker, cron } of GROWTH_SCHEDULED_WORKERS) {
      expect(validateCronExpression(cron), worker).toBeNull();
    }
  });
});
