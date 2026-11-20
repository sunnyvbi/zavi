
import type { OutcomeRollup } from "./cron-outcome";

export const IDLE_MISSED_BUCKET_THRESHOLD = 2;
export const EMPTY_MIN_RUNS = 3;
export const EMPTY_MIN_EMPTY = 2;

export type CoachGateInput = {
  enabled: boolean;
  hidden: boolean;
  cronGatedUnwired: boolean;
  missingRequiredConnectors: number;
};

export function isCoachEligible(g: CoachGateInput): boolean {
  return g.enabled && !g.hidden && !g.cronGatedUnwired && g.missingRequiredConnectors === 0;
}

export function isIdle(g: CoachGateInput, missedBuckets: number): boolean {
  if (!isCoachEligible(g)) return false;
  return missedBuckets >= IDLE_MISSED_BUCKET_THRESHOLD;
}

export function isEmpty(g: CoachGateInput, rollup: OutcomeRollup): boolean {
  if (!isCoachEligible(g)) return false;
  return (
    rollup.count >= EMPTY_MIN_RUNS &&
    rollup.productive_rate === 0 &&
    rollup.by_class.empty >= EMPTY_MIN_EMPTY
  );
}
