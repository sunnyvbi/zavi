import { describe, it, expect } from "vitest";
import { isCoachEligible, isIdle, isEmpty, type CoachGateInput } from "../coach-detectors";
import type { OutcomeRollup } from "../cron-outcome";

const eligible: CoachGateInput = {
  enabled: true,
  hidden: false,
  cronGatedUnwired: false,
  missingRequiredConnectors: 0,
};

function rollup(by: Partial<OutcomeRollup["by_class"]>, count: number, productive_rate: number): OutcomeRollup {
  return {
    count,
    by_class: { produced_decision: 0, produced_note: 0, produced_artifact: 0, empty: 0, failed: 0, ...by },
    empty_rate: 0,
    fail_rate: 0,
    productive_rate,
  };
}

describe("coach-detectors", () => {
  it("isCoachEligible requires enabled + visible + ungated + connectors-complete", () => {
    expect(isCoachEligible(eligible)).toBe(true);
    expect(isCoachEligible({ ...eligible, enabled: false })).toBe(false);
    expect(isCoachEligible({ ...eligible, hidden: true })).toBe(false);
    expect(isCoachEligible({ ...eligible, cronGatedUnwired: true })).toBe(false);
    expect(isCoachEligible({ ...eligible, missingRequiredConnectors: 1 })).toBe(false);
  });

  it("isIdle fires only at/above the missed-bucket threshold AND when eligible", () => {
    expect(isIdle(eligible, 0)).toBe(false);
    expect(isIdle(eligible, 1)).toBe(false);
    expect(isIdle(eligible, 2)).toBe(true);
    expect(isIdle(eligible, 9)).toBe(true);
    expect(isIdle({ ...eligible, hidden: true }, 9)).toBe(false);
    expect(isIdle({ ...eligible, missingRequiredConnectors: 2 }, 9)).toBe(false);
  });

  it("isEmpty fires only with enough samples, zero productive, and a clear empty signature", () => {
    expect(isEmpty(eligible, rollup({ empty: 3 }, 3, 0))).toBe(true);
    expect(isEmpty(eligible, rollup({ empty: 2 }, 2, 0))).toBe(false);
    expect(isEmpty(eligible, rollup({ empty: 2, produced_decision: 1 }, 3, 0.34))).toBe(false);
    expect(isEmpty(eligible, rollup({ failed: 4 }, 4, 0))).toBe(false);
    expect(isEmpty({ ...eligible, hidden: true }, rollup({ empty: 5 }, 5, 0))).toBe(false);
  });
});
